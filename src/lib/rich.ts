/**
 * Telegram "rich messages" (Bot API 10.1+): article-style messages with real
 * headings, quotes, collapsible sections, dividers and footers, sent with
 * `sendRichMessage` (no Premium needed). This module only builds the markup;
 * extras.ts sends it and falls back to the classic HTML renderers when Telegram
 * refuses it, so a bot talking to an older server keeps working.
 *
 * Rich HTML is real HTML: line breaks need <br/> and paragraphs need <p>.
 */
import type { Story, VocabWord, ArtistBio } from './insights.js';
import type { Translation } from './prompt.js';
import type { TrackMeta } from './format.js';
import { escapeHtml } from './format.js';
import type { TrackSummary } from './types.js';

/** Keep well below Telegram's 32 768 characters / 500 blocks per rich message. */
const MAX_CHARS = 24_000;
const MAX_BLOCKS = 380;

export interface RichPart {
  html: string;
  /** Right-to-left layout (Persian text). */
  rtl: boolean;
}

const esc = (value: string): string => escapeHtml(value).replace(/"/g, '&quot;');
const withBreaks = (value: string): string => esc(value).replace(/\n/g, '<br/>');

export function isRtlText(sample: string): boolean {
  const letters = sample.match(/\p{L}/gu) ?? [];
  if (letters.length === 0) return false;
  const rtl = letters.filter((char) => /[֐-ࣿ]/.test(char)).length;
  return rtl / letters.length > 0.4;
}

function sourceLabel(track: TrackSummary): string {
  if (track.source === 'user') return '📜 Pasted by you';
  const name = track.source === 'lrclib' ? 'LRCLIB' : track.source === 'lyrist' ? 'Lyrist' : 'lyrics.ovh';
  return `📚 Source: ${name}`;
}

function identityBlock(track: TrackSummary, meta: TrackMeta): string {
  const title = esc(meta.title ?? track.trackName);
  const linked = meta.link ? `<a href="${esc(meta.link)}">${title}</a>` : title;
  const album = meta.album ?? track.albumName;
  const rows = [
    `<b>👤 Artist:</b> ${esc(meta.artist ?? track.artistName)}`,
    ...(album ? [`<b>💽 Album:</b> ${esc(album)}`] : []),
    ...(meta.date ? [`<b>📅 Date:</b> ${esc(meta.date)}`] : []),
  ];
  return `<h2>🎧 ${linked}</h2><p>${rows.join('<br/>')}</p>`;
}

/**
 * Groups blocks into messages. Every part after the first gets a small heading so
 * a long song reads as one article; the footer goes on the last part only.
 */
export function paginateRich(args: {
  head: string;
  blocks: string[];
  foot: string;
  rtl: boolean;
  /** Each entry in `blocks` counts as this many Telegram blocks (a quote + a paragraph = 2). */
  weight?: number;
}): RichPart[] {
  const weight = args.weight ?? 1;
  const groups: string[][] = [];
  let current: string[] = [];
  let chars = args.head.length + args.foot.length;
  let count = 6;
  for (const block of args.blocks) {
    if (current.length > 0 && (chars + block.length > MAX_CHARS || count + weight > MAX_BLOCKS)) {
      groups.push(current);
      current = [];
      chars = args.foot.length + 40;
      count = 4;
    }
    current.push(block);
    chars += block.length;
    count += weight;
  }
  groups.push(current);

  return groups.map((group, index) => {
    const top = index === 0 ? args.head : `<h3>📄 بخش ${index + 1} از ${groups.length}</h3>`;
    const last = index === groups.length - 1;
    return { html: `${top}${group.join('')}${last ? args.foot : ''}`, rtl: args.rtl };
  });
}

// ---------------------------------------------------------------------------

export function lyricsRich(track: TrackSummary, meta: TrackMeta = {}): RichPart[] {
  const lyrics = track.lyrics?.trim() ?? '';
  const stanzas = lyrics.split(/\n{2,}/).map((stanza) => `<p>${withBreaks(stanza.trim())}</p>`);
  return paginateRich({
    head: `${identityBlock(track, meta)}<hr/>`,
    blocks: stanzas,
    foot: `<hr/><footer>${esc(sourceLabel(track))}</footer>`,
    rtl: isRtlText(lyrics.slice(0, 400)),
  });
}

export function translationRich(
  track: TrackSummary,
  translation: Translation,
  languageName: string,
  meta: TrackMeta = {},
  notice = '',
): RichPart[] {
  const blocks = translation.lines.map((line) => {
    const note = line.note ? ` <i>(${esc(line.note.replace(/^\(|\)$/g, ''))})</i>` : '';
    return `<blockquote>${esc(line.source)}</blockquote><p>${esc(line.text)}${note}</p>`;
  });
  const summary = [
    translation.theme ? `🧠 <b>مفهوم کلی:</b> ${esc(translation.theme)}` : '',
    translation.mood ? `💫 <b>حال‌وهوا:</b> ${esc(translation.mood)}` : '',
  ].filter(Boolean);
  const head = `<h2>🇮🇷 ترجمهٔ ${esc(languageName)}</h2>${identityBlock(track, meta)}${
    summary.length > 0 ? `<aside>${summary.join('<br/>')}</aside>` : ''
  }<hr/>`;
  return paginateRich({
    head,
    blocks,
    weight: 2,
    foot: `<hr/>${notice ? `<p><i>${esc(notice)}</i></p>` : ''}<footer>${esc(sourceLabel(track))}</footer>`,
    rtl: true,
  });
}

const link = (url: string): string => {
  let host = url;
  try {
    host = new URL(url).hostname.replace(/^www\./, '');
  } catch {
    // keep the raw url
  }
  return `<a href="${esc(url)}">${esc(host)}</a>`;
};

export function storyRich(
  track: Pick<TrackSummary, 'trackName' | 'artistName'>,
  story: Story,
  confidenceLabel: string,
): RichPart[] {
  const blocks = [
    ...(story.summary ? [`<p>${withBreaks(story.summary)}</p>`] : []),
    ...story.points.map((point) => `<h4>▫️ ${esc(point.title)}</h4><p>${withBreaks(point.text)}</p>`),
  ];
  const sources = story.sources.length > 0 ? `<p>🔗 <i>منابع:</i> ${story.sources.map(link).join(' · ')}</p>` : '';
  return paginateRich({
    head: `<h2>📖 داستان «${esc(track.trackName)}»</h2><p>🎤 ${esc(track.artistName)}</p><hr/>`,
    blocks,
    weight: 2,
    foot: `<hr/><p><i>${esc(confidenceLabel)}</i></p>${sources}`,
    rtl: true,
  });
}

export function wordsRich(track: Pick<TrackSummary, 'trackName' | 'artistName'>, words: VocabWord[]): RichPart[] {
  const blocks = words.map((word, index) => {
    const title = `<b>${index + 1}. ${esc(word.word)}</b>${word.ipa ? ` <code>/${esc(word.ipa.replace(/^\/|\/$/g, ''))}/</code>` : ''}${
      word.pos ? ` <i>${esc(word.pos)}</i>` : ''
    } — ${esc(word.meaning)}`;
    const rows = [
      ...(word.synonyms.length > 0 ? [`🟰 ${word.synonyms.map(esc).join(', ')}`] : []),
      ...(word.antonyms.length > 0 ? [`↔️ ${word.antonyms.map(esc).join(', ')}`] : []),
      ...(word.usage ? [`💬 <i>${esc(word.usage)}</i>`] : []),
    ];
    return rows.length > 0
      ? `<details><summary>${title}</summary><p>${rows.join('<br/>')}</p></details>`
      : `<p>${title}</p>`;
  });
  return paginateRich({
    head: `<h2>🎓 کلمات کلیدی «${esc(track.trackName)}»</h2><p><i>از سخت به آسان — روی هر کلمه بزن تا هم‌معنی، متضاد و کاربرد را ببینی</i></p><hr/>`,
    blocks,
    weight: 3,
    foot: '',
    rtl: true,
  });
}

export function artistRich(name: string, bio: ArtistBio, fans?: number): RichPart[] {
  const paragraphs = bio.bio
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => `<p>${withBreaks(part)}</p>`);
  const stats = fans ? `<p>❤️ ${esc(fans.toLocaleString('en-US'))} شنونده</p>` : '';
  const sources = bio.sources.length > 0 ? `<hr/><p>🔗 <i>منابع:</i> ${bio.sources.map(link).join(' · ')}</p>` : '';
  return paginateRich({
    head: `<h2>👤 ${esc(name)}</h2>${stats}<hr/>`,
    blocks: paragraphs.length > 0 ? paragraphs : [`<p>${withBreaks(bio.caption)}</p>`],
    foot: sources,
    rtl: true,
  });
}

