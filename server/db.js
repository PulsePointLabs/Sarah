import Database from 'better-sqlite3';
import path from 'node:path';
import fs from 'node:fs';
import { databasePath } from './config.js';

const dbPath = databasePath;
fs.mkdirSync(path.dirname(dbPath), { recursive: true });

export const db = new Database(dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

export const ENTITY_NAMES = [
  'Session',
  'BodyExploration',
  'HeartRateTimeline',
  'EMGTimeline',
  'AudioExport',
  'SessionReviewVideo',
  'CompareAnalysisResult',
  'CascadeAnalysisResult',
  'SessionClusterAnalysis',
  'Journal',
  'CustomMethod',
  'ProcessingJob',
  'User',
];

export function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS entities (
      entity TEXT NOT NULL,
      id TEXT NOT NULL,
      created_date TEXT,
      updated_date TEXT,
      data TEXT NOT NULL,
      PRIMARY KEY (entity, id)
    );
    CREATE INDEX IF NOT EXISTS idx_entities_entity_created ON entities(entity, created_date);
    CREATE INDEX IF NOT EXISTS idx_entities_entity_updated ON entities(entity, updated_date);

    CREATE TABLE IF NOT EXISTS local_vision_results (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      record_type TEXT NOT NULL,
      video_path TEXT NOT NULL,
      start_ms INTEGER NOT NULL,
      end_ms INTEGER NOT NULL,
      engine TEXT NOT NULL,
      model_name TEXT,
      analysis_type TEXT NOT NULL DEFAULT 'window',
      result_json TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_local_vision_results_session ON local_vision_results(session_id, record_type, created_at);
  `);

  const localVisionColumns = db.prepare("PRAGMA table_info(local_vision_results)").all().map((row) => row.name);
  if (!localVisionColumns.includes('model_name')) {
    db.exec("ALTER TABLE local_vision_results ADD COLUMN model_name TEXT");
  }
  if (!localVisionColumns.includes('analysis_type')) {
    db.exec("ALTER TABLE local_vision_results ADD COLUMN analysis_type TEXT NOT NULL DEFAULT 'window'");
  }

  const count = db.prepare("SELECT COUNT(*) AS c FROM entities WHERE entity = 'User'").get().c;
  if (!count) {
    const now = new Date().toISOString();
    upsertEntity('User', 'local-user', {
      id: 'local-user',
      email: 'local@example.com',
      full_name: 'Local User',
      created_date: now,
      updated_date: now,
    });
  }
}

export function nowIso() { return new Date().toISOString(); }
export function safeJsonParse(s) { try { return JSON.parse(s); } catch { return null; } }

export function normalizeEntityName(name) {
  const hit = ENTITY_NAMES.find((n) => n.toLowerCase() === String(name).toLowerCase());
  if (!hit) throw new Error(`Unknown entity: ${name}`);
  return hit;
}

export function listEntities(entity) {
  return db.prepare('SELECT data FROM entities WHERE entity = ?').all(entity).map((r) => safeJsonParse(r.data)).filter(Boolean);
}

export function getEntity(entity, id) {
  const row = db.prepare('SELECT data FROM entities WHERE entity = ? AND id = ?').get(entity, id);
  return row ? safeJsonParse(row.data) : null;
}

export function upsertEntity(entity, id, data) {
  const existing = getEntity(entity, id);
  const now = nowIso();
  const doc = {
    ...(existing || {}),
    ...data,
    id,
    created_date: data.created_date || existing?.created_date || now,
    updated_date: data.updated_date || now,
  };
  db.prepare(`
    INSERT INTO entities(entity, id, created_date, updated_date, data)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(entity, id) DO UPDATE SET
      created_date = excluded.created_date,
      updated_date = excluded.updated_date,
      data = excluded.data
  `).run(entity, id, doc.created_date, doc.updated_date, JSON.stringify(doc));
  return doc;
}

export function deleteEntity(entity, id) {
  const info = db.prepare('DELETE FROM entities WHERE entity = ? AND id = ?').run(entity, id);
  return { ok: true, deleted: info.changes };
}

export function bulkCreate(entity, docs) {
  const insert = db.prepare(`
    INSERT OR REPLACE INTO entities(entity, id, created_date, updated_date, data)
    VALUES (?, ?, ?, ?, ?)
  `);
  const tx = db.transaction((items) => {
    for (const item of items) {
      const id = item.id || crypto.randomUUID();
      const now = nowIso();
      const doc = {
        ...item,
        id,
        created_date: item.created_date || now,
        updated_date: item.updated_date || now,
      };
      insert.run(entity, id, doc.created_date, doc.updated_date, JSON.stringify(doc));
    }
  });
  tx(docs || []);
}
