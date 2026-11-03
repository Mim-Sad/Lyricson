/**
 * The extras around the lyrics: the 30 s audio preview sent first, and the
 * buttons under the lyrics (music card, story, vocabulary, artist).
 */
import { InlineKeyboard, InputFile, type Context } from 'grammy';
import type { Config, Env } from './env.js';
import { describeAiError } from './lib/ai.js';
import { artistBioDoc, artistCaption, bioFitsCaption, cardCaption, storyDoc, wordsDoc } from './lib/cards.js';
import { isUserFacing, logError } from './lib/errors.js';
import { artistRich, storyRich, wordsRich, type RichPart } from './lib/rich.js';
import { paginate, retryKeyboard, type Doc, type TrackMeta } from './lib/format.js';
import {
  buildArtistBio,
  fallbackArtistBio,
  looksPersian,
  buildStory,
  buildVocabulary,
  type ArtistBio,
  type Story,
  type VocabWord,
} from './lib/insights.js';
import * as M from './lib/messages.js';
import {
  fetchBytes,
  findArtistInfo,
  type ArtistInfo,
  findMusicInfo,
  freshPreviewUrl,
  identityOf,
  trackKey,
  withId3Tags,
  type MusicInfo,
} from './lib/music.js';
import { loadSettings, type SettingsSnapshot } from './lib/settings.js';
import { cacheGet, cachePut, consumeQuota, refundQuota, saveShare } from './lib/store.js';
import { normalize, sha256Hex } from './lib/text.js';
import type { Session, TrackSummary } from './lib/types.js';

const HTML = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } } as const;

function chatIdOf(ctx: Context): number | null {
  return ctx.chat?.id ?? ctx.callbackQuery?.message?.chat.id ?? null;
}

type Extra = { reply_markup?: InlineKeyboard; replyTo?: number; effect?: string };

function replyParams(replyTo?: number): { reply_parameters?: { message_id: number; allow_sending_without_reply: true } } {
  return replyTo ? { reply_parameters: { message_id: replyTo, allow_sending_without_reply: true } } : {};
}

/**
 * Answers by editing the "searching…" message when there is one (so the user
 * saw a reply instantly), otherwise sends a fresh message (as a reply to
 * `replyTo` when given). Returns the id of the message that now holds `text`.
 */
export async function settle(
  ctx: Context,
  statusId: number | undefined,
  text: string,
  extra: Extra = {},
): Promise<number> {
  const chatId = chatIdOf(ctx);
  const markup = extra.reply_markup ? { reply_markup: extra.reply_markup } : {};
  const parseFailure = (error: unknown) => error instanceof Error && /can't parse entities|can't find end/i.test(error.message);

  if (statusId && chatId) {
    try {
      await ctx.api.editMessageText(chatId, statusId, text, { ...HTML, ...markup });
      return statusId;
    } catch (error) {
      if (error instanceof Error && /message is not modified/i.test(error.message)) return statusId;
      logError('settle', error);
      if (parseFailure(error)) {
        // Broken markup must never cost the user the answer: resend it as plain text.
        try {
          await ctx.api.editMessageText(chatId, statusId, stripHtml(text), { ...markup, link_preview_options: { is_disabled: true } });
          return statusId;
        } catch (plainError) {
          logError('settle.plain', plainError);
        }
      }
    }
  }
  try {
    try {
      const sent = await ctx.reply(text, { ...HTML, ...markup, ...replyParams(extra.replyTo), ...effectParams(ctx, extra.effect) });
      return sent.message_id;
    } catch (error) {
      // An invalid or unsupported effect must never cost the message itself.
      if (!extra.effect || parseFailure(error)) throw error;
      const sent = await ctx.reply(text, { ...HTML, ...markup, ...replyParams(extra.replyTo) });
      return sent.message_id;
    }
  } catch (error) {
    if (!parseFailure(error)) throw error;
    logError('settle.reply', error);
    const sent = await ctx.reply(stripHtml(text), {
      ...markup,
      link_preview_options: { is_disabled: true },
      ...replyParams(extra.replyTo),
    });
    return sent.message_id;
  }
}

// ---------------------------------------------------------------------------
// Reactions and message effects (free, private chats only)
// ---------------------------------------------------------------------------

let flairEnabled = true;

export function setFlairEnabled(value: boolean): void {
  flairEnabled = value;
}

/** Telegram's built-in full-screen message effects. */
export const EFFECTS = { party: '5046509860389126442', fire: '5104841245755180586' } as const;

