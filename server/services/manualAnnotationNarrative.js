const TECHNICAL_OR_VERDICT = /\b(?:track(?:er|ing|s)?|motion energy|motion field|feature count|pixel|sub-pixel|detail crop|frame|SpO2|sensor|equipment|supported|unsupported|annotation|does not appear|direction.change counts?)\b/i;

export function feetReportNeedsPolish(result) {
  const narrative = ['before','around','after'].map(key=>result?.narrative?.[key] || '').join(' ');
  return narrative.trim().split(/\s+/).length > 200 || TECHNICAL_OR_VERDICT.test(narrative)
    || (result.findings || []).some(f=>TECHNICAL_OR_VERDICT.test(f.observation || ''));
}

// Conditional text-only presentation pass. It receives the current independent
// interpretation, never earlier reviews, media, or telemetry. State, intervals,
// confidence and CV measurements cannot be changed by this copy-edit operation.
export async function polishFeetReview(result, invoke, signal) {
  if (!feetReportNeedsPolish(result)) return result;
  const response = await invoke({ model: 'claude_sonnet_4_6', max_tokens: 2400, signal,
    response_json_schema: { type:'object', properties:{
      narrative:{type:'object',properties:{before:{type:'string'},around:{type:'string'},after:{type:'string'}},required:['before','around','after']},
      observations:{type:'array',items:{type:'object',properties:{index:{type:'integer'},text:{type:'string'}},required:['index','text']}},
    },required:['narrative','observations'] },
    prompt: `Copy-edit this CURRENT visual interpretation for Ben. Do not perform new analysis or add facts. Preserve anatomical side, subtle degree/asymmetry, chronological order and uncertainty. Do not reverse any negative or turn a candidate into certainty. Write a connected BEFORE -> AROUND THE MARK -> AFTER account, 100–180 words TOTAL, 1–2 sentences per phase, addressing you/your. Focus on what begins, changes, persists as part of that change, or locally releases. Omit static inventories, device/equipment/sensor references, timestamps repeated in prose, all tracking/optical-flow/crop/frame/pixel/motion-energy/feature jargon, and all mention of grading, validating or agreeing/disagreeing with an annotation. Never interpret reduced movement as relaxation. Describe local toe release independently from ankle position. For each original finding return its original index and a concise body-only observation; keep uncertainty explicit. Do not omit any potentially useful candidate. Return every finding exactly once.
Current interpretation: ${JSON.stringify({ narrative:result.narrative,findings:(result.findings||[]).map((f,index)=>({index,observation:f.observation,confidence:f.confidence,laterality:f.laterality,state:f.state,change:f.change,magnitude:f.magnitude,asymmetry:f.asymmetry})) })}` });
  const observations = new Map((response.observations || []).map(o=>[o.index,o.text]));
  if (!['before','around','after'].every(key=>typeof response.narrative?.[key] === 'string' && response.narrative[key].trim())
    || (result.findings || []).some((_,index)=>!String(observations.get(index)||'').trim())) {
    throw new Error('Sarah’s chronological report was incomplete; the previous saved review has been preserved.');
  }
  return { ...result, narrative:response.narrative, summary:['before','around','after'].map(key=>response.narrative[key]).join(' '), findings:(result.findings||[]).map((f,index)=>({...f,observation:observations.get(index)})) };
}
