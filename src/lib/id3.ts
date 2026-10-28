/**
 * Minimal ID3 tag reader (ID3v2.2/2.3/2.4 text frames + ID3v1 fallback) so a
 * music file without Telegram metadata can still be identified. No dependency,
 * defensive against truncated or malformed input, and the caller can stop the
 * download as soon as `id3v2Size` bytes have arrived.
 */

export interface Id3Tags {
  title?: string;
  artist?: string;
  album?: string;
}

const TITLE_FRAMES = new Set(['TIT2', 'TT2']);
const ARTIST_FRAMES = new Set(['TPE1', 'TP1']);
const ALBUM_FRAMES = new Set(['TALB', 'TAL']);

function isId3v2Header(buf: Uint8Array): boolean {
  return buf.length >= 10 && buf[0] === 0x49 && buf[1] === 0x44 && buf[2] === 0x33;
}

/** Total size of the ID3v2 tag in bytes (including the header), 0 when absent. */
export function id3v2Size(buf: Uint8Array): number {
  if (!isId3v2Header(buf)) return 0;
  const size = syncSafe([buf[6] ?? 0, buf[7] ?? 0, buf[8] ?? 0, buf[9] ?? 0]);
  const total = 10 + size;
  return total > 0 && total < 1_048_576 ? total : 0;
}

function syncSafe(bytes: [number, number, number, number]): number {
  return ((bytes[0] & 0x7f) << 21) | ((bytes[1] & 0x7f) << 14) | ((bytes[2] & 0x7f) << 7) | (bytes[3] & 0x7f);
}

function beInt(buf: Uint8Array, start: number, length: number): number {
  let value = 0;
  for (let i = 0; i < length; i += 1) value = (value << 8) | (buf[start + i] ?? 0);
  return value >>> 0;
}

function asciiId(buf: Uint8Array, start: number, length: number): string {
  let out = '';
  for (let i = 0; i < length; i += 1) {
    const byte = buf[start + i] ?? 0;
    if (byte === 0) break;
    out += String.fromCharCode(byte);
  }
  return out;
}

function decodeWith(bytes: Uint8Array, label: string): string {
  try {
    return new TextDecoder(label, { fatal: false, ignoreBOM: false }).decode(bytes);
  } catch {
    return new TextDecoder('utf-8', { fatal: false, ignoreBOM: false }).decode(bytes);
  }
}

function cleanText(value: string): string {
  let out = value.replace(/^\ufeff/, '');
  const end = out.indexOf('\u0000');
  if (end >= 0) out = out.slice(0, end);
  // Drop control characters that show up when the wrong encoding was assumed.
  out = out.replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '').trim();
  return out;
}

function decodeFrameText(frame: Uint8Array): string {
  if (frame.length === 0) return '';
  const encoding = frame[0] ?? 0;
  const body = frame.subarray(1);
  switch (encoding) {
    case 0:
      return cleanText(decodeWith(body, 'windows-1252'));
    case 1: {
      if (body[0] === 0xff && body[1] === 0xfe) {
        return cleanText(decodeWith(swapBytes(body), 'utf-16le')).replace(/^\ufeff/, '');
      }
      if (body[0] === 0xfe && body[1] === 0xff) {
        return cleanText(decodeWith(body.subarray(2), 'utf-16be'));
      }
      return cleanText(decodeWith(body, 'utf-16le'));
    }
    case 2:
      return cleanText(decodeWith(body, 'utf-16be'));
    case 3:
      return cleanText(decodeWith(body, 'utf-8'));
    default:
      return cleanText(decodeWith(body, 'utf-8'));
  }
}

/** Little-endian BOM handling: TextDecoder has no utf-16le-with-BOM variant. */
function swapBytes(body: Uint8Array): Uint8Array {
  return body.subarray(2);
}

/** Parses a buffer that starts at the beginning of an ID3v2 tag. */
export function parseId3v2(buf: Uint8Array): Id3Tags | null {
  if (!isId3v2Header(buf)) return null;
  const version = buf[3] ?? 0;
  if (version < 2 || version > 4) return null;
  const flags = buf[5] ?? 0;
  const tagSize = syncSafe([buf[6] ?? 0, buf[7] ?? 0, buf[8] ?? 0, buf[9] ?? 0]);
  const end = Math.min(buf.length, 10 + tagSize);

  let pos = 10;
  // Extended header.
  if ((flags & 0x40) !== 0) {
    if (version === 4) pos += syncSafe([buf[pos] ?? 0, buf[pos + 1] ?? 0, buf[pos + 2] ?? 0, buf[pos + 3] ?? 0]) || 6;
    else pos += 4 + beInt(buf, pos, 4);
  }

  const tags: Id3Tags = {};
  const headerLength = version === 2 ? 6 : 10;
  const idLength = version === 2 ? 3 : 4;
  let guard = 0;

  while (pos + headerLength <= end && guard < 256) {
    guard += 1;
    const id = asciiId(buf, pos, idLength);
    if (!/^[A-Z0-9]{3,4}$/.test(id)) break; // padding reached

    let size: number;
    let formatFlags = 0;
    if (version === 2) {
      size = beInt(buf, pos + 3, 3);
    } else {
      size = version === 4
        ? syncSafe([buf[pos + 4] ?? 0, buf[pos + 5] ?? 0, buf[pos + 6] ?? 0, buf[pos + 7] ?? 0])
        : beInt(buf, pos + 4, 4);
      formatFlags = buf[pos + 9] ?? 0;
    }
    if (size <= 0 || pos + headerLength + size > end) break;

    const frame = buf.subarray(pos + headerLength, pos + headerLength + size);
    pos += headerLength + size;

    if (frame.length === 0) continue;
    // Compression (0x08), encryption (0x04) or a data-length indicator (0x01).
    if ((formatFlags & 0x0d) !== 0) continue;

    if (TITLE_FRAMES.has(id) && !tags.title) tags.title = decodeFrameText(frame) || undefined;
    else if (ARTIST_FRAMES.has(id) && !tags.artist) tags.artist = decodeFrameText(frame) || undefined;
    else if (ALBUM_FRAMES.has(id) && !tags.album) tags.album = decodeFrameText(frame) || undefined;
  }

  return tags.title || tags.artist || tags.album ? tags : null;
}

/** Parses a 128-byte ID3v1 block (the tail of the file). */
export function parseId3v1(tail: Uint8Array): Id3Tags | null {
  if (tail.length < 128) return null;
  const start = tail.length - 128;
  if (asciiId(tail, start, 3) !== 'TAG') return null;
  const read = (offset: number, length: number) =>
    cleanText(decodeWith(tail.subarray(start + offset, start + offset + length), 'windows-1252'));
  const tags: Id3Tags = {
    title: read(3, 30) || undefined,
    artist: read(33, 30) || undefined,
    album: read(63, 30) || undefined,
  };
  return tags.title || tags.artist || tags.album ? tags : null;
}

export function mergeTags(...sources: (Id3Tags | null | undefined)[]): Id3Tags {
  const out: Id3Tags = {};
  for (const source of sources) {
    if (!source) continue;
    if (!out.title && source.title) out.title = source.title;
    if (!out.artist && source.artist) out.artist = source.artist;
    if (!out.album && source.album) out.album = source.album;
  }
  return out;
}