function effectParams(ctx: Context, effect?: string): { message_effect_id?: string } {
  return flairEnabled && effect && ctx.chat?.type === 'private' ? { message_effect_id: effect } : {};
}

/** Reacts to the user's own message ("seen it", "done"); silently skipped when unsupported. */
export async function react(ctx: Context, emoji: '👀' | '🔥' | '🤔' | '🎉'): Promise<void> {
  const message = ctx.message;
  if (!flairEnabled || !message || ctx.chat?.type !== 'private') return;
  try {
    await ctx.api.setMessageReaction(ctx.chat.id, message.message_id, [{ type: 'emoji', emoji }] as never);
  } catch (error) {
    logError('react', error);
  }
}

/** Telegram-HTML to plain text: drop tags, decode the four entities we emit. */
export function stripHtml(text: string): string {
  return text
    .replace(/<[^>]*>/g, '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&');
}

export async function sendStatus(ctx: Context, text: string, replyTo?: number): Promise<number | undefined> {
  try {
    return (await ctx.reply(text, { ...HTML, ...replyParams(replyTo) })).message_id;
  } catch {
    return undefined;
  }
}

// ---------------------------------------------------------------------------
// Rich messages (Bot API 10.1+): article-style layout, with classic HTML as the safety net
// ---------------------------------------------------------------------------

let richEnabled = true;
/** After a "method not found" answer the Bot API server is assumed too old; retry rich after an hour. */
let richRetryAt = 0;

export function setRichEnabled(value: boolean): void {
  richEnabled = value;
}

/** Forgets a previous "method not found" so rich messages are tried again (also used by tests). */
export function resetRichBackoff(): void {
  richRetryAt = 0;
}

export function richAvailable(): boolean {
  return richEnabled && Date.now() >= richRetryAt;
}

type RawApi = Record<string, (payload: unknown) => Promise<{ message_id: number }>>;

async function sendRichPart(
  ctx: Context,
  part: RichPart,
  options: { statusId?: number; replyTo?: number; keyboard?: InlineKeyboard; effect?: string },
): Promise<number | null> {
  const chatId = chatIdOf(ctx);
  if (!chatId || !richAvailable()) return null;
  const raw = ctx.api.raw as unknown as RawApi;
  const rich_message = { html: part.html, ...(part.rtl ? { is_rtl: true } : {}) };
  const markup = options.keyboard ? { reply_markup: options.keyboard } : {};
  const markUnsupported = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    if (/\(404:|unknown method|method not found/i.test(message)) richRetryAt = Date.now() + 60 * 60_000;
  };

  if (options.statusId) {
    try {
      await raw.editMessageText?.({ chat_id: chatId, message_id: options.statusId, rich_message, ...markup });
      return options.statusId;
    } catch (error) {
      if (error instanceof Error && /message is not modified/i.test(error.message)) return options.statusId;
      logError('rich.edit', error);
      markUnsupported(error);
      // A plain "searching…" message may not be convertible: send a new one and drop the placeholder.
    }
  }
  try {
    let sent: { message_id: number } | undefined;
    try {
      sent = await raw.sendRichMessage?.({
        chat_id: chatId,
        rich_message,
        ...markup,
        ...replyParams(options.replyTo),
        ...effectParams(ctx, options.effect),
      });
    } catch (error) {
      if (!options.effect) throw error;
      sent = await raw.sendRichMessage?.({ chat_id: chatId, rich_message, ...markup, ...replyParams(options.replyTo) });
    }
    if (!sent) return null;
    if (options.statusId) await ctx.api.deleteMessage(chatId, options.statusId).catch(() => undefined);
    return sent.message_id;
  } catch (error) {
    logError('rich.send', error);
    markUnsupported(error);
    return null;
  }
}

/**
 * Sends a result as a rich message when Telegram accepts it, otherwise as the classic
 * HTML messages. The first part replaces `statusId`; the keyboard sits on the last part.
 * Returns the id of the last message sent.
 */
