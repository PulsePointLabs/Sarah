// Host receipt times, not an undocumented device clock. Keep every timestamp and
// sample unchanged. One shared tolerance prevents playback from fragmenting data
// that live acquisition accepted. This does not assert that every packet arrived.
export const CIVET_GAP_S = 0.35;
export const CIVET_TIMING_POLICY = 'host-receipt-350ms-1';
export function civetTimingGap(previous, current) {
  if (!previous) return false;
  const dt = current.t - previous.t;
  return !Number.isFinite(dt) || dt < 0 || dt > CIVET_GAP_S + 1e-6 ||
    ['capture_id', 'connection_id'].some(key => previous[key] != null && current[key] != null && previous[key] !== current[key]);
}
export function civetTraceBreak(previous, current) {
  return !previous || !!current.gap || civetTimingGap(previous, current);
}
