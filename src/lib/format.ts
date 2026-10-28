/**
 * Message rendering: HTML escaping, the bilingual line-by-line layout, message
 * splitting for the 4096 character limit, and the inline keyboards.
 */
import { InlineKeyboard } from 'grammy';
import { candidatesHeader } from './messages.js';
import type { Translation } from './prompt.js';
import { clock, faDigits, stripParentheses, truncate } from './text.js';
import type { TrackSummary } from './types.js';

export const TELEGRAM_LIMIT = 4096;
export const SAFE_LIMIT = 3800;
const QUOTE_UPTO_LINES = 40;

export function escapeHtml(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

const RULE = '┄┄┄┄┄┄┄┄┄┄┄┄';

const SOURCE_LABELS: Record<TrackSummary['source'], string> = {
  lrclib: 'LRCLIB',
  'lyrics.ovh': 'lyrics.ovh',
  lyrist: 'Lyrist',
  user: 'متن ارسالی خودت',
};

function trackHeader(track: TrackSummary, link?: string): string[] {
  const title = `<b>${escapeHtml(track.trackName)}</b>`;
  const meta = [
    track.albumName ? `💿 ${escapeHtml(track.albumName)}` : '',
    track.duration ? `⏱ ${faDigits(clock(track.duration))}` : '',
  ].filter(Boolean);
  return [
    `🎵 ${link ? `<a href="${escapeHtml(link).replace(/"/g, '&quot;')}">${title}</a>` : title}`,
    `🎤 ${escapeHtml(track.artistName)}`,
    ...(meta.length > 0 ? [meta.join('  ·  ')] : []),
  ];
}

function sourceFooter(track: TrackSummary): string {
  return track.source === 'user'
    ? '📜 <i>متن ارسالی خودت</i>'
    : `📚 <i>منبع متن: ${SOURCE_LABELS[track.source]}</i>`;
}

export function renderLyricsMessage(track: TrackSummary, link?: string): string {
  const body = escapeHtml(track.lyrics?.trim() ?? '');
  return [...trackHeader(track, link), RULE, '', body, '', RULE, sourceFooter(track)].join('\n');
}

export function renderTranslationMessage(
  track: TrackSummary,
  translation: Translation,
  languageName: string,
  link?: string,
  themeLabel = 'مفهوم کلی',
  moodLabel = 'حال‌و‌هوا',
): string {
  const quote = translation.lines.length <= QUOTE_UPTO_LINES;
  const blocks = translation.lines.map((line) => {
    const source = quote
      ? `<blockquote>${escapeHtml(line.source)}</blockquote>`
      : `<i>${escapeHtml(line.source)}</i>`;
    const note = line.note ? ` <i>(${escapeHtml(stripParentheses(line.note))})</i>` : '';
    return `${source}\n${escapeHtml(line.text)}${note}`;
  });

  const head = [`🇮🇷 <b>ترجمهٔ ${escapeHtml(languageName)}</b>`, ...trackHeader(track, link), RULE];
  if (translation.theme) head.push(`🧠 <b>${themeLabel}:</b> ${escapeHtml(translation.theme)}`);
  if (translation.mood) head.push(`💫 <b>${moodLabel}:</b> ${escapeHtml(translation.mood)}`);
  if (translation.theme || translation.mood) head.push(RULE);

  return `${head.join('\n')}\n\n${blocks.join('\n\n')}\n\n${RULE}\n${sourceFooter(track)}`;
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
  action: 's' | 't' | 'p' | 'c' | 'b' | 'w' | 'r';
  sessionId: string;
  index: number;
}

export function parseCallbackData(data: string): CallbackData | null {
  const match = /^([stpcbwr]):([a-z0-9]{4,16}):(\d{1,4})$/.exec(data);
  if (!match) return null;
  const action = match[1] as CallbackData['action'];
  return { action, sessionId: match[2] ?? '', index: Number.parseInt(match[3] ?? '0', 10) };
}

