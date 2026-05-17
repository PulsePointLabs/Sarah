/**
 * If n >= 100, converts a raw seconds value to "Xm Ys" display string.
 * Otherwise returns the original string unchanged.
 */
export function fmtSecondsInText(text) {
  if (!text) return text;
  // Match standalone numbers >= 100 followed by "seconds" or "second"
  return text.replace(/\b(\d{3,})\s*seconds?\b/gi, (_, n) => {
    const sec = Math.round(Number(n));
    if (sec < 100) return `${sec}s`;
    const m = Math.floor(sec / 60);
    const s = sec % 60;
    return s === 0 ? `${m}m` : `${m}m ${s}s`;
  });
}