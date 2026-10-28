/**
 * The admin panel UI: one render function per screen, the inline keyboards and
 * a strict parser for the `a:` callback namespace.
 */
import { InlineKeyboard } from 'grammy';
import type { AiProvider, Config } from '../env.js';
import { AI_PROVIDERS, AI_PROVIDER_ORDER } from '../env.js';
import { escapeHtml } from './format.js';
import { languageFor, TARGET_LANGUAGES } from './languages.js';
import {
  maskSecret,
  SETTING_KEYS,
  type SettingKey,
  type SettingsSnapshot,
} from './settings.js';
import { faDigits, truncate } from './text.js';

export interface AdminPanel {
  text: string;
  keyboard: InlineKeyboard;
}

export type AdminScreen = 'home' | 'ai' | 'providers' | 'models' | 'defaults' | 'reset' | 'webhook';

export type AdminInputField =
  | 'ai_key'
  | 'ai_base_url'
  | 'ai_model'
  | 'daily_limit'
  | 'public_url';

export type AdminAction =
  | { kind: 'screen'; screen: AdminScreen }
  | { kind: 'input'; field: AdminInputField }
  | { kind: 'setProvider'; provider: AiProvider }
  | { kind: 'setModelIndex'; index: number }
  | { kind: 'setLang'; code: string }
  | { kind: 'clear'; key: SettingKey }
  | { kind: 'test' }
  | { kind: 'stats' }
  | { kind: 'clearCache' }
  | { kind: 'webhookRun' };

export const SETTING_LABELS: Record<SettingKey, string> = {
  ai_provider: 'سرویس هوش مصنوعی',
  ai_api_key: 'کلید API',
  ai_base_url: 'آدرس سرویس',
  ai_model: 'مدل',
  default_target_lang: 'زبان پیش‌فرض',
  daily_limit: 'سهمیهٔ روزانه',
  public_url: 'آدرس عمومی',
};

const SCREEN_CALLBACKS: Record<string, AdminScreen> = {
  home: 'home',
  ai: 'ai',
  prov: 'providers',
  models: 'models',
  def: 'defaults',
  reset: 'reset',
  webhook: 'webhook',
};

const INPUT_CALLBACKS: Record<string, AdminInputField> = {
  key: 'ai_key',
  url: 'ai_base_url',
  model: 'ai_model',
  limit: 'daily_limit',
  hookurl: 'public_url',
};

export function isAdmin(cfg: Config, userId: number | undefined): boolean {
  return typeof userId === 'number' && cfg.adminUserIds.includes(userId);
}

/** Parses `a:…` payloads; returns null for anything we did not create. */
export function parseAdminCallback(data: string): AdminAction | null {
  const [prefix, action, arg] = data.split(':');
  if (prefix !== 'a' || !action) return null;

  const screen = SCREEN_CALLBACKS[action];
  if (screen) return { kind: 'screen', screen };
  const field = INPUT_CALLBACKS[action];
  if (field) return { kind: 'input', field };

  switch (action) {
    case 'test':
      return { kind: 'test' };
    case 'stats':
      return { kind: 'stats' };
    case 'cache':
      return { kind: 'clearCache' };
    case 'hookrun':
      return { kind: 'webhookRun' };
    case 'p': {
      const provider = AI_PROVIDER_ORDER.find((id) => id === arg);
      return provider ? { kind: 'setProvider', provider } : null;
    }
    case 'm': {
      const index = Number.parseInt(arg ?? '', 10);
      return Number.isInteger(index) && index >= 0 ? { kind: 'setModelIndex', index } : null;
    }
    case 'l': {
      const language = TARGET_LANGUAGES.find((entry) => entry.code === arg && entry.enabled);
      return language ? { kind: 'setLang', code: language.code } : null;
    }
    case 'x':
      return arg && (SETTING_KEYS as readonly string[]).includes(arg)
        ? { kind: 'clear', key: arg as SettingKey }
        : null;
    default:
      return null;
  }
}

