function usableBloodPressure(reading) {
  if (!reading || typeof reading !== "object") return null;
  const systolic = Number(reading.systolic_mm_hg);
  const diastolic = Number(reading.diastolic_mm_hg);
  return Number.isFinite(systolic) && Number.isFinite(diastolic) ? reading : null;
}

export function bloodPressureFallsInSession(reading, { startMs, endMs, sessionId, pauses = [] } = {}) {
  const measured = Date.parse(reading?.measured_at || '');
  // A reception timestamp cannot establish when a stored cuff measurement happened.
  if ((reading?.timestamp_source || reading?.raw?.timestamp_source) === 'received_at') return false;
  if (reading?.session && sessionId && reading.session !== sessionId) return false;
  if (!Number.isFinite(measured) || !(startMs > 0) || !Number.isFinite(endMs)) return false;
  if (measured < startMs || measured > endMs) return false;
  return !pauses.some(p => {
    const start = Date.parse(p.started_at || p.paused_at || p.start || p.pausedAt || '');
    const end = Date.parse(p.ended_at || p.resumed_at || p.end || p.resumedAt || '') || endMs;
    return Number.isFinite(start) && measured >= start && measured < end;
  });
}

export function selectLiveSessionBloodPressure({ activeSessionId, activeSessionDoc, captureState, window } = {}) {
  const sessionId = String(activeSessionId || "").trim();
  if (!sessionId) return null;
  const usable = reading => usableBloodPressure(reading) && (!window || bloodPressureFallsInSession(reading, {...window, sessionId})) ? reading : null;

  if (String(captureState?.sessionId || "").trim() === sessionId) {
    const captured = usable(captureState?.lastReading);
    if (captured) return captured;
  }

  if (String(activeSessionDoc?.id || "").trim() !== sessionId) return null;
  return usable(activeSessionDoc?.latest_blood_pressure_reading)
    || usable(activeSessionDoc?.session_context?.blood_pressure)
    || null;
}

export function resetBloodPressureCaptureForSession(previous = {}, activeSessionId = null) {
  const sessionId = String(activeSessionId || "").trim() || null;
  return {
    ...previous,
    sessionId,
    lastReading: null,
    lastCapturedAt: null,
    capturedCount: 0,
    status: previous.syncing ? "syncing" : "idle",
    error: "",
    message: sessionId
      ? "No blood pressure has been captured during this session yet."
      : "Blood pressure sync is waiting for a live session.",
  };
}
