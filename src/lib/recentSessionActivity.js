const RECENT_ACTIVITY_FIELDS = [
  "id",
  "date",
  "start_time",
  "duration_minutes",
  "title",
  "exploration_type",
  "methods",
  "foley_size",
  "foley_type",
  "notes",
  "event_timeline",
];

export const RECENT_SESSION_ACTIVITY_FIELDS = Object.freeze(RECENT_ACTIVITY_FIELDS);

function cleanText(value = "", maxChars = 520) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text || text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars - 1)).trimEnd()}…`;
}

function activityTimestamp(record = {}) {
  const date = String(record.date || record.created_date || "").slice(0, 10);
  const start = String(record.start_time || "").trim();
  const parsed = new Date(`${date || "1970-01-01"}T${start || "00:00"}:00`).getTime();
  return Number.isFinite(parsed) ? parsed : 0;
}

function relevantEvents(record = {}) {
  const events = Array.isArray(record.event_timeline) ? record.event_timeline : [];
  const normalized = events
    .map((event) => ({
      text: cleanText(event?.note || event?.description || event?.label, 240),
      source: String(event?.source || ""),
    }))
    .filter((event) => event.text);
  const deviceSpecific = normalized.filter((event) => (
    /\b(?:catheter|foley|urethr|insert|sound|dilat|probe|enema)\b/i.test(event.text)
  ));
  const manual = normalized.filter((event) => !/^ai/i.test(event.source));
  return [...new Set([...deviceSpecific, ...manual, ...normalized].map((event) => event.text))].slice(0, 5);
}

function activityRecord(record = {}, type = "session") {
  const date = String(record.date || record.created_date || "").slice(0, 10) || "date unavailable";
  const time = String(record.start_time || "").trim();
  const isExploration = type === "body_exploration";
  const heading = isExploration
    ? cleanText(record.title || record.exploration_type || "Body exploration", 120)
    : "Session";
  const methods = (Array.isArray(record.methods) ? record.methods : [])
    .map((method) => cleanText(method, 80))
    .filter(Boolean)
    .slice(0, 8);
  const foley = record.foley_size
    ? `${cleanText(record.foley_size, 20)} French${record.foley_type ? ` ${cleanText(record.foley_type, 80)}` : ""} Foley catheter`
    : "";
  const notes = cleanText(record.notes, 620);
  const events = relevantEvents(record);

  return {
    timestamp: activityTimestamp(record),
    lines: [
      `[${date}${time ? ` ${time}` : ""}] ${isExploration ? "BODY EXPLORATION" : "SESSION"}: ${heading}`,
      methods.length ? `Methods: ${methods.join(", ")}` : null,
      foley ? `Recorded catheter: ${foley}` : null,
      notes ? `Saved notes: ${notes}` : null,
      events.length ? `Saved timeline activity: ${events.join(" | ")}` : null,
    ].filter(Boolean),
  };
}

export function buildRecentSessionActivityContext(sessions = [], explorations = [], options = {}) {
  const limit = Math.max(1, Math.min(12, Number(options.limit) || 8));
  const records = [
    ...(Array.isArray(sessions) ? sessions : []).map((record) => activityRecord(record, "session")),
    ...(Array.isArray(explorations) ? explorations : []).map((record) => activityRecord(record, "body_exploration")),
  ]
    .sort((a, b) => b.timestamp - a.timestamp)
    .slice(0, limit);

  if (!records.length) return "RECENT SAVED SESSION ACTIVITY: none available.";
  return [
    "RECENT SAVED SESSION ACTIVITY - DATED FACTS SARAH MAY REFERENCE:",
    "Use these records for continuity across Chat with Sarah. Treat saved notes and timeline entries as prior-session facts, not as proof of the user's current physical state. If the current status may have changed, ask rather than assume.",
    ...records.flatMap((record) => [...record.lines, ""]),
  ].join("\n").trim();
}
