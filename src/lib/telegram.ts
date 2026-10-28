/** Thin Telegram Bot API client shared by /admin/setup and the admin panel. */
import { webhookSecretFor, type Config, type Env } from '../env.js';
import { loadSettings, readStoredSettings, saveSettings } from './settings.js';
import { sha256Hex } from './text.js';

export interface TelegramEnvelope<T> {
  ok?: boolean;
  result?: T;
  description?: string;
}

export function telegramApiBase(cfg: Config): string {
  return cfg.apiRoot ?? 'https://api.telegram.org';
}

export async function telegramApi<T>(
  cfg: Config,
  method: string,
  body?: unknown,
  timeoutMs = 15_000,
): Promise<TelegramEnvelope<T>> {
  try {
    const response = await fetch(`${telegramApiBase(cfg)}/bot${cfg.botToken}/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    return (await response.json()) as TelegramEnvelope<T>;
  } catch (error) {
    return { ok: false, description: error instanceof Error ? error.message : 'network error' };
  }
}

export const BOT_COMMANDS = [
  { command: 'start', description: 'شروع و راهنمای ربات' },
  { command: 'help', description: 'راهنمای کامل' },
  { command: 'lang', description: 'تغییر زبان مقصد' },
] as const;

/** Shown only in the admin's own chat, so regular users never see it. */
export async function setAdminCommands(cfg: Config, adminId: number): Promise<void> {
  await telegramApi(cfg, 'setMyCommands', {
    commands: [...BOT_COMMANDS, { command: 'admin', description: 'پنل مدیریت' }],
    scope: { type: 'chat', chat_id: adminId },
  });
}

export async function clearAdminCommands(cfg: Config, adminId: number): Promise<void> {
  await telegramApi(cfg, 'deleteMyCommands', { scope: { type: 'chat', chat_id: adminId } });
}

export interface WebhookRegistration {
  webhookUrl: string;
  hook: TelegramEnvelope<boolean>;
  commands: TelegramEnvelope<boolean>;
}

/** Points Telegram at `/telegram/webhook` on the given public origin. */
export async function registerBotWebhook(
  cfg: Config,
  publicUrl: string,
): Promise<WebhookRegistration> {
  const webhookUrl = `${publicUrl.replace(/\/+$/, '')}/telegram/webhook`;
  const body: Record<string, unknown> = {
    url: webhookUrl,
    allowed_updates: ['message', 'callback_query'],
    drop_pending_updates: true,
  };
  const secret = await webhookSecretFor(cfg);
  if (secret) body.secret_token = secret;

  const hook = await telegramApi<boolean>(cfg, 'setWebhook', body);
  const commands = await telegramApi<boolean>(cfg, 'setMyCommands', { commands: BOT_COMMANDS });
  return { webhookUrl, hook, commands };
}

export interface WebhookInfo {
  url?: string;
  pending_update_count?: number;
  last_error_date?: number;
  last_error_message?: string;
}

export function getWebhookInfo(cfg: Config): Promise<TelegramEnvelope<WebhookInfo>> {
  return telegramApi<WebhookInfo>(cfg, 'getWebhookInfo');
}

/**
 * Registers the webhook for `origin` once per (token, origin, secret) and
 * remembers that in D1, so opening the Worker URL (or the cron tick) is all
 * the setup a fresh deploy needs. Returns null when nothing had to be done.
 */
export async function ensureWebhook(
  env: Env,
  cfg: Config,
  origin: string,
  options: { force?: boolean } = {},
): Promise<WebhookRegistration | null> {
  if (!cfg.botToken || !origin) return null;
  const fingerprint = await sha256Hex(
    [cfg.botToken, origin, await webhookSecretFor(cfg), cfg.apiRoot ?? '', JSON.stringify(BOT_COMMANDS)].join('|'),
  );
  if (!options.force) {
    const stored = await readStoredSettings(env);
    if (stored.values.webhook_state === fingerprint) return null;
  }
  const registration = await registerBotWebhook(cfg, origin);
  if (registration.hook.ok) {
    await saveSettings(env, { webhook_state: fingerprint, public_url: origin });
    const settings = await loadSettings(env, cfg, { fresh: true });
    await Promise.all(settings.adminIds.map((id) => setAdminCommands(cfg, id)));
  }
  return registration;
}
