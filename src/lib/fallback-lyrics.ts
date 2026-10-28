/**
 * Second lyrics source (lyrics.ovh, free, no key). It only runs when LRCLIB
 * returned nothing usable, e.g. while LRCLIB answers 429 to shared Worker IPs.
 * lyrics.ovh has no lyrics-bearing search, so we ask its suggest endpoint for a
 * few candidates and fetch their lyrics one by one.
 */
import { LYRICSON_UA } from './identify.js';
import { logError } from './errors.js';
import { normalize, type SearchHint } from './text.js';
import type { TrackSummary } from './types.js';

const BASE = 'https://api.lyrics.ovh';
const TIMEOUT_MS = 8_000;
const MAX_CANDIDATES = 3;

interface SuggestResponse {
  data?: {
    title?: string;
    title_short?: string;
    duration?: number;
    artist?: { name?: string };
    album?: { title?: string };
  }[];
}

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': LYRICSON_UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch (error) {
    logError('lyrics.ovh', error, { url });
    return null;
  }
}

/** lyrics.ovh sometimes prefixes "Paroles de la chanson …" and uses CRLF. */
export function cleanOvhLyrics(raw: string): string {
  return raw
    .replace(/\r\n/g, '\n')
    .replace(/^Paroles de la chanson[^\n]*\n+/i, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function fetchOvhLyrics(artist: string, title: string): Promise<string | null> {
  const payload = await getJson<{ lyrics?: string }>(
    `${BASE}/v1/${encodeURIComponent(artist)}/${encodeURIComponent(title)}`,
  );
  const lyrics = payload?.lyrics ? cleanOvhLyrics(payload.lyrics) : '';
  return lyrics.length > 20 ? lyrics : null;
}

export async function searchFallback(hints: SearchHint[]): Promise<TrackSummary[]> {
  const hint = hints.find((entry) => entry.q && entry.q.length > 1);
  if (!hint) return [];
  const suggest = await getJson<SuggestResponse>(`${BASE}/suggest/${encodeURIComponent(hint.q)}`);
  const seen = new Set<string>();
  const out: TrackSummary[] = [];
  for (const item of suggest?.data ?? []) {
    const trackName = (item.title_short ?? item.title ?? '').trim();
    const artistName = (item.artist?.name ?? '').trim();
    const key = `${normalize(trackName)}|${normalize(artistName)}`;
    if (!trackName || !artistName || seen.has(key)) continue;
    seen.add(key);
    const lyrics = await fetchOvhLyrics(artistName, trackName);
    if (!lyrics) continue;
    out.push({
      trackName,
      artistName,
      ...(item.album?.title ? { albumName: item.album.title } : {}),
      ...(typeof item.duration === 'number' ? { duration: item.duration } : {}),
      lyrics,
      source: 'lyrics.ovh',
    });
    if (out.length >= MAX_CANDIDATES) break;
  }
  return out;
}

export async function probeFallback(): Promise<{ ok: boolean; detail: string }> {
  const started = Date.now();
  try {
    const response = await fetch(`${BASE}/suggest/${encodeURIComponent('coldplay yellow')}`, {
      headers: { accept: 'application/json', 'user-agent': LYRICSON_UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const ms = Date.now() - started;
    if (!response.ok) return { ok: false, detail: `HTTP ${response.status} (${ms}ms)` };
    const body = (await response.json()) as SuggestResponse;
    return { ok: (body.data?.length ?? 0) > 0, detail: `${body.data?.length ?? 0} پیشنهاد (${ms}ms)` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}
