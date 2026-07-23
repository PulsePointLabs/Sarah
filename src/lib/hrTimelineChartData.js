const MAX_VISIBLE_POINTS = 1200;

export function numberOrNull(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function averageNumbers(values = [], { positiveOnly = false } = {}) {
  const numbers = values
    .map(numberOrNull)
    .filter((value) => value != null && (!positiveOnly || value > 0));
  if (!numbers.length) return null;
  return numbers.reduce((sum, value) => sum + value, 0) / numbers.length;
}

function pickLastPresent(rows = [], key) {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const value = rows[index]?.[key];
    if (value != null && value !== "") return value;
  }
  return null;
}

export function buildCleanChartRows(rows = [], maxPoints = MAX_VISIBLE_POINTS) {
  const sortedRows = [...rows]
    .map((row) => ({ ...row, time_offset_s: numberOrNull(row.time_offset_s) }))
    .filter((row) => row.time_offset_s != null)
    .sort((a, b) => a.time_offset_s - b.time_offset_s);

  if (!sortedRows.length) return [];

  const deduped = [];
  let group = [];
  let currentTime = null;

  const flushGroup = () => {
    if (!group.length) return;
    deduped.push({
      ...group[group.length - 1],
      time_offset_s: currentTime,
      hr: averageNumbers(group.map((row) => row.hr), { positiveOnly: true }),
      hr_smoothed: averageNumbers(group.map((row) => row.hr_smoothed), { positiveOnly: true }),
      baseline_hr: averageNumbers(group.map((row) => row.baseline_hr), { positiveOnly: true }),
      elevated_delta: averageNumbers(group.map((row) => row.elevated_delta)),
      hrv_rmssd_ms: averageNumbers(group.map((row) => row.hrv_rmssd_ms), { positiveOnly: true }),
      hrv_sdnn_ms: averageNumbers(group.map((row) => row.hrv_sdnn_ms), { positiveOnly: true }),
      hrv_pnn50: averageNumbers(group.map((row) => row.hrv_pnn50)),
      marker: pickLastPresent(group, "marker"),
      note: pickLastPresent(group, "note"),
      hrv_quality: pickLastPresent(group, "hrv_quality"),
    });
    group = [];
  };

  sortedRows.forEach((row) => {
    if (currentTime == null || row.time_offset_s === currentTime) {
      currentTime = row.time_offset_s;
      group.push(row);
      return;
    }
    flushGroup();
    currentTime = row.time_offset_s;
    group = [row];
  });
  flushGroup();

  if (deduped.length <= maxPoints) return deduped;

  const step = Math.ceil(deduped.length / maxPoints);
  return deduped.filter((_, index) => index % step === 0 || index === deduped.length - 1);
}
