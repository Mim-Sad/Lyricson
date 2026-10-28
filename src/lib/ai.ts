/**
 * OpenAI-compatible chat client plus the translation pipeline:
 * one request for the whole song, a chunked retry when the answer comes back
 * truncated, and a defensive parser that never loses a source line.
 */
import type { AiConfig } from '../env.js';
import { AI_PROVIDERS } from '../env.js';
import { logError, UserFacingError } from './errors.js';
import type { TargetLanguage } from './languages.js';
import { AI_NOT_CONFIGURED } from './messages.js';
import {
  chunkLines,
  systemPrompt,
  userPrompt,
  type ParsedPayload,
  type Translation,
} from './prompt.js';
import type { TrackSummary } from './types.js';

const AI_TIMEOUT_MS = 45_000;

const TEXT_KEYS = ['text', 'fa', 'translation', 'translated', 'persian', 'target', 'output', 'value'];
const NOTE_KEYS = ['note', 'notes', 'comment', 'explanation', 'hint', 'توضیح'];
const THEME_KEYS = ['theme', 'concept', 'summary', 'overall', 'idea', 'مفهوم'];
const MOOD_KEYS = ['mood', 'tone', 'vibe', 'atmosphere', 'حال'];

function pickString(source: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number') return String(value);
  }
  return undefined;
}

/** Pulls the first JSON object (or array) out of a model answer. */
export function extractJson(raw: string): unknown | null {
  const text = raw
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/i, '')
    .trim();

  const objectStart = text.indexOf('{');
  const objectEnd = text.lastIndexOf('}');
  const arrayStart = text.indexOf('[');
  const arrayEnd = text.lastIndexOf(']');

  const slices: string[] = [];
  const push = (start: number, end: number) => {
    if (start >= 0 && end > start) slices.push(text.slice(start, end + 1));
  };
  // Whichever delimiter comes first is the real payload; the other is a nested
  // or trailing value. Trying them in that order keeps both shapes parseable.
  if (arrayStart >= 0 && (objectStart < 0 || arrayStart < objectStart)) {
    push(arrayStart, arrayEnd);
    push(objectStart, objectEnd);
  } else {
    push(objectStart, objectEnd);
    push(arrayStart, arrayEnd);
  }

  for (const candidate of slices) {
    try {
      return JSON.parse(candidate);
    } catch {
      // try the next slice
    }
  }
  return null;
}

/** Maps a model payload onto the source lines, index first then order. */
export function normalizePayload(payload: unknown, sourceLines: string[]): ParsedPayload {
  const root: Record<string, unknown> =
    payload && typeof payload === 'object' && !Array.isArray(payload) ? (payload as Record<string, unknown>) : {};
  const rawLines: unknown[] = Array.isArray(payload)
    ? payload
    : Array.isArray(root.lines)
      ? (root.lines as unknown[])
      : Array.isArray(root.translation)
        ? (root.translation as unknown[])
        : [];

  const byIndex = new Map<number, { text: string; note?: string }>();
  const sequential: { text: string; note?: string }[] = [];

  for (const entry of rawLines) {
    if (typeof entry === 'string') {
      const text = entry.trim();
      if (text) sequential.push({ text });
      continue;
    }
    if (!entry || typeof entry !== 'object') continue;
    const obj = entry as Record<string, unknown>;
    const text = pickString(obj, TEXT_KEYS);
    if (!text) continue;
    const note = pickString(obj, NOTE_KEYS);
    const indexValue = obj.i ?? obj.index ?? obj.line ?? obj.n ?? obj.id;
    const index = typeof indexValue === 'number' ? indexValue : Number.parseInt(String(indexValue ?? ''), 10);
    if (Number.isFinite(index) && index >= 1) byIndex.set(Math.trunc(index), { text, ...(note ? { note } : {}) });
    else sequential.push({ text, ...(note ? { note } : {}) });
  }

  const useIndex = byIndex.size > 0;
  let missing = 0;
  const lines = sourceLines.map((source, position) => {
    const entry = useIndex ? byIndex.get(position + 1) : sequential[position];
    if (!entry) {
      missing += 1;
      return { i: position + 1, text: source };
    }
    return { i: position + 1, text: entry.text, ...(entry.note ? { note: entry.note } : {}) };
  });

  return {
    theme: pickString(root, THEME_KEYS) ?? '',
    mood: pickString(root, MOOD_KEYS) ?? '',
    lines,
    missing,
  };
}

export function parseTranslation(raw: string, sourceLines: string[]): ParsedPayload | null {
  const payload = extractJson(raw);
  if (payload === null) return null;
  const parsed = normalizePayload(payload, sourceLines);
  const translated = parsed.lines.filter((line, index) => line.text !== sourceLines[index]).length;
  if (translated === 0 && sourceLines.length > 1) return null;
  return parsed;
}

interface ChatResponse {
  choices?: {
    message?: { content?: unknown };
    text?: string;
    finish_reason?: string;
  }[];
  error?: { message?: string };
}

