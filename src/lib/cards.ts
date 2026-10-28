/** Telegram-HTML renderers for the extra panels under the lyrics. */
import { escapeHtml, identityLines, type Doc, type TrackMeta } from './format.js';
import type { ArtistBio, Story, VocabWord } from './insights.js';
import type { MusicInfo } from './music.js';
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

/** The music card: fully English, Telegram-styled, links open the result inside the bot. */
export function cardCaption(
  track: TrackSummary,
  meta: TrackMeta,
  links: { lyrics: string; translation: string; listen: { label: string; url: string }[] },
): string {
  const anchor = (url: string, label: string) => `<a href="${escapeHtml(url).replace(/"/g, '&quot;')}">${label}</a>`;
  const rows = [
    `📜 ${anchor(links.lyrics, 'Lyrics')}`,
    `🌐 ${anchor(links.translation, 'Lyrics + Translation')}`,
    ...(links.listen.length > 0
      ? [`🔊 Listen on ${links.listen.map((item) => anchor(item.url, escapeHtml(item.label))).join(' · ')}`]
      : []),
  ];
  return [...identityLines(track, meta), RULE, `<blockquote>${rows.join('\n')}</blockquote>`].join('\n');
}

const CONFIDENCE: Record<Story['confidence'], string> = {
  high: '✅ مبتنی بر منابع پیدا‌شده',
  medium: '〰️ ترکیبی از منابع و دانش عمومی',
  low: '⚠️ اطلاعات محدود بود؛ با احتیاط بخوان',
};

export function storyDoc(track: Pick<TrackSummary, 'trackName' | 'artistName'>, story: Story): Doc {
  return {
    head: [`📖 <b>داستان «${escapeHtml(track.trackName)}»</b>`, `🎤 ${escapeHtml(track.artistName)}`, RULE].join('\n'),
    blocks: [
      ...(story.summary ? [escapeHtml(story.summary)] : []),
      ...story.points.map((point) => `<b>▫️ ${escapeHtml(point.title)}</b>\n${escapeHtml(point.text)}`),
    ],
    foot: [`<i>${CONFIDENCE[story.confidence]}</i>`, ...(story.sources.length > 0 ? [sourcesLine(story.sources)] : [])].join('\n'),
  };
}

export function wordsDoc(track: Pick<TrackSummary, 'trackName' | 'artistName'>, words: VocabWord[]): Doc {
  const blocks = words.map((word, index) => {
    const lines = [
      `<b>${index + 1}. ${escapeHtml(word.word)}</b>${word.ipa ? `  <code>/${escapeHtml(word.ipa.replace(/^\/|\/$/g, ''))}/</code>` : ''}${
        word.pos ? `  <i>${escapeHtml(word.pos)}</i>` : ''
      }`,
      `📘 ${escapeHtml(word.meaning)}`,
      ...(word.synonyms.length > 0 ? [`🟰 ${word.synonyms.map(escapeHtml).join(', ')}`] : []),
      ...(word.antonyms.length > 0 ? [`↔️ ${word.antonyms.map(escapeHtml).join(', ')}`] : []),
      ...(word.usage ? [`💬 <i>${escapeHtml(word.usage)}</i>`] : []),
    ];
    return `<blockquote expandable>${lines.join('\n')}</blockquote>`;
  });
  return {
    head: [
      `🎓 <b>کلمات کلیدی «${escapeHtml(track.trackName)}»</b>`,
      '<i>از سخت به آسان · معنی، تلفظ، هم‌معنی، متضاد و کاربرد</i>',
      RULE,
    ].join('\n'),
    blocks,
    foot: '',
  };
}

export function artistCaption(name: string, bio: ArtistBio, fans?: number): string {
  const head = `👤 <b>${escapeHtml(name)}</b>${fans ? `  ·  ❤️ ${fans.toLocaleString('en-US')} شنونده` : ''}`;
  const caption = `${head}\n${RULE}\n${escapeHtml(bio.caption)}`;
  // Photo captions are limited to 1024 characters.
  return caption.length <= 1000 ? caption : `${caption.slice(0, 997).replace(/\s+\S*$/, '')}…`;
}

export function artistBioDoc(name: string, bio: ArtistBio): Doc | null {
  const rest = bio.bio.trim();
  if (!rest || rest === bio.caption.trim()) return null;
  return {
    head: [`📚 <b>زندگی‌نامهٔ ${escapeHtml(name)}</b>`, RULE].join('\n'),
    blocks: escapeHtml(rest).split(/\n{2,}/).map((part) => part.trim()).filter(Boolean),
    foot: bio.sources.length > 0 ? sourcesLine(bio.sources) : '',
  };
}
