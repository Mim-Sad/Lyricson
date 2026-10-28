/**
 * Local test double for the Telegram Bot API and an OpenAI-compatible endpoint.
 *
 * It lets you exercise the whole bot with `wrangler dev`, without a real bot
 * token, an account or any AI credit:
 *
 *   1) node scripts/mock-telegram.mjs            (port 8790, logs to stdout)
 *   2) npm run dev  -- --var TELEGRAM_API_ROOT:http://127.0.0.1:8790 \
 *                     --var AI_BASE_URL:http://127.0.0.1:8790/v1 \
 *                     --var AI_API_KEY:test-key
 *   3) POST a fake update to http://127.0.0.1:8787/telegram/webhook
 *
 * Recorded requests are served at GET /_messages and reset at POST /_reset,
 * so a test can assert what the bot actually sent.
 */
import { createServer } from 'node:http';

const PORT = Number.parseInt(process.env.MOCK_PORT ?? '8790', 10);
const messages = [];
let nextMessageId = 100;

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', (chunk) => {
      data += chunk;
    });
    req.on('end', () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({ raw: data });
      }
    });
  });
}

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(body);
}

/** Canned translation answer: echoes "FA:<line>" so mapping is easy to assert. */
function translationAnswer(body) {
  const prompt = body?.messages?.find((message) => message.role === 'user')?.content ?? '';
  const lines = [];
  for (const raw of String(prompt).split('\n')) {
    const match = /^(\d+)\|\s?(.*)$/.exec(raw);
    if (match) lines.push({ i: Number(match[1]), text: `FA:${match[2]}`, note: 'معنی پنهان' });
  }
  const slow = /slow/i.test(prompt);
  return {
    id: 'mock-completion',
    object: 'chat.completion',
    model: body?.model ?? 'mock-model',
    choices: [
      {
        index: 0,
        finish_reason: 'stop',
        message: {
          role: 'assistant',
          content: JSON.stringify({
            theme: slow ? 'موضوع کلی آزمون' : 'موضوع کلی: عشق و انتظار',
            mood: 'آرام و نوستالژیک',
            lines,
          }),
        },
      },
    ],
  };
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', `http://127.0.0.1:${PORT}`);
  const path = url.pathname;

  if (req.method === 'GET' && path === '/_messages') {
    send(res, 200, { messages });
    return;
  }
  if (req.method === 'POST' && path === '/_reset') {
    await readBody(req);
    messages.length = 0;
    send(res, 200, { ok: true });
    return;
  }

  const body = req.method === 'POST' ? await readBody(req) : {};

  // OpenAI-compatible endpoint used by the translation engine.
  if (path.endsWith('/chat/completions')) {
    if (/fail/i.test(JSON.stringify(body?.messages ?? ''))) {
      send(res, 400, { error: { message: 'mock failure' } });
      return;
    }
    send(res, 200, translationAnswer(body));
    return;
  }

  // Telegram Bot API methods.
  const method = /\/bot[^/]+\/([a-zA-Z]+)/.exec(path)?.[1] ?? '';
  const record = (result) => {
    messages.push({ method, request: body, result });
    console.log(`[mock] ${method} -> ${JSON.stringify(result).slice(0, 160)}`);
    return result;
  };

  switch (method) {
    case 'getMe':
      send(res, 200, {
        ok: true,
        result: record({ id: 42, is_bot: true, first_name: 'Lyricson', username: 'lyricson_test_bot' }),
      });
      return;
    case 'sendMessage':
      send(res, 200, {
        ok: true,
        result: record({
          message_id: nextMessageId++,
          date: Math.floor(Date.now() / 1000),
          chat: { id: body?.chat_id ?? 1, type: 'private' },
          text: body?.text ?? '',
        }),
      });
      return;
    case 'getFile':
      send(res, 200, { ok: true, result: record({ file_id: body?.file_id, file_path: 'music/test.mp3' }) });
      return;
    default:
      send(res, 200, { ok: true, result: record(true) });
  }
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`[mock] Telegram + AI mock listening on http://127.0.0.1:${PORT}`);
});
