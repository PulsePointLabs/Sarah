export const PERINEAL_EMG_CALIBRATION_VERSION = "perineal-emg-calibration-v1";
export const PERINEAL_EMG_DETECTOR_VERSION = "perineal-emg-detector-v1";

const DEFAULTS = {
  minimum_contraction_duration_s: 0.28,
  maximum_contraction_duration_s: 15,
  refractory_period_s: 1.1,
  debounce_duration_s: 0.18,
  release_duration_s: 0.28,
};

function cleanNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function mean(values = []) {
  const nums = values.map((value) => cleanNumber(value)).filter((value) => value != null);
  return nums.length ? nums.reduce((sum, value) => sum + value, 0) / nums.length : null;
}

function std(values = []) {
  const nums = values.map((value) => cleanNumber(value)).filter((value) => value != null);
  if (nums.length < 2) return 0;
  const avg = mean(nums);
  return Math.sqrt(nums.reduce((sum, value) => sum + (value - avg) ** 2, 0) / nums.length);
}

function median(values = []) {
  const nums = values.map((value) => cleanNumber(value)).filter((value) => value != null).sort((a, b) => a - b);
  if (!nums.length) return null;
  const mid = Math.floor(nums.length / 2);
  return nums.length % 2 ? nums[mid] : (nums[mid - 1] + nums[mid]) / 2;
}

function percentile(values = [], pct = 0.95) {
  const nums = values.map((value) => cleanNumber(value)).filter((value) => value != null).sort((a, b) => a - b);
  if (!nums.length) return null;
  const index = clamp(Math.round((nums.length - 1) * pct), 0, nums.length - 1);
  return nums[index];
}

function sampleValues(samples = []) {
  return samples
    .map((sample) => cleanNumber(sample?.pct ?? sample?.level_pct ?? sample?.left_pct))
    .filter((value) => value != null);
}

function peakClusters(samples = [], threshold = 0) {
  const clusters = [];
  let active = [];
  for (const sample of samples) {
    const pct = cleanNumber(sample?.pct ?? sample?.level_pct ?? sample?.left_pct);
    if (pct == null) continue;
    if (pct >= threshold) {
      active.push(pct);
    } else if (active.length) {
      clusters.push(active);
      active = [];
    }
  }
  if (active.length) clusters.push(active);
  return clusters.map((cluster) => Math.max(...cluster));
}

