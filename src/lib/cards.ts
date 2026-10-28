/** Telegram-HTML renderers for the extra panels under the lyrics. */
import { escapeHtml } from './format.js';
import type { ArtistBio, Story, VocabWord } from './insights.js';
import type { MusicInfo } from './music.js';
import { clock, faDigits } from './text.js';
import type { TrackSummary } from './types.js';

const RULE = '┄┄┄┄┄┄┄┄┄┄┄┄';

export function sourcesLine(sources: string[]): string {
  if (sources.length === 0) return '';
  const links = sources.map((url, index) => {
    let host = url;
    try {
      host = new URL(url).hostname.replace(/^www\./, '');
    } catch {
      /* keep the raw url */
    }
    return `<a href="${escapeHtml(url).replace(/"/g, '&quot;')}">${escapeHtml(host)}</a>${index < sources.length - 1 ? ' · ' : ''}`;
  });
  return `🔗 <i>منابع:</i> ${links.join('')}`;
}

export function cardCaption(
  track: Pick<TrackSummary, 'trackName' | 'artistName' | 'albumName' | 'duration'>,
  info: MusicInfo | null,
): string {
  const album = info?.album ?? track.albumName;
  const duration = info?.duration ?? track.duration;
  const meta = [album ? `💿 ${escapeHtml(album)}` : '', duration ? `⏱ ${faDigits(clock(duration))}` : '']
    .filter(Boolean)
    .join('  ·  ');
  return [`🎵 <b>${escapeHtml(track.trackName)}</b>`, `🎤 ${escapeHtml(track.artistName)}`, ...(meta ? [meta] : [])].join('\n');
}

const CONFIDENCE: Record<Story['confidence'], string> = {
  high: '✅ مبتنی بر منابع پیدا‌شده',
  medium: '〰️ ترکیبی از منابع و دانش عمومی',
  low: '⚠️ اطلاعات محدود بود؛ با احتیاط بخوان',
};

export function renderStory(track: Pick<TrackSummary, 'trackName' | 'artistName'>, story: Story): string {
  const parts = [
    `📖 <b>داستان پشت «${escapeHtml(track.trackName)}»</b>`,
    `🎤 ${escapeHtml(track.artistName)}`,
    RULE,
    ...(story.summary ? [escapeHtml(story.summary)] : []),
    ...story.points.map((point) => `<b>▫️ ${escapeHtml(point.title)}</b>\n${escapeHtml(point.text)}`),
    RULE,
    `<i>${CONFIDENCE[story.confidence]}</i>`,
    ...(story.sources.length > 0 ? [sourcesLine(story.sources)] : []),
  ];
  return parts.join('\n\n').replace(/\n\n(┄+)\n\n/g, '\n$1\n');
}

export function renderWords(track: Pick<TrackSummary, 'trackName' | 'artistName'>, words: VocabWord[]): string {
  const blocks = words.map((word, index) => {
    const lines = [
      `<b>${faDigits(index + 1)}. ${escapeHtml(word.word)}</b>${word.ipa ? `  <code>/${escapeHtml(word.ipa.replace(/^\/|\/$/g, ''))}/</code>` : ''}${
        word.pos ? `  <i>${escapeHtml(word.pos)}</i>` : ''
      }`,
      `📘 ${escapeHtml(word.meaning)}`,
      ...(word.synonyms.length > 0 ? [`🟰 ${word.synonyms.map(escapeHtml).join('، ')}`] : []),
      ...(word.antonyms.length > 0 ? [`↔️ ${word.antonyms.map(escapeHtml).join('، ')}`] : []),
      ...(word.usage ? [`💬 <i>${escapeHtml(word.usage)}</i>`] : []),
    ];
    return `<blockquote expandable>${lines.join('\n')}</blockquote>`;
  });
  return [
    `🎓 <b>کلمات کلیدی «${escapeHtml(track.trackName)}»</b>`,
    '<i>از سخت به آسان · معنی، تلفظ، هم‌معنی، متضاد و کاربرد</i>',
    RULE,
    blocks.join('\n'),
  ].join('\n');
}

export function artistCaption(name: string, bio: ArtistBio, fans?: number): string {
  const head = `👤 <b>${escapeHtml(name)}</b>${fans ? `  ·  ❤️ ${faDigits(fans.toLocaleString('en-US'))} شنونده` : ''}`;
  const caption = `${head}\n${RULE}\n${escapeHtml(bio.caption)}`;
  // Photo captions are limited to 1024 characters.
  return caption.length <= 1000 ? caption : `${caption.slice(0, 997).replace(/\s+\S*$/, '')}…`;
}

export function artistBioMessage(name: string, bio: ArtistBio): string | null {
  const rest = bio.bio.trim();
  if (!rest || rest === bio.caption.trim()) return null;
  return [`📚 <b>زندگی‌نامهٔ ${escapeHtml(name)}</b>`, RULE, escapeHtml(rest), ...(bio.sources.length > 0 ? ['', sourcesLine(bio.sources)] : [])].join(
    '\n',
  );
}
