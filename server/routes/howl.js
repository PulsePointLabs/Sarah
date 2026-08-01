import express from 'express';
import { randomUUID } from 'node:crypto';
import { getEntity, listEntities, upsertEntity } from '../db.js';
import { createHowlActivityExposure } from '../services/howlActivityExposure.js';
import { isRuntimeAutoArmValid } from '../services/howlAutoArm.js';
import { executeReconciledHowlCommand } from '../services/howlCommandReconciler.js';
import { HOWL_CONTROL_DEFAULT_LIMITS, normalizeHowlTelemetrySample } from '../services/howlTelemetry.js';

export const howlRouter = express.Router();

const SETTINGS_ID = 'default';
const SERVER_ARM_TOKEN = randomUUID();
const pendingDirectCommands = new Set();
let testedConnectionFingerprint = '';
const DEFAULT_SETTINGS = Object.freeze({
  id: SETTINGS_ID,
  controlEnabled: false,
  sarahAutoEnabled: false,
  dispatchMode: 'direct_http',
  controlUrl: '',
  remoteAccessKey: '',
  intensityFloor: HOWL_CONTROL_DEFAULT_LIMITS.intensityFloor,
  intensityCeiling: HOWL_CONTROL_DEFAULT_LIMITS.intensityCeiling,
  rampRateLimitPerSecond: HOWL_CONTROL_DEFAULT_LIMITS.rampRateLimitPerSecond,
  buildRampEnabled: true,
  nearClimaxReductionEnabled: true,
  recoveryReductionEnabled: true,
  finalApproachEnabled: true,
  buildStep: 1,
  finalApproachStep: 1,
  reduceStep: 2,
  nearClimaxThreshold: 72,
  plateauThreshold: 60,
  buildThreshold: 32,
  recoveryThreshold: 55,
  buildExitThreshold: 27,
  plateauExitThreshold: 54,
  finalApproachExitThreshold: 66,
  recoveryExitThreshold: 61,
  buildConfirmationSeconds: 12,
  plateauConfirmationSeconds: 15,
  finalApproachConfirmationSeconds: 10,
  recoveryConfirmationSeconds: 15,
  confidenceFullThreshold: 75,
  confidenceConservativeThreshold: 65,
  confidenceHoldThreshold: 55,
  lowConfidenceHoldSeconds: 10,
  telemetryReduceIntervalSeconds: 10,
  telemetryMuteTimeoutSeconds: 45,
  telemetryFreshnessMs: 5000,
  breathHoldAmbiguitySeconds: 12,
  recoveryObservationSeconds: 20,
  responseObservationSeconds: 10,
  buildUpwardPointsPerMinute: 4,
  finalApproachUpwardPointsPerMinute: 6,
  autoCooldownSeconds: 8,
  patternDirectorEnabled: false,
  patternMinimumHoldSeconds: 45,
  patternWeights: {
    initial_contact: { SINETIME: 35, VIBRATOR: 40, SIMPLEX: 25 },
    build: { VIBRATOR: 35, SIMPLEX: 30, RELENTLESS: 25, OVERFLOWING: 10 },
    plateau: { SIMPLEX: 35, VIBRATOR: 30, RELENTLESS: 25, OVERFLOWING: 10 },
    final_approach: { VIBRATOR: 40, RELENTLESS: 25, SIMPLEX: 20, OVERFLOWING: 10, MILKMASTER: 5 },
    recovery: { SINETIME: 40, VIBRATOR: 35, SIMPLEX: 25 },
  },
  patternIntervals: {
    initial_contact: { minSeconds: 60, maxSeconds: 120 },
    build: { minSeconds: 75, maxSeconds: 150 },
    plateau: { minSeconds: 120, maxSeconds: 240 },
    final_approach: { minSeconds: 90, maxSeconds: 180 },
    recovery: { minSeconds: 45, maxSeconds: 90 },
  },
  requireManualConfirm: true,
});

function clampNumber(value, min, max, fallback = null) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function cleanText(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
}

function normalizePatternWeights(input, previous) {
  const output = {};
  for (const [phase, defaults] of Object.entries(DEFAULT_SETTINGS.patternWeights)) {
    const source = input?.[phase] && typeof input[phase] === 'object' ? input[phase] : previous?.[phase];
    output[phase] = {};
    for (const [activity, fallback] of Object.entries(defaults)) {
      output[phase][activity] = clampNumber(source?.[activity], 0, 1000, fallback);
    }
  }
  return output;
}