export function buildPerinealEmgCalibration({
  baseline = [],
  light = [],
  strong = [],
  hold = [],
  artifacts = {},
  existing = {},
  createdAt = new Date().toISOString(),
} = {}) {
  const baselineValues = sampleValues(baseline);
  const lightValues = sampleValues(light);
  const strongValues = sampleValues(strong);
  const holdValues = sampleValues(hold);
  const baselineMean = cleanNumber(mean(baselineValues), cleanNumber(existing.baseline_mean_pct, 8)) ?? 8;
  const baselineStd = cleanNumber(std(baselineValues), cleanNumber(existing.baseline_std_pct, 3)) ?? 3;
  const baselineNoiseCeiling = percentile(baselineValues, 0.95) ?? (baselineMean + baselineStd * 2);
  const lightFloor = Math.max(baselineMean + baselineStd * 2.5, baselineNoiseCeiling + 3);
  const lightPeaks = peakClusters(light, lightFloor);
  const strongPeaks = peakClusters(strong, Math.max(lightFloor, baselineMean + baselineStd * 3.5));
  const lightMedianPeak = median(lightPeaks) ?? percentile(lightValues, 0.9) ?? cleanNumber(existing.light_median_peak_pct, null);
  const strongMedianPeak = median(strongPeaks) ?? percentile(strongValues, 0.9) ?? cleanNumber(existing.strong_median_peak_pct, null);
  const holdMean = mean(holdValues);
  const holdPeak = percentile(holdValues, 0.95);
  const artifactRefs = Object.fromEntries(
    Object.entries(artifacts || {}).map(([key, samples]) => [
      key,
      {
        peak_pct: percentile(sampleValues(samples), 0.98),
        mean_pct: mean(sampleValues(samples)),
        sample_count: sampleValues(samples).length,
      },
    ])
  );
  const suggestedDetection = clamp(
    Math.max(
      baselineMean + baselineStd * 3,
      baselineNoiseCeiling + 4,
      lightMedianPeak != null ? baselineMean + Math.max(6, (lightMedianPeak - baselineMean) * 0.45) : 22,
    ),
    8,
    80,
  );
  const suggestedStrong = clamp(
    strongMedianPeak != null
      ? baselineMean + Math.max(12, (strongMedianPeak - baselineMean) * 0.72)
      : Math.max(suggestedDetection + 18, 55),
    suggestedDetection + 6,
    95,
  );

  return {
    version: PERINEAL_EMG_CALIBRATION_VERSION,
    id: `${PERINEAL_EMG_CALIBRATION_VERSION}-${Date.parse(createdAt) || Date.now()}`,
    created_at: createdAt,
    baseline_mean_pct: Number(baselineMean.toFixed(2)),
    baseline_std_pct: Number(baselineStd.toFixed(2)),
    baseline_sample_count: baselineValues.length,
    light_mean_pct: lightValues.length ? Number(mean(lightValues).toFixed(2)) : null,
    light_median_peak_pct: lightMedianPeak != null ? Number(lightMedianPeak.toFixed(2)) : null,
    strong_mean_pct: strongValues.length ? Number(mean(strongValues).toFixed(2)) : null,
    strong_median_peak_pct: strongMedianPeak != null ? Number(strongMedianPeak.toFixed(2)) : null,
    hold_mean_pct: holdMean != null ? Number(holdMean.toFixed(2)) : null,
    hold_peak_pct: holdPeak != null ? Number(holdPeak.toFixed(2)) : null,
    suggested_detection_threshold_pct: Number(suggestedDetection.toFixed(2)),
    suggested_strong_threshold_pct: Number(suggestedStrong.toFixed(2)),
    release_threshold_pct: Number(Math.max(baselineMean + baselineStd * 2, suggestedDetection * 0.72).toFixed(2)),
    minimum_contraction_duration_s: DEFAULTS.minimum_contraction_duration_s,
    maximum_contraction_duration_s: DEFAULTS.maximum_contraction_duration_s,
    refractory_period_s: DEFAULTS.refractory_period_s,
    artifact_references: artifactRefs,
    artifact_notes: "Cough/glute/adductor references are used as caution signals only; surface EMG cannot perfectly separate pelvic-floor contraction from nearby muscle artifact.",
  };
}

export function calibrationFromSession(session = {}) {
  const stored = session?.emg_perineal_calibration || session?.perineal_emg_calibration || null;
  if (stored && typeof stored === "object") return stored;
  const rest = cleanNumber(session?.emg_rest_left, null);
  const max = cleanNumber(session?.emg_max_left, null);
  if (rest == null && max == null) return buildPerinealEmgCalibration({});
  const baseline = rest ?? 8;
  const strong = max ?? Math.max(55, baseline + 35);
  return {
    ...buildPerinealEmgCalibration({ existing: { baseline_mean_pct: baseline, strong_median_peak_pct: strong } }),
    baseline_mean_pct: baseline,
    baseline_std_pct: 4,
    strong_median_peak_pct: strong,
    suggested_detection_threshold_pct: clamp(baseline + Math.max(10, (strong - baseline) * 0.28), 12, 70),
    suggested_strong_threshold_pct: clamp(baseline + Math.max(20, (strong - baseline) * 0.7), 30, 95),
  };
}

export function createPerinealEmgDetector(options = {}) {
  return {
    phase: "relaxed",
    ema: null,
    aboveSince: null,
    belowSince: null,
    refractoryUntil: -Infinity,
    current: null,
    lastEvent: null,
    counts: {
      total: 0,
      light: 0,
      moderate: 0,
      strong: 0,
      sustained: 0,
      possible_artifact: 0,
    },
    recent: [],
    calibration: options.calibration || buildPerinealEmgCalibration({}),
  };
}

