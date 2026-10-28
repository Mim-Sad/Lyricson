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

export function renderLyricsMessage(track: TrackSummary): string {
  const header = [
    `🎵 <b>${escapeHtml(track.trackName)}</b>`,
    `🎤 ${escapeHtml(track.artistName)}${track.albumName ? ` · <i>${escapeHtml(track.albumName)}</i>` : ''}${
      track.duration ? ` · ⏱ ${faDigits(clock(track.duration))}` : ''
    }`,
  ].join('\n');
  const source =
    track.source === 'user'
      ? '📜 متن ارسالی خودت'
      : `📚 منبع متن: ${track.source === 'lyrics.ovh' ? 'lyrics.ovh' : 'LRCLIB'}`;
  const body = track.lyrics?.trim() ?? '';
  return `${header}\n${source}\n\n${body}`;
}

export function renderTranslationMessage(
  track: Pick<TrackSummary, 'trackName'>,
  translation: Translation,
  languageName: string,
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

  const head = [`🇮🇷 <b>ترجمهٔ ${escapeHtml(languageName)}</b> — ${escapeHtml(track.trackName)}`];
  if (translation.theme) head.push(`🧠 <b>${themeLabel}:</b> ${escapeHtml(translation.theme)}`);
  if (translation.mood) head.push(`💫 <b>${moodLabel}:</b> ${escapeHtml(translation.mood)}`);
  head.push('➖➖➖➖➖➖➖➖');

  return `${head.join('\n')}\n${blocks.join('\n\n')}`;
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
  const budget = Math.max(240, limit - 48);
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
  return chunks.map((chunk, index) => `<b>بخش ${faDigits(index + 1)} از ${faDigits(chunks.length)}</b>\n${chunk}`);
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

export function lyricsKeyboard(
  sessionId: string,
  options: { languageName: string; searchSessionId?: string },
): InlineKeyboard {
  const keyboard = new InlineKeyboard().text(
    `🇮🇷 ترجمهٔ خط‌به‌خط (${options.languageName})`,
    `t:${sessionId}:0`,
  );
  if (options.searchSessionId) {
    keyboard.row().text('🔁 نتایج نزدیک', `p:${options.searchSessionId}:0`);
  }
  return keyboard;
}

export interface CallbackData {
  action: 's' | 't' | 'p';
  sessionId: string;
  index: number;
}

export function parseCallbackData(data: string): CallbackData | null {
  const match = /^([stp]):([a-z0-9]{4,16}):(\d{1,4})$/.exec(data);
  if (!match) return null;
  const action = match[1] as 's' | 't' | 'p';
  return { action, sessionId: match[2] ?? '', index: Number.parseInt(match[3] ?? '0', 10) };
}

