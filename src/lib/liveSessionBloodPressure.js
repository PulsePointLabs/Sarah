function usableBloodPressure(reading) {
  if (!reading || typeof reading !== "object") return null;
  const systolic = Number(reading.systolic_mm_hg);
  const diastolic = Number(reading.diastolic_mm_hg);
  return Number.isFinite(systolic) && Number.isFinite(diastolic) ? reading : null;
}

export function selectLiveSessionBloodPressure({ activeSessionId, activeSessionDoc, captureState } = {}) {
  const sessionId = String(activeSessionId || "").trim();
  if (!sessionId) return null;

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
