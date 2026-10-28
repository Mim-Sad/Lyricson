/**
 * LRCLIB client. Free, no API key, no sign up: https://lrclib.net
 * Every call is cached in D1 so repeated taps cost nothing.
 */
import { LYRICSON_UA } from './identify.js';
import { cacheGet, cachePolicy, cachePut } from './store.js';
import { normalize, type SearchHint } from './text.js';
import type { TrackSummary } from './types.js';

const LRCLIB_BASE = 'https://lrclib.net/api';
const SEARCH_TTL = 60 * 60 * 24;
const REQUEST_TIMEOUT_MS = 12_000;

interface RawTrack {
  id?: number | null;
  trackName?: string | null;
  name?: string | null;
  artistName?: string | null;
  albumName?: string | null;
  duration?: number | null;
  instrumental?: boolean | null;
  plainLyrics?: string | null;
  syncedLyrics?: string | null;
}

async function lrclibFetch<T>(path: string): Promise<T | null> {
  try {
    const response = await fetch(`${LRCLIB_BASE}${path}`, {
      headers: { accept: 'application/json', 'user-agent': LYRICSON_UA },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

/** "[00:34.89] Look at the stars" -> "Look at the stars". */
export function syncedToPlain(synced: string): string {
  return synced
    .split(/\r?\n/)
    .map((line) =>
      line
        .replace(/^\s*\[\d{1,3}:\d{2}(?:[.:]\d{1,3})?\]\s*/g, '')
        .replace(/^\s*\[[a-z]+:[^\]]*\]\s*/gi, '')
        .trim(),
    )
    .filter((line, index, all) => !(line === '' && all[index - 1] === ''))
    .join('\n')
    .trim();
}

export function toSummary(raw: RawTrack): TrackSummary | null {
  const trackName = (raw.trackName ?? raw.name ?? '').trim();
  const artistName = (raw.artistName ?? '').trim();
  if (!trackName) return null;
  const fromSynced = raw.syncedLyrics ? syncedToPlain(raw.syncedLyrics) : '';
  const lyrics = raw.plainLyrics?.trim() || fromSynced || undefined;
  return {
    ...(typeof raw.id === 'number' ? { id: raw.id } : {}),
    trackName,
    artistName: artistName || 'Unknown artist',
    ...(raw.albumName?.trim() ? { albumName: raw.albumName.trim() } : {}),
    ...(typeof raw.duration === 'number' ? { duration: raw.duration } : {}),
    ...(raw.instrumental ? { instrumental: true } : {}),
    ...(lyrics ? { lyrics } : {}),
    source: 'lrclib',
  };
}

function cacheKeyForHint(hint: SearchHint): string {
  const parts = [hint.q, hint.track, hint.artist].map((part) => (part ?? '').trim().toLowerCase());
  return `s:${parts.join('|').slice(0, 180)}`;
}

async function searchOnce(db: D1Database, hint: SearchHint): Promise<TrackSummary[]> {
  const key = cacheKeyForHint(hint);
  const cached = await cacheGet<TrackSummary[]>(db, 'lyric_cache', key, SEARCH_TTL);
  if (cached) return cached;

  const params = new URLSearchParams();
  if (hint.track) params.set('track_name', hint.track);
  if (hint.artist) params.set('artist_name', hint.artist);
  if (!hint.track && hint.q) params.set('q', hint.q);
  if ([...params.keys()].length === 0) return [];

  const raw = await lrclibFetch<RawTrack[]>(`/search?${params.toString()}`);
  if (!raw || !Array.isArray(raw)) return [];

  const summaries = raw.map(toSummary).filter((track): track is TrackSummary => track !== null);
  void cachePut(db, 'lyric_cache', key, summaries.slice(0, 20));

  const withLyrics = summaries.filter((track) => track.lyrics && track.id).slice(0, 12);
  if (withLyrics.length > 0 && cachePolicy.enabled) {
    // Warm the per-track cache so picking a candidate needs no extra request.
    await db.batch(
      withLyrics.map((track) =>
        db
          .prepare('INSERT INTO lyric_cache (key, payload, created_at) VALUES (?1, ?2, ?3) ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, created_at = excluded.created_at')
          .bind(`g:${track.id}`, JSON.stringify(track), Math.floor(Date.now() / 1000)),
      ),
    ).catch(() => undefined);
  }
  return summaries;
}

export async function searchTracks(db: D1Database, hints: SearchHint[], limit = 12): Promise<TrackSummary[]> {
  const attempts = hints.slice(0, 3);
  if (attempts.length === 0) return [];
  const lists = await Promise.all(attempts.map((hint) => searchOnce(db, hint)));

  const merged = lists.flat();
  // The same song exists many times in LRCLIB; keep one entry per track+artist,
  // preferring the copy that actually carries lyrics.
  const usable = merged.filter((track) => Boolean(track.lyrics));
  const unusable = merged.filter((track) => !track.lyrics);
  return dedupeTracks([...usable, ...unusable]).slice(0, limit);
}

/** Collapses uploads of the same song into a single candidate. */
export function dedupeTracks(tracks: TrackSummary[]): TrackSummary[] {
  const seen = new Set<string>();
  const out: TrackSummary[] = [];
  for (const track of tracks) {
    const key = `${normalize(track.trackName)}|${normalize(track.artistName)}`;
    if (key === '|' || seen.has(key)) continue;
    seen.add(key);
    out.push(track);
  }
  return out;
}

export async function getTrackById(db: D1Database, id: number): Promise<TrackSummary | null> {
  const cached = await cacheGet<TrackSummary>(db, 'lyric_cache', `g:${id}`, cachePolicy.lyricsTtl);
  if (cached) return cached;
  const raw = await lrclibFetch<RawTrack>(`/get/${id}`);
  const track = raw ? toSummary(raw) : null;
  if (track) await cachePut(db, 'lyric_cache', `g:${id}`, track);
  return track;
}

/** Exact lookup; LRCLIB returns 404 when it has nothing for artist + track. */
export async function getTrackByMetadata(
  db: D1Database,
  meta: { track: string; artist?: string; album?: string },
): Promise<TrackSummary | null> {
  const params = new URLSearchParams({ track_name: meta.track });
  if (meta.artist) params.set('artist_name', meta.artist);
  if (meta.album) params.set('album_name', meta.album);
  const raw = await lrclibFetch<RawTrack>(`/get?${params.toString()}`);
  const track = raw ? toSummary(raw) : null;
  if (track?.id) await cachePut(db, 'lyric_cache', `g:${track.id}`, track);
  return track;
}
