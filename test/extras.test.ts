import { afterEach, describe, expect, it, vi } from 'vitest';
import { artistBioDoc, artistCaption, cardCaption, storyDoc, wordsDoc } from '../src/lib/cards.js';
import { extractJson } from '../src/lib/ai.js';
import { paginate } from '../src/lib/format.js';
import { buildStory, buildVocabulary, cleanAiText } from '../src/lib/insights.js';
import { cleanTitle, findMusicInfo, identityOf, primaryLink, withId3Tags } from '../src/lib/music.js';

afterEach(() => vi.unstubAllGlobals());

const NO_DB = {} as D1Database; // cache helpers swallow DB errors, so lookups just skip the cache

describe('withId3Tags', () => {
  it('prepends a valid ID3v2.3 tag and keeps the audio intact', () => {
    const audio = new Uint8Array([0xff, 0xfb, 0x90, 0x00, 1, 2, 3]);
    const cover = new Uint8Array([0xff, 0xd8, 0xff, 0xd9]);
    const out = withId3Tags(audio, { title: 'Truce', artist: 'twenty one pilots', album: 'Vessel', cover });
    expect([...out.slice(0, 5)]).toEqual([0x49, 0x44, 0x33, 3, 0]);
    const size = (out[6]! << 21) | (out[7]! << 14) | (out[8]! << 7) | out[9]!;
    expect([...out.slice(10 + size)]).toEqual([...audio]);
    const text = new TextDecoder('latin1').decode(out.slice(0, 10 + size));
    expect(text).toContain('TIT2');
    expect(text).toContain('TPE1');
    expect(text).toContain('APIC');
  });

  it('replaces an existing ID3 tag instead of stacking a second one', () => {
    const old = new Uint8Array([0x49, 0x44, 0x33, 3, 0, 0, 0, 0, 0, 4, 9, 9, 9, 9, 0xff, 0xfb]);
    const out = withId3Tags(old, { title: 'T', artist: 'A' });
    expect(out.at(-2)).toBe(0xff);
    expect(out.at(-1)).toBe(0xfb);
    expect(out.length).toBeLessThan(old.length + 80);
  });
});

describe('findMusicInfo', () => {
  const hit = (title: string, artist: string) => ({
    id: 7,
    title,
    link: 'https://www.deezer.com/track/7',
    duration: 156,
    preview: 'https://cdn/p.mp3',
    artist: { id: 3, name: artist, picture_xl: 'https://img/a.jpg' },
    album: { id: 5, title: 'Vessel', cover_xl: 'https://img/xl.jpg', cover_medium: 'https://img/m.jpg' },
  });

  it('picks the matching Deezer track and prefers Spotify for the link', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('api.deezer.com/search')) {
          return Response.json({ data: [hit('Other song', 'Someone'), hit('Truce', 'twenty one pilots')] });
        }
        if (url.includes('accounts.spotify.com')) return Response.json({ access_token: 't', expires_in: 3600 });
        if (url.includes('api.spotify.com')) {
          return Response.json({ tracks: { items: [{ external_urls: { spotify: 'https://open.spotify.com/track/x' } }] } });
        }
        return new Response('', { status: 404 });
      }),
    );
    const info = await findMusicInfo(NO_DB, { trackName: 'Truce', artistName: 'twenty one pilots' }, { id: 'a', secret: 'b' });
    expect(info?.title).toBe('Truce');
    expect(info?.album).toBe('Vessel');
    expect(primaryLink(info)).toBe('https://open.spotify.com/track/x');
  });

  it('returns null rather than a wrong song', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [hit('Completely different', 'Nobody')] })));
    expect(await findMusicInfo(NO_DB, { trackName: 'Truce', artistName: 'twenty one pilots' })).toBeNull();
  });

  it('falls back to the Deezer link without Spotify credentials', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({ data: [hit('Truce', 'twenty one pilots')] })));
    const info = await findMusicInfo(NO_DB, { trackName: 'Truce', artistName: 'twenty one pilots' });
    expect(primaryLink(info)).toBe('https://www.deezer.com/track/7');
  });
});

const AI = { provider: 'openrouter' as const, apiKey: 'k', baseUrl: 'https://x/v1', model: 'm' };

function stubChat(content: unknown, annotations: unknown[] = []) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      Response.json({ choices: [{ message: { content: JSON.stringify(content), annotations }, finish_reason: 'stop' }] }),
    ),
  );
}

describe('AI panels', () => {
  it('parses a story and keeps the cited sources', async () => {
    stubChat(
      { summary: 'خلاصه', points: [{ title: 'پشت‌صحنه', text: 'متن' }, { title: '', text: 'x' }], confidence: 'high' },
      [{ type: 'url_citation', url_citation: { url: 'https://example.com/interview' } }],
    );
    const story = await buildStory(AI, { trackName: 'Truce', artistName: 'twenty one pilots' }, 'lyrics');
    expect(story.points).toHaveLength(1);
    expect(story.confidence).toBe('high');
    expect(story.sources).toEqual(['https://example.com/interview']);
    expect(paginate(storyDoc({ trackName: 'Truce', artistName: 'X' }, story)).join('')).toContain('منابع');
  });

  it('limits vocabulary to ten words and drops incomplete entries', async () => {
    const words = Array.from({ length: 14 }, (_, index) => ({
      word: `word${index}`,
      ipa: 'wɜːd',
      pos: 'n',
      meaning: 'معنی',
      synonyms: ['a', 'b', 'c', 'd'],
      antonyms: [],
      usage: 'کاربرد',
    }));
    stubChat({ words: [{ word: 'broken' }, ...words] });
    const result = await buildVocabulary(AI, { trackName: 'T', artistName: 'A' }, 'lyrics');
    expect(result).toHaveLength(10);
    expect(result[0]?.synonyms).toHaveLength(3);
    const rendered = paginate(wordsDoc({ trackName: 'T', artistName: 'A' }, result)).join('\n');
    expect(rendered).toContain('<blockquote expandable>');
    expect(rendered).toContain('🟰');
  });
});

