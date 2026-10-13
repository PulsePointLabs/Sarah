import { contractionSnapshot } from './civetSnapshot.js';

const finite = value => value != null && Number.isFinite(value);
const mean = rows => rows.length ? rows.reduce((sum, row) => sum + row.delta_kpa, 0) / rows.length : null;

// Presentation summaries only: detector outputs and recorded samples are unchanged.
export function createCivetMonitorSummary() {
  let key, count = 0, sum = 0, max = null, longest = 0;
  return sample => {
    const nextKey = `${sample.capture_id}:${sample.calibration?.id}`;
    if (key !== nextKey) { key = nextKey; count = 0; sum = 0; max = null; longest = 0; }
    if (sample.usable && !sample.gap && finite(sample.delta_kpa)) {
      count++; sum += sample.delta_kpa;
      max = max == null ? sample.delta_kpa : Math.max(max, sample.delta_kpa);
      longest = Math.max(longest, sample.duration_s || 0);
    }
    return { average: count ? sum / count : null, max, longest, count, calibrationId: sample.calibration?.id };
  };
}

export function civetLiveSnapshot(live) {
  const sample = live.latest;
  const anchor = sample || live.history?.at(-1);
  const end = sample?.t ?? (anchor?.t ?? 0) + Math.min(20, (live.age_ms || 0) / 1000);
  const calibrationId = anchor?.calibration?.id;
  const history = (live.history || []).filter(row => row.t <= end && row.calibration?.id === calibrationId && row.capture_id === anchor?.capture_id);
  const valid = history.filter(row => row.usable && !row.gap && finite(row.delta_kpa));
  const recent = valid.filter(row => row.t >= end - 30);
  const previous = valid.filter(row => row.t < end - 30 && row.t >= end - 60);
  const lastGap = history.findLast(row => row.gap)?.t ?? -Infinity;
  const events = history.flatMap(row => row.events || []).filter(event => event.quality === 'usable' && event.calibration_valid !== false && event.calibration?.id === calibrationId && event.onset >= lastGap);
  const snapshot = contractionSnapshot(events, end, end - 20);
  const current = sample?.usable && finite(sample.delta_kpa) ? sample.delta_kpa : null;
  const held = current != null && sample.duration_s > 0;
  const rhythmic = current != null && sample.rhythm && snapshot.train.length >= 3;
  const strong = current != null && held && sample.duration_s >= .3
    && !sample.gap
    && current >= Math.max(.4, (sample.calibration?.reference || 1) * .6)
    && !(sample.quality_flags || []).includes('abrupt_pressure_change');
  const average = mean(recent), priorAverage = mean(previous);
  // Compare complete adjacent windows, rather than a few startup samples.
  const trend = recent.length >= 240 && previous.length >= 240 ? average - priorAverage : null;
  const summary = live.monitorSummary?.calibrationId === calibrationId ? live.monitorSummary : null;
  return { sample, anchor, end, history, valid, events, current, held, rhythmic, strong, average,
    recentMax: recent.length ? Math.max(...recent.map(row => row.delta_kpa)) : null,
    sessionAverage: summary?.average ?? null, sessionMax: summary ? summary.max : sample?.usable ? sample.session_max_kpa ?? null : null,
    longest: summary?.longest ?? null, snapshot, trend, priorAverage,
    duration: held ? sample.duration_s : current != null ? snapshot.latest?.duration_s ?? null : null };
}

export function updateCivetMonitorZoom(previous = {}, snapshot, enabled = true) {
  const key = `${snapshot.anchor?.capture_id}:${snapshot.anchor?.calibration?.id}`;
  const state = previous.key === key && snapshot.end >= (previous.end ?? -Infinity) ? previous : {};
  const activeUntil = snapshot.current != null && (snapshot.strong || snapshot.rhythmic) ? snapshot.end + 8 : state.activeUntil;
  const values = snapshot.valid.map(row => row.delta_kpa);
  const max = Math.max(state.max ?? 1, snapshot.sample?.calibration?.reference || 0, ...values);
  const min = Math.min(state.min ?? 0, ...values);
  return { key, end: snapshot.end, activeUntil, max: Math.ceil(max), min: Math.floor(min),
    seconds: enabled && snapshot.current != null && snapshot.end <= activeUntil ? 8 : 20 };
}
