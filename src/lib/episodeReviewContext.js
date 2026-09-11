const value = (v) => v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
const median = (a) => { const sorted = a.filter((v) => v != null).sort((x, y) => x - y); return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null; };
export function episodeReviewContext(episode, rows, points, padding = 30) {
  const start = episode.start_s;
  const end = episode.end_s ?? start;
  const domain = [Math.max(0, start - padding), end + padding];
  const samples = rows.filter((r) => r.time_offset_s >= domain[0] && r.time_offset_s <= domain[1]).map((r) => ({
    t: Number(r.time_offset_s), hr: value(r.hr), smoothed: value(r.hr_smoothed), baseline: value(r.baseline_hr),
    rmssd: value(r.hrv_rmssd_ms), sdnn: value(r.hrv_sdnn_ms),
  })).sort((a, b) => a.t - b.t);
  const phases = points.filter((p) => p.t >= domain[0] && p.t <= domain[1]);
  const summarize = (items) => ({ hr: median(items.map((r) => r.hr)), rmssd: median(items.map((r) => r.rmssd)), count: items.length });
  return { domain, start, end, samples, phases,
    before: summarize(samples.filter((r) => r.t < start)), during: summarize(samples.filter((r) => r.t >= start && r.t <= end)),
    after: summarize(samples.filter((r) => r.t > end)) };
}
export function slimSeriesPath(rows, key, x, y, maxGap = 5) {
  let last = null;
  return rows.map((r) => {
    if (r[key] == null || !Number.isFinite(r[key])) { last = null; return ""; }
    const move = !last || r.t - last.t > maxGap;
    last = r;
    return `${move ? "M" : "L"}${x(r.t).toFixed(2)},${y(r[key]).toFixed(2)}`;
  }).join(" ");
}
export const episodeClock = (t) => {
  const ticks = Math.max(0, Math.round(t * 10));
  return `${Math.floor(ticks / 600)}:${((ticks % 600) / 10).toFixed(1).padStart(4, "0")}`;
};
export const episodeDuration = (seconds) => {
  const ticks = Math.max(0, Math.round(seconds * 10));
  const minutes = Math.floor(ticks / 600);
  const rest = (ticks % 600) / 10;
  return `${minutes ? `${minutes}m ` : ""}${Number.isInteger(rest) ? rest : rest.toFixed(1)}s`;
};