describe('card renderers', () => {
  const TRACK = { trackName: 'Act Accordingly', artistName: 'Martin Hall', albumName: 'Over Again', source: 'lrclib' as const };

  it('builds an English card whose links are bot deep links', () => {
    const caption = cardCaption(TRACK, { date: '2026-01-30' }, {
      lyrics: 'https://t.me/bot?start=l_abc123',
      translation: 'https://t.me/bot?start=t_abc123',
      listen: [{ label: 'Deezer', url: 'https://www.deezer.com/track/1' }],
    });
    expect(caption).toContain('🎧 <b>Track:</b> Act Accordingly');
    expect(caption).toContain('📅 <b>Date:</b> 2026-01-30');
    expect(caption).toContain('<blockquote>');
    expect(caption).toContain('https://t.me/bot?start=t_abc123');
    expect(caption).not.toMatch(/[۰-۹]/);
  });

  it('keeps photo captions under the Telegram limit', () => {
    const long = artistCaption('Artist', { caption: 'متن '.repeat(600), bio: 'x', sources: [] }, 1234567);
    expect(long.length).toBeLessThanOrEqual(1024);
  });

  it('skips the long biography message when it adds nothing', () => {
    expect(artistBioDoc('A', { caption: 'same', bio: 'same', sources: [] })).toBeNull();
    expect(artistBioDoc('A', { caption: 'short', bio: 'long bio', sources: ['https://a.b/c'] })?.foot).toContain('a.b');
  });
});

describe('metadata cleanup', () => {
  it('drops the "Artist - " prefix lyric databases put in titles', () => {
    expect(cleanTitle('Coldplay - Yellow', 'Coldplay')).toBe('Yellow');
    expect(cleanTitle('Yellow', 'Coldplay')).toBe('Yellow');
  });

  it('prefers Deezer facts for the identity block', () => {
    const identity = identityOf(
      { trackName: 'Coldplay - Yellow', artistName: 'Coldplay', albumName: 'Coldplay - Yellow' },
      { deezerId: 1, title: 'Yellow', artist: 'Coldplay', album: 'Parachutes', releaseDate: '2000-07-10', deezerUrl: 'https://d/1' },
    );
    expect(identity).toMatchObject({ title: 'Yellow', album: 'Parachutes', date: '2000-07-10', link: 'https://d/1' });
    expect(identityOf({ trackName: 'Coldplay - Yellow', artistName: 'Coldplay' }, null).title).toBe('Yellow');
  });
});

describe('model output handling', () => {
  it('removes markdown, links, citations and Persian digits from AI text', () => {
    const dirty = 'منتشر شد ([elyrics.net](https://www.elyrics.net/read/x.html)). **مهم** [1] در ۱۰ ژوئیه ۲۰۰۰ https://a.b/c';
    const clean = cleanAiText(dirty);
    expect(clean).not.toMatch(/https?:|\[|\*\*/);
    expect(clean).toContain('10');
    expect(clean).toContain('2000');
  });

  it('recovers JSON that was cut off mid-answer', () => {
    const cut = '{"summary":"خلاصه","points":[{"title":"الف","text":"متن کامل"},{"title":"ب","text":"نیمه';
    const parsed = extractJson(cut) as { summary: string; points: { title: string }[] };
    expect(parsed.summary).toBe('خلاصه');
    expect(parsed.points[0]?.title).toBe('الف');
  });
});

describe('paginate', () => {
  it('never cuts a quote in half and labels the parts', () => {
    const blocks = Array.from({ length: 80 }, (_, index) => `<blockquote>line ${index}</blockquote>\nترجمه ${index}`);
    const parts = paginate({ head: '🎧 head', blocks, foot: 'footer' }, { limit: 600 });
    expect(parts.length).toBeGreaterThan(1);
    for (const part of parts) {
      expect(part.length).toBeLessThanOrEqual(600);
      expect((part.match(/<blockquote>/g) ?? []).length).toBe((part.match(/<\/blockquote>/g) ?? []).length);
    }
    expect(parts[1]).toContain('بخش 2 از');
    expect(parts.at(-1)).toContain('footer');
    expect(parts[0]).not.toContain('footer');
  });

  it('splits one huge plain paragraph at line breaks', () => {
    const paragraph = Array.from({ length: 200 }, (_, index) => `lyric line number ${index}`).join('\n');
    const parts = paginate({ head: 'h', blocks: [paragraph], foot: '' }, { limit: 500, plainBlocks: true });
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.join('\n')).toContain('lyric line number 199');
  });
});
