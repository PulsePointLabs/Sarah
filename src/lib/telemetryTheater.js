function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function recordStartMs(record = {}) {
  const date = String(record.date || "").slice(0, 10);
  const time = /^\d{1,2}:\d{2}/.test(String(record.start_time || ""))
    ? String(record.start_time).slice(0, 5)
    : "";
  if (date && time) {
    const local = new Date(`${date}T${time}:00`).getTime();
    if (Number.isFinite(local)) return local;
  }
  for (const value of [record.started_at, record.created_date]) {
    const parsed = new Date(value || "").getTime();
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

export function readingOffsetSeconds(reading = {}, record = {}) {
  const savedOffset = finite(reading.time_offset_s);
  if (savedOffset != null) return savedOffset;
  const startMs = recordStartMs(record);
  const measuredMs = new Date(reading.measured_at || reading.timestamp || reading.time || "").getTime();
  if (startMs == null || !Number.isFinite(measuredMs)) return null;
  return Math.round((measuredMs - startMs) / 100) / 10;
}

export function normalizeTimedReadings(readings = [], record = {}) {
  return (Array.isArray(readings) ? readings : [])
    .map((reading) => ({ ...reading, time_offset_s: readingOffsetSeconds(reading, record) }))
    .filter((reading) => reading.time_offset_s != null)
    .sort((a, b) => a.time_offset_s - b.time_offset_s);
}

export function readingSequenceAt(readings = [], timeS = 0) {
  const rows = [...readings].sort((a, b) => Number(a.time_offset_s) - Number(b.time_offset_s));
  const cursor = finite(timeS) ?? 0;
  const previous = [...rows].reverse().find((row) => Number(row.time_offset_s) <= cursor) || null;
  const upcoming = rows.find((row) => Number(row.time_offset_s) > cursor) || null;
  const nearest = rows.reduce((best, row) => {
    if (!best) return row;
    return Math.abs(Number(row.time_offset_s) - cursor) < Math.abs(Number(best.time_offset_s) - cursor) ? row : best;
  }, null);
  return { previous, upcoming, nearest };
}

export function nearestTimedReading(readings = [], timeS = 0, maxDistanceS = Number.POSITIVE_INFINITY) {
  const { nearest } = readingSequenceAt(readings, timeS);
  if (!nearest || Math.abs(Number(nearest.time_offset_s) - Number(timeS || 0)) > maxDistanceS) return null;
  return nearest;
}
