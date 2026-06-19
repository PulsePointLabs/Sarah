import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { liveCaptureConfig } from '../config.js';

const TZ = 'America/New_York';

// HR_RELAY_OBS_QUIET_RETRY_V1
const OBS_RETRY_LOG_INTERVAL_MS = Number(process.env.HR_OBS_RETRY_LOG_INTERVAL_MS || 60000);

const DEFAULT_CONFIG = {
  buildRiseMin: 4,
  buildSlopeMin: 0.24,
  buildPosRatioMin: 0.46,
  buildAccelMin: 0,
  buildMinSec: 2,
  buildHoldSec: 4,
  significantHrMin: 110,
  peakDropMin: 4,
  recoverySlopeMax: 0.3,
  recoveryMinSec: 1,
  recoveryHoldSec: 8,
};

function formatFilenameDate(date = new Date()) {
  const fmt = new Intl.DateTimeFormat('sv-SE', {
    timeZone: TZ,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );
  return `${parts.year}-${parts.month}-${parts.day}_${parts.hour}-${parts.minute}-${parts.second}`;
}

function formatISOWithOffset(date = new Date(), timeZone = TZ) {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    fractionalSecondDigits: 3,
    hour12: false,
  });
  const parts = Object.fromEntries(
    dtf.formatToParts(date)
      .filter((part) => part.type !== 'literal')
      .map((part) => [part.type, part.value])
  );
  const asUTC = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour),
    Number(parts.minute),
    Number(parts.second),
    Number(parts.fractionalSecond || 0)
  );
  const offsetMinutes = Math.round((asUTC - date.getTime()) / 60000);
  const sign = offsetMinutes >= 0 ? '+' : '-';
  const absolute = Math.abs(offsetMinutes);
  const hh = String(Math.floor(absolute / 60)).padStart(2, '0');
  const mm = String(absolute % 60).padStart(2, '0');
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}.${parts.fractionalSecond || '000'}${sign}${hh}:${mm}`;
}

function csvEscape(value) {
  if (value == null) return '';
  const str = String(value);
  return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
}

function cleanHr(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < 25 || number > 250) return null;
  return Math.round(number);
}

function cleanNumber(value, decimals = 3) {
  const number = Number(value);
  return Number.isFinite(number) ? number.toFixed(decimals) : '';
}

function normalizeMarker(phase) {
  if (!phase) return '';
  const value = String(phase).trim().toLowerCase();
  if (value.includes('build')) return 'build';
  if (value.includes('recover')) return 'recovery';
  if (value.includes('climax')) return 'climax';
  if (value.includes('elevated')) return 'elevated';
  if (value.includes('start')) return 'start';
  return value.replace(/\s+/g, '_');
}

function sha256Base64(input) {
  return crypto.createHash('sha256').update(input).digest('base64');
}

class HeartRateRelay {
  constructor({ WebSocket, WebSocketServer }) {
    this.WebSocket = WebSocket;
    this.WebSocketServer = WebSocketServer;
    this.latestConfig = { ...DEFAULT_CONFIG };
    this.currentRecording = null;
    this.obsRecordActive = false;
    this.obsOutputPath = null;
    this.obsConnected = false;
    this.obsIdentified = false;
    this.obsError = null;
    this.obsSocket = null;
    this.obsRpcId = 1;
    this.obsPending = new Map();
    this.obsReconnectTimer = null;
    this.obsRetryCount = 0;
    this.obsLastRetryLogAt = 0;
    this.obsLastErrorMessage = null;
    this.obsWasEverConnected = false;
    this.appWss = null;
  }

  start() {
    fs.mkdirSync(liveCaptureConfig.hrRecordingsDir, { recursive: true });
    this.appWss = new this.WebSocketServer({ port: liveCaptureConfig.hrRelayPort });
    this.appWss.on('connection', (socket) => this.handleAppConnection(socket));
    this.appWss.on('listening', () => {
      console.log(`Sarah HR relay running on ws://127.0.0.1:${liveCaptureConfig.hrRelayPort}`);
      this.connectObs();
    });
    this.appWss.on('error', (error) => {
      const detail = error?.code === 'EADDRINUSE'
        ? `Port ${liveCaptureConfig.hrRelayPort} is already in use; Sarah will keep using the available HR relay.`
        : error.message || String(error);
      console.warn(`Sarah HR relay not started: ${detail}`);
    });
    return this;
  }

  stop() {
    clearTimeout(this.obsReconnectTimer);
    for (const pending of this.obsPending.values()) pending.reject(new Error('HR relay stopped'));
    this.obsPending.clear();
    this.obsSocket?.close();
    this.appWss?.close();
  }

  broadcast(message, except = null) {
    if (!this.appWss) return;
    const payload = JSON.stringify(message);
    for (const client of this.appWss.clients) {
      if (client !== except && client.readyState === this.WebSocket.OPEN) {
        client.send(payload);
      }
    }
  }

  relayStatus() {
    return {
      embedded: true,
      port: liveCaptureConfig.hrRelayPort,
      recordingsDir: liveCaptureConfig.hrRecordingsDir,
      obs: {
        url: liveCaptureConfig.hrObsWsUrl,
        connected: this.obsConnected,
        identified: this.obsIdentified,
        recording: this.obsRecordActive,
        error: this.obsError,
      },
    };
  }

  broadcastRelayStatus(except = null) {
    this.broadcast({ type: 'relay_status', relay: this.relayStatus() }, except);
  }

  buildNote(data) {
    const parts = [];
    if (data.phaseTimer) parts.push(`phase_timer=${data.phaseTimer}`);
    const confidence = Number(data.buildConfidence);
    if (Number.isFinite(confidence)) parts.push(`build_confidence=${Math.round(confidence)}`);
    if (this.obsOutputPath) parts.push(`obs_output_path=${this.obsOutputPath}`);
    return parts.join('; ');
  }

  createNewRecording(reason = 'manual') {
    const filename = `hr_timeline_${formatFilenameDate()}.csv`;
    const filepath = path.join(liveCaptureConfig.hrRecordingsDir, filename);
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
    fs.writeFileSync(filepath, header, 'utf8');
    this.currentRecording = {
      filename,
      filepath,
      createdAt: new Date(),
      startEpochMs: Date.now(),
      lastEpochMs: null,
      reason,
    };
    this.obsOutputPath = null;
    console.log(`Sarah HR relay started recording CSV: ${filename} (${reason})`);
    this.broadcast({
      type: 'recording_info',
      recording: {
        filename,
        filepath,
        active: this.obsRecordActive,
        startedAtMs: this.currentRecording.startEpochMs,
      },
    });
  }

  finalizeRecording(reason = 'stopped') {
    if (!this.currentRecording) return;
    const metaPath = this.currentRecording.filepath.replace(/\.csv$/i, '.json');
    fs.writeFileSync(metaPath, JSON.stringify({
      reason,
      csv: this.currentRecording.filepath,
      createdAt: this.currentRecording.createdAt.toISOString(),
      endedAt: new Date().toISOString(),
      obsOutputPath: this.obsOutputPath,
    }, null, 2), 'utf8');
    console.log(`Sarah HR relay finalized recording: ${this.currentRecording.filename}`);
    this.broadcast({
      type: 'recording_finalized',
      recording: {
        filename: this.currentRecording.filename,
        filepath: this.currentRecording.filepath,
        metaPath,
        obsOutputPath: this.obsOutputPath,
      },
    });
  }

  appendTelemetryRow(data) {
    if (!this.obsRecordActive) return;
    if (!this.currentRecording) this.createNewRecording('obs_auto_start');
    const now = new Date();
    const epochMs = now.getTime();
    if (this.currentRecording.lastEpochMs != null && epochMs <= this.currentRecording.lastEpochMs) return;
    const hr = cleanHr(data.currentHr);
    if (hr == null) return;
    const timeOffsetMs = epochMs - this.currentRecording.startEpochMs;
    const row = [
      csvEscape(formatISOWithOffset(now)),
      csvEscape(timeOffsetMs),
      csvEscape((timeOffsetMs / 1000).toFixed(3)),
      csvEscape(hr),
      csvEscape(cleanNumber(data.smoothedHr)),
      csvEscape(cleanNumber(data.baselineHr)),
      csvEscape(cleanNumber(data.elevatedDelta)),
      csvEscape(normalizeMarker(data.phase)),
      csvEscape(this.buildNote(data)),
      csvEscape('heartrateonstream'),
      csvEscape(data.measuredAt || epochMs),
      csvEscape(data.receivedAt || epochMs),
      csvEscape(data.quality?.ageMs ?? ''),
      csvEscape(Array.isArray(data.rrIntervalsMs) ? data.rrIntervalsMs.join('|') : ''),
      csvEscape(data.hrv?.rmssdMs ?? ''),
      csvEscape(data.hrv?.sdnnMs ?? ''),
      csvEscape(data.hrv?.pnn50 ?? ''),
      csvEscape(data.hrv?.windowSeconds ?? ''),
      csvEscape(data.hrv?.quality || 'unavailable'),
    ].join(',') + '\n';
    fs.appendFileSync(this.currentRecording.filepath, row, 'utf8');
    this.currentRecording.lastEpochMs = epochMs;
  }

  logObsRetry(reason, { force = false } = {}) {
    const now = Date.now();
    const shouldLog = force || !this.obsLastRetryLogAt || (now - this.obsLastRetryLogAt) >= OBS_RETRY_LOG_INTERVAL_MS;
    if (!shouldLog) return;
    this.obsLastRetryLogAt = now;
    const suffix = this.obsRetryCount > 1 ? `attempt ${this.obsRetryCount}` : 'standing by';
    console.warn(`Sarah HR relay OBS unavailable (${reason}); ${suffix}. Retrying quietly...`);
  }

  scheduleObsReconnect(reason = 'disconnected') {
    this.obsRetryCount += 1;
    this.logObsRetry(reason);
    this.broadcastRelayStatus();
    clearTimeout(this.obsReconnectTimer);
    this.obsReconnectTimer = setTimeout(() => this.connectObs(), 1500);
    this.obsReconnectTimer.unref?.();
  }

  connectObs() {
    clearTimeout(this.obsReconnectTimer);
    this.obsSocket = new this.WebSocket(liveCaptureConfig.hrObsWsUrl);
    this.obsSocket.on('open', () => {
      this.obsConnected = true;
      this.obsError = null;
      const retryText = this.obsRetryCount ? ` after ${this.obsRetryCount} retry attempt${this.obsRetryCount === 1 ? '' : 's'}` : '';
      console.log(`Sarah HR relay connected to OBS at ${liveCaptureConfig.hrObsWsUrl}${retryText}`);
      this.obsRetryCount = 0;
      this.obsLastRetryLogAt = 0;
      this.obsLastErrorMessage = null;
      this.obsWasEverConnected = true;
      this.broadcastRelayStatus();
    });
    this.obsSocket.on('close', () => {
      const reason = this.obsLastErrorMessage || (this.obsWasEverConnected ? 'websocket disconnected' : 'OBS not listening yet');
      this.obsConnected = false;
      this.obsIdentified = false;
      this.scheduleObsReconnect(reason);
    });
    this.obsSocket.on('error', (error) => {
      this.obsError = error.message || String(error);
      this.obsLastErrorMessage = this.obsError;
      this.logObsRetry(this.obsError, { force: this.obsRetryCount === 0 });
      this.broadcastRelayStatus();
    });
    this.obsSocket.on('message', (raw) => this.handleObsMessage(raw));
  }

  async handleObsMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (message.op === 0) {
      const hello = message.d || {};
      const identify = {
        rpcVersion: hello.rpcVersion || 1,
        eventSubscriptions: 0xFFFFFFFF,
      };
      if (hello.authentication?.challenge && hello.authentication?.salt) {
        const secret = sha256Base64(liveCaptureConfig.hrObsPassword + hello.authentication.salt);
        identify.authentication = sha256Base64(secret + hello.authentication.challenge);
      }
      this.obsSocket.send(JSON.stringify({ op: 1, d: identify }));
      return;
    }

    if (message.op === 2) {
      this.obsIdentified = true;
      this.obsError = null;
      console.log('Sarah HR relay identified with OBS');
      this.broadcastRelayStatus();
      try {
        const status = await this.obsRequest('GetRecordStatus');
        if (status?.outputActive) {
          this.obsRecordActive = true;
          this.createNewRecording('obs_already_recording');
        }
      } catch (error) {
        console.warn(`Sarah HR relay could not read initial OBS recording state: ${error.message || error}`);
      }
      return;
    }

    if (message.op === 5) {
      this.handleObsEvent(message.d?.eventType, message.d?.eventData || {});
      return;
    }

    if (message.op === 7) {
      const requestId = message.d?.requestId;
      const pending = this.obsPending.get(requestId);
      if (!pending) return;
      this.obsPending.delete(requestId);
      if (message.d?.requestStatus?.result) {
        pending.resolve(message.d.responseData || {});
      } else {
        pending.reject(new Error(message.d?.requestStatus?.comment || 'OBS request failed'));
      }
    }
  }

  handleObsEvent(eventType, eventData) {
    if (eventType !== 'RecordStateChanged') return;
    const wasActive = this.obsRecordActive;
    this.obsRecordActive = Boolean(eventData.outputActive);
    if (!wasActive && this.obsRecordActive) {
      this.createNewRecording('obs_record_start');
      this.broadcastRelayStatus();
      this.broadcast({
        type: 'obs_record_state',
        active: true,
        startedAtMs: this.currentRecording?.startEpochMs || Date.now(),
        eventData,
      });
      return;
    }
    if (wasActive && !this.obsRecordActive) {
      this.obsOutputPath = eventData.outputPath || null;
      this.finalizeRecording('obs_record_stop');
      this.broadcastRelayStatus();
      this.broadcast({
        type: 'obs_record_state',
        active: false,
        stoppedAtMs: Date.now(),
        outputPath: this.obsOutputPath,
        eventData,
      });
    }
  }

  obsRequest(requestType, requestData = {}) {
    return new Promise((resolve, reject) => {
      if (!this.obsSocket || this.obsSocket.readyState !== this.WebSocket.OPEN) {
        reject(new Error('OBS websocket not connected'));
        return;
      }
      const requestId = String(this.obsRpcId++);
      this.obsPending.set(requestId, { resolve, reject });
      this.obsSocket.send(JSON.stringify({
        op: 6,
        d: { requestType, requestId, requestData },
      }));
    });
  }

  async handleAppConnection(socket) {
    console.log('Sarah HR relay app client connected');
    socket.send(JSON.stringify({ type: 'config', config: this.latestConfig }));
    socket.send(JSON.stringify({ type: 'relay_status', relay: this.relayStatus() }));
    socket.send(JSON.stringify({
      type: 'recording_info',
      recording: this.currentRecording
        ? {
            filename: this.currentRecording.filename,
            filepath: this.currentRecording.filepath,
            active: this.obsRecordActive,
            startedAtMs: this.currentRecording.startEpochMs,
          }
        : null,
    }));
    socket.on('message', async (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString());
      } catch (error) {
        console.warn(`Sarah HR relay ignored bad client JSON: ${error.message}`);
        return;
      }
      if (message.type === 'config' && message.config) {
        this.latestConfig = { ...this.latestConfig, ...message.config };
        this.broadcast({ type: 'config', config: this.latestConfig }, socket);
        return;
      }
      if (message.type === 'telemetry' && message.data) {
        this.appendTelemetryRow(message.data);
        this.broadcast({ type: 'telemetry', data: message.data }, socket);
        return;
      }
      if (message.type === 'overlay_telemetry' && message.data) {
        this.broadcast({ type: 'telemetry', data: message.data }, socket);
        return;
      }
      if (message.type === 'reset') {
        this.createNewRecording('manual_reset');
        this.broadcast({ type: 'reset' }, socket);
        return;
      }
      if (message.type === 'obs_start_record') {
        try {
          await this.obsRequest('StartRecord');
        } catch (error) {
          socket.send(JSON.stringify({ type: 'error', message: error.message }));
        }
        return;
      }
      if (message.type === 'obs_stop_record') {
        try {
          const result = await this.obsRequest('StopRecord');
          socket.send(JSON.stringify({ type: 'obs_stop_result', outputPath: result?.outputPath || null }));
        } catch (error) {
          socket.send(JSON.stringify({ type: 'error', message: error.message }));
        }
      }
    });
    socket.on('close', () => console.log('Sarah HR relay app client disconnected'));
  }
}

export async function startHeartRateRelay() {
  if (!liveCaptureConfig.hrRelayEnabled) {
    console.log('Sarah embedded HR relay disabled by HR_CAPTURE_RELAY_ENABLED=false');
    return null;
  }
  try {
    const ws = await import('ws');
    const WebSocket = ws.WebSocket || ws.default;
    const WebSocketServer = ws.WebSocketServer || WebSocket.Server;
    return new HeartRateRelay({ WebSocket, WebSocketServer }).start();
  } catch (error) {
    console.warn(`Sarah embedded HR relay unavailable: ${error.message || error}`);
    console.warn('Install root dependencies or keep the standalone heart-rate relay running.');
    return null;
  }
}
