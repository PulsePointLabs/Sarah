import express from 'express';
import { listEntities, upsertEntity } from '../db.js';
import { HOWL_CONTROL_DEFAULT_LIMITS, normalizeHowlTelemetrySample } from '../services/howlTelemetry.js';

export const howlRouter = express.Router();

howlRouter.post('/telemetry', (req, res) => {
  const sample = normalizeHowlTelemetrySample(req.body || {});
  const saved = upsertEntity('HowlTelemetry', sample.id, sample);
  res.json({ ok: true, sample: saved });
});

howlRouter.get('/telemetry/recent', (req, res) => {
  const limit = Math.max(1, Math.min(500, Number(req.query.limit) || 100));
  const sessionId = req.query.session ? String(req.query.session) : null;
  const rows = listEntities('HowlTelemetry')
    .filter((row) => !sessionId || row.session === sessionId)
    .sort((a, b) => String(b.measured_at || b.created_date || '').localeCompare(String(a.measured_at || a.created_date || '')))
    .slice(0, limit);
  res.json({ ok: true, samples: rows });
});

howlRouter.get('/control-capabilities', (_req, res) => {
  res.json({
    ok: true,
    mode: 'read_only',
    message: 'PulsePoint can ingest Howl telemetry. Automatic control is intentionally disabled in this phase.',
    safeguards: HOWL_CONTROL_DEFAULT_LIMITS,
  });
});
