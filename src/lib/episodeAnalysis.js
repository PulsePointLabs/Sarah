import { buildPhaseEvidence } from './videoSyncPhaseEvidence.js';

export const EPISODE_REVIEW_VERSION = 1;
export const feetMetrics = ['Pelvis / hips', 'Thighs / leg rotation', 'Knees', 'Calves', 'Ankles / plantar flexion / dorsiflexion', 'Heels / planting', 'Feet / soles / inversion / eversion', 'Toe flexion / extension', 'Toe splay', 'Bracing / tremor / oscillation / local release'];
export const mainMetrics = ['Head / face', 'Neck / shoulders', 'Chest / visible breathing', 'Abdomen / trunk', 'Arms / hands', 'Pelvis / hips', 'Penile / glans state', 'Scrotal / perineal state', 'Skin color / flushing', 'Visible stimulation contact / cadence / grip / coverage / pauses', ...feetMetrics.slice(1)];
export const episodeRole = e => ['feet', 'lower_body'].includes(e.source?.key || e.source?.role) ? 'feet' : e.source?.key || e.source?.role || 'main';
export const episodeSignature = e => JSON.stringify([EPISODE_REVIEW_VERSION, e.id, e.kind, e.start_s, e.end_s, e.source || {}]);
export const completedEpisode = e => Number.isFinite(e.start_s) && Number.isFinite(e.end_s) && e.end_s > e.start_s;
export function episodeSegments(start, end, size = 10) {
  const segments = [];
  for (let t = start; t < end; t += size) segments.push({ start_s: t, end_s: Math.min(end, t + size) });
  if (segments.length > 1 && segments.at(-1).end_s - segments.at(-1).start_s < 0.25) {
    const tail = segments.pop(); segments.at(-1).end_s = tail.end_s;
  }
  return segments;
}
const median = values => { const v = values.filter(Number.isFinite).sort((a,b)=>a-b); return v.length ? v[Math.floor(v.length/2)] : null; };
export function episodeEvidence(episode, rows, model = buildPhaseEvidence(rows)) {
  const points = model.points.filter(p => p.t >= episode.start_s && p.t <= episode.end_s);
  const usable = points.filter(p => Number.isFinite(p.approach));
  const peak = usable.reduce((best,p) => !best || p.approach > best.approach ? p : best, null);
  return { interpretation: 'Approach evidence, not calibrated climax probability', sample_count: points.length,
    usable_score_samples: usable.length, usable_hrv_samples: points.filter(p=>p.hrvUsable).length,
    peak: peak ? { time_s: peak.t, score: peak.approach, contributions: peak.contributions } : null,
    median_score: median(usable.map(p=>p.approach)), hr_median: median(points.map(p=>p.hr)),
    rmssd_median: median(points.filter(p=>p.hrvUsable).map(p=>p.rmssd)),
    start_score: usable[0]?.approach ?? null, end_score: usable.at(-1)?.approach ?? null,
    points: points.map(({t,approach,plateau,recovery,hr,rmssd,hrvUsable,phase})=>({t,approach,plateau,recovery,hr,rmssd,hrvUsable,phase})) };
}
export function validateEpisodeSegment(result, metrics, start, end) {
  if (!result || typeof result.summary !== 'string' || !Array.isArray(result.metrics)) throw new Error('Visual analysis returned an incomplete segment. Re-analyze to retry.');
  const checked = metrics.map(metric => {
    const items = result.metrics.filter(item=>item.metric === metric);
    if (items.length !== 1) throw new Error(`Visual analysis omitted or duplicated ${metric}. Re-analyze to retry.`);
    const item = items[0];
    if (!['clear','partial','not_visible','uncertain'].includes(item.visibility) || !['low','moderate','high'].includes(item.confidence)
      || typeof item.observation !== 'string' || !item.observation.trim() || !Number.isFinite(item.time_s) || item.time_s < start || item.time_s > end) throw new Error(`Invalid timestamp or finding for ${metric}. Re-analyze to retry.`);
    return item;
  });
  return { summary: result.summary, metrics: checked, start_s: start, end_s: end };
}
