export function mergeDatedChatFindings(savedNotes, date, findings) {
  const notes = String(savedNotes || "").trimEnd();
  const cleanFindings = String(findings || "").trim();
  if (!cleanFindings) return notes;

  const marker = `[AI Interview — ${date}]`;
  const replacement = `${marker}\n${cleanFindings}`;
  const markerIndex = notes.lastIndexOf(marker);
  if (markerIndex < 0) return `${notes}${notes ? "\n\n" : ""}${replacement}`;

  const followingSectionIndex = notes.indexOf("\n\n[", markerIndex + marker.length);
  const suffix = followingSectionIndex >= 0 ? notes.slice(followingSectionIndex) : "";
  return `${notes.slice(0, markerIndex).trimEnd()}${markerIndex > 0 ? "\n\n" : ""}${replacement}${suffix}`;
}