function normalizePatternIntervals(input, previous) {
  const output = {};
  for (const [phase, defaults] of Object.entries(DEFAULT_SETTINGS.patternIntervals)) {
    const source = input?.[phase] && typeof input[phase] === 'object' ? input[phase] : previous?.[phase];
    const minSeconds = clampNumber(source?.minSeconds, 15, 1800, defaults.minSeconds);
    const maxSeconds = clampNumber(source?.maxSeconds, minSeconds, 3600, defaults.maxSeconds);
    output[phase] = { minSeconds, maxSeconds };
  }
  return output;
}

function normalizeHowlBaseUrl(value = '') {
  const raw = cleanText(value, 240);
  if (!raw) return '';
  const withProtocol = /^https?:\/\//i.test(raw) ? raw : `http://${raw}`;
  let parsed;
  try {
    parsed = new URL(withProtocol);
  } catch {
    const error = new Error('Enter a valid Howl URL, like http://192.168.1.42:4695.');
    error.status = 400;
    throw error;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) {
    const error = new Error('Howl remote access must use http:// or https://.');
    error.status = 400;
    throw error;
  }
  const port = parsed.port || '4695';
  return `${parsed.protocol}//${parsed.hostname}${port ? `:${port}` : ''}`;
}

function howlEndpoint(settings, endpoint) {
  const baseUrl = normalizeHowlBaseUrl(settings.controlUrl);
  const path = String(endpoint || '').startsWith('/') ? endpoint : `/${endpoint || ''}`;
  return new URL(path, `${baseUrl}/`).toString();
}

function authHeaders(settings) {
  const key = cleanText(settings.remoteAccessKey, 300);
  return {
    'Content-Type': 'application/json',
    ...(key ? { Authorization: `Bearer ${key}` } : {}),
  };
}

function summarizeHowlResponse(data) {
  const options = data?.options || {};
  return {
    connected: true,
    power_a: options.power_a ?? null,
    power_b: options.power_b ?? null,
    power_a_limit: options.power_a_limit ?? null,
    power_b_limit: options.power_b_limit ?? null,
    mute: options.mute ?? null,
    player: data?.player ? {
      playing: data.player.playing ?? null,
      filename: data.player.filename ?? data.player.file ?? null,
      title: data.player.title ?? null,
      position: data.player.position ?? null,
      duration: data.player.duration ?? null,
    } : null,
  };
}

