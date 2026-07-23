export const H10_PMD_SERVICE_UUID = "fb005c80-02e7-f387-1cad-8acd2d8df0c8";
export const H10_PMD_CONTROL_UUID = "fb005c81-02e7-f387-1cad-8acd2d8df0c8";
export const H10_PMD_DATA_UUID = "fb005c82-02e7-f387-1cad-8acd2d8df0c8";

export const H10_ECG_START_COMMAND = Uint8Array.from([
  0x02, 0x00,
  0x00, 0x01, 0x82, 0x00,
  0x01, 0x01, 0x0e, 0x00,
]);

export const H10_ACCELEROMETER_START_COMMAND = Uint8Array.from([
  0x02, 0x02,
  0x00, 0x01, 0x19, 0x00,
  0x01, 0x01, 0x10, 0x00,
  0x02, 0x01, 0x02, 0x00,
  0x04, 0x01, 0x03,
]);

export const H10_ECG_STOP_COMMAND = Uint8Array.from([0x03, 0x00]);
export const H10_ACCELEROMETER_STOP_COMMAND = Uint8Array.from([0x03, 0x02]);

export const H10_PMD_ALREADY_ACTIVE_STATUS = 6;

export function isH10PmdStreamActiveResponse(response) {
  return Boolean(
    response
    && (response.success || response.status === H10_PMD_ALREADY_ACTIVE_STATUS)
  );
}

const ACCEL_RATE_HZ = 25;
const ECG_RATE_HZ = 130;
const RESPIRATION_WINDOW_MS = 60_000;
const RESPIRATION_MIN_WINDOW_MS = 45_000;
const RESPIRATION_MIN_BPM = 5;
const RESPIRATION_MAX_BPM = 36;

