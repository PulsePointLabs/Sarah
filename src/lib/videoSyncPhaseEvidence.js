// Playback-only, causal review heuristic. Scores are evidence strength, not
// calibrated probabilities or confirmation of orgasm. No capture/control writes.
export const PHASE_SAMPLE_MAX_AGE_S = 5;
const finite = (v) => v == null || v === "" || !Number.isFinite(Number(v)) ? null : Number(v);
const clamp = (v, max = 100) => Math.max(0, Math.min(max, v));
const median = (values) => {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : null;
};
export const PHASE_LABELS = {
  unavailable: "Insufficient evidence", warming: "Gathering evidence",
  baseline: "Baseline / low build", build: "Building", plateau: "Elevated plateau",
  approach: "Climax approach candidate", recovery: "Release / recovery candidate",
};
export const PHASE_COLORS = { unavailable: "#64748b", warming: "#64748b", baseline: "#22c55e", build: "#eab308",
  plateau: "#f97316", approach: "#ef4444", recovery: "#38bdf8" };

// Use the card's persisted-in-time classification, without backdating transitions
// or filling missing telemetry. Offsets translate a trimmed view only.
export function phaseBandsFromPoints(points, offset = 0) {
  const bands = [];
  for (let i = 0; i < points.length - 1; i += 1) {
    const point = points[i];
    if (!["baseline", "build", "plateau", "approach", "recovery"].includes(point.phase)) continue;
    const start = point.t - offset;
    const end = Math.min(points[i + 1].t, point.t + PHASE_SAMPLE_MAX_AGE_S) - offset;
    if (end <= start) continue;
    const last = bands.at(-1);
    if (last?.phase === point.phase && last.end === start) last.end = end;
    else bands.push({ start, end, phase: point.phase, color: PHASE_COLORS[point.phase], label: PHASE_LABELS[point.phase] });
  }
  return bands;
}

export function clipPhaseBands(bands, start, end) {
  return bands.filter((b) => b.end > start && b.start < end)
    .map((b) => ({ ...b, start: Math.max(start, b.start), end: Math.min(end, b.end) }));
}

