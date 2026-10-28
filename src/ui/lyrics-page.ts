/** Public lyrics pages linked from the music card: original text, optionally with the translation. */
import type { Translation } from '../lib/prompt.js';
import type { TrackSummary } from '../lib/types.js';

function esc(input: string): string {
  return input.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const STYLES = `
  :root { color-scheme: dark light; --bg:#0b0d14; --card:#141826; --line:#232a3d; --text:#e8ebf5; --mute:#9aa3bd; --accent:#7aa2ff; }
  @media (prefers-color-scheme: light) { :root { --bg:#f5f6fa; --card:#fff; --line:#e3e6ef; --text:#1b2033; --mute:#6a738c; --accent:#2f5bd8; } }
  * { box-sizing: border-box; }
  body { margin:0; padding:32px 16px 64px; background:var(--bg); color:var(--text);
    font-family: system-ui,-apple-system,'Segoe UI',Tahoma,sans-serif; line-height:1.9; }
  .wrap { max-width: 720px; margin: 0 auto; }
  header { margin-bottom: 18px; }
  h1 { font-size: 26px; margin: 0 0 4px; }
  .meta { color: var(--mute); font-size: 14px; }
  nav { display:flex; gap:8px; margin: 14px 0 20px; flex-wrap: wrap; }
  nav a { padding:6px 14px; border-radius:999px; border:1px solid var(--line); color:var(--text); text-decoration:none; font-size:14px; }
  nav a.on { background: var(--accent); border-color: var(--accent); color:#fff; }
  .card { background:var(--card); border:1px solid var(--line); border-radius:16px; padding:18px 20px; }
  .line { margin: 0 0 14px; }
  .src { direction:ltr; text-align:left; color: var(--mute); font-size: 15px; border-inline-start:3px solid var(--accent); padding-inline-start:10px; }
  .fa { font-size: 17px; }
  .note { color: var(--mute); font-size: 14px; }
  pre { white-space: pre-wrap; font: inherit; margin: 0; direction: ltr; text-align: left; }
  .info { background: var(--card); border:1px solid var(--line); border-radius:12px; padding:10px 14px; color:var(--mute); margin-bottom:14px; font-size:14px; }
  footer { margin-top: 28px; color: var(--mute); font-size: 13px; text-align:center; }
`;

export function lyricsPage(args: {
  track: TrackSummary;
  translation?: Translation;
  mode: 'lyrics' | 'translation';
  id: string;
  languageName?: string;
}): string {
  const { track, translation, mode, id } = args;
  const meta = [track.artistName, track.albumName].filter(Boolean).map((part) => esc(part as string)).join(' · ');

  let body: string;
  let info = '';
  if (mode === 'translation' && translation) {
    body = translation.lines
      .map(
        (line) =>
          `<p class="line"><span class="src">${esc(line.source)}</span><br><span class="fa">${esc(line.text)}</span>${
            line.note ? ` <span class="note">(${esc(line.note)})</span>` : ''
          }</p>`,
      )
      .join('\n');
    const bits = [translation.theme ? `🧠 ${esc(translation.theme)}` : '', translation.mood ? `💫 ${esc(translation.mood)}` : ''].filter(Boolean);
    if (bits.length > 0) info = `<div class="info">${bits.join(' &nbsp;·&nbsp; ')}</div>`;
  } else {
    body = `<pre>${esc(track.lyrics ?? '')}</pre>`;
    if (mode === 'translation') {
      info = '<div class="info">ترجمه هنوز ساخته نشده؛ در ربات دکمهٔ «ترجمهٔ خط‌به‌خط» را بزن و این صفحه را دوباره باز کن.</div>';
    }
  }

  return `<!doctype html>
<html lang="fa" dir="rtl">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex,nofollow">
<title>${esc(track.trackName)} — ${esc(track.artistName)}</title>
<style>${STYLES}</style>
</head>
<body>
<div class="wrap">
  <header>
    <h1>🎵 ${esc(track.trackName)}</h1>
    <div class="meta">${meta}</div>
  </header>
  <nav>
    <a href="/l/${esc(id)}" class="${mode === 'lyrics' ? 'on' : ''}">متن اصلی</a>
    <a href="/t/${esc(id)}" class="${mode === 'translation' ? 'on' : ''}">متن + ترجمه</a>
  </nav>
  ${info}
  <div class="card">${body}</div>
  <footer>Lyricson</footer>
</div>
</body>
</html>`;
}