function contentFromChat(payload: ChatResponse): string | null {
  const choice = payload.choices?.[0];
  if (!choice) return null;
  const content = choice.message?.content;
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    const joined = content
      .map((part) => (typeof part === 'string' ? part : typeof (part as { text?: string })?.text === 'string' ? (part as { text: string }).text : ''))
      .join('')
      .trim();
    if (joined) return joined;
  }
  if (typeof choice.text === 'string' && choice.text.trim()) return choice.text;
  return null;
}

function providerLabel(ai: AiConfig): string {
  return AI_PROVIDERS[ai.provider]?.label ?? 'هوش مصنوعی';
}

function statusError(status: number, detail: string, ai: AiConfig): UserFacingError {
  const label = providerLabel(ai);
  if (status === 401 || status === 403) {
    return new UserFacingError(
      `کلید ${label} نامعتبره یا دسترسی نداره (کلید را در پنل ادمین یا AI_API_KEY چک کن).`,
      'AI_UNAUTHORIZED',
      detail,
    );
  }
  if (status === 402) {
    return new UserFacingError(`اعتبار کلید ${label} تموم شده.`, 'AI_NO_CREDIT', detail);
  }
  if (status === 404) {
    return new UserFacingError(
      `اسم مدل برای ${label} درست نیست؛ مدل را در پنل ادمین یا AI_MODEL چک کن.`,
      'AI_MODEL_NOT_FOUND',
      detail,
    );
  }
  if (status === 429) {
    return new UserFacingError('الان ترافیک مدل سنگینه؛ چند لحظه بعد دوباره امتحان کن.', 'AI_RATE_LIMITED', detail);
  }
  if (status >= 500) {
    return new UserFacingError('سرویس هوش مصنوعی الان جواب نمی‌ده؛ چند لحظه بعد دوباره امتحان کن.', 'AI_UPSTREAM', detail);
  }
  return new UserFacingError('درخواست ترجمه رد شد؛ چند لحظه بعد دوباره امتحان کن.', 'AI_BAD_REQUEST', detail);
}

/** OpenRouter reads these two headers for attribution and model rankings. */
function headersFor(ai: AiConfig): Record<string, string> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (ai.apiKey) headers.authorization = `Bearer ${ai.apiKey}`;
  if (ai.provider === 'openrouter') {
    headers['HTTP-Referer'] = ai.appUrl ?? 'https://github.com/Mim-Sad/Lyricson';
    headers['X-Title'] = 'Lyricson';
  }
  return headers;
}

