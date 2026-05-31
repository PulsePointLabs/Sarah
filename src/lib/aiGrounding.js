import { richTextToPlainText } from "@/lib/richText";

export const PERSONALIZED_ANATOMY_OUTPUT_RULE = `
PERSONALIZED ANATOMY OUTPUT RULE - HIGH PRIORITY:
- In companion-style or personally addressed analysis, never refer to the person as "the user," "the subject," "the participant," "the patient," "this person," or "the individual." Use "you," "your notes," "your body," "your physiology," "your recovery," and "your pattern."
- In any sentence describing this person's recorded body, anatomy, appearance, sensation, session response, device interaction, or supported finding, use a personal reference: "your penis," "your shaft," "your glans," "your foreskin" when applicable, "your meatus," "your urethra," "your erection," "your pelvic floor," "your scrotum," "your lower body," "your feet," or the corresponding "your ..." construction.
- This applies even when source notes or structured fields use detached labels. Paraphrase session-linked findings personally rather than echoing phrases such as "the penis," "the shaft," "the glans," "the meatus," "the urethra," "the feet," or "the body."
- Generic phrasing with "the" is permitted only for an unmistakably general physiology or anatomy explanation, such as explaining how penile tissue, the urethra, or the pelvic floor generally functions. As soon as the sentence returns to this person's data, observations, or interpretation, switch back to "your."
- Before returning final output, check every anatomical reference in session-specific findings and revise any detached reference into direct second-person language.
- Keep this personal language clinically grounded, observational, and natural. Do not make it erotic, euphemistic, or more certain than the evidence allows.
`;

function hasValue(value) {
  if (Array.isArray(value)) return value.length > 0;
  return value !== null && value !== undefined && String(value).trim() !== "";
}