async function requestHowl(settings, endpoint, body = {}, { timeoutMs = 5000 } = {}) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(howlEndpoint(settings, endpoint), {
      method: 'POST',
      headers: authHeaders(settings),
      body: JSON.stringify(body || {}),
      signal: controller.signal,
    });
    const text = await response.text();
    let data = null;
    try {
      data = text ? JSON.parse(text) : null;
    } catch {
      data = null;
    }
    if (!response.ok) {
      const error = new Error(data?.error?.message || data?.error || text || `Howl returned HTTP ${response.status}.`);
      error.status = response.status;
      error.raw = text.slice(0, 1000);
      throw error;
    }
    return { status: response.status, data, text };
  } catch (error) {
    if (error?.name === 'AbortError') {
      const timeoutError = new Error('Timed out while contacting Howl. Check the phone IP, port 4695, and Wi-Fi network.');
      timeoutError.status = 504;
      throw timeoutError;
    }
    if (error?.message === 'fetch failed' || error?.name === 'TypeError') {
      const networkError = new Error('Could not reach Howl. Check the phone IP, port 4695, Allow remote access, and that both devices are on the same network.');
      networkError.status = 502;
      throw networkError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function testHowlConnection(input = getSettings()) {
  const settings = { ...getSettings(), ...input };
  if (!cleanText(settings.controlUrl)) {
    const error = new Error('Enter the Howl phone URL first, like http://192.168.1.42:4695.');
    error.status = 400;
    throw error;
  }
  if (!cleanText(settings.remoteAccessKey)) {
    const error = new Error('Enter the Howl remote access key first.');
    error.status = 400;
    throw error;
  }
  try {
    const result = await requestHowl(settings, '/status', {});
    return {
      ok: true,
      message: 'Howl responded to /status.',
      status: result.status,
      howl: summarizeHowlResponse(result.data),
      raw: result.text?.slice(0, 1500) || '',
    };
  } catch (error) {
    const status = Number(error?.status) || 502;
    const authMessage = status === 401 || status === 403
      ? 'Howl rejected the remote access key. Copy the key from Howl settings and try again.'
      : null;
    return {
      ok: false,
      status,
      message: authMessage || error?.message || 'Could not reach Howl.',
      raw: error?.raw || '',
    };
  }
}

function getSettings() {
  const envUrl = String(process.env.HOWL_CONTROL_URL || '').trim();
  const envKey = String(process.env.HOWL_REMOTE_ACCESS_KEY || '').trim();
  const saved = getEntity('HowlControlSettings', SETTINGS_ID) || {};
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    runtimeArmToken: undefined,
    controlUrl: String(saved.controlUrl || envUrl || '').trim(),
    remoteAccessKey: String(saved.remoteAccessKey || envKey || '').trim(),
    controlEnabled: Boolean(saved.controlEnabled),
    sarahAutoEnabled: isRuntimeAutoArmValid(saved, SERVER_ARM_TOKEN),
    intensityFloor: clampNumber(saved.intensityFloor, 0, 100, DEFAULT_SETTINGS.intensityFloor),
    intensityCeiling: clampNumber(saved.intensityCeiling, 0, 100, DEFAULT_SETTINGS.intensityCeiling),
    rampRateLimitPerSecond: clampNumber(saved.rampRateLimitPerSecond, 0, 100, DEFAULT_SETTINGS.rampRateLimitPerSecond),
    patternWeights: normalizePatternWeights(saved.patternWeights, DEFAULT_SETTINGS.patternWeights),
    patternIntervals: normalizePatternIntervals(saved.patternIntervals, DEFAULT_SETTINGS.patternIntervals),
  };
}

function connectionFingerprint(settings) {
  return `${normalizeHowlBaseUrl(settings.controlUrl)}|${cleanText(settings.remoteAccessKey, 300)}`;
}

function saveSettings(input = {}) {
  const previous = getSettings();
  const next = {
    ...previous,
    controlEnabled: Boolean(input.controlEnabled),
    sarahAutoEnabled: Boolean(input.sarahAutoEnabled),
    runtimeArmToken: input.sarahAutoEnabled ? SERVER_ARM_TOKEN : null,
    dispatchMode: ['queue', 'direct_http', 'queue_and_direct'].includes(input.dispatchMode) ? input.dispatchMode : previous.dispatchMode,
    controlUrl: normalizeHowlBaseUrl(input.controlUrl ?? previous.controlUrl ?? ''),
    remoteAccessKey: cleanText(input.remoteAccessKey ?? previous.remoteAccessKey ?? '', 300),
    intensityFloor: clampNumber(input.intensityFloor, 0, 100, previous.intensityFloor),
    intensityCeiling: clampNumber(input.intensityCeiling, 0, 100, previous.intensityCeiling),
    rampRateLimitPerSecond: clampNumber(input.rampRateLimitPerSecond, 0, 100, previous.rampRateLimitPerSecond),
    buildRampEnabled: input.buildRampEnabled !== false,
    nearClimaxReductionEnabled: input.nearClimaxReductionEnabled !== false,
    recoveryReductionEnabled: input.recoveryReductionEnabled !== false,
    finalApproachEnabled: input.finalApproachEnabled !== false,
    buildStep: clampNumber(input.buildStep, 0, 10, previous.buildStep),
    finalApproachStep: clampNumber(input.finalApproachStep, 0, 10, previous.finalApproachStep),
    reduceStep: clampNumber(input.reduceStep, 0, 25, previous.reduceStep),
    nearClimaxThreshold: clampNumber(input.nearClimaxThreshold, 0, 100, previous.nearClimaxThreshold),
    plateauThreshold: clampNumber(input.plateauThreshold, 0, 100, previous.plateauThreshold),
    buildThreshold: clampNumber(input.buildThreshold, 0, 100, previous.buildThreshold),
    recoveryThreshold: clampNumber(input.recoveryThreshold, 0, 100, previous.recoveryThreshold),
    buildExitThreshold: clampNumber(input.buildExitThreshold, 0, 100, previous.buildExitThreshold),
    plateauExitThreshold: clampNumber(input.plateauExitThreshold, 0, 100, previous.plateauExitThreshold),
    finalApproachExitThreshold: clampNumber(input.finalApproachExitThreshold, 0, 100, previous.finalApproachExitThreshold),
    recoveryExitThreshold: clampNumber(input.recoveryExitThreshold, 0, 100, previous.recoveryExitThreshold),
    buildConfirmationSeconds: clampNumber(input.buildConfirmationSeconds, 1, 120, previous.buildConfirmationSeconds),
    plateauConfirmationSeconds: clampNumber(input.plateauConfirmationSeconds, 1, 120, previous.plateauConfirmationSeconds),
    finalApproachConfirmationSeconds: clampNumber(input.finalApproachConfirmationSeconds, 1, 120, previous.finalApproachConfirmationSeconds),
    recoveryConfirmationSeconds: clampNumber(input.recoveryConfirmationSeconds, 1, 120, previous.recoveryConfirmationSeconds),
    confidenceFullThreshold: clampNumber(input.confidenceFullThreshold, 0, 100, previous.confidenceFullThreshold),
    confidenceConservativeThreshold: clampNumber(input.confidenceConservativeThreshold, 0, 100, previous.confidenceConservativeThreshold),
    confidenceHoldThreshold: clampNumber(input.confidenceHoldThreshold, 0, 100, previous.confidenceHoldThreshold),
    lowConfidenceHoldSeconds: clampNumber(input.lowConfidenceHoldSeconds, 0, 120, previous.lowConfidenceHoldSeconds),
    telemetryReduceIntervalSeconds: clampNumber(input.telemetryReduceIntervalSeconds, 2, 120, previous.telemetryReduceIntervalSeconds),
    telemetryMuteTimeoutSeconds: clampNumber(input.telemetryMuteTimeoutSeconds, 10, 600, previous.telemetryMuteTimeoutSeconds),
    telemetryFreshnessMs: clampNumber(input.telemetryFreshnessMs, 1000, 30000, previous.telemetryFreshnessMs),
    breathHoldAmbiguitySeconds: clampNumber(input.breathHoldAmbiguitySeconds, 1, 60, previous.breathHoldAmbiguitySeconds),
    recoveryObservationSeconds: clampNumber(input.recoveryObservationSeconds, 5, 120, previous.recoveryObservationSeconds),
    responseObservationSeconds: clampNumber(input.responseObservationSeconds, 5, 120, previous.responseObservationSeconds),
    buildUpwardPointsPerMinute: clampNumber(input.buildUpwardPointsPerMinute, 0, 25, previous.buildUpwardPointsPerMinute),
    finalApproachUpwardPointsPerMinute: clampNumber(input.finalApproachUpwardPointsPerMinute, 0, 25, previous.finalApproachUpwardPointsPerMinute),
    autoCooldownSeconds: clampNumber(input.autoCooldownSeconds, 8, 120, previous.autoCooldownSeconds),
    patternDirectorEnabled: input.patternDirectorEnabled === true,
    patternMinimumHoldSeconds: clampNumber(input.patternMinimumHoldSeconds, 15, 300, previous.patternMinimumHoldSeconds),
    patternWeights: normalizePatternWeights(input.patternWeights, previous.patternWeights),
    patternIntervals: normalizePatternIntervals(input.patternIntervals, previous.patternIntervals),
    requireManualConfirm: input.requireManualConfirm !== false,
  };
  next.confidenceConservativeThreshold = Math.min(next.confidenceFullThreshold, next.confidenceConservativeThreshold);
  next.confidenceHoldThreshold = Math.min(next.confidenceConservativeThreshold, next.confidenceHoldThreshold);
  if (next.intensityCeiling < next.intensityFloor) {
    next.intensityCeiling = next.intensityFloor;
  }
  if (next.sarahAutoEnabled) {
    if (!next.controlEnabled) throw new Error('Enable manual Howl control before arming Sarah auto-control.');
    if (!next.controlUrl || !next.remoteAccessKey) throw new Error('Configure the Howl URL and access key before arming.');
    if (testedConnectionFingerprint !== connectionFingerprint(next)) {
      throw new Error('Test the current Howl connection before arming Sarah auto-control.');
    }
    if (!['direct_http', 'queue_and_direct'].includes(next.dispatchMode)) {
      throw new Error('Sarah auto-control requires direct Howl status reconciliation.');
    }
    if (!Number.isFinite(next.intensityFloor) || !Number.isFinite(next.intensityCeiling)) {
      throw new Error('Save a valid Howl intensity floor and ceiling before arming.');
    }
  }
  return upsertEntity('HowlControlSettings', SETTINGS_ID, next);
}

function normalizeControlCommand(body = {}, settings = getSettings()) {
  const action = String(body.action || body.command || '').trim().toLowerCase();
  const allowedActions = new Set([
    'set_state',
    'set_intensity',
    'adjust_intensity',
    'set_frequency',
    'set_mode',
    'set_playback',
    'load_activity',
    'increment_power',
    'decrement_power',
    'set_power',
    'set_mute',
    'stop',
    'emergency_stop',
  ]);
  if (!allowedActions.has(action)) {
    throw new Error('Unsupported Howl command action.');
  }

  const channel = String(body.channel || body.channel_id || body.channelId || 'a').trim().toLowerCase();
  const intensity = body.intensity == null
    ? null
    : clampNumber(body.intensity, settings.intensityFloor, settings.intensityCeiling, null);
  if (['set_state', 'set_intensity', 'set_power'].includes(action) && intensity == null) {
    throw new Error('Howl intensity is required for an absolute power command.');
  }
  const frequency_hz = body.frequency_hz == null && body.frequencyHz == null && body.frequency == null
    ? null
    : clampNumber(body.frequency_hz ?? body.frequencyHz ?? body.frequency, 0, 300, null);
  const activityName = body.activity_name ?? body.activityName ?? body.name ?? null;

  return {
    id: body.id || randomUUID(),
    source: 'pulsepoint',
    action,
    channel,
    intensity,
    intensity_delta: body.intensity_delta == null && body.intensityDelta == null ? null : clampNumber(body.intensity_delta ?? body.intensityDelta, -25, 25, null),
    frequency_hz,
    mode: body.mode == null ? null : String(body.mode).trim(),
    activity_name: activityName == null ? null : String(activityName).trim().toUpperCase(),
    activity_display_name: body.activity_display_name == null && body.activityDisplayName == null ? null : String(body.activity_display_name ?? body.activityDisplayName).trim(),
    play: body.play == null ? null : Boolean(body.play),
    waveform: body.waveform == null ? null : String(body.waveform).trim(),
    enabled: body.enabled == null ? null : Boolean(body.enabled),
    value: body.value == null ? null : Boolean(body.value),
    step: clampNumber(body.step, 0, 50, 1),
    playback_status: body.playback_status == null && body.playbackStatus == null ? null : String(body.playback_status ?? body.playbackStatus).trim(),
    session: body.session || body.session_id || body.sessionId || null,
    reason: String(body.reason || 'manual_live_capture').slice(0, 200),
    manual: body.manual === true || !String(body.reason || '').startsWith('sarah_auto_'),
    limits: {
      intensityFloor: settings.intensityFloor,
      intensityCeiling: settings.intensityCeiling,
      rampRateLimitPerSecond: settings.rampRateLimitPerSecond,
    },
    created_at: new Date().toISOString(),
    status: 'queued',
    dispatch: null,
    raw: {
      ...body,
      remoteAccessKey: body.remoteAccessKey ? '[redacted]' : undefined,
    },
  };
}

function commandPayload(command) {
  return {
    id: command.id,
    source: command.source,
    action: command.action,
    channel: command.channel,
    intensity: command.intensity,
    intensity_delta: command.intensity_delta,
    frequency_hz: command.frequency_hz,
    mode: command.mode,
    activity_name: command.activity_name,
    activity_display_name: command.activity_display_name,
    play: command.play,
    waveform: command.waveform,
    enabled: command.enabled,
    value: command.value,
    step: command.step,
    playback_status: command.playback_status,
    session: command.session,
    reason: command.reason,
    limits: command.limits,
    created_at: command.created_at,
  };
}

function channelIndex(channel) {
  const normalized = String(channel || '').trim().toLowerCase();
  if (normalized === 'b' || normalized === '1') return 1;
  return 0;
}

function directHowlRequestForCommand(command) {
  const channel = channelIndex(command.channel);
  if (command.action === 'set_mute' || command.action === 'stop') {
    return { endpoint: '/set_mute', body: command.value == null ? {} : { value: command.value } };
  }
  if (command.action === 'set_power' || command.action === 'set_intensity' || command.action === 'set_state') {
    if (!Number.isFinite(Number(command.intensity))) {
      throw new Error('Howl intensity is required for an absolute power command.');
    }
    const power = Number(command.intensity);
    if (command.channel === 'all') return { endpoint: '/set_power', body: { power_a: power, power_b: power } };
    return { endpoint: '/set_power', body: channel === 1 ? { power_b: power } : { power_a: power } };
  }
  if (command.action === 'load_activity') {
    if (!command.activity_name) {
      throw new Error('Howl activity name is required.');
    }
    return { endpoint: '/load_activity', body: { name: command.activity_name, play: command.play === true } };
  }
  return { endpoint: '/status', body: {} };
}

function powerFromStatus(statusData, channel) {
  const options = statusData?.options || {};
  return channel === 1 ? clampNumber(options.power_b, 0, 200, 0) : clampNumber(options.power_a, 0, 200, 0);
}

function setPowerBody(channel, power) {
  return channel === 1 ? { power_b: power } : { power_a: power };
}

async function dispatchCommand(command, settings) {
  if (!settings.controlUrl || !['direct_http', 'queue_and_direct'].includes(settings.dispatchMode)) {
    return { mode: 'queue', sent: false, message: 'Queued for Howl helper polling.' };
  }

  try {
    let result;
    if (command.action === 'emergency_stop') {
      const mute = await requestHowl(settings, '/set_mute', { value: true });
      const zero = await requestHowl(settings, '/set_power', { power_a: 0, power_b: 0 });
      result = {
        status: zero.status,
        text: zero.text,
        data: zero.data,
        emergency: [
          { endpoint: '/set_mute', status: mute.status },
          { endpoint: '/set_power', status: zero.status },
        ],
      };
    } else {
      if (command.action === 'increment_power' || command.action === 'decrement_power') {
        const channel = channelIndex(command.channel);
        const status = await requestHowl(settings, '/status', {});
        const currentPower = powerFromStatus(status.data, channel);
        const direction = command.action === 'increment_power' ? 1 : -1;
        const targetPower = clampNumber(
          currentPower + direction * (command.step ?? 1),
          settings.intensityFloor,
          settings.intensityCeiling,
          currentPower,
        );
        const powerResult = await requestHowl(settings, '/set_power', setPowerBody(channel, targetPower));
        result = {
          ...powerResult,
          ceiling: settings.intensityCeiling,
          previousPower: currentPower,
          targetPower,
        };
      } else {
        const request = directHowlRequestForCommand(command);
        const reconciled = await executeReconciledHowlCommand({
          command,
          settings,
          request: requestHowl,
          commandRequest: request,
        });
        return {
          mode: 'direct_http',
          sent: reconciled.sent,
          status: reconciled.sent ? 200 : null,
          response: '',
          howl: summarizeHowlResponse(reconciled.statusData),
          reconciliation: reconciled.reconciliation,
          commandTimedOut: reconciled.commandTimedOut,
          commandLatencyMs: reconciled.latencyMs,
          structuredLogs: reconciled.logs,
          safetyAction: reconciled.safetyAction,
          error: reconciled.error,
          message: reconciled.safetyAction === 'mute_disarm'
            ? 'Safety mute sent; Sarah auto-control was disarmed.'
            : reconciled.reconciliation.result === 'applied'
              ? 'Command applied and verified against Howl status.'
              : reconciled.reconciliation.result === 'unverified'
                ? 'Command sent; Howl status did not expose enough detail to verify it.'
                : 'Howl status did not match the requested command.',
        };
      }
    }
    return {
      mode: 'direct_http',
      sent: true,
      status: result.status,
      response: result.text?.slice(0, 1000) || '',
      howl: summarizeHowlResponse(result.data),
      emergency: result.emergency || null,
      message: command.action === 'emergency_stop' ? 'Emergency stop sent to Howl.' : 'Command sent to Howl.',
    };
  } catch (error) {
    return {
      mode: 'direct_http',
      sent: false,
      status: error?.status || null,
      error: error?.message || String(error),
      message: 'Queued locally after direct dispatch failed.',
    };
  }
}

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
  const settings = getSettings();
  res.json({
    ok: true,
    mode: settings.controlEnabled ? 'manual_control' : 'manual_control_disabled',
    message: settings.controlEnabled
      ? 'Sarah can send bounded manual Howl commands. HR/HRV automatic control is available when armed in Live Capture.'
      : 'Howl manual control is available but disabled until explicitly enabled.',
    safeguards: {
      ...HOWL_CONTROL_DEFAULT_LIMITS,
      intensityFloor: settings.intensityFloor,
      intensityCeiling: settings.intensityCeiling,
      rampRateLimitPerSecond: settings.rampRateLimitPerSecond,
    },
    supports: {
      queue: true,
      direct_http: true,
      emergency_stop: true,
      automatic_closed_loop: true,
    },
    settings: {
      controlEnabled: settings.controlEnabled,
      sarahAutoEnabled: settings.sarahAutoEnabled,
      dispatchMode: settings.dispatchMode,
      hasControlUrl: Boolean(settings.controlUrl),
      intensityFloor: settings.intensityFloor,
      intensityCeiling: settings.intensityCeiling,
      rampRateLimitPerSecond: settings.rampRateLimitPerSecond,
      buildRampEnabled: settings.buildRampEnabled,
      nearClimaxReductionEnabled: settings.nearClimaxReductionEnabled,
      recoveryReductionEnabled: settings.recoveryReductionEnabled,
      finalApproachEnabled: settings.finalApproachEnabled,
      buildStep: settings.buildStep,
      finalApproachStep: settings.finalApproachStep,
      reduceStep: settings.reduceStep,
      maxRecoveryRetreat: settings.maxRecoveryRetreat,
      nearClimaxThreshold: settings.nearClimaxThreshold,
      plateauThreshold: settings.plateauThreshold,
      buildThreshold: settings.buildThreshold,
      recoveryThreshold: settings.recoveryThreshold,
      autoCooldownSeconds: settings.autoCooldownSeconds,
      patternDirectorEnabled: settings.patternDirectorEnabled,
      patternMinimumHoldSeconds: settings.patternMinimumHoldSeconds,
      patternWeights: settings.patternWeights,
      patternIntervals: settings.patternIntervals,
      requireManualConfirm: settings.requireManualConfirm,
      buildExitThreshold: settings.buildExitThreshold,
      plateauExitThreshold: settings.plateauExitThreshold,
      finalApproachExitThreshold: settings.finalApproachExitThreshold,
      recoveryExitThreshold: settings.recoveryExitThreshold,
      buildConfirmationSeconds: settings.buildConfirmationSeconds,
      plateauConfirmationSeconds: settings.plateauConfirmationSeconds,
      finalApproachConfirmationSeconds: settings.finalApproachConfirmationSeconds,
      recoveryConfirmationSeconds: settings.recoveryConfirmationSeconds,
      confidenceFullThreshold: settings.confidenceFullThreshold,
      confidenceConservativeThreshold: settings.confidenceConservativeThreshold,
      confidenceHoldThreshold: settings.confidenceHoldThreshold,
      lowConfidenceHoldSeconds: settings.lowConfidenceHoldSeconds,
      telemetryReduceIntervalSeconds: settings.telemetryReduceIntervalSeconds,
      telemetryMuteTimeoutSeconds: settings.telemetryMuteTimeoutSeconds,
      telemetryFreshnessMs: settings.telemetryFreshnessMs,
      breathHoldAmbiguitySeconds: settings.breathHoldAmbiguitySeconds,
      recoveryObservationSeconds: settings.recoveryObservationSeconds,
      responseObservationSeconds: settings.responseObservationSeconds,
      buildUpwardPointsPerMinute: settings.buildUpwardPointsPerMinute,
      finalApproachUpwardPointsPerMinute: settings.finalApproachUpwardPointsPerMinute,
    },
  });
});

