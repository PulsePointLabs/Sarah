import { richTextToPlainText } from "@/lib/richText";
import { isVisualReviewProfileQaEntry } from "@/lib/profileQa";
import { cleanProfileImageReviewText } from "@/lib/profileImageReviewCleanup";
import { SARAH_CLINICAL_REASONING_CALIBRATION_RULE } from "@/utils/clinicalReasoningCalibration";

export const PERSONALIZED_ANATOMY_OUTPUT_RULE = `
PERSONALIZED ANATOMY OUTPUT RULE - HIGH PRIORITY:
- In companion-style or personally addressed analysis, never refer to the person as "the user," "the subject," "the participant," "the patient," "this person," or "the individual." Use "you," "your notes," "your body," "your physiology," "your recovery," and "your pattern."
- In any sentence describing this person's recorded body, anatomy, appearance, sensation, session response, device interaction, or supported finding, use a personal reference: "your penis," "your shaft," "your glans," "your foreskin" when applicable, "your meatus," "your urethra," "your erection," "your pelvic floor," "your scrotum," "your lower body," "your feet," or the corresponding "your ..." construction.
- This applies even when source notes or structured fields use detached labels. Paraphrase session-linked findings personally rather than echoing phrases such as "the penis," "the shaft," "the glans," "the meatus," "the urethra," "the feet," or "the body."
- Generic phrasing with "the" is permitted only for an unmistakably general physiology or anatomy explanation, such as explaining how penile tissue, the urethra, or the pelvic floor generally functions. As soon as the sentence returns to this person's data, observations, or interpretation, switch back to "your."
- Before returning final output, check every anatomical reference in session-specific findings and revise any detached reference into direct second-person language.
- Keep this personal language clinically grounded, observational, and natural. Do not make it erotic, euphemistic, or more certain than the evidence allows.
`;

export const REVIEWED_VISUAL_EVIDENCE_PRIORITY_RULE = `
REVIEWED VISUAL EVIDENCE PRIORITY RULE - HIGH PRIORITY:
- Reviewed Sarah analysis of user-provided images, video frames, frame sequences, or clips is high-priority observational evidence across the app.
- When this evidence describes visible anatomy, erection state, stimulation method, contact zone, grip geometry, device fit, marker/sticker placement, positioning, movement, body response, telemetry overlay, foot/hand behavior, or arousal-state context, prioritize it above stored profile anatomy fields and older freeform notes.
- Video and frame-sequence analysis has the highest priority for motion-dependent claims, including pacing, stroke path, contact changes, grip mechanics, device movement, posture shifts, foot movement, bracing, toe curl, and timing relative to visible telemetry.
- Still-image analysis has high priority for static visible claims, including anatomy, morphology, device fit, positioning, visible state, marker placement, and contact location.
- Q&A that follows a reviewed visual analysis inherits visual-evidence priority when the user confirms, corrects, or clarifies what was visible.
- User Q&A controls subjective/internal claims such as sensation, intent, discomfort, perception, or context. Reviewed visual evidence controls visible claims unless the user explicitly corrects what was shown.
- Stored anatomical/mechanical profile details remain useful secondary context, especially for stable measurements, historical tendencies, and details not visible in the media. They should not override clearer, newer, or more specific reviewed visual evidence.
- Generated profile synthesis is summary context only. It should not override the underlying source evidence when reviewed visual findings, telemetry, event notes, or user-confirmed Q&A are available.
- If reviewed visual evidence conflicts with stored profile details, explicitly acknowledge the discrepancy and prefer the reviewed visual evidence for the visible claim.
- Do not overgeneralize from one image or clip into a permanent anatomical trait or universal response pattern unless repeated reviewed visual evidence or user-confirmed Q&A supports it.
- Keep the rule domain-specific: current-session telemetry/events still control timing and numeric claims; reviewed visual evidence controls visible anatomy, stimulation mechanics, movement, contact, device fit, marker placement, and visible arousal/body-state claims.
`;

