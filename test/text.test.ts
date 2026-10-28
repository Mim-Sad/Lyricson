import { describe, expect, it } from 'vitest';
import {
  buildSearchHints,
  cleanPersianQuery,
  cleanTitle,
  clock,
  decideMatch,
  dice,
  faDigits,
  latinDigits,
  isSpecificQuery,
  looksLikeLyrics,
  normalize,
  parseArtistTitleFromFileName,
  splitArtistTitle,
  stripParentheses,
  tokenSet,
} from '../src/lib/text.js';

describe('normalize', () => {
  it('lowercases, strips accents and punctuation', () => {
    expect(normalize('Never  Gonna Give You Up!')).toBe('never gonna give you up');
    expect(normalize('Beyoncé — Halo')).toBe('beyonce halo');
  });

  it('unifies Persian and Arabic letter variants and digits', () => {
    expect(normalize('كتاب ياد')).toBe('کتاب یاد');
    expect(normalize('آهنگ ۱۲۳')).toBe('اهنگ 123');
  });
});

describe('cleanTitle', () => {
  it('drops packaging words but keeps meaningful versions', () => {
    expect(cleanTitle('Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)')).toBe(
      'Rick Astley - Never Gonna Give You Up',
    );
    expect(cleanTitle('Song (Live at Wembley)')).toBe('Song Live at Wembley');
  });

  it('never returns an empty string', () => {
    expect(cleanTitle('(Official Video)')).toBe('(Official Video)');
    expect(cleanTitle('   ')).toBe('');
  });
});

describe('artist/title splitting', () => {
  it('handles the usual separators and a leading track number', () => {
    expect(splitArtistTitle('08 - Artist - Title')).toEqual({ left: 'Artist', right: 'Title' });
    expect(splitArtistTitle('Coldplay – Yellow')).toEqual({ left: 'Coldplay', right: 'Yellow' });
    expect(splitArtistTitle('JustATitle')).toBeNull();
  });

  it('parses file names', () => {
    expect(parseArtistTitleFromFileName('Coldplay_-_Yellow.mp3')).toEqual({ title: 'Yellow', artist: 'Coldplay' });
    expect(parseArtistTitleFromFileName('yellow.mp3')).toEqual({ title: 'yellow' });
  });
});

describe('search hints', () => {
  it('puts the most precise artist + title hint first', () => {
    const hints = buildSearchHints({ title: 'Coldplay - Yellow', artist: 'Coldplay' });
    expect(hints[0]).toMatchObject({ track: 'Yellow', artist: 'Coldplay' });
  });

  it('keeps a plain query usable', () => {
    const hints = buildSearchHints({ query: 'Coldplay Yellow' });
    expect(hints[0]?.q).toBe('Coldplay Yellow');
  });

  it('strips Persian filler words from a request', () => {
    expect(cleanPersianQuery('متن آهنگ بیخیال از یاس رو ترجمه کن')).toBe('بیخیال یاس');
    expect(cleanPersianQuery('Coldplay Yellow')).toBe('');
  });
});

describe('match confidence', () => {
  const hints = buildSearchHints({ query: 'Coldplay Yellow' });

  it('goes straight to the lyrics when one hit is clearly best', () => {
    const decision = decideMatch(hints, [
      { trackName: 'Coldplay - Yellow', artistName: 'Coldplay' },
      { trackName: 'Yellow', artistName: 'Coldplay' },
    ]);
    expect(decision.confident).toBe(true);
    expect(decision.index).toBe(0);
  });

  it('prefers the right artist when titles are identical', () => {
    const artistHints = buildSearchHints({ title: 'Yellow', artist: 'Coldplay' });
    const decision = decideMatch(artistHints, [
      { trackName: 'Yellow', artistName: 'Coldplay' },
      { trackName: 'Yellow', artistName: 'Some Other Band' },
    ]);
    expect(decision.confident).toBe(true);
    expect(decision.score).toBeGreaterThan(0.9);
  });

  it('shows the list when two hits are equally good', () => {
    const bare = buildSearchHints({ query: 'Yellow' });
    const decision = decideMatch(bare, [
      { trackName: 'Yellow', artistName: 'Band One' },
      { trackName: 'Yellow', artistName: 'Band Two' },
    ]);
    expect(decision.confident).toBe(false);
    expect(decision.margin).toBe(0);
  });

  it('never trusts a single vague word, even when it is far ahead', () => {
    const bare = buildSearchHints({ query: 'yellow' });
    const decision = decideMatch(bare, [
      { trackName: 'YELLOW', artistName: 'Yellow Generation' },
      { trackName: 'Yellow Submarine', artistName: 'The Beatles' },
    ]);
    expect(decision.score).toBe(1);
    expect(decision.margin).toBeGreaterThan(0.1);
    expect(decision.confident).toBe(false);
    expect(isSpecificQuery(bare)).toBe(false);
  });
});

describe('pasted lyrics detection', () => {
  it('accepts a real multi-line lyric and rejects short queries or links', () => {
    const lyrics = [
      'Look at the stars',
      'Look how they shine for you',
      'And everything you do',
      'Yeah, they were all yellow',
    ].join('\n');
    expect(looksLikeLyrics(lyrics)).toBe(true);
    expect(looksLikeLyrics('Coldplay Yellow')).toBe(false);
    expect(looksLikeLyrics(`https://open.spotify.com/track/x\n${lyrics}`)).toBe(false);
  });
});

describe('small helpers', () => {
  it('formats durations and keeps digits Latin', () => {
    expect(clock(267)).toBe('4:27');
    expect(clock(undefined)).toBe('');
    expect(faDigits(1234)).toBe('1234');
    expect(latinDigits('نسخهٔ ۱۲۳ و ٤٥')).toBe('نسخهٔ 123 و 45');
  });

  it('unwraps AI notes exactly once', () => {
    expect(stripParentheses('(یعنی زندگی)')).toBe('یعنی زندگی');
    expect(stripParentheses('یعنی زندگی')).toBe('یعنی زندگی');
  });

  it('computes dice similarity over token sets', () => {
    expect(dice(tokenSet('a b'), tokenSet('a b'))).toBe(1);
    expect(dice(tokenSet('a b'), tokenSet('c d'))).toBe(0);
  });
});