export async function deliver(
  ctx: Context,
  options: {
    statusId?: number;
    replyTo?: number;
    keyboard?: InlineKeyboard;
    /** A full-screen message effect (private chats only). */
    effect?: string;
    classic: string[];
    rich?: RichPart[];
  },
): Promise<number | undefined> {
  const rich = options.rich ?? [];
  if (rich.length > 0 && richAvailable()) {
    const first = rich[0] as RichPart;
    const firstId = await sendRichPart(ctx, first, {
      ...(options.statusId ? { statusId: options.statusId } : {}),
      ...(options.replyTo ? { replyTo: options.replyTo } : {}),
      ...(rich.length === 1 && options.keyboard ? { keyboard: options.keyboard } : {}),
      ...(options.effect ? { effect: options.effect } : {}),
    });
    if (firstId !== null) {
      let last = firstId;
      for (const [offset, part] of rich.slice(1).entries()) {
        const isLast = offset === rich.length - 2;
        const id = await sendRichPart(ctx, part, {
          ...(options.replyTo ? { replyTo: options.replyTo } : {}),
          ...(isLast && options.keyboard ? { keyboard: options.keyboard } : {}),
        });
        if (id === null) break;
        last = id;
      }
      return last;
    }
  }

  let last: number | undefined;
  for (const [index, chunk] of options.classic.entries()) {
    const isLast = index === options.classic.length - 1;
    last = await settle(ctx, index === 0 ? options.statusId : undefined, chunk, {
      ...(isLast && options.keyboard ? { reply_markup: options.keyboard } : {}),
      ...(options.replyTo ? { replyTo: options.replyTo } : {}),
      ...(index === 0 && options.effect ? { effect: options.effect } : {}),
    });
  }
  return last;
}

/** Live check for the diagnostics screen: does this Bot API server accept rich messages? */
export async function probeRich(ctx: Context): Promise<{ ok: boolean; detail: string }> {
  const chatId = chatIdOf(ctx);
  if (!chatId) return { ok: false, detail: 'no chat' };
  try {
    const raw = ctx.api.raw as unknown as RawApi;
    const sent = await raw.sendRichMessage?.({
      chat_id: chatId,
      rich_message: { html: '<h3>✨ Rich messages work</h3><p>This is a test of the article-style layout.</p><hr/><footer>Lyricson diagnostics</footer>' },
    });
    if (sent) richRetryAt = 0;
    return { ok: Boolean(sent), detail: sent ? 'sendRichMessage accepted' : 'method missing' };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message.slice(0, 160) : String(error) };
  }
}

/** Resolves to null instead of waiting longer than `ms`. */
export function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return Promise.race([promise, new Promise<null>((resolve) => setTimeout(() => resolve(null), ms))]);
}

/** Short public id for the track's shared pages. */
export async function shareIdFor(track: TrackSummary): Promise<string> {
  return (await sha256Hex(`${trackKey(track)}|${track.id ?? ''}`)).slice(0, 10);
}

export function musicInfoFor(
  env: Env,
  settings: SettingsSnapshot,
  track: TrackSummary,
): Promise<MusicInfo | null> {
  if (track.source === 'user') return Promise.resolve(null);
  return findMusicInfo(env.DB, track, settings.spotify).catch((error) => {
    logError('musicInfo', error);
    return null;
  });
}

// ---------------------------------------------------------------------------
// 30-second preview with correct tags and cover
// ---------------------------------------------------------------------------

export async function sendPreviewAudio(ctx: Context, env: Env, info: MusicInfo): Promise<boolean> {
  const chatId = chatIdOf(ctx);
  if (!chatId || !info.preview) return false;
  const caption = '▶️ <i>پیش‌نمایش 30 ثانیه‌ای</i>';
  const cacheKey = `a:${info.deezerId}`;
  try {
    const cached = await cacheGet<{ fileId: string }>(env.DB, 'lyric_cache', cacheKey, 0);
    if (cached?.fileId) {
      await ctx.api.sendAudio(chatId, cached.fileId, { caption, parse_mode: 'HTML' });
      return true;
    }

    let mp3 = await fetchBytes(info.preview);
    if (!mp3) {
      const fresh = await freshPreviewUrl(info.deezerId);
      if (fresh) mp3 = await fetchBytes(fresh);
    }
    if (!mp3) return false;
    const thumb = info.coverMedium ? await fetchBytes(info.coverMedium, 400_000) : null;
    const tagged = withId3Tags(mp3, {
      title: info.title,
      artist: info.artist,
      ...(info.album ? { album: info.album } : {}),
      ...(thumb ? { cover: thumb } : {}),
    });
    const sent = await ctx.api.sendAudio(chatId, new InputFile(tagged, `${info.artist} - ${info.title}.mp3`), {
      title: info.title,
      performer: info.artist,
      duration: 30,
      caption,
      parse_mode: 'HTML',
      ...(thumb ? { thumbnail: new InputFile(thumb, 'cover.jpg') } : {}),
    });
    if (sent.audio?.file_id) await cachePut(env.DB, 'lyric_cache', cacheKey, { fileId: sent.audio.file_id });
    return true;
  } catch (error) {
    logError('preview', error, { deezerId: info.deezerId });
    return false;
  }
}

