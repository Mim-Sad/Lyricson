/**
 * D1 storage: short-lived sessions for the inline buttons, LRCLIB and
 * translation caches, per-user preferences and the daily translation quota.
 *
 * The schema is bootstrapped lazily from the Worker itself, so a fresh database
 * works on the very first request (migrations/0001_init.sql is the same DDL).
 */
import type { Translation } from './prompt.js';
import type { Session, SessionPayload, TrackSummary } from './types.js';

export type CacheTable = 'lyric_cache' | 'translation_cache';

const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS sessions (
     id TEXT PRIMARY KEY,
     chat_id INTEGER NOT NULL,
     user_id INTEGER NOT NULL,
     mode TEXT NOT NULL DEFAULT 'search',
     query TEXT NOT NULL DEFAULT '',
     payload TEXT NOT NULL,
     message_id INTEGER,
     created_at INTEGER NOT NULL
   )`,
  `CREATE INDEX IF NOT EXISTS idx_sessions_created_at ON sessions (created_at)`,
  `CREATE TABLE IF NOT EXISTS lyric_cache (
     key TEXT PRIMARY KEY,
     payload TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS translation_cache (
     key TEXT PRIMARY KEY,
     payload TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS prefs (
     user_id INTEGER PRIMARY KEY,
     target_lang TEXT NOT NULL DEFAULT 'fa',
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS usage (
     user_id INTEGER NOT NULL,
     day TEXT NOT NULL,
     count INTEGER NOT NULL DEFAULT 0,
     PRIMARY KEY (user_id, day)
   )`,
  `CREATE TABLE IF NOT EXISTS settings (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS shares (
     id TEXT PRIMARY KEY,
     track TEXT NOT NULL,
     translation TEXT,
     language TEXT,
     created_at INTEGER NOT NULL
   )`,
  `CREATE TABLE IF NOT EXISTS users (
     user_id INTEGER PRIMARY KEY,
     first_name TEXT,
     username TEXT,
     first_seen INTEGER NOT NULL,
     last_seen INTEGER NOT NULL,
     blocked INTEGER NOT NULL DEFAULT 0,
     notified_for TEXT
   )`,
  `CREATE TABLE IF NOT EXISTS admin_state (
     user_id INTEGER PRIMARY KEY,
     action TEXT NOT NULL,
     created_at INTEGER NOT NULL
   )`,
];

let schemaPromise: Promise<void> | undefined;

export function ensureSchema(db: D1Database): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      await db.batch(SCHEMA.map((statement) => db.prepare(statement)));
    })().catch((error: unknown) => {
      schemaPromise = undefined;
      throw error;
    });
  }
  return schemaPromise;
}

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

export function dayKey(date = new Date()): string {
  return date.toISOString().slice(0, 10);
}

function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(8));
  return [...bytes].map((byte) => byte.toString(36).padStart(2, '0')).join('').slice(0, 10);
}

// ---------------------------------------------------------------------------
// Sessions (the state behind the inline buttons)
// ---------------------------------------------------------------------------

export interface CreateSessionInput {
  chatId: number;
  userId: number;
  mode: 'search' | 'track';
  query: string;
  payload: SessionPayload;
  messageId?: number;
}

export async function createSession(db: D1Database, input: CreateSessionInput): Promise<string> {
  const id = randomId();
  await ensureSchema(db);
  await db
    .prepare(
      'INSERT INTO sessions (id, chat_id, user_id, mode, query, payload, message_id, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)',
    )
    .bind(
      id,
      input.chatId,
      input.userId,
      input.mode,
      input.query.slice(0, 300),
      JSON.stringify(input.payload),
      input.messageId ?? null,
      nowSeconds(),
    )
    .run();
  void pruneSessions(db);
  return id;
}

interface SessionRow {
  id: string;
  chat_id: number;
  user_id: number;
  mode: string;
  query: string;
  payload: string;
  message_id: number | null;
}

export async function getSession(db: D1Database, id: string): Promise<Session | null> {
  await ensureSchema(db);
  const row = await db
    .prepare('SELECT id, chat_id, user_id, mode, query, payload, message_id FROM sessions WHERE id = ?1')
    .bind(id)
    .first<SessionRow>();
  if (!row) return null;
  let payload: SessionPayload;
  try {
    payload = JSON.parse(row.payload) as SessionPayload;
  } catch {
    return null;
  }
  return {
    id: row.id,
    chatId: row.chat_id,
    userId: row.user_id,
    mode: row.mode === 'track' ? 'track' : 'search',
    query: row.query,
    payload,
    ...(typeof row.message_id === 'number' ? { messageId: row.message_id } : {}),
  };
}

export async function setSessionMessageId(db: D1Database, id: string, messageId: number): Promise<void> {
  await db.prepare('UPDATE sessions SET message_id = ?1 WHERE id = ?2').bind(messageId, id).run();
}

/** Buttons stay valid for 30 days. */
export async function pruneSessions(db: D1Database, olderThanSeconds = 60 * 60 * 24 * 30): Promise<void> {
  try {
    await db
      .prepare('DELETE FROM sessions WHERE created_at < ?1')
      .bind(nowSeconds() - olderThanSeconds)
      .run();
  } catch {
    // Pruning is best effort.
  }
}

// ---------------------------------------------------------------------------
// Caches
// ---------------------------------------------------------------------------

/**
 * Cache behaviour chosen in the admin panel. The bot refreshes it from the
 * settings on every update, so all cache helpers can read it synchronously.
 */
export interface CachePolicy {
  enabled: boolean;
  /** Lifetime of a finished translation in seconds; 0 = forever. */
  translationTtl: number;
  /** Lifetime of looked-up lyrics and search results in seconds; 0 = forever. */
  lyricsTtl: number;
}

const DAY = 60 * 60 * 24;

/** A TTL of 0 means "never expires" (the default: entries stay until an admin clears them). */
export const cachePolicy: CachePolicy = {
  enabled: true,
  translationTtl: 0,
  lyricsTtl: 0,
};

export function applyCachePolicy(policy: CachePolicy): void {
  cachePolicy.enabled = policy.enabled;
  cachePolicy.translationTtl = policy.translationTtl;
  cachePolicy.lyricsTtl = policy.lyricsTtl;
}

/** Deletes rows older than their TTL; they would never be served again anyway. */
export async function pruneCaches(db: D1Database): Promise<{ translations: number; lyrics: number }> {
  try {
    await ensureSchema(db);
    const now = nowSeconds();
    const never = db.prepare('SELECT 0 WHERE 0');
    const [translations, lyrics] = await db.batch([
      cachePolicy.translationTtl > 0
        ? db.prepare('DELETE FROM translation_cache WHERE created_at < ?1').bind(now - cachePolicy.translationTtl)
        : never,
      cachePolicy.lyricsTtl > 0
        ? db.prepare('DELETE FROM lyric_cache WHERE created_at < ?1').bind(now - cachePolicy.lyricsTtl)
        : never,
    ]);
    return {
      translations: translations?.meta?.changes ?? 0,
      lyrics: lyrics?.meta?.changes ?? 0,
    };
  } catch {
    return { translations: 0, lyrics: 0 };
  }
}

export async function cacheGet<T>(
  db: D1Database,
  table: CacheTable,
  key: string,
  ttlSeconds: number,
): Promise<T | null> {
  if (!cachePolicy.enabled) return null;
  try {
    const row = await db
      .prepare(`SELECT payload, created_at FROM ${table} WHERE key = ?1`)
      .bind(key)
      .first<{ payload: string; created_at: number }>();
    if (!row) return null;
    if (ttlSeconds > 0 && nowSeconds() - row.created_at > ttlSeconds) return null;
    return JSON.parse(row.payload) as T;
  } catch {
    return null;
  }
}

export async function cachePut<T>(db: D1Database, table: CacheTable, key: string, value: T): Promise<void> {
  if (!cachePolicy.enabled) return;
  try {
    await db
      .prepare(
        `INSERT INTO ${table} (key, payload, created_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET payload = excluded.payload, created_at = excluded.created_at`,
      )
      .bind(key, JSON.stringify(value), nowSeconds())
      .run();
  } catch {
    // A cache write must never break the request.
  }
}

// ---------------------------------------------------------------------------
// Preferences and quota
// ---------------------------------------------------------------------------

export async function getTargetLang(db: D1Database, userId: number): Promise<string | null> {
  try {
    const row = await db
      .prepare('SELECT target_lang FROM prefs WHERE user_id = ?1')
      .bind(userId)
      .first<{ target_lang: string }>();
    return row?.target_lang ?? null;
  } catch {
    return null;
  }
}

export async function setTargetLang(db: D1Database, userId: number, lang: string): Promise<void> {
  await db
    .prepare(
      `INSERT INTO prefs (user_id, target_lang, updated_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(user_id) DO UPDATE SET target_lang = excluded.target_lang, updated_at = excluded.updated_at`,
    )
    .bind(userId, lang, nowSeconds())
    .run();
}

export interface QuotaResult {
  allowed: boolean;
  used: number;
}

/** Counts one translation for today, unless the daily limit is already used up. */
export async function consumeQuota(db: D1Database, userId: number, limit: number): Promise<QuotaResult> {
  const day = dayKey();
  await db
    .prepare('INSERT INTO usage (user_id, day, count) VALUES (?1, ?2, 0) ON CONFLICT(user_id, day) DO NOTHING')
    .bind(userId, day)
    .run();
  const row = await db
    .prepare('SELECT count FROM usage WHERE user_id = ?1 AND day = ?2')
    .bind(userId, day)
    .first<{ count: number }>();
  const used = row?.count ?? 0;
  if (used >= limit) return { allowed: false, used };
  await db
    .prepare('UPDATE usage SET count = count + 1 WHERE user_id = ?1 AND day = ?2')
    .bind(userId, day)
    .run();
  return { allowed: true, used: used + 1 };
}

// ---------------------------------------------------------------------------
// Admin panel state (which value the admin is about to send)
// ---------------------------------------------------------------------------

const ADMIN_STATE_TTL = 60 * 15;

export interface AdminState {
  action: string;
  createdAt: number;
}

export async function setAdminState(db: D1Database, userId: number, action: string): Promise<void> {
  await ensureSchema(db);
  await db
    .prepare(
      `INSERT INTO admin_state (user_id, action, created_at) VALUES (?1, ?2, ?3)
       ON CONFLICT(user_id) DO UPDATE SET action = excluded.action, created_at = excluded.created_at`,
    )
    .bind(userId, action, nowSeconds())
    .run();
}

export async function getAdminState(db: D1Database, userId: number): Promise<AdminState | null> {
  await ensureSchema(db);
  const row = await db
    .prepare('SELECT action, created_at FROM admin_state WHERE user_id = ?1')
    .bind(userId)
    .first<{ action: string; created_at: number }>();
  if (!row) return null;
  if (nowSeconds() - row.created_at > ADMIN_STATE_TTL) {
    await clearAdminState(db, userId);
    return null;
  }
  return { action: row.action, createdAt: row.created_at };
}

export async function clearAdminState(db: D1Database, userId: number): Promise<void> {
  try {
    await db.prepare('DELETE FROM admin_state WHERE user_id = ?1').bind(userId).run();
  } catch {
    // Best effort: a stale prompt expires on its own.
  }
}

/** Gives back one use when the AI call it was spent on failed. */
export async function refundQuota(db: D1Database, userId: number): Promise<void> {
  try {
    await db
      .prepare('UPDATE usage SET count = MAX(count - 1, 0) WHERE user_id = ?1 AND day = ?2')
      .bind(userId, dayKey())
      .run();
  } catch {
    // Best effort.
  }
}

export async function quotaUsed(db: D1Database, userId: number): Promise<number> {
  try {
    const row = await db
      .prepare('SELECT count FROM usage WHERE user_id = ?1 AND day = ?2')
      .bind(userId, dayKey())
      .first<{ count: number }>();
    return row?.count ?? 0;
  } catch {
    return 0;
  }
}

// ---------------------------------------------------------------------------
// Shared pages (the links on the music card)
// ---------------------------------------------------------------------------

export interface ShareRecord {
  id: string;
  track: TrackSummary;
  translation?: Translation;
  language?: string;
}

/** Stores (or refreshes) the track and optionally its translation behind a short public id. */
export async function saveShare(
  db: D1Database,
  id: string,
  track: TrackSummary,
  translation?: { value: Translation; language: string },
): Promise<void> {
  await ensureSchema(db);
  await db
    .prepare(
      `INSERT INTO shares (id, track, translation, language, created_at) VALUES (?1, ?2, ?3, ?4, ?5)
       ON CONFLICT(id) DO UPDATE SET track = excluded.track,
         translation = COALESCE(excluded.translation, shares.translation),
         language = COALESCE(excluded.language, shares.language)`,
    )
    .bind(
      id,
      JSON.stringify(track),
      translation ? JSON.stringify(translation.value) : null,
      translation?.language ?? null,
      nowSeconds(),
    )
    .run();
}

export async function getShare(db: D1Database, id: string): Promise<ShareRecord | null> {
  await ensureSchema(db);
  const row = await db
    .prepare('SELECT id, track, translation, language FROM shares WHERE id = ?1')
    .bind(id)
    .first<{ id: string; track: string; translation: string | null; language: string | null }>();
  if (!row) return null;
  try {
    return {
      id: row.id,
      track: JSON.parse(row.track) as TrackSummary,
      ...(row.translation ? { translation: JSON.parse(row.translation) as Translation } : {}),
      ...(row.language ? { language: row.language } : {}),
    };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Users (for admin announcements)
// ---------------------------------------------------------------------------

/** Remembers a private-chat user; a user who writes again is no longer "blocked". */
export async function touchUser(
  db: D1Database,
  user: { id: number; first_name?: string; username?: string },
): Promise<void> {
  try {
    await ensureSchema(db);
    const now = nowSeconds();
    await db
      .prepare(
        `INSERT INTO users (user_id, first_name, username, first_seen, last_seen, blocked) VALUES (?1, ?2, ?3, ?4, ?4, 0)
         ON CONFLICT(user_id) DO UPDATE SET first_name = excluded.first_name, username = excluded.username,
           last_seen = excluded.last_seen, blocked = 0`,
      )
      .bind(user.id, user.first_name ?? null, user.username ?? null, now)
      .run();
  } catch {
    // Tracking must never break a request.
  }
}

export async function userCounts(
  db: D1Database,
  broadcastId: string,
): Promise<{ total: number; reachable: number; pending: number }> {
  await ensureSchema(db);
  const row = await db
    .prepare(
      `SELECT COUNT(*) AS total,
              COALESCE(SUM(CASE WHEN blocked = 0 THEN 1 ELSE 0 END), 0) AS reachable,
              COALESCE(SUM(CASE WHEN blocked = 0 AND COALESCE(notified_for, '') != ?1 THEN 1 ELSE 0 END), 0) AS pending
       FROM users`,
    )
    .bind(broadcastId)
    .first<{ total: number; reachable: number; pending: number }>();
  return { total: Number(row?.total ?? 0), reachable: Number(row?.reachable ?? 0), pending: Number(row?.pending ?? 0) };
}

export async function pendingRecipients(db: D1Database, broadcastId: string, limit: number): Promise<number[]> {
  await ensureSchema(db);
  const rows = await db
    .prepare(
      `SELECT user_id FROM users WHERE blocked = 0 AND COALESCE(notified_for, '') != ?1 ORDER BY user_id LIMIT ?2`,
    )
    .bind(broadcastId, limit)
    .all<{ user_id: number }>();
  return (rows.results ?? []).map((row) => row.user_id);
}

export async function markNotified(
  db: D1Database,
  userId: number,
  broadcastId: string,
  outcome: 'sent' | 'blocked',
): Promise<void> {
  await db
    .prepare(
      outcome === 'blocked'
        ? 'UPDATE users SET blocked = 1, notified_for = ?2 WHERE user_id = ?1'
        : 'UPDATE users SET notified_for = ?2 WHERE user_id = ?1',
    )
    .bind(userId, broadcastId)
    .run();
}
