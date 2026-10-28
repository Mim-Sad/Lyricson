# Lyricson 🎵

A Telegram bot that finds song lyrics and translates them line by line with an LLM that explains the hidden meaning
of metaphors and double entendres. It runs entirely on **Cloudflare Workers + D1**: no server, no queue, no extra
services to babysit.

Send it anything that identifies a song — a title, a link, an audio file, a video with a caption, or the pasted lyrics —
and it replies within a second with a status message, then edits that message into the result.

```
🎧 Track:  Yellow
👤 Artist: Coldplay
💽 Album:  Parachutes
📅 Date:   2000-07-10
┄┄┄┄┄┄┄┄┄┄┄┄
Look at the stars
Look how they shine for you
…
┄┄┄┄┄┄┄┄┄┄┄┄
📚 Source: LRCLIB
[ 🇮🇷 Line-by-line translation ]
[ 🖼 Music card ] [ 📖 Story ]
[ 🎓 Key words  ] [ 👤 About the artist ]
```

---

## Contents

- [Features](#features)
- [Quick start (Cloudflare)](#quick-start-cloudflare)
- [Configuration](#configuration)
- [Admin panel](#admin-panel)
- [How it works](#how-it-works)
- [Caching](#caching)
- [Reliability and error handling](#reliability-and-error-handling)
- [Data sources and legal notes](#data-sources-and-legal-notes)
- [Development](#development)
- [Project layout](#project-layout)
- [Troubleshooting](#troubleshooting)

---

## Features

**Input**
- Song title (`Coldplay Yellow`), links (YouTube, YouTube Music, Spotify, SoundCloud, Deezer, Apple Music, Bandcamp),
  audio files (caption → Telegram metadata → file name → **ID3 tags** read from the file), videos with a caption,
  or pasted lyrics.
- Free-text queries are resolved to a clean *artist + title* through Deezer before the lyrics lookup, which makes
  exact lookups hit far more often.

**Output**
- A status message right away, replaced in place by the result.
- A 30-second **audio preview** with correct title, artist, album, cover (ID3 v2.3 tag + Telegram thumbnail).
- A clean identity block (Track / Artist / Album / Date). The title links to Spotify (optional credentials) or Deezer.
- **Line-by-line translation** (Persian today; the pipeline is language-agnostic) with the overall theme and mood,
  and the real meaning of metaphors in parentheses only where it matters.
- Buttons under the lyrics:
  - **🖼 Music card** – cover + identity block in English, with deep links that open the lyrics or the translation
    inside the bot (`t.me/<bot>?start=l_<id>` / `t_<id>`).
  - **📖 Story** – background of the song: writing, interviews, reception, fan interpretations. Uses OpenRouter's web
    search plugin when available and lists its sources.
  - **🎓 Key words** – up to 10 words from the lyrics, hardest to easiest, with IPA, meaning, synonyms, antonyms and usage.
  - **👤 About the artist** – a photo album (portrait + album covers) with a biography caption, then the full biography.
    Falls back to Wikipedia/Deezer facts if the model fails, so the user always gets an answer.
- Every feature answer replies to the message that holds the buttons, and failures offer a **🔄 Retry** button.

**Operations**
- Zero-config deploy: D1 database, webhook registration, webhook secret and admin claim are all automatic.
- An in-bot **admin panel** controls everything at runtime (see below), including announcements to all users.
- Unlimited cache by default; per-user daily quota to cap AI spend.

---

## Quick start (Cloudflare)

Prerequisites: a Cloudflare account, a GitHub account, and a bot token from [@BotFather](https://t.me/BotFather).

1. **Connect the repository.** Cloudflare dashboard → *Workers & Pages* → *Create* → *Import a repository* → pick this repo.
   The default deploy command (`npx wrangler deploy`) is correct.
2. **Add the bot token.** Worker → *Settings* → *Variables and Secrets* → add the secret `TELEGRAM_BOT_TOKEN`.
3. **Open the Worker URL once** (`https://lyricson.<your-subdomain>.workers.dev`). The first visit registers the Telegram
   webhook and the bot commands for that origin. A cron trigger re-registers it every 10 minutes if it ever drifts.
   The webhook secret is derived from the bot token, so nothing else needs configuring.
4. **Become the admin.** In a private chat with the bot send `/claim <bot token>`. Your message is deleted immediately
   and your numeric id is stored as an admin. Then send `/admin`.
5. **Add the AI key.** `/admin` → *🤖 AI* → *🔑 API key* and paste your [OpenRouter](https://openrouter.ai/keys) key.

Alternatively use the CLI: `npm install && npx wrangler secret put TELEGRAM_BOT_TOKEN && npm run deploy`.

### Builds on pull requests

Workers Builds only builds the production branch (`main`) by default. To also build pull requests and branches, open the
Worker → *Settings* → *Builds* → *Branch control* and enable **Preview builds**. Previews do not inherit production
secrets; do **not** give a Preview the bot token (opening a Preview URL would re-register the webhook to it).

GitHub Actions (`.github/workflows/ci.yml`) additionally runs the type check, the unit tests and a `wrangler deploy
--dry-run` on every pull request and push to `main`.

---

## Configuration

Everything can be set from the admin panel; environment variables are the fallback.
**Precedence: admin panel (stored in D1) > environment variable > built-in default.**

| Variable | Required | Default | Description |
| --- | --- | --- | --- |
| `TELEGRAM_BOT_TOKEN` | ✅ | – | Bot token from BotFather. The only value that cannot be changed from the panel. |
| `DB` | ✅ | – | D1 binding (created automatically on first deploy). |
| `AI_API_KEY` | | – | API key of an OpenAI-compatible service (OpenRouter by default). |
| `AI_PROVIDER` | | `openrouter` | `openrouter`, `freebuff` or `custom`. |
| `AI_BASE_URL` | | `https://openrouter.ai/api/v1` | Any OpenAI-compatible endpoint. |
| `AI_MODEL` | | `google/gemini-3.8-flash` | Model id (`vendor/model` on OpenRouter). |
| `ADMIN_USER_ID` | | – | Numeric Telegram id(s), comma separated. Alternative to `/claim`. |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | | – | Makes the title link to Spotify instead of Deezer. |
| `PUBLIC_URL` | | auto | Public origin of the Worker; detected from the first visit. |
| `TELEGRAM_WEBHOOK_SECRET` | | derived | Defaults to a value derived from the bot token. |
| `ADMIN_SECRET` | | – | Only for the manual `/admin/setup?key=…` page. |
| `DEFAULT_TARGET_LANG` | | `fa` | Default translation language. |
| `DAILY_TRANSLATION_LIMIT` | | `40` | Per-user daily quota for AI features. |
| `TELEGRAM_API_ROOT` | | `https://api.telegram.org` | Only for tests/proxies. |

For local development copy `.dev.vars.example` to `.dev.vars`.

---

## Admin panel

`/admin` (visible only in the admins' own chats; everyone else gets no reply).

| Button | What it does |
| --- | --- |
| 🤖 AI | Provider (OpenRouter / Freebuff / custom), model, endpoint, API key (the message with the key is deleted, only a masked form is shown), connection test |
| 🌍 Defaults | Default language and daily quota |
| 💾 Cache | On/off, lifetime of translations and lyrics (days, `0` = forever), prune expired, clear all |
| 👮 Admins | List, add by numeric id, remove (ids from `ADMIN_USER_ID` are read-only) |
| 📣 Announcements | Write an HTML message, send a test to yourself, broadcast to every user who started the bot (time-boxed rounds, resumable, blocked users are skipped) |
| 🎧 Spotify | Client id/secret for Spotify links |
| ⏸ Maintenance | Regular users get a "back soon" message while admins keep working |
| 🔗 Webhook | Public URL, re-register webhook and commands, last Telegram error and pending count |
| 🩺 Diagnostics | Live check of Telegram, webhook, LRCLIB, lyrics.ovh and the AI provider with real status codes |
| 📊 Stats | Today's translations and active users, cache sizes |
| ♻️ Reset | Remove any stored override so the environment value applies again |

Ways to become an admin: `/claim <bot token>` in a private chat, `ADMIN_USER_ID`, or *Admins → Add* in the panel.
Users can see their own numeric id with `/id` (the command is intentionally not listed in the menu).

---

## How it works

```
input ─► identify ─► resolve (Deezer) ─► lyrics (LRCLIB ∥ lyrics.ovh → Lyrist)
          │                                    │
          │                                    ▼
          │                      exact match? ─ yes ─► audio preview + lyrics + buttons
          │                          │ no
          │                          ▼
          │                  candidate list (paged) ─► choose ─┘
          └─ pasted lyrics ───────────────────────────────────────┘

button ─► cache hit? ─ yes ─► render
              │ no
              ▼
          quota ─► LLM (JSON) ─► parse/repair ─► store JSON ─► render
```

**Structured data first, styling last.** Every AI answer is requested as JSON, parsed defensively (code fences,
truncated output and stray prose are handled) and stored **as data**: translations, stories, vocabulary and artist
biographies are plain objects in D1. Telegram formatting happens in one rendering layer (`format.ts`, `cards.ts`) at
send time, with HTML escaping in a single place, pagination that never cuts a block in half, and a plain-text
fallback if Telegram rejects the markup. Changing the look of a message never requires regenerating anything.

**Speed.** The webhook handler answers Telegram immediately and keeps working in the background; the first
user-visible reply is a status message that is later edited in place. LRCLIB and the backup sources race: whichever
returns lyrics first wins.

```
src/
├─ index.ts            Hono router: webhook, status page, /health, public pages, cron
├─ bot.ts              grammY handlers: input routing, search, lyrics, translation
├─ extras.ts           audio preview, music card, story / words / artist panels, safe sending
├─ admin.ts            admin panel handlers
├─ env.ts              bindings, provider presets, derived config
├─ ui/                 status page and public lyrics pages
└─ lib/
   ├─ lyrics.ts        LRCLIB client, racing search, error accounting
   ├─ fallback-lyrics.ts  lyrics.ovh and Lyrist
   ├─ music.ts         Deezer / Spotify / Wikipedia, ID3 writer, canonical query resolution
   ├─ ai.ts            OpenAI-compatible client, JSON extraction and repair, chunked translation
   ├─ insights.ts      story, vocabulary and artist prompts + parsing
   ├─ format.ts        rendering layer: identity block, pagination, keyboards
   ├─ cards.ts         renderers for the extra panels
   ├─ store.ts         D1 schema (created lazily), sessions, caches, quota, users, shares
   ├─ settings.ts      runtime settings with env fallback
   ├─ admin-panel.ts   panel screens and callback parser
   └─ …                text normalisation, ID3 reader, link resolver, messages
```

---

## Caching

Everything that is expensive or rate-limited is cached in D1 and **never expires by default**:

| What | Key | Notes |
| --- | --- | --- |
| Lyrics search results and tracks | normalised query / track id | negative results are not cached |
| Canonical artist + title for a query | normalised query | misses are remembered for 1 day |
| Deezer/Spotify metadata, cover, links | artist + title | misses are remembered for 1 day |
| Artist info (photos, albums, Wikipedia) | artist | |
| Translations | provider + model + language + lyrics | switching the model produces a fresh translation |
| Story, vocabulary, artist biography | track / artist | the fallback bio (no AI) is **not** cached |
| Audio preview | Deezer track id → Telegram `file_id` | resent instantly |
| Button sessions | random id | 30 days |

Admins can switch the cache off, set a lifetime in days (`0` = forever), prune expired rows or clear everything.
The 10-minute cron removes expired rows only when a finite lifetime is configured.

---

## Reliability and error handling

- **Lyrics:** LRCLIB (with retry on 429/5xx and a one-minute cool-down) races lyrics.ovh, then Lyrist. The bot says
  "services are busy" **only** when every source was unreachable; a genuine miss gets search tips instead. The busy
  message has a Retry button.
- **AI calls:** up to three request shapes per call (web search plugin → `response_format: json_object` → plain),
  a shared time budget that fits Cloudflare's background-work limit, JSON extraction with truncation repair, and
  cleanup of markdown, links, citations and non-Latin digits. Failed calls refund the user's quota and show a Retry button.
- **Telegram:** markup rejected by Telegram is resent as plain text; photo groups fall back to a single photo, then to text.
- **Partial answers beat errors:** the artist panel works from Wikipedia/Deezer data when the model fails or returns
  nothing, and a missing photo never blocks the biography.
- **Webhook:** protected by a secret derived from the bot token; the handler holds the response for up to 20 s so
  slow AI calls have ~50 s of total budget.

---

## Data sources and legal notes

| Purpose | Service | Key needed |
| --- | --- | --- |
| Lyrics | [LRCLIB](https://lrclib.net), lyrics.ovh, Lyrist | no |
| Metadata, covers, artist photos, 30 s previews | [Deezer API](https://developers.deezer.com) | no |
| Artist summaries and portraits | Wikipedia REST API | no |
| Spotify links (optional) | Spotify Web API (client credentials) | yes (free) |
| Translation, story, vocabulary, biography | any OpenAI-compatible LLM (OpenRouter by default) | yes |

The bot sends **30-second previews** that Deezer publishes for exactly this purpose. It does not download or
redistribute full tracks. Lyrics are copyrighted by their owners; the bot fetches them from public APIs on demand
and the translation features are intended for personal study. The public `/l/<id>` and `/t/<id>` pages are marked
`noindex` but are reachable by anyone who has the link.

---

## Development

```bash
npm install
npm run typecheck     # tsc --noEmit
npm test              # vitest
npm run dev           # wrangler dev on :8787
npx wrangler deploy --dry-run --outdir=dist   # what CI runs
```

Test without Telegram or AI credit: `scripts/mock-telegram.mjs` fakes the Bot API and an OpenAI-compatible endpoint.

```bash
node scripts/mock-telegram.mjs            # port 8790
# .dev.vars: TELEGRAM_BOT_TOKEN=123:test  TELEGRAM_API_ROOT=http://127.0.0.1:8790
#            AI_BASE_URL=http://127.0.0.1:8790/v1  AI_API_KEY=test  ADMIN_USER_ID=5
npm run dev
curl -s localhost:8787/health            # also registers the webhook against the mock
curl -s localhost:8790/_messages         # what the bot sent
```

Database tables are created lazily on first use; `migrations/0001_init.sql` contains the same DDL if you prefer to
apply it by hand (`npm run db:migrate:remote`).

---

## Troubleshooting

| Symptom | Likely cause and fix |
| --- | --- |
| Bot does not answer | Open the Worker URL once (registers the webhook), then check `/health`. |
| `403` on the webhook | The token or `TELEGRAM_WEBHOOK_SECRET` changed. Open the Worker URL again or use *Admin → Webhook → Register*. |
| `/admin` is silent | You are not an admin yet: `/claim <bot token>` in a private chat, or set `ADMIN_USER_ID` (numeric id, not a username). |
| "AI key not configured" | *Admin → AI → API key*, or `AI_API_KEY`. |
| Song not found | Run *Admin → Diagnostics*. If LRCLIB shows `429`, the backup sources take over; paste the lyrics as a last resort. |
| A deploy never shows up | Worker → *Deployments* → *View build history*. Enable **Preview builds** under *Settings → Builds → Branch control* to build PRs. |
| Telegram rejects a message | The bot automatically resends it as plain text; check the Worker logs for `settle` entries. |

---

## Credits

Lyrics from [LRCLIB](https://lrclib.net) · metadata from [Deezer](https://developers.deezer.com) and Wikipedia ·
bot framework [grammY](https://grammy.dev) · web framework [Hono](https://hono.dev) · hosting Cloudflare Workers and D1.

MIT © Lyricson
