import { base44 } from "@/api/base44Client";

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

function normalizeCorrection(item = {}) {
  const before = clean(item.before);
  const after = clean(item.after);
  if (!before || !after || before === after) return null;
  return {
    id: clean(item.id, 100) || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    before,
    after,
    context: clean(item.context, 240),
    recordType: clean(item.recordType || item.record_type, 40) || "session",
    createdAt: item.createdAt || item.created_at || item.created_date || new Date().toISOString(),
  };
}

function correctionIdentity(item = {}) {
  return [
    clean(item.recordType || item.record_type, 40).toLowerCase(),
    clean(item.before).toLowerCase(),
    clean(item.after).toLowerCase(),
  ].join("|");
}

export function mergeAiCorrectionMemory(...collections) {
  const seen = new Set();
  const merged = collections
    .flat()
    .map(normalizeCorrection)
    .filter(Boolean)
    .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
    .filter((item) => {
      const identity = correctionIdentity(item);
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    })
    .slice(0, MAX_CORRECTIONS);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  return merged;
}

export function rememberAiCorrection({ before, after, context = "", recordType = "session" } = {}) {
  const correction = normalizeCorrection({ before, after, context, recordType });
  if (!correction) return readAiCorrectionMemory();
  const next = mergeAiCorrectionMemory([correction], readAiCorrectionMemory());
  base44.entities.AICorrectionMemory.create(correction).catch(() => {});
  return next;
}

export async function syncAiCorrectionMemory({ recordType = "session" } = {}) {
  try {
    const remote = await base44.entities.AICorrectionMemory.filter(
      { recordType: [recordType, "all"] },
      "-createdAt",
      MAX_CORRECTIONS,
    );
    const local = readAiCorrectionMemory()
      .filter((item) => item.recordType === recordType || item.recordType === "all");
    const remoteIdentities = new Set(remote.map(correctionIdentity));
    const pending = local.filter((item) => !remoteIdentities.has(correctionIdentity(item)));
    if (pending.length) {
      await Promise.allSettled(pending.map((item) => base44.entities.AICorrectionMemory.create(item)));
    }
    return mergeAiCorrectionMemory(remote, local, readAiCorrectionMemory());
  } catch {
    return readAiCorrectionMemory();
  }
}

export function buildAiCorrectionMemoryPrompt({ recordType = "session", limit = 12, corrections: provided } = {}) {
  const corrections = (Array.isArray(provided) ? provided : readAiCorrectionMemory())
    .filter((item) => item.recordType === recordType || item.recordType === "all")
    .slice(0, limit);
  if (!corrections.length) return "";
  return [
    "USER CORRECTION MEMORY:",
    "These are prior user edits to Sarah's draft observations. Treat the corrected wording as higher-priority calibration when the same visual ambiguity recurs. Do not blindly copy it when current frames differ.",
    ...corrections.map((item, index) => `${index + 1}. Avoid: "${item.before}" Corrected to: "${item.after}"${item.context ? ` Context: ${item.context}` : ""}`),
  ].join("\n");
}
