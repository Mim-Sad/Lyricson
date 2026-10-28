/**
 * Runtime settings the admin can change from inside the bot.
 *
 * Precedence is always: value saved in D1 > env / wrangler var > built-in
 * default. Cloudflare secrets cannot be edited at runtime, so the panel writes
 * to a small `settings` table and everything reads through `loadSettings`.
 */
import type { AiConfig, AiProvider, Config, Env } from '../env.js';
import { AI_PROVIDERS, isAiProvider, normalizeHttpUrl } from '../env.js';
import { ensureSchema, nowSeconds } from './store.js';

export type SettingKey =
  | 'ai_provider'
  | 'ai_api_key'
  | 'ai_base_url'
  | 'ai_model'
  | 'default_target_lang'
  | 'daily_limit'
  | 'public_url';

export const SETTING_KEYS: readonly SettingKey[] = [
  'ai_provider',
  'ai_api_key',
  'ai_base_url',
  'ai_model',
  'default_target_lang',
  'daily_limit',
  'public_url',
];

export type StoredSettings = Partial<Record<SettingKey, string>>;

export interface SettingsSnapshot {
  ai: AiConfig;
  defaultTargetLang: string;
  dailyLimit: number;
  publicUrl?: string;
  /** Keys currently overridden by the admin panel rather than env. */
  fromDb: SettingKey[];
  updatedAt?: number;
}

export function isSettingKey(value: string | undefined): value is SettingKey {
  return Boolean(value) && (SETTING_KEYS as readonly string[]).includes(value as string);
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function positiveInt(value: string | undefined): number | undefined {
  const parsed = Number.parseInt(clean(value) ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}

/**
 * Pure merge of env config and D1 rows, so the effective values are testable
 * without a database.
 */
export function mergeSettings(
  cfg: Config,
  stored: StoredSettings,
  updatedAt?: number,
): SettingsSnapshot {
  const providerValue = clean(stored.ai_provider);
  const provider: AiProvider = isAiProvider(providerValue) ? providerValue : cfg.ai.provider;
  const preset = AI_PROVIDERS[provider];

  const baseUrl =
    normalizeHttpUrl(stored.ai_base_url) ?? normalizeHttpUrl(cfg.ai.baseUrl) ?? preset.baseUrl;
  const model = clean(stored.ai_model) ?? clean(cfg.ai.model) ?? preset.models[0] ?? '';
  const apiKey = clean(stored.ai_api_key) ?? cfg.ai.apiKey;
  const defaultTargetLang = clean(stored.default_target_lang) ?? cfg.defaultTargetLang;
  const dailyLimit = positiveInt(stored.daily_limit) ?? cfg.dailyLimit;
  const publicUrl = normalizeHttpUrl(stored.public_url) ?? cfg.publicUrl;

  // Only values that actually win over env are reported as "from the panel";
  // a malformed leftover row must not pretend to be the active setting.
  const fromDb: SettingKey[] = [];
  if (isAiProvider(providerValue)) fromDb.push('ai_provider');
  if (clean(stored.ai_api_key)) fromDb.push('ai_api_key');
  if (normalizeHttpUrl(stored.ai_base_url)) fromDb.push('ai_base_url');
  if (clean(stored.ai_model)) fromDb.push('ai_model');
  if (clean(stored.default_target_lang)) fromDb.push('default_target_lang');
  if (positiveInt(stored.daily_limit)) fromDb.push('daily_limit');
  if (normalizeHttpUrl(stored.public_url)) fromDb.push('public_url');

  const ai: AiConfig = {
    provider,
    baseUrl,
    model,
    ...(apiKey ? { apiKey } : {}),
    ...(publicUrl ? { appUrl: publicUrl } : {}),
  };

  return {
    ai,
    defaultTargetLang,
    dailyLimit,
    ...(publicUrl ? { publicUrl } : {}),
    fromDb,
    ...(updatedAt ? { updatedAt } : {}),
  };
}

// ---------------------------------------------------------------------------
// D1 storage
// ---------------------------------------------------------------------------

interface SettingsRow {
  key: string;
  value: string;
  updated_at: number;
}

export async function readStoredSettings(
  env: Env,
): Promise<{ values: StoredSettings; updatedAt?: number }> {
  try {
    await ensureSchema(env.DB);
    const rows = await env.DB.prepare('SELECT key, value, updated_at FROM settings').all<SettingsRow>();
    const values: StoredSettings = {};
    let updatedAt = 0;
    for (const row of rows.results ?? []) {
      if (!isSettingKey(row.key)) continue;
      values[row.key] = row.value;
      updatedAt = Math.max(updatedAt, row.updated_at);
    }
    return { values, ...(updatedAt > 0 ? { updatedAt } : {}) };
  } catch {
    // A missing table or a hiccup must not take the bot down: env still works.
    return { values: {} };
  }
}

const CACHE_TTL_MS = 8_000;
let cache: { at: number; snapshot: SettingsSnapshot } | null = null;

export function invalidateSettingsCache(): void {
  cache = null;
}

export async function loadSettings(
  env: Env,
  cfg: Config,
  options: { fresh?: boolean } = {},
): Promise<SettingsSnapshot> {
  if (!options.fresh && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.snapshot;
  const stored = await readStoredSettings(env);
  const snapshot = mergeSettings(cfg, stored.values, stored.updatedAt);
  cache = { at: Date.now(), snapshot };
  return snapshot;
}

/** Saves the given values; `null` or an empty string removes the override. */
export async function saveSettings(
  env: Env,
  entries: Partial<Record<SettingKey, string | null>>,
): Promise<void> {
  await ensureSchema(env.DB);
  const statements: D1PreparedStatement[] = [];
  const now = nowSeconds();

  for (const [key, raw] of Object.entries(entries) as [SettingKey, string | null | undefined][]) {
    if (!isSettingKey(key) || raw === undefined) continue;
    const value = raw?.trim();
    if (!value) {
      statements.push(env.DB.prepare('DELETE FROM settings WHERE key = ?1').bind(key));
      continue;
    }
    statements.push(
      env.DB.prepare(
        `INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).bind(key, value, now),
    );
  }

  if (statements.length > 0) await env.DB.batch(statements);
  invalidateSettingsCache();
}

export async function saveSetting(
  env: Env,
  key: SettingKey,
  value: string | null,
): Promise<void> {
  await saveSettings(env, { [key]: value });
}

/** "sk-or-v1-…9f3a" — enough to recognise a key, not enough to use it. */
export function maskSecret(secret: string | undefined): string {
  if (!secret) return '';
  if (secret.length <= 8) return '••••';
  return `${secret.slice(0, 5)}…${secret.slice(-4)}`;
}