howlRouter.get('/control/settings', (_req, res) => {
  res.json({ ok: true, settings: getSettings() });
});

howlRouter.get('/control/status', async (_req, res) => {
  const settings = getSettings();
  if (!settings.controlUrl) {
    return res.status(400).json({ ok: false, message: 'Howl phone URL is not configured.' });
  }
  if (!settings.remoteAccessKey) {
    return res.status(400).json({ ok: false, message: 'Howl remote access key is not configured.' });
  }
  try {
    const result = await requestHowl(settings, '/status', {}, { timeoutMs: 3000 });
    res.json({
      ok: true,
      status: result.status,
      measured_at: new Date().toISOString(),
      howl: summarizeHowlResponse(result.data),
      raw: result.data,
    });
  } catch (error) {
    res.status(error?.status || 502).json({
      ok: false,
      message: error?.message || 'Could not read Howl status.',
      status: error?.status || null,
    });
  }
});

howlRouter.post('/control/settings', (req, res) => {
  try {
    const settings = saveSettings(req.body || {});
    res.json({ ok: true, settings });
  } catch (error) {
    res.status(error?.status || 400).json({ ok: false, error: error?.message || String(error) });
  }
});

howlRouter.post('/control/test', async (req, res) => {
  try {
    const result = await testHowlConnection(req.body || {});
    if (result.ok) {
      testedConnectionFingerprint = connectionFingerprint({ ...getSettings(), ...(req.body || {}) });
    }
    res.status(result.ok ? 200 : result.status || 502).json(result);
  } catch (error) {
    res.status(error?.status || 400).json({ ok: false, message: error?.message || String(error), raw: '' });
  }
});

