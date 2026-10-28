/**
 * The Telegram bot itself: it accepts a name, a link, an audio file, a video
 * with a caption or pasted lyrics, shows the closest matches, then sends the
 * original text with an inline button that produces a line-by-line translation.
 */
import { Bot, InlineKeyboard, type Context } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { handleAdminCallback, handleAdminCommand, handleAdminText } from './admin.js';
import type { Config, Env } from './env.js';
import { describeAiError, translateTrack } from './lib/ai.js';
import { isAdmin } from './lib/admin-panel.js';
import { addAdminId, loadSettings } from './lib/settings.js';
import { isUserFacing, logError } from './lib/errors.js';
import {
  candidateKeyboard,
  lyricsKeyboard,
  parseCallbackData,
  renderCandidatesMessage,
  renderLyricsMessage,
  renderTranslationMessage,
  splitMessage,
} from './lib/format.js';
import { buildFileInput, detectUrl, fetchId3Tags, resolveLink, type AudioMetadata } from './lib/identify.js';
import { languageFor, TARGET_LANGUAGES } from './lib/languages.js';
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
  getTargetLang,
  quotaUsed,
  setSessionMessageId,
  setTargetLang,
} from './lib/store.js';
import { buildSearchHints, decideMatch, faDigits, looksLikeLyrics, sha256Hex, sortRanked } from './lib/text.js';
import { isSearchPayload, type Session, type TrackSummary } from './lib/types.js';

const PAGE_SIZE = 5;
const SEARCH_RESULT_LIMIT = 12;

const HTML = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } } as const;

type BotContext = Context;

interface RequestInput {
  query?: string;
  title?: string;
  artist?: string;
  /** Lyrics the user pasted instead of a song to look up. */
  lyrics?: string;
}

interface TrackOptions {
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
    cfg.adminUserIds = [...new Set([...cfg.adminUserIds, userId])];
    await ctx.reply(M.claimDone(userId), {
      ...HTML,
      reply_markup: new InlineKeyboard().text('🛠 پنل مدیریت', 'a:home'),
    });
  });

  bot.command('start', async (ctx) => {
    if (isAdmin(cfg, ctx.from?.id)) {
      await ctx.reply(M.WELCOME, {
        ...HTML,
        reply_markup: new InlineKeyboard().text('🛠 پنل مدیریت', 'a:home'),
      });
      return;
    }
    // Until someone is admin, point the owner at /claim.
    const setupHint = cfg.adminUserIds.length === 0 ? `\n\n<i>مالک ربات؟ برای ادمین‌شدن بنویس /claim</i>` : '';
    await ctx.reply(M.WELCOME + setupHint, HTML);
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
      await ctx.reply('این دستور رو نمی‌شناسم 🤔\nدستورها: /start · /help · /lang · /id', HTML);
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
    await onTranslate(ctx, env, cfg, session);
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
    await ctx.reply(M.SEARCHING_FOR_LINK, HTML).catch(() => undefined);
    const info = await resolveLink(url);
    const leftover = text.replace(url, ' ').replace(/\s{2,}/g, ' ').trim();
    const query = [info.artist, info.title].filter(Boolean).join(' ') || leftover;
    if (!query) {
      await ctx.reply(M.notFound(url), HTML);
      return;
    }
    await handleRequest(ctx, env, cfg, {
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

  const hints = buildSearchHints({ ...(input.query ? { query: input.query } : {}), ...(input.title ? { title: input.title } : {}), ...(input.artist ? { artist: input.artist } : {}) });
  const displayQuery = input.query ?? [input.artist, input.title].filter(Boolean).join(' ');
  if (hints.length === 0) {
    await ctx.reply(M.notFound(displayQuery || '—'), HTML);
    return;
  }

  await ctx.replyWithChatAction('typing').catch(() => undefined);

  // Exact lookup first: when we already know artist and title it is a single
  // fast request and usually the right answer.
  const best = hints[0];
  if (best?.track && best.artist) {
    const exact = await getTrackByMetadata(env.DB, { track: best.track, artist: best.artist });
    if (exact?.lyrics && decideMatch(hints, [exact]).confident) {
      await sendTrack(ctx, env, cfg, exact, { candidates: [exact] });
      return;
    }
  }

  const found = await searchTracks(env.DB, hints, SEARCH_RESULT_LIMIT);
  const ranked = sortRanked(hints, found).filter((track) => Boolean(track.lyrics));
  if (ranked.length === 0) {
    const anyTrack = found[0];
    await ctx.reply(anyTrack ? M.noLyricsFound(anyTrack) : M.notFound(displayQuery || '—'), HTML);
    return;
  }

  const decision = decideMatch(hints, ranked);
  const top = ranked[0];
  if (decision.confident && top) {
    await sendTrack(ctx, env, cfg, top, { candidates: ranked });
    return;
  }

  await showCandidates(ctx, env, cfg, { candidates: ranked, query: displayQuery, page: 0 });
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

  const chunks = splitMessage(renderLyricsMessage(track));
  let lastMessageId: number | undefined;
  for (const [index, chunk] of chunks.entries()) {
    const isLast = index === chunks.length - 1;
    const sent = await ctx.reply(chunk, {
      ...HTML,
      ...(isLast
        ? {
            reply_markup: lyricsKeyboard(sessionId, {
              languageName: language.nativeName,
              ...(searchSessionId ? { searchSessionId } : {}),
            }),
          }
        : {}),
    });
    lastMessageId = sent.message_id;
  }
  if (lastMessageId !== undefined) await setSessionMessageId(env.DB, sessionId, lastMessageId);
}

async function showCandidates(
  ctx: BotContext,
  env: Env,
  cfg: Config,
  args: { candidates: TrackSummary[]; query: string; page: number; sessionId?: string; edit?: boolean },
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
    const sent = await ctx.reply(text, options);
    await setSessionMessageId(env.DB, sessionId, sent.message_id);
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

  const track = chosen.lyrics
    ? chosen
    : chosen.id
      ? await getTrackById(env.DB, chosen.id)
      : null;
  if (!track?.lyrics) {
    await ctx.reply(M.noLyricsFound(chosen), HTML);
    return;
  }
  await sendTrack(ctx, env, cfg, track, { searchSessionId: session.id });
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

  const placeholder = await ctx.reply(M.TRANSLATING, {
    ...HTML,
    ...(session.messageId
      ? { reply_parameters: { message_id: session.messageId, allow_sending_without_reply: true } }
      : {}),
  });

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

    const body =
      renderTranslationMessage(track, translation, language.nativeName) +
      (translation.missing > 0 ? M.partialNotice(translation.missing) : '');
    const chunks = splitMessage(body);
    await ctx.api.editMessageText(chatId, placeholder.message_id, chunks[0] ?? '', HTML);
    for (const chunk of chunks.slice(1)) {
      await ctx.reply(chunk, HTML);
    }
  } catch (error) {
    logError('translate', error, { userId, track: track.trackName });
    const text = isUserFacing(error) ? error.userText : describeAiError(error);
    await ctx.api.editMessageText(chatId, placeholder.message_id, text, HTML).catch(() => undefined);
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
