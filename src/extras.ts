/**
 * The extras around the lyrics: the 30 s audio preview sent first, and the
 * buttons under the lyrics (music card, story, vocabulary, artist).
 */
import { InlineKeyboard, InputFile, type Context } from 'grammy';
import type { Config, Env } from './env.js';
import { describeAiError } from './lib/ai.js';
import { artistBioDoc, artistCaption, cardCaption, storyDoc, wordsDoc } from './lib/cards.js';
import { isUserFacing, logError } from './lib/errors.js';
import { paginate, retryKeyboard, type Doc, type TrackMeta } from './lib/format.js';
import {
  buildArtistBio,
  fallbackArtistBio,
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

type Extra = { reply_markup?: InlineKeyboard; replyTo?: number };

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
    const sent = await ctx.reply(text, { ...HTML, ...markup, ...replyParams(extra.replyTo) });
    return sent.message_id;
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
): Promise<T | null> {
  const settings = await loadSettings(c.env, c.cfg);
  const cacheKey = `x:${c.kind}:${await sha256Hex(key)}`;
  const cached = await cacheGet<T>(c.env.DB, 'translation_cache', cacheKey, 0);
  if (cached) return cached;

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
  options: { reuseStatus: boolean; plainBlocks?: boolean },
): Promise<void> {
  const parts = paginate(doc, options.plainBlocks ? { plainBlocks: true } : {});
  for (const [index, part] of parts.entries()) {
    await settle(c.ctx, index === 0 && options.reuseStatus ? c.statusId : undefined, part, {
      ...(c.replyTo ? { replyTo: c.replyTo } : {}),
    });
  }
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
    if (story) await sendDoc(c, storyDoc(track, story), { reuseStatus: true });
    return;
  }

  if (kind === 'words') {
    const words = await cachedInsight<VocabWord[]>(c, trackKey(track), (ai) =>
      buildVocabulary(ai, track, track.lyrics ?? ''),
    );
    if (words) await sendDoc(c, wordsDoc(track, words), { reuseStatus: true });
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
  );
  if (!bio) return;

  const caption = artistCaption(artist.name, bio, artist.fans);
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
  if (sentWithPhotos) {
    if (statusId) await ctx.api.deleteMessage(chatId, statusId).catch(() => undefined);
  } else {
    await settle(ctx, statusId, caption, { ...(replyTo ? { replyTo } : {}) });
  }

  const rest = artistBioDoc(artist.name, bio);
  if (rest) await sendDoc(c, rest, { reuseStatus: false, plainBlocks: true });
}

/** Session payload helper. */
export function trackOfSession(session: Session): TrackSummary | null {
  const payload = session.payload as { track?: TrackSummary };
  return session.mode === 'track' && payload.track ? payload.track : null;
}
