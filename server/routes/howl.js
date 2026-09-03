import express from 'express';
import { randomUUID } from 'node:crypto';
import { getEntity, listEntities, upsertEntity } from '../db.js';
import { HOWL_CONTROL_DEFAULT_LIMITS, normalizeHowlTelemetrySample } from '../services/howlTelemetry.js';
import {
  ABSOLUTE_HOWL_INTENSITY_CEILING,
  MAXIMUM_HOWL_UPWARD_STEP,
  validateAutomaticHowlIncrease,
} from '../services/howlSafety.js';
import { isLiveCaptureObsActivelyRecording, onLiveCaptureObsStateChange } from '../services/liveCaptureObsState.js';
import { readHowlActivityState } from '../services/howlActivityState.js';

export const howlRouter = express.Router();

const SETTINGS_ID = 'default';
const HOWL_DIRECT_API_VERSION = '2.0.1';
const HOWL_DIRECT_ENDPOINTS = Object.freeze([
  'status', 'set_power', 'increment_power', 'decrement_power', 'set_mute',
  'load_activity', 'available_activities', 'start_player', 'stop_player', 'seek',
]);
const HOWL_SAFETY_SETTINGS_VERSION = 2;
const ABSOLUTE_INTENSITY_CEILING = ABSOLUTE_HOWL_INTENSITY_CEILING;
const MAXIMUM_UPWARD_STEP = MAXIMUM_HOWL_UPWARD_STEP;
let automaticControlArmed = false;
let emergencyStopSequence = 0;
const DEFAULT_SETTINGS = Object.freeze({
  id: SETTINGS_ID,
  safetySettingsVersion: HOWL_SAFETY_SETTINGS_VERSION,
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
  maxRecoveryRetreat: 3,
  nearClimaxThreshold: 72,
  plateauThreshold: 60,
  buildThreshold: 32,
  recoveryThreshold: 55,
  autoCooldownSeconds: 8,
  requireManualConfirm: true,
});

onLiveCaptureObsStateChange((activelyRecording) => {
  if (activelyRecording || !automaticControlArmed) return;
  automaticControlArmed = false;
  const saved = getEntity('HowlControlSettings', SETTINGS_ID) || {};
  upsertEntity('HowlControlSettings', SETTINGS_ID, { ...saved, sarahAutoEnabled: false });
});

function clampNumber(value, min, max, fallback = null) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function cleanText(value, max = 500) {
  return String(value ?? '').trim().slice(0, max);
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
  const activity = readHowlActivityState(data);
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
    activity_reported: activity.reported,
    activity_name: activity.name,
    activity_display_name: activity.displayName,
    api_compatibility: HOWL_DIRECT_API_VERSION,
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
  const savedSafetyVersion = Number(saved.safetySettingsVersion || 0);
  const savedCeiling = savedSafetyVersion >= HOWL_SAFETY_SETTINGS_VERSION
    ? saved.intensityCeiling
    : Math.min(Number(saved.intensityCeiling) || DEFAULT_SETTINGS.intensityCeiling, DEFAULT_SETTINGS.intensityCeiling);
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    controlUrl: String(saved.controlUrl || envUrl || '').trim(),
    remoteAccessKey: String(saved.remoteAccessKey || envKey || '').trim(),
    controlEnabled: Boolean(saved.controlEnabled),
    sarahAutoEnabled: automaticControlArmed,
    intensityFloor: clampNumber(saved.intensityFloor, 0, ABSOLUTE_INTENSITY_CEILING, DEFAULT_SETTINGS.intensityFloor),
    safetySettingsVersion: HOWL_SAFETY_SETTINGS_VERSION,
    intensityCeiling: clampNumber(savedCeiling, 0, ABSOLUTE_INTENSITY_CEILING, DEFAULT_SETTINGS.intensityCeiling),
    rampRateLimitPerSecond: clampNumber(saved.rampRateLimitPerSecond, 0, MAXIMUM_UPWARD_STEP, DEFAULT_SETTINGS.rampRateLimitPerSecond),
  };
}

