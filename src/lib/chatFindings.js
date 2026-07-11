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

function normalizeMessageText(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function parseSavedChatSections(savedNotes) {
  const source = String(savedNotes || "");
  if (!source.trim()) return [];
  const pattern = /\[(AI Interview|Sarah Image Review|Sarah Video Review)\s*[—-]\s*([^\]]+)\]\s*([\s\S]*?)(?=\n\s*\[(?:AI Interview|Sarah Image Review|Sarah Video Review)\s*[—-]|\s*$)/g;
  const matches = [...source.matchAll(pattern)];
  return matches
    .map((match, index) => {
      const kind = String(match[1] || "").trim();
      const date = String(match[2] || "").trim();
      const body = String(match[3] || "").trim();
      if (!body) return null;
      const intro = kind === "AI Interview"
        ? `Saved Ask Sarah findings from ${date}:`
        : `${kind} saved ${date}:`;
      return {
        id: `saved-session-chat-${date}-${index}`,
        role: "assistant",
        text: `${intro}\n${body}`,
        createdAt: /^\d{4}-\d{2}-\d{2}$/.test(date) ? `${date}T12:00:00.000Z` : null,
        importedFromNotes: true,
      };
    })
    .filter(Boolean);
}

export function hydrateSessionChatMessages(savedMessages, savedNotes) {
  const primaryMessages = Array.isArray(savedMessages) ? savedMessages.filter(Boolean) : [];
  const importedMessages = parseSavedChatSections(savedNotes);
  if (!importedMessages.length) return primaryMessages;
  if (!primaryMessages.length) return importedMessages;

  const seen = new Set(primaryMessages.map((message) => normalizeMessageText(message?.text)));
  const backfills = importedMessages.filter((message) => {
    const key = normalizeMessageText(message.text);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  return backfills.length ? [...backfills, ...primaryMessages] : primaryMessages;
}
