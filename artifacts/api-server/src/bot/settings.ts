import { Pool } from "@neondatabase/serverless";
import { logger } from "../lib/logger";

const DAILY_STICKER_LIMIT = 12;
const USER_TIME_ZONE = "Africa/Cairo";
const connectionString = process.env["DATABASE_URL"];

if (!connectionString) {
  throw new Error("DATABASE_URL is required. Add your Neon PostgreSQL connection string as a hosting secret.");
}

const pool = new Pool({ connectionString, max: 5, idleTimeoutMillis: 30_000, connectionTimeoutMillis: 15_000 });
let initialized: Promise<void> | null = null;

export async function initDatabase(): Promise<void> {
  if (!initialized) {
    initialized = (async () => {
      await pool.query(`
        CREATE TABLE IF NOT EXISTS settings (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS sticker_users (
          user_id TEXT PRIMARY KEY,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          mode TEXT NOT NULL DEFAULT 'awaiting_choice'
            CHECK (mode IN ('awaiting_choice', 'active', 'contact')),
          is_blocked BOOLEAN NOT NULL DEFAULT FALSE
        );
        CREATE TABLE IF NOT EXISTS sticker_usage (
          user_id TEXT NOT NULL REFERENCES sticker_users(user_id) ON DELETE CASCADE,
          usage_date DATE NOT NULL,
          used_count INTEGER NOT NULL DEFAULT 0 CHECK (used_count >= 0 AND used_count <= 12),
          PRIMARY KEY (user_id, usage_date)
        );
        CREATE TABLE IF NOT EXISTS sticker_history (
          id BIGSERIAL PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES sticker_users(user_id) ON DELETE CASCADE,
          message_id TEXT NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('reserved', 'success', 'failed')),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          error TEXT,
          UNIQUE (user_id, message_id)
        );
        CREATE INDEX IF NOT EXISTS sticker_history_user_created_idx
          ON sticker_history(user_id, created_at DESC);
        CREATE TABLE IF NOT EXISTS whatsapp_sessions (
          id TEXT PRIMARY KEY,
          data JSONB NOT NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
      `);
      await pool.query(
        "INSERT INTO settings(key, value) VALUES ($1, $2), ($3, $4) ON CONFLICT(key) DO NOTHING",
        ["channel_name", "Sticker Bot", "sticker_quality", "80"],
      );
      await pool.query("SELECT 1");
      logger.info("Neon PostgreSQL database ready");
    })().catch((err) => {
      initialized = null;
      throw err;
    });
  }
  return initialized;
}

async function ready() { await initDatabase(); }

export async function getSetting(key: string): Promise<string | null> {
  await ready();
  const result = await pool.query("SELECT value FROM settings WHERE key = $1", [key]);
  return result.rows[0]?.value ?? null;
}

export async function setSetting(key: string, value: string): Promise<void> {
  await ready();
  await pool.query(
    "INSERT INTO settings(key, value) VALUES($1, $2) ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value",
    [key, value],
  );
}

export async function getAllSettings(): Promise<Record<string, string>> {
  await ready();
  const result = await pool.query("SELECT key, value FROM settings ORDER BY key");
  return Object.fromEntries(result.rows.map((row) => [String(row.key), String(row.value)]));
}

export type StickerUser = {
  isNew: boolean;
  mode: "awaiting_choice" | "active" | "contact";
};

export async function ensureStickerUser(userId: string): Promise<StickerUser> {
  await ready();
  const inserted = await pool.query(
    "INSERT INTO sticker_users(user_id) VALUES($1) ON CONFLICT(user_id) DO NOTHING RETURNING user_id",
    [userId],
  );
  await pool.query("UPDATE sticker_users SET last_seen_at = NOW() WHERE user_id = $1", [userId]);
  const existing = await pool.query("SELECT mode, is_blocked FROM sticker_users WHERE user_id = $1", [userId]);
  if (existing.rows[0]?.is_blocked) return { isNew: false, mode: "contact" };
  return {
    isNew: inserted.rowCount === 1,
    mode: (existing.rows[0]?.mode ?? "awaiting_choice") as StickerUser["mode"],
  };
}

export async function setStickerUserMode(userId: string, mode: StickerUser["mode"]): Promise<void> {
  await ready();
  await pool.query("UPDATE sticker_users SET mode = $2, last_seen_at = NOW() WHERE user_id = $1", [userId, mode]);
}

