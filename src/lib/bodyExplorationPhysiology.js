import { buildProcedurePhysiologyContext } from "./procedurePhysiologyContext.js";
import { buildNearbyVitalsEvidence } from "./nearbyVitals.js";

const USABLE_HRV_QUALITY = new Set(["moderate", "high"]);

function finite(value) {
  if (value == null || value === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function round(value, digits = 1) {
  if (!Number.isFinite(value)) return null;
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

function quantile(sorted, percentile) {
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * percentile;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (index - lower);
}

function stats(values, digits = 1) {
  const usable = values.map(finite).filter((value) => value != null).sort((a, b) => a - b);
  if (!usable.length) return null;
  return {
    samples: usable.length,
    min: round(usable[0], digits),
    p25: round(quantile(usable, 0.25), digits),
    median: round(quantile(usable, 0.5), digits),
    mean: round(usable.reduce((sum, value) => sum + value, 0) / usable.length, digits),
    p75: round(quantile(usable, 0.75), digits),
    max: round(usable[usable.length - 1], digits),
  };
}

function rowTime(row = {}) {
  return finite(row.time_offset_s ?? row.time_s ?? row.offset_s);
}

function medianInterval(rows = []) {
  const times = rows.map(rowTime).filter((value) => value != null).sort((a, b) => a - b);
  return stats(times.slice(1).map((value, index) => value - times[index]).filter((value) => value > 0 && value < 30), 3)?.median ?? null;
}

function countValues(rows, field) {
  const counts = {};
  rows.forEach((row) => {
    const value = String(row[field] ?? "").trim();
    if (value) counts[value] = (counts[value] || 0) + 1;
  });
  return counts;
}

function values(rows, field, predicate = () => true) {
  return rows.map((row) => finite(row[field])).filter((value) => value != null && predicate(value));
}

function rrValues(rows) {
  return rows.flatMap((row) => String(row.rr_intervals_ms || "")
    .split(/[|,;\s]+/)
    .map(finite)
    .filter((value) => value != null && value >= 250 && value <= 2000));
}

function summarizeEmg(rows = []) {
  if (!rows.length) return null;
  const ignored = new Set(["time_s", "time_offset_s", "unix_time", "session", "id", "created_date", "updated_date"]);
  const fields = [...new Set(rows.flatMap((row) => Object.keys(row)))].filter((field) => (
    !ignored.has(field) && rows.some((row) => finite(row[field]) != null)
  ));
  const channels = Object.fromEntries(fields.map((field) => [field, stats(values(rows, field))]).filter(([, summary]) => summary));
  return {
    rows: rows.length,
    median_sample_interval_s: medianInterval(rows),
    fields_present: Object.keys(channels),
    channels,
  };
}

function trajectory(rows = []) {
  const duration = Math.max(0, ...rows.map((row) => rowTime(row) || 0));
  if (!rows.length || duration <= 0) return [];
  const binSeconds = Math.max(5, Math.ceil(duration / 240));
  const bins = new Map();
  rows.forEach((row) => {
    const time = rowTime(row);
    if (time == null) return;
    const key = Math.floor(time / binSeconds);
    if (!bins.has(key)) bins.set(key, []);
    bins.get(key).push(row);
  });
  return [...bins.entries()].map(([key, bucket]) => {
    const usableHrv = bucket.filter((row) => USABLE_HRV_QUALITY.has(String(row.hrv_quality || "").toLowerCase()));
    const respiration = bucket.filter((row) => !row.respiration_unavailable_reason && finite(row.respiration_bpm) > 0);
    const motion = bucket.filter((row) => String(row.motion_class || "").toLowerCase() !== "unavailable");
    const stateRows = bucket.filter((row) => row.signal_confidence_level !== "unavailable" && row.multimodal_state);
    return {
      time_s: key * binSeconds,
      window_s: binSeconds,
      hr_bpm: stats(bucket.map((row) => finite(row.hr_smoothed ?? row.hr)), 1)?.mean ?? null,
      rmssd_ms: stats(usableHrv.map((row) => finite(row.hrv_rmssd_ms)), 1)?.median ?? null,
      sdnn_ms: stats(usableHrv.map((row) => finite(row.hrv_sdnn_ms)), 1)?.median ?? null,
      respiration_bpm: stats(respiration.map((row) => finite(row.respiration_bpm)), 1)?.median ?? null,
      motion_rms_mg: stats(motion.map((row) => finite(row.motion_dynamic_rms_mg)), 1)?.median ?? null,
      state: Object.entries(countValues(stateRows, "multimodal_state")).sort((a, b) => b[1] - a[1])[0]?.[0] || null,
    };
  });
}

export function buildBodyExplorationPhysiologyEvidence({ exploration = {}, timelineRows = [], emgRows = [], nearbyVitals = {} } = {}) {
  const sortedRows = [...timelineRows].sort((a, b) => (rowTime(a) || 0) - (rowTime(b) || 0));
  const usableHrv = sortedRows.filter((row) => USABLE_HRV_QUALITY.has(String(row.hrv_quality || "").toLowerCase()));
  const usableRespiration = sortedRows.filter((row) => !row.respiration_unavailable_reason && finite(row.respiration_bpm) > 0);
  const usableMotion = sortedRows.filter((row) => row.motion_class && String(row.motion_class).toLowerCase() !== "unavailable");
  const usableStateRows = sortedRows.filter((row) => row.signal_confidence_level !== "unavailable" && row.multimodal_state);
  const procedure = buildProcedurePhysiologyContext(
    [exploration],
    { [exploration.id]: sortedRows },
    { recordLimit: 1, milestoneLimit: 8 },
  );
  const durationS = Math.max(0, ...sortedRows.map((row) => rowTime(row) || 0));
  const respirationUnavailableReasons = countValues(sortedRows, "respiration_unavailable_reason");

  return {
    provenance: {
      heart_rate_timeline_rows: sortedRows.length,
      emg_timeline_rows: emgRows.length,
      duration_s: round(durationS, 1),
      median_hr_sample_interval_s: medianInterval(sortedRows),
      heart_rate_sources: countValues(sortedRows, "hr_source"),
      signal_quality_levels: countValues(sortedRows, "signal_confidence_level"),
      hrv_quality_levels: countValues(sortedRows, "hrv_quality"),
      interpretation_rule: "Only measured fields are summarized. Zero/unavailable respiration or motion and low-quality HRV are withheld rather than interpreted.",
    },
    signals: {
      heart_rate_bpm: stats(sortedRows.map((row) => finite(row.hr_smoothed ?? row.hr)).filter((value) => value >= 30 && value <= 240)),
      baseline_hr_bpm: stats(values(sortedRows, "baseline_hr", (value) => value >= 30 && value <= 240)),
      elevation_above_baseline_bpm: stats(values(sortedRows, "elevated_delta")),
      rr_intervals_ms: stats(rrValues(sortedRows)),
      hrv: {
        usable_rows: usableHrv.length,
        rmssd_ms: stats(values(usableHrv, "hrv_rmssd_ms", (value) => value > 0)),
        sdnn_ms: stats(values(usableHrv, "hrv_sdnn_ms", (value) => value > 0)),
        pnn50: stats(values(usableHrv, "hrv_pnn50", (value) => value >= 0), 3),
      },
      respiration: usableRespiration.length ? {
        usable_rows: usableRespiration.length,
        breaths_per_minute: stats(values(usableRespiration, "respiration_bpm", (value) => value > 0)),
        confidence: stats(values(usableRespiration, "respiration_confidence", (value) => value > 0)),
        possible_breath_hold_rows: usableRespiration.filter((row) => row.possible_breath_hold === true).length,
      } : { usable_rows: 0, unavailable_reasons: respirationUnavailableReasons },
      motion: usableMotion.length ? {
        usable_rows: usableMotion.length,
        classes: countValues(usableMotion, "motion_class"),
        dynamic_rms_mg: stats(values(usableMotion, "motion_dynamic_rms_mg", (value) => value >= 0)),
        peak_dynamic_mg: stats(values(usableMotion, "motion_peak_dynamic_mg", (value) => value >= 0)),
        position_states: countValues(usableMotion, "position_state"),
      } : { usable_rows: 0 },
      multimodal_states: countValues(usableStateRows, "multimodal_state"),
      recovery_drop_bpm: {
        at_30_seconds: stats(values(sortedRows, "recovery_drop_30_bpm")),
        at_60_seconds: stats(values(sortedRows, "recovery_drop_60_bpm")),
        at_90_seconds: stats(values(sortedRows, "recovery_drop_90_bpm")),
      },
      response_latency_seconds: stats(values(sortedRows, "response_latency_seconds", (value) => value >= 0)),
      emg: summarizeEmg(emgRows),
    },
    high_resolution_trajectory: {
      adaptive_bin_seconds: Math.max(5, Math.ceil(durationS / 240)),
      bins: trajectory(sortedRows),
    },
    procedure_aligned_windows: procedure.context,
    nearby_vital_signs: buildNearbyVitalsEvidence(nearbyVitals),
  };
}