async function postChat(
  ai: AiConfig,
  body: Record<string, unknown>,
  fetcher: typeof fetch,
): Promise<ChatResponse> {
  let response: Response;
  try {
    response = await fetcher(`${ai.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: headersFor(ai),
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(AI_TIMEOUT_MS),
    });
  } catch (error) {
    const timedOut = error instanceof Error && /abort|timeout/i.test(error.message);
    throw new UserFacingError(
      timedOut ? 'مدل ترجمه دیر جواب داد؛ یک‌بار دیگر امتحان کن.' : 'ارتباط با سرویس هوش مصنوعی برقرار نشد.',
      timedOut ? 'AI_TIMEOUT' : 'AI_UNREACHABLE',
      error instanceof Error ? error.message : String(error),
    );
  }

  if (!response.ok) {
    const detail = await response.text().catch(() => '');
    throw statusError(response.status, detail.slice(0, 400), ai);
  }

  try {
    return (await response.json()) as ChatResponse;
  } catch (error) {
    throw new UserFacingError('جواب سرویس هوش مصنوعی قابل خواندن نبود.', 'AI_BAD_JSON', String(error));
  }
}

async function requestTranslation(
  ai: AiConfig,
  language: TargetLanguage,
  track: Pick<TrackSummary, 'trackName' | 'artistName' | 'albumName'>,
  lines: string[],
  fetcher: typeof fetch,
): Promise<string> {
  const body: Record<string, unknown> = {
    model: ai.model,
    temperature: 0.3,
    messages: [
      { role: 'system', content: systemPrompt(language) },
      { role: 'user', content: userPrompt(track, lines) },
    ],
    response_format: { type: 'json_object' },
  };

  let content: string | null = null;
  try {
    content = contentFromChat(await postChat(ai, body, fetcher));
  } catch (error) {
    // Plenty of OpenRouter models reject response_format with a 400. That is
    // not fatal: the prompt already asks for JSON, so retry without it.
    if (!(error instanceof UserFacingError) || error.code !== 'AI_BAD_REQUEST') throw error;
  }

  if (!content) {
    delete body.response_format;
    content = contentFromChat(await postChat(ai, body, fetcher));
  }

  if (!content) {
    throw new UserFacingError('جواب خالی از مدل برگشت؛ یک‌بار دیگر امتحان کن.', 'AI_EMPTY');
  }
  return content;
}

function mergeChunks(chunks: { offset: number; lines: string[] }[], payloads: ParsedPayload[]): ParsedPayload {
  const total = chunks[chunks.length - 1]
    ? (chunks[chunks.length - 1]!.offset + (chunks[chunks.length - 1]!.lines.length))
    : 0;
  const text = new Array<string | undefined>(total);
  const notes = new Array<string | undefined>(total);
  let missing = 0;

  chunks.forEach((chunk, chunkIndex) => {
    const payload = payloads[chunkIndex];
    if (!payload) return;
    missing += payload.missing;
    payload.lines.forEach((line, position) => {
      const absolute = chunk.offset + position;
      text[absolute] = line.text;
      notes[absolute] = line.note;
    });
  });

  const first = payloads[0];
  return {
    theme: first?.theme ?? '',
    mood: first?.mood ?? '',
    missing,
    lines: text.map((value, index) => ({
      i: index + 1,
      text: value ?? chunks.flatMap((chunk) => chunk.lines)[index] ?? '',
      ...(notes[index] ? { note: notes[index] } : {}),
    })),
  };
}

export interface TranslateOptions {
  ai: AiConfig;
  language: TargetLanguage;
  track: Pick<TrackSummary, 'trackName' | 'artistName' | 'albumName'>;
  sourceLines: string[];
  fetcher?: typeof fetch;
}

export async function translateTrack(options: TranslateOptions): Promise<Translation> {
  const { ai, language, track, sourceLines } = options;
  const fetcher = options.fetcher ?? fetch;

  if (!ai.apiKey) {
    throw new UserFacingError(AI_NOT_CONFIGURED, 'AI_NOT_CONFIGURED');
  }
  if (!ai.baseUrl) {
    throw new UserFacingError(
      'آدرس سرویس هوش مصنوعی تنظیم نشده؛ از پنل ادمین (/admin) یا AI_BASE_URL ست کن.',
      'AI_NO_BASE_URL',
    );
  }
  if (sourceLines.length === 0) {
    throw new UserFacingError('متنی برای ترجمه پیدا نشد.', 'AI_NO_INPUT');
  }

  let payload: ParsedPayload | null = null;
  const first = await requestTranslation(ai, language, track, sourceLines, fetcher);
  payload = parseTranslation(first, sourceLines);

  if (!payload) {
    // Usually a truncated answer on a long song: translate it in two passes.
    const chunks = chunkLines(sourceLines, 2);
    const parts: ParsedPayload[] = [];
    for (const chunk of chunks) {
      const content = await requestTranslation(ai, language, track, chunk.lines, fetcher);
      const parsed = parseTranslation(content, chunk.lines);
      if (!parsed) {
        throw new UserFacingError('ترجمهٔ کامل برنگشت؛ یک‌بار دیگر امتحان کن.', 'AI_PARSE_FAILED', content.slice(0, 300));
      }
      parts.push(parsed);
    }
    payload = mergeChunks(chunks, parts);
  }

  const lines = payload.lines.map((line, index) => ({
    i: line.i,
    source: sourceLines[index] ?? '',
    text: line.text,
    ...(line.note ? { note: line.note } : {}),
  }));

  return { theme: payload.theme, mood: payload.mood, lines, missing: payload.missing, model: ai.model };
}

export interface AiTestResult {
  ok: boolean;
  latencyMs: number;
  model: string;
  detail?: string;
}

/** Sends a tiny prompt so the admin can verify key, URL and model in one tap. */
export async function testAiConnection(
  ai: AiConfig,
  fetcher: typeof fetch = fetch,
): Promise<AiTestResult> {
  const started = Date.now();
  if (!ai.apiKey) return { ok: false, latencyMs: 0, model: ai.model, detail: 'کلید API تنظیم نشده' };
  if (!ai.baseUrl) return { ok: false, latencyMs: 0, model: ai.model, detail: 'آدرس سرویس تنظیم نشده' };

  try {
    const response = await fetcher(`${ai.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: headersFor(ai),
      body: JSON.stringify({
        model: ai.model,
        temperature: 0,
        max_tokens: 64,
        messages: [{ role: 'user', content: 'Reply with the single word: OK' }],
      }),
      signal: AbortSignal.timeout(20_000),
    });
    const latencyMs = Date.now() - started;
    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      return {
        ok: false,
        latencyMs,
        model: ai.model,
        detail: `${response.status}: ${detail.slice(0, 300)}`,
      };
    }
    const payload = (await response.json()) as ChatResponse;
    const content = contentFromChat(payload);
    // Reasoning models may spend the whole small budget thinking and return no
    // text; a well-formed 200 reply still proves key, URL and model are valid.
    const connected = Boolean(content) || Array.isArray(payload.choices);
    return {
      ok: connected,
      latencyMs,
      model: ai.model,
      detail: content ? content.slice(0, 120) : 'اتصال برقرار است (مدل متنی برنگرداند)',
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: Date.now() - started,
      model: ai.model,
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

export function describeAiError(error: unknown): string {
  if (error instanceof UserFacingError) return error.userText;
  logError('ai', error);
  return '😞 ترجمه انجام نشد. چند لحظه بعد دوباره امتحان کن.';
}
