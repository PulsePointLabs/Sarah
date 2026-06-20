const CHECKPOINT_PREFIX = "sarah.ttsReadingCheckpoint.";

export function hashTtsContent(parts = []) {
  const text = Array.isArray(parts) ? parts.join("\n\n") : String(parts || "");
  let hash = 2166136261;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv1a-${(hash >>> 0).toString(16).padStart(8, "0")}-${text.length}`;
}

export function ttsCheckpointKey(sessionId, title = "") {
  const safe = String(sessionId || title || "global")
    .replace(/[^a-z0-9_-]+/gi, "_")
    .slice(0, 96);
  return `${CHECKPOINT_PREFIX}${safe || "global"}`;
}

export function buildTtsCheckpoint({
  route = "/",
  sessionId = null,
  title = "",
  contentHash,
  currentPara = -1,
  currentSentenceIdx = -1,
  currentWordIdx = -1,
  playbackTime = 0,
  state = "idle",
  scrollY = 0,
  voiceSettingsHash = "",
  reason = "checkpoint",
  timestamp = new Date().toISOString(),
} = {}) {
  return {
    version: 1,
    route,
    sessionId,
    title: String(title || "").slice(0, 160),
    contentHash,
    currentPara: Number.isFinite(Number(currentPara)) ? Number(currentPara) : -1,
    currentSentenceIdx: Number.isFinite(Number(currentSentenceIdx)) ? Number(currentSentenceIdx) : -1,
    currentWordIdx: Number.isFinite(Number(currentWordIdx)) ? Number(currentWordIdx) : -1,
    playbackTime: Number.isFinite(Number(playbackTime)) ? Number(playbackTime) : 0,
    state,
    scrollY: Number.isFinite(Number(scrollY)) ? Number(scrollY) : 0,
    voiceSettingsHash,
    reason,
    timestamp,
  };
}

export function isCheckpointCompatible(checkpoint, { contentHash, maxAgeMs = 1000 * 60 * 60 * 48 } = {}) {
  if (!checkpoint || checkpoint.version !== 1) return false;
  if (!contentHash || checkpoint.contentHash !== contentHash) return false;
  const ageMs = Date.now() - Date.parse(checkpoint.timestamp || 0);
  if (!Number.isFinite(ageMs) || ageMs < 0 || ageMs > maxAgeMs) return false;
  return checkpoint.currentPara >= 0;
}

export function saveTtsCheckpoint(key, checkpoint, storage = globalThis.localStorage) {
  if (!key || !storage?.setItem) return false;
  storage.setItem(key, JSON.stringify(checkpoint));
  return true;
}

export function loadTtsCheckpoint(key, storage = globalThis.localStorage) {
  if (!key || !storage?.getItem) return null;
  const raw = storage.getItem(key);
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}
