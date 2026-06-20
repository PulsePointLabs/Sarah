import { cleanHr, HR_SOURCE_IDS, HR_SOURCE_LABELS } from './hrSources.js';

export const OVERLAY_HR_STALE_MS = 8000;

function cleanTimestamp(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
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
    sequence,
    fallbackActive,
    subscribers,
    lastDeliveryAt,
  };
}
