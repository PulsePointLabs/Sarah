function cleanNumber(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function cleanHr(value) {
  const number = cleanNumber(value);
  return number != null && number >= 25 && number <= 250 ? Math.round(number) : null;
}

function median(values = []) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
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

export function deriveLiveHrTelemetry(telemetry, derivedHrState, fallbackSource = "unknown") {
  const hr = cleanHr(telemetry?.heartRate || telemetry?.currentHr || telemetry?.hr);
  if (hr == null) return telemetry;
  const source = telemetry?.source || fallbackSource;
  const now = Number(telemetry?.receivedAt || telemetry?.measuredAt) || Date.parse(telemetry?.receivedAt || telemetry?.measuredAt || '') || Date.now();
  const hrv = telemetry?.hrv || {};
  const rmssd = readTelemetryRmssd(telemetry);
  const rrCount = cleanNumber(telemetry?.quality?.rrCount) ?? cleanNumber(hrv.sampleCount) ?? 0;
  const hrvQuality = hrv.quality || telemetry?.hrv_quality || telemetry?.quality?.hrvQuality || null;
  const rows = (derivedHrState.get(source) || [])
    .filter((row) => now - row.t <= 4 * 60 * 60 * 1000);
  const nextRow = { t: now, hr, rmssd };
  const previousRow = rows[rows.length - 1];
  // Direct H10 packets arrive several times per second. Keep a time-based history,
  // not a packet-count history, or a 240-point "8 minute" baseline is really only
  // about one minute and quickly chases a sustained build upward.
  if (previousRow && now - previousRow.t < 900) rows[rows.length - 1] = nextRow;
  else rows.push(nextRow);
  const trimmed = rows.slice(-14400);
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
  const recentHrLiftCount = trimmed.slice(-12).filter((row) => row.hr >= baselineHr + 8).length;
  const persistentHrLift = trimmed.slice(-12).filter((row) => row.hr >= baselineHr + 10).length >= 3;
  const persistentSlopeRise = slopeBpm30s >= 2 && elevatedDelta >= 8 && recentHrLiftCount >= 3;
  const buildCandidate = elevatedDelta >= 12
    || persistentSlopeRise
    || ((hrvCompressed || hrvTightening) && elevatedDelta >= 8);

  const phase = (dropFromPeak >= 8 && elevatedDelta <= 12 && (slopeBpm30s <= 0.5 || hrvRecoveryBias))
    ? 'recovery'
    : (buildCandidate && (persistentHrLift || persistentSlopeRise || ((hrvCompressed || hrvTightening) && recentHrLiftCount >= 2)))
      ? 'build'
      : 'baseline';

  let buildConfidence = elevatedDelta * 7 + Math.max(0, slopeBpm30s) * 4;
  if (hrvCompressed) buildConfidence += 12;
  else if (hrvTightening) buildConfidence += 8;
  else if (hrvRecoveryBias) buildConfidence -= 8;
  if (phase === 'recovery') {
    buildConfidence -= dropFromPeak * 2;
    if (hrvRecoveryBias) buildConfidence -= 8;
  } else if (phase !== 'build' && elevatedDelta < 10) {
    buildConfidence = Math.min(buildConfidence, 42);
  } else if (!persistentHrLift && !persistentSlopeRise && elevatedDelta < 12) {
    buildConfidence = Math.min(buildConfidence, 55);
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
