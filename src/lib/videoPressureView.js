import { civetAt } from './civet.js';
import { contractionSnapshot } from './civetSnapshot.js';

export function videoPressureSummary(rows, events, at, seconds = 30) {
  const current = civetAt(rows, at);
  const relative = !!current && (current.usable ?? current.calibration_valid) && Number.isFinite(current.delta_kpa);
  const known = rows.filter(row => row.t <= at && !row.gap && (relative
    ? (row.usable ?? row.calibration_valid) && row.calibration?.id === current.calibration?.id && Number.isFinite(row.delta_kpa)
    : Number.isFinite(row.pressure_kpa)));
  const value = row => relative ? row.delta_kpa : row.pressure_kpa;
  const rolling = known.filter(row => row.t >= at - seconds);
  const usableEvents = events.filter(event => event.quality === 'usable' && event.calibration_valid !== false);
  const snapshot = contractionSnapshot(usableEvents, at, Math.max(0, at - seconds));
  const held = relative && current.duration_s > 0;
  const range = known.reduce((range, row) => [Math.min(range[0], value(row)), Math.max(range[1], value(row))], [0, .1]);
  return { current, relative, snapshot, held, duration: held ? current.duration_s : current ? snapshot.latest?.duration_s ?? null : null,
    value: current ? value(current) : null,
    average: rolling.length ? rolling.reduce((sum, row) => sum + value(row), 0) / rolling.length : null,
    peak: rolling.length ? rolling.reduce((max, row) => Math.max(max, value(row)), -Infinity) : null,
    range: [Math.floor(range[0]), Math.max(1, Math.ceil(range[1]))] };
}

// Min/max envelopes preserve short peaks without drawing a synthetic joined trace.
export function pressureOverview(rows, budget = 600) {
  if (!rows.length) return [];
  const bins = Math.min(budget, Math.max(1, Math.ceil(rows.length / 6)));
  const start = rows[0].t, end = rows.at(-1).t, width = Math.max(.1, end - start) / bins;
  const buckets = new Map();
  for (const row of rows) {
    if (row.gap || !Number.isFinite(row.pressure_kpa)) continue;
    const index = Math.min(bins - 1, Math.max(0, Math.floor((row.t - start) / width)));
    const old = buckets.get(index);
    buckets.set(index, { t: start + (index + .5) * width, min: Math.min(old?.min ?? Infinity, row.pressure_kpa), max: Math.max(old?.max ?? -Infinity, row.pressure_kpa) });
  }
  return [...buckets.values()];
}

export function nearestPressureBurst(trains, time) {
  return trains.reduce((best, train, index) => {
    const distance = time < train.start ? train.start - time : time > train.end ? time - train.end : 0;
    return best.index < 0 || distance < best.distance ? { index, distance } : best;
  }, { index: -1, distance: Infinity }).index;
}
