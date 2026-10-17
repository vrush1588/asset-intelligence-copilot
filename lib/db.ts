import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";

export const DB_PATH = process.env.COPILOT_DB ?? path.join(process.cwd(), "data", "copilot.db");

// Data tables are rebuilt by every ingest. Memory tables (corrections from users, shared facts,
// rule overrides, conversations) survive re-ingest so a new dataset loads alongside them.
export const DATA_SCHEMA = `
CREATE TABLE areas (area_id TEXT PRIMARY KEY, name TEXT, team_id TEXT, lat REAL, lon REAL);
CREATE TABLE teams (team_id TEXT PRIMARY KEY, name TEXT, lead_user_id TEXT);
CREATE TABLE users (user_id TEXT PRIMARY KEY, name TEXT, role TEXT, team_id TEXT);
CREATE TABLE wells (
  asset_id TEXT PRIMARY KEY, name TEXT, well_type TEXT, area_id TEXT, team_id TEXT,
  in_charge_user_id TEXT, lat REAL, lon REAL, installed_on TEXT, recorded_status TEXT,
  last_inspection_id TEXT, source_root TEXT);
CREATE TABLE equipment (equipment_id TEXT PRIMARY KEY, asset_id TEXT, kind TEXT, model TEXT);
CREATE TABLE inspections (
  inspection_id TEXT PRIMARY KEY, asset_id TEXT, inspected_at TEXT, inspector_user_id TEXT,
  method TEXT, ambient_temp_c REAL, wellhead_temp_c REAL, spill_detected INTEGER,
  spill_area_pct REAL, spill_est_volume_bbl REAL, evidence_images TEXT, notes TEXT);
CREATE INDEX ix_ins_asset ON inspections(asset_id, inspected_at);
CREATE TABLE maintenance (
  maintenance_id TEXT PRIMARY KEY, asset_id TEXT, started_at TEXT, completed_at TEXT,
  maintenance_type TEXT, equipment_kind TEXT, issue TEXT, action_taken TEXT,
  technician_user_id TEXT, contractor TEXT, downtime_hours REAL,
  cost_labor REAL, cost_parts REAL, cost_total REAL,
  triggered_by_inspection_id TEXT, report_file TEXT);
CREATE INDEX ix_mnt_asset ON maintenance(asset_id, started_at);
CREATE INDEX ix_mnt_trig ON maintenance(triggered_by_inspection_id);
CREATE TABLE reports (
  maintenance_id TEXT PRIMARY KEY, asset_id TEXT, path TEXT, text TEXT,
  containment_hours REAL, spill_class TEXT, report_written TEXT);
CREATE TABLE report_checks (maintenance_id TEXT, protocol TEXT, result TEXT, detail TEXT);
CREATE INDEX ix_rc_m ON report_checks(maintenance_id);
CREATE TABLE reg_events (
  event_id TEXT PRIMARY KEY, asset_id TEXT, date TEXT, agency TEXT, event_type TEXT,
  protocol_id TEXT, related_inspection_id TEXT, hours_to_report REAL, detail TEXT,
  fine_usd REAL, status TEXT);
CREATE TABLE notes (
  note_id TEXT PRIMARY KEY, asset_id TEXT, created_at TEXT, author_user_id TEXT,
  note_type TEXT, inspection_id TEXT, text TEXT, valid_from TEXT, valid_to TEXT);
CREATE TABLE docs (doc_id TEXT PRIMARY KEY, title TEXT, path TEXT, kind TEXT, text TEXT);
CREATE TABLE doc_chunks (chunk_id INTEGER PRIMARY KEY, doc_id TEXT, section TEXT, text TEXT);
CREATE VIRTUAL TABLE search_fts USING fts5(ref_type, ref_id, asset_id, title, body, tokenize='porter');
CREATE TABLE rules (
  rule_key TEXT, scope_type TEXT, scope_value TEXT, value REAL, unit TEXT,
  source_doc TEXT, source_section TEXT, quote TEXT,
  PRIMARY KEY (rule_key, scope_type, scope_value));
CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT);
`;

