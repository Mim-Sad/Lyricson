import { describe, expect, it, vi } from 'vitest';
import { deliver, richAvailable, setRichEnabled } from '../src/extras.js';
import { artistRich, isRtlText, lyricsRich, paginateRich, storyRich, translationRich, wordsRich } from '../src/lib/rich.js';
import type { TrackSummary } from '../src/lib/types.js';

const TRACK: TrackSummary = {
  trackName: 'Yellow',
  artistName: 'Coldplay',
  albumName: 'Parachutes',
  lyrics: 'Look at the stars\nLook how they shine for you\n\nAnd everything you do <b>',
  source: 'lrclib',
};

describe('rich builders', () => {
  it('builds an article: heading with the linked title, identity rows, stanzas with <br/>, footer', () => {
    const [part] = lyricsRich(TRACK, { link: 'https://open.spotify.com/track/x', date: '2000-07-10' });
    expect(part?.html).toContain('<h2>🎧 <a href="https://open.spotify.com/track/x">Yellow</a></h2>');
    expect(part?.html).toContain('<b>📅 Date:</b> 2000-07-10');
    expect(part?.html).toContain('<p>Look at the stars<br/>Look how they shine for you</p>');
    expect(part?.html).toContain('&lt;b&gt;');
    expect(part?.html).toContain('<footer>📚 Source: LRCLIB</footer>');
    expect(part?.rtl).toBe(false);
  });

  it('quotes every source line in translations and puts theme and mood in an aside', () => {
    const [part] = translationRich(
      TRACK,
      { theme: 'عشق', mood: 'آرام', model: 'm', missing: 0, lines: [{ i: 1, source: 'Look', text: 'نگاه کن', note: '(اشاره)' }] },
      'فارسی',
    );
    expect(part?.html).toContain('<blockquote>Look</blockquote><p>نگاه کن <i>(اشاره)</i></p>');
    expect(part?.html).toContain('<aside>');
    expect(part?.rtl).toBe(true);
  });

  it('splits by block budget, labels later parts and keeps the footer on the last one', () => {
    const blocks = Array.from({ length: 400 }, (_, index) => `<p>line ${index}</p>`);
    const parts = paginateRich({ head: '<h2>t</h2>', blocks, foot: '<footer>f</footer>', rtl: false });
    expect(parts.length).toBeGreaterThan(1);
    expect(parts[1]?.html).toContain('بخش 2 از');
    expect(parts.at(-1)?.html).toContain('<footer>f</footer>');
    expect(parts[0]?.html).not.toContain('<footer>');
  });

  it('renders story, words (collapsible) and artist pages', () => {
    const story = storyRich({ trackName: 'T', artistName: 'A' }, { summary: 'خلاصه', points: [{ title: 'عنوان', text: 'متن' }], confidence: 'high', sources: ['https://a.b/c'] }, 'ok');
    expect(story[0]?.html).toContain('<h4>▫️ عنوان</h4>');
    expect(story[0]?.html).toContain('a.b');
    const words = wordsRich({ trackName: 'T', artistName: 'A' }, [
      { word: 'ephemeral', ipa: 'ɪˈfem(ə)rəl', pos: 'adj', meaning: 'زودگذر', synonyms: ['fleeting'], antonyms: ['lasting'], usage: 'کاربرد' },
    ]);
    expect(words[0]?.html).toContain('<details><summary>');
    const artist = artistRich('Coldplay', { caption: 'c', bio: 'p1\n\np2', sources: [] }, 1234567);
    expect(artist[0]?.html).toContain('<p>p1</p><p>p2</p>');
    expect(artist[0]?.html).toContain('1,234,567');
  });

  it('detects right-to-left text', () => {
    expect(isRtlText('سلام دنیا')).toBe(true);
    expect(isRtlText('hello world')).toBe(false);
  });
});

function fakeCtx(raw: Record<string, unknown>) {
  const reply = vi.fn(async () => ({ message_id: 50 }));
  const ctx = {
    chat: { id: 1 },
    reply,
    api: { raw, deleteMessage: vi.fn(async () => true), editMessageText: vi.fn(async () => true) },
  };
  return { ctx: ctx as never, reply };
}

