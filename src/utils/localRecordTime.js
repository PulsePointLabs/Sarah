function dateParts(value) {
  if (!value) return null;
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) return [Number(match[1]), Number(match[2]) - 1, Number(match[3])];
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime())
    ? null
    : [parsed.getFullYear(), parsed.getMonth(), parsed.getDate()];
}

function clockParts(value) {
  if (!value) return null;
  const match = String(value).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] || 0);
  if (/pm/i.test(match[4] || "") && hour < 12) hour += 12;
  if (/am/i.test(match[4] || "") && hour === 12) hour = 0;
  if (hour > 23 || minute > 59 || second > 59) return null;
  return [hour, minute, second];
}

export function parseDeviceLocalTimestamp(value) {
  if (!value) return null;
  const raw = String(value).trim().replace(/\s+/g, " ");
  const match = raw.match(
    /^(\d{4})[/-](\d{1,2})[/-](\d{1,2})[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?(?:\s*(?:Z|[+-]\d{2}:?\d{2}))?$/i,
  ) || raw.match(
    /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?(?:\s*(?:Z|[+-]\d{2}:?\d{2}))?$/i,
  );
  if (match) {
    const yearFirst = match[1].length === 4;
    let year = Number(yearFirst ? match[1] : match[3]);
    if (year < 100) year += 2000;
    const month = Number(yearFirst ? match[2] : match[1]);
    const day = Number(yearFirst ? match[3] : match[2]);
    let hour = Number(match[4]);
    if (/pm/i.test(match[7] || "") && hour < 12) hour += 12;
    if (/am/i.test(match[7] || "") && hour === 12) hour = 0;
    const local = new Date(year, month - 1, day, hour, Number(match[5]), Number(match[6] || 0));
    return Number.isNaN(local.getTime()) ? null : local;
  }

  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

export function getRecordStart(record = {}) {
  const day = dateParts(record.date);
  const startClock = clockParts(record.start_time);
  if (!day || !startClock) return null;
  const start = new Date(...day, ...startClock);
  return { start, startMs: start.getTime() };
}

export function getRecordWindow(record = {}) {
  const recordStart = getRecordStart(record);
  if (!recordStart) return null;
  const { start, startMs } = recordStart;
  const day = [start.getFullYear(), start.getMonth(), start.getDate()];
  const endClock = clockParts(record.end_time);
  let end = null;
  if (endClock) {
    end = new Date(...day, ...endClock);
    if (end < start) end.setDate(end.getDate() + 1);
  } else if (Number(record.duration_minutes) > 0) {
    end = new Date(start.getTime() + Number(record.duration_minutes) * 60_000);
  }
  if (!end) return null;
  return { start, end, startMs, endMs: end.getTime() };
}

export function readingsWithinRecord(readings = [], record = {}) {
  const window = getRecordWindow(record);
  if (!window) return [];
  return readings
    .filter((reading) => {
      const timestamp = new Date(reading.measured_at).getTime();
      return Number.isFinite(timestamp) && timestamp >= window.startMs && timestamp <= window.endMs;
    })
    .map((reading) => ({
      ...reading,
      time_offset_s: Math.max(0, Math.round((new Date(reading.measured_at).getTime() - window.startMs) / 1000)),
    }));
}
