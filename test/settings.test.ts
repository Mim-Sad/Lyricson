import { describe, expect, it } from 'vitest';
import { parseAdminIds, readConfig, type Env } from '../src/env.js';
import { parseAdminCallback } from '../src/lib/admin-panel.js';
import { maskSecret, mergeSettings } from '../src/lib/settings.js';

function makeConfig(overrides: Partial<Env> = {}) {
  return readConfig({
    DB: {} as D1Database,
    TELEGRAM_BOT_TOKEN: '123:abc',
    AI_API_KEY: 'sk-env-key',
    ...overrides,
  });
}

describe('provider configuration', () => {
  it('defaults to OpenRouter with a current model and attribution origin', () => {
    const cfg = makeConfig({ PUBLIC_URL: 'https://lyricson.example.workers.dev' });
    expect(cfg.ai.provider).toBe('openrouter');
    expect(cfg.ai.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(cfg.ai.model).toMatch(/^[\w.-]+\/[\w.:-]+$/);
    expect(cfg.ai.appUrl).toBe('https://lyricson.example.workers.dev');
  });

  it('accepts a custom provider, base URL and model', () => {
    const cfg = makeConfig({
      AI_PROVIDER: 'custom',
      AI_BASE_URL: 'https://example.com/v1/',
      AI_MODEL: 'my-model',
    });
    expect(cfg.ai.provider).toBe('custom');
    expect(cfg.ai.baseUrl).toBe('https://example.com/v1');
    expect(cfg.ai.model).toBe('my-model');
  });

  it('drops malformed URLs instead of shipping them to the model', () => {
    const cfg = makeConfig({ AI_BASE_URL: 'openrouter.ai/api/v1' });
    expect(cfg.ai.baseUrl).toBe('https://openrouter.ai/api/v1');
  });

  it('reads one or many numeric admin ids', () => {
    expect(parseAdminIds('123456')).toEqual([123456]);
    expect(parseAdminIds(' 1, 2 3 ')).toEqual([1, 2, 3]);
    expect(parseAdminIds('abc, -4, 0')).toEqual([]);
    expect(parseAdminIds(undefined)).toEqual([]);
  });
});

describe('mergeSettings', () => {
  it('lets panel values override env', () => {
    const cfg = makeConfig();
    const snapshot = mergeSettings(
      cfg,
      {
        ai_provider: 'freebuff',
        ai_base_url: 'https://freebuff.com/api/v1/paid',
        ai_model: 'claude-sonnet-5-5',
        ai_api_key: 'sk-panel-key',
        default_target_lang: 'fa',
        daily_limit: '12',
        public_url: 'https://bot.example.com',
      },
      1234,
    );

    expect(snapshot.ai.provider).toBe('freebuff');
    expect(snapshot.ai.model).toBe('claude-sonnet-5-5');
    expect(snapshot.ai.apiKey).toBe('sk-panel-key');
    expect(snapshot.defaultTargetLang).toBe('fa');
    expect(snapshot.dailyLimit).toBe(12);
    expect(snapshot.publicUrl).toBe('https://bot.example.com');
    expect(snapshot.ai.appUrl).toBe('https://bot.example.com');
    expect(snapshot.updatedAt).toBe(1234);
    expect(snapshot.fromDb).toHaveLength(7);
  });

  it('falls back to env for missing or invalid rows', () => {
    const cfg = makeConfig({ DEFAULT_TARGET_LANG: 'fa', DAILY_TRANSLATION_LIMIT: '25' });
    const snapshot = mergeSettings(cfg, {
      daily_limit: 'not-a-number',
      ai_base_url: 'javascript:alert(1)',
      ai_provider: 'nope',
    });

    expect(snapshot.ai.provider).toBe('openrouter');
    expect(snapshot.ai.baseUrl).toBe('https://openrouter.ai/api/v1');
    expect(snapshot.ai.apiKey).toBe('sk-env-key');
    expect(snapshot.dailyLimit).toBe(25);
    expect(snapshot.fromDb).toEqual([]);
  });

  it('gives the OpenRouter default model when nothing is stored', () => {
    const cfg = makeConfig({ AI_MODEL: undefined });
    const snapshot = mergeSettings(cfg, {});
    expect(snapshot.ai.model).toBe('google/gemini-3.8-flash');
  });
});

describe('maskSecret', () => {
  it('keeps enough to recognise a key but not to use it', () => {
    expect(maskSecret('sk-or-v1-1234567890abcdef')).toBe('sk-or…cdef');
    expect(maskSecret('short')).toBe('••••');
    expect(maskSecret(undefined)).toBe('');
  });
});

describe('parseAdminCallback', () => {
  it('maps panel buttons to actions', () => {
    expect(parseAdminCallback('a:home')).toEqual({ kind: 'screen', screen: 'home' });
    expect(parseAdminCallback('a:webhook')).toEqual({ kind: 'screen', screen: 'webhook' });
    expect(parseAdminCallback('a:key')).toEqual({ kind: 'input', field: 'ai_key' });
    expect(parseAdminCallback('a:hookurl')).toEqual({ kind: 'input', field: 'public_url' });
    expect(parseAdminCallback('a:p:openrouter')).toEqual({
      kind: 'setProvider',
      provider: 'openrouter',
    });
    expect(parseAdminCallback('a:m:2')).toEqual({ kind: 'setModelIndex', index: 2 });
    expect(parseAdminCallback('a:l:fa')).toEqual({ kind: 'setLang', code: 'fa' });
    expect(parseAdminCallback('a:x:ai_api_key')).toEqual({ kind: 'clear', key: 'ai_api_key' });
    expect(parseAdminCallback('a:test')).toEqual({ kind: 'test' });
  });

  it('rejects anything it did not create', () => {
    expect(parseAdminCallback('s:abc12345:0')).toBeNull();
    expect(parseAdminCallback('a:p:gemini')).toBeNull();
    expect(parseAdminCallback('a:m:-1')).toBeNull();
    expect(parseAdminCallback('a:x:not_a_setting')).toBeNull();
    expect(parseAdminCallback('a:l:fr')).toBeNull();
    expect(parseAdminCallback('a:')).toBeNull();
  });
});
