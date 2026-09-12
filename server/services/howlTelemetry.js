import { randomUUID } from 'node:crypto';

const CHANNEL_KEYS = ['a', 'b', 'c', 'd', 'left', 'right', 'main'];

function asNumber(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function firstNumber(...values) {
  for (const value of values) {
    const n = asNumber(value);
    if (n != null) return n;
  }
  return null;
}

function firstText(...values) {
  for (const value of values) {
    const text = value == null ? '' : String(value).trim();
    if (text) return text;
  }
  return null;
}

function normalizeChannelState(input = {}) {
  const channels = input.channels || input.channel_state || input.channelState || null;
  // Flat channel fields are valid even without a nested channels object.
  const out = {};
  for (const key of Object.keys(channels || {})) {
    const channel = channels[key];
    if (channel && typeof channel === 'object') {
      out[key] = {
        ...channel,
        enabled: channel.enabled ?? channel.active ?? null,
        intensity: firstNumber(channel.intensity, channel.level, channel.power),
        frequency_hz: firstNumber(channel.frequency_hz, channel.frequencyHz, channel.frequency, channel.freq),
        mode: firstText(channel.mode, channel.program, channel.pattern),
        waveform: firstText(channel.waveform, channel.wave, channel.shape),
      };
    } else {
      out[key] = channel;
    }
  }
  for (const key of CHANNEL_KEYS) {
    const prefix = `${key}_`;
    const intensity = firstNumber(input[`${prefix}intensity`], input[`${prefix}level`], input[`${prefix}power`]);
    const frequency = firstNumber(input[`${prefix}frequency_hz`], input[`${prefix}frequencyHz`], input[`${prefix}frequency`], input[`${prefix}freq`]);
    const mode = firstText(input[`${prefix}mode`], input[`${prefix}program`], input[`${prefix}pattern`]);
    if (intensity != null || frequency != null || mode) {
      out[key] = {
        ...(out[key] && typeof out[key] === 'object' ? out[key] : {}),
        intensity: intensity ?? out[key]?.intensity ?? null,
        frequency_hz: frequency ?? out[key]?.frequency_hz ?? null,
        mode: mode ?? out[key]?.mode ?? null,
      };
    }
  }
  return Object.keys(out).length ? out : null;
}

export const HOWL_CONTROL_DEFAULT_LIMITS = Object.freeze({
  readOnly: false,
  manualOverrideRequired: true,
  emergencyStopRequired: true,
  intensityFloor: 0,
  intensityCeiling: 10,
  absoluteIntensityCeiling: 15,
  maximumUpwardStep: 2,
  rampRateLimitPerSecond: 2,
});

export function normalizeHowlTelemetrySample(input = {}) {
  const now = new Date().toISOString();
  const options = input.options || {};
  const player = input.player || {};
  const channels = normalizeChannelState({ ...options, ...input,
    a_power: options.power_a ?? input.a_power,
    b_power: options.power_b ?? input.b_power });
  const sample = {
    id: input.id || randomUUID(),
    source: 'howl',
    session: input.session || input.session_id || input.sessionId || null,
    measured_at: firstText(input.measured_at, input.measuredAt, input.timestamp, input.time, input.created_at) || now,
    received_at: now,
    power_level: firstNumber(input.power_level, input.powerLevel, input.power, input.level),
    intensity: firstNumber(input.intensity, input.intensity_pct, input.intensityPercent),
    frequency_hz: firstNumber(input.frequency_hz, input.frequencyHz, input.frequency, input.freq),
    pulse_width_us: firstNumber(input.pulse_width_us, input.pulseWidthUs, input.pulseWidth),
    mode: firstText(input.mode, input.program, input.pattern),
    waveform: firstText(input.waveform, input.wave, input.shape),
    playback_status: firstText(input.playback_status, input.playbackStatus, input.playback, input.transport),
    activity_state: firstText(input.activity_state, input.activityState, input.state, input.status),
    channel_state: scrubHowlSecrets(channels),
    options: scrubHowlSecrets(options),
    player: scrubHowlSecrets(player),
    activity_name: firstText(input.activity_name, input.activity, player.title),
    script_title: firstText(player.title, player.filename, player.file),
    mute: options.mute ?? input.mute ?? null,
    swap_channels: options.swap_channels ?? null,
    auto_increase_power: options.auto_increase_power ?? null,
    raw: scrubHowlSecrets(input),
  };
  return sample;
}

// Howl settings can contain credentials in future versions: never persist them.
export function scrubHowlSecrets(value) {
  if (Array.isArray(value)) return value.map(scrubHowlSecrets);
  if (!value || typeof value !== 'object') return value;
  return Object.fromEntries(Object.entries(value).filter(([key]) => !/key|token|password|authorization|secret/i.test(key))
    .map(([key, item]) => [key, scrubHowlSecrets(item)]));
}