export const SARAH_APP_OVERLAY_TELEMETRY_RULE = `
SARAH APP OVERLAY TELEMETRY RULE - HIGH PRIORITY:
- Sarah videos may include app-generated overlays or captured app panels showing Current HR, AVG, MAX, RR samples, RMSSD/HRV quality, build confidence, AI Magic/near-climax percentage, recovery percentage, phase labels, heart-rate trend charts, timers, OBS/session status, EMG levels, Howl/Coyote/e-stim device state, and other Sarah telemetry.
- Treat readable Sarah overlay values as first-class app telemetry evidence, not random scene text. When a visible overlay says build, recovery, near-climax, HR, HRV, RR, EMG, or device state, use it to improve the physiological interpretation of the same moment.
- Use on-screen Sarah overlay data as timing and context support for visible body/session evidence: it can strengthen reads about rising load, plateau, near-climax, recovery, HRV opening/tightening, EMG activation, device changes, or stimulation-state correlation.
- Do not make overlay text the whole finding. Integrate it naturally with the video, event notes, CSV telemetry, saved phase markers, and subjective notes.
- If stored CSV/session telemetry and the visible overlay disagree, prefer stored telemetry for exact numeric claims and mention the overlay only as visible app context unless the user asks to debug the mismatch.
- If overlay text is blurred, cropped, too small, stale, or partially hidden, say it is unreadable or partial rather than inventing the value.
- Do not mistake Sarah app overlays for external medical monitors or third-party device screens unless the interface is visibly that device. Sarah build/recovery/AI Magic labels are app-derived analysis signals.
`;

