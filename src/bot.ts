/**
 * The Telegram bot itself: it accepts a name, a link, an audio file, a video
 * with a caption or pasted lyrics, shows the closest matches, then sends the
 * original text with an inline button that produces a line-by-line translation.
 */
import { Bot, InlineKeyboard, type Context } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { handleAdminCallback, handleAdminCommand, handleAdminText } from './admin.js';
import {
  metaOf,
  musicInfoFor,
  onCard,
  onInsight,
  sendPreviewAudio,
  sendStatus,
  settle,
  shareIdFor,
  trackOfSession,
  withTimeout,
} from './extras.js';
import type { Config, Env } from './env.js';
import { describeAiError, translateTrack } from './lib/ai.js';
import { isAdmin } from './lib/admin-panel.js';
import { addAdminId, loadSettings } from './lib/settings.js';
import { setAdminCommands } from './lib/telegram.js';
import { isUserFacing, logError } from './lib/errors.js';
import {
  candidateKeyboard,
  lyricsKeyboard,
  parseCallbackData,
  lyricsDoc,
  paginate,
  renderCandidatesMessage,
  retryKeyboard,
  translationDoc,
} from './lib/format.js';
import { buildFileInput, detectUrl, fetchId3Tags, resolveLink, type AudioMetadata } from './lib/identify.js';
import { languageFor, TARGET_LANGUAGES } from './lib/languages.js';
import { resolveCanonical } from './lib/music.js';
import { getTrackById, getTrackByMetadata, searchTracks } from './lib/lyrics.js';
import * as M from './lib/messages.js';
import { toSourceLines, type Translation } from './lib/prompt.js';
import {
  applyCachePolicy,
  cacheGet,
  cachePolicy,
  cachePut,
  consumeQuota,
  createSession,
  ensureSchema,
  getSession,
  getShare,
  getTargetLang,
  quotaUsed,
  refundQuota,
  saveShare,
  setSessionMessageId,
  setTargetLang,
  touchUser,
} from './lib/store.js';
import { buildSearchHints, decideMatch, faDigits, looksLikeLyrics, sha256Hex, sortRanked } from './lib/text.js';
import { isSearchPayload, type Session, type TrackSummary } from './lib/types.js';

const PAGE_SIZE = 5;
const SEARCH_RESULT_LIMIT = 12;

const HTML = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } } as const;

type BotContext = Context;

interface RequestInput {
  /** A "searching…" message already on screen; the answer replaces it in place. */
  statusId?: number;
  query?: string;
  title?: string;
  artist?: string;
  /** Lyrics the user pasted instead of a song to look up. */
  lyrics?: string;
}

interface TrackOptions {
  statusId?: number;
  candidates?: TrackSummary[];
  searchSessionId?: string;
  notice?: string;
}