export type StickerReservation = { allowed: boolean; remaining: number; used: number };

export async function reserveDailySticker(userId: string, messageId: string): Promise<StickerReservation> {
  await ready();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("INSERT INTO sticker_users(user_id) VALUES($1) ON CONFLICT(user_id) DO NOTHING", [userId]);
    const day = await client.query("SELECT (NOW() AT TIME ZONE 'Africa/Cairo')::date AS today");
    const today = day.rows[0].today;
    const event = await client.query(
      "INSERT INTO sticker_history(user_id, message_id, status) VALUES($1, $2, 'reserved') ON CONFLICT(user_id, message_id) DO NOTHING RETURNING id",
      [userId, messageId],
    );
    if (event.rowCount !== 1) {
      await client.query("ROLLBACK");
      const usage = await pool.query("SELECT used_count FROM sticker_usage WHERE user_id=$1 AND usage_date=$2", [userId, today]);
      const used = Number(usage.rows[0]?.used_count ?? 0);
      return { allowed: false, remaining: Math.max(0, DAILY_STICKER_LIMIT - used), used };
    }
    await client.query(
      "INSERT INTO sticker_usage(user_id, usage_date, used_count) VALUES($1, $2, 0) ON CONFLICT(user_id, usage_date) DO NOTHING",
      [userId, today],
    );
    const updated = await client.query(
      "UPDATE sticker_usage SET used_count = used_count + 1 WHERE user_id=$1 AND usage_date=$2 AND used_count < $3 RETURNING used_count",
      [userId, today, DAILY_STICKER_LIMIT],
    );
    if (updated.rowCount !== 1) {
      await client.query("DELETE FROM sticker_history WHERE user_id=$1 AND message_id=$2 AND status='reserved'", [userId, messageId]);
      await client.query("COMMIT");
      return { allowed: false, remaining: 0, used: DAILY_STICKER_LIMIT };
    }
    const used = Number(updated.rows[0].used_count);
    await client.query("COMMIT");
    return { allowed: true, remaining: DAILY_STICKER_LIMIT - used, used };
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function releaseDailySticker(userId: string, messageId: string): Promise<void> {
  await ready();
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const changed = await client.query(
      "UPDATE sticker_history SET status='failed' WHERE user_id=$1 AND message_id=$2 AND status='reserved' RETURNING id",
      [userId, messageId],
    );
    if (changed.rowCount === 1) {
      await client.query(
        "UPDATE sticker_usage SET used_count=GREATEST(0, used_count-1) WHERE user_id=$1 AND usage_date=(NOW() AT TIME ZONE 'Africa/Cairo')::date",
        [userId],
      );
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

export async function completeDailySticker(userId: string, messageId: string): Promise<void> {
  await ready();
  await pool.query(
    "UPDATE sticker_history SET status='success' WHERE user_id=$1 AND message_id=$2 AND status='reserved'",
    [userId, messageId],
  );
}

export async function getDailyStickerUsage(userId: string): Promise<{ used: number; remaining: number }> {
  await ready();
  const result = await pool.query(
    "SELECT used_count FROM sticker_usage WHERE user_id=$1 AND usage_date=(NOW() AT TIME ZONE 'Africa/Cairo')::date",
    [userId],
  );
  const used = Number(result.rows[0]?.used_count ?? 0);
  return { used, remaining: Math.max(0, DAILY_STICKER_LIMIT - used) };
}

export async function saveSessionToDb(id: string, data: string): Promise<void> {
  await ready();
  await pool.query(
    "INSERT INTO whatsapp_sessions(id, data) VALUES($1, $2::jsonb) ON CONFLICT(id) DO UPDATE SET data=EXCLUDED.data, updated_at=NOW()",
    [id, data],
  );
}

export async function getSessionFromDb(id: string): Promise<string | null> {
  await ready();
  const result = await pool.query("SELECT data FROM whatsapp_sessions WHERE id=$1", [id]);
  const value = result.rows[0]?.data;
  return value ? (typeof value === "string" ? value : JSON.stringify(value)) : null;
}

export async function clearSessionFromDb(id: string): Promise<void> {
  await ready();
  await pool.query("DELETE FROM whatsapp_sessions WHERE id=$1", [id]);
}
