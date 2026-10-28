/**
 * One place for everything the user sees, in Persian. Keeping the copy here
 * makes the handlers readable and the wording easy to change.
 */
import { faDigits, latinDigits } from './text.js';

export const BOT_NAME = 'Lyricson';

export const WELCOME = `🎵 <b>${BOT_NAME}</b>
متن موزیک + ترجمهٔ خط‌به‌خط، با معنی استعاره‌ها
┄┄┄┄┄┄┄┄┄┄┄┄

فقط یکی از این‌ها رو بفرست 👇

🎼 <b>اسم موزیک</b>  <code>Coldplay Yellow</code>
🔗 <b>لینک</b>  یوتیوب · اسپاتیفای · ساندکلاد · دیزر · اپل موزیک
🎧 <b>فایل موزیک</b> یا 🎬 <b>ویدیو</b> (با کپشن)
📜 <b>خودِ متن</b>  پیست کن

بعد از متن اصلی، دکمهٔ <b>🇮🇷 ترجمهٔ خط‌به‌خط</b> رو بزن.

/help راهنما · /lang زبان ترجمه`;

export const HELP = `📖 <b>راهنما</b>
┄┄┄┄┄┄┄┄┄┄┄┄

<b>چطور کار می‌کنه؟</b>
1. اسم، لینک، فایل یا متن موزیک رو بفرست.
2. اگر مطمئن باشم مستقیم متن رو می‌فرستم؛ وگرنه چند گزینهٔ نزدیک نشونت می‌دم.
3. با دکمهٔ «ترجمهٔ خط‌به‌خط» هر خط رو با ترجمه، مفهوم کلی آهنگ و معنی استعاره‌ها می‌گیری.

<b>برای نتیجهٔ بهتر</b>
• «خواننده + اسم آهنگ» دقیق‌ترین ورودیه.
• لینک خودش اسم و خواننده رو می‌ده.
• فایل موزیک بهتره تگ داشته باشه، وگرنه کپشن بذار.

<b>دستورها</b>
/lang — زبان ترجمه
/help — همین راهنما`;

export const SEARCHING_FOR_LINK = '🔗 دارم اطلاعات لینک رو می‌گیرم…';
export const SEARCHING = '🔎 یه لحظه، دارم متن رو پیدا می‌کنم…';
export const TRANSLATING = '✨ دارم ترجمه می‌کنم؛ چند ثانیه صبر کن…';

export function pastedLyricsNotice(): string {
  return '📜 این متن رو به‌عنوان متن موزیک در نظر گرفتم. اگر دنبال متن یک آهنگ خاصی هستی، اسم یا لینکش رو بفرست.';
}

export function notFound(query: string): string {
  return `😕 برای «${escapeForMessage(query)}» متن موزیکی پیدا نکردم.

چند راه امتحان کن:
• اسم خواننده رو هم بنویس: <code>خواننده + اسم آهنگ</code>
• لینک بفرست (یوتیوب، یوتیوب موزیک، اسپاتیفای، ساندکلاد، دیزر، اپل موزیک)
• یا مستقیم متن موزیک رو پیست کن (چهار خط یا بیشتر)`;
}

export function candidatesHeader(query: string, page: number, pages: number, total: number): string {
  const pageLine = pages > 1 ? ` · صفحهٔ ${faDigits(page)} از ${faDigits(pages)}` : '';
  return `🔎 <b>نتایج «${escapeForMessage(query)}»</b>\n┄┄┄┄┄┄┄┄┄┄┄┄\n${faDigits(total)} مورد${pageLine}\nموزیک مورد نظرت رو انتخاب کن 👇`;
}

export function noLyricsFound(track: { trackName: string; artistName: string }): string {
  return `🎼 متن ثبت‌شده‌ای برای «${escapeForMessage(track.trackName)}» از ${escapeForMessage(track.artistName)} پیدا نشد.\n\nاگر متنش رو داری، پیستش کن تا برات ترجمه کنم.`;
}

export function searchedFailed(): string {
  return '⚠️ الان نتونستم به دیتابیس متن‌ها وصل شم. چند لحظه بعد دوباره امتحان کن.';
}

export function quotaReached(limit: number): string {
  return `🚦 سهمیهٔ امروزت تموم شد (${limit} ترجمه در روز).\nفردا سهمیه دوباره پر می‌شه.`;
}

