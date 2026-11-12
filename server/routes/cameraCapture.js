import express from 'express';
import { db, getEntity, upsertEntity } from '../db.js';
import { saveCameraCaptureBloodPressure } from './bloodPressure.js';
import { sumEnemaInstilledVolume } from '../../src/lib/enemaVolume.js';

export const cameraCaptureRouter = express.Router();

cameraCaptureRouter.post('/', (req, res) => {
  const { session_id: id, capture_kind: kind, video_start_timestamp: started, video_stop_timestamp: stopped } = req.body || {};
  const startMs = Date.parse(started);
  const stopMs = Date.parse(stopped);
  if (!/^(?:[\da-f]{8}(?:-[\da-f]{4}){3}-[\da-f]{12}|[\da-f]{32})$/i.test(id || '')
      || !Number.isFinite(startMs) || !Number.isFinite(stopMs) || stopMs <= startMs) {
    return res.status(400).json({ error: 'Camera session is missing a valid ID or recording window.' });
  }
  const captureKind = kind === 'body_exploration' ? kind : 'session';
  const entity = captureKind === 'body_exploration' ? 'BodyExploration' : 'Session';
  const body = req.body;
  const rows = key => Array.isArray(body[key]) ? body[key] : [];
  const instilledMl = sumEnemaInstilledVolume(rows('annotations'));
  try {
    const session = db.transaction(() => {
      const existing = getEntity(entity, id);
      if (existing && (existing.capture_transport !== 'camera' || Date.parse(existing.capture_started_at) !== startMs
        || Date.parse(existing.capture_finalized_at) !== stopMs)) {
        throw Object.assign(new Error('This capture ID already belongs to another recording.'), { status: 409 });
      }
      const bodyExploration = captureKind === 'body_exploration';
      const date = new Date(startMs);
      const initial = existing || upsertEntity(entity, id, {
        date: `${new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(date)}T00:00:00`,
        start_time: new Intl.DateTimeFormat('en-US', {
          timeZone: 'America/New_York', hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
        }).format(date),
        ...(bodyExploration ? { title: 'Live camera body exploration', standalone_body_exploration: true } : {}),
        methods: ['Live Capture'],
        tags: ['live-capture', 'camera-recorded'],
        live_capture: true,
        capture_kind: captureKind,
        capture_transport: 'camera',
        capture_source: 'Local camera',
        capture_status: 'ready_for_review',
        capture_started_at: new Date(startMs).toISOString(),
        capture_finalized_at: new Date(stopMs).toISOString(),
        capture_video_filename: typeof body.video_filename === 'string' ? body.video_filename.slice(0, 180) : null,
        duration_minutes: (stopMs - startMs) / 60000,
        hr_timeline: rows('hr_timeline'),
        hrv_timeline: rows('hrv_timeline'),
        emg_timeline: rows('emg_timeline'),
        pulse_ox_readings: rows('spo2_timeline'),
        event_timeline: rows('annotations'),
        ...(instilledMl > 0 ? {
          enema_instilled_total_ml: instilledMl,
          enema_instillation_count: rows('annotations').filter(event => Number(event.procedure_measurement?.amount_ml ?? event.instilled_volume_ml) > 0).length,
        } : {}),
      });
      return saveCameraCaptureBloodPressure(initial, rows('blood_pressure_snapshots'), entity);
    })();
    res.json({ ok: true, id, entity, bloodPressureCount: session.blood_pressure_readings?.length || 0 });
  } catch (error) {
    res.status(error.status || 500).json({ error: error.message || 'Could not save the camera session.' });
  }
});
