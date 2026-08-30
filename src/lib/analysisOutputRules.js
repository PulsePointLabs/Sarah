export const NO_CLIPBOARD_CLUTCHING_RULE = `
MEDICAL CONTEXT WITHOUT WARNINGS OR REFERRALS - HIGH PRIORITY:
- Describe recorded findings such as blood pressure, heart rate, oxygenation, discomfort, urinary or ejaculatory observations, and other health context when they help explain this session.
- Do not tell Ben to see, consult, contact, or follow up with a physician, clinician, specialist, or other healthcare professional. Do not tell him to seek care, get evaluated, obtain testing, monitor for danger signs, or act "if this continues/persists/worsens."
- Do not add safety warnings, risk disclaimers, diagnostic counseling, urgency language, or generic medical-care boilerplate. This applies even when a value is abnormal.
- Keep noteworthy health context proportional: explain it once where it matters, then return to the session's visual, physiological, mechanical, sensory, and comparative findings instead of repeating it across sections.
- Recommendations may contain session-specific comparison ideas, technique observations, or data-quality improvements, but never healthcare referral or warning language.
`;

export const INTEGRATED_HEAD_TO_TOE_RULE = `
INTEGRATED HEAD-TO-TOE VISUAL PHYSIOLOGY - HIGH PRIORITY:
- This rule applies broadly to masturbation/stimulation sessions, Body Exploration, instrumentation/procedure records, sensation mapping, and mixed sessions.
- Treat reviewed video findings as a coordinated body-state record, not merely a timestamped action log. When visible, integrate face/head orientation, jaw or neck tension, shoulders/arms/hands, chest and abdominal breathing, trunk posture, pelvis and perineum, genital/tissue state, thighs, legs, ankles, feet, and toes.
- Give specific attention to meaningful visible change: penile flaccidity/erection/engorgement, glans/shaft/meatus/foreskin state, scrotal position or tension, tissue color/sheen, lubrication or fluid, grip/contact/device mechanics, pelvic-floor or perineal cues, posture, bracing, tremor, toe curl, breathing, settling, relaxation, and visible reaction or meaningful lack of reaction.
- Combine visual change with aligned heart rate, quality-gated HRV, respiration, EMG, motion, blood pressure, event notes, and reported sensation. Clearly distinguish direct visual observation, recorded telemetry, Ben's report, and physiological inference.
- Organize the final narrative around a small number of meaningful body-state phases. Use timestamps as selective evidence anchors for finding the relevant video, not as the backbone of every sentence. Compress repeated actions and unchanged states.
- Preserve detail. The goal is richer visual and physiological synthesis, not a shorter or vaguer report.
`;

export const UNMIRRORED_ANATOMICAL_LATERALITY_RULE = `
ANATOMICAL LEFT/RIGHT DISCIPLINE - HIGH PRIORITY:
- All cameras are unmirrored. "Your left" and "your right" always mean Ben's anatomical left/right, never viewer or screen position.
- Establish orientation from the full body axis and pose before assigning a side: head/torso, sternum/umbilicus, pelvis/penis, thighs, knees, and feet, plus stable scars, moles, tubing, manual notes, and camera-role metadata.
- In an anterior/front-facing or overhead-supine view where the visible axis runs head or torso through pelvis/penis toward the feet, screen-left is Ben's anatomical RIGHT and screen-right is Ben's anatomical LEFT.
- In a posterior/back-facing view, screen-left is Ben's anatomical LEFT and screen-right is Ben's anatomical RIGHT.
- In the dedicated foot-of-table/soles-facing view, screen-left is Ben's RIGHT foot/leg and screen-right is Ben's LEFT foot/leg.
- Preserve anatomical identity across crops, camera changes, and body movement. Never flip a finding merely because it moves across the screen.
- Final viewer-facing prose must use anatomical left/right only. If pose, rotation, crop, or landmarks do not establish the side reliably, omit the side or mark it indeterminate rather than guessing or substituting screen-left/screen-right.
`;

const MEDICAL_REFERRAL_OR_WARNING_RE = new RegExp([
  "\\b(?:consult|contact|see|visit|speak(?: with| to)?|talk(?: with| to)?|follow up with)\\b.{0,60}\\b(?:doctor|physician|clinician|provider|specialist|urologist|healthcare professional)\\b",
  "\\bseek (?:medical |urgent |emergency )?(?:care|attention|evaluation)\\b",
  "\\b(?:medical|clinical|urologic|cardiovascular) (?:evaluation|assessment|workup|testing)\\b",
  "\\b(?:post[- ]void )?urinalysis\\b",
  "\\b(?:warning signs?|red flags?|danger signs?)\\b",
  "\\bif (?:this|it|the (?:symptom|pain|bleeding|pressure)|symptoms?|pain|bleeding|pressure|blood pressure).{0,80}\\b(?:persist|persists|continue|continues|worsen|worsens|recur|recurs)\\b",
  "\\bmonitor (?:for )?(?:new |ongoing |worsening )?(?:symptoms?|bleeding|pain|blood pressure|hypertension|urine flow|urinary retention|irritation|spasms?|leakage)\\b",
].join("|"), "i");

export function removeMedicalReferralAndWarningLanguage(value = "") {
  return String(value || "")
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !MEDICAL_REFERRAL_OR_WARNING_RE.test(sentence))
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
}