function cleanText(value, maxLength = 900) {
  if (!hasValue(value)) return "";
  const text = richTextToPlainText(Array.isArray(value) ? value.join(", ") : String(value));
  return text.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function addLine(lines, label, value, maxLength) {
  const cleaned = cleanText(value, maxLength);
  if (cleaned) lines.push(`- ${label}: ${cleaned}`);
}

function addMeasurementLine(lines, label, measurement) {
  if (!measurement || measurement.value == null || !measurement.unit) return;
  addLine(lines, label, `${measurement.value} ${measurement.unit}`);
}

function buildProfileQaFindingLines(findings = []) {
  if (!Array.isArray(findings)) return [];
  return findings
    .slice(0, 18)
    .flatMap((entry) => {
      const bullets = Array.isArray(entry.findings) ? entry.findings : [];
      return bullets.slice(0, 6).map((finding) => `- ${entry.date || "AI Interview"}: ${cleanText(finding, 500)}`);
    })
    .filter((line) => line.trim() !== "-:");
}

function buildMechanicalProfileContext(profile) {
  if (!profile) return [];

  const lines = [];
  addMeasurementLine(lines, "Flaccid length", profile.flaccid_length);
  addMeasurementLine(lines, "Flaccid mid-shaft diameter", profile.flaccid_mid_shaft_diameter);
  addMeasurementLine(lines, "Flaccid base diameter", profile.flaccid_base_diameter);
  addMeasurementLine(lines, "Resting widest glans diameter", profile.flaccid_widest_glans_diameter);
  addLine(lines, "Resting glans observations", profile.resting_glans_observations, 900);
  addLine(lines, "Resting foreskin coverage or mobility", profile.resting_foreskin_coverage_mobility, 900);
  addLine(lines, "Resting curvature or orientation", profile.resting_curvature_orientation, 900);
  addLine(lines, "Resting meatal observations", profile.resting_meatal_observations, 900);
  addLine(lines, "Resting urethral accommodation notes", profile.resting_urethral_accommodation_notes, 1200);
  addMeasurementLine(lines, "Bone-pressed erect length", profile.bone_pressed_erect_length);
  addMeasurementLine(lines, "Visible erect length", profile.visible_erect_length);
  addMeasurementLine(lines, "Mid-shaft diameter", profile.mid_shaft_diameter);
  addMeasurementLine(lines, "Base diameter", profile.base_diameter);
  addMeasurementLine(lines, "Diameter just below glans", profile.below_glans_diameter);
  addMeasurementLine(lines, "Widest glans diameter", profile.widest_glans_diameter);
  addLine(lines, "Circumcision status", profile.circumcision_status);
  addLine(lines, "Foreskin behavior during sessions", profile.foreskin_behavior);
  addLine(lines, "Glans sensitivity", profile.glans_sensitivity);
  addLine(lines, "Glans overstimulation near climax", profile.glans_overstimulation_near_climax);
  addLine(lines, "Erect glans observations", profile.erect_glans_observations, 900);
  addLine(lines, "Erect curvature or orientation", profile.erect_curvature_orientation, 900);
  addLine(lines, "Meatal shape", profile.meatal_shape);
  addMeasurementLine(lines, "Visible meatal vertical length", profile.visible_meatal_vertical_length);
  addMeasurementLine(lines, "Visible meatal horizontal width", profile.visible_meatal_horizontal_width);
  if (profile.visible_meatal_horizontal_width?.value == null || !profile.visible_meatal_horizontal_width?.unit) {
    addLine(lines, "Visible meatal width", profile.visible_meatal_width_mm != null ? `${profile.visible_meatal_width_mm} mm` : "");
  }
  addLine(lines, "Meatal mobility or shape change during erection", profile.meatal_mobility_shape_change);
  addLine(lines, "Meatal sensitivity", profile.meatal_sensitivity);
  addLine(lines, "Device stability at meatus", profile.device_stability_at_meatus);
  addLine(lines, "Meatal tension or fit notes", profile.meatal_tension_fit_notes, 900);
  addLine(lines, "Erect meatal observations", profile.erect_meatal_observations, 900);
  addLine(lines, "Erect urethral accommodation notes", profile.erect_urethral_accommodation_notes, 1200);
  addLine(lines, "Comfortable inserted diameter", profile.comfortable_inserted_diameter_mm != null ? `${profile.comfortable_inserted_diameter_mm} mm` : "");
  addLine(lines, "Maximum tolerated diameter", profile.maximum_tolerated_diameter_mm != null ? `${profile.maximum_tolerated_diameter_mm} mm` : "");
  addLine(lines, "Preferred Foley size", profile.preferred_foley_size_fr != null ? `${profile.preferred_foley_size_fr} French` : "");
  addLine(lines, "Stable Foley range", profile.stable_foley_range);
  addLine(lines, "Foley discomfort factors", profile.foley_discomfort_factors);
  addLine(lines, "Flaccid to erect expansion characteristics", profile.flaccid_to_erect_expansion_characteristics, 1200);
  addLine(lines, "Relative girth expansion", profile.relative_girth_expansion, 900);
  addLine(lines, "Rigidity or compliance observations", profile.rigidity_compliance_observations, 1200);
  addLine(lines, "Tissue response observations", profile.tissue_response_observations, 1200);
  addLine(lines, "Fit variability by anatomical state", profile.fit_variability_by_state, 1200);
  addLine(lines, "Sensitivity differences by state", profile.sensitivity_differences_by_state, 1200);
  addLine(lines, "Pressure distribution observations", profile.pressure_distribution_observations, 1200);
  addLine(lines, "Accommodation differences by state", profile.accommodation_differences_by_state, 1200);
  addLine(lines, "Device interaction observations", profile.device_interaction_observations, 1200);
  addLine(lines, "Repeated instrumentation fit findings", profile.repeated_instrumentation_fit_findings, 1200);
  addLine(lines, "Full erection stability early session", profile.full_erection_stability_early_session);
  addLine(lines, "Near-threshold erection behavior", profile.near_threshold_erection_behavior);
  addLine(lines, "Finger-on-glans recovery effectiveness", profile.finger_on_glans_recovery_effectiveness);
  addLine(lines, "Full-hand stimulation effectiveness near threshold", profile.full_hand_stimulation_effectiveness_near_threshold);
  addLine(lines, "Sleeve fit dynamics", profile.sleeve_fit_dynamics);
  addLine(lines, "Device movement sensitivity", profile.device_movement_sensitivity);
  addLine(lines, "Erect functional observations", profile.erect_functional_observations, 1200);
  addLine(lines, "Additional functional notes", profile.additional_functional_notes, 1200);
  return lines;
}

export function buildGlobalProfileContext(userProfile) {
  if (!userProfile) return "";

  const lines = [];
  addLine(lines, "Preferred first name", userProfile.first_name, 80);
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
  const qaFindingLines = buildProfileQaFindingLines(userProfile.profile_qa_findings);
  if (qaFindingLines.length) lines.push("User-verified interview findings (Profile Q&A):", ...qaFindingLines);
  addLine(lines, "Anatomical context", userProfile.anatomical_context || userProfile.anatomy_notes, 900);
  const mechanicalLines = buildMechanicalProfileContext(userProfile.anatomical_mechanical_profile);
  if (mechanicalLines.length) lines.push("Functional mechanical profile:", ...mechanicalLines);

  return lines.length ? lines.join("\n") : "";
}

export function buildOptionalFirstNameToneCue(userProfile, { prioritizeProfileTone = false } = {}) {
  const firstName = cleanText(userProfile?.first_name, 80);
  if (!firstName) return "";
  return `
OPTIONAL FIRST-NAME ADDRESS CUE:
- The person's preferred first name is ${firstName}.
- You may use ${firstName} sparingly when direct address naturally deepens warmth or continuity${prioritizeProfileTone ? ", particularly in the profile overview or a meaningful concluding observation" : ""}.
- Do not overuse the name, force it into technical sentences, or substitute it for clear second-person language.`;
}

export function buildAIGroundingContext(userProfile, { includeProfile = true } = {}) {
  const profileContext = includeProfile ? buildGlobalProfileContext(userProfile) : "";

  return `GLOBAL PROFILE REFERENCE:
${profileContext || "- No saved profile context was available. Rely only on the session data, journal, and event notes."}

GLOBAL EVIDENCE AND INTERPRETATION RULES:
- Treat the profile as background context, not as a replacement for the current session facts.
- Treat User-verified interview findings (Profile Q&A) as structured first-person interview evidence. They are stronger than loose profile notes because they were distilled from direct Q&A, but they remain below current-session telemetry, event notes, journal text, and direct session facts when those sources conflict.
- Use repeated or convergent Profile Q&A findings to support higher-confidence longitudinal interpretation, especially when they align with telemetry, behavior, journals, or saved profile fields.
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
- If a subjective note conflicts with stronger reviewed visual evidence, saved telemetry, or a later corrected observation, explicitly note the discrepancy and prefer the stronger evidence for interpretation. Do not build confident recommendations on disputed source data.
- Use one consistent numeric source within each claim. If saved summary values differ from directly computed telemetry or differ only because of rounding, identify which value you are citing or explain the rounding/source difference instead of silently mixing figures.
- Do not invent hormone explanations, neurological localization claims, or anatomical causal claims that are not directly supported by the available evidence.
- Do not assume person-specific anatomy or sensations that are not present in the data. You may discuss anatomy and physiology implied by logged methods or sensations, such as glans, foreskin, urethral, perineal, pelvic floor, ejaculatory, autonomic, or recovery physiology when those methods or cues are present.
- If explicit manually entered timeline events identify stimulation as paused or resumed, treat those entries as the primary evidence for stimulation pause timing and duration. Motion-derived hand inactivity or resumption candidates are secondary observational support only, because hand tracking may be incomplete or unreliable.
- If only motion-derived pause/resume evidence exists, describe it as an observed hand-activity gap or resumption candidate rather than a confirmed stimulation pause or resumption.
- Use anatomical dimensions only when they meaningfully affect stimulation mechanics, device interaction, pressure distribution, or interpretation of repeated observed patterns.
- Do not use anatomy for unsupported physiological claims, vanity assumptions, or speculative causal conclusions.
- Meatal morphology may be considered only when interpreting device fit, movement perception, sealing behavior, stimulation mechanics, or repeated observed functional patterns.
- Do not use morphology for unsupported causal physiological claims or speculative conclusions.
- Do not turn ambiguous pauses, slowdowns, or non-climax sessions into psychological conclusions.

${PERSONALIZED_ANATOMY_OUTPUT_RULE}`;
}
