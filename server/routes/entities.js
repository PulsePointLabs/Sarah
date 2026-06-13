import express from 'express';
import { bulkCreate, deleteEntity, getEntity, listEntities, normalizeEntityName, upsertEntity } from '../db.js';

export const entitiesRouter = express.Router();

function coerceValue(value) {
  if (value === 'true') return true;
  if (value === 'false') return false;
  if (value === 'null') return null;
  if (value !== '' && !Number.isNaN(Number(value)) && /^-?\d+(\.\d+)?$/.test(String(value))) return Number(value);
  try {
    if (typeof value === 'string' && /^[\[{]/.test(value.trim())) return JSON.parse(value);
  } catch {}
  return value;
}

function matches(doc, criteria = {}) {
  return Object.entries(criteria || {}).every(([key, expected]) => {
    const actual = doc?.[key];
    if (Array.isArray(expected)) return expected.includes(actual);
    if (expected && typeof expected === 'object' && !Array.isArray(expected)) {
      if ('$in' in expected) return expected.$in.includes(actual);
      if ('$ne' in expected) return actual !== expected.$ne;
      if ('$gt' in expected && !(actual > expected.$gt)) return false;
      if ('$gte' in expected && !(actual >= expected.$gte)) return false;
      if ('$lt' in expected && !(actual < expected.$lt)) return false;
      if ('$lte' in expected && !(actual <= expected.$lte)) return false;
      return JSON.stringify(actual) === JSON.stringify(expected);
    }
    return actual === expected;
  });
}

function sortRows(rows, sort) {
  if (!sort) return rows;
  const desc = String(sort).startsWith('-');
  const key = desc ? String(sort).slice(1) : String(sort);
  return [...rows].sort((a, b) => {
    const av = a?.[key]; const bv = b?.[key];
    if (av == null && bv == null) return 0;
    if (av == null) return desc ? 1 : -1;
    if (bv == null) return desc ? -1 : 1;
    if (av < bv) return desc ? 1 : -1;
    if (av > bv) return desc ? -1 : 1;
    return 0;
  });
}

function limitRows(rows, limit, skip = 0) {
  const start = Number(skip || 0);
  const lim = limit == null ? rows.length : Number(limit);
  return rows.slice(start, start + lim);
}

function parseFields(value) {
  if (!value) return null;
  const fields = Array.isArray(value) ? value : String(value).split(',');
  const cleaned = fields.map((field) => String(field || '').trim()).filter(Boolean);
  return cleaned.length ? cleaned : null;
}

function publicEntity(entity, doc) {
  if (entity !== 'ProcessingJob' || !doc) return doc;
  const { payload: _payload, ...rest } = doc;
  return rest;
}

function projectEntity(doc, fields) {
  if (!fields?.length || !doc) return doc;
  const out = {};
  for (const field of fields) {
    if (field in doc) out[field] = doc[field];
  }
  if (doc.id != null) out.id = doc.id;
  if (doc.created_date != null) out.created_date = doc.created_date;
  if (doc.updated_date != null) out.updated_date = doc.updated_date;
  return out;
}

entitiesRouter.get('/:entity', (req, res) => {
  const entity = normalizeEntityName(req.params.entity);
  const fields = parseFields(req.query.fields);
  const rows = sortRows(listEntities(entity), req.query.sort);
  res.json(limitRows(rows, req.query.limit, req.query.skip).map((row) => projectEntity(publicEntity(entity, row), fields)));
});

entitiesRouter.post('/:entity/filter', (req, res) => {
  const entity = normalizeEntityName(req.params.entity);
  const { criteria = {}, sort, limit, skip, fields: rawFields } = req.body || {};
  const fields = parseFields(rawFields);
  const rows = sortRows(listEntities(entity).filter((r) => matches(r, criteria)), sort);
  res.json(limitRows(rows, limit, skip).map((row) => projectEntity(publicEntity(entity, row), fields)));
});

entitiesRouter.post('/:entity', (req, res) => {
  const entity = normalizeEntityName(req.params.entity);
  const doc = upsertEntity(entity, req.body?.id || crypto.randomUUID(), req.body || {});
  res.json(publicEntity(entity, doc));
});

entitiesRouter.post('/:entity/bulk', (req, res) => {
  const entity = normalizeEntityName(req.params.entity);
  const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
  bulkCreate(entity, rows);
  res.json({ ok: true, inserted: rows.length });
});

entitiesRouter.patch('/:entity/:id', (req, res) => {
  const entity = normalizeEntityName(req.params.entity);
  const existing = getEntity(entity, req.params.id);
  if (!existing) return res.status(404).json({ error: 'Not found' });
  res.json(publicEntity(entity, upsertEntity(entity, req.params.id, { ...existing, ...(req.body || {}) })));
});

entitiesRouter.delete('/:entity/:id', (req, res) => {
  const entity = normalizeEntityName(req.params.entity);
  res.json(deleteEntity(entity, req.params.id));
});
