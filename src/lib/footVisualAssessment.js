export const FOOT_VISUAL_REVIEW_RULE = `FEET / LOWER-BODY STATE RULE:
- Separate posture from motion. Reduced oscillation or no captured movement does not mean relaxation; a foot can remain strongly plantar-flexed, toes curled, and braced while moving less.
- Plantar flexion means the forefoot/toes point away from the shin at the ankle. Toe curl is flexion of the digits and must be assessed separately. Bracing/planting means visible sustained loading or pressing through the heel, sole, forefoot, or toes; do not infer it from screen height alone.
- Never use "flatter", "low-angle", "settled", or "lower tension" as a substitute for an anatomical state. Name the ankle state, toe state, visible bracing, and movement independently for anatomical left and right.
- A relaxation/decreased-tension claim requires a visible transition across at least two ordered supporting frames: ankle position moves toward neutral or dorsiflexion, toes visibly uncurl/extend, and bracing visibly decreases. If plantar flexion, toe curl, or bracing remains, report reduced movement while the posture/tension remains instead of calling relaxation.
- Absence of the prior window's cyclic movement is evidence only that the cycle was not captured in this window. It is not evidence of neutral posture, release, or reduced tension.
- Complete foot_assessment from current frames before writing the summary, findings, or events. Current-frame anatomy overrides prior-window wording.`;

const SIDE_SCHEMA = {
  type: "object",
  properties: {
    ankle_state: { type: "string", enum: ["plantar_flexed", "neutral", "dorsiflexed", "uncertain"] },
    toe_state: { type: "string", enum: ["curled", "neutral", "extended_or_splayed", "obscured", "uncertain"] },
    bracing_state: { type: "string", enum: ["braced", "not_braced", "uncertain"] },
    movement_state: { type: "string", enum: ["increasing_flexion", "decreasing_flexion", "oscillating", "stable", "uncertain"] },
    evidence_frames: { type: "array", maxItems: 8, items: { type: "number" } },
  },
  required: ["ankle_state", "toe_state", "bracing_state", "movement_state", "evidence_frames"],
};

export const FOOT_ASSESSMENT_SCHEMA = {
  type: "object",
  properties: {
    left: SIDE_SCHEMA,
    right: SIDE_SCHEMA,
    bilateral_change: { type: "string", enum: ["increased_tension", "decreased_tension", "mixed", "unchanged", "uncertain"] },
    relaxation_supported: { type: "boolean" },
    relaxation_evidence: { type: "string" },
  },
  required: ["left", "right", "bilateral_change", "relaxation_supported", "relaxation_evidence"],
};

const RELAXATION_CLAIM_RE = /\b(?:relax(?:ed|ation|es|ing)?|lower[- ]tension|tension (?:decreas|drop)|flatter|flat resting|low-angle resting|return(?:s|ed|ing)? toward neutral|settle(?:s|d|ing)?|release(?:s|d|ing)?)\b/i;

function sideSupportsRelaxation(side = {}) {
  const ankleReleased = side.ankle_state === "neutral" || side.ankle_state === "dorsiflexed";
  const toesReleased = side.toe_state === "neutral" || side.toe_state === "extended_or_splayed";
  const enoughFrames = Array.isArray(side.evidence_frames) && new Set(side.evidence_frames.map(Number).filter(Number.isFinite)).size >= 2;
  return ankleReleased
    && toesReleased
    && side.bracing_state === "not_braced"
    && side.movement_state === "decreasing_flexion"
    && enoughFrames;
}

export function isFootRelaxationClaim(value = "") {
  return RELAXATION_CLAIM_RE.test(String(value || ""));
}

export function footRelaxationIsSupported(assessment = {}, claimText = "") {
  if (!assessment || assessment.relaxation_supported !== true || assessment.bilateral_change !== "decreased_tension") return false;
  const text = String(claimText || "").toLowerCase();
  const left = sideSupportsRelaxation(assessment.left);
  const right = sideSupportsRelaxation(assessment.right);
  if (/\b(?:both|bilateral|feet|lower[- ]body)\b/.test(text)) return left && right;
  if (/\bleft\b/.test(text) && !/\bright\b/.test(text)) return left;
  if (/\bright\b/.test(text) && !/\bleft\b/.test(text)) return right;
  return left && right;
}

export function keepFootVisualItem(item = {}, assessment = null) {
  const text = [item.title, item.text, item.findingText, item.note, item.observation, item.change_from_prior]
    .filter(Boolean)
    .join(" ");
  return !isFootRelaxationClaim(text) || footRelaxationIsSupported(assessment, text);
}

function sideStateText(label, side = {}) {
  const parts = [];
  if (side.ankle_state && side.ankle_state !== "uncertain") parts.push(side.ankle_state.replaceAll("_", " "));
  if (side.toe_state && !["uncertain", "obscured"].includes(side.toe_state)) parts.push(`toes ${side.toe_state.replaceAll("_", " ")}`);
  if (side.bracing_state === "braced") parts.push("visible bracing");
  return parts.length ? `${label}: ${parts.join(", ")}` : "";
}

export function footAssessmentSummary(assessment = {}) {
  const states = [sideStateText("Your left foot", assessment.left), sideStateText("your right foot", assessment.right)].filter(Boolean);
  if (!states.length) return "Current foot posture is uncertain; reduced sampled movement alone does not establish relaxation.";
  return `${states.join("; ")}. Reduced sampled movement alone does not establish relaxation.`;
}

export function sanitizeFootSummary(summary = "", assessment = null) {
  if (!assessment || !isFootRelaxationClaim(summary) || footRelaxationIsSupported(assessment, summary)) return String(summary || "").trim();
  const retained = String(summary || "")
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !isFootRelaxationClaim(sentence))
    .join(" ")
    .trim();
  return retained || footAssessmentSummary(assessment);
}
