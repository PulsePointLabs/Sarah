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
  'BloodPressureReading',
  'BloodGlucoseReading',
  'BodyCompositionReading',
  'PulseOxReading',
  'HowlTelemetry',
  'HowlControlCommand',
  'HowlControlSettings',
  'AudioExport',
  'SessionReviewVideo',
  'CompareAnalysisResult',
  'CascadeAnalysisResult',
  'SessionClusterAnalysis',
  'Journal',
  'CustomMethod',
  'ProcessingJob',
  'SessionRecording',
  'RecordingUpload',
  'RenderedVideo',
  'RenderPreset',
  'User',
  'SarahVsVitalsTransfer',
  'SarahMemory',
  'SarahConversationState',
  'SarahLanguageProfile',
  'AICorrectionMemory',
  'AppSetting',
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
    CREATE INDEX IF NOT EXISTS idx_entities_entity_session
      ON entities(entity, json_extract(data, '$.session'))
      WHERE json_extract(data, '$.session') IS NOT NULL;
    CREATE INDEX IF NOT EXISTS idx_entities_processing_job_status_updated
      ON entities(entity, json_extract(data, '$.status'), updated_date)
      WHERE entity = 'ProcessingJob';
    CREATE INDEX IF NOT EXISTS idx_entities_processing_job_type_updated
      ON entities(entity, json_extract(data, '$.type'), updated_date)
      WHERE entity = 'ProcessingJob';

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

    CREATE TABLE IF NOT EXISTS local_telemetry_events (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      kind TEXT NOT NULL,
      source TEXT NOT NULL,
      wall_time_ms INTEGER NOT NULL,
      monotonic_ms REAL NOT NULL,
      received_at TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_local_telemetry_events_session ON local_telemetry_events(session_id, kind, wall_time_ms);
    CREATE INDEX IF NOT EXISTS idx_local_telemetry_events_kind_time ON local_telemetry_events(kind, wall_time_ms);

    CREATE TABLE IF NOT EXISTS profile_anatomy_image_classifications (
      file_hash TEXT NOT NULL,
      classification_version TEXT NOT NULL,
      image_id TEXT NOT NULL,
      source_type TEXT NOT NULL,
      source_url TEXT,
      classifier_model TEXT NOT NULL,
      classified_at TEXT NOT NULL,
      classification_json TEXT NOT NULL,
      PRIMARY KEY (file_hash, classification_version)
    );
    CREATE INDEX IF NOT EXISTS idx_profile_anatomy_classification_image
      ON profile_anatomy_image_classifications(image_id, classification_version);
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

const ENTITY_FIELD_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

function normalizedEntityFields(fields = []) {
  const requested = Array.isArray(fields) ? fields : [];
  return [...new Set([
    ...requested,
    'id',
    'created_date',
    'updated_date',
  ].map((field) => String(field || '').trim()).filter((field) => ENTITY_FIELD_NAME.test(field)))];
}

function projectedEntityJsonSql(fields = []) {
  const safeFields = normalizedEntityFields(fields);
  if (!safeFields.length) return null;
  const args = safeFields.flatMap((field) => [
    `'${field}'`,
    `json_extract(data, '$.${field}')`,
  ]);
  return `json_object(${args.join(', ')})`;
}

export function listEntityPage(entity, { sort = '', limit, skip = 0, fields = [] } = {}) {
  const selectedJson = fields?.length ? projectedEntityJsonSql(fields) : 'data';
  const params = [entity];
  const clauses = ['entity = ?'];
  let orderSql = '';
  const sortValue = String(sort || '').trim();
  if (sortValue) {
    const descending = sortValue.startsWith('-');
    const sortField = descending ? sortValue.slice(1) : sortValue;
    if (ENTITY_FIELD_NAME.test(sortField)) {
      const indexedColumn = ['id', 'created_date', 'updated_date'].includes(sortField)
        ? sortField
        : null;
      orderSql = indexedColumn
        ? ` ORDER BY ${indexedColumn} ${descending ? 'DESC' : 'ASC'}`
        : ` ORDER BY json_extract(data, ?) ${descending ? 'DESC' : 'ASC'}`;
      if (!indexedColumn) params.push(`$.${sortField}`);
    }
  }

  let pageSql = '';
  if (limit != null && Number.isFinite(Number(limit))) {
    pageSql = ' LIMIT ? OFFSET ?';
    params.push(Math.max(0, Math.min(10000, Math.trunc(Number(limit)))));
    params.push(Math.max(0, Math.trunc(Number(skip) || 0)));
  } else if (Number(skip) > 0) {
    pageSql = ' LIMIT -1 OFFSET ?';
    params.push(Math.max(0, Math.trunc(Number(skip))));
  }

  return db.prepare(`SELECT ${selectedJson} AS data FROM entities WHERE ${clauses.join(' AND')}${orderSql}${pageSql}`)
    .all(...params)
    .map((row) => safeJsonParse(row.data))
    .filter(Boolean);
}

export function getEntityFields(entity, id, fields = []) {
  if (!fields?.length) return getEntity(entity, id);
  const selectedJson = projectedEntityJsonSql(fields);
  const row = db.prepare(`SELECT ${selectedJson} AS data FROM entities WHERE entity = ? AND id = ?`).get(entity, id);
  return row ? safeJsonParse(row.data) : null;
}

export function listEntitiesByExactCriteria(entity, criteria = {}) {
  const entries = Object.entries(criteria || {});
  if (!entries.length) return null;
  if (entries.some(([key, value]) => (
    !/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)
    || value === null
    || (typeof value === 'object' && value !== null)
    || !['string', 'number', 'boolean'].includes(typeof value)
  ))) return null;

  const clauses = ['entity = ?'];
  const params = [entity];
  for (const [key, rawValue] of entries) {
    const value = typeof rawValue === 'boolean' ? Number(rawValue) : rawValue;
    if (key === 'id') {
      clauses.push('id = ?');
      params.push(String(value));
    } else {
      clauses.push("json_extract(data, ?) = ?");
      params.push(`$.${key}`, value);
    }
  }

  return db.prepare(`SELECT data FROM entities WHERE ${clauses.join(' AND ')}`)
    .all(...params)
    .map((row) => safeJsonParse(row.data))
    .filter(Boolean);
}