function classifyContraction({ durationS, peakPct, averagePct, integratedActivation, calibration }) {
  const threshold = cleanNumber(calibration.suggested_detection_threshold_pct, 24);
  const strongThreshold = cleanNumber(calibration.suggested_strong_threshold_pct, threshold + 22);
  const lightPeak = cleanNumber(calibration.light_median_peak_pct, threshold + 8);
  const baseline = cleanNumber(calibration.baseline_mean_pct, 8);
  const baselineStd = cleanNumber(calibration.baseline_std_pct, 3);
  const amplitude = peakPct - baseline;
  if (durationS < cleanNumber(calibration.minimum_contraction_duration_s, DEFAULTS.minimum_contraction_duration_s)) {
    return { contraction_type: "possible_artifact", confidence: peakPct >= strongThreshold ? "medium" : "low" };
  }
  if (durationS > cleanNumber(calibration.maximum_contraction_duration_s, DEFAULTS.maximum_contraction_duration_s)) {
    return { contraction_type: "possible_artifact", confidence: "medium" };
  }
  if (durationS >= 4.5 && averagePct >= threshold) {
    return { contraction_type: "sustained", confidence: peakPct >= strongThreshold || integratedActivation >= amplitude * 3 ? "high" : "medium" };
  }
  if (peakPct >= strongThreshold) return { contraction_type: "strong", confidence: durationS >= 0.45 ? "high" : "medium" };
  const moderateThreshold = Math.min(
    strongThreshold - 4,
    lightPeak + Math.max(7, (strongThreshold - lightPeak) * 0.35),
  );
  if (peakPct >= moderateThreshold) return { contraction_type: "moderate", confidence: durationS >= 0.4 ? "high" : "medium" };
  return { contraction_type: "light", confidence: durationS >= 0.35 ? "medium" : "low" };
}

