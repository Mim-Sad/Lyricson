/**
 * AI-backed extras shown under the lyrics: background story, vocabulary and
 * artist biography. Every call returns structured JSON, is cached forever in
 * D1 (translation_cache) and, on OpenRouter, uses the web-search plugin so the
 * answer can rest on interviews and articles instead of the model's memory.
 */
import type { AiConfig } from '../env.js';
import { contentFromChat, extractJson, postChat } from './ai.js';
import { latinDigits } from './text.js';
import { UserFacingError } from './errors.js';
import type { ArtistInfo } from './music.js';
import type { TrackSummary } from './types.js';

export interface Story {
  summary: string;
  points: { title: string; text: string }[];
  /** "high" when the answer comes from found sources, "low" when it is mostly general knowledge. */
  confidence: 'high' | 'medium' | 'low';
  sources: string[];
}

export interface VocabWord {
  word: string;
  ipa: string;
  pos: string;
  meaning: string;
  synonyms: string[];
  antonyms: string[];
  usage: string;
}

export interface ArtistBio {
  /** One compact paragraph that fits a photo caption. */
  caption: string;
  /** Longer biography, paragraphs separated by blank lines. */
  bio: string;
  sources: string[];
}

type Ask = { data: unknown; sources: string[] };

/** Everything one panel may spend: Workers only keep background work alive for ~30 s after the webhook answers. */
const BUDGET_MS = 27_000;

