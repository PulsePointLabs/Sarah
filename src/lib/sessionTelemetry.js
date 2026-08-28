import { base44 } from "@/api/base44Client";

export const SESSION_TIMELINE_SAMPLE_LIMIT = 1200;

export const SESSION_TIMELINE_FIELDS = [
  "id",
  "session",
  "timestamp",
  "time_offset_ms",
  "time_offset_s",
  "hr",
  "hr_smoothed",
  "baseline_hr",
  "elevated_delta",
  "marker",
  "note",
  "hr_source",
  "hr_measured_at",
  "hr_received_at",
  "hr_age_ms",
  "rr_intervals_ms",
  "hrv_rmssd_ms",
  "hrv_sdnn_ms",
  "hrv_pnn50",
  "hrv_window_seconds",
  "hrv_quality",
  "signal_confidence_score",
  "signal_confidence_level",
  "motion_class",
  "motion_dynamic_rms_mg",
  "motion_peak_dynamic_mg",
  "respiration_bpm",
  "respiration_confidence",
  "respiration_source",
  "respiration_unavailable_reason",
  "possible_breath_hold",
  "breath_hold_duration_seconds",
  "position_state",
  "orientation_change_degrees",
  "multimodal_state",
  "recovery_drop_30_bpm",
  "recovery_drop_60_bpm",
  "recovery_drop_90_bpm",
  "response_latency_seconds",
];

function positiveInteger(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : 0;
}

export function sessionTelemetryExpectation(session = {}) {
  const sourceRows = Math.max(
    positiveInteger(session?.live_capture_import?.hr_rows),
    positiveInteger(session?.capture_digest?.hr_rows),
    positiveInteger(session?.telemetry_summary?.hr_rows),
  );
  const fileUrl = session.hr_data_file || session?.capture_files?.hr?.file_url || "";
  return {
    sourceRows,
    fileUrl,
    hasAttachedFile: Boolean(fileUrl),
    expected: Boolean(fileUrl || sourceRows),
  };
}

export function describeSessionTelemetry(session, rows = [], error = null) {
  const expectation = sessionTelemetryExpectation(session);
  const loadedRows = Array.isArray(rows) ? rows.length : 0;
  if (loadedRows > 0) {
    return {
      status: "ready",
      source: "heart_rate_timeline",
      loadedRows,
      sampled: loadedRows >= SESSION_TIMELINE_SAMPLE_LIMIT || expectation.sourceRows > loadedRows,
      ...expectation,
      message: expectation.sourceRows > loadedRows
        ? `${loadedRows.toLocaleString()} evenly sampled review points loaded from ${expectation.sourceRows.toLocaleString()} saved readings.`
        : `${loadedRows.toLocaleString()} saved telemetry points loaded.`,
    };
  }

  if (error) {
    return {
      status: "error",
      source: "heart_rate_timeline",
      loadedRows: 0,
      sampled: false,
      ...expectation,
      message: expectation.hasAttachedFile
        ? "An HR CSV is attached, but its saved timeline could not be loaded. Analysis is blocked to prevent a false no-data report."
        : "Saved heart-rate telemetry could not be loaded.",
      error: error?.message || String(error),
    };
  }

  return {
    status: expectation.expected ? "unresolved" : "missing",
    source: "heart_rate_timeline",
    loadedRows: 0,
    sampled: false,
    ...expectation,
    message: expectation.expected
      ? "This session says HR data exists, but no saved timeline rows were returned. Analysis is blocked until that mismatch is repaired."
      : "No heart-rate telemetry is attached to this session.",
  };
}

export async function loadSessionTelemetry(sessionId, session, { timeoutMs = 20000 } = {}) {
  const rows = await base44.entities.HeartRateTimeline.filterFieldsSampled(
    { session: sessionId },
    SESSION_TIMELINE_FIELDS,
    "time_offset_s",
    SESSION_TIMELINE_SAMPLE_LIMIT,
    undefined,
    undefined,
    { timeoutMs },
  );
  return { rows, state: describeSessionTelemetry(session, rows) };
}
