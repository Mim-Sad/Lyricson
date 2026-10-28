/** Worker bindings and the derived, validated configuration. */

export interface Env {
  /** D1 database: sessions, caches, preferences and daily usage. */
  DB: D1Database;

  /** Telegram bot token from @BotFather. */
  TELEGRAM_BOT_TOKEN: string;
  /** Shared secret registered with setWebhook and checked on every update. */
  TELEGRAM_WEBHOOK_SECRET?: string;
  /** Development only: point grammY at a mock Telegram API server. */
  TELEGRAM_API_ROOT?: string;

  /** OpenAI-compatible endpoint that powers the translation. */
  AI_PROVIDER?: string;
  AI_API_KEY?: string;
  AI_BASE_URL?: string;
  AI_MODEL?: string;

  /** Protects /admin/setup. */
  ADMIN_SECRET?: string;
  /** Numeric Telegram user id(s) that may open the in-bot admin panel. */
  ADMIN_USER_ID?: string;
  /** Public origin of this Worker, used to register the webhook from the bot. */
  PUBLIC_URL?: string;

  /** Optional: lets the song title link to Spotify (developer.spotify.com, client credentials). */
  SPOTIFY_CLIENT_ID?: string;
  SPOTIFY_CLIENT_SECRET?: string;

  DEFAULT_TARGET_LANG?: string;
  DAILY_TRANSLATION_LIMIT?: string;
}

export type AiProvider = 'openrouter' | 'freebuff' | 'custom';

export interface AiProviderPreset {
  id: AiProvider;
  label: string;
  /** Default OpenAI-compatible base URL (without /chat/completions). */
  baseUrl: string;
  /** Model ids offered as one-tap choices in the admin panel. */
  models: readonly string[];
  keyUrl?: string;
}

export const AI_PROVIDERS: Record<AiProvider, AiProviderPreset> = {
  openrouter: {
    id: 'openrouter',
    label: 'OpenRouter',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: [
      'google/gemini-3.8-flash',
      'anthropic/claude-haiku-5.5',
      'openai/gpt-6-luna',
      'deepseek/deepseek-v4.1-flash',
      'qwen/qwen3.8-flash',
      'anthropic/claude-sonnet-5.5',
      'google/gemini-4-argon',
    ],
    keyUrl: 'https://openrouter.ai/keys',
  },
  freebuff: {
    id: 'freebuff',
    label: 'Freebuff API',
    baseUrl: 'https://freebuff.com/api/v1/paid',
    models: [
      'gemini-3.8-flash',
      'deepseek-v4.1-flash',
      'gpt-6-luna',
      'kimi-k3',
      'gemini-4-argon',
      'claude-sonnet-5-5',
      'claude-opus-5-5',
    ],
    keyUrl: 'https://freebuff.com/account/api',
  },
  custom: {
    id: 'custom',
    label: 'سرویس دلخواه',
    baseUrl: '',
    models: [],
  },
};

export const AI_PROVIDER_ORDER: readonly AiProvider[] = ['openrouter', 'freebuff', 'custom'];

export function isAiProvider(value: string | undefined): value is AiProvider {
  return value === 'openrouter' || value === 'freebuff' || value === 'custom';
}

export const DEFAULT_AI_PROVIDER: AiProvider = 'openrouter';
export const DEFAULT_AI_BASE_URL = AI_PROVIDERS[DEFAULT_AI_PROVIDER].baseUrl;
export const DEFAULT_AI_MODEL = AI_PROVIDERS[DEFAULT_AI_PROVIDER].models[0] ?? '';

/** Kept for readability at call sites that list models. */
export const AI_MODEL_SUGGESTIONS = AI_PROVIDERS.openrouter.models;

export interface AiConfig {
  provider: AiProvider;
  apiKey?: string;
  baseUrl: string;
  model: string;
  /** Sent to OpenRouter for attribution and rankings. */
  appUrl?: string;
}

export interface Config {
  botToken: string;
  webhookSecret?: string;
  apiRoot?: string;
  adminSecret?: string;
  /** Effective admins: env ids plus the ones added from the bot (refreshed per update). */
  adminUserIds: number[];
  /** Admins declared in `ADMIN_USER_ID`; they cannot be removed from the panel. */
  envAdminIds: number[];
  publicUrl?: string;
  spotify?: { id: string; secret: string };
  ai: AiConfig;
  defaultTargetLang: string;
  dailyLimit: number;
}