// ---------------------------------------------------------------------------
// Music card
// ---------------------------------------------------------------------------

export function metaOf(track: TrackSummary, info: MusicInfo | null): TrackMeta {
  const identity = identityOf(track, info);
  return {
    title: identity.title,
    artist: identity.artist,
    ...(identity.album ? { album: identity.album } : {}),
    ...(identity.date ? { date: identity.date } : {}),
    ...(identity.link ? { link: identity.link } : {}),
  };
}

export async function onCard(ctx: Context, env: Env, cfg: Config, track: TrackSummary): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const chatId = chatIdOf(ctx);
  if (!chatId) return;
  const replyTo = ctx.callbackQuery?.message?.message_id;
  const settings = await loadSettings(env, cfg);
  const info = await withTimeout(musicInfoFor(env, settings, track), 5000);
  const id = await shareIdFor(track);
  await saveShare(env.DB, id, track).catch((error) => logError('share', error));

  // Links open the result inside the bot (deep link), never an external site.
  const bot = ctx.me.username;
  const deep = (kind: 'l' | 't') => `https://t.me/${bot}?start=${kind}_${id}`;
  const listen = [
    ...(info?.spotifyUrl ? [{ label: 'Spotify', url: info.spotifyUrl }] : []),
    ...(info?.deezerUrl ? [{ label: 'Deezer', url: info.deezerUrl }] : []),
  ];
  const caption = cardCaption(track, metaOf(track, info), {
    lyrics: deep('l'),
    translation: deep('t'),
    listen,
  });
  if (info?.cover) {
    try {
      await ctx.api.sendPhoto(chatId, info.cover, { caption, parse_mode: 'HTML', ...replyParams(replyTo) });
      return;
    } catch (error) {
      logError('card.photo', error);
    }
  }
  await ctx.reply(caption, { ...HTML, ...replyParams(replyTo) });
}

// ---------------------------------------------------------------------------
// AI panels: story, vocabulary, artist
// ---------------------------------------------------------------------------

type InsightKind = 'story' | 'words' | 'artist';

const WORKING: Record<InsightKind, string> = {
  story: M.STORY_WORKING,
  words: M.WORDS_WORKING,
  artist: M.ARTIST_WORKING,
};

const KIND_ACTION = { story: 'b', words: 'w', artist: 'r' } as const;

interface InsightContext {
  ctx: Context;
  env: Env;
  cfg: Config;
  kind: InsightKind;
  sessionId: string;
  replyTo: number | undefined;
  statusId: number | undefined;
}

/** Shows an error on the status message with a retry button. */
async function failWithRetry(c: InsightContext, text: string): Promise<void> {
  await settle(c.ctx, c.statusId, text, {
    reply_markup: retryKeyboard(KIND_ACTION[c.kind], c.sessionId),
    ...(c.replyTo ? { replyTo: c.replyTo } : {}),
  });
}

/** Cache → quota → AI → cache; the same answer is never paid for twice. */
async function cachedInsight<T>(
  c: InsightContext,
  key: string,
  build: (ai: SettingsSnapshot['ai']) => Promise<T>,
  /** Used (but never cached) when the AI fails, so the user still gets an answer. */
  fallback?: () => T,
  /** Cached values failing this check (e.g. an old English biography) are regenerated. */
  isValid?: (value: T) => boolean,
): Promise<T | null> {
  const settings = await loadSettings(c.env, c.cfg);
  const cacheKey = `x:${c.kind}:${await sha256Hex(key)}`;
  const cached = await cacheGet<T>(c.env.DB, 'translation_cache', cacheKey, 0);
  if (cached && (!isValid || isValid(cached))) return cached;

  if (!settings.ai.apiKey) {
    await settle(c.ctx, c.statusId, M.AI_NOT_CONFIGURED, { ...(c.replyTo ? { replyTo: c.replyTo } : {}) });
    return null;
  }
  const quota = await consumeQuota(c.env.DB, c.ctx.from?.id ?? 0, settings.dailyLimit);
  if (!quota.allowed) {
    await settle(c.ctx, c.statusId, M.quotaReached(settings.dailyLimit), { ...(c.replyTo ? { replyTo: c.replyTo } : {}) });
    return null;
  }
  try {
    const value = await build(settings.ai);
    await cachePut(c.env.DB, 'translation_cache', cacheKey, value);
    return value;
  } catch (error) {
    logError(`insight.${c.kind}`, error);
    await refundQuota(c.env.DB, c.ctx.from?.id ?? 0);
    if (fallback) return fallback();
    await failWithRetry(c, isUserFacing(error) ? error.userText : describeAiError(error));
    return null;
  }
}

