// Bluetooth readiness, delivery, and session membership are separate facts.
export function summarizeOmronConnection(state = {}) {
  if (!state.listening) return "Cuff disconnected.";
  const connection = state.connected ? "Cuff connected. Ready for a reading."
    : state.state === "connecting" || state.state === "connected" ? "Connecting to cuff…"
      : "Waiting for cuff to wake — not connected yet.";
  const pending = state.pendingReadings?.length || Boolean(state.pendingReading);
  const delivery = pending ? state.deliveryError
    ? " Reading received; server save failed. Retrying automatically."
    : " Reading received; saving to Sarah…" : "";
  const held = state.heldReadings?.length ? " Older reading preserved; its date needs recovery." : "";
  return connection + delivery + held;
}

export function cuffReceiptSince(reading, openedAt) {
  const receivedAt = Date.parse(reading?.received_at || reading?.raw?.received_at || "");
  return Number.isFinite(receivedAt) && receivedAt >= openedAt ? reading : null;
}
