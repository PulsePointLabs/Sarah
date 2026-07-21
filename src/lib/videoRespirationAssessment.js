const CONFIDENCE_LEVELS = new Set(["low", "moderate", "high"]);
const VISIBILITY_LEVELS = new Set(["unavailable", "limited", "adequate", "good"]);

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function normalizeVideoRespirationAssessment(raw, fallbackWindow = {}, selectedRole = "main") {
  if (!raw || typeof raw !== "object" || selectedRole === "feet") return null;

  const windowStart = Math.max(0, Number(fallbackWindow.start || 0));
  const windowEnd = Math.max(windowStart, Number(fallbackWindow.end || windowStart));
  const windowDuration = Math.max(0, windowEnd - windowStart);
  const visibility = VISIBILITY_LEVELS.has(raw.visibility_quality) ? raw.visibility_quality : "unavailable";
  const confidence = CONFIDENCE_LEVELS.has(raw.confidence) ? raw.confidence : "low";
  const observationSeconds = clamp(Number(raw.observation_seconds || 0), 0, windowDuration || 180);
  const breathsObserved = clamp(Math.round(Number(raw.breaths_observed || 0)), 0, 30);
  const rawRate = Number(raw.estimated_rate_bpm || 0);
  const rateSupported = Boolean(raw.assessable)
    && ["adequate", "good"].includes(visibility)
    && confidence !== "low"
    && observationSeconds >= 8
    && breathsObserved >= 2
    && rawRate >= 3
    && rawRate <= 80;

  const holdStart = clamp(Number(raw.hold_start_time_s || windowStart), windowStart, windowEnd);
  const holdEnd = clamp(Number(raw.hold_end_time_s || holdStart), holdStart, windowEnd);
  const reportedHoldDuration = Number(raw.hold_duration_seconds || 0);
  const holdDuration = clamp(Math.max(reportedHoldDuration, holdEnd - holdStart), 0, windowDuration);
  const holdSupported = Boolean(raw.assessable)
    && Boolean(raw.possible_breath_hold)
    && ["adequate", "good"].includes(visibility)
    && confidence !== "low"
    && holdDuration >= 4;

  return {
    assessable: Boolean(raw.assessable) && ["adequate", "good"].includes(visibility),
    visibilityQuality: visibility,
    breathsObserved,
    observationSeconds: Number(observationSeconds.toFixed(1)),
    estimatedRateBpm: rateSupported ? Number(rawRate.toFixed(1)) : null,
    possibleBreathHold: holdSupported,
    holdStartTimeSeconds: holdSupported ? Number(holdStart.toFixed(1)) : null,
    holdEndTimeSeconds: holdSupported ? Number(holdEnd.toFixed(1)) : null,
    holdDurationSeconds: holdSupported ? Number(holdDuration.toFixed(1)) : null,
    pattern: String(raw.pattern || (holdSupported ? "possible_breath_hold" : "unavailable")),
    evidence: String(raw.evidence || "").trim(),
    confidence,
  };
}

export function respirationFindingForAssessment(assessment) {
  if (!assessment?.assessable) return null;
  const details = [];
  if (assessment.estimatedRateBpm != null) {
    details.push(`${assessment.breathsObserved} complete chest/abdominal cycles across ${assessment.observationSeconds.toFixed(1)} seconds support a rough visible rate of ${Math.round(assessment.estimatedRateBpm)} breaths/min`);
  }
  if (assessment.possibleBreathHold) {
    details.push(`a possible ${assessment.holdDurationSeconds.toFixed(1)}-second breath hold is visible, with shallow breathing or subtle obscured motion not fully excluded`);
  }
  if (!details.length) return null;
  return {
    title: assessment.possibleBreathHold ? "Possible breath hold" : "Visible breathing estimate",
    text: `${details.join("; ")}.`,
    category: "physiology",
    confidence: assessment.confidence,
  };
}

export function respirationEventForAssessment(assessment) {
  if (!assessment?.possibleBreathHold || assessment.holdStartTimeSeconds == null) return null;
  return {
    time_s: assessment.holdStartTimeSeconds,
    note: `Possible breath hold for about ${assessment.holdDurationSeconds.toFixed(1)} seconds based on sustained visible chest/abdominal stillness; shallow breathing remains a possible confounder.`,
    category: ["physical"],
    annotation_tags: ["respiration", "possible_breath_hold", "visual_estimate"],
    confidence: assessment.confidence,
  };
}
