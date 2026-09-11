export const TELEMETRY_MAX_AGE_S = 2;
const numeric = (v) => v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);

// Sorted session timestamps. Never borrow a future or distant sample to make
// the panel look more complete than the actual evidence at the playhead.
export function telemetryAtOrBefore(rows, time, maxAge = TELEMETRY_MAX_AGE_S) {
  let low = 0, high = rows.length;
  while (low < high) {
    const middle = (low + high) >>> 1;
    if (Number(rows[middle].time_offset_s) <= time) low = middle + 1;
    else high = middle;
  }
  const row = rows[low - 1] ?? null;
  const age = row ? time - Number(row.time_offset_s) : null;
  return { row: age != null && age <= maxAge ? row : null, age, stale: age != null && age > maxAge };
}

export function telemetryTimeLabel(seconds) {
  const totalMs = Math.max(0, Math.round((numeric(seconds) ?? 0) * 1000));
  const totalSeconds = Math.floor(totalMs / 1000);
  return `${Math.floor(totalSeconds / 60)}:${String(totalSeconds % 60).padStart(2, "0")}.${String(totalMs % 1000).padStart(3, "0")}`;
}

export function breakTelemetryGaps(rows, keys, maxGap = TELEMETRY_MAX_AGE_S) {
  const result = [];
  for (const row of rows) {
    const last = result.at(-1);
    if (last && row.t - last.t > maxGap) {
      result.push({ t: last.t + maxGap, ...Object.fromEntries(keys.map((key) => [key, null])) });
    }
    result.push(row);
  }
  return result;
}