export function createBot(env: Env, cfg: Config, botInfo?: UserFromGetMe): Bot {
  const bot = new Bot(env.TELEGRAM_BOT_TOKEN, {
    ...(botInfo ? { botInfo } : {}),
    ...(cfg.apiRoot ? { client: { apiRoot: cfg.apiRoot } } : {}),
  });

  bot.catch((failure) => {
    logError('bot', failure.error, { updateId: failure.ctx.update.update_id });
  });

  // Refresh the live settings (admins, cache policy, maintenance) once per update.
  bot.use(async (ctx, next) => {
    const settings = await loadSettings(env, cfg);
    if (ctx.from && ctx.chat?.type === 'private') await touchUser(env.DB, ctx.from);
    cfg.adminUserIds = settings.adminIds;
    applyCachePolicy({
      enabled: settings.cache.enabled,
      translationTtl: settings.cache.translationDays * 86_400,
      lyricsTtl: settings.cache.lyricsDays * 86_400,
    });
    const isClaim = /^\/claim(@\w+)?(\s|$)/.test(ctx.message?.text ?? '');
    if (settings.maintenance && !isAdmin(cfg, ctx.from?.id) && !isClaim) {
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: M.MAINTENANCE, show_alert: true }).catch(() => undefined);
      } else if (ctx.message) {
        await ctx.reply(M.MAINTENANCE);
      }
      return;
    }
    await next();
  });

  // -- commands ------------------------------------------------------------
  bot.command('id', async (ctx) => {
    await ctx.reply(M.yourId(userIdOf(ctx)), HTML);
  });

  // Anyone who knows the bot token (i.e. the owner) can become an admin.
  bot.command('claim', async (ctx) => {
    const userId = ctx.from?.id;
    if (!userId) return;
    if (ctx.chat?.type !== 'private') {
      await ctx.reply(M.CLAIM_PRIVATE_ONLY);
      return;
    }
    const given = String(ctx.match ?? '').trim();
    // The message carries the token; remove it whatever the outcome.
    await ctx.deleteMessage().catch(() => undefined);
    if (!given) {
      await ctx.reply(M.CLAIM_USAGE, HTML);
      return;
    }
    if ((await sha256Hex(given)) !== (await sha256Hex(env.TELEGRAM_BOT_TOKEN.trim()))) {
      await ctx.reply(M.CLAIM_INVALID);
      return;
    }
    await addAdminId(env, userId);
    await setAdminCommands(cfg, userId);
    cfg.adminUserIds = [...new Set([...cfg.adminUserIds, userId])];
    await ctx.reply(M.claimDone(userId), {
      ...HTML,
      reply_markup: new InlineKeyboard().text('🛠 پنل مدیریت', 'a:home'),
    });
  });

  bot.command('start', async (ctx) => {
    // Deep links from the music card: /start l_<id> (lyrics) or t_<id> (lyrics + translation).
    const shared = /^([lt])_([a-z0-9]{6,16})$/.exec(String(ctx.match ?? '').trim());
    if (shared) {
      await openShared(ctx, env, cfg, shared[1] === 't', shared[2] ?? '');
      return;
    }
    if (isAdmin(cfg, ctx.from?.id)) {
      await ctx.reply(M.WELCOME, {
        ...HTML,
        reply_markup: new InlineKeyboard().text('🛠 پنل مدیریت', 'a:home'),
      });
      return;
    }
    await ctx.reply(M.WELCOME, HTML);
  });

  bot.command('help', async (ctx) => {
    const settings = await loadSettings(env, cfg);
    const used = await quotaUsed(env.DB, userIdOf(ctx));
    const quota = `\n\n🔋 سهمیهٔ امروز: ${faDigits(used)} از ${faDigits(settings.dailyLimit)}`;
    const admin = isAdmin(cfg, ctx.from?.id) ? M.ADMIN_HELP_SECTION : '';
    await ctx.reply(M.HELP + quota + admin, HTML);
  });

  bot.command('lang', async (ctx) => {
    await sendLanguageMenu(ctx, env, cfg, false);
  });

  bot.command('admin', async (ctx) => {
    await handleAdminCommand(ctx, env, cfg);
  });

  bot.on('message:text', async (ctx) => {
    const text = ctx.message.text.trim();
    if (text.startsWith('/')) {
      await ctx.reply('این دستور رو نمی‌شناسم 🤔\nدستورها: /start · /help · /lang', HTML);
      return;
    }
    // A pending admin prompt takes the next plain message as its value.
    if (await handleAdminText(ctx, env, cfg, text)) return;
    await routeText(ctx, env, cfg, text);
  });

  bot.on('message:audio', (ctx) => handleMedia(ctx, env, cfg));
  bot.on('message:video', (ctx) => handleMedia(ctx, env, cfg));
  bot.on('message:voice', (ctx) => ctx.reply(M.unknownFile(), HTML));
  bot.on('message:document', async (ctx) => {
    const document = ctx.message.document;
    const looksAudio =
      (document?.mime_type ?? '').startsWith('audio/') ||
      /\.(mp3|m4a|aac|flac|ogg|opus|wav|wma|mp4)$/i.test(document?.file_name ?? '');
    if (looksAudio) {
      await handleMedia(ctx, env, cfg);
      return;
    }
    await ctx.reply(M.unknownFile(), HTML);
  });

  // -- inline buttons ------------------------------------------------------
  bot.on('callback_query:data', async (ctx) => {
    const data = ctx.callbackQuery.data;
    if (data.startsWith('a:')) {
      await handleAdminCallback(ctx, env, cfg, data);
      return;
    }
    const languageMatch = /^l:([a-z]{2})$/.exec(data);
    if (languageMatch) {
      const code = languageMatch[1] ?? '';
      const language = languageFor(code);
      if (!language.enabled) {
        await ctx.answerCallbackQuery({ text: 'این زبان هنوز فعال نیست.' });
        return;
      }
      await setTargetLang(env.DB, userIdOf(ctx), language.code);
      await ctx.answerCallbackQuery({ text: `زبان مقصد: ${language.nativeName} ✅` });
      await sendLanguageMenu(ctx, env, cfg, true);
      return;
    }

    const parsed = parseCallbackData(data);
    if (!parsed) {
      await ctx.answerCallbackQuery({ text: 'این دکمه دیگه معتبر نیست.' });
      return;
    }

    await ensureSchema(env.DB);
    const session = await getSession(env.DB, parsed.sessionId);
    if (!session || session.userId !== userIdOf(ctx)) {
      await ctx.answerCallbackQuery({ text: 'این دکمه منقضی شده؛ دوباره جست‌وجو کن.' });
      return;
    }

    if (parsed.action === 's') {
      await onSelectCandidate(ctx, env, cfg, session, parsed.index);
      return;
    }
    if (parsed.action === 'p') {
      await onShowPage(ctx, env, cfg, session, parsed.index);
      return;
    }
    if (parsed.action === 't') {
      await onTranslate(ctx, env, cfg, session);
      return;
    }
    if (parsed.action === 'y') {
      // Retry of a search that failed because the lyric sources were unreachable.
      await ctx.answerCallbackQuery({ text: 'Retrying…' }).catch(() => undefined);
      const statusId = ctx.callbackQuery.message?.message_id;
      await settle(ctx, statusId, M.SEARCHING);
      await handleRequest(ctx, env, cfg, { query: session.query, ...(statusId ? { statusId } : {}) });
      return;
    }
    const track = trackOfSession(session);
    if (!track) {
      await ctx.answerCallbackQuery({ text: 'این دکمه منقضی شده؛ دوباره جست‌وجو کن.' });
      return;
    }
    if (parsed.action === 'c') await onCard(ctx, env, cfg, track);
    else if (parsed.action === 'b') await onInsight(ctx, env, cfg, 'story', session, track);
    else if (parsed.action === 'w') await onInsight(ctx, env, cfg, 'words', session, track);
    else await onInsight(ctx, env, cfg, 'artist', session, track);
  });

  return bot;
}

