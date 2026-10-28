/**
 * Target languages. Only Persian is enabled for now — flip `enabled` and a bot
 * user can pick it from /lang; the translation prompt is language agnostic.
 */
export interface TargetLanguage {
  code: string;
  /** Shown inside Telegram messages. */
  nativeName: string;
  /** Used when we talk to the model. */
  promptName: string;
  enabled: boolean;
}

export const TARGET_LANGUAGES: readonly TargetLanguage[] = [
  { code: 'fa', nativeName: 'فارسی', promptName: 'Persian (Farsi)', enabled: true },
  { code: 'en', nativeName: 'English', promptName: 'English', enabled: false },
  { code: 'ar', nativeName: 'العربية', promptName: 'Arabic', enabled: false },
  { code: 'tr', nativeName: 'Türkçe', promptName: 'Turkish', enabled: false },
];

export const DEFAULT_LANGUAGE_CODE = 'fa';

export function languageFor(code: string | undefined): TargetLanguage {
  const found = TARGET_LANGUAGES.find((lang) => lang.code === (code ?? '').trim());
  if (found) return found;
  const fallback = TARGET_LANGUAGES.find((lang) => lang.code === DEFAULT_LANGUAGE_CODE);
  return fallback ?? { code: 'fa', nativeName: 'فارسی', promptName: 'Persian (Farsi)', enabled: true };
}