function finite(value, fallback = null) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function round(value, digits = 1) {
  if (!Number.isFinite(value)) return null;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function bytesFrom(value) {
  if (value instanceof Uint8Array) return value;
  if (value instanceof DataView) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  if (value instanceof ArrayBuffer) return new Uint8Array(value);
  if (ArrayBuffer.isView(value)) return new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
  return Uint8Array.from(value || []);
}

export function commandDataView(command) {
  const bytes = bytesFrom(command);
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function littleUnsigned(bytes, offset, size) {
  let result = 0n;
  for (let index = 0; index < size; index += 1) {
    result |= BigInt(bytes[offset + index] || 0) << BigInt(index * 8);
  }
  return result;
}

function littleSigned(bytes, offset, size) {
  let result = Number(littleUnsigned(bytes, offset, size));
  const signBit = 2 ** (size * 8 - 1);
  if (result >= signBit) result -= 2 ** (size * 8);
  return result;
}

export function createH10PmdParserState(sampleRateHz) {
  return {
    sampleRateHz,
    previousDeviceTimestampNs: 0n,
    hostTimestampBaseMs: null,
    deviceTimestampBaseNs: null,
  };
}

function hostTimestampFor(state, deviceTimestampNs, hostNowMs) {
  if (
    state.hostTimestampBaseMs == null
    || state.deviceTimestampBaseNs == null
    || deviceTimestampNs < state.deviceTimestampBaseNs
  ) {
    state.hostTimestampBaseMs = hostNowMs;
    state.deviceTimestampBaseNs = deviceTimestampNs;
    return hostNowMs;
  }
  return state.hostTimestampBaseMs + Number((deviceTimestampNs - state.deviceTimestampBaseNs) / 1_000_000n);
}

function sampleTimestamps(state, frameTimestampNs, count, hostNowMs) {
  const nominalDeltaNs = BigInt(Math.round(1_000_000_000 / state.sampleRateHz));
  const deltaNs = state.previousDeviceTimestampNs > 0n && frameTimestampNs > state.previousDeviceTimestampNs
    ? (frameTimestampNs - state.previousDeviceTimestampNs) / BigInt(count)
    : nominalDeltaNs;
  const firstTimestampNs = state.previousDeviceTimestampNs > 0n
    ? state.previousDeviceTimestampNs + deltaNs
    : frameTimestampNs - (deltaNs * BigInt(Math.max(0, count - 1)));
  const timestamps = Array.from({ length: count }, (_unused, index) => (
    hostTimestampFor(state, firstTimestampNs + (deltaNs * BigInt(index)), hostNowMs)
  ));
  state.previousDeviceTimestampNs = frameTimestampNs;
  return timestamps;
}

export function parseH10PmdFrame(value, parserStates, hostNowMs = Date.now()) {
  const bytes = bytesFrom(value);
  if (bytes.length < 10) throw new Error("Truncated H10 PMD frame");
  const measurement = bytes[0] & 0x3f;
  const deviceTimestampNs = littleUnsigned(bytes, 1, 8);
  const frameByte = bytes[9];
  if ((frameByte & 0x80) !== 0) throw new Error("Compressed H10 PMD frames are not supported");
  const frameType = frameByte & 0x7f;
  const content = bytes.subarray(10);

  if (measurement === 0) {
    if (frameType !== 0 || !content.length || content.length % 3 !== 0) {
      throw new Error("Malformed H10 ECG frame");
    }
    const state = parserStates.ecg;
    const count = content.length / 3;
    const timestamps = sampleTimestamps(state, deviceTimestampNs, count, hostNowMs);
    return {
      type: "ecg",
      samples: timestamps.map((timestampMs, index) => ({
        timestampMs,
        microvolts: littleSigned(content, index * 3, 3),
      })),
    };
  }

  if (measurement === 2) {
    const bytesPerAxis = frameType + 1;
    const sampleSize = bytesPerAxis * 3;
    if (bytesPerAxis < 1 || bytesPerAxis > 3 || !content.length || content.length % sampleSize !== 0) {
      throw new Error("Malformed H10 accelerometer frame");
    }
    const state = parserStates.accelerometer;
    const count = content.length / sampleSize;
    const timestamps = sampleTimestamps(state, deviceTimestampNs, count, hostNowMs);
    return {
      type: "accelerometer",
      samples: timestamps.map((timestampMs, index) => {
        const offset = index * sampleSize;
        return {
          timestampMs,
          xMilliG: littleSigned(content, offset, bytesPerAxis),
          yMilliG: littleSigned(content, offset + bytesPerAxis, bytesPerAxis),
          zMilliG: littleSigned(content, offset + bytesPerAxis * 2, bytesPerAxis),
        };
      }),
    };
  }

  throw new Error(`Unsupported H10 PMD measurement ${measurement}`);
}

export function parseH10PmdControlResponse(value) {
  const bytes = bytesFrom(value);
  if (bytes.length < 4 || bytes[0] !== 0xf0) return null;
  return {
    command: bytes[1],
    measurement: bytes[2],
    status: bytes[3],
    success: bytes[3] === 0,
  };
}

export function appendBoundedSamples(current, incoming, { maxAgeMs, maxSamples, nowMs = Date.now() }) {
  const merged = [...(Array.isArray(current) ? current : []), ...(Array.isArray(incoming) ? incoming : [])];
  const cutoff = nowMs - maxAgeMs;
  const recent = merged.filter((sample) => finite(sample?.timestampMs, 0) >= cutoff);
  return recent.slice(-maxSamples);
}

function vectorMagnitude(sample) {
  const x = finite(sample?.xMilliG, 0);
  const y = finite(sample?.yMilliG, 0);
  const z = finite(sample?.zMilliG, 0);
  return Math.sqrt((x * x) + (y * y) + (z * z));
}

function mean(values) {
  if (!values.length) return null;
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function standardDeviation(values) {
  const average = mean(values);
  if (average == null || values.length < 2) return null;
  return Math.sqrt(values.reduce((sum, value) => sum + ((value - average) ** 2), 0) / values.length);
}

function percentile(values, fraction) {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.round((sorted.length - 1) * fraction)));
  return sorted[index];
}

function windowCoverage(samples, expectedRateHz) {
  if (samples.length < 2) return { durationMs: 0, coveragePercent: 0, largestGapMs: null };
  const times = samples.map((sample) => finite(sample.timestampMs)).filter(Number.isFinite).sort((a, b) => a - b);
  if (times.length < 2) return { durationMs: 0, coveragePercent: 0, largestGapMs: null };
  const durationMs = times[times.length - 1] - times[0];
  const expected = Math.max(1, (durationMs / 1000) * expectedRateHz);
  let largestGapMs = 0;
  for (let index = 1; index < times.length; index += 1) largestGapMs = Math.max(largestGapMs, times[index] - times[index - 1]);
  return {
    durationMs,
    coveragePercent: Math.min(100, (times.length / expected) * 100),
    largestGapMs,
  };
}

function motionSummary(samples) {
  if (!samples.length) {
    return {
      available: false,
      class: "unavailable",
      dynamicRmsMilliG: null,
      peakDynamicMilliG: null,
      lowMotionPercent: null,
      confidence: 0,
    };
  }
  const dynamic = samples.map((sample) => Math.abs(vectorMagnitude(sample) - 1000));
  const dynamicRmsMilliG = Math.sqrt(mean(dynamic.map((value) => value ** 2)) || 0);
  const peakDynamicMilliG = percentile(dynamic, 0.98) || 0;
  const lowMotionPercent = dynamic.filter((value) => value < 90).length / dynamic.length * 100;
  const klass = dynamicRmsMilliG < 90
    ? "low_motion"
    : dynamicRmsMilliG < 180
      ? "mild_motion"
      : dynamicRmsMilliG < 360
        ? "moderate_motion"
        : "high_motion";
  return {
    available: true,
    class: klass,
    dynamicRmsMilliG: round(dynamicRmsMilliG),
    peakDynamicMilliG: round(peakDynamicMilliG),
    lowMotionPercent: round(lowMotionPercent, 0),
    confidence: Math.min(1, samples.length / (ACCEL_RATE_HZ * 4)),
  };
}

function orientationVector(samples) {
  if (!samples.length) return null;
  const vector = {
    x: mean(samples.map((sample) => finite(sample.xMilliG, 0))),
    y: mean(samples.map((sample) => finite(sample.yMilliG, 0))),
    z: mean(samples.map((sample) => finite(sample.zMilliG, 0))),
  };
  const magnitude = Math.sqrt((vector.x ** 2) + (vector.y ** 2) + (vector.z ** 2));
  if (!magnitude) return null;
  return { x: vector.x / magnitude, y: vector.y / magnitude, z: vector.z / magnitude };
}

function orientationAngleDegrees(first, second) {
  if (!first || !second) return null;
  const dot = Math.max(-1, Math.min(1, (first.x * second.x) + (first.y * second.y) + (first.z * second.z)));
  return Math.acos(dot) * (180 / Math.PI);
}

function movingAverage(values, radius) {
  const result = [];
  let sum = 0;
  for (let index = 0; index < values.length; index += 1) {
    sum += values[index];
    if (index > radius * 2) sum -= values[index - (radius * 2) - 1];
    const count = Math.min(index + 1, radius * 2 + 1);
    result.push(sum / count);
  }
  return result;
}

function resampleAxis(samples, axis, intervalMs = 200) {
  if (samples.length < 2) return [];
  const bins = new Map();
  samples.forEach((sample) => {
    const timestampMs = finite(sample.timestampMs);
    if (!Number.isFinite(timestampMs)) return;
    const key = Math.floor(timestampMs / intervalMs) * intervalMs;
    const bin = bins.get(key) || [];
    bin.push(finite(sample[axis], 0));
    bins.set(key, bin);
  });
  return [...bins.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([timestampMs, values]) => ({ timestampMs, value: mean(values) || 0 }));
}

function bandpass(values, sampleRateHz) {
  const centered = values.map((value) => value - (mean(values) || 0));
  const fast = movingAverage(centered, Math.max(1, Math.round(sampleRateHz * 0.35)));
  const slow = movingAverage(centered, Math.max(2, Math.round(sampleRateHz * 2.0)));
  return fast.map((value, index) => value - slow[index]);
}

function autocorrelationRate(values, sampleRateHz) {
  if (values.length < sampleRateHz * 20) return null;
  const variance = mean(values.map((value) => value ** 2)) || 0;
  if (variance < 1) return null;
  const minLag = Math.max(1, Math.floor(sampleRateHz * 60 / RESPIRATION_MAX_BPM));
  const maxLag = Math.min(values.length - 2, Math.ceil(sampleRateHz * 60 / RESPIRATION_MIN_BPM));
  let best = null;
  for (let lag = minLag; lag <= maxLag; lag += 1) {
    let numerator = 0;
    let left = 0;
    let right = 0;
    for (let index = lag; index < values.length; index += 1) {
      numerator += values[index] * values[index - lag];
      left += values[index] ** 2;
      right += values[index - lag] ** 2;
    }
    const correlation = numerator / Math.sqrt(Math.max(1e-9, left * right));
    if (!best || correlation > best.correlation) best = { lag, correlation };
  }
  if (!best) return null;
  return { bpm: 60 * sampleRateHz / best.lag, periodicity: best.correlation };
}

function accelerometerRespiration(samples, motion) {
  const coverage = windowCoverage(samples, ACCEL_RATE_HZ);
  if (coverage.durationMs < RESPIRATION_MIN_WINDOW_MS) {
    return { accepted: false, reason: "insufficient_window", coveragePercent: round(coverage.coveragePercent, 0) };
  }
  if (coverage.coveragePercent < 82 || coverage.largestGapMs > 1500) {
    return { accepted: false, reason: coverage.largestGapMs > 1500 ? "stream_gap" : "insufficient_coverage", coveragePercent: round(coverage.coveragePercent, 0) };
  }
  if (!["low_motion", "mild_motion"].includes(motion.class) || motion.lowMotionPercent < 80) {
    return { accepted: false, reason: "motion_limited", coveragePercent: round(coverage.coveragePercent, 0) };
  }
  const candidates = ["xMilliG", "yMilliG", "zMilliG"].map((axis) => {
    const series = resampleAxis(samples, axis);
    const filtered = bandpass(series.map((item) => item.value), 5);
    return { axis, series, filtered, estimate: autocorrelationRate(filtered, 5) };
  }).filter((candidate) => candidate.estimate);
  const best = candidates.sort((a, b) => b.estimate.periodicity - a.estimate.periodicity)[0];
  if (!best || best.estimate.periodicity < 0.56) {
    return { accepted: false, reason: "low_periodicity", coveragePercent: round(coverage.coveragePercent, 0) };
  }
  const bpm = best.estimate.bpm;
  if (bpm < RESPIRATION_MIN_BPM || bpm > RESPIRATION_MAX_BPM) {
    return { accepted: false, reason: "out_of_range", coveragePercent: round(coverage.coveragePercent, 0) };
  }
  const recentHoldWindow = best.filtered.slice(-20);
  const precedingWindow = best.filtered.slice(-45, -20);
  const recentAmplitude = standardDeviation(recentHoldWindow) || 0;
  const precedingAmplitude = standardDeviation(precedingWindow) || 0;
  const possibleBreathHold = precedingWindow.length >= 20
    && precedingAmplitude >= 3
    && recentAmplitude <= Math.max(1.2, precedingAmplitude * 0.18);
  return {
    accepted: true,
    bpm: round(bpm),
    periodicity: round(best.estimate.periodicity, 2),
    confidence: best.estimate.periodicity >= 0.72 ? "high" : "moderate",
    source: "chest_accelerometer",
    axis: best.axis[0],
    coveragePercent: round(coverage.coveragePercent, 0),
    possibleBreathHold,
    holdDurationSeconds: possibleBreathHold ? 4 : null,
    waveform: best.filtered.slice(-80).map((value) => round(value, 2)),
  };
}

function detectRPeaks(samples) {
  if (samples.length < ECG_RATE_HZ * 10) return [];
  let baseline = 0;
  let envelope = 100;
  let lastPeakTimestamp = -Infinity;
  const peaks = [];
  samples.forEach((sample) => {
    const voltage = finite(sample.microvolts, 0);
    baseline += (voltage - baseline) * 0.015;
    const magnitude = Math.abs(voltage - baseline);
    envelope += (magnitude - envelope) * 0.01;
    const threshold = Math.max(180, envelope * 3.2);
    if (magnitude > threshold && sample.timestampMs - lastPeakTimestamp >= 250) {
      peaks.push({ timestampMs: sample.timestampMs, amplitude: magnitude });
      lastPeakTimestamp = sample.timestampMs;
    }
  });
  return peaks;
}

function ecgDerivedRespiration(samples) {
  const coverage = windowCoverage(samples, ECG_RATE_HZ);
  if (coverage.durationMs < RESPIRATION_MIN_WINDOW_MS) return { accepted: false, reason: "insufficient_window" };
  if (coverage.coveragePercent < 82 || coverage.largestGapMs > 250) {
    return { accepted: false, reason: coverage.largestGapMs > 250 ? "stream_gap" : "insufficient_coverage" };
  }
  const peaks = detectRPeaks(samples);
  if (peaks.length < 35) return { accepted: false, reason: "qrs_detection_failure" };
  const amplitudes = peaks.map((peak) => peak.amplitude);
  const filtered = bandpass(amplitudes, Math.max(0.7, peaks.length / (coverage.durationMs / 1000)));
  const sampleRate = peaks.length / (coverage.durationMs / 1000);
  const estimate = autocorrelationRate(filtered, sampleRate);
  if (!estimate || estimate.periodicity < 0.56) return { accepted: false, reason: "low_ecg_periodicity" };
  return {
    accepted: true,
    bpm: round(estimate.bpm),
    periodicity: round(estimate.periodicity, 2),
    confidence: estimate.periodicity >= 0.72 ? "high" : "moderate",
    source: "ecg_derived",
    coveragePercent: round(coverage.coveragePercent, 0),
  };
}

function rrDerivedRespiration(rrIntervalsMs = []) {
  const intervals = rrIntervalsMs
    .map((value) => finite(value))
    .filter((value) => Number.isFinite(value) && value >= 300 && value <= 2000)
    .slice(-180);
  const durationMs = intervals.reduce((sum, value) => sum + value, 0);
  if (intervals.length < 45 || durationMs < RESPIRATION_MIN_WINDOW_MS) {
    return { accepted: false, reason: "insufficient_rr_window" };
  }

  let elapsedMs = 0;
  const beats = intervals.map((interval) => {
    elapsedMs += interval;
    return { timestampMs: elapsedMs, value: interval };
  });
  const sampleRateHz = 2;
  const stepMs = 1000 / sampleRateHz;
  const resampled = [];
  let beatIndex = 1;
  for (let timestampMs = beats[0].timestampMs; timestampMs <= elapsedMs; timestampMs += stepMs) {
    while (beatIndex < beats.length && beats[beatIndex].timestampMs < timestampMs) beatIndex += 1;
    if (beatIndex >= beats.length) break;
    const left = beats[beatIndex - 1];
    const right = beats[beatIndex];
    const span = Math.max(1, right.timestampMs - left.timestampMs);
    const ratio = (timestampMs - left.timestampMs) / span;
    resampled.push(left.value + ((right.value - left.value) * ratio));
  }
  const filtered = bandpass(resampled, sampleRateHz);
  const modulationMs = standardDeviation(filtered) || 0;
  const estimate = autocorrelationRate(filtered, sampleRateHz);
  if (!estimate || estimate.periodicity < 0.62 || modulationMs < 2.5) {
    return {
      accepted: false,
      reason: estimate ? "low_rr_periodicity" : "insufficient_rr_periodicity",
      periodicity: round(estimate?.periodicity, 2),
    };
  }
  if (estimate.bpm < RESPIRATION_MIN_BPM || estimate.bpm > RESPIRATION_MAX_BPM) {
    return { accepted: false, reason: "rr_rate_out_of_range" };
  }
  return {
    accepted: true,
    bpm: round(estimate.bpm),
    periodicity: round(estimate.periodicity, 2),
    confidence: estimate.periodicity >= 0.78 ? "moderate" : "limited",
    source: "rr_interval_modulation",
    caveat: "Indirect RR modulation estimate; motion and autonomic shifts can affect it.",
  };
}

export function fuseRespiration(accelerometer, ecg, rr = { accepted: false }) {
  if (accelerometer.accepted && ecg.accepted) {
    const difference = Math.abs(accelerometer.bpm - ecg.bpm);
    if (difference > 3.5) {
      return { available: false, reason: "source_disagreement", accelerometer, ecg };
    }
    const bpm = (accelerometer.bpm + ecg.bpm) / 2;
    return {
      available: true,
      bpm: round(bpm),
      confidence: difference <= 2 && accelerometer.confidence === "high" && ecg.confidence === "high" ? "high" : "moderate",
      source: "accelerometer_ecg_fused",
      agreementBpm: round(difference),
      accelerometer,
      ecg,
      possibleBreathHold: Boolean(accelerometer.possibleBreathHold),
      holdDurationSeconds: accelerometer.holdDurationSeconds || null,
    };
  }
  if (accelerometer.accepted) {
    return {
      available: true,
      bpm: accelerometer.bpm,
      confidence: "moderate",
      source: accelerometer.source,
      possibleBreathHold: Boolean(accelerometer.possibleBreathHold),
      holdDurationSeconds: accelerometer.holdDurationSeconds || null,
      accelerometer,
      ecg,
    };
  }
  if (ecg.accepted) {
    return {
      available: true,
      bpm: ecg.bpm,
      confidence: "moderate",
      source: ecg.source,
      possibleBreathHold: false,
      holdDurationSeconds: null,
      accelerometer,
      ecg,
      rr,
    };
  }
  if (rr.accepted) {
    return {
      available: true,
      bpm: rr.bpm,
      confidence: rr.confidence || "limited",
      source: rr.source,
      possibleBreathHold: false,
      holdDurationSeconds: null,
      caveat: rr.caveat,
      accelerometer,
      ecg,
      rr,
    };
  }
  const meaningfulRawReason = [accelerometer.reason, ecg.reason]
    .find((reason) => reason && reason !== "insufficient_window");
  return {
    available: false,
    reason: meaningfulRawReason || rr.reason || accelerometer.reason || ecg.reason || "sensor_unavailable",
    accelerometer,
    ecg,
    rr,
  };
}

function signalConfidence({ accelCoverage, ecgCoverage, motion, respiration, rrQuality }) {
  const ecgUsable = ecgCoverage.durationMs >= 8000 && ecgCoverage.coveragePercent >= 80 && ecgCoverage.largestGapMs <= 250;
  const accelerometerUsable = accelCoverage.durationMs >= 4000 && accelCoverage.coveragePercent >= 75 && accelCoverage.largestGapMs <= 1000;
  const motionAcceptable = motion.available && ["low_motion", "mild_motion"].includes(motion.class);
  const score = Math.round(
    (ecgUsable ? 25 : 0)
    + (accelerometerUsable ? 25 : 0)
    + (motionAcceptable ? 20 : 5)
    + (respiration.available ? 20 : 0)
    + (["high", "moderate"].includes(String(rrQuality || "").toLowerCase()) ? 10 : 0),
  );
  return {
    score,
    level: score >= 80 ? "high" : score >= 55 ? "moderate" : score >= 30 ? "low" : "unavailable",
    ecg: ecgUsable ? "usable" : ecgCoverage.durationMs ? "weak" : "unavailable",
    accelerometer: accelerometerUsable ? "usable" : accelCoverage.durationMs ? "weak" : "unavailable",
    respiration: respiration.available ? respiration.confidence : respiration.reason || "unavailable",
    motionGate: motionAcceptable ? "open" : "closed",
  };
}

function recoveryKinetics(hrHistory = []) {
  const points = hrHistory
    .map((point) => ({ timestampMs: finite(point?.ts), hr: finite(point?.hr) }))
    .filter((point) => Number.isFinite(point.timestampMs) && Number.isFinite(point.hr))
    .sort((a, b) => a.timestampMs - b.timestampMs);
  if (points.length < 10) return { available: false };
  const latest = points[points.length - 1];
  const lookbackStart = latest.timestampMs - 180_000;
  const recent = points.filter((point) => point.timestampMs >= lookbackStart);
  const peak = recent.reduce((best, point) => (point.hr > best.hr ? point : best), recent[0]);
  const elapsedSeconds = (latest.timestampMs - peak.timestampMs) / 1000;
  if (elapsedSeconds < 20 || latest.hr >= peak.hr - 2) return { available: false, peakHr: peak.hr };
  const atOffset = (seconds) => {
    const target = peak.timestampMs + seconds * 1000;
    return recent.reduce((best, point) => (
      Math.abs(point.timestampMs - target) < Math.abs(best.timestampMs - target) ? point : best
    ), recent[0]);
  };
  const at30 = elapsedSeconds >= 25 ? atOffset(30) : null;
  const at60 = elapsedSeconds >= 55 ? atOffset(60) : null;
  const at90 = elapsedSeconds >= 85 ? atOffset(90) : null;
  return {
    available: true,
    peakHr: peak.hr,
    secondsSincePeak: round(elapsedSeconds, 0),
    currentDropBpm: round(peak.hr - latest.hr, 0),
    drop30Bpm: at30 ? round(peak.hr - at30.hr, 0) : null,
    drop60Bpm: at60 ? round(peak.hr - at60.hr, 0) : null,
    drop90Bpm: at90 ? round(peak.hr - at90.hr, 0) : null,
  };
}

function responseLatency(hrHistory = [], eventHistory = []) {
  const events = (eventHistory || []).filter((event) => Number.isFinite(finite(event?.timestampMs)));
  const points = (hrHistory || []).filter((point) => Number.isFinite(finite(point?.ts)) && Number.isFinite(finite(point?.hr)));
  if (!events.length || points.length < 10) return { available: false, sampleCount: 0 };
  const lags = [];
  events.slice(-12).forEach((event) => {
    const before = points.filter((point) => point.ts >= event.timestampMs - 15_000 && point.ts <= event.timestampMs);
    const after = points.filter((point) => point.ts > event.timestampMs && point.ts <= event.timestampMs + 45_000);
    const baseline = mean(before.map((point) => point.hr));
    if (baseline == null || after.length < 3) return;
    const crossing = after.find((point) => point.hr >= baseline + 4);
    if (crossing) lags.push((crossing.ts - event.timestampMs) / 1000);
  });
  if (lags.length < 2) return { available: false, sampleCount: lags.length };
  return { available: true, medianSeconds: round(percentile(lags, 0.5), 0), sampleCount: lags.length };
}

function autonomicState({ motion, respiration, recovery, currentHr, baselineHr, hrvQuality }) {
  if (!Number.isFinite(currentHr)) return { key: "waiting", label: "WAITING", tone: "neutral" };
  if (respiration.possibleBreathHold) return { key: "possible_breath_hold", label: "POSSIBLE BREATH HOLD", tone: "warn" };
  if (recovery.available && recovery.currentDropBpm >= 4) return { key: "recovering", label: "RECOVERING", tone: "good" };
  if (respiration.reason === "motion_limited" || ["moderate_motion", "high_motion"].includes(motion.class)) {
    return { key: "active_motion", label: "ACTIVE MOTION", tone: "warn" };
  }
  const delta = Number.isFinite(baselineHr) ? currentHr - baselineHr : null;
  if (delta != null && delta >= 20 && respiration.available) return { key: "building_load", label: "BUILDING LOAD", tone: "warn" };
  if (respiration.available && ["high", "moderate"].includes(String(hrvQuality || "").toLowerCase())) {
    return { key: "tracked", label: "MULTIMODAL TRACKING", tone: "good" };
  }
  return { key: "hr_led", label: "HR-LED TRACKING", tone: "neutral" };
}

export function deriveH10MultimodalSnapshot({
  accelerometerSamples = [],
  ecgSamples = [],
  rrIntervalsMs = [],
  rrQuality = "unavailable",
  hrHistory = [],
  eventHistory = [],
  currentHr = null,
  baselineHr = null,
  baselineOrientation = null,
  nowMs = Date.now(),
} = {}) {
  const accelWindow = accelerometerSamples.filter((sample) => sample.timestampMs >= nowMs - RESPIRATION_WINDOW_MS);
  const ecgWindow = ecgSamples.filter((sample) => sample.timestampMs >= nowMs - RESPIRATION_WINDOW_MS);
  const recentAccel = accelWindow.filter((sample) => sample.timestampMs >= nowMs - 4000);
  const motion = motionSummary(recentAccel);
  const currentOrientation = orientationVector(recentAccel.filter((sample) => Math.abs(vectorMagnitude(sample) - 1000) < 120));
  const orientationChangeDegrees = orientationAngleDegrees(baselineOrientation, currentOrientation);
  const position = {
    state: !motion.available
      ? "unavailable"
      : ["moderate_motion", "high_motion"].includes(motion.class)
        ? "repositioning_or_active"
        : orientationChangeDegrees != null && orientationChangeDegrees >= 35
          ? "position_changed"
          : "stable_reference",
    orientationChangeDegrees: round(orientationChangeDegrees, 0),
    currentOrientation,
  };
  const accelRespiration = accelerometerRespiration(accelWindow, motion);
  const ecgRespiration = ecgDerivedRespiration(ecgWindow);
  const rrRespiration = rrDerivedRespiration(rrIntervalsMs);
  const respiration = fuseRespiration(accelRespiration, ecgRespiration, rrRespiration);
  const accelCoverage = windowCoverage(accelWindow, ACCEL_RATE_HZ);
  const ecgCoverage = windowCoverage(ecgWindow, ECG_RATE_HZ);
  const confidence = signalConfidence({ accelCoverage, ecgCoverage, motion, respiration, rrQuality });
  const recovery = recoveryKinetics(hrHistory);
  const latency = responseLatency(hrHistory, eventHistory);
  const state = autonomicState({ motion, respiration, recovery, currentHr: finite(currentHr), baselineHr: finite(baselineHr), hrvQuality: rrQuality });
  return {
    measuredAt: nowMs,
    signalConfidence: confidence,
    motion,
    position,
    respiration,
    recovery,
    responseLatency: latency,
    state,
    streams: {
      ecg: { sampleCount: ecgWindow.length, coveragePercent: round(ecgCoverage.coveragePercent, 0), largestGapMs: round(ecgCoverage.largestGapMs, 0) },
      accelerometer: { sampleCount: accelWindow.length, coveragePercent: round(accelCoverage.coveragePercent, 0), largestGapMs: round(accelCoverage.largestGapMs, 0) },
    },
  };
}

export function detectH10TapGesture(samples, state = {}, nowMs = Date.now()) {
  const previousMagnitude = finite(state.previousMagnitude, samples.length ? vectorMagnitude(samples[0]) : 1000);
  let lastMagnitude = previousMagnitude;
  const impulses = [...(state.impulses || [])];
  let lastImpulseAt = finite(state.lastImpulseAt, 0);
  samples.forEach((sample) => {
    const magnitude = vectorMagnitude(sample);
    const jerk = Math.abs(magnitude - lastMagnitude);
    const dynamic = Math.abs(magnitude - 1000);
    const timestampMs = finite(sample.timestampMs, nowMs);
    if ((jerk >= 420 || dynamic >= 520) && timestampMs - lastImpulseAt >= 120) {
      impulses.push(timestampMs);
      lastImpulseAt = timestampMs;
    }
    lastMagnitude = magnitude;
  });
  const recent = impulses.filter((timestampMs) => nowMs - timestampMs <= 2200).slice(-6);
  let gesture = null;
  if (recent.length >= 3) {
    const triple = recent.slice(-3);
    const intervals = [triple[1] - triple[0], triple[2] - triple[1]];
    if (intervals.every((interval) => interval >= 140 && interval <= 800)) {
      const lastGestureAt = finite(state.lastGestureAt, 0);
      if (!lastGestureAt || triple[2] - lastGestureAt >= 4000) {
        gesture = { type: "triple_tap", timestampMs: triple[1], confidence: "high" };
        return {
          state: { previousMagnitude: lastMagnitude, impulses: [], lastImpulseAt, lastGestureAt: triple[2] },
          gesture,
        };
      }
    }
  }
  return {
    state: { ...state, previousMagnitude: lastMagnitude, impulses: recent, lastImpulseAt },
    gesture,
  };
}