export function getProfileAnatomyImageClassification(fileHash, classificationVersion) {
  const row = db.prepare(`
    SELECT *
    FROM profile_anatomy_image_classifications
    WHERE file_hash = ? AND classification_version = ?
  `).get(fileHash, classificationVersion);
  if (!row) return null;
  return {
    fileHash: row.file_hash,
    classificationVersion: row.classification_version,
    imageId: row.image_id,
    sourceType: row.source_type,
    sourceUrl: row.source_url || '',
    classifierModel: row.classifier_model,
    classifiedAt: row.classified_at,
    classification: safeJsonParse(row.classification_json),
  };
}

export function upsertProfileAnatomyImageClassification(record = {}) {
  db.prepare(`
    INSERT INTO profile_anatomy_image_classifications(
      file_hash, classification_version, image_id, source_type, source_url,
      classifier_model, classified_at, classification_json
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(file_hash, classification_version) DO UPDATE SET
      image_id = excluded.image_id,
      source_type = excluded.source_type,
      source_url = excluded.source_url,
      classifier_model = excluded.classifier_model,
      classified_at = excluded.classified_at,
      classification_json = excluded.classification_json
  `).run(
    record.fileHash,
    record.classificationVersion,
    record.imageId,
    record.sourceType,
    record.sourceUrl || '',
    record.classifierModel,
    record.classifiedAt || nowIso(),
    JSON.stringify(record.classification || {}),
  );
  return getProfileAnatomyImageClassification(record.fileHash, record.classificationVersion);
}

const PROFILE_REVIEW_RESULT_KEYS = new Set([
  'pelvic_genital_image_review_result',
  'head_to_toe_image_review_result',
]);
const PROFILE_REVIEW_ARCHIVE_KEYS = new Set([
  'pelvic_genital_image_review_archive',
  'head_to_toe_image_review_archive',
]);