describe('deliver', () => {
  it('sends the rich message when Telegram accepts it', async () => {
    setRichEnabled(true);
    const sendRichMessage = vi.fn(async () => ({ message_id: 9 }));
    const { ctx, reply } = fakeCtx({ sendRichMessage });
    const id = await deliver(ctx, { classic: ['classic'], rich: [{ html: '<p>x</p>', rtl: false }] });
    expect(id).toBe(9);
    expect(sendRichMessage).toHaveBeenCalledOnce();
    expect(reply).not.toHaveBeenCalled();
  });

  it('falls back to classic HTML when the method is unknown, and stops trying for a while', async () => {
    setRichEnabled(true);
    const sendRichMessage = vi.fn(async () => {
      throw new Error('Call to sendRichMessage failed! (404: Not Found: method not found)');
    });
    const { ctx, reply } = fakeCtx({ sendRichMessage });
    await deliver(ctx, { classic: ['classic'], rich: [{ html: '<p>x</p>', rtl: false }] });
    expect(reply).toHaveBeenCalledOnce();
    expect(richAvailable()).toBe(false);
    await deliver(ctx, { classic: ['again'], rich: [{ html: '<p>y</p>', rtl: false }] });
    expect(sendRichMessage).toHaveBeenCalledOnce();
    setRichEnabled(true);
  });

  it('uses classic only when rich is switched off', async () => {
    setRichEnabled(false);
    const sendRichMessage = vi.fn();
    const { ctx, reply } = fakeCtx({ sendRichMessage });
    await deliver(ctx, { classic: ['classic'], rich: [{ html: '<p>x</p>', rtl: false }] });
    expect(sendRichMessage).not.toHaveBeenCalled();
    expect(reply).toHaveBeenCalledOnce();
    setRichEnabled(true);
  });
});

describe('welcome, reactions and effects', () => {
  it('builds the rich welcome with a list, an aside and a footer', async () => {
    const { welcomeRich, helpRich } = await import('../src/lib/rich.js');
    const html = welcomeRich()[0]?.html ?? '';
    expect(html).toContain('<h1>🎵 Lyricson</h1>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<aside>');
    expect(html).toContain('<footer>/help');
    expect(helpRich('quota 3/40', true)[0]?.html).toContain('/admin');
    expect(helpRich('quota 3/40', false)[0]?.html).not.toContain('/admin');
  });

  it('retries without the effect when Telegram rejects it', async () => {
    const { EFFECTS, resetRichBackoff, setFlairEnabled } = await import('../src/extras.js');
    resetRichBackoff();
    setRichEnabled(true);
    setFlairEnabled(true);
    const calls: unknown[] = [];
    const sendRichMessage = vi.fn(async (payload: Record<string, unknown>) => {
      calls.push(payload);
      if (payload.message_effect_id) throw new Error('Bad Request: message effect invalid');
      return { message_id: 11 };
    });
    const reply = vi.fn();
    const ctx = { chat: { id: 1, type: 'private' }, reply, api: { raw: { sendRichMessage } } } as never;
    const id = await deliver(ctx, { classic: ['x'], rich: [{ html: '<p>hi</p>', rtl: true }], effect: EFFECTS.party });
    expect(id).toBe(11);
    expect(calls).toHaveLength(2);
    expect((calls[1] as Record<string, unknown>).message_effect_id).toBeUndefined();
  });

  it('reacts only in private chats and never throws', async () => {
    const { react, setFlairEnabled } = await import('../src/extras.js');
    setFlairEnabled(true);
    const setMessageReaction = vi.fn(async () => true);
    await react({ message: { message_id: 5 }, chat: { id: 1, type: 'private' }, api: { setMessageReaction } } as never, '👀');
    expect(setMessageReaction).toHaveBeenCalledWith(1, 5, [{ type: 'emoji', emoji: '👀' }]);
    await react({ message: { message_id: 5 }, chat: { id: -1, type: 'group' }, api: { setMessageReaction } } as never, '👀');
    expect(setMessageReaction).toHaveBeenCalledOnce();
    const failing = vi.fn(async () => {
      throw new Error('REACTION_INVALID');
    });
    await expect(
      react({ message: { message_id: 5 }, chat: { id: 1, type: 'private' }, api: { setMessageReaction: failing } } as never, '🔥'),
    ).resolves.toBeUndefined();
  });
});
