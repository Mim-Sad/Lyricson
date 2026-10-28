/**
 * In-bot admin handlers. Every entry point re-checks the numeric admin id from
 * `ADMIN_USER_ID`, so a forwarded button or a guessed callback does nothing.
 */
import { InlineKeyboard, type Context } from 'grammy';
import type { Config, Env } from './env.js';
import { AI_PROVIDERS, normalizeHttpUrl } from './env.js';
import { testAiConnection } from './lib/ai.js';
import {
  INPUT_PROMPTS,
  isAdmin,
  parseAdminCallback,
  renderScreen,
  type AdminInputField,
  type AdminScreen,
} from './lib/admin-panel.js';
import { escapeHtml } from './lib/format.js';
import {
  addAdminId,
  loadSettings,
  maskSecret,
  removeAdminId,
  saveSetting,
  saveSettings,
} from './lib/settings.js';
import {
  clearAdminState,
  dayKey,
  ensureSchema,
  getAdminState,
  pruneCaches,
  setAdminState,
} from './lib/store.js';
import { getWebhookInfo, registerBotWebhook, telegramApi } from './lib/telegram.js';
import { probeLrclib } from './lib/lyrics.js';
import { faDigits } from './lib/text.js';

const HTML = { parse_mode: 'HTML', link_preview_options: { is_disabled: true } } as const;

export async function handleAdminCommand(ctx: Context, env: Env, cfg: Config): Promise<void> {
  if (!isAdmin(cfg, ctx.from?.id)) return;
  // Opening the panel always cancels a pending "send me the new value" prompt.
  if (ctx.from?.id) await clearAdminState(env.DB, ctx.from.id);
  const snapshot = await loadSettings(env, cfg);
  const panel = renderScreen('home', snapshot, cfg);
  await ctx.reply(panel.text, { ...HTML, reply_markup: panel.keyboard });
}

/** Renders a screen by editing the panel message, or replying when there is none. */
async function showScreen(
  ctx: Context,
  screen: AdminScreen,
  snapshot: Awaited<ReturnType<typeof loadSettings>>,
  cfg: Config,
  flash?: string,
): Promise<void> {
  const panel = renderScreen(screen, snapshot, cfg);
  const text = flash ? `${flash}\n\n${panel.text}` : panel.text;
  const message = ctx.callbackQuery?.message;
  if (message) {
    try {
      await ctx.api.editMessageText(message.chat.id, message.message_id, text, {
        ...HTML,
        reply_markup: panel.keyboard,
      });
      return;
    } catch (error) {
      // Tapping the same button twice is not an error worth showing.
      if (error instanceof Error && /message is not modified/i.test(error.message)) return;
    }
  }
  await ctx.reply(text, { ...HTML, reply_markup: panel.keyboard });
}

async function refresh(
  ctx: Context,
  env: Env,
  cfg: Config,
  screen: AdminScreen,
  flash?: string,
): Promise<void> {
  const snapshot = await loadSettings(env, cfg, { fresh: true });
  await showScreen(ctx, screen, snapshot, cfg, flash);
}

async function askForInput(
  ctx: Context,
  env: Env,
  cfg: Config,
  field: AdminInputField,
  intro?: string,
): Promise<void> {
  const userId = ctx.from?.id;
  if (!userId) return;
  await setAdminState(env.DB, userId, field);
  const text = [intro, INPUT_PROMPTS[field], '<i>برای لغو /admin را بزن.</i>']
    .filter(Boolean)
    .join('\n\n');
  await ctx.reply(text, {
    ...HTML,
    reply_markup: new InlineKeyboard().text('✖️ لغو', 'a:home'),
  });
}

