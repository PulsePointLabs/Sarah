const BLOCKED_AUTOMATIC_EVENT_NOTES = new Set([
  "edging pattern candidate",
]);

export function shouldKeepLiveSessionEvent(event) {
  const source = String(event?.source || "").trim().toLowerCase();
  if (source !== "sarah_live_cue") return true;
  const note = String(event?.note || event?.label || "").trim().toLowerCase();
  return !BLOCKED_AUTOMATIC_EVENT_NOTES.has(note);
}
