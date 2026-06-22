function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 1) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function fmtClock(seconds = 0) {
  const totalSeconds = Math.max(0, Math.round(Number(seconds) || 0));
  const minutes = Math.floor(totalSeconds / 60);
  const secs = totalSeconds % 60;
  return `${minutes}:${String(secs).padStart(2, "0")}`;
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

function rowTime(row) {
  return numberOrNull(row?.time_offset_s ?? row?.time_s ?? row?.offset_s ?? row?.timestamp_s);
}

function rowHr(row) {
  return numberOrNull(row?.hr_smoothed ?? row?.hr ?? row?.heart_rate ?? row?.bpm);
}

function rowRr(row) {
  return numberOrNull(row?.rr_ms ?? row?.rr_interval_ms ?? row?.rrIntervalMs);
}

function summarizeValues(values, digits = 1) {
  const clean = values.filter(Number.isFinite);
  if (!clean.length) return null;
  return {
    count: clean.length,
    min: round(Math.min(...clean), digits),
    avg: round(clean.reduce((sum, value) => sum + value, 0) / clean.length, digits),
    max: round(Math.max(...clean), digits),
    median: round(median(clean), digits),
    start: round(clean[0], digits),
    end: round(clean[clean.length - 1], digits),
    delta: round(clean[clean.length - 1] - clean[0], digits),
  };
}

function rowsInWindow(rows = [], start, end) {
  return rows
    .map((row) => ({ ...row, _time_s: rowTime(row) }))
    .filter((row) => row._time_s != null && row._time_s >= start && row._time_s <= end)
    .sort((a, b) => a._time_s - b._time_s);
}

function nearestRow(rows = [], time) {
  const clean = rows
    .map((row) => ({ ...row, _time_s: rowTime(row) }))
    .filter((row) => row._time_s != null)
    .sort((a, b) => Math.abs(a._time_s - time) - Math.abs(b._time_s - time));
  return clean[0] || null;
}

function summarizeHrv(rows = []) {
  const rmssd = summarizeValues(rows.map((row) => numberOrNull(row.hrv_rmssd_ms)), 1);
  const sdnn = summarizeValues(rows.map((row) => numberOrNull(row.hrv_sdnn_ms)), 1);
  const pnn50 = summarizeValues(rows.map((row) => numberOrNull(row.hrv_pnn50)), 3);
  const rr = summarizeValues(rows.map(rowRr), 1);
  const qualities = rows
    .map((row) => String(row.hrv_quality || "").toLowerCase())
    .filter(Boolean);
  if (!rmssd && !sdnn && !pnn50 && !rr && !qualities.length) return null;
  return {
    rr_ms: rr,
    rmssd_ms: rmssd,
    sdnn_ms: sdnn,
    pnn50,
    quality_values: [...new Set(qualities)].slice(0, 5),
    usable_quality_rows: qualities.filter((value) => value === "moderate" || value === "high").length,
  };
}

function summarizeHr(rows = []) {
  const values = rows.map(rowHr);
  const summary = summarizeValues(values, 0);
  if (!summary) return null;
  return {
    samples: summary.count,
    bpm_min: summary.min,
    bpm_avg: summary.avg,
    bpm_max: summary.max,
    bpm_start: summary.start,
    bpm_end: summary.end,
    bpm_delta: summary.delta,
  };
}

function nearbyEvents(session = {}, start, end) {
  const rows = Array.isArray(session?.event_timeline) ? session.event_timeline : [];
  return rows
    .map((event) => ({
      time_s: rowTime(event),
      note: String(event?.note || event?.label || event?.description || event?.text || "").replace(/\s+/g, " ").trim(),
      category: event?.category || "",
      source: event?.source || "event_timeline",
    }))
    .filter((event) => event.time_s != null && event.note && event.time_s >= start && event.time_s <= end)
    .sort((a, b) => a.time_s - b.time_s)
    .slice(0, 16)
    .map((event) => ({
      ...event,
      time_label: fmtClock(event.time_s),
      note: event.note.slice(0, 260),
    }));
}

function phaseMarkers(session = {}, center) {
  return [
    ["pre_climax_offset_s", "pre-climax"],
    ["climax_offset_s", "climax"],
    ["recovery_offset_s", "recovery"],
  ]
    .map(([key, label]) => {
      const time = numberOrNull(session?.[key]);
      if (time == null) return null;
      return {
        key,
        label,
        time_s: time,
        time_label: fmtClock(time),
        delta_from_window_center_s: round(time - center, 1),
      };
    })
    .filter(Boolean);
}

function summarizeEmgRows(rows = []) {
  if (!rows.length) return null;
  const numericKeys = Object.keys(rows[0] || {})
    .filter((key) => !/^(?:id|session|created|updated|time|timestamp|offset)/i.test(key))
    .filter((key) => rows.some((row) => Number.isFinite(Number(row[key]))))
    .slice(0, 8);
  if (!numericKeys.length) return { samples: rows.length };
  return {
    samples: rows.length,
    channels: Object.fromEntries(numericKeys.map((key) => [key, summarizeValues(rows.map((row) => numberOrNull(row[key])), 2)])),
  };
}

export function buildSessionMomentTelemetry({
  session = {},
  timelineRows = [],
  emgRows = [],
  startSeconds = 0,
  endSeconds = 0,
  contextPadSeconds = 20,
} = {}) {
  const start = Math.max(0, Number(startSeconds) || 0);
  const end = Math.max(start, Number(endSeconds) || start);
  const center = (start + end) / 2;
  const contextStart = Math.max(0, start - contextPadSeconds);
  const contextEnd = end + contextPadSeconds;
  const exactRows = rowsInWindow(timelineRows, start, end);
  const contextRows = rowsInWindow(timelineRows, contextStart, contextEnd);
  const nearest = nearestRow(timelineRows, center);
  const exactEmgRows = rowsInWindow(emgRows, start, end);
  const contextEmgRows = rowsInWindow(emgRows, contextStart, contextEnd);

  return {
    source: "saved HeartRateTimeline/EMGTimeline rows, event timeline, and manual phase markers",
    requested_session_window: {
      start_s: round(start, 1),
      end_s: round(end, 1),
      label: `${fmtClock(start)}-${fmtClock(end)}`,
    },
    context_window: {
      start_s: round(contextStart, 1),
      end_s: round(contextEnd, 1),
      label: `${fmtClock(contextStart)}-${fmtClock(contextEnd)}`,
    },
    nearest_sample_to_center: nearest ? {
      time_s: round(nearest._time_s, 1),
      time_label: fmtClock(nearest._time_s),
      hr_bpm: rowHr(nearest) != null ? round(rowHr(nearest), 0) : null,
      rr_ms: rowRr(nearest),
      hrv_rmssd_ms: numberOrNull(nearest.hrv_rmssd_ms),
      hrv_sdnn_ms: numberOrNull(nearest.hrv_sdnn_ms),
      hrv_pnn50: numberOrNull(nearest.hrv_pnn50),
      hrv_quality: nearest.hrv_quality || null,
    } : null,
    heart_rate: {
      exact_window: summarizeHr(exactRows),
      context_window: summarizeHr(contextRows),
    },
    rr_hrv: {
      exact_window: summarizeHrv(exactRows),
      context_window: summarizeHrv(contextRows),
    },
    emg: {
      exact_window: summarizeEmgRows(exactEmgRows),
      context_window: summarizeEmgRows(contextEmgRows),
    },
    phase_markers: phaseMarkers(session, center),
    nearby_events: nearbyEvents(session, contextStart, contextEnd),
    row_counts: {
      timeline_exact: exactRows.length,
      timeline_context: contextRows.length,
      emg_exact: exactEmgRows.length,
      emg_context: contextEmgRows.length,
    },
  };
}

export function formatMomentTelemetryForPrompt(momentTelemetry) {
  if (!momentTelemetry) return "No saved telemetry context was assembled for this moment.";
  return JSON.stringify(momentTelemetry, null, 2).slice(0, 9000);
}

export const MOMENT_TELEMETRY_INTERPRETATION_RULES = `
MOMENT TELEMETRY RULES:
- Treat the saved telemetry packet as the source of truth for exact HR, RR/HRV, EMG, event-note, and phase-marker timing claims.
- Do not infer exact climax HR, HRV, or recovery values from whole-session average/max fields if moment rows are available.
- If the packet has no exact-window row for a metric, say that metric is unavailable for the exact moment; then you may use the wider context window cautiously.
- RR/HRV fields are only interpretable when present and quality is moderate/high. Low-quality-only HRV should be described as limited or unavailable, not as a firm autonomic read.
- Use visual frames for visible mechanics and body position; use saved telemetry for numeric physiology; use manual event notes and phase markers for timing.
- If exported-video playback time and source session time differ, cite the mapped session window, not just the video player time.
`;