export async function handleAdminCallback(
  ctx: Context,
  env: Env,
  cfg: Config,
  data: string,
): Promise<boolean> {
  const action = parseAdminCallback(data);
  if (!action) return false;

  const userId = ctx.from?.id;
  if (!isAdmin(cfg, userId)) {
    await ctx.answerCallbackQuery({ text: 'این بخش فقط برای ادمین است.' }).catch(() => undefined);
    return true;
  }
  await ctx.answerCallbackQuery().catch(() => undefined);
  // Navigating the panel abandons any half-finished text input as well.
  if (userId) await clearAdminState(env.DB, userId);

  switch (action.kind) {
    case 'screen':
      await refresh(ctx, env, cfg, action.screen);
      return true;

    case 'input':
      await askForInput(ctx, env, cfg, action.field);
      return true;

    case 'setProvider': {
      const preset = AI_PROVIDERS[action.provider];
      if (action.provider === 'custom') {
        await saveSetting(env, 'ai_provider', 'custom');
        await askForInput(
          ctx,
          env,
          cfg,
          'ai_base_url',
          '🔄 سرویس دلخواه انتخاب شد. اول آدرس سرویس سازگار با OpenAI را بفرست.',
        );
        return true;
      }
      await saveSettings(env, {
        ai_provider: action.provider,
        ai_base_url: preset.baseUrl,
        ai_model: preset.models[0] ?? '',
      });
      await refresh(
        ctx,
        env,
        cfg,
        'ai',
        `✅ سرویس <b>${escapeHtml(preset.label)}</b> تنظیم شد؛ آدرس و مدل پیشنهادی هم عوض شدند.`,
      );
      return true;
    }

    case 'setModelIndex': {
      const snapshot = await loadSettings(env, cfg, { fresh: true });
      const preset = AI_PROVIDERS[snapshot.ai.provider];
      const model = preset.models[action.index];
      if (!model) {
        await refresh(ctx, env, cfg, 'models', '⛔️ این مدل در فهرست نیست؛ شناسه را دستی بفرست.');
        return true;
      }
      await saveSetting(env, 'ai_model', model);
      await refresh(ctx, env, cfg, 'ai', `✅ مدل: <code>${escapeHtml(model)}</code>`);
      return true;
    }

    case 'setLang': {
      await saveSetting(env, 'default_target_lang', action.code);
      await refresh(ctx, env, cfg, 'defaults', '✅ زبان پیش‌فرض تغییر کرد.');
      return true;
    }

    case 'clear':
      await saveSetting(env, action.key, null);
      await refresh(ctx, env, cfg, 'reset', '♻️ مقدار پاک شد و مقدار env برگشت.');
      return true;

    case 'test': {
      const snapshot = await loadSettings(env, cfg, { fresh: true });
      const result = await testAiConnection(snapshot.ai);
      const lines = [
        result.ok ? '✅ <b>اتصال برقرار است</b>' : '⛔️ <b>تست ناموفق بود</b>',
        `سرویس: <b>${escapeHtml(AI_PROVIDERS[snapshot.ai.provider].label)}</b>`,
        `مدل: <code>${escapeHtml(result.model || '—')}</code>`,
        `زمان: ${faDigits(result.latencyMs)} میلی‌ثانیه`,
        ...(result.detail ? [`پاسخ: <code>${escapeHtml(result.detail)}</code>`] : []),
      ];
      await ctx.reply(lines.join('\n'), {
        ...HTML,
        reply_markup: new InlineKeyboard().text('⬅️ هوش مصنوعی', 'a:ai'),
      });
      return true;
    }

    case 'diagnose': {
      const snapshot = await loadSettings(env, cfg, { fresh: true });
      const [me, lyrics, ai, hook] = await Promise.all([
        telegramApi<{ username?: string }>(cfg, 'getMe'),
        probeLrclib(),
        testAiConnection(snapshot.ai),
        getWebhookInfo(cfg),
      ]);
      const mark = (ok: boolean | undefined) => (ok ? '✅' : '⛔️');
      const lines = [
        '🩺 <b>تشخیص</b>',
        '',
        `${mark(me.ok)} تلگرام: ${escapeHtml(me.ok ? `@${me.result?.username ?? '?'}` : (me.description ?? 'خطا'))}`,
        `${mark(Boolean(hook.result?.url))} وبهوک: <code>${escapeHtml(hook.result?.url ?? '—')}</code>${
          hook.result?.last_error_message ? `\n   ⚠️ ${escapeHtml(hook.result.last_error_message)}` : ''
        }`,
        `${mark(lyrics.ok)} LRCLIB (جست‌وجوی متن): ${escapeHtml(lyrics.detail)}`,
        `${mark(ai.ok)} هوش مصنوعی (<code>${escapeHtml(ai.model || '—')}</code>): ${escapeHtml(ai.detail ?? '')}`,
        `کلید: ${snapshot.ai.apiKey ? '✅ ثبت شده' : '⛔️ ثبت نشده'} · ادمین‌ها: ${faDigits(snapshot.adminIds.length)}`,
      ];
      await ctx.reply(lines.join('\n'), {
        ...HTML,
        reply_markup: new InlineKeyboard().text('⬅️ پنل', 'a:home'),
      });
      return true;
    }

    case 'stats': {
      const stats = await collectStats(env);
      const lines = [
        '📊 <b>آمار امروز</b>',
        '',
        `• ترجمه‌ها: <b>${faDigits(stats.translations)}</b>`,
        `• کاربران فعال: <b>${faDigits(stats.users)}</b>`,
        `• سشن‌های ذخیره‌شده: ${faDigits(stats.sessions)}`,
        `• متن‌های کش‌شده: ${faDigits(stats.lyricsCached)}`,
        `• ترجمه‌های کش‌شده: ${faDigits(stats.translationsCached)}`,
      ];
      await ctx.reply(lines.join('\n'), {
        ...HTML,
        reply_markup: new InlineKeyboard().text('⬅️ پنل', 'a:home'),
      });
      return true;
    }

    case 'clearCache': {
      await ensureSchema(env.DB);
      const before = await cacheCounts(env);
      await env.DB.batch([
        env.DB.prepare('DELETE FROM translation_cache'),
        env.DB.prepare('DELETE FROM lyric_cache'),
      ]);
      await refresh(
        ctx,
        env,
        cfg,
        'home',
        `🧹 کش پاک شد — ${faDigits(before.translations)} ترجمه و ${faDigits(before.lyrics)} متن.`,
      );
      return true;
    }

    case 'pruneCache': {
      const removed = await pruneCaches(env.DB);
      await refresh(
        ctx,
        env,
        cfg,
        'cache',
        `🧹 منقضی‌ها پاک شدند — ${faDigits(removed.translations)} ترجمه و ${faDigits(removed.lyrics)} متن.`,
      );
      return true;
    }

    case 'toggleCache': {
      const snapshot = await loadSettings(env, cfg, { fresh: true });
      await saveSetting(env, 'cache_enabled', snapshot.cache.enabled ? 'off' : null);
      await refresh(ctx, env, cfg, 'cache', snapshot.cache.enabled ? '⛔️ کش خاموش شد.' : '✅ کش روشن شد.');
      return true;
    }

    case 'toggleMaintenance': {
      const snapshot = await loadSettings(env, cfg, { fresh: true });
      await saveSetting(env, 'maintenance', snapshot.maintenance ? null : 'on');
      await refresh(
        ctx,
        env,
        cfg,
        'home',
        snapshot.maintenance ? '▶️ حالت تعمیر تمام شد؛ ربات دوباره پاسخ می‌دهد.' : '⏸ حالت تعمیر روشن شد؛ فقط ادمین‌ها پاسخ می‌گیرند.',
      );
      return true;
    }

    case 'removeAdmin': {
      if (action.id === userId) {
        await refresh(ctx, env, cfg, 'admins', '⛔️ نمی‌توانی خودت را حذف کنی.');
        return true;
      }
      await removeAdminId(env, action.id);
      await refresh(ctx, env, cfg, 'admins', `🗑 ادمین <code>${action.id}</code> حذف شد.`);
      return true;
    }

    case 'webhookRun': {
      const snapshot = await loadSettings(env, cfg, { fresh: true });
      if (!snapshot.publicUrl) {
        await askForInput(
          ctx,
          env,
          cfg,
          'public_url',
          '🔗 برای ثبت وبهوک اول آدرس عمومی ورکر لازم است.',
        );
        return true;
      }
      const result = await registerBotWebhook(cfg, snapshot.publicUrl);
      const info = await getWebhookInfo(cfg);
      const lines = [
        '🔗 <b>ثبت وبهوک</b>',
        `آدرس: <code>${escapeHtml(result.webhookUrl)}</code>`,
        result.hook.ok
          ? '✅ setWebhook انجام شد'
          : `⛔️ setWebhook: ${escapeHtml(result.hook.description ?? 'ناموفق')}`,
        result.commands.ok
          ? '✅ دستورها ثبت شد'
          : `⛔️ setMyCommands: ${escapeHtml(result.commands.description ?? 'ناموفق')}`,
        ...(info.result?.last_error_message
          ? [`⚠️ آخرین خطای تلگرام: ${escapeHtml(info.result.last_error_message)}`]
          : []),
        `در صف: ${faDigits(info.result?.pending_update_count ?? 0)}`,
      ];
      await ctx.reply(lines.join('\n'), {
        ...HTML,
        reply_markup: new InlineKeyboard().text('⬅️ وبهوک', 'a:webhook'),
      });
      return true;
    }

    default:
      return false;
  }
}

