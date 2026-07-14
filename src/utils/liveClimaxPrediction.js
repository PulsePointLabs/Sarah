function numberOrNull(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function clamp(value, min = 0, max = 100) {
  return Math.max(min, Math.min(max, value));
}

function hrvQualityScore(value) {
  const quality = String(value || "").toLowerCase();
  if (quality === "high") return 3;
  if (quality === "moderate") return 2;
  if (quality === "low") return 1;
  return 0;
}

function pointRmssd(point) {
  return numberOrNull(point?.hrvRmssd, point?.rmssdMs, point?.hrv_rmssd_ms);
}

function pointElevatedDelta(point) {
  const hr = numberOrNull(point?.hrSmoothed, point?.hr);
  const baseline = numberOrNull(point?.baseline, point?.baselineHr, point?.baseline_hr);
  if (hr == null || baseline == null) return 0;
  return Math.max(0, hr - baseline);
}

function pointLooksLikeBuild(point) {
  const phase = String(point?.phase || "").toLowerCase();
  const build = numberOrNull(point?.build, point?.buildConfidence, point?.build_confidence) || 0;
  const elevatedDelta = pointElevatedDelta(point);
  return phase.includes("build") || build >= 45 || elevatedDelta >= 8;
}

function estimateBuildDurationSec(history = [], fallbackSessionTimeSec = 0) {
  const points = history.filter(Boolean);
  if (!points.length || !pointLooksLikeBuild(points[points.length - 1])) return 0;
  const lastPoint = points[points.length - 1];
  let startPoint = lastPoint;
  for (let index = points.length - 2; index >= 0; index -= 1) {
    if (!pointLooksLikeBuild(points[index])) break;
    startPoint = points[index];
  }
  const lastSessionTime = numberOrNull(lastPoint?.sessionTimeSec, fallbackSessionTimeSec);
  const startSessionTime = numberOrNull(startPoint?.sessionTimeSec);
  if (lastSessionTime != null && startSessionTime != null) {
    return Math.max(0, Math.round(lastSessionTime - startSessionTime));
  }
  const lastTs = numberOrNull(lastPoint?.ts);
  const startTs = numberOrNull(startPoint?.ts);
  if (lastTs != null && startTs != null) {
    return Math.max(0, Math.round((lastTs - startTs) / 1000));
  }
  return 0;
}

export function computeLiveClimaxPrediction(hrTelemetry, emgTelemetry, history = [], options = {}) {
  const phase = String(hrTelemetry?.phase || "").toLowerCase();
  const hrv = hrTelemetry?.hrv || {};
  const buildConfidence = numberOrNull(hrTelemetry?.buildConfidence, hrTelemetry?.build_confidence) || 0;
  const currentHr = numberOrNull(hrTelemetry?.currentHr, hrTelemetry?.hr, hrTelemetry?.heartRate) || 0;
  const baselineHr = numberOrNull(hrTelemetry?.baselineHr, hrTelemetry?.baseline_hr) || 0;
  const elevatedDelta = numberOrNull(hrTelemetry?.elevatedDelta, currentHr && baselineHr ? currentHr - baselineHr : null) || 0;
  const rmssd = numberOrNull(hrv.rmssdMs, hrTelemetry?.hrv_rmssd_ms);
  const hrvQuality = hrv.quality || hrTelemetry?.hrv_quality || null;
  const rrCount = numberOrNull(hrTelemetry?.quality?.rrCount, hrv.sampleCount) || 0;
  const hrvUsable = hrvQualityScore(hrvQuality) >= 2 || rrCount >= 40;

  const left = numberOrNull(emgTelemetry?.left_pct, emgTelemetry?.level_pct) || 0;
  const right = numberOrNull(emgTelemetry?.right_pct) || 0;
  const emgPeak = Math.max(left, right);
  const recent = history.slice(-18).filter((point) => point.hr != null);
  const longer = history.slice(-80).filter((point) => point.hr != null);
  const firstRecent = recent[0];
  const lastRecent = recent[recent.length - 1];
  const recentSlope = firstRecent && lastRecent && lastRecent.ts !== firstRecent.ts
    ? ((lastRecent.hr - firstRecent.hr) / ((lastRecent.ts - firstRecent.ts) / 1000)) * 30
    : 0;
  const recentPeak = recent.length ? Math.max(...recent.map((point) => point.hr)) : currentHr;
  const sessionPeak = longer.length ? Math.max(...longer.map((point) => point.hr)) : recentPeak;
  const dropFromRecentPeak = currentHr && recentPeak ? recentPeak - currentHr : 0;

  const recentRmssdValues = recent.map(pointRmssd).filter(Number.isFinite);
  const longerRmssdValues = longer.map(pointRmssd).filter(Number.isFinite);
  const recentRmssdMedian = median(recentRmssdValues);
  const sessionRmssdMedian = median(longerRmssdValues);
  const firstRecentRmssd = recentRmssdValues[0];
  const rmssdTrend = rmssd != null && firstRecentRmssd != null ? rmssd - firstRecentRmssd : 0;
  const elapsedMinutes = Math.max(
    0,
    Number(
      options?.elapsedMinutes
      ?? (numberOrNull(options?.sessionTimeSec, history[history.length - 1]?.sessionTimeSec) != null
        ? numberOrNull(options?.sessionTimeSec, history[history.length - 1]?.sessionTimeSec) / 60
        : 0)
    ) || 0,
  );
  const buildDurationSec = Math.max(
    0,
    Math.round(numberOrNull(options?.buildDurationSec, estimateBuildDurationSec(history, numberOrNull(options?.sessionTimeSec, history[history.length - 1]?.sessionTimeSec) || 0)) || 0),
  );

  let hrvContribution = 0;
  let hrvSignal = "waiting";
  let hrvContributionType = "waiting";
  let hrvExplanation = rrCount
    ? "RR-HRV is still building a usable rolling window."
    : "Waiting for RR intervals from the H10.";
  let hrvOpeningPenaltyApplied = false;

  if (hrvUsable && rmssd != null) {
    const referenceRmssd = sessionRmssdMedian || recentRmssdMedian || rmssd;
    const compressed = (referenceRmssd >= 8 && rmssd <= referenceRmssd * 0.68) || (rmssd <= 6 && elevatedDelta >= 10);
    const opening = referenceRmssd >= 5 && rmssd >= referenceRmssd * 1.65 && elevatedDelta >= 10;
    const release = opening && (dropFromRecentPeak >= 4 || recentSlope <= 0.5);
    const fallingWhileRising = rmssdTrend < -3 && recentSlope > 0.8;

    if (compressed && recentSlope >= -0.5) {
      hrvContribution += 13;
      hrvSignal = "compressed";
      hrvContributionType = "compressed";
      hrvExplanation = "HRV is compressed while HR is elevated, which often means your system is more tightly loaded.";
    } else if (fallingWhileRising) {
      hrvContribution += 8;
      hrvSignal = "tightening";
      hrvContributionType = "tightening";
      hrvExplanation = "RMSSD is falling while HR rises, suggesting the build is getting less flexible and more driven.";
    } else if (release) {
      hrvContribution -= 8;
      hrvSignal = "release";
      hrvContributionType = "release";
      hrvExplanation = "HRV is opening while the rise is easing off, which reads more like settling or recovery than threshold approach.";
    } else if (opening) {
      hrvContribution -= 4;
      hrvSignal = "opening";
      hrvContributionType = "opening_penalty";
      hrvOpeningPenaltyApplied = true;
      hrvExplanation = "HRV opened instead of compressing, so it does not strengthen a near-climax read here.";
    } else {
      hrvContribution += 3;
      hrvSignal = "steady";
      hrvContributionType = "steady";
      hrvExplanation = "RR-HRV is usable, but it is not adding a strong threshold cue yet.";
    }
  }

  const hrvCompressedOrTightening = ["compressed", "tightening"].includes(hrvSignal);
  const emgRise = emgPeak >= 18;
  const sustainedHrElevation = elevatedDelta >= 12 && buildDurationSec >= 60;
  const meaningfulPositiveSlope = recentSlope >= 1.5 && buildDurationSec >= 45 && elevatedDelta >= 8;
  const peakProximityWithoutRecoveryDrop = elevatedDelta >= 10 && dropFromRecentPeak <= 4;
  const confirmationSignals = {
    sustainedHrElevation,
    hrvCompressedOrTightening,
    meaningfulPositiveSlope,
    emgRise,
    peakProximityWithoutRecoveryDrop,
  };
  const confirmationCount = Object.values(confirmationSignals).filter(Boolean).length;
  const strongMultiSignalEvidence = confirmationCount >= 3;
  const buildEligibleForNearClimax = buildDurationSec >= 90 && (
    elevatedDelta >= 10
    || (elevatedDelta >= 8 && hrvCompressedOrTightening)
    || (elevatedDelta >= 8 && emgRise)
  );

  let nearClimax = 0;
  nearClimax += clamp(buildConfidence, 0, 100) * 0.35;
  nearClimax += clamp(elevatedDelta * 3.6, 0, 32);
  nearClimax += clamp(emgPeak * 0.16, 0, 16);
  nearClimax += hrvContribution;
  if (recentSlope > 1.5) nearClimax += clamp(recentSlope * 2.2, 0, 14);
  if (dropFromRecentPeak > 8) nearClimax -= 12;
  if (phase.includes("build")) nearClimax += 8;
  if (phase.includes("recovery")) nearClimax = Math.min(nearClimax, 22);
  if (buildDurationSec < 45 && confirmationCount < 2 && !hrvCompressedOrTightening && !emgRise && elevatedDelta >= 8) {
    nearClimax -= 10;
  }
  const nearClimaxBeforeCaps = Math.round(clamp(nearClimax));

  let cappedNearClimax = nearClimaxBeforeCaps;
  let earlySessionCapApplied = false;
  let earlySessionCapValue = null;
  if (elapsedMinutes < 8 && !strongMultiSignalEvidence) {
    earlySessionCapApplied = true;
    earlySessionCapValue = 35;
    cappedNearClimax = Math.min(cappedNearClimax, 35);
  } else if (elapsedMinutes < 15 && !strongMultiSignalEvidence) {
    earlySessionCapApplied = true;
    earlySessionCapValue = 50;
    cappedNearClimax = Math.min(cappedNearClimax, 50);
  }
  if (elevatedDelta > 0 && buildDurationSec < 60) {
    cappedNearClimax = Math.min(cappedNearClimax, confirmationCount >= 2 ? 50 : 45);
  }
  if (!buildEligibleForNearClimax) {
    cappedNearClimax = Math.min(cappedNearClimax, confirmationCount >= 2 ? 60 : 55);
  }
  const nearClimaxAfterCaps = Math.round(clamp(cappedNearClimax));

  const recovery = phase.includes("recovery")
    ? Math.max(65, Math.min(100, 65 + Math.max(0, 100 - buildConfidence) * 0.25))
    : clamp(Math.round((buildConfidence < 25 && elevatedDelta < 6 ? 35 : 0) + (emgPeak < 10 ? 10 : 0) + (dropFromRecentPeak > 8 ? 20 : 0)));

  const label = phase.includes("recovery")
    ? "Recovery likely"
    : buildEligibleForNearClimax && nearClimaxAfterCaps >= 85
      ? "Climax approach watch"
      : buildEligibleForNearClimax && nearClimaxAfterCaps >= 68
        ? "Near-climax watch"
        : nearClimaxAfterCaps >= 45 && (elapsedMinutes >= 5 || buildDurationSec >= 60)
          ? "Build intensifying"
          : nearClimaxAfterCaps >= 35
            ? "Arousal/build signal rising"
          : "Baseline/build";

  const confidenceBand = hrvUsable
    ? buildEligibleForNearClimax
      ? nearClimaxAfterCaps >= 85 ? "high watch" : nearClimaxAfterCaps >= 68 ? "moderate watch" : "low watch"
      : nearClimaxAfterCaps >= 45 ? "gated watch" : "low watch"
    : "HR-only watch";

  const reason = [
    buildConfidence ? `build ${Math.round(buildConfidence)}%` : null,
    elevatedDelta ? `HR +${Math.round(elevatedDelta)} over baseline` : null,
    recentSlope > 1 ? `rising ${recentSlope.toFixed(1)} bpm/30s` : null,
    dropFromRecentPeak > 8 ? `drop ${Math.round(dropFromRecentPeak)} from recent peak` : null,
    hrvUsable && rmssd != null ? `HRV ${hrvSignal}, RMSSD ${rmssd.toFixed(1)}` : null,
    emgPeak ? `EMG ${Math.round(emgPeak)}%` : null,
    buildDurationSec ? `build dwell ${buildDurationSec}s` : null,
    !buildEligibleForNearClimax && nearClimaxBeforeCaps > nearClimaxAfterCaps ? "high watch held back pending longer build" : null,
  ].filter(Boolean).join(" · ");

  return {
    nearClimax: nearClimaxAfterCaps,
    recovery: Math.round(recovery),
    label,
    reason,
    recentSlope,
    dropFromRecentPeak,
    hrvSignal,
    hrvExplanation,
    hrvContribution: Math.round(hrvContribution),
    hrvUsable,
    rrCount,
    rmssd,
    confidenceBand,
    sessionPeak,
    elapsedMinutes: Number(elapsedMinutes.toFixed(2)),
    buildDurationSec,
    earlySessionCapApplied,
    earlySessionCapValue,
    buildEligibleForNearClimax,
    confirmationCount,
    hrvContributionType,
    hrvOpeningPenaltyApplied,
    nearClimaxBeforeCaps,
    nearClimaxAfterCaps,
  };
}