export function listLatestProfileReviewEvidenceSlices(resultKey, archiveKey, archiveLimit = 10) {
  if (!PROFILE_REVIEW_RESULT_KEYS.has(resultKey) || !PROFILE_REVIEW_ARCHIVE_KEYS.has(archiveKey)) {
    throw new Error('Unsupported profile review evidence keys.');
  }
  const limit = Math.max(0, Math.min(30, Number(archiveLimit) || 0));
  const rows = db.prepare(`
    WITH latest AS (
      SELECT data
      FROM entities
      WHERE entity = 'SessionClusterAnalysis'
      ORDER BY COALESCE(updated_date, created_date) DESC
      LIMIT 1
    )
    SELECT
      -1 AS archive_index,
      json_extract(data, ?) AS reviewed_images,
      json_extract(data, ?) AS annotated_images
    FROM latest
    UNION ALL
    SELECT
      CAST(entry.key AS INTEGER) AS archive_index,
      json_extract(entry.value, '$.result._meta.reviewed_images') AS reviewed_images,
      json_extract(entry.value, '$.result.annotated_images') AS annotated_images
    FROM latest, json_each(json_extract(latest.data, ?)) AS entry
    WHERE CAST(entry.key AS INTEGER) < ?
    ORDER BY archive_index
  `).all(
    `$.${resultKey}._meta.reviewed_images`,
    `$.${resultKey}.annotated_images`,
    `$.${archiveKey}`,
    limit,
  );
  return rows.map((row) => ({
    archiveIndex: Number(row.archive_index),
    result: {
      _meta: { reviewed_images: safeJsonParse(row.reviewed_images) || [] },
      annotated_images: safeJsonParse(row.annotated_images) || [],
    },
  }));
}

export function listProcessingJobSummaries({ type = '', statuses = [], meta = {}, limit = 100, includeCleared = false } = {}) {
  const clauses = [];
  const requestedLimit = Math.max(1, Math.min(500, Number(limit) || 100));
  const params = includeCleared
    ? []
    : [Math.max(500, requestedLimit * 5)];
  if (type) {
    clauses.push("json_extract(data, '$.type') = ?");
    params.push(type);
  }
  if (Array.isArray(statuses) && statuses.length) {
    clauses.push(`json_extract(data, '$.status') IN (${statuses.map(() => '?').join(', ')})`);
    params.push(...statuses);
  }
  if (!includeCleared) {
    clauses.push("json_extract(data, '$.meta.clearedAt') IS NULL");
  }
  for (const [key, value] of Object.entries(meta || {})) {
    if (value === undefined || value === null || value === '') continue;
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    clauses.push(`json_extract(data, '$.meta.${key}') = ?`);
    params.push(String(value));
  }
  params.push(requestedLimit);
  const recentJobsCte = includeCleared ? '' : `
    WITH recent_jobs AS (
      SELECT data, updated_date
      FROM entities
      WHERE entity = 'ProcessingJob'
      ORDER BY updated_date DESC
      LIMIT ?
    )
  `;
  const source = includeCleared ? 'entities' : 'recent_jobs';
  if (includeCleared) clauses.unshift("entity = 'ProcessingJob'");
  return db.prepare(`
    ${recentJobsCte}
    SELECT json_set(
      json_remove(data, '$.result', '$.payload', '$.progress.completed_batch_results', '$.meta.reviewed_images'),
      '$.hasResult',
      CASE WHEN json_type(data, '$.result') IS NOT NULL THEN 1 ELSE 0 END,
      '$.result_summary',
      CASE
        WHEN json_type(data, '$.result') IS NULL THEN NULL
        ELSE json_object(
          'file_url', COALESCE(json_extract(data, '$.result.file_url'), json_extract(data, '$.result.record.file_url')),
          'stream_url', COALESCE(json_extract(data, '$.result.stream_url'), json_extract(data, '$.result.record.stream_url')),
          'download_url', COALESCE(json_extract(data, '$.result.download_url'), json_extract(data, '$.result.record.download_url')),
          'manifest_url', COALESCE(json_extract(data, '$.result.manifest_url'), json_extract(data, '$.result.record.manifest_url')),
          'filename', COALESCE(json_extract(data, '$.result.filename'), json_extract(data, '$.result.record.filename')),
          'size', COALESCE(json_extract(data, '$.result.size'), json_extract(data, '$.result.size_bytes'), json_extract(data, '$.result.record.size'), json_extract(data, '$.result.record.size_bytes')),
          'duration_seconds', COALESCE(json_extract(data, '$.result.duration_seconds'), json_extract(data, '$.result.record.duration_seconds')),
          'mime_type', COALESCE(json_extract(data, '$.result.mime_type'), json_extract(data, '$.result.content_type'), json_extract(data, '$.result.record.mime_type'), json_extract(data, '$.result.record.content_type'))
        )
      END
    ) AS data
    FROM ${source}
    ${clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''}
    ORDER BY updated_date DESC
    LIMIT ?
  `).all(...params).map((r) => safeJsonParse(r.data)).filter(Boolean);
}

