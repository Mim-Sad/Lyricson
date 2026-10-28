/**
 * Backup lyrics sources, tried in order after LRCLIB: lyrics.ovh, then Lyrist
 * (both free, no key). They run when LRCLIB returned nothing usable, e.g. while
 * it answers 429 to shared Worker IPs.
 * lyrics.ovh has no lyrics-bearing search, so we ask its suggest endpoint for a
 * few candidates and fetch their lyrics one by one.
 */
import { LYRICSON_UA } from './identify.js';
import { logError } from './errors.js';
import { normalize, type SearchHint } from './text.js';
import type { TrackSummary } from './types.js';

const BASE = 'https://api.lyrics.ovh';
const LYRIST_BASE = 'https://lyrist.vercel.app/api';
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

/** Number of responses that proved a service is up (any 2xx, or a plain 404). */
let reached = 0;

async function getJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': LYRICSON_UA },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (response.ok || response.status === 404) reached++;
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

async function searchOvh(hint: SearchHint): Promise<TrackSummary[]> {
  const suggest = await getJson<SuggestResponse>(`${BASE}/suggest/${encodeURIComponent(hint.q)}`);
  const seen = new Set<string>();
  const picks: { trackName: string; artistName: string; albumName?: string; duration?: number }[] = [];
  for (const item of suggest?.data ?? []) {
    const trackName = (item.title_short ?? item.title ?? '').trim();
    const artistName = (item.artist?.name ?? '').trim();
    const key = `${normalize(trackName)}|${normalize(artistName)}`;
    if (!trackName || !artistName || seen.has(key)) continue;
    seen.add(key);
    picks.push({
      trackName,
      artistName,
      ...(item.album?.title ? { albumName: item.album.title } : {}),
      ...(typeof item.duration === 'number' ? { duration: item.duration } : {}),
    });
    if (picks.length >= MAX_CANDIDATES) break;
  }
  const lyrics = await Promise.all(picks.map((pick) => fetchOvhLyrics(pick.artistName, pick.trackName)));
  return picks.flatMap((pick, index): TrackSummary[] => {
    const text = lyrics[index];
    return text ? [{ ...pick, lyrics: text, source: 'lyrics.ovh' }] : [];
  });
}

/** Lyrist: one request by "title/artist" when both are known, otherwise by the free-text query. */
async function searchLyrist(hint: SearchHint): Promise<TrackSummary[]> {
  const path =
    hint.track && hint.artist
      ? `${encodeURIComponent(hint.track)}/${encodeURIComponent(hint.artist)}`
      : encodeURIComponent(hint.q);
  const payload = await getJson<{ lyrics?: string; title?: string; artist?: string }>(`${LYRIST_BASE}/${path}`);
  const lyrics = payload?.lyrics ? cleanOvhLyrics(payload.lyrics) : '';
  const trackName = (payload?.title ?? hint.track ?? '').trim();
  if (lyrics.length <= 20 || !trackName) return [];
  return [
    {
      trackName,
      artistName: (payload?.artist ?? hint.artist ?? 'Unknown artist').trim(),
      lyrics,
      source: 'lyrist',
    },
  ];
}

export async function searchFallback(
  hints: SearchHint[],
): Promise<{ tracks: TrackSummary[]; reachable: boolean }> {
  const before = reached;
  const hint = hints.find((entry) => entry.q && entry.q.length > 1);
  if (!hint) return { tracks: [], reachable: true };

  // With a known artist and title the direct lookup is one request and the most precise.
  if (hint.track && hint.artist) {
    const direct = await fetchOvhLyrics(hint.artist, hint.track);
    if (direct) {
      return {
        tracks: [{ trackName: hint.track, artistName: hint.artist, lyrics: direct, source: 'lyrics.ovh' }],
        reachable: true,
      };
    }
  }
  let tracks = await searchOvh(hint);
  if (tracks.length === 0) tracks = await searchLyrist(hint);
  return { tracks, reachable: reached > before };
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