async function sendDoc(
  c: InsightContext,
  doc: Doc,
  options: { reuseStatus: boolean; plainBlocks?: boolean; rich?: RichPart[] },
): Promise<void> {
  await deliver(c.ctx, {
    ...(options.reuseStatus && c.statusId ? { statusId: c.statusId } : {}),
    ...(c.replyTo ? { replyTo: c.replyTo } : {}),
    classic: paginate(doc, options.plainBlocks ? { plainBlocks: true } : {}),
    ...(options.rich ? { rich: options.rich } : {}),
  });
}

export async function onInsight(
  ctx: Context,
  env: Env,
  cfg: Config,
  kind: InsightKind,
  session: Session,
  track: TrackSummary,
): Promise<void> {
  await ctx.answerCallbackQuery({ text: kind === 'words' ? 'Working…' : 'Researching…' }).catch(() => undefined);
  const chatId = chatIdOf(ctx);
  if (!chatId) return;
  // Both the temporary and the final answer reply to the message that holds the buttons.
  const replyTo = ctx.callbackQuery?.message?.message_id;
  const statusId = await sendStatus(ctx, WORKING[kind], replyTo);
  const c: InsightContext = { ctx, env, cfg, kind, sessionId: session.id, replyTo, statusId };

  if (kind === 'story') {
    const story = await cachedInsight<Story>(c, trackKey(track), (ai) => buildStory(ai, track, track.lyrics ?? ''));
    if (story) {
      await sendDoc(c, storyDoc(track, story), { reuseStatus: true, rich: storyRich(track, story, M.confidenceLabel(story.confidence)) });
    }
    return;
  }

  if (kind === 'words') {
    const words = await cachedInsight<VocabWord[]>(c, trackKey(track), (ai) =>
      buildVocabulary(ai, track, track.lyrics ?? ''),
    );
    if (words) await sendDoc(c, wordsDoc(track, words), { reuseStatus: true, rich: wordsRich(track, words) });
    return;
  }

  // artist
  const settings = await loadSettings(env, cfg);
  const info = await withTimeout(musicInfoFor(env, settings, track), 5000);
  const name = info?.artist ?? track.artistName;
  const artist: ArtistInfo = await findArtistInfo(env.DB, name, info?.artistId).catch((error) => {
    logError('artistInfo', error);
    return { name, photos: [], albums: [] };
  });
  const bio = await cachedInsight<ArtistBio>(
    c,
    normalize(name),
    (ai) => buildArtistBio(ai, artist),
    () => fallbackArtistBio(artist),
    (value) => looksPersian(value.bio),
  );
  if (!bio) return;

  // One piece of content: a short biography rides in the photo caption, a long one is a single article.
  const fits = bioFitsCaption(artist.name, bio, artist.fans);
  const caption = artistCaption(artist.name, fits ? bio.bio : '', artist.fans);
  const photos = [...new Set([...artist.photos, ...artist.albums])].slice(0, 4);
  let sentWithPhotos = false;
  try {
    if (photos.length >= 2) {
      await ctx.api.sendMediaGroup(
        chatId,
        photos.map((url, index) => ({
          type: 'photo' as const,
          media: url,
          ...(index === 0 ? { caption, parse_mode: 'HTML' as const } : {}),
        })),
        replyParams(replyTo),
      );
      sentWithPhotos = true;
    }
  } catch (error) {
    logError('artist.group', error);
  }
  // A single photo (or a group Telegram refused): try the portrait alone before giving up on photos.
  if (!sentWithPhotos && photos[0]) {
    try {
      await ctx.api.sendPhoto(chatId, photos[0], { caption, parse_mode: 'HTML', ...replyParams(replyTo) });
      sentWithPhotos = true;
    } catch (error) {
      logError('artist.photo', error);
    }
  }
  if (sentWithPhotos && statusId) await ctx.api.deleteMessage(chatId, statusId).catch(() => undefined);

  // The article carries the full biography when it did not fit the caption (or there is no photo at all).
  if (!(sentWithPhotos && fits)) {
    const doc = artistBioDoc(artist.name, { ...bio, bio: bio.bio }, true);
    if (doc) {
      await sendDoc(c, doc, {
        reuseStatus: !sentWithPhotos,
        plainBlocks: true,
        rich: artistRich(artist.name, bio, artist.fans),
      });
    }
  }
}

/** Session payload helper. */
export function trackOfSession(session: Session): TrackSummary | null {
  const payload = session.payload as { track?: TrackSummary };
  return session.mode === 'track' && payload.track ? payload.track : null;
}