howlRouter.get('/control/commands', (req, res) => {
  const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
  const rows = listEntities('HowlControlCommand')
    .sort((a, b) => String(b.created_at || b.created_date || '').localeCompare(String(a.created_at || a.created_date || '')))
    .slice(0, limit);
  res.json({ ok: true, commands: rows });
});

howlRouter.get('/control/next', (req, res) => {
  const limit = Math.max(1, Math.min(20, Number(req.query.limit) || 5));
  const client = String(req.query.client || 'howl-helper').slice(0, 80);
  const now = new Date().toISOString();
  const pending = listEntities('HowlControlCommand')
    .filter((cmd) => ['queued', 'dispatch_failed'].includes(cmd.status))
    .sort((a, b) => String(a.created_at || a.created_date || '').localeCompare(String(b.created_at || b.created_date || '')))
    .slice(0, limit);
  const commands = pending.map((cmd) => {
    const next = {
      ...cmd,
      status: 'delivered',
      delivered_at: now,
      delivered_to: client,
    };
    upsertEntity('HowlControlCommand', next.id, next);
    return commandPayload(next);
  });
  res.json({ ok: true, commands });
});

howlRouter.post('/control/:id/ack', (req, res) => {
  const id = String(req.params.id || '');
  const existing = getEntity('HowlControlCommand', id);
  if (!existing) return res.status(404).json({ ok: false, error: 'Howl command not found.' });
  const status = ['applied', 'rejected', 'failed'].includes(req.body?.status) ? req.body.status : 'applied';
  const updated = upsertEntity('HowlControlCommand', id, {
    ...existing,
    status,
    ack_at: new Date().toISOString(),
    ack: req.body || {},
  });
  return res.json({ ok: true, command: updated });
});

