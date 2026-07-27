import Database from "better-sqlite3";
import path from "node:path";
import { logger } from "../lib/logger";

const DB_PATH = process.env["DB_PATH"] ?? path.resolve(process.cwd(), "data", "settings.db");

let _db: Database.Database | null = null;

function getDb(): Database.Database {
  if (!_db) {
    _db = new Database(DB_PATH);
    _db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );
    `);
    // Insert defaults if missing
    const defaults: Record<string, string> = {
      phone_number: "201044568121",
      channel_name: "Sticker Bot",
      sticker_quality: "80",
    };
    const insert = _db.prepare(
      "INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)"
    );
    for (const [k, v] of Object.entries(defaults)) {
      insert.run(k, v);
    }
    logger.info({ path: DB_PATH }, "Settings DB ready");
  }
  return _db;
}

export function getSetting(key: string): string | null {
  const row = getDb().prepare("SELECT value FROM settings WHERE key = ?").get(key) as
    | { value: string }
    | undefined;
  return row ? row.value : null;
}

export function setSetting(key: string, value: string): void {
  getDb()
    .prepare("INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)")
    .run(key, value);
}

export function getAllSettings(): Record<string, string> {
  const rows = getDb().prepare("SELECT key, value FROM settings").all() as {
    key: string;
    value: string;
  }[];
  return Object.fromEntries(rows.map((r) => [r.key, r.value]));
}

// ─── Session Persistence Helpers ─────────────────────────────────────────────

export function saveSessionToDb(id: string, data: string): void {
  getDb().exec(`
    CREATE TABLE IF NOT EXISTS whatsapp_sessions (
      id TEXT PRIMARY KEY,
      data TEXT NOT NULL
    );
  `);
  getDb()
    .prepare("INSERT OR REPLACE INTO whatsapp_sessions (id, data) VALUES (?, ?)")
    .run(id, data);
}

export function getSessionFromDb(id: string): string | null {
  try {
    const row = getDb()
      .prepare("SELECT data FROM whatsapp_sessions WHERE id = ?")
      .get(id) as { data: string } | undefined;
    return row ? row.data : null;
  } catch {
    return null;
  }
}

export function clearSessionFromDb(id: string): void {
  try {
    getDb().prepare("DELETE FROM whatsapp_sessions WHERE id = ?").run(id);
  } catch {}
}