function saveSettings(input = {}) {
  const previous = getSettings();
  const next = {
    ...previous,
    safetySettingsVersion: HOWL_SAFETY_SETTINGS_VERSION,
    controlEnabled: Boolean(input.controlEnabled),
    sarahAutoEnabled: Boolean(input.sarahAutoEnabled && input.controlEnabled),
    dispatchMode: ['queue', 'direct_http', 'queue_and_direct'].includes(input.dispatchMode) ? input.dispatchMode : previous.dispatchMode,
    controlUrl: normalizeHowlBaseUrl(input.controlUrl ?? previous.controlUrl ?? ''),
    remoteAccessKey: cleanText(input.remoteAccessKey ?? previous.remoteAccessKey ?? '', 300),
    intensityFloor: clampNumber(input.intensityFloor, 0, ABSOLUTE_INTENSITY_CEILING, previous.intensityFloor),
    intensityCeiling: clampNumber(input.intensityCeiling, 0, ABSOLUTE_INTENSITY_CEILING, previous.intensityCeiling),
    rampRateLimitPerSecond: clampNumber(input.rampRateLimitPerSecond, 0, MAXIMUM_UPWARD_STEP, previous.rampRateLimitPerSecond),
    buildRampEnabled: input.buildRampEnabled !== false,
    nearClimaxReductionEnabled: input.nearClimaxReductionEnabled !== false,
    recoveryReductionEnabled: input.recoveryReductionEnabled !== false,
    finalApproachEnabled: input.finalApproachEnabled !== false,
    buildStep: clampNumber(input.buildStep, 0, MAXIMUM_UPWARD_STEP, previous.buildStep),
    finalApproachStep: clampNumber(input.finalApproachStep, 0, MAXIMUM_UPWARD_STEP, previous.finalApproachStep),
    reduceStep: clampNumber(input.reduceStep, 0, 25, previous.reduceStep),
    maxRecoveryRetreat: clampNumber(input.maxRecoveryRetreat, 0, 25, previous.maxRecoveryRetreat),
    nearClimaxThreshold: clampNumber(input.nearClimaxThreshold, 0, 100, previous.nearClimaxThreshold),
    plateauThreshold: clampNumber(input.plateauThreshold, 0, 100, previous.plateauThreshold),
    buildThreshold: clampNumber(input.buildThreshold, 0, 100, previous.buildThreshold),
    recoveryThreshold: clampNumber(input.recoveryThreshold, 0, 100, previous.recoveryThreshold),
    autoCooldownSeconds: clampNumber(input.autoCooldownSeconds, 2, 120, previous.autoCooldownSeconds),
    requireManualConfirm: input.requireManualConfirm !== false,
  };
  if (next.intensityCeiling < next.intensityFloor) {
    next.intensityCeiling = next.intensityFloor;
  }
  automaticControlArmed = next.sarahAutoEnabled;
  return upsertEntity('HowlControlSettings', SETTINGS_ID, next);
}