howlRouter.post('/control', async (req, res) => {
  const settings = getSettings();
  if (!settings.controlEnabled) {
    return res.status(409).json({ ok: false, error: 'Howl control is disabled. Enable manual control first.' });
  }
  try {
    const command = normalizeControlCommand(req.body || {}, settings);
    const pendingKey = `${command.session || 'global'}:${command.channel || 'a'}`;
    if (pendingDirectCommands.has(pendingKey)) {
      return res.status(409).json({ ok: false, error: 'A Howl command is already pending reconciliation.' });
    }
    pendingDirectCommands.add(pendingKey);
    let saved = upsertEntity('HowlControlCommand', command.id, command);
    try {
      const dispatch = await dispatchCommand(saved, settings);
      const nextStatus = dispatch.reconciliation?.result === 'applied'
        ? 'applied'
        : dispatch.sent
          ? 'sent'
          : saved.status;
      saved = upsertEntity('HowlControlCommand', saved.id, {
        ...saved,
        status: nextStatus,
        dispatch,
        dispatched_at: new Date().toISOString(),
      });
      if (dispatch.safetyAction === 'mute_disarm') {
        saveSettings({ ...settings, sarahAutoEnabled: false });
      }
      const automaticReconciliationFault = saved.manual === false
        && dispatch.reconciliation?.result !== 'applied';
      if (automaticReconciliationFault) {
        saveSettings({ ...settings, sarahAutoEnabled: false });
      }
      return res.status(dispatch.safetyAction || automaticReconciliationFault ? 409 : 200).json({
        ok: !dispatch.safetyAction && !automaticReconciliationFault,
        command: saved,
        dispatch,
        error: dispatch.safetyAction
          ? dispatch.error
          : automaticReconciliationFault
            ? 'Automatic Howl command was not verified; Sarah auto-control was disarmed.'
            : null,
      });
    } finally {
      pendingDirectCommands.delete(pendingKey);
    }
  } catch (error) {
    return res.status(400).json({ ok: false, error: error?.message || String(error) });
  }
});

