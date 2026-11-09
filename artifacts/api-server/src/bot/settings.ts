import Database from "better-sqlite3";
import path from "node:path";
import fs from "node:fs";
import { logger } from "../lib/logger";

const DB_PATH = process.env["DB_PATH"] ?? path.resolve(process.cwd(), "data", "settings.db");
const DAILY_STICKER_LIMIT = 12;
const USER_TIME_ZONE = "Africa/Cairo";

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!_db) {
    const dbDir = path.dirname(DB_PATH);
    fs.mkdirSync(dbDir, { recursive: true });
    _db = new Database(DB_PATH);
    _db.pragma("journal_mode = WAL");
    _db.pragma("busy_timeout = 5000");
    _db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS whatsapp_sessions (
        id TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sticker_users (
        user_id TEXT PRIMARY KEY,
        created_at TEXT NOT NULL,
        mode TEXT NOT NULL DEFAULT 'awaiting_choice',
        daily_date TEXT NOT NULL DEFAULT '',
        daily_count INTEGER NOT NULL DEFAULT 0
      );
    `);
    const defaults: Record<string, string> = {
      phone_number: "201505324892",
      channel_name: "Sticker Bot",
      sticker_quality: "80",
    };
    const insert = _db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
    for (const [key, value] of Object.entries(defaults)) insert.run(key, value);
    logger.info({ path: DB_PATH }, "Settings DB ready");
  }
  return _db;
}

function cairoDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: USER_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

export function getSetting(key: string): string | null {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

export function setSetting(key: string, value: string): void {
  getDb().prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)").run(key, value);
}

export function getAllSettings(): Record<string, string> {
  const rows = getDb().prepare("SELECT key, value FROM settings").all() as {
    key: string;
    value: string;
  }[];
  return Object.fromEntries(rows.map((row) => [row.key, row.value]));
}

export type StickerUser = {
  isNew: boolean;
  mode: "awaiting_choice" | "active" | "contact";
};

export function ensureStickerUser(userId: string): StickerUser {
  const db = getDb();
  const inserted = db.prepare(
    "INSERT OR IGNORE INTO sticker_users (user_id, created_at, mode, daily_date, daily_count) VALUES (?, ?, 'awaiting_choice', ?, 0)",
  ).run(userId, new Date().toISOString(), cairoDate());
  if (inserted.changes > 0) return { isNew: true, mode: "awaiting_choice" };

  const existing = db.prepare("SELECT mode FROM sticker_users WHERE user_id = ?").get(userId) as
    | { mode: StickerUser["mode"] }
    | undefined;
  return { isNew: false, mode: existing?.mode ?? "awaiting_choice" };
}

export function setStickerUserMode(
  userId: string,
  mode: StickerUser["mode"],
): void {
  getDb().prepare("UPDATE sticker_users SET mode = ? WHERE user_id = ?").run(mode, userId);
}

export function reserveDailySticker(userId: string): { allowed: boolean; remaining: number; used: number } {
  const db = getDb();
  const today = cairoDate();
  const reserve = db.transaction(() => {
    db.prepare(
      "INSERT OR IGNORE INTO sticker_users (user_id, created_at, mode, daily_date, daily_count) VALUES (?, ?, 'active', ?, 0)",
    ).run(userId, new Date().toISOString(), today);
    const row = db.prepare(
      "SELECT daily_date, daily_count FROM sticker_users WHERE user_id = ?",
    ).get(userId) as { daily_date: string; daily_count: number };
    const used = row.daily_date === today ? row.daily_count : 0;
    if (used >= DAILY_STICKER_LIMIT) {
      return { allowed: false, remaining: 0, used };
    }
    const nextUsed = used + 1;
    db.prepare(
      "UPDATE sticker_users SET daily_date = ?, daily_count = ? WHERE user_id = ?",
    ).run(today, nextUsed, userId);
    return { allowed: true, remaining: DAILY_STICKER_LIMIT - nextUsed, used: nextUsed };
  });
  return reserve();
}

export function releaseDailySticker(userId: string): void {
  getDb().prepare(
    "UPDATE sticker_users SET daily_count = CASE WHEN daily_count > 0 THEN daily_count - 1 ELSE 0 END WHERE user_id = ? AND daily_date = ?",
  ).run(userId, cairoDate());
}

export function getDailyStickerUsage(userId: string): { used: number; remaining: number } {
  const row = getDb().prepare(
    "SELECT daily_date, daily_count FROM sticker_users WHERE user_id = ?",
  ).get(userId) as { daily_date: string; daily_count: number } | undefined;
  const used = row?.daily_date === cairoDate() ? row.daily_count : 0;
  return { used, remaining: Math.max(0, DAILY_STICKER_LIMIT - used) };
}

// ─── WhatsApp session persistence ────────────────────────────────────────────

export function saveSessionToDb(id: string, data: string): void {
  getDb().prepare("INSERT OR REPLACE INTO whatsapp_sessions (id, data) VALUES (?, ?)").run(id, data);
}

export function getSessionFromDb(id: string): string | null {
  const row = getDb().prepare("SELECT data FROM whatsapp_sessions WHERE id = ?").get(id) as
    | { data: string }
    | undefined;
  return row?.data ?? null;
}

export function clearSessionFromDb(id: string): void {
  getDb().prepare("DELETE FROM whatsapp_sessions WHERE id = ?").run(id);
}
