/**
 * Music metadata from free, key-less sources: Deezer (cover, album, links, 30 s
 * preview, artist photos) and Wikipedia (artist summary and photo). Spotify is
 * optional: with a client id/secret from the admin panel the title links to the
 * Spotify track, otherwise it links to Deezer.
 */
import { LYRICSON_UA } from './identify.js';
import { logError } from './errors.js';
import { cacheGet, cachePolicy, cachePut } from './store.js';
import { normalize } from './text.js';
import type { TrackSummary } from './types.js';

const TIMEOUT_MS = 6_000;

export interface MusicInfo {
  deezerId: number;
  title: string;
  artist: string;
  artistId?: number;
  artistPicture?: string;
  album?: string;
  albumId?: number;
  /** Large cover (≈1000 px) for photos, medium for thumbnails. */
  cover?: string;
  coverMedium?: string;
  duration?: number;
  /** Album release date as Deezer reports it (YYYY-MM-DD). */
  releaseDate?: string;
  /** 30-second MP3 preview; the URL is signed and expires, so it is refreshed on demand. */
  preview?: string;
  deezerUrl?: string;
  spotifyUrl?: string;
}

export interface SpotifyCredentials {
  id: string;
  secret: string;
}

async function getJson<T>(url: string, headers: Record<string, string> = {}): Promise<T | null> {
  try {
    const response = await fetch(url, {
      headers: { accept: 'application/json', 'user-agent': LYRICSON_UA, ...headers },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch (error) {
    logError('music', error, { url });
    return null;
  }
}

interface DeezerTrack {
  id?: number;
  title?: string;
  title_short?: string;
  link?: string;
  duration?: number;
  preview?: string;
  artist?: { id?: number; name?: string; picture_xl?: string; picture_big?: string };
  album?: { id?: number; title?: string; cover_xl?: string; cover_big?: string; cover_medium?: string };
}

function fromDeezer(item: DeezerTrack): MusicInfo | null {
  const title = (item.title_short ?? item.title ?? '').trim();
  const artist = (item.artist?.name ?? '').trim();
  if (typeof item.id !== 'number' || !title || !artist) return null;
  const cover = item.album?.cover_xl ?? item.album?.cover_big;
  return {
    deezerId: item.id,
    title,
    artist,
    ...(typeof item.artist?.id === 'number' ? { artistId: item.artist.id } : {}),
    ...((item.artist?.picture_xl ?? item.artist?.picture_big)
      ? { artistPicture: (item.artist?.picture_xl ?? item.artist?.picture_big) as string }
      : {}),
    ...(item.album?.title ? { album: item.album.title } : {}),
    ...(typeof item.album?.id === 'number' ? { albumId: item.album.id } : {}),
    ...(cover ? { cover } : {}),
    ...(item.album?.cover_medium ? { coverMedium: item.album.cover_medium } : {}),
    ...(typeof item.duration === 'number' ? { duration: item.duration } : {}),
    ...(item.preview ? { preview: item.preview } : {}),
    ...(item.link ? { deezerUrl: item.link } : {}),
  };
}

/** How well a Deezer hit matches what we looked up (0..2). */
function matchScore(info: MusicInfo, track: Pick<TrackSummary, 'trackName' | 'artistName'>): number {
  const title = normalize(track.trackName);
  const artist = normalize(track.artistName);
  let score = 0;
  const infoTitle = normalize(info.title);
  if (infoTitle === title) score += 1;
  else if (infoTitle.includes(title) || title.includes(infoTitle)) score += 0.5;
  const infoArtist = normalize(info.artist);
  if (artist && (infoArtist === artist || infoArtist.includes(artist) || artist.includes(infoArtist))) score += 1;
  return score;
}

export function trackKey(track: Pick<TrackSummary, 'trackName' | 'artistName'>): string {
  return `${normalize(track.artistName)}|${normalize(track.trackName)}`.slice(0, 160);
}

let spotifyToken: { value: string; expires: number; owner: string } | null = null;

async function spotifyAccessToken(credentials: SpotifyCredentials): Promise<string | null> {
  const owner = `${credentials.id}:${credentials.secret}`;
  if (spotifyToken && spotifyToken.owner === owner && spotifyToken.expires > Date.now() + 30_000) {
    return spotifyToken.value;
  }
  try {
    const response = await fetch('https://accounts.spotify.com/api/token', {
      method: 'POST',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        authorization: `Basic ${btoa(owner)}`,
      },
      body: 'grant_type=client_credentials',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!response.ok) return null;
    const payload = (await response.json()) as { access_token?: string; expires_in?: number };
    if (!payload.access_token) return null;
    spotifyToken = {
      value: payload.access_token,
      expires: Date.now() + (payload.expires_in ?? 3600) * 1000,
      owner,
    };
    return payload.access_token;
  } catch (error) {
    logError('spotify.token', error);
    return null;
  }
}

export async function findSpotifyUrl(
  credentials: SpotifyCredentials,
  track: Pick<TrackSummary, 'trackName' | 'artistName'>,
): Promise<string | undefined> {
  const token = await spotifyAccessToken(credentials);
  if (!token) return undefined;
  const q = `track:${track.trackName} artist:${track.artistName}`;
  const payload = await getJson<{ tracks?: { items?: { external_urls?: { spotify?: string } }[] } }>(
    `https://api.spotify.com/v1/search?type=track&limit=1&q=${encodeURIComponent(q)}`,
    { authorization: `Bearer ${token}` },
  );
  return payload?.tracks?.items?.[0]?.external_urls?.spotify;
}

/**
 * Looks the track up on Deezer (and Spotify when configured). Cached in D1
 * together with the lyrics cache policy; returns null when nothing matches.
 */
export async function findMusicInfo(
  db: D1Database,
  track: Pick<TrackSummary, 'trackName' | 'artistName'>,
  spotify?: SpotifyCredentials,
): Promise<MusicInfo | null> {
  const key = `m:${trackKey(track)}`;
  const missKey = `mn:${trackKey(track)}`;
  const cached = await cacheGet<MusicInfo>(db, 'lyric_cache', key, cachePolicy.lyricsTtl);
  if (cached) return cached;
  // A miss is remembered for a day only: Deezer may add the track later.
  if (await cacheGet<{ none: true }>(db, 'lyric_cache', missKey, 60 * 60 * 24)) return null;

  const queries = [`artist:"${track.artistName}" track:"${track.trackName}"`, `${track.artistName} ${track.trackName}`];
  let best: MusicInfo | null = null;
  let bestScore = 0;
  for (const q of queries) {
    const result = await getJson<{ data?: DeezerTrack[] }>(
      `https://api.deezer.com/search?limit=5&q=${encodeURIComponent(q)}`,
    );
    for (const item of result?.data ?? []) {
      const info = fromDeezer(item);
      if (!info) continue;
      const score = matchScore(info, track);
      if (score > bestScore) {
        best = info;
        bestScore = score;
      }
    }
    if (bestScore >= 2) break;
  }
  // Require the title to match; an unrelated hit is worse than no card at all.
  if (!best || bestScore < 1.5) {
    await cachePut(db, 'lyric_cache', missKey, { none: true });
    return null;
  }

  const [spotifyUrl, album] = await Promise.all([
    spotify ? findSpotifyUrl(spotify, track) : Promise.resolve(undefined),
    best.albumId
      ? getJson<{ release_date?: string }>(`https://api.deezer.com/album/${best.albumId}`)
      : Promise.resolve(null),
  ]);
  if (spotifyUrl) best.spotifyUrl = spotifyUrl;
  if (album?.release_date && /^\d{4}-\d{2}-\d{2}$/.test(album.release_date)) best.releaseDate = album.release_date;
  await cachePut(db, 'lyric_cache', key, best);
  return best;
}

/** "Coldplay - Yellow" by "Coldplay" -> "Yellow"; messy upload titles are common in lyric databases. */
export function cleanTitle(title: string, artist: string): string {
  const trimmed = title.trim();
  const lower = trimmed.toLowerCase();
  const prefix = `${artist.trim().toLowerCase()} - `;
  if (artist.trim() && lower.startsWith(prefix) && trimmed.length > prefix.length) return trimmed.slice(prefix.length).trim();
  return trimmed;
}

export interface TrackIdentity {
  title: string;
  artist: string;
  album?: string;
  date?: string;
  link?: string;
}

/** The facts shown in the header: Deezer's canonical data when we have it, otherwise the lyric source's. */
export function identityOf(
  track: Pick<TrackSummary, 'trackName' | 'artistName' | 'albumName'>,
  info: MusicInfo | null | undefined,
): TrackIdentity {
  const artist = info?.artist ?? track.artistName;
  const album = info?.album ?? track.albumName;
  const link = primaryLink(info);
  return {
    title: info?.title ?? cleanTitle(track.trackName, artist),
    artist,
    ...(album ? { album } : {}),
    ...(info?.releaseDate ? { date: info.releaseDate } : {}),
    ...(link ? { link } : {}),
  };
}

/** The best link for the song title: Spotify when we found it, else Deezer. */
export function primaryLink(info: MusicInfo | null | undefined): string | undefined {
  return info?.spotifyUrl ?? info?.deezerUrl;
}

// ---------------------------------------------------------------------------
// Audio preview (30 s) with proper tags and cover
// ---------------------------------------------------------------------------

export async function fetchBytes(url: string, maxBytes = 15 * 1024 * 1024): Promise<Uint8Array | null> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(12_000) });
    if (!response.ok) return null;
    const buffer = new Uint8Array(await response.arrayBuffer());
    return buffer.byteLength > 0 && buffer.byteLength <= maxBytes ? buffer : null;
  } catch (error) {
    logError('music.fetch', error, { url });
    return null;
  }
}

