/**
 * D1 storage: short-lived sessions for the inline buttons, LRCLIB and
 * translation caches, per-user preferences and the daily translation quota.
 *
 * The schema is bootstrapped lazily from the Worker itself, so a fresh database
 * works on the very first request (migrations/0001_init.sql is the same DDL).
 */
import type { Session, SessionPayload } from './types.js';

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

export async function pruneSessions(db: D1Database, olderThanSeconds = 60 * 60 * 48): Promise<void> {
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

export async function cacheGet<T>(
  db: D1Database,
  table: CacheTable,
  key: string,
  ttlSeconds: number,
): Promise<T | null> {
  try {
    const row = await db
      .prepare(`SELECT payload, created_at FROM ${table} WHERE key = ?1`)
      .bind(key)
      .first<{ payload: string; created_at: number }>();
    if (!row) return null;
    if (nowSeconds() - row.created_at > ttlSeconds) return null;
    return JSON.parse(row.payload) as T;
  } catch {
    return null;
  }
}

export async function cachePut<T>(db: D1Database, table: CacheTable, key: string, value: T): Promise<void> {
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
