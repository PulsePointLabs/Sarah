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
  return `PulsePoint_${output}_${sessionDate}_generated-${generated}.${extension}`;
}

export function buildProfileExportFilename({ outputType, extension, generatedAt = new Date() }) {
  const output = sanitizeFilenamePart(outputType) || "Profile";
  return `PulsePoint_${output}_generated-${datePart(generatedAt)}.${extension}`;
}

export function buildExportMetadataHeader({ type, session, generatedAt, evidenceStatus }) {
  return [
    "PulsePoint Export",
    `Type: ${type}`,
    session?.date ? `Session Date: ${datePart(session.date)}` : null,
    `Generated: ${datePart(generatedAt || new Date())}`,
    evidenceStatus ? `Motion Evidence: ${evidenceStatus}` : null,
    "Source: PulsePoint Standalone local export",
    "",
  ].filter((value) => value != null).join("\n");
}
