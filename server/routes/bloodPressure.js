import express from 'express';
import { getEntity, listEntities, upsertEntity } from '../db.js';

export const bloodPressureRouter = express.Router();

function cleanNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function cleanText(value, fallback = '') {
  return String(value ?? fallback).trim();
}

function isoOrNull(value) {
  if (!value) return null;
  const t = new Date(value).getTime();
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

function stableReadingId(reading = {}) {
  const external = cleanText(reading.external_id || reading.platform_id || reading.health_connect_id);
  if (external) return `bp-${external.replace(/[^a-z0-9_.:-]+/gi, '-').slice(0, 120)}`;
  const measured = isoOrNull(reading.measured_at || reading.timestamp || reading.time) || new Date().toISOString();
  return [
    'bp',
    measured.replace(/[^0-9TZ]/g, ''),
    cleanNumber(reading.systolic_mm_hg ?? reading.systolic) ?? 'sys',
    cleanNumber(reading.diastolic_mm_hg ?? reading.diastolic) ?? 'dia',
  ].join('-');
}

function normalizeReading(input = {}) {
  const measuredAt = isoOrNull(input.measured_at || input.timestamp || input.time || input.startDate);
  const systolic = cleanNumber(input.systolic_mm_hg ?? input.systolic);
  const diastolic = cleanNumber(input.diastolic_mm_hg ?? input.diastolic);
  if (!measuredAt) {
    const error = new Error('Blood pressure reading is missing a valid measured_at timestamp.');
    error.status = 400;
    throw error;
  }
  if (systolic == null || diastolic == null) {
    const error = new Error('Blood pressure reading requires numeric systolic and diastolic values.');
    error.status = 400;
    throw error;
  }
  return {
    id: input.id || stableReadingId({ ...input, measured_at: measuredAt }),
    measured_at: measuredAt,
    systolic_mm_hg: Math.round(systolic),
    diastolic_mm_hg: Math.round(diastolic),
    pulse_bpm: cleanNumber(input.pulse_bpm ?? input.pulse ?? input.heart_rate_bpm),
    source_app: cleanText(input.source_app || input.sourceApp || input.source_name || input.sourceName || 'Health Connect'),
    source_device: cleanText(input.source_device || input.sourceDevice || input.device || ''),
    source_package: cleanText(input.source_package || input.sourcePackage || ''),
    body_position: cleanText(input.body_position || input.bodyPosition || 'unknown'),
    measurement_location: cleanText(input.measurement_location || input.measurementLocation || 'unknown'),
    health_connect_id: cleanText(input.health_connect_id || input.platform_id || input.platformId || ''),
    external_id: cleanText(input.external_id || input.platform_id || input.platformId || ''),
    notes: cleanText(input.notes || input.note || ''),
    raw: input.raw && typeof input.raw === 'object' ? input.raw : undefined,
  };
}

function readingTime(reading) {
  return new Date(reading?.measured_at || 0).getTime();
}

function sortRecent(rows) {
  return [...rows].sort((a, b) => readingTime(b) - readingTime(a));
}

function sessionWindow(session, beforeHours = 8, afterHours = 4) {
  const baseMs = new Date(session?.date || session?.created_date || 0).getTime();
  if (!Number.isFinite(baseMs) || baseMs <= 0) return null;
  let startMs = baseMs;
  if (session?.start_time && /^\d{1,2}:\d{2}/.test(String(session.start_time))) {
    const date = new Date(baseMs);
    const [hour, minute] = String(session.start_time).split(':').map(Number);
    date.setHours(hour, minute, 0, 0);
    startMs = date.getTime();
  }
  const durationMs = Math.max(0, Number(session?.duration_minutes || 0)) * 60000;
  return {
    startMs: startMs - Math.max(0, Number(beforeHours || 0)) * 3600000,
    endMs: startMs + durationMs + Math.max(0, Number(afterHours || 0)) * 3600000,
    sessionStartMs: startMs,
  };
}

function publicReading(reading = {}) {
  const { raw: _raw, ...rest } = reading;
  return rest;
}

bloodPressureRouter.get('/recent', (req, res) => {
  const limit = Math.max(1, Math.min(500, Number(req.query.limit || 50)));
  const rows = sortRecent(listEntities('BloodPressureReading')).slice(0, limit);
  res.json({ ok: true, readings: rows.map(publicReading), count: rows.length });
});

bloodPressureRouter.post('/ingest', (req, res) => {
  try {
    const inputs = Array.isArray(req.body?.readings) ? req.body.readings : [req.body?.reading || req.body].filter(Boolean);
    const saved = inputs.map((input) => {
      const normalized = normalizeReading(input);
      return upsertEntity('BloodPressureReading', normalized.id, normalized);
    });
    res.json({ ok: true, inserted: saved.length, readings: saved.map(publicReading) });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || String(error) });
  }
});

bloodPressureRouter.get('/near-session/:sessionId', (req, res) => {
  const session = getEntity('Session', req.params.sessionId);
  if (!session) return res.status(404).json({ error: 'Session not found' });
  const window = sessionWindow(session, req.query.beforeHours ?? 8, req.query.afterHours ?? 4);
  if (!window) return res.status(400).json({ error: 'Session is missing a usable date.' });
  const readings = sortRecent(listEntities('BloodPressureReading').filter((reading) => {
    const t = readingTime(reading);
    return Number.isFinite(t) && t >= window.startMs && t <= window.endMs;
  }));
  const nearest = readings
    .map((reading) => ({ reading, distanceMs: Math.abs(readingTime(reading) - window.sessionStartMs) }))
    .sort((a, b) => a.distanceMs - b.distanceMs)[0];
  res.json({
    ok: true,
    readings: readings.map(publicReading),
    nearest: nearest ? publicReading(nearest.reading) : null,
    window: {
      start: new Date(window.startMs).toISOString(),
      end: new Date(window.endMs).toISOString(),
    },
  });
});

