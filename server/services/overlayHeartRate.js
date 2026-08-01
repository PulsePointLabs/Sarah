import { cleanHr, HR_SOURCE_IDS, HR_SOURCE_LABELS } from './hrSources.js';
import { SHARED_HR_PACKET_STALE_MS } from './hrFreshness.js';

export const OVERLAY_HR_STALE_MS = SHARED_HR_PACKET_STALE_MS;

function cleanTimestamp(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function cleanNumber(value, { min = -Infinity, max = Infinity, decimals = 1 } = {}) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric) || numeric < min || numeric > max) return null;
  return Number(numeric.toFixed(decimals));
}

function cleanText(value, fallback = null) {
  const text = String(value || '').trim();
  return text ? text.slice(0, 64) : fallback;
}

export function normalizeOverlayPhysiology(telemetry = {}, { stale = false } = {}) {
  const hrv = telemetry?.hrv || {};
  const multimodal = telemetry?.multimodal || {};
  const respiration = multimodal?.respiration || {};
  const motion = multimodal?.motion || {};
  const recovery = multimodal?.recovery || {};
  const state = multimodal?.state || {};
  const signalConfidence = cleanNumber(multimodal?.signalConfidence?.score, { min: 0, max: 100, decimals: 0 });
  const rmssdMs = cleanNumber(hrv?.rmssdMs ?? telemetry?.hrv_rmssd_ms, { min: 0.1, max: 500 });
  const respirationBpm = respiration?.available === true
    ? cleanNumber(respiration?.bpm, { min: 3, max: 60 })
    : null;
  const motionRmsMilliG = motion?.available === true
    ? cleanNumber(motion?.dynamicRmsMilliG, { min: 0, max: 8000, decimals: 0 })
    : null;
  const recoveryDropBpm = recovery?.available === true
    ? cleanNumber(recovery?.currentDropBpm, { min: 0, max: 150, decimals: 0 })
    : null;

  return {
    stale: Boolean(stale),
    signalConfidence: stale ? null : signalConfidence,
    state: stale ? null : {
      key: cleanText(state?.key),
      label: cleanText(state?.label || state?.key),
      tone: cleanText(state?.tone),
    },
    hrv: {
      available: !stale && rmssdMs != null,
      rmssdMs: stale ? null : rmssdMs,
      quality: stale ? null : cleanText(hrv?.quality),
      sampleCount: stale ? null : cleanNumber(hrv?.sampleCount, { min: 0, max: 10000, decimals: 0 }),
    },
    respiration: {
      available: !stale && respirationBpm != null,
      bpm: stale ? null : respirationBpm,
      confidence: stale ? null : cleanText(respiration?.confidence),
      source: stale ? null : cleanText(respiration?.source),
      possibleBreathHold: !stale && Boolean(respiration?.possibleBreathHold),
      reason: stale ? 'telemetry_stale' : cleanText(respiration?.reason),
    },
    motion: {
      available: !stale && motion?.available === true && (motionRmsMilliG != null || Boolean(motion?.class)),
      class: stale || motion?.available !== true ? null : cleanText(motion?.class),
      dynamicRmsMilliG: stale ? null : motionRmsMilliG,
      reason: stale ? 'telemetry_stale' : cleanText(motion?.reason),
    },
    recovery: {
      available: !stale && recoveryDropBpm != null,
      currentDropBpm: stale ? null : recoveryDropBpm,
    },
  };
}

export function normalizeOverlayHeartRateSnapshot({
  telemetry,
  sourceStatus = {},
  sequence = 0,
  subscribers = 0,
  lastDeliveryAt = null,
  now = Date.now(),
  staleMs = OVERLAY_HR_STALE_MS,
  fallbackActive = false,
} = {}) {
  const heartRate = cleanHr(
    telemetry?.heartRate
    ?? telemetry?.currentHr
    ?? telemetry?.hr
    ?? telemetry?.bpm
  );
  const measuredAt = cleanTimestamp(
    telemetry?.measuredAt
    ?? telemetry?.measured_at
    ?? telemetry?.timestampMs
    ?? telemetry?.engineWallTimeMs
  );
  const receivedAt = cleanTimestamp(telemetry?.receivedAt ?? telemetry?.received_at) || measuredAt;
  const ageBase = receivedAt || measuredAt;
  const ageMs = ageBase ? Math.max(0, now - ageBase) : null;
  const stale = heartRate == null || Boolean(telemetry?.quality?.stale) || (ageMs != null && ageMs > staleMs);
  const source = telemetry?.source || sourceStatus.source || HR_SOURCE_IDS.HEART_RATE_ON_STREAM;

  return {
    kind: 'overlay_heart_rate_snapshot',
    source,
    sourceLabel: telemetry?.sourceLabel || sourceStatus.label || HR_SOURCE_LABELS[source] || source,
    heartRate: stale ? null : heartRate,
    currentHr: stale ? null : heartRate,
    measuredAt,
    receivedAt,
    ageMs,
    connected: Boolean(sourceStatus.connected) && !stale,
    stale,
    physiology: normalizeOverlayPhysiology(telemetry, { stale }),
    sequence,
    fallbackActive,
    subscribers,
    lastDeliveryAt,
  };
}
