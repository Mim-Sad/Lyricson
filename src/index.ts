/**
 * The Worker entry point: Telegram webhook, a status page, a health endpoint
 * and /admin/setup which registers the webhook and the bot commands for you.
 */
import { Hono, type Context } from 'hono';
import type { Bot } from 'grammy';
import type { UserFromGetMe } from 'grammy/types';
import { createBot } from './bot.js';
import { readConfig, setupChecks, type Config, type Env } from './env.js';
import { logError } from './lib/errors.js';
import { loadSettings } from './lib/settings.js';
import { ensureSchema } from './lib/store.js';
import { BOT_COMMANDS, telegramApi } from './lib/telegram.js';
import { landingPage, setupResultPage } from './ui/landing.js';

type AppEnv = { Bindings: Env };

const app = new Hono<AppEnv>();

interface BotCache {
  key: string;
  bot: Bot;
  info: UserFromGetMe | null;
}

let cachedBot: BotCache | null = null;

/** Creates (and initialises) the grammY bot once per isolate. */
async function readyBot(env: Env, cfg: Config): Promise<Bot> {
  const key = `${cfg.botToken}|${cfg.apiRoot ?? ''}`;
  if (cachedBot && cachedBot.key === key) {
    if (!cachedBot.info) {
      await cachedBot.bot.init();
      cachedBot.info = cachedBot.bot.botInfo;
    }
    return cachedBot.bot;
  }

  const bot = createBot(env, cfg);
  try {
    await bot.init();
    cachedBot = { key, bot, info: bot.botInfo };
  } catch (error) {
    logError('bot.init', error);
    cachedBot = { key, bot, info: null };
  }
  return bot;
}

function botUsername(): string | undefined {
  return cachedBot?.info?.username;
}

// ---------------------------------------------------------------------------
// Webhook
// ---------------------------------------------------------------------------

async function webhook(c: Context<AppEnv>): Promise<Response> {
  const cfg = readConfig(c.env);
  const provided = c.req.header('x-telegram-bot-api-secret-token') ?? c.req.param('secret') ?? '';
  if (cfg.webhookSecret && provided !== cfg.webhookSecret) {
    return c.json({ ok: false, error: 'forbidden' }, 403);
  }
  if (!cfg.botToken) {
    return c.json({ ok: false, error: 'TELEGRAM_BOT_TOKEN is not set' }, 500);
  }

  let update: unknown;
  try {
    update = await c.req.json();
  } catch {
    return c.json({ ok: true });
  }

  // Answer Telegram immediately; the work continues in the background.
  const work = (async () => {
    try {
      await ensureSchema(c.env.DB);
      const bot = await readyBot(c.env, cfg);
      await bot.handleUpdate(update as Parameters<Bot['handleUpdate']>[0]);
    } catch (error) {
      logError('webhook', error);
    }
  })();

  try {
    c.executionCtx.waitUntil(work);
  } catch {
    await work;
  }
  return c.json({ ok: true });
}

app.post('/telegram/webhook', webhook);
app.post('/telegram/webhook/:secret', webhook);
app.get('/telegram/webhook', (c) => c.text('Telegram only posts here.', 405));

// ---------------------------------------------------------------------------
// Status, health, admin
// ---------------------------------------------------------------------------

async function databaseStatus(env: Env): Promise<{ ready: boolean; error?: string }> {
  if (!env.DB) return { ready: false, error: 'binding DB missing' };
  try {
    await ensureSchema(env.DB);
    await env.DB.prepare('SELECT 1 AS ok').first();
    return { ready: true };
  } catch (error) {
    return { ready: false, error: error instanceof Error ? error.message : 'unknown error' };
  }
}

app.get('/', async (c) => {
  const cfg = readConfig(c.env);
  const database = await databaseStatus(c.env);
  const settings = await loadSettings(c.env, cfg).catch(() => null);
  return c.html(
    landingPage({
      checks: setupChecks(c.env, cfg),
      model: settings?.ai.model ?? cfg.ai.model,
      baseUrl: settings?.ai.baseUrl ?? cfg.ai.baseUrl,
      dailyLimit: settings?.dailyLimit ?? cfg.dailyLimit,
      databaseReady: database.ready,
      ...(database.error ? { databaseError: database.error } : {}),
      ...(botUsername() ? { botUsername: botUsername() as string } : {}),
    }),
  );
});

