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
  type SettingKey,
  type SettingsSnapshot,
} from './settings.js';
import { faDigits, truncate } from './text.js';

export interface AdminPanel {
  text: string;
  keyboard: InlineKeyboard;
}

export type AdminScreen =
  | 'home'
  | 'ai'
  | 'providers'
  | 'models'
  | 'defaults'
  | 'reset'
  | 'webhook'
  | 'admins'
  | 'cache'
  | 'spotify';

export type AdminInputField =
  | 'ai_key'
  | 'ai_base_url'
  | 'ai_model'
  | 'daily_limit'
  | 'public_url'
  | 'admin_add'
  | 'spotify_id'
  | 'spotify_secret'
  | 'cache_translation_days'
  | 'cache_lyrics_days';

export type AdminAction =
  | { kind: 'screen'; screen: AdminScreen }
  | { kind: 'input'; field: AdminInputField }
  | { kind: 'setProvider'; provider: AiProvider }
  | { kind: 'setModelIndex'; index: number }
  | { kind: 'setLang'; code: string }
  | { kind: 'clear'; key: SettingKey }
  | { kind: 'test' }
  | { kind: 'diagnose' }
  | { kind: 'stats' }
  | { kind: 'clearCache' }
  | { kind: 'pruneCache' }
  | { kind: 'toggleCache' }
  | { kind: 'toggleMaintenance' }
  | { kind: 'removeAdmin'; id: number }
  | { kind: 'webhookRun' };

export const SETTING_LABELS: Record<SettingKey, string> = {
  ai_provider: 'سرویس هوش مصنوعی',
  ai_api_key: 'کلید API',
  ai_base_url: 'آدرس سرویس',
  ai_model: 'مدل',
  default_target_lang: 'زبان پیش‌فرض',
  daily_limit: 'سهمیهٔ روزانه',
  public_url: 'آدرس عمومی',
  admin_ids: 'ادمین‌ها',
  cache_enabled: 'کش',
  cache_translation_days: 'ماندگاری کش ترجمه',
  cache_lyrics_days: 'ماندگاری کش متن',
  maintenance: 'حالت تعمیر',
  webhook_state: 'وضعیت وبهوک',
  spotify_client_id: 'Spotify Client ID',
  spotify_client_secret: 'Spotify Client Secret',
};

/** Settings the reset screen may clear (admins, maintenance and webhook state have their own controls). */
const RESETTABLE: readonly SettingKey[] = [
  'ai_provider',
  'ai_api_key',
  'ai_base_url',
  'ai_model',
  'default_target_lang',
  'daily_limit',
  'public_url',
  'cache_enabled',
  'cache_translation_days',
  'cache_lyrics_days',
  'spotify_client_id',
  'spotify_client_secret',
];

const SCREEN_CALLBACKS: Record<string, AdminScreen> = {
  home: 'home',
  ai: 'ai',
  prov: 'providers',
  models: 'models',
  def: 'defaults',
  reset: 'reset',
  webhook: 'webhook',
  admins: 'admins',
  cache: 'cache',
  spotify: 'spotify',
};

const INPUT_CALLBACKS: Record<string, AdminInputField> = {
  key: 'ai_key',
  url: 'ai_base_url',
  model: 'ai_model',
  limit: 'daily_limit',
  hookurl: 'public_url',
  addadmin: 'admin_add',
  spid: 'spotify_id',
  spsec: 'spotify_secret',
  ctdays: 'cache_translation_days',
  cldays: 'cache_lyrics_days',
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
    case 'diag':
      return { kind: 'diagnose' };
    case 'stats':
      return { kind: 'stats' };
    case 'cache_clear':
      return { kind: 'clearCache' };
    case 'prune':
      return { kind: 'pruneCache' };
    case 'tc':
      return { kind: 'toggleCache' };
    case 'tm':
      return { kind: 'toggleMaintenance' };
    case 'rm': {
      const id = Number.parseInt(arg ?? '', 10);
      return Number.isSafeInteger(id) && id > 0 ? { kind: 'removeAdmin', id } : null;
    }
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
      return arg && (RESETTABLE as readonly string[]).includes(arg)
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
    `👮 ادمین‌ها: ${faDigits(snapshot.adminIds.length)} نفر`,
    snapshot.maintenance ? '⏸ <b>حالت تعمیر روشن است</b> — کاربران عادی پاسخی نمی‌گیرند.' : '',
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
    `• کش: ${snapshot.cache.enabled ? '✅ روشن' : '⛔️ خاموش'}`,
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
    .text('🩺 تشخیص مشکل', 'a:diag')
    .row()
    .text('💾 کش', 'a:cache')
    .text('👮 ادمین‌ها', 'a:admins')
    .row()
    .text('🎧 اسپاتیفای', 'a:spotify')
    .text('🔗 وبهوک', 'a:webhook')
    .row()
    .text(snapshot.maintenance ? '▶️ پایان حالت تعمیر' : '⏸ حالت تعمیر', 'a:tm')
    .row()
    .text('♻️ بازگشت به پیش‌فرض‌های env', 'a:reset');

  return { text: lines.filter((line, index) => line !== '' || lines[index - 1] !== '').join('\n'), keyboard };
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
  const overrides = RESETTABLE.filter((key) => snapshot.fromDb.includes(key));
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
    `• secret وبهوک: ${cfg.webhookSecret ? '✅ از env' : '✅ خودکار (از توکن ربات)'}`,
    '',
    'آدرس عمومی همان دامنهٔ ورکر است، مثل <code>https://lyricson.example.workers.dev</code>. بعد از تغییر دامنه، یک‌بار «ثبت وبهوک» را بزن.',
  ].join('\n');
  return { text, keyboard };
}

