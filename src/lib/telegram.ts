/** Thin Telegram Bot API client shared by /admin/setup and the admin panel. */
import type { Config } from '../env.js';

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
  if (cfg.webhookSecret) body.secret_token = cfg.webhookSecret;

  const hook = await telegramApi<boolean>(cfg, 'setWebhook', body);
  const commands = await telegramApi<boolean>(cfg, 'setMyCommands', { commands: BOT_COMMANDS });
  return { webhookUrl, hook, commands };
}
