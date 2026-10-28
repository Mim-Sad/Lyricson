/**
 * Prompts and answer parsing for the translation model.
 *
 * The whole song is sent in one request so the model can translate every line
 * with the full picture in mind, and it answers with a line-indexed JSON object
 * so nothing gets dropped or reordered.
 */
import type { TargetLanguage } from './languages.js';
import type { TrackSummary } from './types.js';

export interface TranslationLine {
  i: number;
  source: string;
  text: string;
  note?: string;
}

export interface Translation {
  theme: string;
  mood: string;
  lines: TranslationLine[];
  missing: number;
  model: string;
}

export interface ParsedPayload {
  theme: string;
  mood: string;
  lines: { i: number; text: string; note?: string }[];
  missing: number;
}

export const MAX_LINES_PER_REQUEST = 60;

export function toSourceLines(lyrics: string): string[] {
  return lyrics
    .split(/\r?\n/)
    .map((line) => line.replace(/\s+$/g, '').trim())
    .filter((line) => line.length > 0 && !/^\[(offset|by|re|ti|ar|al|length):[^\]]*\]$/i.test(line))
    .slice(0, MAX_LINES_PER_REQUEST * 2);
}

export function systemPrompt(language: TargetLanguage): string {
  return `You are Lyricson, an expert literary translator and music interpreter.
You translate song lyrics line by line into ${language.promptName} and explain what the song really means.

METHOD
1. Read the complete song first. Work out its story, mood, register (street slang, poetic, devotional, romantic, playful...), who is speaking, and every metaphor, idiom, pun, double meaning, slang word, cultural or religious reference, place or brand name, and any coded or self-censored language.
2. Translate the song line by line, in order, using that reading: each line must make sense inside the song's story, never in isolation.
3. Write the notes: when a line's real meaning is NOT obvious from its literal words (metaphor, irony, slang, double entendre, cultural reference, or something that contradicts the rest of the song), add ONE short note in ${language.promptName} in parentheses that tells a listener what the line actually means. When the line is already clear, leave the note empty. Never write a note for every line; only where it genuinely adds understanding.

TRANSLATION RULES
- Natural, contemporary ${language.promptName} that a native speaker would really say or sing, never a stiff word-for-word rendering.
- Keep slang as slang. Keep the intensity and the profanity: translate the song honestly, never censor, sanitise or moralise.
- Keep the point of view, the pronouns and the tense of the source.
- Produce exactly one translated line per source line, in the same order, with the same index.
- Translate every line, including short interjections ("oh", "yeah", "la la").
- Section labels such as [Verse 1] or [Chorus] become the short ${language.promptName} equivalent in brackets.
- Never merge, split, add or drop lines, and never explain inside the translation itself; explanations belong in the note.
- Keep names, brands and untranslatable words as they are, transliterated when ${language.promptName} normally does that.

OUTPUT
Return ONLY a JSON object, with no markdown fences and no commentary, in exactly this shape:
{"theme":"one or two short ${language.promptName} sentences describing the song's overall concept and story","mood":"two to four ${language.promptName} words for the mood and energy","lines":[{"i":1,"text":"the translation of line 1","note":"the hidden meaning, only when needed"}]}
- Exactly one entry in "lines" per source line, same order, same "i".
- Omit "note" (or send an empty string) when the line is clear.
- Every human-readable value must be written in ${language.promptName}.`;
}

export function userPrompt(track: Pick<TrackSummary, 'trackName' | 'artistName' | 'albumName'>, lines: string[]): string {
  const meta = [
    `Title: ${track.trackName}`,
    `Artist: ${track.artistName}`,
    track.albumName ? `Album: ${track.albumName}` : '',
  ].filter(Boolean);

  const numbered = lines.map((line, index) => `${index + 1}| ${line}`).join('\n');
  return `${meta.join('\n')}

Lyrics (${lines.length} numbered lines):

${numbered}

Translate all ${lines.length} lines and answer with the JSON object described in your instructions.`;
}

/** Splits a long song into chunks for the retry path. */
export function chunkLines(lines: string[], parts = 2): { offset: number; lines: string[] }[] {
  const size = Math.max(1, Math.ceil(lines.length / parts));
  const chunks: { offset: number; lines: string[] }[] = [];
  for (let start = 0; start < lines.length; start += size) {
    chunks.push({ offset: start, lines: lines.slice(start, start + size) });
  }
  return chunks;
}