export const DATA_TABLES = [
  "areas", "teams", "users", "wells", "equipment", "inspections", "maintenance", "reports",
  "report_checks", "reg_events", "notes", "docs", "doc_chunks", "search_fts", "rules", "meta",
];

export const MEMORY_SCHEMA = `
CREATE TABLE IF NOT EXISTS corrections (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  inspection_id TEXT NOT NULL, asset_id TEXT NOT NULL,
  field TEXT NOT NULL,            -- wellhead_temp_c | ambient_temp_c | spill_est_volume_bbl | spill_detected
  original_value REAL, new_value REAL,
  author_user_id TEXT, reason TEXT,
  source TEXT NOT NULL,           -- 'note:<note_id>' from the dataset, or 'chat'
  status TEXT NOT NULL DEFAULT 'accepted',   -- accepted | unconfirmed
  conflicts TEXT,                 -- JSON list of evidence that disagrees
  created_at TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS ix_corr ON corrections(inspection_id, field, status);
CREATE TABLE IF NOT EXISTS shared_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  asset_id TEXT, kind TEXT, text TEXT, claimed_producing INTEGER,
  valid_from TEXT, valid_to TEXT, author_user_id TEXT,
  status TEXT NOT NULL DEFAULT 'accepted',   -- accepted | unconfirmed
  conflicts TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS rule_overrides (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  rule_key TEXT, scope_type TEXT, scope_value TEXT, value REAL,
  qualifier TEXT,                 -- optional, e.g. equipment kind for rca_count
  author_user_id TEXT, reason TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id TEXT, title TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT, conversation_id INTEGER, role TEXT,
  content TEXT, payload TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS answer_ratings (
  id INTEGER PRIMARY KEY AUTOINCREMENT, message_id INTEGER, user_id TEXT,
  rating INTEGER,                 -- 1 helpful, -1 not helpful
  comment TEXT, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS conversation_entities (
  conversation_id INTEGER, user_id TEXT, entity_type TEXT, entity_id TEXT,
  rank INTEGER, created_at TEXT NOT NULL);
`;

// Which database is live. Ingest builds a new file and then points data/active.json at it, so a
// running server switches to new data without downtime. COPILOT_DB pins one file (eval, probe).
export const DATA_DIR = path.join(process.cwd(), "data");
export const ACTIVE_FILE = path.join(DATA_DIR, "active.json");

export function activeDbPath(): string {
  if (process.env.COPILOT_DB) return process.env.COPILOT_DB;
  try {
    const { db: file } = JSON.parse(fs.readFileSync(ACTIVE_FILE, "utf8"));
    if (file && fs.existsSync(path.join(DATA_DIR, file))) return path.join(DATA_DIR, file);
  } catch { /* no pointer yet */ }
  return DB_PATH;
}

export function openDb(file: string): Database.Database {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const d = new Database(file);
  d.pragma("journal_mode = WAL");
  d.exec(MEMORY_SCHEMA);
  const cols = (d.prepare(`PRAGMA table_info(rule_overrides)`).all() as any[]).map((c) => c.name);
  if (!cols.includes("qualifier")) d.exec(`ALTER TABLE rule_overrides ADD COLUMN qualifier TEXT`);
  return d;
}

let _db: Database.Database | null = null;
let _path = "";
let _checked = 0;
let _generation = 0;

/** Bumps whenever the live database changes, so caches can reset. */
export const dbGeneration = () => _generation;

export function db(): Database.Database {
  const now = Date.now();
  if (_db && (process.env.COPILOT_DB || now - _checked < 1000)) return _db;
  _checked = now;
  const file = activeDbPath();
  if (_db && file === _path) return _db;
  const next = openDb(file);
  const old = _db;
  _db = next;
  _path = file;
  _generation++;
  try { old?.close(); } catch { /* already closed */ }
  return _db;
}

export const currentDbPath = () => _path || activeDbPath();

export function closeDb() {
  _db?.close();
  _db = null;
  _path = "";
}