// ---------------------------------------------------------------------------
// Input routing
// ---------------------------------------------------------------------------

export function telegramApiBase(cfg: Config): string {
  return cfg.apiRoot ?? 'https://api.telegram.org';
}

async function routeText(ctx: BotContext, env: Env, cfg: Config, text: string): Promise<void> {
  const url = detectUrl(text);
  if (url) {
    if (!cfg.botToken) {
      await ctx.reply(M.searchedFailed(), HTML);
      return;
    }
    const statusId = await sendStatus(ctx, M.SEARCHING_FOR_LINK);
    const info = await resolveLink(url);
    const leftover = text.replace(url, ' ').replace(/\s{2,}/g, ' ').trim();
    const query = [info.artist, info.title].filter(Boolean).join(' ') || leftover;
    if (!query) {
      await settle(ctx, statusId, M.notFound(url));
      return;
    }
    await handleRequest(ctx, env, cfg, {
      ...(statusId ? { statusId } : {}),
      query,
      ...(info.title ? { title: info.title } : {}),
      ...(info.artist ? { artist: info.artist } : {}),
    });
    return;
  }

  if (looksLikeLyrics(text)) {
    await handleRequest(ctx, env, cfg, { lyrics: text });
    return;
  }

  await handleRequest(ctx, env, cfg, { query: text });
}

async function handleMedia(ctx: BotContext, env: Env, cfg: Config): Promise<void> {
  const message = ctx.message;
  if (!message) return;
  const caption = message.caption?.trim();
  const meta = mediaMetadata(message);

  let id3 = {};
  const needsId3 = !caption && !meta.title && !meta.artist && Boolean(meta.fileId);
  if (needsId3 && (meta.fileSize ?? 0) <= 20 * 1024 * 1024) {
    const fileUrl = await telegramFileUrl(cfg, meta.fileId ?? '');
    if (fileUrl) {
      await ctx.replyWithChatAction('typing').catch(() => undefined);
      id3 = await fetchId3Tags(fileUrl);
    }
  }

  const input = buildFileInput({ ...(caption ? { caption } : {}), meta, id3 });
  if (!input.query && !input.title && !input.artist) {
    await ctx.reply(M.unknownFile(), HTML);
    return;
  }
  await handleRequest(ctx, env, cfg, input);
}