// ---------------------------------------------------------------------------
// Welcome and help
// ---------------------------------------------------------------------------

export function welcomeRich(): RichPart[] {
  return [
    {
      rtl: true,
      html:
        '<h1>🎵 Lyricson</h1>' +
        '<p><i>متن موزیک + ترجمهٔ خط‌به‌خط، با معنی استعاره‌ها</i></p><hr/>' +
        '<h3>فقط یکی از این‌ها را بفرست 👇</h3>' +
        '<ul>' +
        '<li>🎼 <b>اسم موزیک</b> — <code>Coldplay Yellow</code></li>' +
        '<li>🔗 <b>لینک</b> — یوتیوب، اسپاتیفای، ساندکلاد، دیزر، اپل موزیک</li>' +
        '<li>🎧 <b>فایل موزیک</b> یا 🎬 <b>ویدیو</b> (با کپشن)</li>' +
        '<li>📜 <b>خودِ متن</b> — پیستش کن</li>' +
        '</ul>' +
        '<aside>بعد از متن اصلی، دکمهٔ «🇮🇷 ترجمهٔ خط‌به‌خط» را بزن؛ مفهوم کلی آهنگ و معنی استعاره‌ها هم می‌آید.</aside>' +
        '<hr/><footer>/help راهنما · /lang زبان ترجمه</footer>',
    },
  ];
}

