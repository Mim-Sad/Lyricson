/**
 * The extras around the lyrics: the 30 s audio preview sent first, and the
 * buttons under the lyrics (music card, story, vocabulary, artist).
 */
import { InlineKeyboard, InputFile, type Context } from 'grammy';
import type { Config, Env } from './env.js';
import { describeAiError } from './lib/ai.js';
import { artistBioMessage, artistCaption, cardCaption, renderStory, renderWords } from './lib/cards.js';
import { isUserFacing, logError } from './lib/errors.js';
import { splitMessage } from './lib/format.js';
import {
  buildArtistBio,
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
  primaryLink,
  trackKey,
  withId3Tags,
  type MusicInfo,
} from './lib/music.js';
import { loadSettings, type SettingsSnapshot } from './lib/settings.js';
import { cacheGet, cachePut, consumeQuota, saveShare } from './lib/store.js';
import { normalize, sha256Hex } from './lib/text.js';
import type { Session, TrackSummary } from './lib/types.js';

const HTML = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } } as const;

function chatIdOf(ctx: Context): number | null {
  return ctx.chat?.id ?? ctx.callbackQuery?.message?.chat.id ?? null;
}

/**
 * Answers by editing the "searching…" message when there is one (so the user
 * saw a reply instantly), otherwise sends a fresh message. Returns the id of
 * the message that now holds `text`.
 */
export async function settle(
  ctx: Context,
  statusId: number | undefined,
  text: string,
  extra: { reply_markup?: InlineKeyboard } = {},
): Promise<number> {
  const chatId = chatIdOf(ctx);
  if (statusId && chatId) {
    try {
      await ctx.api.editMessageText(chatId, statusId, text, { ...HTML, ...extra });
      return statusId;
    } catch (error) {
      if (error instanceof Error && /message is not modified/i.test(error.message)) return statusId;
      logError('settle', error);
    }
  }
  const sent = await ctx.reply(text, { ...HTML, ...extra });
  return sent.message_id;
}

export async function sendStatus(ctx: Context, text: string): Promise<number | undefined> {
  try {
    return (await ctx.reply(text, HTML)).message_id;
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
  const caption = '▶️ <i>پیش‌نمایش ۳۰ ثانیه‌ای</i>';
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

export async function onCard(ctx: Context, env: Env, cfg: Config, track: TrackSummary): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => undefined);
  const chatId = chatIdOf(ctx);
  if (!chatId) return;
  const settings = await loadSettings(env, cfg);
  const info = await withTimeout(musicInfoFor(env, settings, track), 5000);
  const id = await shareIdFor(track);
  await saveShare(env.DB, id, track).catch((error) => logError('share', error));

  const keyboard = new InlineKeyboard();
  const base = settings.publicUrl;
  if (base) {
    keyboard.url('📜 متن اصلی', `${base}/l/${id}`).url('🇮🇷 متن + ترجمه', `${base}/t/${id}`).row();
  }
  if (info?.spotifyUrl) keyboard.url('🎧 Spotify', info.spotifyUrl);
  if (info?.deezerUrl) keyboard.url('🎵 Deezer', info.deezerUrl);

  const caption = cardCaption(track, info);
  const markup = keyboard.inline_keyboard.length > 0 ? { reply_markup: keyboard } : {};
  if (info?.cover) {
    try {
      await ctx.api.sendPhoto(chatId, info.cover, { caption, parse_mode: 'HTML', ...markup });
      return;
    } catch (error) {
      logError('card.photo', error);
    }
  }
  await ctx.reply(caption, { ...HTML, ...markup });
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

/** Cache → quota → AI → cache; the same answer is never paid for twice. */
async function cachedInsight<T>(
  ctx: Context,
  env: Env,
  cfg: Config,
  kind: InsightKind,
  key: string,
  statusId: number | undefined,
  build: (ai: SettingsSnapshot['ai']) => Promise<T>,
): Promise<{ value: T; statusId: number | undefined } | null> {
  const settings = await loadSettings(env, cfg);
  const cacheKey = `x:${kind}:${await sha256Hex(key)}`;
  const cached = await cacheGet<T>(env.DB, 'translation_cache', cacheKey, 0);
  if (cached) return { value: cached, statusId };

  if (!settings.ai.apiKey) {
    await settle(ctx, statusId, M.AI_NOT_CONFIGURED);
    return null;
  }
  const quota = await consumeQuota(env.DB, ctx.from?.id ?? 0, settings.dailyLimit);
  if (!quota.allowed) {
    await settle(ctx, statusId, M.quotaReached(settings.dailyLimit));
    return null;
  }
  try {
    const value = await build(settings.ai);
    await cachePut(env.DB, 'translation_cache', cacheKey, value);
    return { value, statusId };
  } catch (error) {
    logError(`insight.${kind}`, error);
    await settle(ctx, statusId, isUserFacing(error) ? error.userText : describeAiError(error));
    return null;
  }
}

async function sendLong(ctx: Context, statusId: number | undefined, text: string): Promise<void> {
  const chunks = splitMessage(text);
  for (const [index, chunk] of chunks.entries()) {
    await settle(ctx, index === 0 ? statusId : undefined, chunk);
  }
}

export async function onInsight(
  ctx: Context,
  env: Env,
  cfg: Config,
  kind: InsightKind,
  track: TrackSummary,
): Promise<void> {
  await ctx.answerCallbackQuery({ text: kind === 'words' ? 'در حال آماده‌سازی ⏳' : 'در حال تحقیق ⏳' }).catch(() => undefined);
  const chatId = chatIdOf(ctx);
  if (!chatId) return;
  const statusId = await sendStatus(ctx, WORKING[kind]);

  if (kind === 'story') {
    const result = await cachedInsight<Story>(ctx, env, cfg, 'story', trackKey(track), statusId, (ai) =>
      buildStory(ai, track, track.lyrics ?? ''),
    );
    if (result) await sendLong(ctx, statusId, renderStory(track, result.value));
    return;
  }

  if (kind === 'words') {
    const result = await cachedInsight<VocabWord[]>(ctx, env, cfg, 'words', trackKey(track), statusId, (ai) =>
      buildVocabulary(ai, track, track.lyrics ?? ''),
    );
    if (result) await sendLong(ctx, statusId, renderWords(track, result.value));
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
  const result = await cachedInsight<ArtistBio>(ctx, env, cfg, 'artist', normalize(name), statusId, (ai) =>
    buildArtistBio(ai, artist),
  );
  if (!result) return;

  const bio = result.value;
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
      );
      sentWithPhotos = true;
    } else if (photos.length === 1 && photos[0]) {
      await ctx.api.sendPhoto(chatId, photos[0], { caption, parse_mode: 'HTML' });
      sentWithPhotos = true;
    }
  } catch (error) {
    logError('artist.photos', error);
  }
  if (statusId) await ctx.api.deleteMessage(chatId, statusId).catch(() => undefined);
  if (!sentWithPhotos) await ctx.reply(caption, HTML);

  const rest = artistBioMessage(artist.name, bio);
  if (rest) await sendLong(ctx, undefined, rest);
}

/** Session payload helper. */
export function trackOfSession(session: Session): TrackSummary | null {
  const payload = session.payload as { track?: TrackSummary };
  return session.mode === 'track' && payload.track ? payload.track : null;
}
