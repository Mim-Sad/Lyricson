import { describe, expect, it } from 'vitest';
import type { AiConfig } from '../src/env.js';
import { extractJson, normalizePayload, parseTranslation, translateTrack } from '../src/lib/ai.js';
import { languageFor } from '../src/lib/languages.js';
import { chunkLines, toSourceLines } from '../src/lib/prompt.js';

const SOURCES = ['Look at the stars', 'Look how they shine for you', 'Yeah, they were all yellow'];

describe('extractJson', () => {
  it('reads fenced and prose-wrapped answers', () => {
    expect(extractJson('```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('Sure! Here you go: {"theme":"x"} hope it helps')).toEqual({ theme: 'x' });
    expect(extractJson('[{"i":1,"text":"یک"}]')).toEqual([{ i: 1, text: 'یک' }]);
  });

  it('returns null when there is no JSON', () => {
    expect(extractJson('no json at all')).toBeNull();
    expect(extractJson('')).toBeNull();
  });
});

describe('normalizePayload', () => {
  it('maps indexed lines onto the source lines', () => {
    const parsed = normalizePayload(
      { theme: 'مفهوم', mood: 'آرام', lines: [{ i: 1, text: 'به ستاره‌ها نگاه کن' }, { i: 3, text: 'زرد بود' }] },
      SOURCES,
    );
    expect(parsed.theme).toBe('مفهوم');
    expect(parsed.lines[0]?.text).toBe('به ستاره‌ها نگاه کن');
    expect(parsed.lines[2]?.text).toBe('زرد بود');
    expect(parsed.missing).toBe(1);
    expect(parsed.lines[1]?.text).toBe(SOURCES[1]);
  });

  it('accepts a plain array in source order and alternate keys', () => {
    const parsed = normalizePayload({ lines: ['یک', 'دو', 'سه'] }, SOURCES);
    expect(parsed.lines.map((line) => line.text)).toEqual(['یک', 'دو', 'سه']);
    expect(parsed.missing).toBe(0);

    const alt = normalizePayload({ translation: [{ fa: 'یک' }, { fa: 'دو' }, { fa: 'سه' }] }, SOURCES);
    expect(alt.lines.map((line) => line.text)).toEqual(['یک', 'دو', 'سه']);
  });

  it('keeps notes only when the model sends them', () => {
    const parsed = normalizePayload(
      { lines: [{ i: 1, text: 'الف', note: 'استعاره' }, { i: 2, text: 'ب', note: '' }] },
      SOURCES,
    );
    expect(parsed.lines[0]?.note).toBe('استعاره');
    expect(parsed.lines[1]?.note).toBeUndefined();
  });
});

describe('parseTranslation', () => {
  it('rejects answers that are not usable JSON', () => {
    expect(parseTranslation('sorry, I cannot help', SOURCES)).toBeNull();
    // An empty line list carries no translation at all.
    expect(parseTranslation('{"theme":"x","lines":[]}', SOURCES)).toBeNull();
  });

  it('accepts a valid answer', () => {
    const parsed = parseTranslation(
      '{"theme":"t","mood":"m","lines":[{"i":1,"text":"الف"},{"i":2,"text":"ب"},{"i":3,"text":"پ"}]}',
      SOURCES,
    );
    expect(parsed?.lines.map((line) => line.text)).toEqual(['الف', 'ب', 'پ']);
    expect(parsed?.missing).toBe(0);
  });
});

const PANEL_AI: AiConfig = {
  provider: 'openrouter',
  apiKey: 'sk-or-v1-test',
  baseUrl: 'https://openrouter.ai/api/v1',
  model: 'google/gemini-3.8-flash',
  appUrl: 'https://lyricson.example.workers.dev',
};

function translationResponse(): Response {
  return new Response(
    JSON.stringify({
      choices: [
        {
          message: {
            content: JSON.stringify({
              theme: 'مفهوم',
              mood: 'آرام',
              lines: SOURCES.map((line, index) => ({ i: index + 1, text: `فا ${index + 1}` })),
            }),
          },
        },
      ],
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );
}

describe('OpenRouter pipeline', () => {
  it('sends attribution headers and the saved model', async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const fetcher = (async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init: init ?? {} });
      return translationResponse();
    }) as unknown as typeof fetch;

    const result = await translateTrack({
      ai: PANEL_AI,
      language: languageFor('fa'),
      track: { trackName: 'Yellow', artistName: 'Coldplay' },
      sourceLines: SOURCES,
      fetcher,
    });

    const first = calls[0];
    const headers = first?.init.headers as Record<string, string>;
    expect(first?.url).toBe('https://openrouter.ai/api/v1/chat/completions');
    expect(headers.authorization).toBe('Bearer sk-or-v1-test');
    expect(headers['HTTP-Referer']).toBe('https://lyricson.example.workers.dev');
    expect(headers['X-Title']).toBe('Lyricson');
    const body = JSON.parse(String(first?.init.body)) as { model: string };
    expect(body.model).toBe('google/gemini-3.8-flash');
    expect(result.lines).toHaveLength(SOURCES.length);
  });

  it('retries without response_format when the model rejects it', async () => {
    let attempts = 0;
    const fetcher = (async (_input: RequestInfo | URL, init?: RequestInit) => {
      attempts += 1;
      const body = JSON.parse(String(init?.body ?? '{}')) as { response_format?: unknown };
      if (body.response_format) {
        return new Response(JSON.stringify({ error: { message: 'response_format unsupported' } }), {
          status: 400,
        });
      }
      return translationResponse();
    }) as unknown as typeof fetch;

    const result = await translateTrack({
      ai: PANEL_AI,
      language: languageFor('fa'),
      track: { trackName: 'Yellow', artistName: 'Coldplay' },
      sourceLines: SOURCES,
      fetcher,
    });

    expect(attempts).toBe(2);
    expect(result.lines[0]?.text).toBe('فا 1');
  });
});

describe('source lines', () => {
  it('numbers only meaningful lines and drops meta tags', () => {
    const lines = toSourceLines('[offset:0]\nLook at the stars\n\n  \n[Verse 1]\nYeah');
    expect(lines).toEqual(['Look at the stars', '[Verse 1]', 'Yeah']);
  });

  it('splits a long song into offset-aware chunks', () => {
    const chunks = chunkLines(['a', 'b', 'c', 'd'], 2);
    expect(chunks).toEqual([
      { offset: 0, lines: ['a', 'b'] },
      { offset: 2, lines: ['c', 'd'] },
    ]);
  });
});
