import { buildPhaseEvidence } from "./videoSyncPhaseEvidence.js";
const number = (v) => v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
const median = (values) => { const a = values.sort((a, b) => a - b); return a.length ? a[Math.floor(a.length / 2)] : null; };

export function summarizeSubjectiveEpisode(start, end, rows, session) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) throw new Error("Episode end must be after its start. Seek forward, then press N again.");
  const inside = rows.filter((r) => Number(r.time_offset_s) >= start && Number(r.time_offset_s) <= end);
  const hr = inside.map((r) => number(r.hr)).filter((n) => n > 0);
  const hrv = inside.filter((r) => ["moderate", "high"].includes(r.hrv_quality)).map((r) => number(r.hrv_rmssd_ms)).filter((n) => n > 0);
  const model = buildPhaseEvidence(rows);
  const points = model.points.filter((p) => p.t >= start && p.t <= end && p.approach != null);
  const logged = number(session.climax_offset_s);
  const candidates = model.moments.filter((m) => m.kind === "approach").map((m) => ({ time_s: m.t, kind: "Physiology candidate" }));
  const targets = logged != null ? [{ time_s: logged, kind: "Logged climax" }] : candidates;
  const distance = (t) => t < start ? t - start : t > end ? t - end : 0;
  const target = targets.sort((a, b) => Math.abs(distance(a.time_s)) - Math.abs(distance(b.time_s)))[0];
  return {
    duration_s: end - start,
    telemetry: { sample_count: inside.length, hr_sample_count: hr.length, hr_start: hr[0] ?? null, hr_end: hr.at(-1) ?? null,
      hr_min: hr.length ? Math.min(...hr) : null, hr_max: hr.length ? Math.max(...hr) : null,
      hr_mean: hr.length ? Math.round(hr.reduce((a, b) => a + b, 0) / hr.length) : null,
      rmssd_median_ms: median(hrv), usable_hrv_samples: hrv.length,
      approach_peak: points.length ? Math.max(...points.map((p) => p.approach)) : null },
    proximity: target ? { ...target, relative_to_episode_s: distance(target.time_s) } : null,
  };
}

export function toggleSubjectiveEpisode(episodes, time, source, thumbnail, rows, session, id, kind = "near_climax") {
  const open = episodes.find((e) => e.end_s == null && (e.kind || "near_climax") === kind);
  if (open) return episodes.map((e) => e.id === open.id ? { ...e, end_s: time,
    ...summarizeSubjectiveEpisode(e.start_s, time, rows, session), completed_at: new Date().toISOString() } : e);
  return [...episodes, { id, kind, start_s: time, end_s: null, source, thumbnail_url: thumbnail,
    evidence_status: "user_reported", created_at: new Date().toISOString() }].sort((a, b) => a.start_s - b.start_s);
}

export function totalEpisodeSeconds(episodes, kind) {
  const ranges = episodes.filter((e) => (e.kind || "near_climax") === kind && e.end_s > e.start_s).sort((a, b) => a.start_s - b.start_s);
  let total = 0, until = -Infinity;
  for (const e of ranges) { total += Math.max(0, e.end_s - Math.max(until, e.start_s)); until = Math.max(until, e.end_s); }
  return total;
}

export function subjectiveProximity(episode, episodes, fallback) {
  const climaxes = episodes.filter((e) => e.kind === "climax");
  if (!climaxes.length) return fallback;
  const end = episode.end_s ?? episode.start_s;
  const targets = climaxes.map((e) => ({ kind: "User-marked climax", time_s: e.start_s,
    relative_to_episode_s: e.start_s < episode.start_s ? e.start_s - episode.start_s : e.start_s > end ? e.start_s - end : 0 }));
  return targets.sort((a, b) => Math.abs(a.relative_to_episode_s) - Math.abs(b.relative_to_episode_s))[0];
}
