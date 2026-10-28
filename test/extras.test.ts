import { afterEach, describe, expect, it, vi } from 'vitest';
import { artistBioMessage, artistCaption, cardCaption, renderStory, renderWords } from '../src/lib/cards.js';
import { buildStory, buildVocabulary } from '../src/lib/insights.js';
import { findMusicInfo, primaryLink, withId3Tags } from '../src/lib/music.js';

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
    expect(renderStory({ trackName: 'Truce', artistName: 'X' }, story)).toContain('منابع');
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
    const rendered = renderWords({ trackName: 'T', artistName: 'A' }, result);
    expect(rendered).toContain('<blockquote expandable>');
    expect(rendered).toContain('🟰');
  });
});

describe('card renderers', () => {
  it('builds the card caption and keeps photo captions under the Telegram limit', () => {
    const caption = cardCaption({ trackName: 'Truce', artistName: 'twenty one pilots', albumName: 'Vessel', duration: 156 }, null);
    expect(caption).toContain('<b>Truce</b>');
    expect(caption).toContain('💿 Vessel');
    const long = artistCaption('Artist', { caption: 'متن '.repeat(600), bio: 'x', sources: [] }, 1234567);
    expect(long.length).toBeLessThanOrEqual(1024);
  });

  it('skips the long biography message when it adds nothing', () => {
    expect(artistBioMessage('A', { caption: 'same', bio: 'same', sources: [] })).toBeNull();
    expect(artistBioMessage('A', { caption: 'short', bio: 'long bio', sources: ['https://a.b/c'] })).toContain('a.b');
  });
});