interface MediaMetadata extends AudioMetadata {
  fileId?: string;
  fileSize?: number;
}

function mediaMetadata(message: NonNullable<BotContext['message']>): MediaMetadata {
  const audio = message.audio;
  if (audio) {
    return {
      ...(audio.title ? { title: audio.title } : {}),
      ...(audio.performer ? { artist: audio.performer } : {}),
      ...(audio.file_name ? { fileName: audio.file_name } : {}),
      ...(audio.duration ? { duration: audio.duration } : {}),
      fileId: audio.file_id,
      ...(audio.file_size ? { fileSize: audio.file_size } : {}),
    };
  }
  const video = message.video;
  if (video) {
    return {
      ...(video.file_name ? { fileName: video.file_name } : {}),
      ...(video.duration ? { duration: video.duration } : {}),
      fileId: video.file_id,
      ...(video.file_size ? { fileSize: video.file_size } : {}),
    };
  }
  const document = message.document;
  if (document) {
    return {
      ...(document.file_name ? { fileName: document.file_name } : {}),
      fileId: document.file_id,
      ...(document.file_size ? { fileSize: document.file_size } : {}),
    };
  }
  return {};
}

async function telegramFileUrl(cfg: Config, fileId: string): Promise<string | null> {
  if (!fileId || !cfg.botToken) return null;
  try {
    const response = await fetch(
      `${telegramApiBase(cfg)}/bot${cfg.botToken}/getFile?file_id=${encodeURIComponent(fileId)}`,
      { signal: AbortSignal.timeout(8000) },
    );
    const payload = (await response.json()) as { ok?: boolean; result?: { file_path?: string } };
    if (!payload.ok || !payload.result?.file_path) return null;
    return `${telegramApiBase(cfg)}/file/bot${cfg.botToken}/${payload.result.file_path}`;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Search -> lyrics -> translation
// ---------------------------------------------------------------------------

async function handleRequest(ctx: BotContext, env: Env, cfg: Config, input: RequestInput): Promise<void> {
  await ensureSchema(env.DB);

  if (input.lyrics) {
    const track: TrackSummary = {
      trackName: 'متن ارسالی',
      artistName: ctx.from?.first_name ?? 'کاربر',
      lyrics: input.lyrics,
      source: 'user',
    };
    await sendTrack(ctx, env, cfg, track, { notice: M.pastedLyricsNotice() });
    return;
  }

  let hints = buildSearchHints({ ...(input.query ? { query: input.query } : {}), ...(input.title ? { title: input.title } : {}), ...(input.artist ? { artist: input.artist } : {}) });
  const displayQuery = input.query ?? [input.artist, input.title].filter(Boolean).join(' ');
  if (hints.length === 0) {
    await settle(ctx, input.statusId, M.notFound(displayQuery || '—'));
    return;
  }

  // Answer instantly; the real result edits this message when it is ready.
  const statusId = input.statusId ?? (await sendStatus(ctx, M.SEARCHING));

  // A free-text query ("Truce twenty one pilots") is first resolved to a clean
  // artist + title through Deezer; the exact lookups below then hit far more often.
  if (!input.title && !input.artist && displayQuery) {
    const canonical = await withTimeout(resolveCanonical(env.DB, displayQuery), 2500).catch(() => null);
    if (canonical) {
      hints = buildSearchHints({ title: canonical.title, artist: canonical.artist, query: displayQuery });
    }
  }

  // Exact lookup first: when we already know artist and title it is a single
  // fast request and usually the right answer.
  const best = hints[0];
  if (best?.track && best.artist) {
    const exact = await getTrackByMetadata(env.DB, { track: best.track, artist: best.artist });
    if (exact?.lyrics && decideMatch(hints, [exact]).confident) {
      await sendTrack(ctx, env, cfg, exact, { candidates: [exact], ...(statusId ? { statusId } : {}) });
      return;
    }
  }

  const { tracks: found, degraded } = await searchTracks(env.DB, hints, SEARCH_RESULT_LIMIT);
  const ranked = sortRanked(hints, found).filter((track) => Boolean(track.lyrics));
  if (ranked.length === 0) {
    // "Busy" only when the sources were really unreachable; a genuine miss gets the normal tips.
    if (degraded) {
      const chatId = chatIdOf(ctx);
      const retrySession =
        chatId && displayQuery
          ? await createSession(env.DB, {
              chatId,
              userId: userIdOf(ctx),
              mode: 'search',
              query: displayQuery,
              payload: { candidates: [] },
            }).catch(() => undefined)
          : undefined;
      await settle(ctx, statusId, M.LYRICS_BUSY, retrySession ? { reply_markup: retryKeyboard('y', retrySession) } : {});
      return;
    }
    const anyTrack = found[0];
    await settle(ctx, statusId, anyTrack ? M.noLyricsFound(anyTrack) : M.notFound(displayQuery || '—'));
    return;
  }

  const decision = decideMatch(hints, ranked);
  const top = ranked[0];
  if (decision.confident && top) {
    await sendTrack(ctx, env, cfg, top, { candidates: ranked, ...(statusId ? { statusId } : {}) });
    return;
  }

  await showCandidates(ctx, env, cfg, {
    candidates: ranked,
    query: displayQuery,
    page: 0,
    ...(statusId ? { statusId } : {}),
  });
}

async function sendTrack(
  ctx: BotContext,
  env: Env,
  cfg: Config,
  track: TrackSummary,
  options: TrackOptions = {},
): Promise<void> {
  const userId = userIdOf(ctx);
  const chatId = chatIdOf(ctx);
  if (!chatId) return;

  const settings = await loadSettings(env, cfg);
  const language = languageFor((await getTargetLang(env.DB, userId)) ?? settings.defaultTargetLang);
  if (options.notice) await ctx.reply(options.notice, HTML).catch(() => undefined);

  // Cover, album and links come from Deezer (+ Spotify if configured); never wait long for them.
  const info = await withTimeout(musicInfoFor(env, settings, track), 3000);
  const audioSent = info?.preview ? await sendPreviewAudio(ctx, env, info) : false;
  const statusForLyrics = audioSent ? undefined : options.statusId;

  const searchSessionId =
    options.searchSessionId ??
    (options.candidates
      ? await createSession(env.DB, {
          chatId,
          userId,
          mode: 'search',
          query: track.trackName,
          payload: { candidates: options.candidates },
        })
      : undefined);

  const sessionId = await createSession(env.DB, {
    chatId,
    userId,
    mode: 'track',
    query: track.trackName,
    payload: { track, ...(searchSessionId ? { searchSid: searchSessionId } : {}) },
  });

  const chunks = paginate(lyricsDoc(track, metaOf(track, info)), { plainBlocks: true });
  let lastMessageId: number | undefined;
  for (const [index, chunk] of chunks.entries()) {
    const isLast = index === chunks.length - 1;
    const extra = isLast
      ? {
          reply_markup: lyricsKeyboard(sessionId, {
            languageName: language.nativeName,
            ...(searchSessionId ? { searchSessionId } : {}),
          }),
        }
      : {};
    // The first chunk replaces the "searching…" message; the rest follow as new messages.
    lastMessageId = await settle(ctx, index === 0 ? statusForLyrics : undefined, chunk, extra);
  }
  if (lastMessageId !== undefined) await setSessionMessageId(env.DB, sessionId, lastMessageId);
  // The audio went out as its own message, so the "searching…" placeholder is no longer needed.
  if (audioSent && options.statusId) await ctx.api.deleteMessage(chatId, options.statusId).catch(() => undefined);
  await saveShare(env.DB, await shareIdFor(track), track).catch((error) => logError('share', error));
}

/** Opens a track from a card deep link: the lyrics, or the stored translation when asked for. */
async function openShared(ctx: BotContext, env: Env, cfg: Config, wantTranslation: boolean, id: string): Promise<void> {
  await ensureSchema(env.DB);
  const share = await getShare(env.DB, id);
  if (!share) {
    await ctx.reply(M.SHARE_MISSING, HTML);
    return;
  }
  if (!wantTranslation || !share.translation) {
    await sendTrack(ctx, env, cfg, share.track, {
      ...(wantTranslation ? { notice: M.NO_TRANSLATION_YET } : {}),
    });
    return;
  }
  const settings = await loadSettings(env, cfg);
  const info = await withTimeout(musicInfoFor(env, settings, share.track), 3000);
  const doc = translationDoc(share.track, share.translation, languageFor(share.language ?? 'fa').nativeName, metaOf(share.track, info));
  for (const chunk of paginate(doc)) await ctx.reply(chunk, HTML);
}

async function showCandidates(
  ctx: BotContext,
  env: Env,
  cfg: Config,
  args: {
    candidates: TrackSummary[];
    query: string;
    page: number;
    sessionId?: string;
    edit?: boolean;
    statusId?: number;
  },
): Promise<string | undefined> {
  const chatId = chatIdOf(ctx);
  const userId = userIdOf(ctx);
  if (!chatId || args.candidates.length === 0) return undefined;

  const sessionId =
    args.sessionId ??
    (await createSession(env.DB, {
      chatId,
      userId,
      mode: 'search',
      query: args.query,
      payload: { candidates: args.candidates },
    }));

  const text = renderCandidatesMessage(args.candidates, args.query, args.page, PAGE_SIZE);
  const options = {
    ...HTML,
    reply_markup: candidateKeyboard(args.candidates, sessionId, args.page, PAGE_SIZE),
  };

  if (args.edit && ctx.callbackQuery?.message) {
    try {
      await ctx.editMessageText(text, options);
    } catch (error) {
      logError('showCandidates.edit', error);
      const sent = await ctx.reply(text, options);
      await setSessionMessageId(env.DB, sessionId, sent.message_id);
    }
  } else {
    const messageId = await settle(ctx, args.statusId, text, { reply_markup: options.reply_markup });
    await setSessionMessageId(env.DB, sessionId, messageId);
  }
  return sessionId;
}

async function onSelectCandidate(
  ctx: BotContext,
  env: Env,
  cfg: Config,
  session: Session,
  index: number,
): Promise<void> {
  const candidates = isSearchPayload(session.payload) ? session.payload.candidates : [];
  const chosen = candidates[index];
  if (!chosen) {
    await ctx.answerCallbackQuery({ text: 'این گزینه دیگه معتبر نیست.' });
    return;
  }
  await ctx.answerCallbackQuery();

  const statusId = chosen.lyrics ? undefined : await sendStatus(ctx, M.SEARCHING);
  const track = chosen.lyrics
    ? chosen
    : chosen.id
      ? await getTrackById(env.DB, chosen.id)
      : null;
  if (!track?.lyrics) {
    await settle(ctx, statusId, M.noLyricsFound(chosen));
    return;
  }
  await sendTrack(ctx, env, cfg, track, { searchSessionId: session.id, ...(statusId ? { statusId } : {}) });
}

async function onShowPage(ctx: BotContext, env: Env, cfg: Config, session: Session, page: number): Promise<void> {
  await ctx.answerCallbackQuery();
  if (!isSearchPayload(session.payload)) {
    await ctx.reply(M.searchedFailed(), HTML);
    return;
  }
  const callbackMessageId = ctx.callbackQuery?.message?.message_id;
  const edit = session.messageId !== undefined && session.messageId === callbackMessageId;
  await showCandidates(ctx, env, cfg, {
    candidates: session.payload.candidates,
    query: session.query,
    page,
    sessionId: session.id,
    edit,
  });
}

async function onTranslate(ctx: BotContext, env: Env, cfg: Config, session: Session): Promise<void> {
  if (session.mode !== 'track' || isSearchPayload(session.payload)) {
    await ctx.answerCallbackQuery({ text: 'این دکمه منقضی شده.' });
    return;
  }
  const track = session.payload.track;
  const chatId = chatIdOf(ctx);
  const userId = userIdOf(ctx);
  const sourceLines = toSourceLines(track.lyrics ?? '');
  const settings = await loadSettings(env, cfg);
  const ai = settings.ai;

  if (!ai.apiKey) {
    await ctx.answerCallbackQuery();
    await ctx.reply(M.AI_NOT_CONFIGURED, HTML);
    return;
  }
  if (!ai.baseUrl) {
    await ctx.answerCallbackQuery();
    await ctx.reply(M.AI_BASE_URL_MISSING, HTML);
    return;
  }
  if (sourceLines.length === 0) {
    await ctx.answerCallbackQuery({ text: 'متنی برای ترجمه نیست.' });
    return;
  }

  const language = languageFor((await getTargetLang(env.DB, userId)) ?? settings.defaultTargetLang);
  const cacheKey = `t:${await sha256Hex(
    [ai.provider, ai.model, language.code, String(track.id ?? track.trackName), track.lyrics ?? ''].join('|'),
  )}`;

  const cached = await cacheGet<Translation>(env.DB, 'translation_cache', cacheKey, cachePolicy.translationTtl);
  if (!cached) {
    const quota = await consumeQuota(env.DB, userId, settings.dailyLimit);
    if (!quota.allowed) {
      await ctx.answerCallbackQuery({ text: 'سهمیهٔ امروز تموم شده' });
      await ctx.reply(M.quotaReached(settings.dailyLimit), HTML);
      return;
    }
  }

  await ctx.answerCallbackQuery({ text: cached ? 'از حافظه می‌فرستم ⚡️' : 'شروع کردم ⏳' });
  if (!chatId) return;

  // Everything below replies to the message that holds the buttons.
  const replyTo = ctx.callbackQuery?.message?.message_id ?? session.messageId;
  const placeholderId = await sendStatus(ctx, M.TRANSLATING, replyTo);
  let spentQuota = !cached;

  try {
    let translation = cached;
    if (!translation) {
      translation = await translateTrack({
        ai,
        language,
        track,
        sourceLines,
      });
      await cachePut(env.DB, 'translation_cache', cacheKey, translation);
    }
    spentQuota = false;

    const info = await withTimeout(musicInfoFor(env, settings, track), 2500);
    await saveShare(env.DB, await shareIdFor(track), track, { value: translation, language: language.code }).catch(
      (error) => logError('share', error),
    );
    const doc = translationDoc(track, translation, language.nativeName, metaOf(track, info));
    if (translation.missing > 0) doc.foot = `${M.partialNotice(translation.missing).trim()}\n${doc.foot}`;
    const chunks = paginate(doc);
    for (const [index, chunk] of chunks.entries()) {
      await settle(ctx, index === 0 ? placeholderId : undefined, chunk, replyTo ? { replyTo } : {});
    }
  } catch (error) {
    logError('translate', error, { userId, track: track.trackName });
    // A failed AI call must not cost the user a translation from today's quota.
    if (spentQuota) await refundQuota(env.DB, userId);
    const text = isUserFacing(error) ? error.userText : describeAiError(error);
    await settle(ctx, placeholderId, text, {
      reply_markup: retryKeyboard('t', session.id),
      ...(replyTo ? { replyTo } : {}),
    }).catch(() => undefined);
  }
}

async function sendLanguageMenu(ctx: BotContext, env: Env, cfg: Config, edit: boolean): Promise<void> {
  const userId = userIdOf(ctx);
  const settings = await loadSettings(env, cfg);
  const current = languageFor((await getTargetLang(env.DB, userId)) ?? settings.defaultTargetLang);
  const enabled = TARGET_LANGUAGES.filter((language) => language.enabled);
  const summary = enabled.map((language) => `• ${language.nativeName}`).join('\n');
  const keyboard = new InlineKeyboard();
  for (const language of enabled) keyboard.text(language.nativeName, `l:${language.code}`).row();
  const text = M.languageInfo(current.nativeName, summary);
  const options = { ...HTML, reply_markup: keyboard };

  if (edit && ctx.callbackQuery?.message) {
    await ctx.editMessageText(text, options).catch(() => undefined);
    return;
  }
  await ctx.reply(text, options);
}

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function userIdOf(ctx: BotContext): number {
  return ctx.from?.id ?? 0;
}

function chatIdOf(ctx: BotContext): number | null {
  return ctx.chat?.id ?? ctx.callbackQuery?.message?.chat.id ?? null;
}
