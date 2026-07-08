/**
 * 小合自己的 SQLite（不碰 panel）。存陪伴的跨天状态：人 / 对话轮 / 关系上下文 / 待跟进 / 主动关心钩子。
 * 长期人物画像仍在 src/memory/ 的 markdown，不进这里。
 *
 * 默认 src/db/companion.sqlite；生产设 XIAOHE_DB_PATH 指向挂载卷（跟 XIAOHE_MEMORY_DIR 一样别丢）。
 */
import Database from 'better-sqlite3';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

const DEFAULT_PATH = join(dirname(fileURLToPath(import.meta.url)), 'companion.sqlite');
const DB_PATH = process.env.XIAOHE_DB_PATH || DEFAULT_PATH;
mkdirSync(dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
CREATE TABLE IF NOT EXISTS companion_people (
  open_id TEXT PRIMARY KEY,
  display_name TEXT,
  enabled INTEGER NOT NULL DEFAULT 1,
  timezone TEXT DEFAULT 'Asia/Shanghai',
  quiet_hours_json TEXT,
  last_user_at TEXT,
  last_bot_at TEXT,
  last_active_at TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS companion_turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  open_id TEXT NOT NULL,
  direction TEXT NOT NULL CHECK(direction IN ('inbound','outbound')),
  source TEXT NOT NULL DEFAULT 'feishu' CHECK(source IN ('feishu','proactive','system')),
  user_text TEXT,
  assistant_text TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_turns_open ON companion_turns(open_id, id);

CREATE TABLE IF NOT EXISTS companion_context (
  open_id TEXT PRIMARY KEY,
  recent_summary TEXT,
  active_threads_json TEXT,
  last_summarized_turn_id INTEGER DEFAULT 0,
  compact_failures INTEGER DEFAULT 0,
  token_factor REAL,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS companion_followups (
  id TEXT PRIMARY KEY,
  open_id TEXT NOT NULL,
  content TEXT NOT NULL,
  due_at TEXT,
  status TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','sent','done','cancelled','expired')),
  source TEXT,
  last_prompted_at TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_followups_open ON companion_followups(open_id, status);

CREATE TABLE IF NOT EXISTS companion_hooks (
  id TEXT PRIMARY KEY,
  open_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK(kind IN ('morning','evening','weekend','followup','anniversary','festival','custom')),
  fire_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','fired','skipped','cancelled')),
  payload_json TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  fired_at TEXT,
  skip_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_hooks_fire ON companion_hooks(status, fire_at);

CREATE TABLE IF NOT EXISTS companion_outreach_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  open_id TEXT NOT NULL,
  hook_id TEXT,
  kind TEXT,
  decision TEXT CHECK(decision IN ('send','skip')),
  reason TEXT,
  message TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);
`);

console.log(`[Xiaohe/DB] SQLite 就绪 @ ${DB_PATH}`);

export default db;
