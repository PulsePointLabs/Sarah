import express from 'express';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import WebSocket from 'ws';
import { parse } from 'csv-parse/sync';
import { bulkCreate, getEntity, upsertEntity } from '../db.js';
import { liveCaptureConfig, uploadDir } from '../config.js';
import { telemetryEngine } from '../localEngine/index.js';
import {
  HR_SOURCE_IDS,
  HR_SOURCE_LABELS,
  cleanHr,
  maskToken,
  normalizeDirectH10Telemetry,
  normalizeHeartRateOnStreamTelemetry,
  normalizePulsoidTelemetry,
  parsePulsoidMessage,
} from '../services/hrSources.js';
import { SHARED_HR_PACKET_STALE_MS, isSharedHrPacketFresh } from '../services/hrFreshness.js';
import { normalizeOverlayHeartRateSnapshot } from '../services/overlayHeartRate.js';

export const liveCaptureRouter = express.Router();

const HR_WS_URL = liveCaptureConfig.hrWsUrl;
const HR_RECORDINGS_DIR = liveCaptureConfig.hrRecordingsDir;
const EMG_TEXT_DIR = liveCaptureConfig.emgTextDir;
const EMG_SESSIONS_DIR = liveCaptureConfig.emgSessionsDir;
const EMG_COMMAND_FILE = path.join(EMG_TEXT_DIR, 'emg_command.json');
const EMG_COMMAND_STATUS_FILE = path.join(EMG_TEXT_DIR, 'emg_command_status.json');
const EMG_CALIBRATION_ACTIONS = new Set([
  'set_both_rest',
  'set_both_max',
  'set_left_max',
  'set_right_max',
  'set_left_rest',
  'set_right_rest',
  'save_calibration',
  'flip_lr',
]);

const clients = new Set();
const overlayHrClients = new Set();
let hrSocket = null;
let hrReconnectTimer = null;
let pulsoidSocket = null;
let pulsoidReconnectTimer = null;
let pulsoidPollTimer = null;
let pulsoidBackoffMs = 1500;
let pulsoidAccessToken = '';
let emgPollTimer = null;
let lastEmgSignature = '';
let pulsoidRecording = null;
let directH10Recording = null;
// The Android source may batch network delivery while its BLE recording remains healthy.
// Explicit disconnect events still propagate immediately; this only governs packet silence.
const HR_SOURCE_STALE_MS = SHARED_HR_PACKET_STALE_MS;
const derivedHrState = new Map();
const CAPTURE_KINDS = new Set(['session', 'body_exploration']);
let overlayHrSequence = 0;
let overlayLastDeliveryAt = null;
let overlayTestTelemetry = null;

const state = {
  startedAt: new Date().toISOString(),
  hr: {
    url: HR_WS_URL,
    connected: false,
    recording: null,
    latestTelemetry: null,
    selectedSource: HR_SOURCE_IDS.HEART_RATE_ON_STREAM,
    selectedSourceLabel: HR_SOURCE_LABELS[HR_SOURCE_IDS.HEART_RATE_ON_STREAM],
    sourceStatus: {
      source: HR_SOURCE_IDS.HEART_RATE_ON_STREAM,
      label: HR_SOURCE_LABELS[HR_SOURCE_IDS.HEART_RATE_ON_STREAM],
      connected: false,
      message: 'Using HeartRateOnStream relay',
      mode: 'websocket',
      tokenMasked: '',
    },
    pulsoid: {
      mode: 'websocket',
      tokenMasked: '',
      connected: false,
      lastMessageAt: null,
      lastMeasuredAt: null,
      error: null,
      reconnecting: false,
      pollMs: 800,
    },
    directH10: {
      connected: false,
      deviceName: '',
      lastMessageAt: null,
      lastMeasuredAt: null,
      error: null,
    },
    lastMessageAt: null,
    error: null,
    relay: null,
  },
  emg: {
    textDir: EMG_TEXT_DIR,
    sessionsDir: EMG_SESSIONS_DIR,
    latestTelemetry: null,
    lastMessageAt: null,
    lastPollAt: null,
    lastSourceAt: null,
    calibrationCommandStatus: null,
    error: null,
  },
  files: {
    latestHrCsv: null,
    latestEmgCsv: null,
  },
  session: {
    activeSessionId: null,
    entity: 'Session',
    captureKind: 'session',
    active: false,
    startedAt: null,
    finalizedAt: null,
    lastImportedAt: null,
    lastImportError: null,
    importing: false,
    finalizedRecordingKey: null,
  },
  engine: null,
};

telemetryEngine.on('snapshot', (snapshot) => {
  state.engine = snapshot.engine;
  if (snapshot.hr) state.hr.latestTelemetry = snapshot.hr;
  if (snapshot.emg) state.emg.latestTelemetry = snapshot.emg;
  broadcast('telemetry_snapshot', snapshot);
  if (snapshot.hr) broadcastOverlayHeartRate(snapshot.hr);
});

function cleanNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function csvEscape(value) {
  if (value == null) return '';
  const str = String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function fmtDateForSession(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return new Date().toISOString();
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York' }).format(d);
  return `${day}T00:00:00`;
}

function fmtTimeForSession(date) {
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return '';
  const value = d.toLocaleTimeString('en-US', {
    timeZone: 'America/New_York',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });
  return value === '24:00' ? '00:00' : value;
}

function safeFilePart(value) {
  return String(value || 'capture.csv').replace(/[^a-zA-Z0-9._-]/g, '_');
}

function publicUploadUrl(filename) {
  return `/uploads/${filename}`;
}

function formatFilenameDate(date = new Date()) {
  const value = date.toISOString().replace(/[:.]/g, '-');
  return value.replace(/T/, '_').replace(/Z$/, '');
}

function shouldUseTelemetrySource(source) {
  return state.hr.selectedSource === source;
}

function hasRecentDirectH10Packet(maxAgeMs = HR_SOURCE_STALE_MS) {
  return Boolean(
    state.hr.directH10.connected
    && isSharedHrPacketFresh(state.hr.directH10.lastMessageAt, { staleMs: maxAgeMs })
  );
}

function normalizeCaptureKind(value) {
  return CAPTURE_KINDS.has(value) ? value : 'session';
}

function entityForCaptureKind(captureKind) {
  return normalizeCaptureKind(captureKind) === 'body_exploration' ? 'BodyExploration' : 'Session';
}

function median(values = []) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

function hrvQualityScore(value) {
  const quality = String(value || '').trim().toLowerCase();
  if (quality === 'high') return 3;
  if (quality === 'moderate') return 2;
  if (quality === 'low') return 1;
  return 0;
}

function readTelemetryRmssd(telemetry = {}) {
  const direct = cleanNumber(telemetry?.hrv?.rmssdMs);
  if (direct != null) return direct;
  return cleanNumber(telemetry?.hrv_rmssd_ms);
}

function enrichHrTelemetry(telemetry) {
  const hr = cleanHr(telemetry?.heartRate || telemetry?.currentHr || telemetry?.hr);
  if (hr == null) return telemetry;
  const source = telemetry?.source || state.hr.selectedSource || 'unknown';
  const now = Number(telemetry?.receivedAt) || Date.now();
  const hrv = telemetry?.hrv || {};
  const rmssd = readTelemetryRmssd(telemetry);
  const rrCount = cleanNumber(telemetry?.quality?.rrCount) ?? cleanNumber(hrv.sampleCount) ?? 0;
  const hrvQuality = hrv.quality || telemetry?.hrv_quality || telemetry?.quality?.hrvQuality || null;
  const rows = (derivedHrState.get(source) || [])
    .filter((row) => now - row.t <= 8 * 60 * 1000);
  rows.push({ t: now, hr, rmssd });
  const trimmed = rows.slice(-240);
  derivedHrState.set(source, trimmed);

  const recent = trimmed.slice(-30).map((row) => row.hr);
  const baselinePool = trimmed.length >= 20 ? trimmed.map((row) => row.hr) : recent;
  const lowBand = [...baselinePool].sort((a, b) => a - b).slice(0, Math.max(5, Math.ceil(baselinePool.length * 0.35)));
  const baselineHr = Math.round(median(lowBand) || hr);
  const smoothedHr = Math.round(median(recent.slice(-5)) || hr);
  const elevatedDelta = Math.max(0, smoothedHr - baselineHr);
  const firstRecent = trimmed[Math.max(0, trimmed.length - 12)];
  const slopeBpm30s = firstRecent && firstRecent.t !== now
    ? ((smoothedHr - firstRecent.hr) / ((now - firstRecent.t) / 1000)) * 30
    : 0;
  const recentPeak = Math.max(...trimmed.slice(-45).map((row) => row.hr));
  const dropFromPeak = Math.max(0, recentPeak - smoothedHr);
  const recentRmssd = trimmed.slice(-45).map((row) => cleanNumber(row.rmssd)).filter((value) => value != null);
  const baselineRmssd = trimmed.slice(-120).map((row) => cleanNumber(row.rmssd)).filter((value) => value != null);
  const baselineRmssdMedian = median(baselineRmssd);
  const recentRmssdMedian = median(recentRmssd);
  const referenceRmssd = baselineRmssdMedian ?? recentRmssdMedian ?? rmssd;
  const hrvUsable = hrvQualityScore(hrvQuality) >= 2 || rrCount >= 40;
  const firstRecentRmssd = recentRmssd.length ? recentRmssd[0] : null;
  const rmssdTrend = rmssd != null && firstRecentRmssd != null ? rmssd - firstRecentRmssd : 0;
  const hrvCompressed = hrvUsable && rmssd != null && (
    ((referenceRmssd ?? 0) >= 8 && rmssd <= referenceRmssd * 0.72 && elevatedDelta >= 8)
    || (rmssd <= 6 && elevatedDelta >= 10)
  );
  const hrvTightening = hrvUsable && rmssd != null && rmssdTrend <= -3 && elevatedDelta >= 8 && slopeBpm30s >= 0.6;
  const hrvOpening = hrvUsable && rmssd != null && (referenceRmssd ?? 0) >= 5 && rmssd >= referenceRmssd * 1.55;
  const hrvRecoveryBias = hrvOpening && dropFromPeak >= 4 && slopeBpm30s <= 0.5;

  const phase = (dropFromPeak >= 8 && elevatedDelta <= 12 && (slopeBpm30s <= 0.5 || hrvRecoveryBias))
    ? 'recovery'
    : (elevatedDelta >= 8 || slopeBpm30s >= 2 || ((hrvCompressed || hrvTightening) && elevatedDelta >= 6))
      ? 'build'
      : 'baseline';

  let buildConfidence = elevatedDelta * 7 + Math.max(0, slopeBpm30s) * 4;
  if (hrvCompressed) buildConfidence += 12;
  else if (hrvTightening) buildConfidence += 8;
  else if (hrvRecoveryBias) buildConfidence -= 8;
  if (phase === 'recovery') {
    buildConfidence -= dropFromPeak * 2;
    if (hrvRecoveryBias) buildConfidence -= 8;
  }
  buildConfidence = Math.round(Math.max(0, Math.min(100, buildConfidence)));

  const hrvSignal = !hrvUsable || rmssd == null
    ? 'waiting'
    : hrvCompressed
      ? 'compressed'
      : hrvRecoveryBias
        ? 'release'
        : hrvTightening
          ? 'tightening'
          : hrvOpening
            ? 'opening'
            : 'steady';

  return {
    ...telemetry,
    currentHr: hr,
    heartRate: hr,
    hr,
    smoothedHr,
    hrSmoothed: smoothedHr,
    baselineHr,
    elevatedDelta,
    phase,
    buildConfidence,
    hrvUsable,
    hrvSignal,
    hrvReferenceRmssd: referenceRmssd != null ? Number(referenceRmssd.toFixed(1)) : null,
  };
}

function markSelectedHrStaleIfNeeded() {
  const source = state.hr.selectedSource;
  if (source === HR_SOURCE_IDS.DIRECT_H10) {
    const last = Date.parse(state.hr.directH10.lastMessageAt || '');
    if (state.hr.directH10.connected && !isSharedHrPacketFresh(state.hr.directH10.lastMessageAt)) {
      state.hr.directH10 = {
        ...state.hr.directH10,
        connected: false,
        error: 'Direct H10 signal lost - no HR packets received recently.',
      };
      state.hr.latestTelemetry = state.hr.latestTelemetry ? {
        ...state.hr.latestTelemetry,
        quality: {
          ...(state.hr.latestTelemetry.quality || {}),
          stale: true,
          ageMs: Number.isFinite(last) ? Date.now() - last : null,
        },
      } : null;
      refreshHrSourceStatus('Direct H10 signal lost - reconnect from Live Capture');
      return true;
    }
  }
  return false;
}

function sanitizeHrSourceSettings(body = {}) {
  const requestedSource = String(body.source || '');
  const source = [HR_SOURCE_IDS.PULSOID, HR_SOURCE_IDS.DIRECT_H10].includes(requestedSource)
    ? requestedSource
    : HR_SOURCE_IDS.HEART_RATE_ON_STREAM;
  const mode = body.pulsoidMode === 'http' ? 'http' : 'websocket';
  return {
    source,
    pulsoidMode: mode,
    pulsoidToken: String(body.pulsoidToken || '').trim(),
  };
}

function refreshHrSourceStatus(message = '') {
  const source = state.hr.selectedSource;
  state.hr.selectedSourceLabel = HR_SOURCE_LABELS[source] || source;
  const sourceConnected = source === HR_SOURCE_IDS.PULSOID
    ? Boolean(state.hr.pulsoid.connected)
    : source === HR_SOURCE_IDS.DIRECT_H10
      ? Boolean(state.hr.directH10.connected)
      : Boolean(state.hr.connected);
  const sourceMessage = message || (
    source === HR_SOURCE_IDS.PULSOID
      ? state.hr.pulsoid.error || (state.hr.pulsoid.connected ? 'Pulsoid feed connected' : 'Pulsoid feed waiting')
      : source === HR_SOURCE_IDS.DIRECT_H10
        ? state.hr.directH10.error || (state.hr.directH10.connected ? 'Direct H10 connected' : 'Connect the H10 from Live Capture')
        : state.hr.error || 'Using HeartRateOnStream relay'
  );
  state.hr.sourceStatus = {
    source,
    label: state.hr.selectedSourceLabel,
    connected: sourceConnected,
    mode: source === HR_SOURCE_IDS.PULSOID ? state.hr.pulsoid.mode : source === HR_SOURCE_IDS.DIRECT_H10 ? 'web_bluetooth' : 'websocket',
    tokenMasked: source === HR_SOURCE_IDS.PULSOID ? state.hr.pulsoid.tokenMasked : '',
    message: sourceMessage,
    lastMessageAt: source === HR_SOURCE_IDS.PULSOID ? state.hr.pulsoid.lastMessageAt : source === HR_SOURCE_IDS.DIRECT_H10 ? state.hr.directH10.lastMessageAt : state.hr.lastMessageAt,
    lastMeasuredAt: source === HR_SOURCE_IDS.PULSOID ? state.hr.pulsoid.lastMeasuredAt : source === HR_SOURCE_IDS.DIRECT_H10 ? state.hr.directH10.lastMeasuredAt : null,
    reconnecting: source === HR_SOURCE_IDS.PULSOID ? state.hr.pulsoid.reconnecting : false,
  };
}

async function copyCaptureFileToUploads(filePath, prefix) {
  if (!filePath) return null;
  try {
    await fs.mkdir(uploadDir, { recursive: true });
    await fs.access(filePath);
    const filename = `${Date.now()}-${crypto.randomUUID()}-${prefix}-${safeFilePart(path.basename(filePath))}`;
    const dest = path.join(uploadDir, filename);
    await fs.copyFile(filePath, dest);
    const stat = await fs.stat(dest);
    return {
      file_url: publicUploadUrl(filename),
      filename,
      sourcePath: filePath,
      size: stat.size,
      copiedAt: new Date().toISOString(),
    };
  } catch {
    return null;
  }
}

async function createPulsoidRecording(recording = {}, reason = 'obs_record_start') {
  await fs.mkdir(HR_RECORDINGS_DIR, { recursive: true });
  const filename = `hr_timeline_pulsoid_${formatFilenameDate()}.csv`;
  const filepath = path.join(HR_RECORDINGS_DIR, filename);
  const header = [
    'timestamp',
    'time_offset_ms',
    'time_offset_s',
    'hr',
    'hr_smoothed',
    'baseline_hr',
    'elevated_delta',
    'marker',
    'note',
    'hr_source',
    'hr_measured_at',
    'hr_received_at',
    'hr_age_ms',
    'rr_intervals_ms',
    'hrv_rmssd_ms',
    'hrv_sdnn_ms',
    'hrv_pnn50',
    'hrv_window_seconds',
    'hrv_quality',
  ].join(',') + '\n';
  await fs.writeFile(filepath, header, 'utf8');
  pulsoidRecording = {
    filename,
    filepath,
    createdAt: new Date().toISOString(),
    startEpochMs: Number(recording?.startedAtMs) || Date.now(),
    lastEpochMs: null,
    reason,
  };
  state.hr.pulsoidRecording = {
    filename,
    filepath,
    active: Boolean(recording?.active ?? true),
    startedAtMs: pulsoidRecording.startEpochMs,
  };
  return pulsoidRecording;
}

async function appendPulsoidTelemetryRow(telemetry) {
  if (!state.hr.recording?.active || state.hr.selectedSource !== HR_SOURCE_IDS.PULSOID) return;
  if (!pulsoidRecording) await createPulsoidRecording(state.hr.recording, 'pulsoid_auto_start');
  const epochMs = Number(telemetry?.receivedAt) || Date.now();
  if (pulsoidRecording.lastEpochMs != null && epochMs <= pulsoidRecording.lastEpochMs) return;
  const hr = cleanHr(telemetry?.heartRate || telemetry?.currentHr || telemetry?.hr);
  if (hr == null) return;
  const timeOffsetMs = epochMs - pulsoidRecording.startEpochMs;
  const hrv = telemetry?.hrv || {};
  const rr = Array.isArray(telemetry?.rrIntervalsMs) ? telemetry.rrIntervalsMs.join('|') : '';
  const note = hrv.quality && hrv.quality !== 'unavailable'
    ? `real_rr_intervals=true; hrv_quality=${hrv.quality}`
    : 'hrv_unavailable_without_rr_intervals';
  const row = [
    csvEscape(new Date(epochMs).toISOString()),
    csvEscape(timeOffsetMs),
    csvEscape((timeOffsetMs / 1000).toFixed(3)),
    csvEscape(hr),
    csvEscape(cleanNumber(telemetry.smoothedHr ?? telemetry.hrSmoothed ?? hr)),
    csvEscape(cleanNumber(telemetry.baselineHr)),
    csvEscape(cleanNumber(telemetry.elevatedDelta)),
    csvEscape(telemetry.phase || ''),
    csvEscape(note),
    csvEscape(HR_SOURCE_IDS.PULSOID),
    csvEscape(telemetry.measuredAt || ''),
    csvEscape(telemetry.receivedAt || epochMs),
    csvEscape(telemetry.quality?.ageMs ?? ''),
    csvEscape(rr),
    csvEscape(hrv.rmssdMs ?? ''),
    csvEscape(hrv.sdnnMs ?? ''),
    csvEscape(hrv.pnn50 ?? ''),
    csvEscape(hrv.windowSeconds ?? ''),
    csvEscape(hrv.quality || 'unavailable'),
  ].join(',') + '\n';
  await fs.appendFile(pulsoidRecording.filepath, row, 'utf8');
  pulsoidRecording.lastEpochMs = epochMs;
}

async function finalizePulsoidRecording(recording = {}) {
  if (!pulsoidRecording) return null;
  const current = pulsoidRecording;
  const metaPath = current.filepath.replace(/\.csv$/i, '.json');
  await fs.writeFile(metaPath, JSON.stringify({
    reason: 'obs_record_stop',
    csv: current.filepath,
    createdAt: current.createdAt,
    endedAt: new Date().toISOString(),
    source: HR_SOURCE_IDS.PULSOID,
    sourceLabel: HR_SOURCE_LABELS[HR_SOURCE_IDS.PULSOID],
    obsOutputPath: recording?.obsOutputPath || recording?.outputPath || null,
  }, null, 2), 'utf8');
  state.hr.pulsoidRecording = {
    filename: current.filename,
    filepath: current.filepath,
    metaPath,
    active: false,
    startedAtMs: current.startEpochMs,
  };
  pulsoidRecording = null;
  return state.hr.pulsoidRecording;
}

async function createDirectH10Recording(recording = {}, reason = 'obs_record_start') {
  await fs.mkdir(HR_RECORDINGS_DIR, { recursive: true });
  const filename = `hr_timeline_direct_h10_${formatFilenameDate()}.csv`;
  const filepath = path.join(HR_RECORDINGS_DIR, filename);
  const header = [
    'timestamp',
    'time_offset_ms',
    'time_offset_s',
    'hr',
    'hr_smoothed',
    'baseline_hr',
    'elevated_delta',
    'marker',
    'note',
    'hr_source',
    'hr_measured_at',
    'hr_received_at',
    'hr_age_ms',
    'rr_intervals_ms',
    'hrv_rmssd_ms',
    'hrv_sdnn_ms',
    'hrv_pnn50',
    'hrv_window_seconds',
    'hrv_quality',
  ].join(',') + '\n';
  await fs.writeFile(filepath, header, 'utf8');
  directH10Recording = {
    filename,
    filepath,
    createdAt: new Date().toISOString(),
    startEpochMs: Number(recording?.startedAtMs) || Date.now(),
    lastEpochMs: null,
    reason,
  };
  state.hr.directH10Recording = {
    filename,
    filepath,
    active: Boolean(recording?.active ?? true),
    startedAtMs: directH10Recording.startEpochMs,
  };
  return directH10Recording;
}

async function appendDirectH10TelemetryRow(telemetry) {
  if (!state.hr.recording?.active || state.hr.selectedSource !== HR_SOURCE_IDS.DIRECT_H10) return;
  if (!directH10Recording) await createDirectH10Recording(state.hr.recording, 'direct_h10_auto_start');
  const epochMs = Number(telemetry?.receivedAt) || Date.now();
  if (directH10Recording.lastEpochMs != null && epochMs <= directH10Recording.lastEpochMs) return;
  const hr = cleanHr(telemetry?.heartRate || telemetry?.currentHr || telemetry?.hr);
  if (hr == null) return;
  const timeOffsetMs = epochMs - directH10Recording.startEpochMs;
  const hrv = telemetry?.hrv || {};
  const rr = Array.isArray(telemetry?.rrIntervalsMs) ? telemetry.rrIntervalsMs.join('|') : '';
  const note = hrv.quality && hrv.quality !== 'unavailable'
    ? `direct_h10=true; real_rr_intervals=true; hrv_quality=${hrv.quality}`
    : 'direct_h10=true; hrv_waiting_for_rr_window';
  const row = [
    csvEscape(new Date(epochMs).toISOString()),
    csvEscape(timeOffsetMs),
    csvEscape((timeOffsetMs / 1000).toFixed(3)),
    csvEscape(hr),
    csvEscape(cleanNumber(telemetry.smoothedHr ?? telemetry.hrSmoothed ?? hr)),
    csvEscape(cleanNumber(telemetry.baselineHr)),
    csvEscape(cleanNumber(telemetry.elevatedDelta)),
    csvEscape(telemetry.phase || ''),
    csvEscape(note),
    csvEscape(HR_SOURCE_IDS.DIRECT_H10),
    csvEscape(telemetry.measuredAt || ''),
    csvEscape(telemetry.receivedAt || epochMs),
    csvEscape(telemetry.quality?.ageMs ?? ''),
    csvEscape(rr),
    csvEscape(hrv.rmssdMs ?? ''),
    csvEscape(hrv.sdnnMs ?? ''),
    csvEscape(hrv.pnn50 ?? ''),
    csvEscape(hrv.windowSeconds ?? ''),
    csvEscape(hrv.quality || 'unavailable'),
  ].join(',') + '\n';
  await fs.appendFile(directH10Recording.filepath, row, 'utf8');
  directH10Recording.lastEpochMs = epochMs;
}

async function finalizeDirectH10Recording(recording = {}) {
  if (!directH10Recording) return null;
  const current = directH10Recording;
  const metaPath = current.filepath.replace(/\.csv$/i, '.json');
  await fs.writeFile(metaPath, JSON.stringify({
    reason: 'obs_record_stop',
    csv: current.filepath,
    createdAt: current.createdAt,
    endedAt: new Date().toISOString(),
    source: HR_SOURCE_IDS.DIRECT_H10,
    sourceLabel: HR_SOURCE_LABELS[HR_SOURCE_IDS.DIRECT_H10],
    obsOutputPath: recording?.obsOutputPath || recording?.outputPath || null,
  }, null, 2), 'utf8');
  state.hr.directH10Recording = {
    filename: current.filename,
    filepath: current.filepath,
    metaPath,
    active: false,
    startedAtMs: current.startEpochMs,
  };
  directH10Recording = null;
  return state.hr.directH10Recording;
}

async function resolveHrRecordingForImport(recording = {}) {
  if (![HR_SOURCE_IDS.PULSOID, HR_SOURCE_IDS.DIRECT_H10].includes(state.hr.selectedSource)) return recording;
  const sourceRecording = state.hr.selectedSource === HR_SOURCE_IDS.DIRECT_H10
    ? (directH10Recording ? await finalizeDirectH10Recording(recording) : state.hr.directH10Recording)
    : (pulsoidRecording ? await finalizePulsoidRecording(recording) : state.hr.pulsoidRecording);
  if (!sourceRecording?.filepath) return recording;
  return {
    ...recording,
    ...sourceRecording,
    obsOutputPath: recording?.obsOutputPath || recording?.outputPath || null,
  };
}

function parseHrRows(text) {
  const records = parse(text, { columns: true, skip_empty_lines: true, trim: true });
  return records
    .map((row) => ({
      timestamp: row.timestamp || null,
      time_offset_ms: cleanNumber(row.time_offset_ms),
      time_offset_s: cleanNumber(row.time_offset_s),
      hr: cleanNumber(row.hr),
      hr_smoothed: cleanNumber(row.hr_smoothed),
      baseline_hr: cleanNumber(row.baseline_hr),
      elevated_delta: cleanNumber(row.elevated_delta),
      marker: row.marker || null,
      note: row.note || null,
      hr_source: row.hr_source || null,
      hr_measured_at: cleanNumber(row.hr_measured_at),
      hr_received_at: cleanNumber(row.hr_received_at),
      hr_age_ms: cleanNumber(row.hr_age_ms),
      rr_intervals_ms: row.rr_intervals_ms || null,
      hrv_rmssd_ms: cleanNumber(row.hrv_rmssd_ms),
      hrv_sdnn_ms: cleanNumber(row.hrv_sdnn_ms),
      hrv_pnn50: cleanNumber(row.hrv_pnn50),
      hrv_window_seconds: cleanNumber(row.hrv_window_seconds),
      hrv_quality: row.hrv_quality || null,
    }))
    .filter((row) => row.hr != null);
}

function summarizeHrRows(rows) {
  if (!rows.length) return {};
  const hrs = rows.map((row) => row.hr).filter((value) => value != null);
  const offsets = rows.map((row) => Number(row.time_offset_s)).filter(Number.isFinite);
  const timestamps = rows.map((row) => row.timestamp).filter(Boolean).sort();
  const firstTimestamp = timestamps[0] ? new Date(timestamps[0]) : null;
  const lastTimestamp = timestamps[timestamps.length - 1] ? new Date(timestamps[timestamps.length - 1]) : null;
  const maxOffsetS = offsets.length ? Math.max(...offsets) : null;
  const avgHr = hrs.length ? Math.round(hrs.reduce((sum, value) => sum + value, 0) / hrs.length) : null;
  const maxHr = hrs.length ? Math.max(...hrs) : null;
  const durationMinutes = maxOffsetS != null ? Math.max(1, Math.round(maxOffsetS / 60)) : null;
  return {
    avg_hr: avgHr,
    max_hr: maxHr,
    duration_minutes: durationMinutes,
    date: firstTimestamp ? fmtDateForSession(firstTimestamp) : undefined,
    start_time: firstTimestamp ? fmtTimeForSession(firstTimestamp) : undefined,
    end_time: lastTimestamp ? fmtTimeForSession(lastTimestamp) : undefined,
  };
}

function fmtDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function buildCaptureDigest({ hrRows = [], hrImport = {}, emgUpload = null, recording = {} }) {
  const hrs = hrRows.map((row) => row.hr).filter((value) => value != null);
  const offsets = hrRows.map((row) => Number(row.time_offset_s)).filter(Number.isFinite);
  const maxOffset = offsets.length ? Math.max(...offsets) : null;
  const peakHr = hrs.length ? Math.max(...hrs) : null;
  const avgHr = hrs.length ? Math.round(hrs.reduce((sum, value) => sum + value, 0) / hrs.length) : null;
  const baselineValues = hrRows.map((row) => row.baseline_hr).filter((value) => value != null);
  const baseline = baselineValues.length ? Math.round(baselineValues[baselineValues.length - 1]) : null;
  const elevatedRows = hrRows.filter((row) => Number(row.elevated_delta) >= 8);
  const peakRow = peakHr != null ? hrRows.find((row) => row.hr === peakHr) : null;
  const durationText = maxOffset != null ? fmtDuration(maxOffset) : 'unknown';
  const findings = [
    maxOffset != null ? `Duration ${durationText}` : null,
    avgHr != null ? `Average HR ${avgHr} bpm` : null,
    peakHr != null ? `Peak HR ${peakHr} bpm${peakRow?.time_offset_s != null ? ` at ${fmtDuration(peakRow.time_offset_s)}` : ''}` : null,
    baseline != null ? `Latest baseline ${baseline} bpm` : null,
    elevatedRows.length ? `${elevatedRows.length} elevated HR samples` : null,
    emgUpload ? 'EMG file attached' : 'No EMG file attached',
    recording?.obsOutputPath || recording?.outputPath ? 'OBS output path captured' : null,
  ].filter(Boolean);
  return {
    generated_at: new Date().toISOString(),
    duration_s: maxOffset != null ? Math.round(maxOffset) : null,
    duration_text: durationText,
    avg_hr: avgHr,
    peak_hr: peakHr,
    peak_time_s: peakRow?.time_offset_s != null ? Math.round(Number(peakRow.time_offset_s)) : null,
    baseline_hr: baseline,
    elevated_sample_count: elevatedRows.length,
    hr_rows: hrImport.rows || 0,
    hr_original_rows: hrImport.originalRows || 0,
    emg_attached: Boolean(emgUpload),
    obs_output_path: recording?.obsOutputPath || recording?.outputPath || null,
    findings,
    review_items: [
      'Open the session and add subjective details.',
      'Review live voice annotations for timing and clarity.',
      'Confirm phase markers after reviewing the full timeline.',
      emgUpload ? 'Confirm EMG channel placement and left/right orientation.' : 'Attach EMG data if this capture used EMG.',
    ],
  };
}

async function importHeartRateCsv(sessionId, hrCsv) {
  if (!sessionId || !hrCsv?.path) return { rows: 0, upload: null, metrics: {} };
  const text = await fs.readFile(hrCsv.path, 'utf8');
  const rows = parseHrRows(text);
  const finalRows = rows.length > 10000
    ? rows.filter((_row, index) => index % Math.ceil(rows.length / 10000) === 0)
    : rows;
  bulkCreate('HeartRateTimeline', finalRows.map((row) => ({ ...row, session: sessionId })));
  return {
    rows: finalRows.length,
    originalRows: rows.length,
    upload: await copyCaptureFileToUploads(hrCsv.path, 'hr'),
    metrics: summarizeHrRows(rows),
    rawRows: rows,
  };
}

async function findEmgCsvForSession(startedAt) {
  const latest = await latestCsv(EMG_SESSIONS_DIR);
  if (!latest) return null;
  if (!startedAt) return latest;
  const latestMtime = new Date(latest.modifiedAt).getTime();
  const startMs = new Date(startedAt).getTime();
  return latestMtime >= startMs - 60_000 ? latest : latest;
}

async function attachEmgCsv(emgCsv) {
  if (!emgCsv?.path) return null;
  return copyCaptureFileToUploads(emgCsv.path, 'emg');
}

function buildSessionSeed(recording) {
  const started = recording?.startedAtMs ? new Date(recording.startedAtMs) : new Date();
  return {
    date: fmtDateForSession(started),
    start_time: fmtTimeForSession(started),
    methods: ['Live Capture'],
    tags: ['live-capture', 'obs-recorded'],
    media_images: [],
    hr_timeline: [],
    substances: [],
    is_favorite: false,
    live_capture: true,
    capture_status: 'recording',
    capture_started_at: started.toISOString(),
    capture_source: `OBS + ${state.hr.selectedSourceLabel || 'HR relay'} + EMG bridge`,
    hr_source: state.hr.selectedSource,
    hr_source_label: state.hr.selectedSourceLabel,
    notes: 'Live capture session created automatically when OBS recording started. Add subjective details after recording.',
  };
}

function buildBodyExplorationSeed(recording) {
  const started = recording?.startedAtMs ? new Date(recording.startedAtMs) : new Date();
  return {
    date: fmtDateForSession(started),
    start_time: fmtTimeForSession(started),
    title: `Live body exploration ${started.toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`,
    exploration_type: 'Body exploration',
    methods: ['Live Capture'],
    tags: ['live-capture', 'body-exploration', 'obs-recorded'],
    media_images: [],
    hr_timeline: [],
    substances: [],
    standalone_body_exploration: true,
    telemetry_only: true,
    live_capture: true,
    capture_kind: 'body_exploration',
    capture_status: 'recording',
    capture_started_at: started.toISOString(),
    capture_source: `OBS + ${state.hr.selectedSourceLabel || 'HR relay'} + EMG bridge`,
    hr_source: state.hr.selectedSource,
    hr_source_label: state.hr.selectedSourceLabel,
    purpose: 'Live Capture body exploration record created automatically when recording started.',
    notes: 'Body exploration capture created from Live Capture. Add findings, comfort notes, and setup details after recording.',
  };
}

function ensureLiveSession(recording, options = {}) {
  if (state.session.activeSessionId && state.session.active) return state.session.activeSessionId;
  const captureKind = normalizeCaptureKind(options.captureKind || state.session.captureKind);
  const entity = entityForCaptureKind(captureKind);
  const id = crypto.randomUUID();
  upsertEntity(entity, id, captureKind === 'body_exploration' ? buildBodyExplorationSeed(recording) : buildSessionSeed(recording));
  telemetryEngine.setActiveSession(id);
  state.session = {
    ...state.session,
    activeSessionId: id,
    entity,
    captureKind,
    active: true,
    startedAt: new Date(recording?.startedAtMs || Date.now()).toISOString(),
    finalizedAt: null,
    lastImportError: null,
  };
  broadcast('live_session', state.session);
  return id;
}

async function finalizeLiveSession(recording) {
  const sessionId = state.session.activeSessionId;
  if (!sessionId) return null;
  const recordingKey = recording?.filepath || recording?.filename || recording?.obsOutputPath || recording?.outputPath || sessionId;
  if (state.session.importing) return null;
  if (state.session.lastImportedAt && state.session.finalizedRecordingKey === recordingKey) return null;
  state.session = { ...state.session, importing: true, lastImportError: null };
  broadcast('live_session', state.session);
  try {
    await refreshLatestFiles();
    const hrCsv = recording?.filepath
      ? { path: recording.filepath, name: path.basename(recording.filepath), modifiedAt: new Date().toISOString() }
      : state.files.latestHrCsv;
    const emgCsv = await findEmgCsvForSession(state.session.startedAt);
    const [hrImport, emgUpload] = await Promise.all([
      importHeartRateCsv(sessionId, hrCsv),
      attachEmgCsv(emgCsv),
    ]);
    const stoppedAt = recording?.stoppedAtMs ? new Date(recording.stoppedAtMs) : new Date();
    const update = {
      ...hrImport.metrics,
      capture_status: 'ready_for_review',
      capture_finalized_at: stoppedAt.toISOString(),
      capture_files: {
        hr: hrImport.upload,
        emg: emgUpload,
        obsOutputPath: recording?.obsOutputPath || recording?.outputPath || null,
      },
      hr_source: state.hr.selectedSource,
      hr_source_label: state.hr.selectedSourceLabel,
      hr_data_file: hrImport.upload?.file_url || undefined,
      emg_data_file: emgUpload?.file_url || undefined,
      emg_enabled: Boolean(emgUpload),
      emg_channels: emgUpload ? 'dual' : undefined,
      live_capture_import: {
        imported_at: new Date().toISOString(),
        hr_rows: hrImport.rows,
        hr_original_rows: hrImport.originalRows,
        hr_source: state.hr.selectedSource,
        hr_source_label: state.hr.selectedSourceLabel,
        emg_attached: Boolean(emgUpload),
      },
      capture_digest: buildCaptureDigest({ hrRows: hrImport.rawRows, hrImport, emgUpload, recording }),
    };
    Object.keys(update).forEach((key) => update[key] === undefined && delete update[key]);
    const targetEntity = state.session.entity || (getEntity('BodyExploration', sessionId) ? 'BodyExploration' : 'Session');
    upsertEntity(targetEntity, sessionId, update);
    state.session = {
      ...state.session,
      active: false,
      finalizedAt: stoppedAt.toISOString(),
      lastImportedAt: new Date().toISOString(),
      lastImportError: null,
      importing: false,
      finalizedRecordingKey: recordingKey,
    };
    telemetryEngine.setActiveSession(null);
    broadcast('live_session', state.session);
    return { sessionId, ...update.live_capture_import };
  } catch (error) {
    state.session = {
      ...state.session,
      active: false,
      finalizedAt: new Date().toISOString(),
      lastImportError: error.message || String(error),
      importing: false,
      finalizedRecordingKey: recordingKey,
    };
    broadcast('live_session', state.session);
    return null;
  }
}

function sendSse(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function broadcast(event, data) {
  for (const res of clients) {
    sendSse(res, event, data);
  }
}

function currentOverlayHeartRateSnapshot({ now = Date.now(), forceTelemetry = null } = {}) {
  const activeTest = overlayTestTelemetry && (now - Number(overlayTestTelemetry.receivedAt || 0)) < 10000;
  return normalizeOverlayHeartRateSnapshot({
    telemetry: forceTelemetry || (activeTest ? overlayTestTelemetry : state.hr.latestTelemetry),
    sourceStatus: activeTest
      ? { source: 'overlay_test', label: 'OBS overlay test pulse', connected: true }
      : state.hr.sourceStatus,
    sequence: overlayHrSequence,
    subscribers: overlayHrClients.size,
    lastDeliveryAt: overlayLastDeliveryAt,
    now,
  });
}

function sendOverlayHeartRate(res, event = 'snapshot', telemetry = null) {
  const snapshot = currentOverlayHeartRateSnapshot({ forceTelemetry: telemetry });
  overlayLastDeliveryAt = new Date().toISOString();
  sendSse(res, event, { ...snapshot, lastDeliveryAt: overlayLastDeliveryAt });
}

function broadcastOverlayHeartRate(telemetry = null) {
  overlayHrSequence += 1;
  overlayLastDeliveryAt = new Date().toISOString();
  const snapshot = {
    ...currentOverlayHeartRateSnapshot({ forceTelemetry: telemetry }),
    sequence: overlayHrSequence,
    lastDeliveryAt: overlayLastDeliveryAt,
  };
  for (const res of overlayHrClients) {
    sendSse(res, 'hr', snapshot);
  }
  return snapshot;
}

async function latestCsv(dir) {
  try {
    const files = await fs.readdir(dir, { withFileTypes: true });
    const stats = await Promise.all(
      files
        .filter((item) => item.isFile() && item.name.toLowerCase().endsWith('.csv'))
        .map(async (item) => {
          const filePath = path.join(dir, item.name);
          const stat = await fs.stat(filePath);
          return {
            name: item.name,
            path: filePath,
            size: stat.size,
            modifiedAt: stat.mtime.toISOString(),
          };
        })
    );
    return stats.sort((a, b) => new Date(b.modifiedAt) - new Date(a.modifiedAt))[0] || null;
  } catch {
    return null;
  }
}

async function refreshLatestFiles() {
  const [latestHrCsv, latestEmgCsv] = await Promise.all([
    latestCsv(HR_RECORDINGS_DIR),
    latestCsv(EMG_SESSIONS_DIR),
  ]);
  state.files = { latestHrCsv, latestEmgCsv };
  broadcast('files', state.files);
}

function updatePulsoidState(patch, message = '') {
  state.hr.pulsoid = { ...state.hr.pulsoid, ...patch };
  refreshHrSourceStatus(message);
  broadcast('status', state);
}

function clearPulsoidTimers() {
  clearTimeout(pulsoidReconnectTimer);
  clearTimeout(pulsoidPollTimer);
  pulsoidReconnectTimer = null;
  pulsoidPollTimer = null;
}

function closePulsoidConnection({ quiet = false } = {}) {
  clearPulsoidTimers();
  if (pulsoidSocket) {
    try {
      pulsoidSocket.close();
    } catch {
      // Ignore close races during source switching.
    }
  }
  pulsoidSocket = null;
  if (!quiet) updatePulsoidState({ connected: false, reconnecting: false }, 'Pulsoid feed stopped');
}

function applySelectedHrTelemetry(telemetry) {
  const enriched = telemetry?.buildConfidence != null && telemetry?.baselineHr != null
    ? telemetry
    : enrichHrTelemetry(telemetry);
  const protectedSample = telemetryEngine.ingestHrSample(enriched, { source: enriched?.source || state.hr.selectedSource });
  const storedTelemetry = protectedSample.event?.payload || enriched;
  state.hr.latestTelemetry = storedTelemetry;
  state.hr.lastMessageAt = new Date().toISOString();
  broadcast('hr_telemetry', storedTelemetry);
  broadcastOverlayHeartRate(storedTelemetry);
  return storedTelemetry;
}

function publishHrTelemetryToOverlay(telemetry) {
  if (!telemetry || !hrSocket || hrSocket.readyState !== WebSocket.OPEN) return;
  try {
    hrSocket.send(JSON.stringify({ type: 'overlay_telemetry', data: telemetry }));
  } catch {
    // Overlay mirroring is best-effort; protected ingestion/storage already happened.
  }
}

function refreshDirectH10TelemetryState(telemetry, fallbackDeviceName = '') {
  // Connection freshness is based on arrival at this server, not the sender's clock.
  // measuredAt remains available separately for physiological timeline alignment.
  const receivedIso = new Date().toISOString();
  state.hr.directH10 = {
    ...state.hr.directH10,
    connected: true,
    deviceName: String(
      telemetry?.deviceName
      || telemetry?.raw?.deviceName
      || fallbackDeviceName
      || state.hr.directH10.deviceName
      || ''
    ),
    error: null,
    lastMessageAt: receivedIso,
    lastMeasuredAt: telemetry?.measuredAt ? new Date(telemetry.measuredAt).toISOString() : null,
  };
}

function handleRelayTelemetry(telemetry) {
  if (!telemetry) return;
  if (telemetry?.origin === 'obs_overlay' || telemetry?.raw?.origin === 'obs_overlay') return;

  const shouldTreatAsDirectH10 =
    telemetry?.source === HR_SOURCE_IDS.DIRECT_H10 ||
    telemetry?.sourceLabel === HR_SOURCE_LABELS[HR_SOURCE_IDS.DIRECT_H10] ||
    telemetry?.raw?.source === HR_SOURCE_IDS.DIRECT_H10;

  if (shouldTreatAsDirectH10) {
    const normalized = normalizeDirectH10Telemetry(telemetry);
    if (!normalized) return;
    refreshDirectH10TelemetryState(normalized, 'OBS overlay relay');
    refreshHrSourceStatus(normalized.rrIntervalsMs?.length ? 'Direct H10 HR + RR live' : 'Direct H10 HR live');
    const selectedTelemetry = applySelectedHrTelemetry(normalized);
    appendDirectH10TelemetryRow(selectedTelemetry).catch((error) => {
      state.hr.directH10.error = `Direct H10 CSV write failed: ${error.message || error}`;
      refreshHrSourceStatus();
      broadcast('status', state);
    });
    broadcast('status', state);
    return;
  }

  const normalized = normalizeHeartRateOnStreamTelemetry(telemetry);
  const canUseRelayTelemetry = shouldUseTelemetrySource(HR_SOURCE_IDS.HEART_RATE_ON_STREAM)
    || (state.hr.selectedSource === HR_SOURCE_IDS.DIRECT_H10 && !hasRecentDirectH10Packet())
    || (state.hr.selectedSource === HR_SOURCE_IDS.PULSOID && !state.hr.pulsoid.connected);
  if (normalized && canUseRelayTelemetry) {
    if (state.hr.selectedSource !== HR_SOURCE_IDS.HEART_RATE_ON_STREAM) {
      state.hr.selectedSource = HR_SOURCE_IDS.HEART_RATE_ON_STREAM;
      state.hr.selectedSourceLabel = HR_SOURCE_LABELS[HR_SOURCE_IDS.HEART_RATE_ON_STREAM];
    }
    const nextTelemetry = applySelectedHrTelemetry(normalized);
    state.hr.latestTelemetry = nextTelemetry;
    refreshHrSourceStatus('HeartRateOnStream HR live');
    broadcast('status', state);
  }
}

function handlePulsoidTelemetry(telemetry) {
  if (!telemetry) return;
  pulsoidBackoffMs = 1500;
  const receivedIso = new Date(telemetry.receivedAt || Date.now()).toISOString();
  state.hr.pulsoid = {
    ...state.hr.pulsoid,
    connected: true,
    reconnecting: false,
    error: null,
    lastMessageAt: receivedIso,
    lastMeasuredAt: telemetry.measuredAt ? new Date(telemetry.measuredAt).toISOString() : null,
  };
  telemetry.quality = {
    ...(telemetry.quality || {}),
    reconnecting: false,
  };
  if (shouldUseTelemetrySource(HR_SOURCE_IDS.PULSOID)) {
    refreshHrSourceStatus('Pulsoid HR live');
    const selectedTelemetry = applySelectedHrTelemetry(telemetry);
    publishHrTelemetryToOverlay(selectedTelemetry);
    appendPulsoidTelemetryRow(telemetry).catch((error) => {
      state.hr.pulsoid.error = `Pulsoid CSV write failed: ${error.message || error}`;
      refreshHrSourceStatus();
      broadcast('status', state);
    });
  } else {
    refreshHrSourceStatus();
  }
  broadcast('status', state);
}

function schedulePulsoidReconnect(reason = 'disconnected') {
  if (state.hr.selectedSource !== HR_SOURCE_IDS.PULSOID || !pulsoidAccessToken) return;
  const delay = pulsoidBackoffMs;
  pulsoidBackoffMs = Math.min(30000, Math.round(pulsoidBackoffMs * 1.7));
  updatePulsoidState({
    connected: false,
    reconnecting: true,
    error: reason,
  }, `Pulsoid reconnecting in ${Math.round(delay / 1000)}s`);
  pulsoidReconnectTimer = setTimeout(() => {
    if (state.hr.pulsoid.mode === 'http') {
      startPulsoidPolling();
    } else {
      connectPulsoidSocket();
    }
  }, delay);
  pulsoidReconnectTimer.unref?.();
}

function connectPulsoidSocket() {
  clearPulsoidTimers();
  if (!pulsoidAccessToken) {
    updatePulsoidState({ connected: false, reconnecting: false, error: 'Pulsoid token required' }, 'Pulsoid token required');
    return;
  }
  const url = `wss://dev.pulsoid.net/api/v1/data/real_time?access_token=${encodeURIComponent(pulsoidAccessToken)}`;
  try {
    pulsoidSocket = new WebSocket(url);
    pulsoidSocket.addEventListener('open', () => {
      updatePulsoidState({ connected: true, reconnecting: false, error: null }, 'Pulsoid websocket connected');
    });
    pulsoidSocket.addEventListener('message', (event) => {
      handlePulsoidTelemetry(parsePulsoidMessage(String(event.data || '')));
    });
    pulsoidSocket.addEventListener('close', () => {
      state.hr.pulsoid.connected = false;
      schedulePulsoidReconnect('Pulsoid websocket closed');
    });
    pulsoidSocket.addEventListener('error', () => {
      state.hr.pulsoid.connected = false;
      schedulePulsoidReconnect('Pulsoid websocket error');
    });
  } catch (error) {
    schedulePulsoidReconnect(error.message || String(error));
  }
}

async function pollPulsoidLatestOnce() {
  if (!pulsoidAccessToken) {
    updatePulsoidState({ connected: false, reconnecting: false, error: 'Pulsoid token required' }, 'Pulsoid token required');
    return;
  }
  try {
    const res = await fetch('https://dev.pulsoid.net/api/v1/data/heart_rate/latest', {
      headers: {
        Authorization: `Bearer ${pulsoidAccessToken}`,
        Accept: 'application/json',
      },
    });
    if (res.status === 401) {
      updatePulsoidState({
        connected: false,
        reconnecting: false,
        error: 'Pulsoid token invalid or missing data:heart_rate:read scope',
      });
      return;
    }
    if (res.status === 412) {
      updatePulsoidState({ connected: false, reconnecting: true, error: 'Pulsoid has no heart-rate data yet' });
      return;
    }
    if (!res.ok) {
      throw new Error(`Pulsoid latest endpoint returned ${res.status}`);
    }
    const text = await res.text();
    const parsed = parsePulsoidMessage(text) || normalizePulsoidTelemetry({ data: { heart_rate: text } });
    handlePulsoidTelemetry(parsed);
  } catch (error) {
    updatePulsoidState({ connected: false, reconnecting: true, error: error.message || String(error) });
  }
}

function startPulsoidPolling() {
  clearPulsoidTimers();
  const poll = async () => {
    await pollPulsoidLatestOnce();
    if (state.hr.selectedSource !== HR_SOURCE_IDS.PULSOID || state.hr.pulsoid.mode !== 'http') return;
    const delay = state.hr.pulsoid.error ? 2500 : state.hr.pulsoid.pollMs;
    pulsoidPollTimer = setTimeout(poll, delay);
    pulsoidPollTimer.unref?.();
  };
  poll();
}

function restartPulsoidSource() {
  closePulsoidConnection({ quiet: true });
  if (state.hr.selectedSource !== HR_SOURCE_IDS.PULSOID) {
    updatePulsoidState({ connected: false, reconnecting: false, error: null }, 'Using HeartRateOnStream relay');
    return;
  }
  pulsoidBackoffMs = 1500;
  if (state.hr.pulsoid.mode === 'http') {
    startPulsoidPolling();
  } else {
    connectPulsoidSocket();
  }
}

function connectHrBridge() {
  if (hrSocket && [WebSocket.CONNECTING, WebSocket.OPEN].includes(hrSocket.readyState)) return;
  clearTimeout(hrReconnectTimer);

  try {
    hrSocket = new WebSocket(HR_WS_URL);

    hrSocket.addEventListener('open', () => {
      state.hr.connected = true;
      state.hr.error = null;
      refreshHrSourceStatus();
      broadcast('status', state);
    });

    hrSocket.addEventListener('message', (event) => {
      let msg;
      try {
        msg = JSON.parse(String(event.data || ''));
      } catch {
        return;
      }

      state.hr.lastMessageAt = new Date().toISOString();

      if (msg.type === 'telemetry') {
        handleRelayTelemetry(msg.data || null);
      }

      if (msg.type === 'relay_status') {
        state.hr.relay = msg.relay || null;
        refreshHrSourceStatus();
        broadcast('status', state);
      }

      if (msg.type === 'recording_info') {
        state.hr.recording = msg.recording || null;
        if (state.hr.recording?.active) {
          ensureLiveSession(state.hr.recording);
          if (state.hr.selectedSource === HR_SOURCE_IDS.PULSOID && !pulsoidRecording) {
            createPulsoidRecording(state.hr.recording, 'pulsoid_recording_info').catch((error) => {
              state.hr.pulsoid.error = `Pulsoid CSV start failed: ${error.message || error}`;
              refreshHrSourceStatus();
              broadcast('status', state);
            });
          }
          if (state.hr.selectedSource === HR_SOURCE_IDS.DIRECT_H10 && !directH10Recording) {
            createDirectH10Recording(state.hr.recording, 'direct_h10_recording_info').catch((error) => {
              state.hr.directH10.error = `Direct H10 CSV start failed: ${error.message || error}`;
              refreshHrSourceStatus();
              broadcast('status', state);
            });
          }
        }
        broadcast('recording', state.hr.recording);
      }

      if (msg.type === 'obs_record_state') {
        state.hr.recording = {
          ...(state.hr.recording || {}),
          active: !!msg.active,
          startedAtMs: msg.startedAtMs || state.hr.recording?.startedAtMs || null,
          stoppedAtMs: msg.stoppedAtMs || null,
          outputPath: msg.outputPath || null,
        };
        if (state.hr.recording.active) {
          ensureLiveSession(state.hr.recording);
          if (state.hr.selectedSource === HR_SOURCE_IDS.PULSOID && !pulsoidRecording) {
            createPulsoidRecording(state.hr.recording).catch((error) => {
              state.hr.pulsoid.error = `Pulsoid CSV start failed: ${error.message || error}`;
              refreshHrSourceStatus();
              broadcast('status', state);
            });
          }
          if (state.hr.selectedSource === HR_SOURCE_IDS.DIRECT_H10 && !directH10Recording) {
            createDirectH10Recording(state.hr.recording).catch((error) => {
              state.hr.directH10.error = `Direct H10 CSV start failed: ${error.message || error}`;
              refreshHrSourceStatus();
              broadcast('status', state);
            });
          }
        }
        broadcast('recording', state.hr.recording);
        refreshLatestFiles();
        if (!state.hr.recording.active) {
          resolveHrRecordingForImport(state.hr.recording).then((recordingForImport) => finalizeLiveSession(recordingForImport).then((result) => {
            if (result) broadcast('live_session_imported', result);
          }));
        }
      }

      if (msg.type === 'recording_finalized') {
        state.hr.recording = {
          ...(msg.recording || state.hr.recording || {}),
          active: false,
        };
        broadcast('recording_finalized', state.hr.recording);
        refreshLatestFiles();
        resolveHrRecordingForImport(state.hr.recording).then((recordingForImport) => finalizeLiveSession(recordingForImport).then((result) => {
          if (result) broadcast('live_session_imported', result);
        }));
      }
    });

    hrSocket.addEventListener('close', () => {
      state.hr.connected = false;
      refreshHrSourceStatus();
      broadcast('status', state);
      hrReconnectTimer = setTimeout(connectHrBridge, 1500);
    });

    hrSocket.addEventListener('error', () => {
      state.hr.connected = false;
      state.hr.error = `Could not connect to ${HR_WS_URL}`;
      refreshHrSourceStatus();
      broadcast('status', state);
    });
  } catch (error) {
    state.hr.connected = false;
    state.hr.error = error.message || String(error);
    refreshHrSourceStatus();
    hrReconnectTimer = setTimeout(connectHrBridge, 1500);
  }
}

async function readEmgTextTelemetry() {
  try {
    const commandStatus = JSON.parse(await fs.readFile(EMG_COMMAND_STATUS_FILE, 'utf8'));
    const previous = JSON.stringify(state.emg.calibrationCommandStatus);
    if (JSON.stringify(commandStatus) !== previous) {
      state.emg.calibrationCommandStatus = commandStatus;
      broadcast('emg_calibration_status', commandStatus);
    }
  } catch {
    // The helper only creates this status file after the first app-issued command.
  }

  const read = async (name) => {
    try {
      const filePath = path.join(EMG_TEXT_DIR, name);
      const [text, stat] = await Promise.all([
        fs.readFile(filePath, 'utf8'),
        fs.stat(filePath),
      ]);
      return { text: text.trim(), modifiedAt: stat.mtime.toISOString() };
    } catch {
      return { text: '', modifiedAt: null };
    }
  };

  const [leftFile, rightFile, diffFile, levelFile] = await Promise.all([
    read('emg_left.txt'),
    read('emg_right.txt'),
    read('emg_diff.txt'),
    read('emg_level.txt'),
  ]);
  const sourceTimes = [leftFile, rightFile, diffFile, levelFile]
    .map((file) => file.modifiedAt)
    .filter(Boolean)
    .sort();
  const sourceAt = sourceTimes[sourceTimes.length - 1] || state.emg.lastSourceAt;

  const telemetry = {
    left_pct: cleanNumber(leftFile.text),
    right_pct: cleanNumber(rightFile.text),
    diff_pct: cleanNumber(diffFile.text),
    level_pct: cleanNumber(levelFile.text),
    source_at: sourceAt,
  };

  if ([telemetry.left_pct, telemetry.right_pct, telemetry.diff_pct, telemetry.level_pct].every((value) => value == null)) return;

  state.emg.lastPollAt = new Date().toISOString();
  state.emg.lastSourceAt = sourceAt;
  const signature = JSON.stringify(telemetry);
  if (signature === lastEmgSignature) return;
  lastEmgSignature = signature;
  state.emg.latestTelemetry = telemetry;
  state.emg.lastMessageAt = new Date().toISOString();
  state.emg.error = null;
  const protectedSample = telemetryEngine.ingestEmgSample(telemetry, { source: 'emg_text_bridge' });
  const storedTelemetry = protectedSample.event?.payload || telemetry;
  state.emg.latestTelemetry = storedTelemetry;
  broadcast('emg_telemetry', storedTelemetry);
}

function startEmgPolling() {
  if (emgPollTimer) return;
  emgPollTimer = setInterval(() => {
    readEmgTextTelemetry().catch((error) => {
      state.emg.error = error.message || String(error);
    });
  }, liveCaptureConfig.emgPollMs);
  emgPollTimer.unref?.();
}

connectHrBridge();
startEmgPolling();
refreshLatestFiles();

liveCaptureRouter.post('/hr-source', (req, res) => {
  if (state.hr.recording?.active) {
    res.status(409).json({ error: 'Stop the active recording before switching heart-rate sources.' });
    return;
  }
  const settings = sanitizeHrSourceSettings(req.body || {});
  state.hr.selectedSource = settings.source;
  state.hr.selectedSourceLabel = HR_SOURCE_LABELS[settings.source] || settings.source;
  pulsoidAccessToken = settings.pulsoidToken;
  state.hr.pulsoid = {
    ...state.hr.pulsoid,
    mode: settings.pulsoidMode,
    tokenMasked: maskToken(pulsoidAccessToken),
    error: null,
    reconnecting: false,
  };
  state.hr.directH10 = {
    ...state.hr.directH10,
    error: null,
  };
  if (settings.source === HR_SOURCE_IDS.PULSOID) {
    state.hr.latestTelemetry = null;
    restartPulsoidSource();
  } else if (settings.source === HR_SOURCE_IDS.DIRECT_H10) {
    closePulsoidConnection({ quiet: true });
    state.hr.latestTelemetry = null;
    state.hr.directH10 = {
      ...state.hr.directH10,
      connected: false,
      lastMessageAt: null,
      lastMeasuredAt: null,
      error: null,
    };
    refreshHrSourceStatus('Connect the H10 from Live Capture');
    broadcast('status', state);
  } else {
    closePulsoidConnection({ quiet: true });
    state.hr.pulsoid = {
      ...state.hr.pulsoid,
      connected: false,
      reconnecting: false,
      error: null,
    };
    refreshHrSourceStatus('Using HeartRateOnStream relay');
    broadcast('status', state);
  }
  res.json({
    ok: true,
    hr: {
      selectedSource: state.hr.selectedSource,
      selectedSourceLabel: state.hr.selectedSourceLabel,
      sourceStatus: state.hr.sourceStatus,
      pulsoid: state.hr.pulsoid,
      directH10: state.hr.directH10,
    },
  });
});

liveCaptureRouter.post('/capture-kind', (req, res) => {
  if (state.session.active) {
    res.status(409).json({ error: 'Stop the active capture before switching between Session and Body Exploration.' });
    return;
  }
  const captureKind = normalizeCaptureKind(req.body?.captureKind);
  state.session = {
    ...state.session,
    captureKind,
    entity: entityForCaptureKind(captureKind),
  };
  broadcast('live_session', state.session);
  res.json({ ok: true, session: state.session });
});

liveCaptureRouter.post('/hr-direct-h10/telemetry', (req, res) => {
  let telemetry = normalizeDirectH10Telemetry(req.body || {});
  if (!telemetry) {
    res.status(400).json({ error: 'Direct H10 telemetry did not include a valid heart rate.' });
    return;
  }
  telemetry = enrichHrTelemetry(telemetry);
  if (state.hr.selectedSource !== HR_SOURCE_IDS.DIRECT_H10) {
    closePulsoidConnection({ quiet: true });
    state.hr.selectedSource = HR_SOURCE_IDS.DIRECT_H10;
    state.hr.selectedSourceLabel = HR_SOURCE_LABELS[HR_SOURCE_IDS.DIRECT_H10];
  }
  refreshDirectH10TelemetryState(
    telemetry,
    req.body?.deviceName || req.body?.device_name || state.hr.directH10.deviceName || ''
  );
  if (shouldUseTelemetrySource(HR_SOURCE_IDS.DIRECT_H10)) {
    refreshHrSourceStatus('Direct H10 HR + RR live');
    telemetry = applySelectedHrTelemetry(telemetry);
    publishHrTelemetryToOverlay(telemetry);
    appendDirectH10TelemetryRow(telemetry).catch((error) => {
      state.hr.directH10.error = `Direct H10 CSV write failed: ${error.message || error}`;
      refreshHrSourceStatus();
      broadcast('status', state);
    });
  } else {
    telemetry = applySelectedHrTelemetry(telemetry);
    publishHrTelemetryToOverlay(telemetry);
    refreshHrSourceStatus();
  }
  broadcast('status', state);
  res.json({ ok: true, hr: { latestTelemetry: telemetry, sourceStatus: state.hr.sourceStatus, directH10: state.hr.directH10 } });
});

liveCaptureRouter.post('/emg/calibration-command', async (req, res) => {
  const action = String(req.body?.action || '');
  if (!EMG_CALIBRATION_ACTIONS.has(action)) {
    res.status(400).json({ error: 'Unsupported EMG calibration command.' });
    return;
  }

  const command = {
    id: randomUUID(),
    action,
    save: req.body?.save !== false,
    requested_at: new Date().toISOString(),
    source: 'sarah_live_capture',
  };

  try {
    await fs.mkdir(EMG_TEXT_DIR, { recursive: true });
    await fs.writeFile(EMG_COMMAND_FILE, JSON.stringify(command, null, 2), 'utf8');
    const queued = {
      id: command.id,
      action,
      status: 'queued',
      requested_at: command.requested_at,
      message: 'Waiting for the running EMG helper to apply this calibration command.',
    };
    state.emg.calibrationCommandStatus = queued;
    broadcast('emg_calibration_status', queued);
    res.json(queued);
  } catch (error) {
    res.status(500).json({ error: error.message || String(error) });
  }
});

liveCaptureRouter.get('/status', (_req, res) => {
  markSelectedHrStaleIfNeeded();
  state.engine = telemetryEngine.snapshot().engine;
  res.json(state);
});

liveCaptureRouter.get('/overlay-heart-rate', (_req, res) => {
  markSelectedHrStaleIfNeeded();
  res.json({
    ok: true,
    overlay: currentOverlayHeartRateSnapshot(),
  });
});

liveCaptureRouter.post('/overlay-heart-rate/test-pulse', (req, res) => {
  const now = Date.now();
  const requested = cleanHr(req.body?.heartRate ?? req.body?.bpm ?? req.body?.hr ?? 72);
  overlayTestTelemetry = requested == null ? null : {
    source: 'overlay_test',
    sourceLabel: 'OBS overlay test pulse',
    heartRate: requested,
    currentHr: requested,
    measuredAt: now,
    receivedAt: now,
    quality: { stale: false, ageMs: 0 },
  };
  const overlay = overlayTestTelemetry
    ? broadcastOverlayHeartRate(overlayTestTelemetry)
    : currentOverlayHeartRateSnapshot();
  res.json({ ok: Boolean(overlayTestTelemetry), overlay });
});

liveCaptureRouter.post('/overlay-heart-rate/clear-test-pulse', (_req, res) => {
  overlayTestTelemetry = null;
  const overlay = broadcastOverlayHeartRate(state.hr.latestTelemetry);
  res.json({ ok: true, overlay });
});

liveCaptureRouter.get('/engine/status', (_req, res) => {
  res.json(telemetryEngine.snapshot());
});

liveCaptureRouter.post('/engine/mock-sample', (req, res) => {
  const body = req.body || {};
  const now = Date.now();
  const hr = body.hr ?? body.heartRate ?? body.currentHr ?? 82 + Math.round(Math.sin(now / 3000) * 8);
  const hrResult = telemetryEngine.ingestHrSample({
    heartRate: hr,
    currentHr: hr,
    hr,
    source: 'mock_local_engine',
    receivedAt: now,
  }, { source: 'mock_local_engine' });
  const emgResult = body.emg === false ? null : telemetryEngine.ingestEmgSample({
    left_pct: body.left_pct ?? Math.max(0, Math.min(100, 20 + Math.round(Math.sin(now / 900) * 12))),
    right_pct: body.right_pct ?? Math.max(0, Math.min(100, 18 + Math.round(Math.cos(now / 1100) * 10))),
    diff_pct: body.diff_pct ?? null,
    level_pct: body.level_pct ?? null,
    source_at: new Date(now).toISOString(),
  }, { source: 'mock_local_engine' });
  telemetryEngine.emitSnapshotIfDirty(true);
  res.json({
    ok: Boolean(hrResult.ok && (emgResult == null || emgResult.ok)),
    snapshot: telemetryEngine.snapshot(),
  });
});

liveCaptureRouter.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  clients.add(res);
  state.engine = telemetryEngine.snapshot().engine;
  sendSse(res, 'status', state);
  const keepAlive = setInterval(() => {
    if (markSelectedHrStaleIfNeeded()) {
      sendSse(res, 'status', state);
    }
    res.write(': keepalive\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    clients.delete(res);
  });
});

liveCaptureRouter.get('/overlay-heart-rate/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  overlayHrClients.add(res);
  sendOverlayHeartRate(res, 'snapshot');
  const keepAlive = setInterval(() => {
    const staleChanged = markSelectedHrStaleIfNeeded();
    if (staleChanged) broadcastOverlayHeartRate(state.hr.latestTelemetry);
    sendOverlayHeartRate(res, 'heartbeat');
    res.write(': keepalive\n\n');
  }, 5000);

  req.on('close', () => {
    clearInterval(keepAlive);
    overlayHrClients.delete(res);
  });
});

liveCaptureRouter.post('/refresh-files', async (_req, res) => {
  await refreshLatestFiles();
  res.json(state.files);
});

liveCaptureRouter.post('/ensure-session', (req, res) => {
  const sessionId = ensureLiveSession(req.body?.recording || state.hr.recording || {}, {
    captureKind: req.body?.captureKind,
  });
  res.json({ ok: true, sessionId, session: state.session });
});
