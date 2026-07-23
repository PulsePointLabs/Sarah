const STORAGE_KEY = "sarah.ai-observation-corrections.v1";
const MAX_CORRECTIONS = 120;

function clean(value, maxLength = 700) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

export function readAiCorrectionMemory() {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) || "[]");
    return Array.isArray(parsed) ? parsed.filter((item) => item?.before && item?.after) : [];
  } catch {
    return [];
  }
}

export function rememberAiCorrection({ before, after, context = "", recordType = "session" } = {}) {
  const normalizedBefore = clean(before);
  const normalizedAfter = clean(after);
  if (!normalizedBefore || !normalizedAfter || normalizedBefore === normalizedAfter) return readAiCorrectionMemory();
  const next = [{
    id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    before: normalizedBefore,
    after: normalizedAfter,
    context: clean(context, 240),
    recordType: clean(recordType, 40) || "session",
    createdAt: new Date().toISOString(),
  }, ...readAiCorrectionMemory().filter((item) => (
    item.before.toLowerCase() !== normalizedBefore.toLowerCase()
      || item.after.toLowerCase() !== normalizedAfter.toLowerCase()
  ))].slice(0, MAX_CORRECTIONS);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  return next;
}

export function buildAiCorrectionMemoryPrompt({ recordType = "session", limit = 12 } = {}) {
  const corrections = readAiCorrectionMemory()
    .filter((item) => item.recordType === recordType || item.recordType === "all")
    .slice(0, limit);
  if (!corrections.length) return "";
  return [
    "USER CORRECTION MEMORY:",
    "These are prior user edits to Sarah's draft observations. Treat the corrected wording as higher-priority calibration when the same visual ambiguity recurs. Do not blindly copy it when current frames differ.",
    ...corrections.map((item, index) => `${index + 1}. Avoid: "${item.before}" Corrected to: "${item.after}"${item.context ? ` Context: ${item.context}` : ""}`),
  ].join("\n");
}