function isAutomaticCommand(body = {}) {
  return Boolean(body.controller) || String(body.reason || '').startsWith('sarah_auto_');
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
  const automatic = isAutomaticCommand(body);
  const requestedIntensity = body.intensity == null
    ? null
    : clampNumber(body.intensity, settings.intensityFloor, Math.min(settings.intensityCeiling, ABSOLUTE_INTENSITY_CEILING), null);
  const previousIntensity = clampNumber(body.controller?.previousIntensity ?? body.previousIntensity, 0, ABSOLUTE_INTENSITY_CEILING, null);
  const intensity = requestedIntensity == null || previousIntensity == null
    ? requestedIntensity
    : Math.min(requestedIntensity, previousIntensity + MAXIMUM_UPWARD_STEP);
  const frequency_hz = body.frequency_hz == null && body.frequencyHz == null && body.frequency == null
    ? null
    : clampNumber(body.frequency_hz ?? body.frequencyHz ?? body.frequency, 0, 300, null);
  const activityName = body.activity_name ?? body.activityName ?? body.name ?? null;

  return {
    id: body.id || randomUUID(),
    source: automatic ? 'sarah_auto' : 'pulsepoint',
    action,
    channel,
    intensity,
    intensity_delta: body.intensity_delta == null && body.intensityDelta == null ? null : clampNumber(body.intensity_delta ?? body.intensityDelta, -25, MAXIMUM_UPWARD_STEP, null),
    frequency_hz,
    mode: body.mode == null ? null : String(body.mode).trim(),
    activity_name: activityName == null ? null : String(activityName).trim().toUpperCase(),
    activity_display_name: body.activity_display_name == null && body.activityDisplayName == null ? null : String(body.activity_display_name ?? body.activityDisplayName).trim(),
    play: body.play == null ? null : Boolean(body.play),
    waveform: body.waveform == null ? null : String(body.waveform).trim(),
    enabled: body.enabled == null ? null : Boolean(body.enabled),
    value: body.value == null ? null : Boolean(body.value),
    step: clampNumber(body.step, 0, MAXIMUM_UPWARD_STEP, 1),
    playback_status: body.playback_status == null && body.playbackStatus == null ? null : String(body.playback_status ?? body.playbackStatus).trim(),
    session: body.session || body.session_id || body.sessionId || null,
    reason: String(body.reason || 'manual_live_capture').slice(0, 200),
    manual: !automatic,
    emergency_stop_sequence: automatic ? emergencyStopSequence : null,
    limits: {
      intensityFloor: settings.intensityFloor,
      intensityCeiling: settings.intensityCeiling,
      rampRateLimitPerSecond: settings.rampRateLimitPerSecond,
      absoluteIntensityCeiling: ABSOLUTE_INTENSITY_CEILING,
      maximumUpwardStep: MAXIMUM_UPWARD_STEP,
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
    const power = command.intensity == null ? 0 : command.intensity;
    if (command.channel === 'all') return { endpoint: '/set_power', body: { power_a: power, power_b: power } };
    return { endpoint: '/set_power', body: channel === 1 ? { power_b: power } : { power_a: power } };
  }
  if (command.action === 'load_activity') {
    if (!command.activity_name) {
      throw new Error('Howl activity name is required.');
    }
    return { endpoint: '/load_activity', body: { name: command.activity_name, play: command.play === true } };
  }
  if (command.action === 'set_frequency') {
    throw new Error('Howl 2.0.1 does not expose direct frequency control. Use a saved Howl activity or the queue helper.');
  }
  if (command.action === 'set_mode') {
    throw new Error('Howl 2.0.1 does not expose direct mode control. Load a named Howl activity instead.');
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
    if (command.action === 'emergency_stop' || command.action === 'stop') {
      const [muteResult, zeroResult, stopResult] = await Promise.allSettled([
        requestHowl(settings, '/set_mute', { value: true }),
        requestHowl(settings, '/set_power', { power_a: 0, power_b: 0 }),
        requestHowl(settings, '/stop_player', {}),
      ]);
      const mute = muteResult.status === 'fulfilled' ? muteResult.value : null;
      const zero = zeroResult.status === 'fulfilled' ? zeroResult.value : null;
      const stop = stopResult.status === 'fulfilled' ? stopResult.value : null;
      if (!mute || !zero) {
        throw muteResult.status === 'rejected' ? muteResult.reason : zeroResult.reason;
      }
      result = {
        status: zero?.status || mute?.status || stop?.status,
        text: zero?.text || mute?.text || stop?.text,
        data: zero?.data || mute?.data || stop?.data,
        emergency: [
          { endpoint: '/set_mute', status: mute?.status || null, sent: Boolean(mute) },
          { endpoint: '/set_power', status: zero?.status || null, sent: Boolean(zero) },
          { endpoint: '/stop_player', status: stop?.status || null, sent: Boolean(stop) },
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
      } else if (['set_power', 'set_intensity', 'set_state'].includes(command.action)) {
        const status = await requestHowl(settings, '/status', {});
        const requested = clampNumber(command.intensity, settings.intensityFloor, Math.min(settings.intensityCeiling, ABSOLUTE_INTENSITY_CEILING), 0);
        const currentA = powerFromStatus(status.data, 0);
        const currentB = powerFromStatus(status.data, 1);
        const targetA = Math.min(requested, currentA + MAXIMUM_UPWARD_STEP);
        const targetB = Math.min(requested, currentB + MAXIMUM_UPWARD_STEP);
        const body = command.channel === 'all'
          ? { power_a: targetA, power_b: targetB }
          : setPowerBody(channelIndex(command.channel), command.channel === 'b' ? targetB : targetA);
        if (command.source === 'sarah_auto' && command.emergency_stop_sequence !== emergencyStopSequence) {
          throw new Error('Automatic command cancelled by emergency stop.');
        }
        const powerResult = await requestHowl(settings, '/set_power', body);
        if (command.source === 'sarah_auto' && command.emergency_stop_sequence !== emergencyStopSequence) {
          await Promise.allSettled([
            requestHowl(settings, '/set_mute', { value: true }),
            requestHowl(settings, '/set_power', { power_a: 0, power_b: 0 }),
            requestHowl(settings, '/stop_player', {}),
          ]);
          throw new Error('Automatic command superseded by emergency stop; stop state reasserted.');
        }
        result = {
          ...powerResult,
          ceiling: settings.intensityCeiling,
          maximumUpwardStep: MAXIMUM_UPWARD_STEP,
          previousPower: command.channel === 'b' ? currentB : currentA,
          targetPower: command.channel === 'all' ? { a: targetA, b: targetB } : command.channel === 'b' ? targetB : targetA,
        };
      } else {
        const request = directHowlRequestForCommand(command);
        result = await requestHowl(settings, request.endpoint, request.body);
      }
    }
    return {
      mode: 'direct_http',
      sent: true,
      status: result.status,
      response: result.text?.slice(0, 1000) || '',
      howl: summarizeHowlResponse(result.data),
      emergency: result.emergency || null,
      previousPower: result.previousPower ?? null,
      targetPower: result.targetPower ?? null,
      ceiling: result.ceiling ?? null,
      maximumUpwardStep: result.maximumUpwardStep ?? null,
      message: command.action === 'emergency_stop'
        ? 'Emergency stop sent to Howl.'
        : command.action === 'stop'
          ? 'Howl output muted, power set to zero, and playback stopped.'
          : 'Command sent to Howl.',
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
      howl_api_version: HOWL_DIRECT_API_VERSION,
      direct_endpoints: HOWL_DIRECT_ENDPOINTS,
      direct_frequency_control: false,
      direct_mode_control: false,
      named_activity_loading: true,
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
      requireManualConfirm: settings.requireManualConfirm,
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
    .filter((cmd) => cmd.action === 'emergency_stop' || !cmd.cancelled_by_emergency_stop)
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
    if (isAutomaticCommand(req.body || {})) {
      if (!settings.sarahAutoEnabled) {
        return res.status(409).json({ ok: false, error: 'Automatic Howl control is not armed.' });
      }
      if (!isLiveCaptureObsActivelyRecording()) {
        return res.status(409).json({ ok: false, error: 'Automatic Howl control only operates while OBS is actively recording.' });
      }
      const validation = validateAutomaticHowlIncrease(req.body || {}, settings);
      if (!validation.ok) return res.status(409).json({ ok: false, error: validation.error });
    }
    const command = normalizeControlCommand(req.body || {}, settings);
    let saved = upsertEntity('HowlControlCommand', command.id, command);
    const dispatch = await dispatchCommand(saved, settings);
    if (saved.source === 'sarah_auto' && saved.emergency_stop_sequence !== emergencyStopSequence) {
      saved = upsertEntity('HowlControlCommand', saved.id, {
        ...saved,
        status: 'cancelled',
        cancelled_at: new Date().toISOString(),
        cancelled_by_emergency_stop: true,
        dispatch,
      });
      return res.status(409).json({ ok: false, error: 'Automatic command cancelled by emergency stop.', command: saved });
    }
    const nextStatus = dispatch.sent ? 'sent' : saved.status;
    saved = upsertEntity('HowlControlCommand', saved.id, {
      ...saved,
      status: nextStatus,
      dispatch,
      dispatched_at: new Date().toISOString(),
    });
    return res.json({ ok: true, command: saved, dispatch });
  } catch (error) {
    return res.status(400).json({ ok: false, error: error?.message || String(error) });
  }
});

howlRouter.post('/control/emergency-stop', async (req, res) => {
  emergencyStopSequence += 1;
  automaticControlArmed = false;
  const currentSettings = getSettings();
  const settings = { ...currentSettings, controlEnabled: true, sarahAutoEnabled: false };
  upsertEntity('HowlControlSettings', SETTINGS_ID, { ...currentSettings, sarahAutoEnabled: false });
  const cancelledAt = new Date().toISOString();
  for (const pending of listEntities('HowlControlCommand').filter((item) => (
    item.source === 'sarah_auto' && ['queued', 'dispatch_failed', 'delivered'].includes(item.status)
  ))) {
    upsertEntity('HowlControlCommand', pending.id, {
      ...pending,
      status: 'cancelled',
      cancelled_at: cancelledAt,
      cancelled_by_emergency_stop: true,
    });
  }
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
  res.json({ ok: true, command: saved, dispatch });
});
