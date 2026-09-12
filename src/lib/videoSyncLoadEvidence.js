import { buildPhaseEvidence, PHASE_COLORS, phaseBandsFromPoints } from './videoSyncPhaseEvidence.js';

export const LOAD_LABELS = {
  unavailable: 'Insufficient evidence', warming: 'Gathering evidence',
  baseline: 'Low physiological load', build: 'Rising physiological load',
  plateau: 'Sustained physiological load', approach: 'High physiological load', recovery: 'Recovering / settling',
};

// Reuse causal cardiac features, not the approach score or its classifications.
// This is relative cardiac demand, not exercise intensity or a diagnosis.
export function buildLoadEvidence(rows = []) {
  const features = buildPhaseEvidence(rows).points;
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
