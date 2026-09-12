import { buildPhaseEvidence, PHASE_COLORS, phaseBandsFromPoints } from './videoSyncPhaseEvidence.js';

export const LOAD_LABELS = {
  unavailable: 'Insufficient evidence', warming: 'Gathering evidence',
  baseline: 'Low physiological load', build: 'Rising physiological load',
  plateau: 'Sustained physiological load', approach: 'High physiological load', recovery: 'Recovering / settling',
};

// Saved timeline packets can interleave complete and partial records. Carry only
// already-observed fields for at most five seconds; never borrow future packets.
export function normalizeLoadRows(rows) {
  const positive = (v) => v != null && v !== '' && Number.isFinite(Number(v)) && Number(v) > 0;
  const sorted = rows.filter(r => r.time_offset_s != null && r.time_offset_s !== '' && Number.isFinite(Number(r.time_offset_s)))
    .map(r => ({ ...r, time_offset_s: Number(r.time_offset_s) })).sort((a,b) => a.time_offset_s-b.time_offset_s);
  const recent = {};
  const result = [];
  for (const row of sorted) {
    const t = row.time_offset_s;
    const next = { ...row };
    for (const key of ['hr', 'baseline_hr']) {
      if (positive(row[key])) recent[key] = { t, value: Number(row[key]) };
      if (recent[key] && t - recent[key].t <= 5) next[key] = recent[key].value;
    }
    if (positive(row.hrv_rmssd_ms) && ['high', 'moderate'].includes(String(row.hrv_quality).toLowerCase())) {
      recent.hrv = { t, value: Number(row.hrv_rmssd_ms), quality: String(row.hrv_quality).toLowerCase() };
    }
    if (recent.hrv && t - recent.hrv.t <= 5) {
      next.hrv_rmssd_ms = recent.hrv.value;
      next.hrv_quality = recent.hrv.quality;
    }
    // Merge simultaneous records before the feature builder's duplicate guard.
    if (result.at(-1)?.time_offset_s === t) result[result.length - 1] = next;
    else result.push(next);
  }
  return result;
}

// Reuse causal cardiac features, not the approach score or its classifications.
// This is relative cardiac demand, not exercise intensity or a diagnosis.
export function buildLoadEvidence(rows = []) {
  const features = buildPhaseEvidence(normalizeLoadRows(rows)).points;
  let phase = 'warming', pending = null, since = 0;
  const moments = [];
  const points = features.map((p) => {
    if (p.approach == null) {
      phase = p.phase || 'unavailable'; pending = null;
      return { ...p, phase, load: null, sustained: null };
    }
    const contributions = {
      elevation: Math.max(0, Math.min(1, p.delta / 25)) * 65,
      rise: Math.max(0, Math.min(1, p.slope / 12)) * 10,
      hrv: (p.compression ?? 0) * 25,
    };
    const load = Math.round(Object.values(contributions).reduce((a, b) => a + b, 0));
    const wanted = p.recovery >= 45 && p.slope < 0 ? 'recovery'
      : load >= 70 ? 'approach' : p.plateau >= 60 ? 'plateau'
        : load >= 20 || p.slope >= 3 ? 'build' : 'baseline';
    if (pending !== wanted) { pending = wanted; since = p.t; }
    if (p.t - since >= 3) {
      if (phase !== wanted) moments.push({ t: since, detectedAt: p.t, kind: wanted, label: LOAD_LABELS[wanted] });
      phase = wanted;
    }
    return { ...p, phase, load, sustained: p.plateau, loadContributions: contributions };
  });
  return { points, moments };
}

export function loadBandsFromPoints(points) {
  return phaseBandsFromPoints(points).map((b) => ({ ...b, label: LOAD_LABELS[b.phase], color: PHASE_COLORS[b.phase] }));
}
