import { formatManualAnnotationReviewText } from './manualAnnotationReviewText.js';

export const REVIEW_READER_RULE = `Write directly to Ben as you/your, never subject, patient, client or participant. Use concise, natural anatomical language. Describe the visible state, what changes, and when; avoid inflated clinical prose and internal tracking/debug language. Keep the user's note or subjective marker separate from your visual observations. Do not infer breath holding from a still frame, muscle force from pressure, intent from movement, or orgasm from appearance alone. For penis/glans observations, distinguish shaft state from glans appearance rather than treating them as identical. Keep subtle candidates and uncertainty explicit.`;

const main = [
  ['head','Head / face',/head|face|jaw|mouth|eyes/i],
  ['neck','Neck / shoulders',/neck|shoulder/i],
  ['breathing','Chest / breathing',/chest|breath|respirat|thorax/i],
  ['abdomen','Abdomen / trunk',/abdomen|abdominal|trunk|torso/i],
  ['arms','Arms / hands',/arms?|hands?|finger/i],
  ['pelvis','Pelvis / hips',/pelvi|hips?|glute/i],
  ['penis','Penis / glans',/penis|penile|glans|shaft|foreskin/i],
  ['perineum','Scrotum / perineum',/scrot|perine/i],
  ['skin','Skin / flushing',/skin|flushing|color|colour/i],
  ['contact','Visible contact / movement',/contact|stimulation|cadence|grip|coverage|pause/i],
];
const lower = [
  ['legs','Thighs / legs / knees',/thigh|legs?|knees?|calves|calf/i],
  ['ankles','Ankles / heels',/ankle|heel|plantar|dorsiflex/i],
  ['feet','Feet / soles',/feet|foot|sole|inversion|eversion/i],
  ['toes','Toes',/toes?|splay/i],
  ['tension','Bracing / tension / release',/brac|tension|tremor|oscillat|release/i],
];
export const anatomyChecklistLabels = role => (['feet','lower_body'].includes(role)?[main[5],...lower]:[...main,...lower]).map(([,label])=>label);
export function anatomySections(findings = [], role = 'main') {
  const feet = ['feet','lower_body','lower-body','foot'].includes(role);
  const definitions = feet ? [main[5],...lower] : [...main,...lower];
  const sections=definitions.map(([id,label])=>({id,label,findings:[]}));
  const other={id:'other',label:'Other saved observations',findings:[]};
  for(const finding of findings) {
    const observation=formatManualAnnotationReviewText(finding.observation || '');
    if(!observation)continue;
    // Match the recorded area only. Never infer an anatomical location from prose.
    const match=definitions.findIndex(([, ,pattern])=>pattern.test(finding.anatomical_area || finding.metric || ''));
    (sections[match] || other).findings.push({...finding,observation});
  }
  return other.findings.length?[...sections,other]:sections;
}
export function evidenceFramesFor(finding, frames = [], tolerance = .6) {
  const time=finding.evidence_time_s ?? finding.time_s;
  if(time==null || !Number.isFinite(Number(time)))return [];
  return frames.filter(frame=>frame.url && (frame.recordTimeSeconds ?? frame.time_s)!=null
    && Math.abs(Number(frame.recordTimeSeconds ?? frame.time_s)-Number(time))<=tolerance);
}
