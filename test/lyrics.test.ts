import { describe, expect, it } from 'vitest';
import { dedupeTracks, syncedToPlain, toSummary } from '../src/lib/lyrics.js';
import type { TrackSummary } from '../src/lib/types.js';

describe('dedupeTracks', () => {
  it('collapses the many uploads of one song', () => {
    const tracks: TrackSummary[] = [
      { id: 1, trackName: 'Coldplay - Yellow', artistName: 'Coldplay', lyrics: 'a', source: 'lrclib' },
      { id: 2, trackName: 'coldplay -  yellow', artistName: 'COLDPLAY', source: 'lrclib' },
      { id: 3, trackName: 'Yellow', artistName: 'Coldplay', lyrics: 'b', source: 'lrclib' },
    ];
    const result = dedupeTracks(tracks);
    expect(result.map((track) => track.id)).toEqual([1, 3]);
  });
});

describe('syncedToPlain', () => {
  it('strips timestamps and metadata tags', () => {
    const synced = '[offset:12]\n[00:34.89] Look at the stars\n[00:37.55] Look how they shine for you';
    expect(syncedToPlain(synced)).toBe('Look at the stars\nLook how they shine for you');
  });
});

describe('toSummary', () => {
  it('maps an LRCLIB record', () => {
    const track = toSummary({
      id: 16232,
      trackName: 'Yellow',
      artistName: 'Coldplay',
      albumName: 'Parachutes',
      duration: 267,
      instrumental: false,
      plainLyrics: 'Look at the stars',
    });
    expect(track).toMatchObject({
      id: 16232,
      trackName: 'Yellow',
      artistName: 'Coldplay',
      lyrics: 'Look at the stars',
      source: 'lrclib',
    });
  });

  it('falls back to synced lyrics and marks instrumental tracks', () => {
    const track = toSummary({
      id: 5,
      trackName: 'Instrumental',
      artistName: 'Nobody',
      instrumental: true,
      syncedLyrics: '[00:01.00] hmm',
    });
    expect(track?.lyrics).toBe('hmm');
    expect(track?.instrumental).toBe(true);
  });

  it('drops records without a track name', () => {
    expect(toSummary({ id: 1, artistName: 'x' })).toBeNull();
  });
});
