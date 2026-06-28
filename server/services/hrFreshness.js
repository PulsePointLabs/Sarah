export const SHARED_HR_PACKET_STALE_MS = 30000;

export function parseHrTimestamp(value) {
  const numeric = Number(value);
  if (Number.isFinite(numeric) && numeric > 0) return numeric;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function isSharedHrPacketFresh(lastMessageAt, {
  now = Date.now(),
  staleMs = SHARED_HR_PACKET_STALE_MS,
} = {}) {
  const timestamp = parseHrTimestamp(lastMessageAt);
  if (!Number.isFinite(timestamp)) return false;
  const ageMs = now - timestamp;
  return ageMs >= -5000 && ageMs <= staleMs;
}