/** Deezer preview links expire; ask for a fresh one when the stored link fails. */
export async function freshPreviewUrl(deezerId: number): Promise<string | undefined> {
  const item = await getJson<DeezerTrack>(`https://api.deezer.com/track/${deezerId}`);
  return item?.preview;
}

function syncSafe(size: number): number[] {
  return [(size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f];
}

function bigEndian32(value: number): number[] {
  return [(value >>> 24) & 0xff, (value >>> 16) & 0xff, (value >>> 8) & 0xff, value & 0xff];
}

function textFrame(id: string, text: string): number[] {
  const body = [1, 0xff, 0xfe, ...utf16le(text)]; // UTF-16 with BOM
  return [...new TextEncoder().encode(id), ...bigEndian32(body.length), 0, 0, ...body];
}

function utf16le(text: string): number[] {
  const out: number[] = [];
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    out.push(code & 0xff, code >> 8);
  }
  out.push(0, 0);
  return out;
}

function pictureFrame(jpeg: Uint8Array): number[] {
  const head = [0, ...new TextEncoder().encode('image/jpeg'), 0, 3, 0]; // latin1, mime, front cover, empty description
  const size = head.length + jpeg.length;
  return [...new TextEncoder().encode('APIC'), ...bigEndian32(size), 0, 0, ...head];
}

