function datePart(value) {
  const date = value ? new Date(value) : new Date();
  if (Number.isNaN(date.getTime())) return "unknown-date";
  return date.toISOString().slice(0, 10);
}

export function sanitizeFilenamePart(value) {
  return String(value || "")
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "")
    .slice(0, 60);
}

export function buildSessionExportFilename({ session, outputType, extension, generatedAt = new Date() }) {
  const sessionDate = datePart(session?.date);
  const output = sanitizeFilenamePart(outputType) || "Export";
  const generated = datePart(generatedAt);
  return `Sarah_${output}_${sessionDate}_generated-${generated}.${extension}`;
}

export function buildProfileExportFilename({ outputType, extension, generatedAt = new Date() }) {
  const output = sanitizeFilenamePart(outputType) || "Profile";
  return `Sarah_${output}_generated-${datePart(generatedAt)}.${extension}`;
}

function audioTitleParts(value) {
  const raw = String(value || "Audio Narration").trim();
  const datedTitle = raw.match(/^([A-Za-z]+ \d{1,2},? \d{4})\s*[-\u2013\u2014]\s*(.+)$/);
  const title = (datedTitle?.[2] || raw)
    .replace(/^AI\s+/i, "")
    .replace(/\s+and\s+/gi, " ")
    .replace(/\s*&\s*/g, " ");

  return {
    title: sanitizeFilenamePart(title) || "Audio-Narration",
    embeddedDate: datedTitle?.[1] || null,
  };
}

export function buildAudioExportFilename({ title, sessionDate, extension = "mp3" }) {
  const parts = audioTitleParts(title);
  const recordedDate = datePart(sessionDate || parts.embeddedDate || new Date());
  return `${parts.title}_${recordedDate}.${extension}`;
}

export function buildExportMetadataHeader({ type, session, generatedAt, evidenceStatus }) {
  return [
    "Sarah Export",
    `Type: ${type}`,
    session?.date ? `Session Date: ${datePart(session.date)}` : null,
    `Generated: ${datePart(generatedAt || new Date())}`,
    evidenceStatus ? `Motion Evidence: ${evidenceStatus}` : null,
    "Source: Sarah local export",
    "",
  ].filter((value) => value != null).join("\n");
}
