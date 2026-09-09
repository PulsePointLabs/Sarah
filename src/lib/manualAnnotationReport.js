import { formatManualAnnotationReviewText } from './manualAnnotationReviewText.js';

export function directObservationText(value) {
  // Omit uncertainty/verdict sentences rather than turning a negation into a fact.
  return formatManualAnnotationReviewText(value).split(/(?<=[.!?])\s+/)
    .filter((sentence) => !/\b(?:does? not appear|not visually confirmed|not supported by|partially supported|note is unsupported|contrary to your|your (?:note|observation) (?:is|was) (?:incorrect|unsupported)|reduced sampled movement alone does not establish relaxation)\b/i.test(sentence))
    .join(' ').trim();
}

export function manualAnnotationReport(review = {}) {
  const role = review.source_video_role || review.source_video?.role;
  const feet = ['feet', 'lower_body', 'lower-body', 'foot'].includes(role) || (!role && review.foot_assessment);
  if (!feet) return { summary: review.summary || '', findings: Array.isArray(review.findings) ? review.findings : [] };
  const saved = [...(review.findings || []), ...(review.reused_findings || [])]
    .map((finding) => ({ ...finding, observation: directObservationText(finding.observation) }))
    .filter((finding) => finding.observation);
  const findings = [...new Map(saved.map((finding) => [`${finding.anatomical_area}:${finding.observation}`, finding])).values()];
  // Older feet reviews retained structured observations while blanking their
  // prose. Present those observations in the same format as main-camera findings.
  if (!findings.length && review.foot_assessment) {
    const ankle = { plantar_flexed: 'ankle plantar-flexed', neutral: 'ankle neutral', dorsiflexed: 'ankle dorsiflexed' };
    const toes = { curled: 'toes curled', neutral: 'toes neutral', extended_or_splayed: 'toes extended or splayed' };
    const movement = { increasing_flexion: 'flexion increasing', decreasing_flexion: 'flexion decreasing', oscillating: 'oscillating movement', stable: 'position stable across sampled frames' };
    for (const side of ['left', 'right']) {
      const state = review.foot_assessment[side];
      if (!state?.evidence_frames?.length) continue;
      const parts = [ankle[state.ankle_state], toes[state.toe_state], state.bracing_state === 'braced' ? 'visible bracing' : '', movement[state.movement_state]].filter(Boolean);
      if (parts.length) findings.push({ anatomical_area: `${side === 'left' ? 'Left' : 'Right'} foot`, observation: `${parts.join('; ')}.`, evidence_time_s: state.evidence_frames[0] });
    }
  }
  return {
    summary: review.coverage_status === 'fully_reused' ? '' : directObservationText(review.summary),
    findings,
  };
}
