/**
 * Self-contained HTML pages: the status page at "/" and the result page of
 * /admin/setup. No external assets, RTL, dark theme.
 */

export interface StatusItem {
  label: string;
  hint: string;
  ok: boolean;
  required: boolean;
}

export interface LandingInfo {
  checks: StatusItem[];
  model: string;
  baseUrl: string;
  dailyLimit: number;
  databaseReady: boolean;
  databaseError?: string;
  botUsername?: string;
}

function escapeHtml(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const STYLES = `
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body {
    margin: 0; padding: 40px 20px 64px;
    background: #0b0d14;
    color: #e8ebf5;
    font-family: system-ui, -apple-system, 'Segoe UI', Tahoma, sans-serif;
    line-height: 1.88;
  }
  .wrap { max-width: 760px; margin: 0 auto; }
  header { display: flex; align-items: center; gap: 14px; margin-bottom: 6px; }
  .logo { font-size: 34px; }
  h1 { font-size: 30px; margin: 0; letter-spacing: -0.5px; }
  .tagline { color: #9aa3bd; margin: 0 0 26px; font-size: 15px; }
  .card {
    background: #141826; border: 1px solid #232a3d; border-radius: 16px;
    padding: 20px 22px; margin-bottom: 18px;
  }
  .card h2 { font-size: 16px; margin: 0 0 14px; color: #cfd6ea; }
  ul { margin: 0; padding-inline-start: 20px; }
  li { margin: 6px 0; }
  code {
    background: #0d1120; border: 1px solid #262e44; border-radius: 7px;
    padding: 2px 7px; font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 13px; direction: ltr; display: inline-block;
  }
  .chip {
    display: inline-flex; align-items: center; gap: 8px; margin: 0 6px 8px 0;
    padding: 6px 12px; border-radius: 999px; font-size: 13px;
    background: #10172a; border: 1px solid #26304a;
  }
  .chip.ok { border-color: #1f6b4a; background: #0f2419; color: #8ff0bb; }
  .chip.missing { border-color: #6b3030; background: #2a1416; color: #ffb3b3; }
  .hint { color: #8b94ad; font-size: 13px; }
  .grid { display: grid; gap: 10px; }
  .flow { counter-reset: step; }
  .flow li { margin: 10px 0; }
  footer { color: #6f7894; font-size: 13px; margin-top: 26px; text-align: center; }
  a { color: #8fb4ff; }
  .mono { direction: ltr; text-align: left; }
`;

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="robots" content="noindex, nofollow" />
<title>${escapeHtml(title)}</title>
<style>${STYLES}</style>
</head>
<body><div class="wrap">${body}</div></body>
</html>`;
}

export function landingPage(info: LandingInfo): string {
  const chips = info.checks
    .map((check) => {
      const state = check.ok ? 'ok' : 'missing';
      const mark = check.ok ? '✅' : check.required ? '⛔️' : '⚠️';
      return `<span class="chip ${state}">${mark} <code>${escapeHtml(check.label)}</code></span>`;
    })
    .join('');

  const missingRequired = info.checks.filter((check) => check.required && !check.ok);
  const todos = missingRequired
    .map((check) => `<li><code>${escapeHtml(check.label)}</code> — ${escapeHtml(check.hint)}</li>`)
    .join('');

  const ready = missingRequired.length === 0;

  return page(
    'Lyricson',
    `<header><span class="logo">🎵</span><h1>Lyricson</h1></header>
<p class="tagline">ربات تلگرام ترجمهٔ هوشمند متن موزیک — خط‌به‌خط، با معنی واقعی استعاره‌ها.</p>

<div class="card">
  <h2>وضعیت راه‌اندازی</h2>
  <div>${chips}</div>
  ${
    info.databaseReady
      ? '<p class="hint">دیتابیس D1 در دسترس است و جدول‌ها آماده‌اند.</p>'
      : `<p class="hint">اتصال به D1 برقرار نشد${info.databaseError ? `: <code>${escapeHtml(info.databaseError)}</code>` : ''}</p>`
  }
  <p class="hint">مدل فعال: <code>${escapeHtml(info.model)}</code> · سهمیهٔ روزانه: <code>${escapeHtml(String(info.dailyLimit))}</code> ترجمه به‌ازای هر کاربر</p>
</div>

${
  ready
    ? `<div class="card">
         <h2>ثبت وب‌هوک (یک‌بار برای همیشه)</h2>
         <p>این آدرس را در مرورگر باز کن تا دامنهٔ فعلی به‌عنوان وب‌هوک ربات ثبت شود:</p>
         <p><code>${escapeHtml('/admin/setup?key=ADMIN_SECRET')}</code></p>
         <p class="hint">جای <code>ADMIN_SECRET</code> همون مقداری رو بگذار که ست کردی.</p>
         ${info.botUsername ? `<p>بعد از ثبت، برو سراغ ربات: <a href="https://t.me/${escapeHtml(info.botUsername)}">@${escapeHtml(info.botUsername)}</a></p>` : ''}
       </div>`
    : `<div class="card">
         <h2>برای فعال‌شدن این دو کار مانده</h2>
         <ol>${todos}</ol>
         <p class="hint">تنظیم secretها: <code>npx wrangler secret put NAME</code> · ساخت دیتابیس: <code>npx wrangler d1 create lyricson</code></p>
       </div>`
}

<div class="card">
  <h2>ربات چطور کار می‌کند</h2>
  <ol class="flow">
    <li>ورودی: اسم موزیک، لینک (یوتیوب، اسپاتیفای، ساندکلاد، دیزر، اپل موزیک، بندکمپ)، فایل موزیک، موزیک‌ویدیو با کپشن، یا خودِ متن.</li>
    <li>اول لیست موزیک‌های نزدیک با دکمه‌های شیشه‌ای؛ اگر تطبیق دقیق باشد مستقیم می‌رود سراغ متن.</li>
    <li><b>متن اصلی</b> فرستاده می‌شود، همراه دکمهٔ «🇮🇷 ترجمهٔ خط‌به‌خط».</li>
    <li>ترجمهٔ فارسی خط‌به‌خط با توجه به مفهوم کلی آهنگ، و هرجا لازم باشد معنی واقعی داخل پرانتز.</li>
  </ol>
</div>

<footer>
  متن‌ها از <span class="mono">LRCLIB</span> · ترجمه با <span class="mono">${escapeHtml(info.baseUrl)}</span>
</footer>`,
  );
}

export interface SetupResult {
  ok: boolean;
  title: string;
  lines: string[];
  botUsername?: string;
  warnings?: string[];
}

export function setupResultPage(result: SetupResult): string {
  const color = result.ok ? 'ok' : 'missing';
  const items = result.lines.map((line) => `<li>${line}</li>`).join('');
  const warnings = (result.warnings ?? []).map((warning) => `<li>${warning}</li>`).join('');
  const botLink =
    result.ok && result.botUsername
      ? `<p>برو داخل تلگرام و امتحان کن: <a href="https://t.me/${escapeHtml(result.botUsername)}">@${escapeHtml(result.botUsername)}</a></p>`
      : '';

  return page(
    result.title,
    `<header><span class="logo">🎵</span><h1>Lyricson</h1></header>
<p class="tagline"><span class="chip ${color}">${result.ok ? '✅ انجام شد' : '⛔️ انجام نشد'}</span> ${escapeHtml(result.title)}</p>
<div class="card"><h2>نتیجه</h2><ul>${items}</ul>${warnings ? `<h2 style="margin-top:18px">هشدارها</h2><ul>${warnings}</ul>` : ''}${botLink}</div>
<p><a href="/">بازگشت به صفحهٔ وضعیت</a></p>`,
  );
}