/** Returns the MP3 with a fresh ID3v2.3 tag (title, artist, album, cover) in front of the audio. */
export function withId3Tags(
  mp3: Uint8Array,
  tags: { title: string; artist: string; album?: string; cover?: Uint8Array },
): Uint8Array {
  let audioStart = 0;
  if (mp3[0] === 0x49 && mp3[1] === 0x44 && mp3[2] === 0x33) {
    const size = ((mp3[6] ?? 0) << 21) | ((mp3[7] ?? 0) << 14) | ((mp3[8] ?? 0) << 7) | (mp3[9] ?? 0);
    audioStart = 10 + size;
  }
  const frames: number[] = [
    ...textFrame('TIT2', tags.title),
    ...textFrame('TPE1', tags.artist),
    ...(tags.album ? textFrame('TALB', tags.album) : []),
  ];
  const coverFrameHead = tags.cover ? pictureFrame(tags.cover) : [];
  const framesSize = frames.length + coverFrameHead.length + (tags.cover?.length ?? 0);
  const header = [0x49, 0x44, 0x33, 3, 0, 0, ...syncSafe(framesSize)];
  const audio = mp3.subarray(audioStart);
  const out = new Uint8Array(header.length + framesSize + audio.length);
  out.set(header, 0);
  out.set(frames, header.length);
  let offset = header.length + frames.length;
  if (tags.cover) {
    out.set(coverFrameHead, offset);
    offset += coverFrameHead.length;
    out.set(tags.cover, offset);
    offset += tags.cover.length;
  }
  out.set(audio, offset);
  return out;
}

// ---------------------------------------------------------------------------
// Artist: Deezer + Wikipedia
// ---------------------------------------------------------------------------

export interface ArtistInfo {
  name: string;
  fans?: number;
  deezerUrl?: string;
  wikiExtract?: string;
  wikiUrl?: string;
  /** Photos Telegram can fetch directly: artist portrait first, then album covers. */
  photos: string[];
  albums: string[];
}