function sourceTag(snapshot: SettingsSnapshot, key: SettingKey): string {
  return snapshot.fromDb.includes(key) ? ' <i>(از پنل)</i>' : '';
}

function keyLine(snapshot: SettingsSnapshot): string {
  if (!snapshot.ai.apiKey) return '⛔️ تنظیم نشده';
  const source = snapshot.fromDb.includes('ai_api_key') ? 'از پنل' : 'از env';
  return `✅ <code>${escapeHtml(maskSecret(snapshot.ai.apiKey))}</code> <i>(${source})</i>`;
}

function homePanel(snapshot: SettingsSnapshot, cfg: Config): AdminPanel {
  const preset = AI_PROVIDERS[snapshot.ai.provider];
  const language = languageFor(snapshot.defaultTargetLang);
  const lines = [
    '🛠 <b>پنل مدیریت Lyricson</b>',
    `👤 آیدی تو: <code>${escapeHtml(String(cfg.adminUserIds[0] ?? ''))}</code>`,
    '',
    '<b>هوش مصنوعی</b>',
    `• سرویس: <b>${escapeHtml(preset.label)}</b>`,
    `• مدل: <code>${escapeHtml(snapshot.ai.model || '—')}</code>${sourceTag(snapshot, 'ai_model')}`,
    `• کلید: ${keyLine(snapshot)}`,
    `• آدرس: <code>${escapeHtml(snapshot.ai.baseUrl || '—')}</code>`,
    '',
    '<b>پیش‌فرض‌های ربات</b>',
    `• زبان مقصد: <b>${escapeHtml(language.nativeName)}</b>${sourceTag(snapshot, 'default_target_lang')}`,
    `• سهمیهٔ روزانه: <b>${faDigits(snapshot.dailyLimit)}</b> ترجمه برای هر کاربر${sourceTag(snapshot, 'daily_limit')}`,
    '',
    '<i>هر تغییری این‌جا بدهی همان لحظه اعمال می‌شود و بر مقادیر env اولویت دارد؛ با «بازگشت به پیش‌فرض‌های env» می‌توانی هر مقدار را پاک کنی.</i>',
  ];

  const keyboard = new InlineKeyboard()
    .text('🤖 هوش مصنوعی', 'a:ai')
    .text('🌍 پیش‌فرض‌ها', 'a:def')
    .row()
    .text('🔑 کلید API', 'a:key')
    .text('🧠 مدل', 'a:models')
    .row()
    .text('🧪 تست اتصال', 'a:test')
    .text('📊 آمار امروز', 'a:stats')
    .row()
    .text('🔗 وبهوک', 'a:webhook')
    .text('🧹 پاک‌کردن کش', 'a:cache')
    .row()
    .text('♻️ بازگشت به پیش‌فرض‌های env', 'a:reset');

  return { text: lines.join('\n'), keyboard };
}

function aiPanel(snapshot: SettingsSnapshot): AdminPanel {
  const preset = AI_PROVIDERS[snapshot.ai.provider];
  const lines = [
    '🤖 <b>هوش مصنوعی</b>',
    '',
    `• سرویس: <b>${escapeHtml(preset.label)}</b>`,
    `• مدل: <code>${escapeHtml(snapshot.ai.model || '—')}</code>${sourceTag(snapshot, 'ai_model')}`,
    `• کلید: ${keyLine(snapshot)}`,
    `• آدرس: <code>${escapeHtml(snapshot.ai.baseUrl || '—')}</code>`,
    '',
    '<i>OpenRouter با همین آدرس و کلید کار می‌کند. اگر سرویس دیگری داری، آدرس سازگار با OpenAI را بفرست (مثلاً https://host/v1).</i>',
  ];
  const keyboard = new InlineKeyboard()
    .text('🔄 تغییر سرویس', 'a:prov')
    .text('🧠 انتخاب مدل', 'a:models')
    .row()
    .text('🔑 کلید API', 'a:key')
    .text('🌐 آدرس سرویس', 'a:url')
    .row()
    .text('🧪 تست اتصال', 'a:test')
    .row()
    .text('⬅️ پنل', 'a:home');
  return { text: lines.join('\n'), keyboard };
}

