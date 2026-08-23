const finite = (value) => {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

const rowTime = (row) => finite(row?.time_offset_s);
const rowHr = (row) => finite(row?.hr_smoothed) ?? finite(row?.hr);

function median(values = []) {
  const usable = values.map(finite).filter(Number.isFinite).sort((a, b) => a - b);
  if (!usable.length) return null;
  const middle = Math.floor(usable.length / 2);
  return usable.length % 2 ? usable[middle] : (usable[middle - 1] + usable[middle]) / 2;
}

function recoveryDrops(row = {}) {
  return {
    seconds30: finite(row.recovery_drop_30_bpm),
    seconds60: finite(row.recovery_drop_60_bpm),
    seconds90: finite(row.recovery_drop_90_bpm),
  };
}

function availableDropCount(drops = {}) {
  return Object.values(drops).filter(Number.isFinite).length;
}

function describeTrajectory(drops = {}) {
  const ordered = [
    [30, drops.seconds30],
    [60, drops.seconds60],
    [90, drops.seconds90],
  ].filter(([, value]) => Number.isFinite(value));
  if (!ordered.length) return null;
  const [lastSeconds, lastDrop] = ordered[ordered.length - 1];
  if (ordered.length === 1) {
    return {
      key: "early_only",
      label: "Early window only",
      detail: `Heart rate was ${Math.abs(lastDrop).toFixed(0)} bpm ${lastDrop >= 0 ? "below" : "above"} the rolling peak at ${lastSeconds} seconds; later recovery windows were not saved.`,
    };
  }
  const [previousSeconds, previousDrop] = ordered[ordered.length - 2];
  const change = lastDrop - previousDrop;
  if (change >= 3) {
    return {
      key: "continued_fall",
      label: "Continued HR decline",
      detail: `The drop widened by ${change.toFixed(0)} bpm from ${previousSeconds} to ${lastSeconds} seconds, so HR was still moving away from the local peak.`,
    };
  }
  if (change <= -3) {
    return {
      key: "rebound",
      label: "Partial rebound",
      detail: `The drop narrowed by ${Math.abs(change).toFixed(0)} bpm from ${previousSeconds} to ${lastSeconds} seconds, meaning HR rose again after the initial fall.`,
    };
  }
  return {
    key: "plateau",
    label: "Recovery plateau",
    detail: `The drop changed by less than 3 bpm from ${previousSeconds} to ${lastSeconds} seconds, so HR was comparatively level in that interval.`,
  };
}

function closestPhaseAnchor(session = {}, peakTimeS = null) {
  if (!Number.isFinite(peakTimeS)) return null;
  const anchors = [
    ["pre-climax marker", finite(session.pre_climax_offset_s)],
    ["climax marker", finite(session.climax_offset_s)],
    ["recovery marker", finite(session.recovery_offset_s)],
  ].filter(([, seconds]) => Number.isFinite(seconds));
  if (!anchors.length) return null;
  const [label, seconds] = anchors.reduce((best, candidate) => (
    Math.abs(candidate[1] - peakTimeS) < Math.abs(best[1] - peakTimeS) ? candidate : best
  ));
  const deltaSeconds = peakTimeS - seconds;
  if (Math.abs(deltaSeconds) > 90) return null;
  return { label, seconds, deltaSeconds };
}

export function summarizeRecoveryResponse(timelineRows = [], session = {}) {
  const rows = (timelineRows || [])
    .filter((row) => rowTime(row) != null)
    .sort((a, b) => rowTime(a) - rowTime(b));
  const recoveryCandidates = rows
    .map((row) => ({ row, drops: recoveryDrops(row), timeS: rowTime(row) }))
    .filter((candidate) => availableDropCount(candidate.drops) > 0);
  const recoverySnapshot = recoveryCandidates.reduce((best, candidate) => {
    if (!best) return candidate;
    const completeness = availableDropCount(candidate.drops) - availableDropCount(best.drops);
    if (completeness !== 0) return completeness > 0 ? candidate : best;
    return candidate.timeS > best.timeS ? candidate : best;
  }, null);

  let recovery = null;
  if (recoverySnapshot) {
    const peakWindow = rows.filter((row) => {
      const seconds = rowTime(row);
      return seconds >= recoverySnapshot.timeS - 180 && seconds <= recoverySnapshot.timeS && rowHr(row) != null;
    });
    const peakRow = peakWindow.reduce((best, row) => (
      !best || rowHr(row) > rowHr(best) ? row : best
    ), null);
    const peakTimeS = rowTime(peakRow);
    const signalWindowStart = Number.isFinite(peakTimeS) ? peakTimeS : Math.max(0, recoverySnapshot.timeS - 90);
    const signalWindow = rows.filter((row) => rowTime(row) >= signalWindowStart && rowTime(row) <= recoverySnapshot.timeS);
    const signalScores = signalWindow.map((row) => finite(row.signal_confidence_score)).filter(Number.isFinite);
    recovery = {
      ...recoverySnapshot,
      peakTimeS,
      peakHr: rowHr(peakRow),
      observationHr: rowHr(recoverySnapshot.row),
      sampleCount: signalWindow.filter((row) => rowHr(row) != null).length,
      signalConfidenceMedian: median(signalScores),
      phaseAnchor: closestPhaseAnchor(session, peakTimeS),
      trajectory: describeTrajectory(recoverySnapshot.drops),
    };
  }

  const latencyRows = rows.filter((row) => finite(row.response_latency_seconds) != null);
  const latencyRow = latencyRows[latencyRows.length - 1] || null;
  const response = latencyRow ? {
    medianSeconds: finite(latencyRow.response_latency_seconds),
    qualifyingCount: finite(latencyRow.response_latency_sample_count),
    evaluatedCount: finite(latencyRow.response_latency_evaluated_count),
    savedAtS: rowTime(latencyRow),
  } : null;

  return {
    recovery,
    response,
    hasRecovery: Boolean(recovery),
    hasResponse: Boolean(response),
  };
}

