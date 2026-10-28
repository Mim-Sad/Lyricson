/**
 * Text helpers: normalisation, fuzzy matching for picking the right song,
 * query cleaning (including Persian filler words) and small utilities.
 */
/** One way of asking the lyrics database for a song. */
export interface SearchHint {
  /** Free-text query ("coldplay yellow"). */
  q: string;
  /** Track name when we already know it. */
  track?: string;
  /** Artist name when we already know it. */
  artist?: string;
}

const COMBINING_MARKS = /\p{M}/gu;

const PERSIAN_DIGIT_MAP: Record<string, string> = {
  '۰': '0', '۱': '1', '۲': '2', '۳': '3', '۴': '4', '۵': '5', '۶': '6', '۷': '7', '۸': '8', '۹': '9',
  '٠': '0', '١': '1', '٢': '2', '٣': '3', '٤': '4', '٥': '5', '٦': '6', '٧': '7', '٨': '8', '٩': '9',
};

/** Lowercase, strip accents and punctuation, unify Persian/Arabic variants. */
export function normalize(input: string): string {
  return input
    .normalize('NFKD')
    .replace(COMBINING_MARKS, '')
    .toLowerCase()
    .replace(/[۰-۹٠-٩]/g, (d) => PERSIAN_DIGIT_MAP[d] ?? d)
    .replace(/[يﻯﻰ]/g, 'ی')
    .replace(/[كﻙ]/g, 'ک')
    .replace(/[ۀة]/g, 'ه')
    .replace(/[\u200c\u200e\u200f\u202a-\u202e]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export function tokenSet(input: string): Set<string> {
  return new Set(normalize(input).split(' ').filter((token) => token.length > 0));
}

/** Sørensen–Dice coefficient over token sets (0..1). */
export function dice(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return (2 * shared) / (a.size + b.size);
}

export async function sha256Hex(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export function detectUrls(text: string): string[] {
  const matches = text.match(/https?:\/\/[^\s<>"'`\])]+/gi) ?? [];
  return matches.map((url) => url.replace(/[.,،؛;:!؟?]+$/u, ''));
}

/** Numbers stay Latin everywhere in the bot (kept as a function so call sites read naturally). */
export function faDigits(input: string | number): string {
  return String(input);
}

/** Persian/Arabic-Indic digits -> ASCII digits, for text coming from AI models and lyrics. */
export function latinDigits(input: string): string {
  return input.replace(/[۰-۹٠-٩]/g, (digit) => PERSIAN_DIGIT_MAP[digit] ?? digit);
}

export function truncate(input: string, max: number): string {
  const chars = [...input];
  if (chars.length <= max) return input;
  return `${chars.slice(0, Math.max(0, max - 1)).join('').trimEnd()}…`;
}

export function clock(seconds: number | undefined): string {
  if (!seconds || seconds <= 0) return '';
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  const rest = total % 60;
  return `${minutes}:${String(rest).padStart(2, '0')}`;
}

/** Removes one layer of decorative parentheses/quotes from an AI note. */
export function stripParentheses(input: string): string {
  let out = input.trim();
  for (const [open, close] of [['(', ')'], ['[', ']'], ['«', '»'], ['"', '"']] as const) {
    if (out.startsWith(open) && out.endsWith(close) && out.length > 2) {
      out = out.slice(open.length, out.length - close.length).trim();
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Song titles and search queries
// ---------------------------------------------------------------------------

/** Words that only describe the packaging of a track, never its name. */
const STRONG_NOISE = new Set([
  'official', 'officiel', 'oficial', 'videoclip', 'video', 'clip', 'lyric', 'lyrics', 'letra',
  'audio', 'hd', 'hq', 'uhd', '4k', '8k', '1080p', '720p', 'mv', 'm/v', 'visualizer', 'visualiser',
  'remaster', 'remastered', 'remasterizado', 'full', 'explicit', 'clean', 'shorts', 'tiktok',
]);

const NOISE_GROUP_RATIO = 0.6;

function isNoiseGroup(content: string): boolean {
  const tokens = normalize(content).split(' ').filter(Boolean);
  if (tokens.length === 0) return true;
  const noise = tokens.filter((token) => STRONG_NOISE.has(token));
  return noise.length / tokens.length >= NOISE_GROUP_RATIO;
}

function isStrongNoise(word: string): boolean {
  return STRONG_NOISE.has(normalize(word));
}

/** "Artist - Song (Official Video) (4K Remaster)" -> "Artist - Song". */
export function cleanTitle(raw: string): string {
  let out = raw.replace(/[([«]([^()[\]«»]*)[)\]»]/g, (_match, inner: string) =>
    isNoiseGroup(inner) ? ' ' : ` ${inner} `,
  );
  out = out.replace(/[♪♫]/g, ' ').replace(/["¡¿]/g, ' ');
  const words = out.split(/\s+/).filter(Boolean);
  while (words.length > 1 && isStrongNoise(words[0] ?? '')) words.shift();
  while (words.length > 1 && isStrongNoise(words[words.length - 1] ?? '')) words.pop();
  const joined = words.join(' ').replace(/\s*[-–—|·]+\s*$/u, '').replace(/\s{2,}/g, ' ').trim();
  return joined.length > 0 ? joined : raw.trim();
}

/** Persian sentences around a request ("متن آهنگ X رو ترجمه کن" -> "X"). */
const FA_FILLERS = new Set(
  [
    'آهنگ', 'آهنگه', 'ترانه', 'موزیک', 'متن', 'متنش', 'متنشو', 'ترجمه', 'ترجمهاش', 'ترجمهاشو', 'ترجمهش',
    'کن', 'کنید', 'کنی', 'کنه', 'کنش', 'لطفا', 'لطفاً', 'بده', 'بکن', 'میخوام', 'میخواهم', 'میخواستم',
    'برای', 'از', 'رو', 'را', 'یه', 'این', 'هم', 'و', 'با', 'چی', 'چیه', 'چیست', 'بگو', 'معنی', 'فارسی',
  ].map((word) => normalize(word)),
);

export function cleanPersianQuery(raw: string): string {
  if (!/[\u0600-\u06FF]/.test(raw)) return '';
  const tokens = raw.split(/\s+/).filter(Boolean);
  const kept = tokens.filter((token) => {
    const bare = normalize(token.replace(/[،؛؟!.«»:"']/gu, ''));
    if (bare.length === 0) return false;
    if (FA_FILLERS.has(bare)) return false;
    // Colloquial object marker: "متنشو" is the same filler as "متنش".
    return !FA_FILLERS.has(bare.replace(/و$/, ''));
  });
  const out = kept.join(' ').replace(/[،؛؟]+/gu, ' ').replace(/\s{2,}/g, ' ').trim();
  return out.length >= 2 && out !== raw.trim() ? out : '';
}

export interface SplitTitle {
  left: string;
  right: string;
}

/** Splits "Artist - Title" (also handles a leading track number). */
export function splitArtistTitle(raw: string): SplitTitle | null {
  const parts = raw
    .replace(/_/g, ' ')
    .split(/\s+[-–—|]+\s+/u)
    .map((part) => part.trim())
    .filter(Boolean);
  while (parts.length > 2 && /^\d{1,3}$/.test(parts[0] ?? '')) parts.shift();
  if (parts.length < 2) return null;
  const left = parts[0] ?? '';
  const right = parts.slice(1).join(' - ').trim();
  if (left.length === 0 || right.length === 0) return null;
  return { left, right };
}

export function parseArtistTitleFromFileName(fileName: string): { title: string; artist?: string } {
  const base = fileName
    .replace(/\.[a-z0-9]{2,5}$/i, '')
    .replace(/_/g, ' ')
    .replace(/\s{2,}/g, ' ')
    .trim();
  const split = splitArtistTitle(base);
  if (!split) return { title: cleanTitle(base) };
  return { title: cleanTitle(split.right), artist: cleanTitle(split.left) };
}

/**
 * Every reasonable way to ask LRCLIB for this song. The first hint is the most
 * specific one; all of them are used for scoring and as search fallbacks.
 */
export function buildSearchHints(input: { query?: string; title?: string; artist?: string }): SearchHint[] {
  const hints: SearchHint[] = [];
  const seen = new Set<string>();

  const add = (hint: SearchHint) => {
    const key = `${hint.q}|${hint.track ?? ''}|${hint.artist ?? ''}`.toLowerCase();
    if (seen.has(key)) return;
    const hasTrack = Boolean(hint.track && hint.track.length > 1);
    const hasQuery = Boolean(hint.q && hint.q.length > 1);
    if (!hasTrack && !hasQuery) return;
    seen.add(key);
    hints.push({ q: hint.q, ...(hint.track ? { track: hint.track } : {}), ...(hint.artist ? { artist: hint.artist } : {}) });
  };

  const title = input.title ? cleanTitle(input.title) : '';
  const artistInput = input.artist ? cleanTitle(input.artist) : '';

  if (title) {
    // The most specific hint comes first: it drives the exact lookup and the
    // confidence decision further down the line.
    const split = splitArtistTitle(title);
    if (split) {
      const left = cleanTitle(split.left);
      const right = cleanTitle(split.right);
      const primaryArtist = artistInput || left;
      add({ q: `${primaryArtist} ${right}`, track: right, artist: primaryArtist });
      add({ q: right, track: right });
      add({ q: `${right} ${left}`, track: left, artist: right });
    }
    if (artistInput) add({ q: `${artistInput} ${title}`, track: title, artist: artistInput });
    else add({ q: title, track: title });
  }

  const rawQuery = input.query ? cleanTitle(input.query) : [artistInput, title].filter(Boolean).join(' ');
  if (rawQuery) {
    add({ q: rawQuery, track: title || undefined, ...(artistInput ? { artist: artistInput } : {}) });
    const split = splitArtistTitle(rawQuery);
    if (split) {
      const left = cleanTitle(split.left);
      const right = cleanTitle(split.right);
      add({ q: rawQuery, track: left, artist: right });
      add({ q: rawQuery, track: right, artist: left });
      add({ q: left, track: left });
      add({ q: right, track: right });
    }
    const persian = cleanPersianQuery(rawQuery);
    if (persian) add({ q: persian });
  }

  return hints.slice(0, 5);
}

export interface MatchTarget {
  trackName: string;
  artistName: string;
}

/** How well a candidate matches one search hint (0..1). */
export function scoreHint(hint: SearchHint, track: MatchTarget): number {
  const queryText = hint.track ?? hint.q;
  if (!queryText) return 0;
  const queryTokens = tokenSet(queryText);
  let score = dice(queryTokens, tokenSet(track.trackName));
  if (hint.q && hint.track) {
    score = Math.max(score, dice(tokenSet(hint.q), tokenSet(track.trackName)));
  }
  if (hint.q && !hint.track) {
    score = Math.max(score, 0.6 * dice(tokenSet(hint.q), tokenSet(track.artistName)));
  }
  if (hint.artist) {
    score = 0.78 * score + 0.22 * dice(tokenSet(hint.artist), tokenSet(track.artistName));
  }
  return Math.round(Math.min(1, score) * 1000) / 1000;
}

export const CONFIDENT_SCORE = 0.85;
export const CONFIDENT_MARGIN = 0.12;

export interface RankedTrack<T> {
  track: T;
  score: number;
}

export function rankTracks<T extends MatchTarget>(hints: SearchHint[], tracks: T[]): RankedTrack<T>[] {
  if (hints.length === 0) return tracks.map((track) => ({ track, score: 0 }));
  return tracks
    .map((track) => ({
      track,
      score: hints.reduce((best, hint) => Math.max(best, scoreHint(hint, track)), 0),
    }))
    .sort((a, b) => b.score - a.score);
}

export interface MatchDecision {
  index: number;
  score: number;
  confident: boolean;
  margin: number;
}

/** A lone word ("yellow") is ambiguous by nature, so it never skips the list. */
export function isSpecificQuery(hints: SearchHint[]): boolean {
  if (hints.some((hint) => Boolean(hint.artist?.trim()))) return true;
  return hints.some((hint) => tokenSet(hint.track ?? hint.q).size >= 2);
}

/**
 * Should we skip the candidate list and go straight to the lyrics?
 * Only when the best hit is a near-exact match, clearly ahead of the runner-up,
 * and the query itself was specific enough to trust.
 */
export function decideMatch<T extends MatchTarget>(hints: SearchHint[], tracks: T[]): MatchDecision {
  if (tracks.length === 0) return { index: -1, score: 0, confident: false, margin: 0 };
  const ranked = rankTracks(hints, tracks);
  const best = ranked[0];
  if (!best) return { index: -1, score: 0, confident: false, margin: 0 };
  const second = ranked[1];
  const margin = second ? best.score - second.score : 1;
  const confident =
    tracks.length === 1
      ? best.score >= 0.7
      : best.score >= CONFIDENT_SCORE && margin >= CONFIDENT_MARGIN && isSpecificQuery(hints);
  return { index: 0, score: best.score, confident, margin: Math.round(margin * 1000) / 1000 };
}

/** Reorders a ranked list while keeping the decision index meaningful. */
export function sortRanked<T extends MatchTarget>(hints: SearchHint[], tracks: T[]): T[] {
  return rankTracks(hints, tracks).map((entry) => entry.track);
}

const MIN_LYRICS_LINES = 4;
const MIN_LYRICS_CHARS = 80;
const MAX_AVG_LINE = 120;

/** True when the message looks like lyrics the user pasted themselves. */
export function looksLikeLyrics(text: string): boolean {
  if (detectUrls(text).length > 0) return false;
  const trimmed = text.trim();
  if (trimmed.length < MIN_LYRICS_CHARS) return false;
  const lines = trimmed.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < MIN_LYRICS_LINES) return false;
  const avg = trimmed.length / lines.length;
  return avg > 8 && avg < MAX_AVG_LINE;
}