function providersPanel(snapshot: SettingsSnapshot): AdminPanel {
  const keyboard = new InlineKeyboard();
  for (const id of AI_PROVIDER_ORDER) {
    const preset = AI_PROVIDERS[id];
    const mark = snapshot.ai.provider === id ? '✅ ' : '';
    keyboard.text(`${mark}${preset.label}`, `a:p:${id}`).row();
  }
  keyboard.text('⬅️ هوش مصنوعی', 'a:ai');
  const text = [
    '🔄 <b>سرویس هوش مصنوعی</b>',
    '',
    'یکی از سرویس‌های زیر را انتخاب کن. با انتخاب OpenRouter، آدرس و یک مدل پیشنهادی هم خودکار تنظیم می‌شود.',
    '',
    '• <b>OpenRouter</b> — یک کلید برای صدها مدل؛ مناسب این کار.',
    '• <b>Freebuff API</b> — پیش‌فرض قبلی؛ کلید از حساب Freebuff.',
    '• <b>سرویس دلخواه</b> — هر endpoint سازگار با OpenAI (آدرس و مدل را خودت می‌دهی).',
  ].join('\n');
  return { text, keyboard };
}

function modelsPanel(snapshot: SettingsSnapshot): AdminPanel {
  const preset = AI_PROVIDERS[snapshot.ai.provider];
  const keyboard = new InlineKeyboard();
  preset.models.forEach((model, index) => {
    const mark = snapshot.ai.model === model ? '✅ ' : '';
    keyboard.text(`${mark}${truncate(model, 42)}`, `a:m:${index}`).row();
  });
  keyboard.text('✍️ مدل دلخواه (تایپ)', 'a:model').row();
  keyboard.text('⬅️ هوش مصنوعی', 'a:ai');

  const text = [
    '🧠 <b>مدل</b>',
    `سرویس: <b>${escapeHtml(preset.label)}</b>`,
    `مدل فعلی: <code>${escapeHtml(snapshot.ai.model || '—')}</code>`,
    '',
    preset.models.length > 0
      ? 'یکی از مدل‌های پیشنهادی را بزن یا شناسهٔ دقیق مدل را خودت بفرست.'
      : 'شناسهٔ مدل را از سرویس خودت بگیر و بفرست (مثلاً <code>vendor/model-name</code>).',
    '<i>برای فهرست کامل مدل‌های OpenRouter: openrouter.ai/models</i>',
  ].join('\n');
  return { text, keyboard };
}

function defaultsPanel(snapshot: SettingsSnapshot): AdminPanel {
  const current = languageFor(snapshot.defaultTargetLang);
  const keyboard = new InlineKeyboard();
  for (const language of TARGET_LANGUAGES.filter((entry) => entry.enabled)) {
    const mark = current.code === language.code ? '✅ ' : '';
    keyboard.text(`${mark}${language.nativeName}`, `a:l:${language.code}`).row();
  }
  keyboard.text(`🔢 سهمیهٔ روزانه (${faDigits(snapshot.dailyLimit)})`, 'a:limit').row();
  keyboard.text('⬅️ پنل', 'a:home');

  const text = [
    '🌍 <b>پیش‌فرض‌های ربات</b>',
    '',
    `• زبان مقصد پیش‌فرض: <b>${escapeHtml(current.nativeName)}</b>${sourceTag(snapshot, 'default_target_lang')}`,
    `• سهمیهٔ روزانهٔ هر کاربر: <b>${faDigits(snapshot.dailyLimit)}</b> ترجمه${sourceTag(snapshot, 'daily_limit')}`,
    '',
    '<i>زبان هر کاربر با /lang قابل تغییر است؛ این مقدار فقط پیش‌فرض است.</i>',
  ].join('\n');
  return { text, keyboard };
}

