/** Track and session shapes shared by the bot, the store and the formatter. */

export interface TrackSummary {
  /** LRCLIB id, absent for lyrics the user pasted themselves. */
  id?: number;
  trackName: string;
  artistName: string;
  albumName?: string;
  duration?: number;
  instrumental?: boolean;
  /** Present only for user-supplied lyrics (and for the chosen track). */
  lyrics?: string;
  source: 'lrclib' | 'lyrics.ovh' | 'lyrist' | 'user';
}

export type SessionPayload =
  | { candidates: TrackSummary[] }
  | { track: TrackSummary; searchSid?: string };

export interface Session {
  id: string;
  chatId: number;
  userId: number;
  mode: 'search' | 'track';
  query: string;
  payload: SessionPayload;
  messageId?: number;
}

export function isSearchPayload(payload: SessionPayload): payload is { candidates: TrackSummary[] } {
  return Array.isArray((payload as { candidates?: unknown }).candidates);
}
