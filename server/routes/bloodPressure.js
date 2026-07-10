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

function sessionStartMs(session) {
  const baseMs = new Date(session?.date || session?.created_date || 0).getTime();
  if (!Number.isFinite(baseMs) || baseMs <= 0) return 0;
  if (session?.start_time && /^\d{1,2}:\d{2}/.test(String(session.start_time))) {
    const date = new Date(baseMs);
    const [hour, minute] = String(session.start_time).split(':').map(Number);
    date.setHours(hour, minute, 0, 0);
    return date.getTime();
  }
  return baseMs;
}

function publicReading(reading = {}) {
  const { raw: _raw, ...rest } = reading;
  return rest;
}

function attachReadingsToSession(session, readings = [], { source = 'manual_session_bp_attach' } = {}) {
  const startMs = sessionStartMs(session);
  if (!startMs) {
    const error = new Error('Session is missing a usable start time.');
    error.status = 400;
    throw error;
  }
  const existingEvents = Array.isArray(session.event_timeline) ? session.event_timeline : [];
  const existingReadingIds = new Set([
    ...((session.blood_pressure_readings || []).map((reading) => reading?.id).filter(Boolean)),
    ...((session.session_context?.blood_pressure_readings || []).map((reading) => reading?.id).filter(Boolean)),
    ...existingEvents.map((event) => event?.blood_pressure?.reading_id || event?.blood_pressure?.id || '').filter(Boolean),
  ]);
  const existingEventIds = new Set(existingEvents.map((event) => event?.id).filter(Boolean));
  const sortedReadings = sortRecent(readings).reverse();
  const attachable = sortedReadings.filter((reading) => {
    const readingId = cleanText(reading?.id || reading?.external_id || reading?.health_connect_id);
    const eventId = `blood-pressure-${readingId || readingTime(reading)}`;
    return !existingReadingIds.has(readingId) && !existingEventIds.has(eventId);
  });
  if (!attachable.length) return { session, attachedCount: 0, attachedReadings: [] };

  const nextEvents = [...existingEvents];
  attachable.forEach((reading) => {
    const measuredMs = readingTime(reading);
    const timeS = Math.max(0, Math.round((measuredMs - startMs) / 1000));
    nextEvents.push({
      id: `blood-pressure-${reading.id || measuredMs}`,
      time_s: timeS,
      note: `Blood pressure captured: ${reading.systolic_mm_hg}/${reading.diastolic_mm_hg} mmHg${reading.pulse_bpm ? ` · ${Math.round(Number(reading.pulse_bpm))} bpm` : ''}`,
      label: 'Blood pressure captured',
      category: ['physiology', 'blood_pressure'],
      source,
      created_at: new Date().toISOString(),
      blood_pressure: {
        reading_id: reading.id,
        measured_at: reading.measured_at,
        systolic_mm_hg: reading.systolic_mm_hg,
        diastolic_mm_hg: reading.diastolic_mm_hg,
        pulse_bpm: reading.pulse_bpm ?? null,
        source_app: reading.source_app || 'Health Connect',
        source_device: reading.source_device || '',
      },
    });
  });

  const mergedReadings = [
    ...(Array.isArray(session.blood_pressure_readings) ? session.blood_pressure_readings : []),
    ...attachable,
  ].sort((a, b) => readingTime(a) - readingTime(b));
  const latest = mergedReadings[mergedReadings.length - 1] || null;
  const nextSession = upsertEntity('Session', session.id, {
    ...session,
    event_timeline: nextEvents.sort((a, b) => Number(a.time_s || 0) - Number(b.time_s || 0)),
    blood_pressure_readings: mergedReadings,
    latest_blood_pressure_reading: latest,
    session_context: {
      ...(session.session_context || {}),
      blood_pressure: latest
        ? {
          reading_id: latest.id,
          measured_at: latest.measured_at,
          systolic_mm_hg: latest.systolic_mm_hg,
          diastolic_mm_hg: latest.diastolic_mm_hg,
          pulse_bpm: latest.pulse_bpm ?? null,
          source_app: latest.source_app || 'Health Connect',
          source_device: latest.source_device || '',
          relationship: 'manually_attached_to_session',
        }
        : session.session_context?.blood_pressure,
      blood_pressure_readings: mergedReadings,
    },
  });
  return { session: nextSession, attachedCount: attachable.length, attachedReadings: attachable.map(publicReading) };
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

bloodPressureRouter.post('/attach-session/:sessionId', (req, res) => {
  try {
    const session = getEntity('Session', req.params.sessionId);
    if (!session) return res.status(404).json({ error: 'Session not found' });
    const requestedIds = Array.isArray(req.body?.readingIds)
      ? req.body.readingIds.map((value) => cleanText(value)).filter(Boolean)
      : [];
    if (!requestedIds.length) {
      return res.status(400).json({ error: 'Provide one or more readingIds to attach.' });
    }
    const readingMap = new Map(listEntities('BloodPressureReading').map((reading) => [reading.id, reading]));
    const readings = requestedIds.map((id) => readingMap.get(id)).filter(Boolean);
    if (!readings.length) {
      return res.status(404).json({ error: 'No matching blood pressure readings were found.' });
    }
    const result = attachReadingsToSession(session, readings, { source: 'manual_session_bp_attach' });
    res.json({
      ok: true,
      attached: result.attachedCount,
      readings: result.attachedReadings,
      session: result.session,
    });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || String(error) });
  }
});
