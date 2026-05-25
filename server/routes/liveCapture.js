import express from 'express';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'csv-parse/sync';
import { bulkCreate, upsertEntity } from '../db.js';
import { liveCaptureConfig, uploadDir } from '../config.js';

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
let hrSocket = null;
let hrReconnectTimer = null;
let emgPollTimer = null;
let lastEmgSignature = '';

const state = {
  startedAt: new Date().toISOString(),
  hr: {
    url: HR_WS_URL,
    connected: false,
    recording: null,
    latestTelemetry: null,
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
    active: false,
    startedAt: null,
    finalizedAt: null,
    lastImportedAt: null,
    lastImportError: null,
    importing: false,
    finalizedRecordingKey: null,
  },
};

function cleanNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
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
    capture_source: 'OBS + HR relay + EMG bridge',
    notes: 'Live capture session created automatically when OBS recording started. Add subjective details after recording.',
  };
}

function ensureLiveSession(recording) {
  if (state.session.activeSessionId && state.session.active) return state.session.activeSessionId;
  const id = crypto.randomUUID();
  upsertEntity('Session', id, buildSessionSeed(recording));
  state.session = {
    ...state.session,
    activeSessionId: id,
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
      hr_data_file: hrImport.upload?.file_url || undefined,
      emg_data_file: emgUpload?.file_url || undefined,
      emg_enabled: Boolean(emgUpload),
      emg_channels: emgUpload ? 'dual' : undefined,
      live_capture_import: {
        imported_at: new Date().toISOString(),
        hr_rows: hrImport.rows,
        hr_original_rows: hrImport.originalRows,
        emg_attached: Boolean(emgUpload),
      },
      capture_digest: buildCaptureDigest({ hrRows: hrImport.rawRows, hrImport, emgUpload, recording }),
    };
    Object.keys(update).forEach((key) => update[key] === undefined && delete update[key]);
    upsertEntity('Session', sessionId, update);
    state.session = {
      ...state.session,
      active: false,
      finalizedAt: stoppedAt.toISOString(),
      lastImportedAt: new Date().toISOString(),
      lastImportError: null,
      importing: false,
      finalizedRecordingKey: recordingKey,
    };
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

function connectHrBridge() {
  if (hrSocket && [WebSocket.CONNECTING, WebSocket.OPEN].includes(hrSocket.readyState)) return;
  clearTimeout(hrReconnectTimer);

  try {
    hrSocket = new WebSocket(HR_WS_URL);

    hrSocket.addEventListener('open', () => {
      state.hr.connected = true;
      state.hr.error = null;
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
        state.hr.latestTelemetry = msg.data || null;
        broadcast('hr_telemetry', state.hr.latestTelemetry);
      }

      if (msg.type === 'relay_status') {
        state.hr.relay = msg.relay || null;
        broadcast('status', state);
      }

      if (msg.type === 'recording_info') {
        state.hr.recording = msg.recording || null;
        if (state.hr.recording?.active) ensureLiveSession(state.hr.recording);
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
        }
        broadcast('recording', state.hr.recording);
        refreshLatestFiles();
        if (!state.hr.recording.active) {
          finalizeLiveSession(state.hr.recording).then((result) => {
            if (result) broadcast('live_session_imported', result);
          });
        }
      }

      if (msg.type === 'recording_finalized') {
        state.hr.recording = {
          ...(msg.recording || state.hr.recording || {}),
          active: false,
        };
        broadcast('recording_finalized', state.hr.recording);
        refreshLatestFiles();
        finalizeLiveSession(state.hr.recording).then((result) => {
          if (result) broadcast('live_session_imported', result);
        });
      }
    });

    hrSocket.addEventListener('close', () => {
      state.hr.connected = false;
      broadcast('status', state);
      hrReconnectTimer = setTimeout(connectHrBridge, 1500);
    });

    hrSocket.addEventListener('error', () => {
      state.hr.connected = false;
      state.hr.error = `Could not connect to ${HR_WS_URL}`;
      broadcast('status', state);
    });
  } catch (error) {
    state.hr.connected = false;
    state.hr.error = error.message || String(error);
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
  broadcast('emg_telemetry', telemetry);
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
    source: 'pulsepoint_live_capture',
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
  res.json(state);
});

liveCaptureRouter.get('/stream', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders?.();

  clients.add(res);
  sendSse(res, 'status', state);
  const keepAlive = setInterval(() => {
    res.write(': keepalive\n\n');
  }, 25000);

  req.on('close', () => {
    clearInterval(keepAlive);
    clients.delete(res);
  });
});

liveCaptureRouter.post('/refresh-files', async (_req, res) => {
  await refreshLatestFiles();
  res.json(state.files);
});

liveCaptureRouter.post('/ensure-session', (req, res) => {
  const sessionId = ensureLiveSession(req.body?.recording || state.hr.recording || {});
  res.json({ ok: true, sessionId, session: state.session });
});
