/**
 * SQLite database — stores clients, machines, events, and sessions.
 * On Railway the DB lives at /data/alexander.db (persistent volume).
 * Falls back to ./alexander.db for local dev.
 */
const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const DB_DIR = process.env.RAILWAY_VOLUME_MOUNT_PATH || ".";
const DB_PATH = path.join(DB_DIR, "alexander.db");

// Ensure directory exists
try { fs.mkdirSync(DB_DIR, { recursive: true }); } catch {}

const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS admins (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    username  TEXT UNIQUE NOT NULL,
    password  TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS clients (
    id           TEXT PRIMARY KEY,
    name         TEXT NOT NULL,
    email        TEXT,
    agent_type   TEXT NOT NULL DEFAULT 'hermes',
    install_token TEXT UNIQUE NOT NULL,
    created_at   TEXT DEFAULT (datetime('now')),
    notes        TEXT
  );

  CREATE TABLE IF NOT EXISTS machines (
    machine_id   TEXT PRIMARY KEY,
    client_id    TEXT REFERENCES clients(id),
    hostname     TEXT,
    os           TEXT,
    os_release   TEXT,
    architecture TEXT,
    agent_type   TEXT,
    agent_version TEXT,
    hermes_version TEXT,
    docker_container TEXT,
    disk_total_gb REAL,
    disk_free_gb  REAL,
    tailscale_ip        TEXT,
    tailscale_connected INTEGER DEFAULT 0,
    last_seen    TEXT,
    connected_at TEXT,
    online       INTEGER DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    machine_id  TEXT REFERENCES machines(machine_id),
    client_id   TEXT REFERENCES clients(id),
    type        TEXT NOT NULL,
    message     TEXT,
    data        TEXT,
    created_at  TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS commands (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    machine_id  TEXT,
    cmd         TEXT,
    output      TEXT,
    returncode  INTEGER,
    timed_out   INTEGER DEFAULT 0,
    sent_at     TEXT DEFAULT (datetime('now')),
    replied_at  TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_events_machine ON events(machine_id);
  CREATE INDEX IF NOT EXISTS idx_events_created ON events(created_at);
  CREATE INDEX IF NOT EXISTS idx_machines_client ON machines(client_id);
`);

// ── Migrations: add new columns to existing DBs without wiping data ──────────
const migrations = [
  `ALTER TABLE machines ADD COLUMN tailscale_ip TEXT`,
  `ALTER TABLE machines ADD COLUMN tailscale_connected INTEGER DEFAULT 0`,
];
for (const sql of migrations) {
  try { db.exec(sql); } catch (_) { /* column already exists — safe to ignore */ }
}

module.exports = db;
