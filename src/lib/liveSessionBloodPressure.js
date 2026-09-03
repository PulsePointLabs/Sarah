function usableBloodPressure(reading) {
  if (!reading || typeof reading !== "object") return null;
  const systolic = Number(reading.systolic_mm_hg);
  const diastolic = Number(reading.diastolic_mm_hg);
  return Number.isFinite(systolic) && Number.isFinite(diastolic) ? reading : null;
}

export function selectLiveSessionBloodPressure({ activeSessionId, activeSessionDoc, captureState } = {}) {
  const sessionId = String(activeSessionId || "").trim();
  // While Live Capture is armed and waiting for OBS there is deliberately no
  // session record yet. A reading captured by this live page is still current
  // and should be visible in the telemetry display instead of being hidden
  // behind the not-yet-created session id.
  if (!sessionId) return usableBloodPressure(captureState?.lastReading);

  if (String(captureState?.sessionId || "").trim() === sessionId) {
    const captured = usableBloodPressure(captureState?.lastReading);
    if (captured) return captured;
  }

  if (String(activeSessionDoc?.id || "").trim() !== sessionId) return null;
  return usableBloodPressure(activeSessionDoc?.latest_blood_pressure_reading)
    || usableBloodPressure(activeSessionDoc?.session_context?.blood_pressure)
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
