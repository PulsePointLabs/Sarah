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
- Treat reviewed video findings as a coordinated body-state record, not merely a timestamped action log. When visible, integrate face/head orientation, facial color or expression, jaw or neck tension, shoulders and upper back, arms and hands, chest and abdominal breathing, spinal or trunk posture, pelvis and perineum, genital and tissue state, thighs, legs, ankles, feet, and toes.
- Give specific attention to meaningful visible change: generalized or regional skin flushing, pallor, mottling, sheen, sweating, muscle definition or tension; shoulder lift or retraction; spinal extension or arching; abdominal bracing or release; pelvic tilt, lift, drop, rocking, or pulse-like movement; hand clench or release; thigh or leg bracing; tremor, shudder, spasm-like movement, toe curl, foot planting; breathing depth or interruption; penile flaccidity, erection, engorgement, glans, shaft, meatus, foreskin, scrotal and perineal state; lubrication or fluid; grip, contact, device, and procedure mechanics; settling, relaxation, and meaningful visible lack of reaction.
- Compare each meaningful change with the nearest comparable visible baseline and, when available, later recovery. Distinguish onset, increase, peak, persistence, decrease, return toward baseline, cyclic recurrence, asymmetry, and no sampled visible response. Do not treat lighting, exposure, camera angle, occlusion, or transmitted motion as physiology.
- Keep evidence lanes explicit. First state direct visual observation. Then, in the broader synthesis only, correlate it with recorded heart rate, quality-gated HRV, respiration measurements, EMG, motion telemetry, blood pressure, event notes, or reported sensation. Never rewrite telemetry as something the camera saw.
- Organize the final narrative around a small number of meaningful body-state phases. Use timestamps as selective evidence anchors for finding the relevant video, not as the backbone of every sentence. Compress repeated actions and unchanged states.
- Preserve detail. The goal is richer visual and physiological synthesis, not a shorter or vaguer report.
`;

export const SYSTEMATIC_VISIBLE_BODY_REVIEW_RULE = `
SYSTEMATIC VISIBLE-BODY REVIEW - HIGH PRIORITY:
- Before focusing on the main action, scan every visible region in a fixed order: head/face; jaw/neck; shoulders/upper back; arms/hands; chest; abdomen; spine/trunk; pelvis/hips/perineum; genital tissues; thighs; knees/calves; ankles; feet/toes; then the coordinated whole-body state.
- For every visible region, compare surface appearance, position/posture, muscle tension, movement, and change over the ordered frames. Look specifically for regional or generalized flushing, pallor, mottling, sheen or sweating; arching or spinal extension; shoulder, abdominal, pelvic, gluteal, thigh or leg bracing; hand clench; tremor, shudder, discrete spasm-like movement, rhythmic or pulse-like movement; toe curl, foot planting or splay; breathing-related rise/fall; settling and release.
- Describe the observable form and location before interpreting it. Do not infer orgasm, pain, pleasure, internal contraction, autonomic cause, or intent from movement or color alone.
- Compare with a similar earlier visible state and later recovery whenever available. Label the pattern as onset, increased, decreased, sustained, transient, cyclic, asymmetric, return toward baseline, no sampled visible response, or indeterminate.
- A sampled-frame review can support what appears in the supplied frames but cannot exclude a brief movement between frames. Phrase a lack of reaction as "no visible response in the sampled frames," never as proof that no response occurred.
- Omit obscured or off-camera anatomy instead of inventing normal findings. Treat lighting, exposure, shadow, compression, camera motion, crop changes, body rotation, and contact-transmitted movement as possible confounders.
`;

export const VISUAL_TELEMETRY_SEPARATION_RULE = `
VISUAL EVIDENCE AND TELEMETRY SEPARATION - HIGH PRIORITY:
- Visual annotation summaries, finding titles, finding text, and draft visual events must describe visible anatomy, body movement, posture, surface change, contact, device/procedure mechanics, fluid, or visibility limitations only.
- Do not include heart rate, beats per minute, HRV, RMSSD, blood pressure, SpO2, EMG values, Sarah overlay labels, phase labels, trend charts, timers, averages, maxima, or other telemetry in visual-card prose or visual event notes.
- Telemetry may help choose a review window and remains saved as separate aligned metadata. It may be correlated with accepted visual findings later in Session Analysis or Body Exploration Analysis, where it must be clearly labeled as recorded physiology rather than visual evidence.
- A telemetry change without a visible body change is not a visual finding. A visible body change remains useful even when telemetry is flat, missing, delayed, or discordant.
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