export const ADMIN_HELP_SECTION = `

<b>🛠 بخش ادمین</b>
/admin — پنل مدیریت: هوش مصنوعی (سرویس، مدل، کلید)، زبان و سهمیه، کش، ادمین‌ها، حالت تعمیر و وبهوک.
فقط آیدی‌های عددیِ ادمین به این بخش دسترسی دارند.`;

export const MAINTENANCE = '🛠 ربات موقتاً در دست تعمیر است؛ کمی بعد دوباره امتحان کن.';

export const CLAIM_USAGE = `🔐 برای ادمین‌شدن، توکن ربات را بعد از دستور بفرست:
<code>/claim 123456:ABC…</code>

(توکن همان است که از @BotFather گرفتی. پیامت بلافاصله پاک می‌شود.)`;

export const CLAIM_INVALID = '⛔️ توکن درست نیست.';

export const CLAIM_PRIVATE_ONLY = 'این دستور را فقط در چت خصوصی با ربات بزن.';

export function claimDone(userId: number): string {
  return `✅ حالا ادمین هستی (آیدی <code>${userId}</code>). برای باز کردن پنل /admin را بزن.`;
}

export function yourId(userId: number): string {
  return `🆔 آیدی عددی تو: <code>${userId}</code>`;
}

export const AI_BASE_URL_MISSING = `🌐 آدرس سرویس هوش مصنوعی تنظیم نشده.

از پنل ادمین (/admin) آدرس را بگذار، یا مقدار <code>AI_BASE_URL</code> را ست کن.`;

export const AI_NOT_CONFIGURED = `🔑 کلید هوش مصنوعی تنظیم نشده.

متن موزیک‌ها رو پیدا می‌کنم، ولی برای ترجمه یک کلید سازگار با OpenAI لازمه:

<code>wrangler secret put AI_API_KEY</code>

بعد از تنظیم، دوباره دکمهٔ ترجمه رو بزن.`;

export function unknownFile(): string {
  return `🤔 از این فایل نتونستم اسم و خواننده رو تشخیص بدم.

اسم موزیک رو به‌صورت متن یا به‌عنوان کپشن همین فایل بفرست — مثلاً:
<code>Coldplay - Yellow</code>`;
}

export function unexpectedError(detail?: string): string {
  const tail = detail ? `\n\n<code>${escapeForMessage(detail)}</code>` : '';
  return `😞 یک مشکل غیرمنتظره پیش آمد. چند لحظه بعد دوباره امتحان کن.${tail}`;
}

export function languageInfo(nativeName: string, enabledLanguages: string): string {
  return `🌍 زبان مقصد فعلی: <b>${escapeForMessage(nativeName)}</b>

${enabledLanguages}

برای اضافه‌کردن زبان‌های دیگر، در فایل <code>src/lib/languages.ts</code> مقدار <code>enabled</code> را true کن.`;
}

export function escapeForMessage(text: string): string {
  return latinDigits(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function partialNotice(missing: number): string {
  return `\n\n<i>⚠️ ${missing} خط ترجمه نشد؛ همون خط‌ها به زبان اصلی مونده.</i>`;
}

export const LYRICS_BUSY = '⏳ سرویس‌های متن الان شلوغ‌اند و جواب ندادند؛ چند ثانیه بعد همین را دوباره بفرست.';

export const STORY_WORKING = '📖 دارم دربارهٔ داستان این موزیک تحقیق می‌کنم (مصاحبه‌ها، مقاله‌ها و بحث‌ها)؛ ممکنه تا 25 ثانیه طول بکشه…';
export const WORDS_WORKING = '🎓 دارم کلمه‌های ارزشمند متن رو انتخاب و مرتب می‌کنم…';
export const ARTIST_WORKING = '👤 دارم دربارهٔ هنرمند تحقیق می‌کنم…';

export const SHARE_MISSING = '😕 این کارت دیگر در دسترس نیست؛ اسم موزیک را دوباره بفرست.';
export const NO_TRANSLATION_YET = '🌐 هنوز ترجمه‌ای برای این موزیک ساخته نشده؛ متن را می‌فرستم و با دکمهٔ «ترجمه» می‌توانی بگیری.';
