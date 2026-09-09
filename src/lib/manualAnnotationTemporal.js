export const TEMPORAL_FEET_RULES = `ACTIVE CAMERA = FEET / LOWER BODY ONLY.
Review the entire visible lower-body field: pelvis/hips, thighs, rotation, abduction/adduction, knees, calves, ankles, heels, whole feet, soles, forefeet and toes. A note about toes is not a crop instruction. Do not discuss genital state, penis/scrotum/glans, engorgement, erection, stimulation, strokes, cadence, grip or devices.
The annotation is an attention marker, not a proposition to validate. Independently describe the CURRENT complete window BEFORE -> AROUND THE MARK -> AFTER. Never grade, rebut, validate or argue with the note. Never write unsupported, partially supported, does not appear, or a verdict about Ben's observation. Uncertain observations can be described as possible/candidate; absence of evidence is not evidence of absence. Do not turn uncertainty into an assertion.
Address Ben as you/your. Give a connected chronological account, not a static inventory, frame-number narration or repetitive stable statements. Describe persistence when it belongs to a developing movement, not as filler.
Full frames are primary context throughout. Detail crops supplement them. Dense CV includes every sampled interval, camera compensation and persistent tracked regions. Pixel displacement is not a joint angle or a measure of tension. Inspect direction changes, onset/offset, oscillation, relative positions, asymmetry, tremor, bracing and release using BOTH ordered images and motion measurements. Screen x/y directions are not anatomical directions. Do not equate a motion threshold or tracking loss with release or camera movement. Compensation failures and low localization confidence must lower confidence, not fabricate precision.
OUTPUT LANGUAGE: narrative is 100–180 words TOTAL across all three phases, usually 1–2 sentences per phase. Describe your visible movement in ordinary anatomical language. No tracker, tracking, motion-energy, feature-count, pixel, crop, frame, direction-change-count or other implementation narration in narrative or finding observation. Those measurements stay in machine data. Do not inventory static baseline anatomy. Omit equipment identification, SpO2 sensors, overlays and handling; describe only resulting body movement. Do not say consistent with the annotation or otherwise validate the note. Findings should each give one concise anatomical change, preserving degree/asymmetry/uncertainty.
Track anatomical left/right only if orientation supports it; these cameras are unmirrored. Preserve unresolved laterality instead of guessing. Both sides can share a categorical state but differ in degree: e.g. left slightly more plantar-flexed; left toe curl begins while right toes remain extended. Toe flexion, extension and splay are separate dimensions. Do not invent angle measurements.
Local release is independent: toe flexion can decrease while the ankle remains plantar-flexed. Reduced movement alone does not establish relaxation, but do not inject a lecture or demand whole-body relaxation to describe local change.
No prior Sarah prose is supplied. Interpret this window first. Do not infer sensation, internal physiology, arousal, causation or a global relaxation verdict from movement alone.
Return narrative.before, narrative.around, narrative.after in chronological order and summary as their natural joined prose. Timestamp structured observations in SESSION seconds, not source seconds or frame numbers. Each finding describes a region's state/change, degree and laterality with its interval, visibility and confidence. Preserve subtle low-confidence candidates explicitly as uncertain; they remain visible but are not automatically promoted to physiology evidence.`;

export const TEMPORAL_FEET_SCHEMA = {
  type: 'object', properties: {
    summary: { type: 'string' },
    narrative: { type: 'object', properties: { before: { type: 'string' }, around: { type: 'string' }, after: { type: 'string' } }, required: ['before', 'around', 'after'] },
    findings: { type: 'array', maxItems: 32, items: { type: 'object', properties: {
      anatomical_area: { type: 'string' },
      laterality: { type: 'string', enum: ['left', 'right', 'bilateral', 'midline', 'unresolved'] },
      state: { type: 'string' }, direction: { type: 'string' }, magnitude: { type: 'string' }, asymmetry: { type: 'string' },
      temporal_phase: { type: 'string', enum: ['before', 'around', 'after', 'spanning'] },
      change: { type: 'string', enum: ['onset', 'increase', 'decrease', 'persistence', 'release', 'oscillation', 'direction_change', 'uncertain'] },
      observation: { type: 'string' }, change_from_prior: { type: 'string' },
      start_s: { type: 'number' }, end_s: { type: 'number' }, evidence_time_s: { type: 'number' },
      confidence: { type: 'string', enum: ['low', 'moderate', 'high'] },
      visibility: { type: 'string', enum: ['clear', 'partial', 'limited'] },
      response_domain: { type: 'string', enum: ['movement', 'posture', 'muscle_tension', 'skin', 'other'] },
    }, required: ['anatomical_area', 'laterality', 'state', 'direction', 'magnitude', 'asymmetry', 'temporal_phase', 'change', 'observation', 'start_s', 'end_s', 'evidence_time_s', 'confidence', 'visibility', 'response_domain'] } },
  }, required: ['summary', 'narrative', 'findings'],
};

export function promoteManualFinding(finding) {
  return ['moderate', 'high'].includes(finding.confidence) && finding.visibility !== 'limited';
}

export function temporalFindingInWindow(finding, start, end) {
  const values = [finding.start_s, finding.evidence_time_s, finding.end_s];
  return values.every(v => typeof v === 'number' && Number.isFinite(v) && v >= start-.001 && v <= end+.001)
    && finding.start_s <= finding.evidence_time_s && finding.evidence_time_s <= finding.end_s;
}