function adminsPanel(snapshot: SettingsSnapshot, cfg: Config): AdminPanel {
  const keyboard = new InlineKeyboard();
  for (const id of snapshot.storedAdminIds) keyboard.text(`🗑 ${id}`, `a:rm:${id}`).row();
  keyboard.text('➕ افزودن ادمین (آیدی عددی)', 'a:addadmin').row();
  keyboard.text('⬅️ پنل', 'a:home');

  const envLines = cfg.envAdminIds.map((id) => `• <code>${id}</code> <i>(از env؛ از اینجا حذف نمی‌شود)</i>`);
  const storedLines = snapshot.storedAdminIds.map((id) => `• <code>${id}</code>`);
  const all = [...envLines, ...storedLines];
  const text = [
    '👮 <b>ادمین‌ها</b>',
    '',
    all.length > 0 ? all.join('\n') : '⛔️ هنوز ادمینی ثبت نشده.',
    '',
    '<b>راه‌های اضافه‌کردن آیدی عددی:</b>',
    '۱) همین‌جا «افزودن ادمین» و فرستادن آیدی عددی (آیدی را کاربر با /id در ربات می‌بیند یا از @userinfobot می‌گیرد).',
    '۲) خودِ شخص در چت خصوصی بنویسد <code>/claim &lt;توکن ربات&gt;</code>.',
    '۳) متغیر <code>ADMIN_USER_ID</code> (چند آیدی با کاما).',
    '',
    '<i>برای دکمهٔ 🗑 روی آیدی بزن تا ادمین حذف شود.</i>',
  ].join('\n');
  return { text, keyboard };
}

/** 0 days means the entry never expires. */
function days(value: number): string {
  return value > 0 ? `${faDigits(value)} روز` : 'بی‌نهایت';
}

function spotifyPanel(snapshot: SettingsSnapshot): AdminPanel {
  const keyboard = new InlineKeyboard()
    .text('🆔 Client ID', 'a:spid')
    .text('🔑 Client Secret', 'a:spsec')
    .row()
    .text('⬅️ پنل', 'a:home');
  const text = [
    '🎧 <b>اسپاتیفای (اختیاری)</b>',
    '',
    `• وضعیت: ${snapshot.spotify ? '✅ تنظیم شده' : '⛔️ تنظیم نشده'}`,
    '',
    'با این دو مقدار، اسم موزیک در پیام به لینک اسپاتیفای وصل می‌شود. بدون آن لینک Deezer استفاده می‌شود.',
    'از developer.spotify.com ← Dashboard ← Create app (رایگان) ← Client ID و Client Secret را بگیر.',
  ].join('\n');
  return { text, keyboard };
}

function cachePanel(snapshot: SettingsSnapshot): AdminPanel {
  const keyboard = new InlineKeyboard()
    .text(snapshot.cache.enabled ? '⛔️ خاموش‌کردن کش' : '✅ روشن‌کردن کش', 'a:tc')
    .row()
    .text(`⏳ ماندگاری ترجمه (${days(snapshot.cache.translationDays)})`, 'a:ctdays')
    .row()
    .text(`⏳ ماندگاری متن (${days(snapshot.cache.lyricsDays)})`, 'a:cldays')
    .row()
    .text('🧹 حذف منقضی‌ها', 'a:prune')
    .text('🗑 پاک‌کردن همه', 'a:cache_clear')
    .row()
    .text('⬅️ پنل', 'a:home');
  const text = [
    '💾 <b>کش</b>',
    '',
    `• وضعیت: ${snapshot.cache.enabled ? '✅ روشن' : '⛔️ خاموش'}`,
    `• ترجمه‌ها: ${days(snapshot.cache.translationDays)}${sourceTag(snapshot, 'cache_translation_days')}`,
    `• متن آهنگ‌ها: ${days(snapshot.cache.lyricsDays)}${sourceTag(snapshot, 'cache_lyrics_days')}`,
    '',
    'نتیجهٔ جست‌وجو، متن آهنگ و ترجمه‌های تمام‌شده در دیتابیس D1 ذخیره می‌شوند؛ تپ دوباره روی دکمهٔ ترجمه بدون هزینهٔ AI و بدون مصرف سهمیه جواب می‌دهد. کلید ترجمه شامل مدل، زبان و خودِ متن است، پس با عوض‌کردن مدل ترجمهٔ تازه ساخته می‌شود. پیش‌فرض بی‌نهایت است: چیزی خودکار پاک نمی‌شود. اگر عدد روز بدهی (یا ۰ برای بی‌نهایت)، ردیف‌های منقضی هر ۱۰ دقیقه پاک می‌شوند.',
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
    case 'admins':
      return adminsPanel(snapshot, cfg);
    case 'cache':
      return cachePanel(snapshot);
    case 'spotify':
      return spotifyPanel(snapshot);
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
  admin_add: '👮 آیدی عددی تلگرام شخص را بفرست (فقط رقم؛ مثلاً <code>123456789</code>).',
  cache_translation_days: '⏳ ماندگاری کش ترجمه را به روز بفرست (۱ تا ۳۶۵)، یا ۰ برای بی‌نهایت.',
  cache_lyrics_days: '⏳ ماندگاری کش متن آهنگ را به روز بفرست (۱ تا ۳۶۵)، یا ۰ برای بی‌نهایت.',
  spotify_id: '🆔 Spotify Client ID را بفرست.',
  spotify_secret: '🔑 Spotify Client Secret را بفرست؛ بعد از ذخیره پیامت پاک می‌شود.',
  public_url:
    '📝 آدرس عمومی ورکر را بفرست؛ مثلاً:\n<code>https://lyricson.example.workers.dev</code>',
};