export function buildPhaseEvidence(rows = []) {
  const sorted = rows.map((r) => ({ ...r, t: finite(r.time_offset_s) }))
    .filter((r) => r.t != null && r.t >= 0).sort((a, b) => a.t - b.t);
  const points = [], moments = [];
  let history = [], smooth = null, previousT = null, buildStart = null;
  let phase = "warming", pendingPhase = null, pendingSince = 0, lastMoment = -Infinity;
  let approachPeak = null;
  for (const r of sorted) {
    // Duplicate packets at one timestamp must not count as additional duration.
    if (r.t === previousT) continue;
    const gap = previousT != null && r.t - previousT > PHASE_SAMPLE_MAX_AGE_S;
    if (gap) points.push({ t: previousT + PHASE_SAMPLE_MAX_AGE_S, approach: null, recovery: null, plateau: null });
    const hr = finite(r.hr), baseline = finite(r.baseline_hr);
    const valid = hr > 0 && baseline > 0;
    if (gap || !valid) {
      history = []; smooth = null; buildStart = null; phase = "warming";
      pendingPhase = null; approachPeak = null;
    }
    const dt = previousT == null ? 0 : r.t - previousT;
    previousT = r.t;
    if (!valid) {
      points.push({ t: r.t, phase: "unavailable", approach: null, recovery: null, plateau: null,
        reason: hr > 0 ? "No saved HR baseline at this moment." : "No saved heart-rate sample at this moment." });
      continue;
    }
    // Use raw HR with trailing smoothing, never a potentially centered imported curve.
    smooth = smooth == null ? hr : smooth + (hr - smooth) * (1 - Math.exp(-dt / 3));
    history = history.filter((p) => r.t - p.t <= 120);
    const rmssd = finite(r.hrv_rmssd_ms);
    const hrvUsable = rmssd > 0 && ["moderate", "high"].includes(String(r.hrv_quality).toLowerCase());
    const reference = median(history.filter((p) => r.t - p.t >= 20 && p.hrvUsable).map((p) => p.rmssd));
    const compression = hrvUsable && reference > 0 ? clamp((1 - rmssd / reference) / 0.4, 1) : null;
    const opening = hrvUsable && reference > 0 ? clamp((rmssd / reference - 1) / 0.5, 1) : null;
    const recent = history.filter((p) => r.t - p.t <= 15);
    const first = recent[0];
    const slope = first ? (smooth - first.smooth) * 30 / (r.t - first.t) : 0;
    const delta = smooth - baseline;
    if (delta >= 8) buildStart ??= r.t;
    else if (delta < 5) buildStart = null;
    const dwell = buildStart == null ? 0 : r.t - buildStart;
    const peak = Math.max(smooth, ...history.filter((p) => r.t - p.t <= 60).map((p) => p.smooth));
    const drop = peak - smooth;
    const priorLoad = history.some((p) => p.delta >= 8);
    const warming = !history.length || r.t - history[0].t < 10;
    const contributions = {
      elevation: clamp(delta / 25, 1) * 45,
      rise: clamp(slope / 12, 1) * 20,
      dwell: clamp(dwell / 60, 1) * 10,
      hrv: (compression ?? 0) * 25,
    };
    const recovery = priorLoad && drop >= 5
      ? Math.round(clamp(drop / 15, 1) * 60 + clamp(-slope / 10, 1) * 25 + (opening ?? 0) * 15) : 0;
    const approach = Math.round(clamp(Object.values(contributions).reduce((a, b) => a + b, 0)
      - clamp(drop / 15, 1) * 30, compression == null ? 60 : 100));
    const plateau = Math.round(clamp(delta / 15, 1) * clamp(dwell / 30, 1)
      * clamp(1 - Math.abs(slope) / 6, 1) * 100);
    const wanted = warming ? "warming" : recovery >= 45 ? "recovery"
      : approach >= 70 ? "approach" : plateau >= 60 ? "plateau" : delta >= 5 || slope >= 3 ? "build" : "baseline";
    // Three seconds of persistence makes the peripheral color readable, while
    // the underlying metrics still update at every recorded sample.
    if (wanted !== pendingPhase) { pendingPhase = wanted; pendingSince = r.t; }
    if (wanted === "warming" || r.t - pendingSince >= 3) {
      if (phase !== wanted && ["build", "plateau", "approach", "recovery"].includes(wanted)) {
        moments.push({ t: pendingSince, detectedAt: r.t, label: PHASE_LABELS[wanted], kind: wanted });
      }
      phase = wanted;
    }
    const point = { t: r.t, hr, baseline, smooth, delta, slope, rmssd, hrvUsable, reference,
      compression, opening, dwell, drop, contributions, phase,
      approach: warming ? null : approach, recovery: warming ? null : recovery, plateau: warming ? null : plateau };
    if (!warming) {
      if (!approachPeak || approach >= approachPeak.approach) approachPeak = point;
      if (approachPeak.approach >= 35 && approachPeak.approach - approach >= 10 && r.t - lastMoment >= 15) {
        moments.push({ t: approachPeak.t, detectedAt: r.t, label: "Approach crest", kind: "crest" });
        lastMoment = r.t; approachPeak = point;
      }
    }
    history.push(point); points.push(point);
  }
  return { points, moments: moments.sort((a, b) => a.t - b.t) };
}

export function phaseEvidenceAt(points, time) {
  let lo = 0, hi = points.length;
  while (lo < hi) { const mid = (lo + hi) >>> 1; if (points[mid].t <= time) lo = mid + 1; else hi = mid; }
  const point = points[lo - 1];
  if (!point || time - point.t > PHASE_SAMPLE_MAX_AGE_S || !point.phase) return {
    phase: "unavailable", approach: null, recovery: null, plateau: null,
    reason: "No recent telemetry at this playhead. Scores resume when samples return.",
  };
  return { ...point, age: time - point.t };
}

export function savedPhaseMarkers(session = {}) {
  return [["pre_climax_offset_s", "Logged pre-climax"], ["climax_offset_s", "Logged climax"],
    ["recovery_offset_s", "Logged recovery"]].map(([key, label]) => ({ t: finite(session[key]), label }))
    .filter((m) => m.t != null && m.t >= 0).sort((a, b) => a.t - b.t);
}