export function helpRich(quotaLine: string, adminSection: boolean): RichPart[] {
  return [
    {
      rtl: true,
      html:
        '<h2>📖 راهنما</h2><hr/>' +
        '<h3>چطور کار می‌کند؟</h3>' +
        '<ol>' +
        '<li>اسم، لینک، فایل یا متن موزیک را بفرست.</li>' +
        '<li>اگر مطمئن باشم مستقیم متن را می‌فرستم؛ وگرنه چند گزینهٔ نزدیک نشانت می‌دهم.</li>' +
        '<li>با دکمهٔ «ترجمهٔ خط‌به‌خط» هر خط را با ترجمه، مفهوم کلی و معنی استعاره‌ها می‌گیری.</li>' +
        '</ol>' +
        '<h3>زیر هر متن</h3>' +
        '<ul><li>🖼 کارت موزیک</li><li>📖 داستان موزیک</li><li>🎓 کلمات کلیدی</li><li>👤 دربارهٔ هنرمند</li></ul>' +
        '<h3>برای نتیجهٔ بهتر</h3>' +
        '<ul><li>«خواننده + اسم آهنگ» دقیق‌ترین ورودی است.</li><li>لینک خودش اسم و خواننده را می‌دهد.</li><li>فایل موزیک بهتر است تگ داشته باشد، وگرنه کپشن بگذار.</li></ul>' +
        `<aside>${esc(quotaLine)}</aside>` +
        (adminSection ? '<h3>🛠 ادمین</h3><p>/admin — هوش مصنوعی، کش، ادمین‌ها، اطلاع‌رسانی، حالت تعمیر و وبهوک.</p>' : '') +
        '<hr/><footer>/lang — زبان ترجمه</footer>',
    },
  ];
}