async function ask(
  ai: AiConfig,
  system: string,
  user: string,
  options: { web?: boolean; maxTokens?: number } = {},
): Promise<Ask> {
  const base: Record<string, unknown> = {
    model: ai.model,
    temperature: 0.4,
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    max_tokens: options.maxTokens ?? 3000,
  };

  // Most capable first; each later attempt is a plainer request that more models accept.
  const attempts: { body: Record<string, unknown>; share: number }[] = [];
  if (options.web && ai.provider === 'openrouter') {
    attempts.push({ body: { ...base, plugins: [{ id: 'web', max_results: 5 }] }, share: 0.55 });
  }
  attempts.push({ body: { ...base, response_format: { type: 'json_object' } }, share: 0.8 }, { body: base, share: 1 });

  const deadline = Date.now() + BUDGET_MS;
  let lastError: unknown;
  for (const attempt of attempts) {
    const remaining = deadline - Date.now();
    if (remaining < 4_000) break;
    try {
      const response = await postChat(ai, attempt.body, fetch, Math.max(4_000, Math.floor(remaining * attempt.share)));
      const content = contentFromChat(response);
      const data = content ? extractJson(content) : null;
      if (!data || typeof data !== 'object') {
        lastError = new UserFacingError('جواب مدل قابل خواندن نبود.', 'AI_UNREADABLE', (content ?? '').slice(0, 200));
        continue;
      }
      const sources = (response.choices?.[0]?.message?.annotations ?? [])
        .map((annotation) => annotation.url_citation?.url)
        .filter((url): url is string => typeof url === 'string' && /^https?:\/\//.test(url));
      return { data, sources: [...new Set(sources)].slice(0, 5) };
    } catch (error) {
      lastError = error;
      // Auth, credit-less keys and unknown models will not improve with a plainer request.
      if (
        error instanceof UserFacingError &&
        ['AI_UNAUTHORIZED', 'AI_MODEL_NOT_FOUND'].includes(error.code)
      ) {
        throw error;
      }
    }
  }
  if (lastError instanceof UserFacingError && lastError.code === 'AI_UNREADABLE') {
    throw new UserFacingError('مدل این بار جواب ساختارمند نداد؛ دوباره امتحان کن.', 'AI_UNREADABLE', lastError.detail);
  }
  if (lastError) throw lastError;
  throw new UserFacingError('مدل به‌موقع جواب نداد؛ دوباره امتحان کن.', 'AI_TIMEOUT');
}

/** Models love markdown, citations and Persian digits; Telegram HTML wants none of them. */
export function cleanAiText(input: string): string {
  return latinDigits(input)
    .replace(/\(\s*\[[^\]]*\]\(\s*<?https?:[^)]*\)\s*\)/g, '')
    .replace(/\[([^\]]*)\]\(\s*<?https?:[^)]*\)/g, '$1')
    .replace(/\(\s*https?:\/\/[^)\s]+\s*\)/g, '')
    .replace(/https?:\/\/\S+/g, '')
    .replace(/\*\*|__|`+/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*•]\s+/gm, '• ')
    .replace(/\[\d{1,2}\]/g, '')
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/\s+([،.؛:!؟,])/g, '$1')
    .replace(/\(\s*\)/g, '')
    .trim();
}

const text = (value: unknown, max = 1200): string =>
  typeof value === 'string' ? cleanAiText(value).replace(/\s+\n/g, '\n').slice(0, max) : '';

const list = (value: unknown, max = 6): string[] =>
  Array.isArray(value) ? value.map((item) => text(item, 60)).filter(Boolean).slice(0, max) : [];

const SYSTEM_COMMON =
  'You write for Persian-speaking music fans. Reply with ONE JSON object only, no markdown fences. ' +
  'All explanations are in natural, fluent Persian; keep song titles, names and English terms in their original script. ' +
  'Plain text only: no markdown, no links or URLs, no citation markers like [1]. Always write numbers with English digits (0-9). ' +
  'Never invent facts, quotes or sources: if you are not sure, say so briefly in the text and lower "confidence".';

// ---------------------------------------------------------------------------

export async function buildStory(
  ai: AiConfig,
  track: Pick<TrackSummary, 'trackName' | 'artistName' | 'albumName'>,
  lyricsExcerpt: string,
): Promise<Story> {
  const { data, sources } = await ask(
    ai,
    `${SYSTEM_COMMON}\nYou research the story behind a song: how and why it was written, what the writers said about it in interviews, ` +
      'recording details, reception, and fan interpretations from forums. Prefer information from the web search results.',
    `Song: "${track.trackName}" by ${track.artistName}${track.albumName ? ` (album: ${track.albumName})` : ''}.\n` +
      `Lyrics excerpt:\n${lyricsExcerpt.slice(0, 1500)}\n\n` +
      'Return JSON: {"summary": string (2-4 sentences, max 600 chars), ' +
      '"points": [{"title": string, "text": string}] (3 to 5 items: e.g. "پشت‌صحنه", "از زبان هنرمند", "برداشت طرفداران", "دریافت و تأثیر"), ' +
      '"confidence": "high"|"medium"|"low"}',
    { web: true, maxTokens: 2500 },
  );
  const record = (data ?? {}) as Record<string, unknown>;
  const points = Array.isArray(record.points)
    ? record.points
        .map((item) => {
          const point = (item ?? {}) as Record<string, unknown>;
          return { title: text(point.title, 60), text: text(point.text, 500) };
        })
        .filter((point) => point.title && point.text)
        .slice(0, 5)
    : [];
  const confidence = record.confidence === 'high' || record.confidence === 'low' ? record.confidence : 'medium';
  const summary = text(record.summary, 700);
  if (!summary && points.length === 0) {
    throw new UserFacingError('چیز قابل‌اتکایی دربارهٔ داستان این موزیک پیدا نشد.', 'STORY_EMPTY');
  }
  return { summary, points, confidence, sources };
}

export async function buildVocabulary(
  ai: AiConfig,
  track: Pick<TrackSummary, 'trackName' | 'artistName'>,
  lyrics: string,
): Promise<VocabWord[]> {
  const { data } = await ask(
    ai,
    `${SYSTEM_COMMON}\nYou are a language teacher. From song lyrics you pick the most valuable vocabulary for learners.`,
    `Song: "${track.trackName}" by ${track.artistName}.\nLyrics:\n${lyrics.slice(0, 3500)}\n\n` +
      'Pick at most 10 words or idioms from the lyrics (original language of the lyrics) that are worth learning; skip names and trivial words. ' +
      'Order them from the HARDEST to the EASIEST. Return JSON: {"words": [{"word": string, "ipa": string (IPA pronunciation), ' +
      '"pos": string (part of speech, English abbreviation), "meaning": string (Persian), "synonyms": string[] (max 3, same language as the word), ' +
      '"antonyms": string[] (max 3, empty if none), "usage": string (one short Persian note on how it is used, plus a short example sentence in the original language)}]}',
    { maxTokens: 4000 },
  );
  const words = Array.isArray((data as { words?: unknown })?.words) ? ((data as { words: unknown[] }).words) : [];
  const out = words
    .map((item): VocabWord => {
      const entry = (item ?? {}) as Record<string, unknown>;
      return {
        word: text(entry.word, 60),
        ipa: text(entry.ipa, 60),
        pos: text(entry.pos, 20),
        meaning: text(entry.meaning, 160),
        synonyms: list(entry.synonyms, 3),
        antonyms: list(entry.antonyms, 3),
        usage: text(entry.usage, 280),
      };
    })
    .filter((word) => word.word && word.meaning)
    .slice(0, 10);
  if (out.length === 0) {
    throw new UserFacingError('کلمهٔ قابل‌یادگیری‌ای از این متن درنیامد.', 'WORDS_EMPTY');
  }
  return out;
}

export async function buildArtistBio(ai: AiConfig, artist: ArtistInfo): Promise<ArtistBio> {
  const facts = [
    artist.wikiExtract ? `Wikipedia summary: ${artist.wikiExtract.slice(0, 1800)}` : '',
    artist.fans ? `Deezer fans: ${artist.fans}` : '',
    artist.albums.length > 0 ? 'The artist has released albums (cover art found).' : '',
  ]
    .filter(Boolean)
    .join('\n');
  const { data, sources } = await ask(
    ai,
    `${SYSTEM_COMMON}\nYou write accurate artist biographies. Prefer the supplied facts and web search results over memory.`,
    `Artist: ${artist.name}\n${facts}\n\n` +
      'Return JSON: {"caption": string (one tight paragraph, max 700 chars: who they are, genre, origin, what they are known for), ' +
      '"bio": string (a complete biography in 3-5 short paragraphs separated by blank lines: early life and formation, career milestones and key albums, style and influences, notable achievements; max 2200 chars)}',
    { web: true, maxTokens: 3500 },
  );
  const record = (data ?? {}) as Record<string, unknown>;
  const bio = text(record.bio, 2600);
  const caption = text(record.caption, 800) || bio.slice(0, 700);
  if (!bio && !caption) {
    throw new UserFacingError('اطلاعات کافی دربارهٔ این هنرمند پیدا نشد.', 'ARTIST_EMPTY');
  }
  const wiki = artist.wikiUrl ? [artist.wikiUrl] : [];
  return { caption, bio: bio || caption, sources: [...new Set([...wiki, ...sources])].slice(0, 4) };
}

/** What we can say without the AI: Wikipedia's summary and Deezer's numbers. Better than nothing. */
export function fallbackArtistBio(artist: ArtistInfo): ArtistBio {
  const wiki = artist.wikiExtract?.trim() ?? '';
  const firstSentences = wiki.length > 700 ? `${wiki.slice(0, 700).replace(/\s+\S*$/, '')}…` : wiki;
  const facts = artist.fans ? `${artist.name} — ${artist.fans.toLocaleString('en-US')} fans on Deezer.` : artist.name;
  return {
    caption: firstSentences || facts,
    bio: wiki || facts,
    sources: artist.wikiUrl ? [artist.wikiUrl] : [],
  };
}
