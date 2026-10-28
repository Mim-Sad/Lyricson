/**
 * Turns any user input (link, audio file, caption, file name) into a search
 * query. Links are resolved through the free oEmbed endpoints of each provider,
 * with noembed.com as a generic fallback.
 */
import { parseId3v2, type Id3Tags } from './id3.js';
import { cleanTitle, parseArtistTitleFromFileName, splitArtistTitle, normalize, tokenSet, dice } from './text.js';

export const LYRICSON_UA = 'Lyricson/1.0 (+https://github.com/Mim-Sad/Lyricson)';

export type Provider = 'youtube' | 'spotify' | 'soundcloud' | 'deezer' | 'appleMusic' | 'bandcamp' | 'unknown';

export interface LinkInfo {
  url: string;
  provider: Provider;
  title?: string;
  artist?: string;
}

export interface IdentifiedInput {
  /** Free-text query handed to LRCLIB. */
  query: string;
  title?: string;
  artist?: string;
  /** Where the query came from, for the message shown to the user. */
  origin: 'text' | 'link' | 'file';
  provider?: Provider;
}

type Fetcher = typeof fetch;

const REQUEST_TIMEOUT_MS = 8000;

async function getJson<T>(fetcher: Fetcher, url: string): Promise<T | null> {
  try {
    const response = await fetcher(url, {
      headers: { accept: 'application/json', 'user-agent': LYRICSON_UA },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) return null;
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export function detectUrl(text: string): string | null {
  const match = text.match(/https?:\/\/[^\s<>"'`\]]+/i);
  if (!match) return null;
  return match[0].replace(/[.,،؛;:!؟?]+$/u, '');
}

export function providerForUrl(url: string): Provider {
  let host: string;
  try {
    host = new URL(url).hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return 'unknown';
  }
  if (host === 'youtu.be' || host.endsWith('youtube.com')) return 'youtube';
  if (host.endsWith('spotify.com')) return 'spotify';
  if (host.endsWith('soundcloud.com')) return 'soundcloud';
  if (host.endsWith('deezer.com') || host.endsWith('deezer.page.link')) return 'deezer';
  if (host.endsWith('music.apple.com') || host.endsWith('itunes.apple.com')) return 'appleMusic';
  if (host.endsWith('bandcamp.com')) return 'bandcamp';
  return 'unknown';
}

/** YouTube Music and Shorts links all resolve through the normal oEmbed. */
function canonicalYoutubeUrl(url: string): string {
  try {
    const parsed = new URL(url);
    const id = parsed.searchParams.get('v') ?? parsed.pathname.match(/\/(?:shorts|embed)\/([\w-]{6,})/)?.[1];
    return id ? `https://www.youtube.com/watch?v=${id}` : url;
  } catch {
    return url;
  }
}

function oembedEndpoint(url: string, provider: Provider): string | null {
  const encoded = encodeURIComponent(url);
  switch (provider) {
    case 'youtube':
      return `https://www.youtube.com/oembed?url=${encodeURIComponent(canonicalYoutubeUrl(url))}&format=json`;
    case 'spotify':
      return `https://open.spotify.com/oembed?url=${encoded}`;
    case 'soundcloud':
      return `https://soundcloud.com/oembed?format=json&url=${encoded}`;
    case 'deezer':
      return `https://api.deezer.com/oembed?url=${encoded}&format=json`;
    default:
      return null;
  }
}

interface OembedPayload {
  title?: string;
  author_name?: string;
  html?: string;
}

function titleFromHtml(html: string | undefined): string | undefined {
  if (!html) return undefined;
  const match = html.match(/title="([^"]+)"/i);
  if (!match) return undefined;
  return match[1]?.replace(/^Spotify Embed:\s*/i, '').trim() || undefined;
}

/** Apple Music exposes no oEmbed; the iTunes Search API does the job. */
async function appleMusicLookup(url: string, fetcher: Fetcher): Promise<{ title?: string; artist?: string }> {
  try {
    const parsed = new URL(url);
    const trackId = parsed.searchParams.get('i');
    const segments = parsed.pathname.split('/').filter(Boolean);
    const albumId = segments[segments.length - 1];
    const id = trackId ?? (/^\d+$/.test(albumId ?? '') ? albumId : undefined);
    if (!id) return {};
    const payload = await getJson<{ results?: { wrapperType?: string; trackName?: string; collectionName?: string; artistName?: string }[] }>(
      fetcher,
      `https://itunes.apple.com/lookup?id=${encodeURIComponent(id)}&entity=song&limit=1`,
    );
    const hit = payload?.results?.[0];
    if (!hit) return {};
    return { title: hit.trackName ?? hit.collectionName, artist: hit.artistName };
  } catch {
    return {};
  }
}

/** Last meaningful path segment, e.g. bandcamp.com/track/never-gonna-give-you-up. */
export function slugToQuery(url: string): string | null {
  try {
    const parsed = new URL(url);
    const segments = parsed.pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1] ?? '';
    const candidate = /^(track|album|song|audio|video|watch|index|home)$/i.test(last)
      ? segments[segments.length - 2] ?? ''
      : last;
    // Opaque ids (Spotify/Apple) carry no song name: too long, no separators.
    if (/^[A-Za-z0-9]{16,}$/.test(candidate) && !/[-_]/.test(candidate)) return null;
    const cleaned = decodeURIComponent(candidate)
      .replace(/\.[a-z0-9]{2,5}$/i, '')
      .replace(/[-_+]+/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim();
    if (cleaned.length < 3 || /^\d+$/.test(cleaned)) return null;
    return cleaned;
  } catch {
    return null;
  }
}

/** "Rick Astley - Never Gonna Give You Up (Official Video)" + channel name. */
export function deriveTitleArtist(rawTitle: string, authorName?: string): { title: string; artist?: string } {
  const cleaned = cleanTitle(rawTitle);
  const author = authorName ? cleanTitle(authorName) : undefined;
  const split = splitArtistTitle(cleaned);
  if (author) {
    if (split && normalize(split.left) === normalize(author)) {
      return { title: cleanTitle(split.right), artist: author };
    }
    return { title: cleaned, artist: author };
  }
  if (split) return { title: cleanTitle(split.right), artist: cleanTitle(split.left) };
  return { title: cleaned };
}

export async function resolveLink(url: string, fetcher: Fetcher = fetch): Promise<LinkInfo> {
  const provider = providerForUrl(url);
  const info: LinkInfo = { url, provider };

  if (provider === 'appleMusic') {
    const apple = await appleMusicLookup(url, fetcher);
    if (apple.title) {
      return { ...info, ...deriveTitleArtist(apple.title, apple.artist), ...(apple.artist ? { artist: apple.artist } : {}) };
    }
  }

  const endpoint = oembedEndpoint(url, provider);
  if (endpoint) {
    const payload = await getJson<OembedPayload>(fetcher, endpoint);
    const rawTitle = payload?.title ?? titleFromHtml(payload?.html);
    if (rawTitle) return { ...info, ...deriveTitleArtist(rawTitle, payload?.author_name) };
  }

  const generic = await getJson<OembedPayload>(fetcher, `https://noembed.com/embed?url=${encodeURIComponent(url)}`);
  const genericTitle = generic?.title ?? titleFromHtml(generic?.html);
  if (genericTitle) return { ...info, ...deriveTitleArtist(genericTitle, generic?.author_name) };

  const slug = slugToQuery(url);
  if (slug) return { ...info, title: cleanTitle(slug) };

  return info;
}

export interface AudioMetadata {
  title?: string;
  artist?: string;
  fileName?: string;
  duration?: number;
}

function withExtractedTitle(meta: AudioMetadata): AudioMetadata {
  const fileName = meta.fileName;
  if (!fileName || (meta.title && meta.artist)) return meta;
  const parsed = parseArtistTitleFromFileName(fileName);
  return {
    ...meta,
    title: meta.title ?? parsed.title,
    artist: meta.artist ?? parsed.artist,
  };
}

/** Reads the first chunk of a Telegram file and parses its ID3 tags. */
export async function fetchId3Tags(fileUrl: string, fetcher: Fetcher = fetch, maxBytes = 262_144): Promise<Id3Tags> {
  let received = new Uint8Array(0);
  try {
    const response = await fetcher(fileUrl, {
      headers: { 'user-agent': LYRICSON_UA },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS * 2),
    });
    if (!response.ok || !response.body) return {};
    const reader = response.body.getReader();
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        const merged = new Uint8Array(received.length + (value?.length ?? 0));
        merged.set(received, 0);
        if (value) merged.set(value, received.length);
        received = merged;

        const total = id3v2SizeOf(received);
        if (total > 0 && received.length >= Math.min(total, maxBytes)) break;
        if (total === 0 && received.length >= 4096) break;
        if (received.length >= maxBytes) break;
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  } catch {
    return {};
  }
  return parseId3v2(received) ?? {};
}

function id3v2SizeOf(buf: Uint8Array): number {
  if (buf.length < 10) return 0;
  if (buf[0] !== 0x49 || buf[1] !== 0x44 || buf[2] !== 0x33) return 0;
  const size =
    ((buf[6]! & 0x7f) << 21) | ((buf[7]! & 0x7f) << 14) | ((buf[8]! & 0x7f) << 7) | (buf[9]! & 0x7f);
  return 10 + size;
}

/**
 * Builds the final search input. A caption always wins (that is what the user
 * typed), then Telegram's own audio metadata, then the file name, then ID3.
 */
export function buildFileInput(options: {
  caption?: string;
  meta: AudioMetadata;
  id3?: Id3Tags;
}): { query?: string; title?: string; artist?: string } {
  const caption = options.caption?.trim();
  if (caption) return { query: caption };

  const meta = withExtractedTitle(options.meta);
  const title = meta.title?.trim() || options.id3?.title?.trim();
  const artist = meta.artist?.trim() || options.id3?.artist?.trim();
  if (title || artist) return { title, artist };
  return {};
}

/** Small helper used by tests: how alike are two song labels. */
export function labelsAlike(a: string, b: string): number {
  return Math.round(dice(tokenSet(a), tokenSet(b)) * 1000) / 1000;
}
