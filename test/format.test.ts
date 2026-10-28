import type { InlineKeyboard } from 'grammy';
import { describe, expect, it } from 'vitest';
import {
  candidateKeyboard,
  escapeHtml,
  lyricsKeyboard,
  parseCallbackData,
  renderCandidatesMessage,
  renderLyricsMessage,
  renderTranslationMessage,
  splitMessage,
} from '../src/lib/format.js';
import type { Translation } from '../src/lib/prompt.js';
import type { TrackSummary } from '../src/lib/types.js';

interface ButtonLike {
  text: string;
  callback_data?: string;
}

/** grammY types the keyboard as a union with game buttons; tests only need data. */
function rows(keyboard: InlineKeyboard): ButtonLike[][] {
  return keyboard.inline_keyboard as unknown as ButtonLike[][];
}

const TRACK: TrackSummary = {
  id: 16232,
  trackName: 'Yellow',
  artistName: 'Coldplay',
  albumName: 'Parachutes',
  duration: 267,
  lyrics: 'Look at the stars\nLook how they shine for you',
  source: 'lrclib',
};

const TRANSLATION: Translation = {
  theme: 'عشق و فداکاری',
  mood: 'آرام',
  model: 'mock',
  missing: 0,
  lines: [
    { i: 1, source: 'Look at the stars', text: 'به ستاره‌ها نگاه کن', note: 'اشاره به معشوق' },
    { i: 2, source: 'Look how they shine for you', text: 'ببین چطور برای تو می‌درخشند' },
  ],
};

describe('escapeHtml', () => {
  it('escapes markup inside lyrics', () => {
    expect(escapeHtml('<b> & </b>')).toBe('&lt;b&gt; &amp; &lt;/b&gt;');
  });
});

describe('header', () => {
  it('shows title, artist and album without hashtags, linking the title when a link is known', () => {
    const text = renderLyricsMessage(TRACK, 'https://open.spotify.com/track/abc');
    expect(text).toContain('<a href="https://open.spotify.com/track/abc"><b>Yellow</b></a>');
    expect(text).toContain('🎤 Coldplay');
    expect(text).toContain('💿 Parachutes');
    expect(text).not.toContain('#');
    expect(renderLyricsMessage(TRACK)).not.toContain('<a href');
  });

  it('puts the source footer last', () => {
    const text = renderLyricsMessage({ ...TRACK, source: 'lyrics.ovh' });
    expect(text.trim().endsWith('lyrics.ovh</i>')).toBe(true);
  });
});

describe('renderLyricsMessage', () => {
  it('shows the original text with its source', () => {
    const text = renderLyricsMessage(TRACK);
    expect(text).toContain('<b>Yellow</b>');
    expect(text).toContain('Coldplay');
    expect(text).toContain('LRCLIB');
    expect(text).toContain('Look at the stars');
    expect(text).toContain('۴:۲۷');
  });

  it('marks user supplied lyrics', () => {
    expect(renderLyricsMessage({ ...TRACK, source: 'user' })).toContain('متن ارسالی خودت');
  });
});

describe('renderTranslationMessage', () => {
  it('puts every source line above its translation and keeps notes in parentheses', () => {
    const text = renderTranslationMessage(TRACK, TRANSLATION, 'فارسی');
    expect(text).toContain('<blockquote>Look at the stars</blockquote>');
    expect(text).toContain('به ستاره‌ها نگاه کن');
    expect(text).toContain('<i>(اشاره به معشوق)</i>');
    expect(text).toContain('🧠');
    expect(text).toContain('حال‌و‌هوا');
  });

  it('falls back to italic source lines for long songs', () => {
    const lines = Array.from({ length: 45 }, (_, index) => ({
      i: index + 1,
      source: `line ${index + 1}`,
      text: `خط ${index + 1}`,
    }));
    const text = renderTranslationMessage(TRACK, { ...TRANSLATION, lines }, 'فارسی');
    expect(text).not.toContain('<blockquote>');
    expect(text).toContain('<i>line 1</i>');
  });
});

describe('splitMessage', () => {
  it('keeps short messages untouched', () => {
    expect(splitMessage('سلام')).toEqual(['سلام']);
  });

  it('splits long messages and labels the parts', () => {
    const long = Array.from({ length: 400 }, (_, index) => `خط شمارهٔ ${index} با متن کمی طولانی‌تر`).join('\n\n');
    const chunks = splitMessage(long, 1000);
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) expect(chunk.length).toBeLessThanOrEqual(1000);
    expect(chunks[0]).toMatch(/بخش ۱ از /);
  });
});

describe('inline keyboards', () => {
  it('builds the candidate list with paging', () => {
    const candidates: TrackSummary[] = Array.from({ length: 7 }, (_, index) => ({
      trackName: `Song ${index + 1}`,
      artistName: `Artist ${index + 1}`,
      source: 'lrclib',
    }));
    const keyboard = candidateKeyboard(candidates, 'sess1234', 0, 5);
    const grid = rows(keyboard);
    expect(grid).toHaveLength(6);
    expect(grid[0]?.[0]?.callback_data).toBe('s:sess1234:0');
    expect(grid[5]?.[0]?.callback_data).toBe('p:sess1234:1');
  });

  it('builds the lyrics keyboard with the translation button', () => {
    const keyboard = lyricsKeyboard('trk12345', { languageName: 'فارسی', searchSessionId: 'src12345' });
    const grid = rows(keyboard);
    expect(grid[0]?.[0]?.callback_data).toBe('t:trk12345:0');
    expect(grid[0]?.[0]?.text).toContain('ترجمهٔ خط‌به‌خط');
    expect(grid[1]?.map((button) => button.callback_data)).toEqual(['c:trk12345:0', 'b:trk12345:0']);
    expect(grid[2]?.map((button) => button.callback_data)).toEqual(['w:trk12345:0', 'r:trk12345:0']);
    expect(grid[3]?.[0]?.callback_data).toBe('p:src12345:0');
  });

  it('parses the new panel callbacks', () => {
    expect(parseCallbackData('c:trk12345:0')?.action).toBe('c');
    expect(parseCallbackData('r:trk12345:0')?.action).toBe('r');
    expect(parseCallbackData('x:trk12345:0')).toBeNull();
  });

  it('renders the candidate header with paging info', () => {
    const text = renderCandidatesMessage(
      [
        { trackName: 'A', artistName: 'B', source: 'lrclib' },
        { trackName: 'C', artistName: 'D', source: 'lrclib' },
      ],
      'coldplay',
      0,
      1,
    );
    expect(text).toContain('coldplay');
    expect(text).toContain('صفحهٔ ۱ از ۲');
  });
});

describe('parseCallbackData', () => {
  it('accepts our own payloads', () => {
    expect(parseCallbackData('t:abc12345:0')).toEqual({ action: 't', sessionId: 'abc12345', index: 0 });
    expect(parseCallbackData('s:abcdefgh:11')).toEqual({ action: 's', sessionId: 'abcdefgh', index: 11 });
  });

  it('rejects anything else', () => {
    expect(parseCallbackData('x:abc12345:0')).toBeNull();
    expect(parseCallbackData('t:abc12345:99999')).toBeNull();
    expect(parseCallbackData('t:ab:0')).toBeNull();
    expect(parseCallbackData('')).toBeNull();
  });
});
