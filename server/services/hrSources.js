const HR_MIN = 25;
const HR_MAX = 250;
const RR_MIN_MS = 300;
const RR_MAX_MS = 2000;

export const HR_SOURCE_IDS = {
  HEART_RATE_ON_STREAM: 'heartrateonstream',
  PULSOID: 'pulsoid',
  DIRECT_H10: 'direct_h10',
};

export const HR_SOURCE_LABELS = {
  [HR_SOURCE_IDS.HEART_RATE_ON_STREAM]: 'HeartRateOnStream',
  [HR_SOURCE_IDS.PULSOID]: 'Pulsoid / Polar H10',
  [HR_SOURCE_IDS.DIRECT_H10]: 'Direct Polar H10',
};

export function cleanHr(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < HR_MIN || n > HR_MAX) return null;
  return Math.round(n);
}

export function cleanRrIntervals(values) {
  const list = Array.isArray(values) ? values : [];
  return list
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= RR_MIN_MS && value <= RR_MAX_MS);
}

export function maskToken(token = '') {
  const value = String(token || '').trim();
  if (!value) return '';
  if (value.length <= 10) return `${value.slice(0, 2)}...${value.slice(-2)}`;
  return `${value.slice(0, 4)}...${value.slice(-4)}`;
}

function pickFirst(...values) {
  return values.find((value) => value != null && value !== '');
}

function extractRrIntervals(payload) {
  const data = payload?.data || payload || {};
  return cleanRrIntervals(pickFirst(
    data.rr_intervals_ms,
    data.rrIntervalsMs,
    data.rr,
    data.ibi,
    data.ibi_ms,
    payload?.rr_intervals_ms,
    payload?.rrIntervalsMs
  ));
}

function hrvQuality(sampleCount, rejectedFraction = 0) {
  if (sampleCount < 20) return 'low';
  if (sampleCount >= 80 && rejectedFraction < 0.08) return 'high';
  if (sampleCount >= 40 && rejectedFraction < 0.15) return 'moderate';
  return 'low';
}

export function computeHrvFromRr(rrIntervalsMs, { windowSeconds = 90, rejectedFraction = 0 } = {}) {
  const rr = cleanRrIntervals(rrIntervalsMs);
  if (rr.length < 20) {
    return {
      sampleCount: rr.length,
      windowSeconds,
      quality: rr.length ? 'low' : 'unavailable',
    };
  }

  const mean = rr.reduce((sum, value) => sum + value, 0) / rr.length;
  const sdnnMs = Math.sqrt(rr.reduce((sum, value) => sum + ((value - mean) ** 2), 0) / rr.length);
  const successiveDiffs = rr.slice(1).map((value, index) => value - rr[index]);
  const rmssdMs = Math.sqrt(successiveDiffs.reduce((sum, diff) => sum + (diff ** 2), 0) / successiveDiffs.length);
  const pnn50 = successiveDiffs.filter((diff) => Math.abs(diff) > 50).length / successiveDiffs.length;

  return {
    rmssdMs: Number(rmssdMs.toFixed(1)),
    sdnnMs: Number(sdnnMs.toFixed(1)),
    pnn50: Number(pnn50.toFixed(3)),
    sampleCount: rr.length,
    windowSeconds,
    quality: hrvQuality(rr.length, rejectedFraction),
  };
}

export function normalizeHeartRateOnStreamTelemetry(data) {
  const receivedAt = Date.now();
  const heartRate = cleanHr(pickFirst(data?.currentHr, data?.heartRate, data?.hr));
  if (heartRate == null) return null;
  const measuredAt = Number(pickFirst(data?.measuredAt, data?.measured_at, data?.timestampMs)) || receivedAt;
  const ageMs = Math.max(0, receivedAt - measuredAt);
  return {
    ...data,
    source: HR_SOURCE_IDS.HEART_RATE_ON_STREAM,
    sourceLabel: HR_SOURCE_LABELS[HR_SOURCE_IDS.HEART_RATE_ON_STREAM],
    measuredAt,
    receivedAt,
    heartRate,
    currentHr: heartRate,
    quality: {
      ...(data?.quality || {}),
      stale: ageMs > 5000,
      ageMs,
    },
    hrv: {
      quality: 'unavailable',
    },
  };
}

export function parsePulsoidMessage(raw) {
  const receivedAt = Date.now();
  const text = typeof raw === 'string' ? raw.trim() : String(raw || '').trim();
  if (/^\d+(\.\d+)?$/.test(text)) {
    const heartRate = cleanHr(text);
    if (heartRate == null) return null;
    return normalizePulsoidTelemetry({ data: { heart_rate: heartRate } }, receivedAt);
  }

  let payload;
  try {
    payload = JSON.parse(text);
  } catch {
    return null;
  }
  return normalizePulsoidTelemetry(payload, receivedAt);
}

export function normalizePulsoidTelemetry(payload, receivedAt = Date.now()) {
  const data = payload?.data || payload || {};
  const heartRate = cleanHr(pickFirst(
    data.heart_rate,
    data.heartRate,
    data.hr,
    payload?.heart_rate,
    payload?.heartRate,
    payload?.hr
  ));
  if (heartRate == null) return null;

  const measuredAtRaw = pickFirst(payload?.measured_at, payload?.measuredAt, data.measured_at, data.measuredAt);
  const measuredAt = Number(measuredAtRaw) || receivedAt;
  const ageMs = Math.max(0, receivedAt - measuredAt);
  const rrIntervalsMs = extractRrIntervals(payload);
  const hrv = rrIntervalsMs.length
    ? computeHrvFromRr(rrIntervalsMs)
    : { quality: 'unavailable' };

  return {
    source: HR_SOURCE_IDS.PULSOID,
    sourceLabel: HR_SOURCE_LABELS[HR_SOURCE_IDS.PULSOID],
    measuredAt,
    receivedAt,
    heartRate,
    currentHr: heartRate,
    hr: heartRate,
    rrIntervalsMs,
    hrv,
    quality: {
      stale: ageMs > 5000,
      ageMs,
    },
    raw: payload,
  };
}

export function normalizeDirectH10Telemetry(payload, receivedAt = Date.now()) {
  const data = payload?.data || payload || {};
  const heartRate = cleanHr(pickFirst(
    data.heart_rate,
    data.heartRate,
    data.currentHr,
    data.hr,
    payload?.heart_rate,
    payload?.heartRate,
    payload?.currentHr,
    payload?.hr
  ));
  if (heartRate == null) return null;

  const measuredAtRaw = pickFirst(payload?.measured_at, payload?.measuredAt, data.measured_at, data.measuredAt);
  const measuredAt = Number(measuredAtRaw) || receivedAt;
  const ageMs = Math.max(0, receivedAt - measuredAt);
  const rrIntervalsMs = extractRrIntervals(payload);
  const hrv = payload?.hrv || data.hrv || (rrIntervalsMs.length
    ? computeHrvFromRr(rrIntervalsMs)
    : { quality: 'unavailable' });

  return {
    source: HR_SOURCE_IDS.DIRECT_H10,
    sourceLabel: HR_SOURCE_LABELS[HR_SOURCE_IDS.DIRECT_H10],
    measuredAt,
    receivedAt,
    heartRate,
    currentHr: heartRate,
    hr: heartRate,
    rrIntervalsMs,
    hrv,
    quality: {
      ...(payload?.quality || data.quality || {}),
      stale: ageMs > 5000,
      ageMs,
    },
    raw: payload,
  };
}