export function processPerinealEmgSample(detector, sample = {}, options = {}) {
  const state = detector || createPerinealEmgDetector();
  const calibration = options.calibration || state.calibration || buildPerinealEmgCalibration({});
  state.calibration = calibration;
  const rawPct = cleanNumber(sample.pct ?? sample.level_pct ?? sample.left_pct, null);
  const timeS = cleanNumber(sample.time_s ?? sample.timeS, null);
  if (rawPct == null || timeS == null) return { detector: state, event: null };

  const alpha = cleanNumber(options.smoothing_alpha, 0.38);
  state.ema = state.ema == null ? rawPct : (state.ema * (1 - alpha)) + (rawPct * alpha);
  const pct = clamp(state.ema, 0, 100);
  const threshold = cleanNumber(calibration.suggested_detection_threshold_pct, 24);
  const releaseThreshold = cleanNumber(calibration.release_threshold_pct, Math.max(cleanNumber(calibration.baseline_mean_pct, 8) + 5, threshold * 0.72));
  const debounceS = cleanNumber(calibration.debounce_duration_s, DEFAULTS.debounce_duration_s);
  const releaseS = cleanNumber(calibration.release_duration_s, DEFAULTS.release_duration_s);
  const refractoryS = cleanNumber(calibration.refractory_period_s, DEFAULTS.refractory_period_s);
  const minDurationS = cleanNumber(calibration.minimum_contraction_duration_s, DEFAULTS.minimum_contraction_duration_s);

  state.recent = [...(state.recent || []), { time_s: timeS, pct }].filter((item) => timeS - item.time_s <= 1.5);

  if (timeS < (state.refractoryUntil ?? -Infinity)) {
    state.phase = "refractory";
    return { detector: state, event: null };
  }

  if (!state.current) {
    if (pct >= threshold) {
      state.aboveSince = state.aboveSince ?? timeS;
      state.phase = timeS - state.aboveSince >= debounceS ? "contracting" : "rising";
      if (timeS - state.aboveSince >= debounceS) {
        const startTime = state.aboveSince;
        const startingSamples = state.recent.filter((item) => item.time_s >= startTime);
        state.current = {
          start_time_s: startTime,
          peak_time_s: timeS,
          peak_pct: pct,
          samples: startingSamples.length ? startingSamples : [{ time_s: timeS, pct }],
        };
        state.belowSince = null;
      }
    } else {
      state.phase = "relaxed";
      state.aboveSince = null;
    }
    return { detector: state, event: null };
  }

  state.phase = pct >= releaseThreshold ? "contracting" : "releasing";
  state.current.samples.push({ time_s: timeS, pct });
  if (pct > state.current.peak_pct) {
    state.current.peak_pct = pct;
    state.current.peak_time_s = timeS;
  }
  if (pct < releaseThreshold) {
    state.belowSince = state.belowSince ?? timeS;
  } else {
    state.belowSince = null;
  }

  if (state.belowSince == null || timeS - state.belowSince < releaseS) return { detector: state, event: null };

  const samples = state.current.samples;
  const endTime = timeS;
  const durationS = Math.max(0, endTime - state.current.start_time_s);
  const values = samples.map((item) => item.pct);
  const averagePct = mean(values) ?? pct;
  const baseline = cleanNumber(calibration.baseline_mean_pct, 0);
  const integratedActivation = samples.reduce((sum, item, index) => {
    if (index === 0) return sum;
    const prev = samples[index - 1];
    const dt = Math.max(0, item.time_s - prev.time_s);
    return sum + Math.max(0, ((item.pct + prev.pct) / 2) - baseline) * dt;
  }, 0);
  const tooShort = durationS < minDurationS;
  const singleSpike = samples.filter((item) => item.pct >= threshold).length <= 1;
  const classification = classifyContraction({
    durationS,
    peakPct: state.current.peak_pct,
    averagePct,
    integratedActivation,
    calibration,
  });
  const event = {
    source: "perineal_emg",
    event_type: classification.contraction_type === "possible_artifact" || tooShort || singleSpike ? "possible_artifact" : "kegel_contraction",
    contraction_type: tooShort || singleSpike ? "possible_artifact" : classification.contraction_type,
    start_time_s: Number(state.current.start_time_s.toFixed(2)),
    peak_time_s: Number(state.current.peak_time_s.toFixed(2)),
    end_time_s: Number(endTime.toFixed(2)),
    duration_s: Number(durationS.toFixed(2)),
    peak_pct: Number(state.current.peak_pct.toFixed(1)),
    average_pct: Number(averagePct.toFixed(1)),
    integrated_activation: Number(integratedActivation.toFixed(1)),
    confidence: tooShort || singleSpike ? "low" : classification.confidence,
    calibration_id: calibration.id || null,
    detector_version: PERINEAL_EMG_DETECTOR_VERSION,
  };

  state.current = null;
  state.aboveSince = null;
  state.belowSince = null;
  state.refractoryUntil = endTime + refractoryS;
  state.phase = "refractory";
  state.lastEvent = event;
  state.counts.total += 1;
  state.counts[event.contraction_type] = (state.counts[event.contraction_type] || 0) + 1;
  return { detector: state, event };
}

export function perinealEventNote(event = {}) {
  if (event.contraction_type === "strong") return "Strong Kegel detected";
  if (event.contraction_type === "sustained") return "Sustained pelvic-floor hold detected";
  if (event.contraction_type === "possible_artifact") return "Possible EMG artifact";
  return "Kegel detected";
}

export function signalQualityFromCalibration(calibration = {}, liveSpread = null) {
  const baselineStd = cleanNumber(calibration.baseline_std_pct, null);
  const threshold = cleanNumber(calibration.suggested_detection_threshold_pct, null);
  const baseline = cleanNumber(calibration.baseline_mean_pct, null);
  if (baseline == null || threshold == null) return { label: "Needs baseline", tone: "muted" };
  if (baselineStd != null && baselineStd > 10) return { label: "Noisy baseline", tone: "warn" };
  if (liveSpread != null && liveSpread > 25) return { label: "Moving/noisy", tone: "warn" };
  if (threshold - baseline < 8) return { label: "Low separation", tone: "warn" };
  return { label: "Usable", tone: "good" };
}
