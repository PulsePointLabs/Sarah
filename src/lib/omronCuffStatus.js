// Bluetooth readiness, delivery, and session membership are separate facts.
export function summarizeOmronConnection(state = {}) {
  if (state.deliveryError && (state.pendingReadings?.length || state.pendingReading)) {
    return "Reading saved on phone. Saving to Sarah failed; retrying automatically.";
  }
  if (!state.listening) return "Cuff disconnected.";
  if (state.connected) return "Cuff connected. Ready for a reading.";
  if (state.state === "connecting" || state.state === "connected") return "Connecting to cuff…";
  return "Waiting for cuff. It will reconnect automatically when awake.";
}

export function cuffReceiptSince(reading, openedAt) {
  const receivedAt = Date.parse(reading?.received_at || reading?.raw?.received_at || "");
  return Number.isFinite(receivedAt) && receivedAt >= openedAt ? reading : null;
}