howlRouter.get('/control/exposures', (req, res) => {
  const sessionId = req.query.session ? String(req.query.session) : null;
  const limit = Math.max(1, Math.min(1000, Number(req.query.limit) || 200));
  const exposures = listEntities('HowlActivityExposure')
    .filter((row) => !sessionId || row.session_id === sessionId)
    .sort((a, b) => String(b.start_time || '').localeCompare(String(a.start_time || '')))
    .slice(0, limit);
  res.json({ ok: true, exposures });
});

howlRouter.post('/control/exposures', (req, res) => {
  const exposure = createHowlActivityExposure(req.body || {});
  if (!exposure.session_id || !exposure.activity_name) {
    return res.status(400).json({ ok: false, error: 'Session ID and activity name are required.' });
  }
  const saved = upsertEntity('HowlActivityExposure', exposure.id, exposure);
  return res.json({ ok: true, exposure: saved });
});

howlRouter.post('/control/exposures/:id', (req, res) => {
  const existing = getEntity('HowlActivityExposure', String(req.params.id || ''));
  if (!existing) return res.status(404).json({ ok: false, error: 'Howl activity exposure not found.' });
  const saved = upsertEntity('HowlActivityExposure', existing.id, {
    ...existing,
    ...(req.body || {}),
    id: existing.id,
    updated_at: new Date().toISOString(),
  });
  return res.json({ ok: true, exposure: saved });
});

howlRouter.post('/control/emergency-stop', async (req, res) => {
  const currentSettings = getSettings();
  const settings = { ...currentSettings, controlEnabled: true };
  const command = normalizeControlCommand({
    ...(req.body || {}),
    action: 'emergency_stop',
    channel: req.body?.channel || 'all',
    intensity: 0,
    enabled: false,
    playback_status: 'stop',
    reason: req.body?.reason || 'manual_emergency_stop',
  }, settings);
  let saved = upsertEntity('HowlControlCommand', command.id, command);
  const dispatch = await dispatchCommand(saved, settings);
  saved = upsertEntity('HowlControlCommand', saved.id, {
    ...saved,
    status: dispatch.sent ? 'sent' : 'queued',
    dispatch,
    dispatched_at: new Date().toISOString(),
  });
  saveSettings({ ...currentSettings, sarahAutoEnabled: false });
  res.json({ ok: true, command: saved, dispatch });
});
