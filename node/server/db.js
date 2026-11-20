'use strict';
const path = require('path');
const fs = require('fs');
const Database = require('better-sqlite3');

const DATA = path.resolve(process.env.DATA_DIR || path.join(__dirname, '..', 'data'));
for (const d of ['files', 'versions', 'tmp']) fs.mkdirSync(path.join(DATA, d), { recursive: true });

const db = new Database(path.join(DATA, 'drive.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL COLLATE NOCASE,
  name TEXT NOT NULL,
  password TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user',
  quota INTEGER NOT NULL DEFAULT 0,
  disabled INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  last_login INTEGER
);
CREATE TABLE IF NOT EXISTS items(
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  parent_id TEXT REFERENCES items(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  size INTEGER NOT NULL DEFAULT 0,
  mime TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  description TEXT,
  trashed_at INTEGER,
  trash_root INTEGER NOT NULL DEFAULT 0,
  created INTEGER NOT NULL,
  modified INTEGER NOT NULL,
  modified_by TEXT
);
CREATE INDEX IF NOT EXISTS idx_items_parent ON items(parent_id);
CREATE INDEX IF NOT EXISTS idx_items_owner ON items(owner_id);
CREATE TABLE IF NOT EXISTS stars(
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  PRIMARY KEY(user_id, item_id)
);
CREATE TABLE IF NOT EXISTS versions(
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  size INTEGER NOT NULL,
  created INTEGER NOT NULL,
  author TEXT
);
CREATE TABLE IF NOT EXISTS access(
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  perm TEXT NOT NULL,
  created INTEGER NOT NULL,
  PRIMARY KEY(item_id, user_id)
);
CREATE TABLE IF NOT EXISTS links(
  token TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  mode TEXT NOT NULL,
  password TEXT,
  expires INTEGER,
  created_by TEXT NOT NULL,
  created INTEGER NOT NULL,
  views INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS activity(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT,
  user_id TEXT,
  user_name TEXT,
  action TEXT NOT NULL,
  detail TEXT,
  at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_act_item ON activity(item_id);
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS team_members(
  team_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  PRIMARY KEY(team_id, user_id)
);
CREATE TABLE IF NOT EXISTS comments(
  id TEXT PRIMARY KEY,
  item_id TEXT NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  user_id TEXT,
  user_name TEXT,
  text TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_item ON comments(item_id);
CREATE TABLE IF NOT EXISTS app_passwords(
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  hash TEXT NOT NULL,
  created INTEGER NOT NULL,
  last_used INTEGER
);
CREATE VIRTUAL TABLE IF NOT EXISTS fts USING fts5(item_id UNINDEXED, name, content, tokenize='unicode61 remove_diacritics 2');
`);

// Migrations (ajout de colonnes sur une base existante)
function addCol(table, col, def) {
  if (!db.prepare(`PRAGMA table_info(${table})`).all().some(c => c.name === col)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${col} ${def}`);
}
addCol('users', 'kind', "TEXT NOT NULL DEFAULT 'user'");
addCol('users', 'totp_secret', 'TEXT');
addCol('users', 'totp_pending', 'TEXT');
addCol('users', 'recovery', 'TEXT');
addCol('items', 'color', 'TEXT');
addCol('items', 'indexed', 'INTEGER NOT NULL DEFAULT 0');

module.exports = { db, DATA };