export const ANATOMICAL_REFERENCE_FOCUS_RULE = `
ANATOMICAL REFERENCE FOCUS RULE - HIGH PRIORITY:
- When the requested output is a pelvic/genital image review, visual anatomy reference, device-fit review, body exploration review, or anatomical/mechanical reference, prioritize anatomy and evidence over personal history.
- Focus on visible morphology, measured dimensions, tissue state, state-dependent changes, device interaction, contact mechanics, stimulation mechanics, positioning, safety observations, and limitations.
- Use psychological, historical, emotional, or broad life-context material only when it directly explains a visible/mechanical finding, device interaction, safety consideration, or session-specific physiological interpretation.
- Do not turn an anatomical reference into a broad arousal biography, psychological architecture discussion, reclaiming/history frame, or session optimization essay unless the user explicitly asks for a whole-profile synthesis.
- Do not repeat sensitive personal history in anatomical reference outputs unless it is directly relevant to the requested anatomical, physiological, mechanical, or device-fit question.
- Keep the tone direct, warm, clinical, and personal. Use "you" and "your" for person-specific findings.
- Avoid detached phrasing such as "the user" and awkward euphemisms. Use clear anatomical terms when the evidence supports them.
- Do not overgeneralize from one image or clip. Label reviewed visual evidence, entered measurements, Q&A confirmation, telemetry, and cautious inference separately when relevant.
- If no fresh media is attached, explicitly state that the review is based on previously reviewed visual evidence and saved findings rather than direct re-examination.
- "Next images", "future views", or "evidence gaps" should be framed as optional documentation opportunities, not instructions or pressure to capture intimate media.
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

const LATEST_REVIEW_SECTION_LABELS = {
  executive_summary: "Executive summary",
  head_face: "Head and face",
  neck: "Neck",
  shoulders_upper_back: "Shoulders and upper back",
  chest: "Chest",
  abdomen: "Abdomen",
  pelvis_pubic_region: "Pelvis and pubic region",
  genitals_perineum: "Genitals and perineum",
  buttocks_perianal_region: "Buttocks and perianal region",
  upper_limbs_hands: "Upper limbs and hands",
  lower_limbs: "Lower limbs",
  feet_toes: "Feet and toes",
  posture_alignment: "Posture and alignment",
  skin_summary: "Skin summary",
  pubic_mound_lower_abdomen: "Pubic mound and lower abdomen",
  inguinal_folds_groin_skin: "Inguinal folds and groin skin",
  penis: "Penis",
  foreskin: "Foreskin",
  glans_meatus: "Glans and meatus",
  scrotum_testes: "Scrotum and testes",
  perineum: "Perineum",
  anal_opening_perianal_region: "Anal opening and perianal region",
  buttocks_gluteal_skin: "Buttocks and gluteal skin",
  device_contact_findings: "Device and contact findings",
  tissue_health_safety_observations: "Tissue health and safety observations",
  measurement_reconciliation: "Measurement reconciliation",
  constitutional_and_systemic_context: "Constitutional and systemic context",
  cardiovascular_and_autonomic_context: "Cardiovascular and autonomic context",
  sensory_and_biomechanical_context: "Sensory and biomechanical context",
  pelvic_and_external_anatomy: "Pelvic and external anatomy",
  dynamic_anatomical_function: "Dynamic anatomical function",
  instrumentation_and_fit_findings: "Instrumentation and fit",
  session_linked_interpretations: "Session-linked interpretations",
};

const LATEST_REVIEW_SECTION_ORDER = [
  "executive_summary",
  "posture_alignment",
  "abdomen",
  "pelvis_pubic_region",
  "genitals_perineum",
  "skin_summary",
  "feet_toes",
  "pubic_mound_lower_abdomen",
  "inguinal_folds_groin_skin",
  "penis",
  "foreskin",
  "glans_meatus",
  "scrotum_testes",
  "perineum",
  "anal_opening_perianal_region",
  "buttocks_gluteal_skin",
  "device_contact_findings",
  "tissue_health_safety_observations",
  "measurement_reconciliation",
  "constitutional_and_systemic_context",
  "cardiovascular_and_autonomic_context",
  "sensory_and_biomechanical_context",
  "pelvic_and_external_anatomy",
  "dynamic_anatomical_function",
  "instrumentation_and_fit_findings",
  "session_linked_interpretations",
];

function cleanReviewDigestText(value, maxLength = 520) {
  const cleaned = cleanProfileImageReviewText(value);
  return cleanText(cleaned, maxLength);
}

function addReviewDigestItems(lines, label, items, { limit = 3, maxLength = 520 } = {}) {
  if (!Array.isArray(items) || !items.length) return;
  const seen = new Set();
  for (const item of items) {
    const text = cleanReviewDigestText(item, maxLength);
    const key = text.toLowerCase();
    if (!text || seen.has(key)) continue;
    seen.add(key);
    lines.push(`- ${label}: ${text}`);
    if (seen.size >= limit) break;
  }
}

function buildLatestReviewDigest(result, label, { maxLines = 26 } = {}) {
  if (!result || typeof result !== "object") return [];
  const lines = [];
  const generated = result?._meta?.last_generated_at || result?._meta?.generated_at || result?.generated_at;
  const suffix = generated ? ` (${generated})` : "";
  const overview = cleanReviewDigestText(result.overview, 700);
  if (overview) lines.push(`- ${label}${suffix} overview: ${overview}`);
  addReviewDigestItems(lines, `${label} key finding`, result.summary_card?.key_direct_findings, { limit: 4, maxLength: 520 });
  addReviewDigestItems(lines, `${label} reference value`, result.summary_card?.primary_reference_value, { limit: 3, maxLength: 460 });

  for (const key of LATEST_REVIEW_SECTION_ORDER) {
    if (lines.length >= maxLines) break;
    const items = Array.isArray(result[key]) ? result[key] : [];
    if (!items.length) continue;
    addReviewDigestItems(lines, `${label} ${LATEST_REVIEW_SECTION_LABELS[key] || key}`, items, {
      limit: key === "executive_summary" ? 5 : 2,
      maxLength: 520,
    });
  }
  return lines.slice(0, maxLines);
}

function buildLatestAnatomicalReferenceContext(userProfile) {
  if (!userProfile) return [];
  const lines = [
    ...buildLatestReviewDigest(userProfile.head_to_toe_image_review_result, "Latest Head-to-Toe review", { maxLines: 18 }),
    ...buildLatestReviewDigest(userProfile.pelvic_genital_image_review_result, "Latest Pelvic/Genital review", { maxLines: 22 }),
    ...buildLatestReviewDigest(userProfile.anatomical_physiological_profile_result, "Latest A&P profile", { maxLines: 18 }),
  ];
  return lines.slice(0, 44);
}

function buildProfileQaFindingLines(findings = [], { visualOnly = false } = {}) {
  if (!Array.isArray(findings)) return [];
  return findings
    .filter((entry) => visualOnly ? isVisualReviewProfileQaEntry(entry) : !isVisualReviewProfileQaEntry(entry))
    .slice(0, 18)
    .flatMap((entry) => {
      const bullets = Array.isArray(entry.findings) ? entry.findings : [];
      return bullets.slice(0, 6).map((finding) => {
        const structured = Array.isArray(entry.structured_findings) && entry.structured_findings.length
          ? entry.structured_findings.find((item) => cleanText(item.findingText || item.text, 500) === cleanText(finding, 500))
          : null;
        const confidence = structured?.confidence ? `; ${structured.confidence} confidence` : "";
        const media = entry.frame_count ? `; ${entry.frame_count} sampled video frames` : entry.image_count ? `; ${entry.image_count} image${entry.image_count === 1 ? "" : "s"}` : "";
        return `- ${entry.date || "AI Interview"}${confidence}${media}: ${cleanText(finding, 500)}`;
      });
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
  const latestComposition = userProfile.latest_body_composition;
  if (latestComposition) {
    addLine(lines, "Latest measured weight", latestComposition.weight_kg != null ? `${Number(latestComposition.weight_kg).toFixed(1)} kilograms` : "");
    addLine(lines, "Latest body fat estimate", latestComposition.body_fat_percent != null ? `${Number(latestComposition.body_fat_percent).toFixed(1)} percent` : "");
    addLine(lines, "Latest lean body mass estimate", latestComposition.lean_body_mass_kg != null ? `${Number(latestComposition.lean_body_mass_kg).toFixed(1)} kilograms` : "");
    addLine(lines, "Latest body-composition measurement time", latestComposition.measured_at);
  } else {
    addLine(lines, "Profile weight", userProfile.weight_kg ? `${userProfile.weight_kg} kilograms` : "");
  }
  addLine(lines, "Typical sixty-second recovery", userProfile.recovery_hr_60s ? `${userProfile.recovery_hr_60s} beats per minute` : "");
  addLine(lines, "Medications or conditions", userProfile.medications, 700);
  addLine(lines, "Arousal response style", userProfile.arousal_response_style, 700);
  addLine(lines, "Typical build duration", userProfile.typical_build_duration);
  addLine(lines, "Climax sensitivity", userProfile.climax_sensitivity, 700);
  addLine(lines, "Preferred stimulation", userProfile.preferred_stimulation);
  addLine(lines, "Refractory pattern", userProfile.refractory_pattern, 700);
  addLine(lines, "Arousal notes", userProfile.arousal_notes, 1200);
  addLine(lines, "Profile notes", userProfile.profile_notes || userProfile.notes, 1200);
  const visualFindingLines = buildProfileQaFindingLines(userProfile.profile_qa_findings, { visualOnly: true });
  if (visualFindingLines.length) lines.push("Reviewed Sarah visual evidence (profile/anatomy/media):", ...visualFindingLines);
  const qaFindingLines = buildProfileQaFindingLines(userProfile.profile_qa_findings);
  if (qaFindingLines.length) lines.push("User-verified interview findings (Profile Q&A):", ...qaFindingLines);
  addLine(lines, "Anatomical context", userProfile.anatomical_context || userProfile.anatomy_notes, 900);
  const mechanicalLines = buildMechanicalProfileContext(userProfile.anatomical_mechanical_profile);
  if (mechanicalLines.length) lines.push("Functional mechanical profile:", ...mechanicalLines);
  const latestAnatomicalReferenceLines = buildLatestAnatomicalReferenceContext(userProfile);
  if (latestAnatomicalReferenceLines.length) {
    lines.push("Latest cumulative anatomical reference reviews:", ...latestAnatomicalReferenceLines);
  }

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
- Treat Reviewed Sarah visual evidence as a distinct high-priority observational layer for visible claims. It is stronger than older profile fields and freeform notes when it directly describes visible anatomy, technique, fit, contact, body state, marker placement, movement, or frame-sequence context.
- Use repeated or convergent Profile Q&A findings to support higher-confidence longitudinal interpretation, especially when they align with telemetry, behavior, journals, or saved profile fields.
- Compare current observations against the profile when useful, especially deviations from the person's known build style, sensitivity, recovery, and preferred stimulation.
- Separate observed facts from interpretation. Anchor every meaningful claim in heart-rate data, event notes, journal text, subjective metrics, or saved profile notes.
- Maintain a warm, deeply personalized, psychologically resonant tone. The person values meaningful interpretation, not sterile detached reporting.
- Strong interpretive language is welcome when it is earned by repeated patterns, direct observations, or strong contextual evidence.
- Strong longitudinal phrasing such as "your body repeatedly shows", "your nervous system appears to", "your response pattern suggests", or "this has become a recognizable signature" requires repeated evidence across telemetry, behavior, journals, interviews, or profile notes.
- Use an interpretive confidence ladder:
  HIGH confidence: repeated telemetry plus repeated behavioral confirmation plus matching journal, interview, or profile support. Strong narrative language is allowed.
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

${REVIEWED_VISUAL_EVIDENCE_PRIORITY_RULE}

${SARAH_APP_OVERLAY_TELEMETRY_RULE}

${SARAH_CLINICAL_REASONING_CALIBRATION_RULE}

${PERSONALIZED_ANATOMY_OUTPUT_RULE}`;
}