export async function findArtistInfo(
  db: D1Database,
  name: string,
  artistId?: number,
): Promise<ArtistInfo> {
  const key = `art:${normalize(name)}`;
  const cached = await cacheGet<ArtistInfo>(db, 'lyric_cache', key, cachePolicy.lyricsTtl);
  if (cached) return cached;

  const info: ArtistInfo = { name, photos: [], albums: [] };

  const deezer = artistId
    ? await getJson<{ name?: string; nb_fan?: number; link?: string; picture_xl?: string }>(
        `https://api.deezer.com/artist/${artistId}`,
      )
    : null;
  if (deezer) {
    if (deezer.name) info.name = deezer.name;
    if (typeof deezer.nb_fan === 'number') info.fans = deezer.nb_fan;
    if (deezer.link) info.deezerUrl = deezer.link;
    if (deezer.picture_xl) info.photos.push(deezer.picture_xl);
  }

  const [albums, wikiSearch] = await Promise.all([
    artistId
      ? getJson<{ data?: { title?: string; cover_xl?: string; record_type?: string }[] }>(
          `https://api.deezer.com/artist/${artistId}/albums?limit=12`,
        )
      : Promise.resolve(null),
    getJson<{ pages?: { key?: string }[] }>(
      `https://en.wikipedia.org/w/rest.php/v1/search/title?limit=1&q=${encodeURIComponent(name)}`,
    ),
  ]);

  const covers = (albums?.data ?? [])
    .filter((album) => album.cover_xl && !/album_default|\/0x1000/.test(album.cover_xl))
    .map((album) => album.cover_xl as string);
  info.albums = [...new Set(covers)].slice(0, 6);

  const wikiKey = wikiSearch?.pages?.[0]?.key;
  if (wikiKey) {
    const summary = await getJson<{
      type?: string;
      extract?: string;
      originalimage?: { source?: string };
      thumbnail?: { source?: string };
      content_urls?: { desktop?: { page?: string } };
    }>(`https://en.wikipedia.org/api/rest_v1/page/summary/${encodeURIComponent(wikiKey)}`);
    if (summary && summary.type !== 'disambiguation' && summary.extract) {
      info.wikiExtract = summary.extract;
      if (summary.content_urls?.desktop?.page) info.wikiUrl = summary.content_urls.desktop.page;
      const photo = summary.thumbnail?.source ?? summary.originalimage?.source;
      if (photo && !info.photos.includes(photo)) info.photos.push(photo);
    }
  }

  await cachePut(db, 'lyric_cache', key, info);
  return info;
}

// ---------------------------------------------------------------------------
// Canonical title/artist for a free-text query
// ---------------------------------------------------------------------------

export interface Canonical {
  title: string;
  artist: string;
}

/**
 * "Truce twenty one pilots" -> { title: "Truce", artist: "twenty one pilots" }.
 * Deezer's catalogue is a far better parser of messy queries than any regex, and
 * the clean pair makes the exact lyric lookups (LRCLIB /get, lyrics.ovh) hit.
 */
export async function resolveCanonical(db: D1Database, query: string): Promise<Canonical | null> {
  const needle = normalize(query);
  if (needle.length < 3) return null;
  const key = `q:${needle.slice(0, 120)}`;
  const cached = await cacheGet<Canonical>(db, 'lyric_cache', key, cachePolicy.lyricsTtl);
  if (cached) return cached;
  if (await cacheGet<{ none: true }>(db, 'lyric_cache', `qn:${needle.slice(0, 120)}`, 60 * 60 * 24)) return null;

  const result = await getJson<{ data?: DeezerTrack[] }>(
    `https://api.deezer.com/search?limit=6&q=${encodeURIComponent(query)}`,
  );
  let found: Canonical | null = null;
  for (const item of result?.data ?? []) {
    const info = fromDeezer(item);
    if (!info) continue;
    const title = normalize(info.title);
    const artist = normalize(info.artist);
    // Both the title and the artist must be recognisable inside what the user typed.
    if (title.length > 1 && artist.length > 1 && needle.includes(title) && needle.includes(artist)) {
      found = { title: info.title, artist: info.artist };
      break;
    }
  }
  if (found) await cachePut(db, 'lyric_cache', key, found);
  else await cachePut(db, 'lyric_cache', `qn:${needle.slice(0, 120)}`, { none: true });
  return found;
}
