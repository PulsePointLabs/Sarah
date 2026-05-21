function hasValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function cleanText(value, maxLength = 900) {
  if (!hasValue(value)) return "";
  const text = Array.isArray(value) ? value.join(", ") : String(value);
  return text.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function addLine(lines, label, value, maxLength) {
  const cleaned = cleanText(value, maxLength);
  if (cleaned) lines.push(`- ${label}: ${cleaned}`);
}

export function buildGlobalProfileContext(userProfile) {
  if (!userProfile) return "";

  const lines = [];
  addLine(lines, "Age", userProfile.age);
  addLine(lines, "Fitness level", userProfile.fitness_level);
  addLine(lines, "Resting heart rate", userProfile.resting_hr ? `${userProfile.resting_hr} beats per minute` : "");
  addLine(lines, "Maximum heart rate", userProfile.max_hr ? `${userProfile.max_hr} beats per minute` : "");
  addLine(lines, "Typical sixty-second recovery", userProfile.recovery_hr_60s ? `${userProfile.recovery_hr_60s} beats per minute` : "");
  addLine(lines, "Medications or conditions", userProfile.medications, 700);
  addLine(lines, "Arousal response style", userProfile.arousal_response_style, 700);
  addLine(lines, "Typical build duration", userProfile.typical_build_duration);
  addLine(lines, "Climax sensitivity", userProfile.climax_sensitivity, 700);
  addLine(lines, "Preferred stimulation", userProfile.preferred_stimulation);
  addLine(lines, "Refractory pattern", userProfile.refractory_pattern, 700);
  addLine(lines, "Arousal notes", userProfile.arousal_notes, 1200);
  addLine(lines, "Profile notes", userProfile.profile_notes || userProfile.notes, 1200);
  addLine(lines, "Anatomical context", userProfile.anatomical_context || userProfile.anatomy_notes, 900);

  return lines.length ? lines.join("\n") : "";
}

export function buildAIGroundingContext(userProfile, { includeProfile = true } = {}) {
  const profileContext = includeProfile ? buildGlobalProfileContext(userProfile) : "";

  return `GLOBAL PROFILE REFERENCE:
${profileContext || "- No saved profile context was available. Rely only on the session data, journal, and event notes."}

GLOBAL EVIDENCE AND INTERPRETATION RULES:
- Treat the profile as background context, not as a replacement for the current session facts.
- Compare current observations against the profile when useful, especially deviations from the person's known build style, sensitivity, recovery, and preferred stimulation.
- Separate observed facts from interpretation. Anchor every meaningful claim in heart-rate data, event notes, journal text, subjective metrics, or saved profile notes.
- Maintain a warm, deeply personalized, psychologically resonant tone. The person values meaningful interpretation, not sterile detached reporting.
- Strong interpretive language is welcome when it is earned by repeated patterns, direct observations, or highly consistent contextual evidence.
- Strong longitudinal phrasing such as "your body repeatedly shows", "your nervous system appears to", "your response pattern suggests", or "this has become a recognizable signature" requires repeated evidence across telemetry, behavior, journals, interviews, or profile notes.
- Use an interpretive confidence ladder:
  HIGH confidence: repeated telemetry plus repeated behavioral confirmation plus consistent journal, interview, or profile support. Strong narrative language is allowed.
  MODERATE confidence: repeated subjective patterns without strong objective corroboration. Interpret confidently but keep the claim qualified.
  LOW confidence: single observations, person hypotheses, or speculative mechanisms. Frame them cautiously with language such as "one possibility is", "this may reflect", "a plausible interpretation is", or "this remains speculative".
- Do explain the physiological "why" behind observed patterns. Use established sexual physiology, autonomic nervous system dynamics, stimulation mechanics, and anatomy as the interpretive framework when the session data gives you a clear anchor.
- Connect stimulation changes to likely sensory and autonomic effects when methods, event notes, heart-rate shifts, or subjective sensations support that connection.
- Connect heart-rate rises, plateaus, drops, and recovery slopes to plausible sympathetic and parasympathetic dynamics. The analysis should feel mechanistic and insightful, not just descriptive.
- Use timeline events as evidence, not as a script. Avoid simple play-by-play unless the user specifically asks for it.
- Prefer synthesis: group nearby observations into meaningful windows, turning points, or response patterns, then explain what changed and why it likely mattered.
- Time references are useful anchors, but every time reference should support an interpretation rather than merely restating sequence.
- Do not infer intent, strategy, motivation, or goals unless the person explicitly wrote it in notes, journal text, event annotations, or profile context.
- Avoid claims like "trying to avoid climax", "intentionally edging", "choosing to delay", "suppressing climax", or "holding back" unless explicitly logged.
- Use neutral physiological language when intent is not stated: stimulation slowed, arousal plateaued, heart rate decelerated, climax did not occur, recovery signs appeared, stimulation stopped, or the body shifted toward recovery.
- If offering a hypothesis about physiology, make it evidence-linked and explain why it fits. Only label it as tentative when the evidence is indirect or ambiguous.
- Do not present speculation as established physiology.
- Do not invent hormone explanations, neurological localization claims, or anatomical causal claims that are not directly supported by the available evidence.
- Do not assume person-specific anatomy or sensations that are not present in the data. You may discuss anatomy and physiology implied by logged methods or sensations, such as glans, foreskin, urethral, perineal, pelvic floor, ejaculatory, autonomic, or recovery physiology when those methods or cues are present.
- Do not turn ambiguous pauses, slowdowns, or non-climax sessions into psychological conclusions.`;
}
