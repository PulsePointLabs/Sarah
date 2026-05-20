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
- Do explain the physiological "why" behind observed patterns. Use established sexual physiology, autonomic nervous system dynamics, stimulation mechanics, and anatomy as the interpretive framework when the session data gives you a clear anchor.
- Connect stimulation changes to likely sensory and autonomic effects when methods, event notes, heart-rate shifts, or subjective sensations support that connection.
- Connect heart-rate rises, plateaus, drops, and recovery slopes to plausible sympathetic and parasympathetic dynamics. The analysis should feel mechanistic and insightful, not just descriptive.
- Do not infer intent, strategy, motivation, or goals unless the person explicitly wrote it in notes, journal text, event annotations, or profile context.
- Avoid claims like "trying to avoid climax", "intentionally edging", "choosing to delay", "suppressing climax", or "holding back" unless explicitly logged.
- Use neutral physiological language when intent is not stated: stimulation slowed, arousal plateaued, heart rate decelerated, climax did not occur, recovery signs appeared, stimulation stopped, or the body shifted toward recovery.
- If offering a hypothesis about physiology, make it evidence-linked and explain why it fits. Only label it as tentative when the evidence is indirect or ambiguous.
- Do not assume person-specific anatomy or sensations that are not present in the data. You may discuss anatomy and physiology implied by logged methods or sensations, such as glans, foreskin, urethral, perineal, pelvic floor, ejaculatory, autonomic, or recovery physiology when those methods or cues are present.
- Do not turn ambiguous pauses, slowdowns, or non-climax sessions into psychological conclusions.`;
}
