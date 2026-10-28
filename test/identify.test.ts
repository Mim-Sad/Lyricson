import { describe, expect, it, vi } from 'vitest';
import {
  buildFileInput,
  deriveTitleArtist,
  fetchId3Tags,
  providerForUrl,
  resolveLink,
  slugToQuery,
} from '../src/lib/identify.js';

describe('providerForUrl', () => {
  it('knows the supported platforms', () => {
    expect(providerForUrl('https://music.youtube.com/watch?v=abc')).toBe('youtube');
    expect(providerForUrl('https://youtu.be/abc')).toBe('youtube');
    expect(providerForUrl('https://open.spotify.com/track/4cOdK')).toBe('spotify');
    expect(providerForUrl('https://soundcloud.com/x/y')).toBe('soundcloud');
    expect(providerForUrl('https://www.deezer.com/track/3135556')).toBe('deezer');
    expect(providerForUrl('https://music.apple.com/us/album/1/1440833098?i=1440833198')).toBe('appleMusic');
    expect(providerForUrl('https://artist.bandcamp.com/track/song')).toBe('bandcamp');
    expect(providerForUrl('https://example.com/x')).toBe('unknown');
  });
});

describe('slugToQuery', () => {
  it('turns a readable path into a query', () => {
    expect(slugToQuery('https://artist.bandcamp.com/track/never-gonna-give-you-up')).toBe(
      'never gonna give you up',
    );
    expect(slugToQuery('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT')).toBeNull();
    expect(slugToQuery('https://www.youtube.com/watch?v=abc')).toBeNull();
  });
});

describe('deriveTitleArtist', () => {
  it('splits a YouTube title when the channel is the artist', () => {
    expect(deriveTitleArtist('Rick Astley - Never Gonna Give You Up (Official Video) (4K Remaster)', 'Rick Astley')).toEqual(
      { title: 'Never Gonna Give You Up', artist: 'Rick Astley' },
    );
  });

  it('keeps the channel as the artist when the title has no artist', () => {
    expect(deriveTitleArtist('Yellow (Official Audio)', 'Coldplay')).toEqual({
      title: 'Yellow',
      artist: 'Coldplay',
    });
  });
});

describe('resolveLink', () => {
  it('uses the YouTube oEmbed endpoint', async () => {
    const fetcher = vi.fn(async () =>
      new Response(
        JSON.stringify({
          title: 'Rick Astley - Never Gonna Give You Up (Official Video)',
          author_name: 'Rick Astley',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ) as unknown as typeof fetch;

    const info = await resolveLink('https://www.youtube.com/watch?v=dQw4w9WgXcQ', fetcher);
    expect(info.provider).toBe('youtube');
    expect(info.title).toBe('Never Gonna Give You Up');
    expect(info.artist).toBe('Rick Astley');
    const called = (fetcher as unknown as { mock: { calls: string[][] } }).mock.calls[0]?.[0];
    expect(String(called)).toContain('youtube.com/oembed');
  });

  it('reads a Spotify embed title out of the oEmbed html', async () => {
    const fetcher = vi.fn(async () =>
      new Response(
        JSON.stringify({
          html: '<iframe title="Spotify Embed: Never Gonna Give You Up"></iframe>',
        }),
        { status: 200, headers: { 'content-type': 'application/json' } },
      ),
    ) as unknown as typeof fetch;

    const info = await resolveLink('https://open.spotify.com/track/4cOdK2wGLETKBW3PvgPWqT', fetcher);
    expect(info.title).toBe('Never Gonna Give You Up');
  });

  it('falls back to the URL slug when every provider fails', async () => {
    const fetcher = vi.fn(async () => new Response('nope', { status: 500 })) as unknown as typeof fetch;
    const info = await resolveLink('https://artist.bandcamp.com/track/never-gonna-give-you-up', fetcher);
    expect(info.title).toBe('never gonna give you up');
  });
});

describe('buildFileInput', () => {
  it('prefers the caption, then metadata, then ID3', () => {
    expect(buildFileInput({ caption: 'Coldplay Yellow', meta: { title: 'A', artist: 'B' } })).toEqual({
      query: 'Coldplay Yellow',
    });
    expect(buildFileInput({ meta: { title: 'Yellow', artist: 'Coldplay' } })).toEqual({
      title: 'Yellow',
      artist: 'Coldplay',
    });
    expect(buildFileInput({ meta: {}, id3: { title: 'Yellow', artist: 'Coldplay' } })).toEqual({
      title: 'Yellow',
      artist: 'Coldplay',
    });
    expect(buildFileInput({ meta: { fileName: 'Coldplay - Yellow.mp3' } })).toEqual({
      title: 'Yellow',
      artist: 'Coldplay',
    });
    expect(buildFileInput({ meta: {} })).toEqual({});
  });
});

describe('fetchId3Tags', () => {
  it('stops reading as soon as the tag has arrived', async () => {
    const frame = [
      ...new TextEncoder().encode('TIT2'),
      0x00, 0x00, 0x00, 0x08,
      0x00, 0x00,
      0x03,
      ...new TextEncoder().encode('Yellow!'),
    ];
    const tag = new Uint8Array([
      ...new TextEncoder().encode('ID3'),
      0x03, 0x00, 0x00,
      (frame.length >> 21) & 0x7f,
      (frame.length >> 14) & 0x7f,
      (frame.length >> 7) & 0x7f,
      frame.length & 0x7f,
      ...frame,
    ]);

    const cancel = vi.fn(async () => undefined);
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(tag);
      },
      cancel,
    });
    const fetcher = vi.fn(async () =>
      new Response(stream, { status: 200 }),
    ) as unknown as typeof fetch;

    const tags = await fetchId3Tags('https://api.telegram.org/file/bot-x/music/test.mp3', fetcher);
    expect(tags.title).toBe('Yellow!');
    expect(cancel).toHaveBeenCalled();
  });

  it('returns empty tags when the request fails', async () => {
    const fetcher = vi.fn(async () => new Response('nope', { status: 404 })) as unknown as typeof fetch;
    expect(await fetchId3Tags('https://example.com/none', fetcher)).toEqual({});
  });
});
