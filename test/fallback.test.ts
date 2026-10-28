import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanOvhLyrics, searchFallback } from '../src/lib/fallback-lyrics.js';

afterEach(() => vi.unstubAllGlobals());

describe('lyrics.ovh fallback', () => {
  it('strips the French header and CRLF', () => {
    expect(cleanOvhLyrics('Paroles de la chanson Truce par X\r\nLine one\r\n\r\n\r\n\r\nLine two')).toBe(
      'Line one\n\nLine two',
    );
  });

  it('turns suggestions into candidates that carry lyrics', async () => {
    const body = 'a long enough lyric line\nanother lyric line here';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        if (url.includes('/suggest/')) {
          return Response.json({
            data: [
              { title: 'Truce', artist: { name: 'twenty one pilots' }, album: { title: 'Vessel' } },
              { title: 'Truce', artist: { name: 'twenty one pilots' } },
              { title: 'Nope', artist: { name: 'Nobody' } },
            ],
          });
        }
        return url.includes('Nope') ? new Response('{}', { status: 404 }) : Response.json({ lyrics: body });
      }),
    );
    const found = await searchFallback([{ q: 'Truce twenty one pilots' }]);
    expect(found).toHaveLength(1);
    expect(found[0]).toMatchObject({ trackName: 'Truce', artistName: 'twenty one pilots', source: 'lyrics.ovh' });
    expect(found[0]?.lyrics).toBe(body);
  });

  it('returns nothing when the service is down', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })));
    expect(await searchFallback([{ q: 'anything' }])).toEqual([]);
  });
});