export function listRecoverableProcessingJobs() {
  return db.prepare(`
    SELECT data
    FROM entities
    WHERE entity = 'ProcessingJob'
      AND json_extract(data, '$.status') IN ('queued', 'running')
  `).all().map((r) => safeJsonParse(r.data)).filter(Boolean);
}

export function getEntity(entity, id) {
  const row = db.prepare('SELECT data FROM entities WHERE entity = ? AND id = ?').get(entity, id);
  return row ? safeJsonParse(row.data) : null;
}

const MAX_CLIMAX_SAMPLE_DELTA_SECONDS = 5;

function syncSessionClimaxHeartRate(sessionId) {
  const session = getEntity('Session', sessionId);
  const climaxOffset = Number(session?.climax_offset_s);
  if (!session || session.no_climax || session.telemetry_only || !Number.isFinite(climaxOffset) || climaxOffset < 0) {
    return session;
  }

  const row = db.prepare(`
    SELECT data,
      ABS(CAST(json_extract(data, '$.time_offset_s') AS REAL) - ?) AS sample_delta_s
    FROM entities
    WHERE entity = 'HeartRateTimeline'
      AND json_extract(data, '$.session') = ?
      AND json_type(data, '$.time_offset_s') IN ('integer', 'real')
      AND json_type(data, '$.hr') IN ('integer', 'real')
    ORDER BY sample_delta_s ASC
    LIMIT 1
  `).get(climaxOffset, sessionId);
  if (!row || Number(row.sample_delta_s) > MAX_CLIMAX_SAMPLE_DELTA_SECONDS) return session;

  const sample = safeJsonParse(row.data);
  const heartRate = Number(sample?.hr);
  const sampleOffset = Number(sample?.time_offset_s);
  if (!Number.isFinite(heartRate) || heartRate < 20 || heartRate > 260 || !Number.isFinite(sampleOffset)) return session;

  const updated = {
    ...session,
    hr_at_climax: Math.round(heartRate),
    hr_at_climax_source: 'timeline_marker_sample',
    hr_at_climax_sample_offset_s: sampleOffset,
    hr_at_climax_sample_delta_s: Number(Number(row.sample_delta_s).toFixed(3)),
    updated_date: nowIso(),
  };
  db.prepare(`
    UPDATE entities SET updated_date = ?, data = ?
    WHERE entity = 'Session' AND id = ?
  `).run(updated.updated_date, JSON.stringify(updated), sessionId);
  return updated;
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
  return entity === 'Session' ? syncSessionClimaxHeartRate(id) : doc;
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
  if (entity === 'HeartRateTimeline') {
    const sessionIds = new Set((docs || []).map((item) => item?.session).filter(Boolean));
    for (const sessionId of sessionIds) syncSessionClimaxHeartRate(sessionId);
  }
}