app.get('/health', async (c) => {
  const cfg = readConfig(c.env);
  const database = await databaseStatus(c.env);
  const settings = await loadSettings(c.env, cfg).catch(() => null);
  const ai = settings?.ai ?? cfg.ai;
  return c.json({
    ok: Boolean(cfg.botToken) && database.ready,
    botToken: Boolean(cfg.botToken),
    database: database.ready,
    aiKey: Boolean(ai.apiKey),
    aiProvider: ai.provider,
    webhookSecret: Boolean(cfg.webhookSecret),
    adminPanel: cfg.adminUserIds.length > 0,
    model: ai.model,
  });
});

app.get('/admin/setup', async (c) => {
  const cfg = readConfig(c.env);
  const key = c.req.query('key') ?? '';

  if (!cfg.adminSecret) {
    return c.html(
      setupResultPage({
        ok: false,
        title: 'ADMIN_SECRET تنظیم نشده',
        lines: [
          'اول یک secret به اسم <code>ADMIN_SECRET</code> بساز:',
          '<code>npx wrangler secret put ADMIN_SECRET</code>',
          'بعد همین صفحه را با <code>/admin/setup?key=&lt;همان مقدار&gt;</code> باز کن.',
        ],
      }),
      403,
    );
  }
  if (key !== cfg.adminSecret) return c.text('403 forbidden', 403);
  if (!cfg.botToken) {
    return c.html(
      setupResultPage({
        ok: false,
        title: 'TELEGRAM_BOT_TOKEN تنظیم نشده',
        lines: [
          'توکن ربات را از @BotFather بگیر و ست کن:',
          '<code>npx wrangler secret put TELEGRAM_BOT_TOKEN</code>',
        ],
      }),
      400,
    );
  }

  const origin = new URL(c.req.url).origin;
  const webhookUrl = `${origin}/telegram/webhook`;
  const me = await telegramApi<{ username?: string; first_name?: string }>(cfg, 'getMe');
  const webhookBody: Record<string, unknown> = {
    url: webhookUrl,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  };
  if (cfg.webhookSecret) webhookBody.secret_token = cfg.webhookSecret;
  const hook = await telegramApi<boolean>(cfg, 'setWebhook', webhookBody);
  const commands = await telegramApi<boolean>(cfg, 'setMyCommands', { commands: BOT_COMMANDS });

  const lines = [
    `getMe: ${me.ok ? `✅ ربات <b>@${me.result?.username ?? '?'}</b>` : `⛔️ ${me.description ?? 'failed'}`}`,
    `setWebhook: ${hook.ok ? `✅ <code>${webhookUrl}</code>` : `⛔️ ${hook.description ?? 'failed'}`}`,
    `setMyCommands: ${commands.ok ? '✅ دستورها ثبت شد' : `⛔️ ${commands.description ?? 'failed'}`}`,
  ];
  const warnings = cfg.webhookSecret
    ? []
    : ['<code>TELEGRAM_WEBHOOK_SECRET</code> خالی است؛ هر کسی می‌تواند آدرس وب‌هوک را صدا بزند. یک secret بساز و دوباره همین صفحه را باز کن.'];

  return c.html(
    setupResultPage({
      ok: Boolean(me.ok && hook.ok),
      title: Boolean(me.ok && hook.ok) ? 'وب‌هوک ثبت شد' : 'ثبت وب‌هوک کامل نشد',
      lines,
      ...(me.result?.username ? { botUsername: me.result.username } : {}),
      warnings,
    }),
  );
});

app.notFound((c) => c.text('یا این آدرس وجود ندارد. /', 404));

app.onError((error, c) => {
  logError('http', error, { path: new URL(c.req.url).pathname });
  return c.json({ ok: false, error: 'internal error' }, 500);
});

export default app;