export async function handleAdminText(
  ctx: Context,
  env: Env,
  cfg: Config,
  text: string,
): Promise<boolean> {
  const userId = ctx.from?.id;
  if (!isAdmin(cfg, userId) || !userId) return false;

  const state = await getAdminState(env.DB, userId);
  if (!state) return false;
  await clearAdminState(env.DB, userId);

  const field = state.action as AdminInputField;
  const value = text.trim();

  switch (field) {
    case 'ai_key': {
      if (value.length < 8 || /\s/.test(value)) {
        await ctx.reply(
          '⛔️ این کلید معتبر به نظر نمی‌رسد؛ یک رشتهٔ بدون فاصله (حداقل ۸ کاراکتر) بفرست.\nدوباره /admin را بزن.',
          HTML,
        );
        return true;
      }
      await saveSetting(env, 'ai_api_key', value);
      await ctx.deleteMessage().catch(() => undefined);
      await refresh(
        ctx,
        env,
        cfg,
        'ai',
        `✅ کلید ذخیره شد: <code>${escapeHtml(maskSecret(value))}</code> — دیگر با هیچ پیامی فرستاده نمی‌شود.`,
      );
      return true;
    }

    case 'ai_base_url': {
      const url = normalizeHttpUrl(value);
      if (!url) {
        await ctx.reply(
          '⛔️ آدرس باید کامل و با http:// یا https:// شروع شود؛ مثلاً <code>https://openrouter.ai/api/v1</code>',
          HTML,
        );
        return true;
      }
      await saveSetting(env, 'ai_base_url', url);
      await refresh(ctx, env, cfg, 'ai', `✅ آدرس ذخیره شد: <code>${escapeHtml(url)}</code>`);
      return true;
    }

    case 'ai_model': {
      if (!value || value.length > 200 || /\s/.test(value)) {
        await ctx.reply(
          '⛔️ شناسهٔ مدل باید بدون فاصله باشد؛ مثلاً <code>google/gemini-3.8-flash</code>',
          HTML,
        );
        return true;
      }
      await saveSetting(env, 'ai_model', value);
      await refresh(ctx, env, cfg, 'ai', `✅ مدل ذخیره شد: <code>${escapeHtml(value)}</code>`);
      return true;
    }

    case 'daily_limit': {
      const limit = Number.parseInt(value, 10);
      if (!Number.isInteger(limit) || limit < 1 || limit > 1000) {
        await ctx.reply('⛔️ یک عدد بین ۱ تا ۱۰۰۰ بفرست.', HTML);
        return true;
      }
      await saveSetting(env, 'daily_limit', String(limit));
      await refresh(
        ctx,
        env,
        cfg,
        'defaults',
        `✅ سهمیهٔ روزانه: <b>${faDigits(limit)}</b> ترجمه برای هر کاربر`,
      );
      return true;
    }

    case 'admin_add': {
      const id = Number.parseInt(value, 10);
      if (!/^\d{5,15}$/.test(value) || !Number.isSafeInteger(id)) {
        await ctx.reply('⛔️ آیدی عددی باید فقط رقم باشد (نه یوزرنیم)؛ از /id یا @userinfobot بگیر.', HTML);
        return true;
      }
      await addAdminId(env, id);
      await refresh(ctx, env, cfg, 'admins', `✅ ادمین <code>${id}</code> اضافه شد.`);
      return true;
    }

    case 'cache_translation_days':
    case 'cache_lyrics_days': {
      const days = Number.parseInt(value, 10);
      if (!/^\d+$/.test(value) || days < 1 || days > 365) {
        await ctx.reply('⛔️ یک عدد بین ۱ تا ۳۶۵ بفرست.', HTML);
        return true;
      }
      await saveSetting(env, field, String(days));
      await refresh(ctx, env, cfg, 'cache', `✅ ماندگاری: <b>${faDigits(days)}</b> روز`);
      return true;
    }

    case 'public_url': {
      const url = normalizeHttpUrl(value);
      if (!url) {
        await ctx.reply(
          '⛔️ آدرس باید کامل و با http:// یا https:// شروع شود؛ مثلاً <code>https://lyricson.example.workers.dev</code>',
          HTML,
        );
        return true;
      }
      await saveSetting(env, 'public_url', url);
      await refresh(
        ctx,
        env,
        cfg,
        'webhook',
        `✅ آدرس عمومی ذخیره شد: <code>${escapeHtml(url)}</code>`,
      );
      return true;
    }

    default:
      return false;
  }
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------

interface CacheCounts {
  translations: number;
  lyrics: number;
}

async function cacheCounts(env: Env): Promise<CacheCounts> {
  const [translations, lyrics] = await Promise.all([
    env.DB.prepare('SELECT COUNT(*) AS total FROM translation_cache').first<{ total: number }>(),
    env.DB.prepare('SELECT COUNT(*) AS total FROM lyric_cache').first<{ total: number }>(),
  ]);
  return {
    translations: Number(translations?.total ?? 0),
    lyrics: Number(lyrics?.total ?? 0),
  };
}

interface TodayStats {
  translations: number;
  users: number;
  sessions: number;
  lyricsCached: number;
  translationsCached: number;
}

async function collectStats(env: Env): Promise<TodayStats> {
  await ensureSchema(env.DB);
  const day = dayKey();
  const [usage, sessions, cache] = await Promise.all([
    env.DB.prepare(
      'SELECT COALESCE(SUM(count), 0) AS total, COUNT(*) AS users FROM usage WHERE day = ?1',
    )
      .bind(day)
      .first<{ total: number; users: number }>(),
    env.DB.prepare('SELECT COUNT(*) AS total FROM sessions').first<{ total: number }>(),
    cacheCounts(env),
  ]);
  return {
    translations: Number(usage?.total ?? 0),
    users: Number(usage?.users ?? 0),
    sessions: Number(sessions?.total ?? 0),
    translationsCached: cache.translations,
    lyricsCached: cache.lyrics,
  };
}