export const DEFAULT_DAILY_LIMIT = 40;

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function toInt(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(clean(value) ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/** Accepts only http(s) URLs; trailing slashes are dropped. */
export function normalizeHttpUrl(value: string | undefined): string | undefined {
  const trimmed = clean(value)?.replace(/\/+$/, '');
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return undefined;
    if (!url.hostname) return undefined;
    return trimmed;
  } catch {
    return undefined;
  }
}

/** "123456, 7890" -> [123456, 7890]. */
export function parseAdminIds(value: string | undefined): number[] {
  const ids = new Set<number>();
  for (const part of (value ?? '').split(/[,\s]+/)) {
    const id = Number.parseInt(part.trim(), 10);
    if (Number.isSafeInteger(id) && id > 0) ids.add(id);
  }
  return [...ids];
}

export function readConfig(env: Env): Config {
  const providerValue = clean(env.AI_PROVIDER);
  const provider = isAiProvider(providerValue) ? providerValue : DEFAULT_AI_PROVIDER;
  const preset = AI_PROVIDERS[provider];
  const publicUrl = normalizeHttpUrl(env.PUBLIC_URL);

  return {
    botToken: clean(env.TELEGRAM_BOT_TOKEN) ?? '',
    webhookSecret: clean(env.TELEGRAM_WEBHOOK_SECRET),
    apiRoot: clean(env.TELEGRAM_API_ROOT),
    adminSecret: clean(env.ADMIN_SECRET),
    adminUserIds: parseAdminIds(env.ADMIN_USER_ID),
    envAdminIds: parseAdminIds(env.ADMIN_USER_ID),
    ...(publicUrl ? { publicUrl } : {}),
    ...(clean(env.SPOTIFY_CLIENT_ID) && clean(env.SPOTIFY_CLIENT_SECRET)
      ? { spotify: { id: clean(env.SPOTIFY_CLIENT_ID) as string, secret: clean(env.SPOTIFY_CLIENT_SECRET) as string } }
      : {}),
    ai: {
      provider,
      apiKey: clean(env.AI_API_KEY),
      baseUrl: normalizeHttpUrl(env.AI_BASE_URL) ?? preset.baseUrl,
      model: clean(env.AI_MODEL) ?? preset.models[0] ?? DEFAULT_AI_MODEL,
      ...(publicUrl ? { appUrl: publicUrl } : {}),
    },
    defaultTargetLang: clean(env.DEFAULT_TARGET_LANG) ?? 'fa',
    dailyLimit: toInt(env.DAILY_TRANSLATION_LIMIT, DEFAULT_DAILY_LIMIT),
  };
}

/**
 * The webhook secret: `TELEGRAM_WEBHOOK_SECRET` when set, otherwise derived
 * from the bot token (which only the owner knows), so a fresh deploy is
 * protected without any extra configuration.
 */
export async function webhookSecretFor(cfg: Config): Promise<string> {
  if (cfg.webhookSecret) return cfg.webhookSecret;
  if (!cfg.botToken) return '';
  const bytes = new TextEncoder().encode(`lyricson-webhook:${cfg.botToken}`);
  const digest = await crypto.subtle.digest('SHA-256', bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

export interface SetupCheck {
  label: string;
  /** Persian hint shown when the item is missing. */
  hint: string;
  ok: boolean;
  required: boolean;
}

/** Used by the landing page and by /admin/setup. */
export function setupChecks(
  env: Env,
  cfg: Config,
  live?: { hasAiKey: boolean; adminCount: number },
): SetupCheck[] {
  return [
    {
      label: 'TELEGRAM_BOT_TOKEN',
      hint: 'توکن ربات از @BotFather را به عنوان secret ست کن.',
      ok: cfg.botToken.length > 0,
      required: true,
    },
    {
      label: 'DB (D1)',
      hint: 'بایندینگ DB در wrangler.jsonc باید باشد؛ هنگام دیپلوی روی Cloudflare خودکار ساخته می‌شود.',
      ok: Boolean(env.DB),
      required: true,
    },
    {
      label: 'AI_API_KEY',
      hint: 'کلید OpenRouter را ست کن یا از پنل ادمین داخل ربات بگذار.',
      ok: live ? live.hasAiKey : Boolean(cfg.ai.apiKey),
      required: false,
    },
    {
      label: 'ADMIN_USER_ID',
      hint: 'آیدی عددی ادمین؛ اگر از داخل ربات ادمین ثبت کرده‌ای، این مورد خودکار سبز می‌شود.',
      ok: (live ? live.adminCount : cfg.adminUserIds.length) > 0,
      required: false,
    },
  ];
}
