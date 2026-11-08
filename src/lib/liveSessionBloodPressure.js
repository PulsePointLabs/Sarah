function usableBloodPressure(reading) {
  if (!reading || typeof reading !== "object") return null;
  const systolic = Number(reading.systolic_mm_hg);
  const diastolic = Number(reading.diastolic_mm_hg);
  return systolic > 0 && diastolic > 0 ? reading : null;
}

export function bloodPressureKey(reading) {
  return reading?.external_id || reading?.id
    || [reading?.measured_at || reading?.received_at, reading?.systolic_mm_hg, reading?.diastolic_mm_hg, reading?.pulse_bpm].join("|");
}

const hourMs = 3600000;

export function correctOmronFutureDstReading(reading, timeZone = "America/New_York") {
  const raw = reading?.raw || {};
  if ((reading?.timestamp_source || raw.timestamp_source) !== "cuff_clock"
      || !/omron/i.test(reading.source_app || "")
      || !/^omron-/i.test(reading.external_id || "")) return reading;
  const measured = Date.parse(reading.measured_at);
  const received = Date.parse(reading.received_at || raw.received_at);
  const corrected = measured - hourMs;
  // A stored record cannot have been measured in the future. Only consider
  // packets whose corrected cuff time is within 30 seconds before receipt.
  if (!(received >= corrected && received - corrected <= 30000)) return reading;

  const formatter = new Intl.DateTimeFormat("en-US", { timeZone, timeZoneName: "longOffset" });
  const offset = at => formatter.formatToParts(at).find(part => part.type === "timeZoneName")?.value;
  const after = offset(received);
  const before = offset(received - 30 * 24 * hourMs);
  const minutes = text => {
    const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(text || "");
    return match ? (Number(match[2]) * 60 + Number(match[3])) * (match[1] === "-" ? -1 : 1) : 0;
  };
  if (minutes(before) - minutes(after) !== 60) return reading;
  const note = "Cuff clock was one hour ahead after daylight saving ended. Original cuff timestamp retained.";
  return {
    ...reading,
    measured_at: new Date(corrected).toISOString(),
    timestamp_source: "cuff_clock_corrected",
    timestamp_note: note,
    raw: {
      ...raw,
      cuff_measured_at: raw.cuff_measured_at || reading.measured_at,
      clock_offset_ms: hourMs,
      clock_correction: "dst_fallback_future_cuff_time",
      timestamp_source: "cuff_clock_corrected",
      timestamp_note: note,
    },
  };
}

export function selectTelemetryBloodPressure({ receipt, stored, sessionReading, openedAt = 0 } = {}) {
  if (!usableBloodPressure(receipt) && !usableBloodPressure(stored) && !usableBloodPressure(sessionReading)) return null;
  const sameAsStored = receipt && [stored, sessionReading].some((reading) => reading && bloodPressureKey(reading) === bloodPressureKey(receipt));
  const receivedAt = Date.parse(receipt?.received_at || "");
  const storedAt = Date.parse(stored?.received_at || stored?.measured_at || "");
  if (usableBloodPressure(receipt) && !sameAsStored && receivedAt >= openedAt
      && (!Number.isFinite(storedAt) || receivedAt >= storedAt)) {
    const source = receipt.timestamp_source || receipt.raw?.timestamp_source;
    return { reading: receipt, state: Number.isFinite(Date.parse(receipt.measured_at)) && source !== "received_at" ? "pending" : "clock_unknown" };
  }
  if (usableBloodPressure(sessionReading)
      && (!usableBloodPressure(stored) || !(Date.parse(stored.measured_at) > Date.parse(sessionReading.measured_at)))) {
    return { reading: sessionReading, state: "session" };
  }
  return usableBloodPressure(stored) ? { reading: stored, state: "history" } : null;
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