function resetPanel(snapshot: SettingsSnapshot): AdminPanel {
  const overrides = SETTING_KEYS.filter((key) => snapshot.fromDb.includes(key));
  const keyboard = new InlineKeyboard();
  for (const key of overrides) {
    keyboard.text(`🗑 ${SETTING_LABELS[key]}`, `a:x:${key}`).row();
  }
  keyboard.text('⬅️ پنل', 'a:home');

  const text =
    overrides.length > 0
      ? `♻️ <b>بازگشت به پیش‌فرض‌های env</b>\n\nاین مقادیر الان از پنل می‌آیند و روی env را می‌پوشانند. هر کدام را پاک کنی، مقدار env (یا پیش‌فرض داخلی) برمی‌گردد:\n\n${overrides
          .map((key) => `• ${SETTING_LABELS[key]}`)
          .join('\n')}`
      : '♻️ <b>بازگشت به پیش‌فرض‌های env</b>\n\nهیچ مقداری از پنل ذخیره نشده؛ همه‌چیز از env و پیش‌فرض‌های داخلی می‌آید.';
  return { text, keyboard };
}

function webhookPanel(snapshot: SettingsSnapshot, cfg: Config): AdminPanel {
  const keyboard = new InlineKeyboard()
    .text('📝 تنظیم آدرس عمومی', 'a:hookurl')
    .row()
    .text('🔗 ثبت وبهوک', 'a:hookrun')
    .row()
    .text('⬅️ پنل', 'a:home');

  const text = [
    '🔗 <b>وبهوک تلگرام</b>',
    '',
    `• آدرس عمومی: ${snapshot.publicUrl ? `<code>${escapeHtml(snapshot.publicUrl)}</code>` : '⛔️ تنظیم نشده'}`,
    `• secret وبهوک: ${cfg.webhookSecret ? '✅ تنظیم شده' : '⚠️ خالی (امنیت کمتر)'}`,
    '',
    'آدرس عمومی همان دامنهٔ ورکر است، مثل <code>https://lyricson.example.workers.dev</code>. بعد از تغییر دامنه، یک‌بار «ثبت وبهوک» را بزن.',
  ].join('\n');
  return { text, keyboard };
}

export function renderScreen(
  screen: AdminScreen,
  snapshot: SettingsSnapshot,
  cfg: Config,
): AdminPanel {
  switch (screen) {
    case 'ai':
      return aiPanel(snapshot);
    case 'providers':
      return providersPanel(snapshot);
    case 'models':
      return modelsPanel(snapshot);
    case 'defaults':
      return defaultsPanel(snapshot);
    case 'reset':
      return resetPanel(snapshot);
    case 'webhook':
      return webhookPanel(snapshot, cfg);
    case 'home':
    default:
      return homePanel(snapshot, cfg);
  }
}

export const INPUT_PROMPTS: Record<AdminInputField, string> = {
  ai_key:
    '🔑 کلید API را بفرست.\n\nکلید OpenRouter را از openrouter.ai/keys بگیر. بعد از ذخیره، پیامت پاک می‌شود و خود کلید هیچ‌جا نمایش داده نمی‌شود.',
  ai_base_url:
    '🌐 آدرس سرویس سازگار با OpenAI را بفرست؛ مثلاً:\n<code>https://openrouter.ai/api/v1</code>',
  ai_model:
    '🧠 شناسهٔ دقیق مدل را بفرست؛ مثلاً:\n<code>google/gemini-3.8-flash</code>',
  daily_limit: '🔢 سهمیهٔ روزانهٔ هر کاربر را به عدد بفرست (بین ۱ تا ۱۰۰۰).',
  public_url:
    '📝 آدرس عمومی ورکر را بفرست؛ مثلاً:\n<code>https://lyricson.example.workers.dev</code>',
};
