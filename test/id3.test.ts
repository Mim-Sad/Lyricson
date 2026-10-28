import { describe, expect, it } from 'vitest';
import { id3v2Size, mergeTags, parseId3v1, parseId3v2 } from '../src/lib/id3.js';

function syncSafeBytes(value: number): number[] {
  return [(value >> 21) & 0x7f, (value >> 14) & 0x7f, (value >> 7) & 0x7f, value & 0x7f];
}

function ascii(text: string): number[] {
  return [...text].map((char) => char.charCodeAt(0));
}

function utf8(text: string): number[] {
  return [...new TextEncoder().encode(text)];
}

function frame(id: string, text: string, version: 3 | 4): number[] {
  const payload = [0x03, ...utf8(text)]; // 0x03 = UTF-8 text frame
  const size = payload.length;
  const sizeBytes =
    version === 4
      ? syncSafeBytes(size)
      : [(size >> 24) & 0xff, (size >> 16) & 0xff, (size >> 8) & 0xff, size & 0xff];
  return [...ascii(id), ...sizeBytes, 0x00, 0x00, ...payload];
}

function id3v2(frames: number[][], version: 3 | 4): Uint8Array {
  const body = frames.flat();
  return new Uint8Array([...ascii('ID3'), version, 0x00, 0x00, ...syncSafeBytes(body.length), ...body]);
}

describe('ID3v2', () => {
  it('reads title, artist and album from v2.3 frames', () => {
    const tag = id3v2(
      [
        frame('TIT2', 'Yellow', 3),
        frame('TPE1', 'Coldplay', 3),
        frame('TALB', 'Parachutes', 3),
        frame('TCON', 'Rock', 3),
      ],
      3,
    );
    expect(parseId3v2(tag)).toEqual({ title: 'Yellow', artist: 'Coldplay', album: 'Parachutes' });
    expect(id3v2Size(tag)).toBe(tag.length);
  });

  it('reads syncsafe sizes in v2.4', () => {
    const tag = id3v2([frame('TIT2', 'بیخیال', 4), frame('TPE1', 'یاس', 4)], 4);
    expect(parseId3v2(tag)).toEqual({ title: 'بیخیال', artist: 'یاس' });
  });

  it('understands the short v2.2 frame ids', () => {
    const payload = [0x00, ...ascii('Old Tag')];
    const body = [...ascii('TT2'), (payload.length >> 16) & 0xff, (payload.length >> 8) & 0xff, payload.length & 0xff, ...payload];
    const tag = new Uint8Array([...ascii('ID3'), 2, 0x00, 0x00, ...syncSafeBytes(body.length), ...body]);
    expect(parseId3v2(tag)).toEqual({ title: 'Old Tag' });
  });

  it('never throws on truncated or foreign data', () => {
    const tag = id3v2([frame('TIT2', 'Yellow', 3)], 3);
    expect(parseId3v2(tag.subarray(0, 14))).toBeNull();
    expect(parseId3v2(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(id3v2Size(new Uint8Array([1, 2, 3]))).toBe(0);
  });
});

describe('ID3v1', () => {
  it('reads the 128 byte tail block', () => {
    const tail = new Uint8Array(128);
    tail.set(ascii('TAG'), 0);
    tail.set(ascii('Yellow'), 3);
    tail.set(ascii('Coldplay'), 33);
    tail.set(ascii('Parachutes'), 63);
    expect(parseId3v1(tail)).toEqual({ title: 'Yellow', artist: 'Coldplay', album: 'Parachutes' });
    expect(parseId3v1(new Uint8Array(10))).toBeNull();
  });
});

describe('mergeTags', () => {
  it('fills gaps from later sources', () => {
    expect(mergeTags({ title: 'A' }, { title: 'B', artist: 'C' }, null)).toEqual({ title: 'A', artist: 'C' });
  });
});
