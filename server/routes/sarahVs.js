import express from 'express';
import { listEntities, upsertEntity } from '../db.js';

export const sarahVsRouter = express.Router();

function requireToken(req, res, next) {
  const expected = String(process.env.SARAHVS_TRANSFER_TOKEN || '').trim();
  if (!expected) return next();
  const provided = String(req.get('X-SarahVS-Token') || req.body?.token || '').trim();
  if (provided !== expected) return res.status(401).json({ error: 'SarahVS transfer token is invalid.' });
  return next();
}

function cleanText(value, fallback = '') {
  return String(value ?? fallback).trim();
}

function stableTransferId(payload = {}) {
  const latest = payload.latestWindow || {};
  const sessionId = cleanText(latest.sessionId || payload.sessionId);
  const exported = cleanText(payload.exportedAtUtc || new Date().toISOString()).replace(/[^0-9TZ]/g, '');
  if (sessionId) return `sarahvs-${sessionId}-${exported}`.slice(0, 180);
  return `sarahvs-${exported}`;
}

function summarizeTransfer(payload = {}) {
  const latest = payload.latestWindow || {};
  const hr = latest.heartRate || {};
  const hrv = latest.hrv || {};
  const bp = Array.isArray(payload.recentBloodPressure) ? payload.recentBloodPressure[0] : null;
  const pieces = [];
  if (hr.baselineBpm != null) pieces.push(`baseline HR ${hr.baselineBpm}`);
  if (hr.finalBpm != null) pieces.push(`final HR ${hr.finalBpm}`);
  if (hr.averageBpm != null) pieces.push(`avg HR ${Math.round(Number(hr.averageBpm))}`);
  if (hr.maxBpm != null) pieces.push(`max HR ${hr.maxBpm}`);
  if (hrv.rmssdMs != null) pieces.push(`RMSSD ${Number(hrv.rmssdMs).toFixed(1)} ms`);
  if (bp) pieces.push(`latest BP ${bp.systolic}/${bp.diastolic}`);
  return pieces.length ? pieces.join(' · ') : cleanText(payload.humanSummary, 'SarahVS vitals summary received.');
}

function publicTransfer(row = {}) {
  return {
    id: row.id,
    imported_at: row.imported_at,
    exported_at_utc: row.exported_at_utc,
    source: row.source,
    app_version: row.app_version,
    scope: row.scope,
    latest_session_id: row.latest_session_id,
    latest_session_title: row.latest_session_title,
    latest_session_started_at_utc: row.latest_session_started_at_utc,
    summary: row.summary,
    payload: row.payload,
  };
}

sarahVsRouter.get('/health', (_req, res) => {
  res.json({ ok: true, app: 'Sarah local API', feature: 'sarahvs-vitals-import' });
});

sarahVsRouter.post('/vitals/import', requireToken, (req, res) => {
  try {
    const payload = req.body && typeof req.body === 'object' ? req.body : {};
    if (!payload.latestWindow && !Array.isArray(payload.recentSessions)) {
      return res.status(400).json({ error: 'Expected a SarahVS vitals summary payload.' });
    }
    const latest = payload.latestWindow || {};
    const id = stableTransferId(payload);
    const doc = upsertEntity('SarahVsVitalsTransfer', id, {
      id,
      imported_at: new Date().toISOString(),
      exported_at_utc: cleanText(payload.exportedAtUtc),
      source: cleanText(payload.source, 'SarahVS'),
      app_version: cleanText(payload.appVersion),
      scope: cleanText(payload.scope, 'longitudinal_vitals_context'),
      latest_session_id: cleanText(latest.sessionId),
      latest_session_title: cleanText(latest.title),
      latest_session_started_at_utc: cleanText(latest.startedAtUtc),
      summary: summarizeTransfer(payload),
      payload,
    });
    res.json({ ok: true, transfer: publicTransfer(doc) });
  } catch (error) {
    res.status(500).json({ error: error?.message || String(error) });
  }
});

sarahVsRouter.get('/vitals/recent', (req, res) => {
  const limit = Math.max(1, Math.min(100, Number(req.query.limit || 20)));
  const transfers = listEntities('SarahVsVitalsTransfer')
    .sort((a, b) => new Date(b.imported_at || b.created_date || 0) - new Date(a.imported_at || a.created_date || 0))
    .slice(0, limit)
    .map(publicTransfer);
  res.json({ ok: true, transfers, count: transfers.length });
});
