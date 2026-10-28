/**
 * Message rendering: HTML escaping, the bilingual line-by-line layout, message
 * splitting for the 4096 character limit, and the inline keyboards.
 */
import { InlineKeyboard } from 'grammy';
import { candidatesHeader } from './messages.js';
import type { Translation } from './prompt.js';
import { clock, faDigits, latinDigits, stripParentheses, truncate } from './text.js';
import type { TrackSummary } from './types.js';

export const TELEGRAM_LIMIT = 4096;
export const SAFE_LIMIT = 3800;
/** Telegram renders at most 100 formatting entities per message; stay below it. */
const MAX_ENTITIES = 90;

function countEntities(html: string): number {
  return (html.match(/<(?!\/)[a-z]/gi) ?? []).length;
}

export function escapeHtml(input: string): string {
  return latinDigits(input).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const RULE = '┄┄┄┄┄┄┄┄┄┄┄┄';

const SOURCE_LABELS: Record<TrackSummary['source'], string> = {
  lrclib: 'LRCLIB',
  'lyrics.ovh': 'lyrics.ovh',
  lyrist: 'Lyrist',
  user: 'متن ارسالی خودت',
};

export interface TrackMeta {
  title?: string;
  artist?: string;
  album?: string;
  /** Release date, YYYY-MM-DD. */
  date?: string;
  /** Spotify / Deezer page for the title. */
  link?: string;
}

/** The "identity card" block: English labels, Latin digits, title as a link when known. */
export function identityLines(track: TrackSummary, meta: TrackMeta = {}): string[] {
  const title = escapeHtml(meta.title ?? track.trackName);
  const linkedTitle = meta.link
    ? `<a href="${escapeHtml(meta.link).replace(/"/g, '&quot;')}">${title}</a>`
    : title;
  const album = meta.album ?? track.albumName;
  return [
    `🎧 <b>Track:</b> ${linkedTitle}`,
    `👤 <b>Artist:</b> ${escapeHtml(meta.artist ?? track.artistName)}`,
    ...(album ? [`💽 <b>Album:</b> ${escapeHtml(album)}`] : []),
    ...(meta.date ? [`📅 <b>Date:</b> ${escapeHtml(meta.date)}`] : []),
  ];
}

function sourceFooter(track: TrackSummary): string {
  return track.source === 'user'
    ? '📜 <i>متن ارسالی خودت</i>'
    : `📚 <i>منبع متن: ${SOURCE_LABELS[track.source]}</i>`;
}

export interface Doc {
  head: string;
  blocks: string[];
  foot: string;
}

/** Splits text that carries no markup (escaped lyrics) at line boundaries. */
function splitPlain(text: string, budget: number): string[] {
  if (text.length <= budget) return [text];
  const out: string[] = [];
  let current = '';
  for (const line of text.split('\n')) {
    const candidate = current ? `${current}\n${line}` : line;
    if (candidate.length <= budget) {
      current = candidate;
      continue;
    }
    if (current) out.push(current);
    let rest = line;
    while (rest.length > budget) {
      const cut = lastBreak(rest, budget);
      out.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trimStart();
    }
    current = rest;
  }
  if (current) out.push(current);
  return out;
}

/**
 * Builds Telegram-sized messages from whole blocks. A block is never cut in
 * the middle, so quotes and bold/italic runs always stay balanced; only a
 * plain-text block that is too long on its own is split (and `plainBlocks`
 * says which blocks are plain).
 */
export function paginate(doc: Doc, options: { plainBlocks?: boolean; limit?: number } = {}): string[] {
  const limit = options.limit ?? SAFE_LIMIT;
  const partHead = (index: number, total: number) => `📄 <b>بخش ${index} از ${total}</b>\n${RULE}\n`;
  const reserve = Math.max(doc.head.length, 60) + doc.foot.length + 40;
  const budget = Math.max(400, limit - reserve);

  const blocks = options.plainBlocks ? doc.blocks.flatMap((block) => splitPlain(block, budget)) : doc.blocks;
  const groups: string[][] = [];
  let current: string[] = [];
  let size = 0;
  let entities = countEntities(doc.head) + countEntities(doc.foot) + 1;
  for (const block of blocks) {
    const extra = block.length + 2;
    const blockEntities = countEntities(block);
    if (current.length > 0 && (size + extra > budget || entities + blockEntities > MAX_ENTITIES)) {
      groups.push(current);
      current = [];
      size = 0;
      entities = countEntities(doc.foot) + 1;
    }
    current.push(block);
    size += extra;
    entities += blockEntities;
  }
  if (current.length > 0) groups.push(current);
  if (groups.length === 0) groups.push([]);

  return groups.map((group, index) => {
    const first = index === 0;
    const last = index === groups.length - 1;
    const top = first ? doc.head : groups.length > 1 ? partHead(index + 1, groups.length) : '';
    const body = group.join('\n\n');
    return [top ? top.trimEnd() : '', body, last && doc.foot ? `${RULE}\n${doc.foot}` : '']
      .filter(Boolean)
      .join(first ? '\n\n' : '\n\n')
      .trim();
  });
}

export function lyricsDoc(track: TrackSummary, meta: TrackMeta = {}): Doc {
  const body = escapeHtml(track.lyrics?.trim() ?? '');
  return {
    head: [...identityLines(track, meta), RULE].join('\n'),
    blocks: body.split(/\n{2,}/).map((paragraph) => paragraph.trim()).filter(Boolean),
    foot: sourceFooter(track),
  };
}

export function renderLyricsMessage(track: TrackSummary, meta: TrackMeta = {}): string {
  const doc = lyricsDoc(track, meta);
  return [doc.head, doc.blocks.join('\n\n'), `${RULE}\n${doc.foot}`].join('\n\n');
}

export function translationDoc(
  track: TrackSummary,
  translation: Translation,
  languageName: string,
  meta: TrackMeta = {},
  themeLabel = 'مفهوم کلی',
  moodLabel = 'حال‌و‌هوا',
): Doc {
  // The original line is always a quote; pagination keeps each message under Telegram's entity limit.
  const blocks = translation.lines.map((line) => {
    const source = `<blockquote>${escapeHtml(line.source)}</blockquote>`;
    const note = line.note ? ` <i>(${escapeHtml(stripParentheses(line.note))})</i>` : '';
    return `${source}\n${escapeHtml(line.text)}${note}`;
  });
  const head = [`🇮🇷 <b>ترجمهٔ ${escapeHtml(languageName)}</b>`, ...identityLines(track, meta), RULE];
  if (translation.theme) head.push(`🧠 <b>${themeLabel}:</b> ${escapeHtml(translation.theme)}`);
  if (translation.mood) head.push(`💫 <b>${moodLabel}:</b> ${escapeHtml(translation.mood)}`);
  if (translation.theme || translation.mood) head.push(RULE);
  return { head: head.join('\n'), blocks, foot: sourceFooter(track) };
}

export function renderTranslationMessage(
  track: TrackSummary,
  translation: Translation,
  languageName: string,
  meta: TrackMeta = {},
  themeLabel = 'مفهوم کلی',
  moodLabel = 'حال‌و‌هوا',
): string {
  const doc = translationDoc(track, translation, languageName, meta, themeLabel, moodLabel);
  return `${doc.head}\n\n${doc.blocks.join('\n\n')}\n\n${RULE}\n${doc.foot}`;
}

function lastBreak(text: string, limit: number): number {
  const window = text.slice(0, limit);
  const newline = window.lastIndexOf('\n');
  if (newline > limit * 0.5) return newline + 1;
  const space = window.lastIndexOf(' ');
  if (space > limit * 0.5) return space + 1;
  return limit;
}

/** Splits a rendered message into Telegram-sized chunks. */
export function splitMessage(text: string, limit = SAFE_LIMIT): string[] {
  const trimmed = text.trim();
  if (trimmed.length <= limit) return [trimmed];

  // Room for the "part 1 of 3" label that gets prepended to every chunk.
  const budget = Math.max(240, limit - 80);
  const chunks: string[] = [];
  let current = '';
  const flush = () => {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  };

  for (const rawBlock of trimmed.split('\n\n')) {
    // A single block longer than the budget loses its markup so nothing breaks.
    const block = rawBlock.length > budget - 32 ? rawBlock.replace(/<[^>]*>/g, '') : rawBlock;
    const candidate = current ? `${current}\n\n${block}` : block;
    if (candidate.length <= budget) {
      current = candidate;
      continue;
    }
    flush();
    let rest = block;
    while (rest.length > budget) {
      const cut = lastBreak(rest, budget);
      chunks.push(rest.slice(0, cut).trim());
      rest = rest.slice(cut).trimStart();
    }
    current = rest;
  }
  flush();

  if (chunks.length <= 1) return chunks;
  return chunks.map((chunk, index) => `📄 <b>بخش ${faDigits(index + 1)} از ${faDigits(chunks.length)}</b>\n${RULE}\n${chunk}`);
}

export function renderCandidatesMessage(
  candidates: TrackSummary[],
  query: string,
  page: number,
  pageSize: number,
): string {
  const pages = Math.max(1, Math.ceil(candidates.length / pageSize));
  const safePage = Math.min(Math.max(page, 0), pages - 1);
  return candidatesHeader(query, safePage + 1, pages, candidates.length);
}

export function candidateKeyboard(
  candidates: TrackSummary[],
  sessionId: string,
  page: number,
  pageSize = 5,
): InlineKeyboard {
  const keyboard = new InlineKeyboard();
  const pages = Math.max(1, Math.ceil(candidates.length / pageSize));
  const safePage = Math.min(Math.max(page, 0), pages - 1);
  const slice = candidates.slice(safePage * pageSize, safePage * pageSize + pageSize);

  slice.forEach((track, position) => {
    const index = safePage * pageSize + position;
    const label = `${faDigits(index + 1)}. ${truncate(`${track.trackName} — ${track.artistName}`, 52)}`;
    keyboard.text(label, `s:${sessionId}:${index}`).row();
  });

  if (safePage > 0) keyboard.text('◀️ صفحهٔ قبل', `p:${sessionId}:${safePage - 1}`);
  if (safePage < pages - 1) keyboard.text('صفحهٔ بعد ▶️', `p:${sessionId}:${safePage + 1}`);
  return keyboard;
}

/** Telegram's coloured buttons (Bot API 9.4+); older clients simply ignore the field. */
export function styled(keyboard: InlineKeyboard, style: 'primary' | 'success' | 'danger'): InlineKeyboard {
  const rowsList = keyboard.inline_keyboard as unknown as { style?: string }[][];
  const last = rowsList[rowsList.length - 1]?.at(-1);
  if (last) last.style = style;
  return keyboard;
}

export function lyricsKeyboard(
  sessionId: string,
  options: { languageName: string; searchSessionId?: string },
): InlineKeyboard {
  const keyboard = styled(
    new InlineKeyboard().text(`🇮🇷 ترجمهٔ خط‌به‌خط · ${options.languageName}`, `t:${sessionId}:0`),
    'primary',
  );
  keyboard
    .row()
    .text('🖼 کارت موزیک', `c:${sessionId}:0`)
    .text('📖 داستان موزیک', `b:${sessionId}:0`)
    .row()
    .text('🎓 کلمات کلیدی', `w:${sessionId}:0`)
    .text('👤 دربارهٔ هنرمند', `r:${sessionId}:0`);
  if (options.searchSessionId) {
    keyboard.row().text('🔁 نتایج دیگر', `p:${options.searchSessionId}:0`);
  }
  return keyboard;
}

export interface CallbackData {
  action: 's' | 't' | 'p' | 'c' | 'b' | 'w' | 'r' | 'y';
  sessionId: string;
  index: number;
}

export function parseCallbackData(data: string): CallbackData | null {
  const match = /^([stpcbwry]):([a-z0-9]{4,16}):(\d{1,4})$/.exec(data);
  if (!match) return null;
  const action = match[1] as CallbackData['action'];
  return { action, sessionId: match[2] ?? '', index: Number.parseInt(match[3] ?? '0', 10) };
}


/** One glass button that repeats a failed action (same callback as the original). */
export function retryKeyboard(action: CallbackData['action'], sessionId: string): InlineKeyboard {
  return new InlineKeyboard().text('🔄 تلاش دوباره', `${action}:${sessionId}:0`);
}
