import { randomUUID } from "node:crypto";

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function createHowlActivityExposure(input = {}) {
  const startedAt = input.start_time || input.startTime || new Date().toISOString();
  return {
    id: input.id || randomUUID(),
    session_id: input.session_id || input.sessionId || input.session || null,
    timestamp: input.timestamp || startedAt,
    physiological_phase: input.physiological_phase || input.physiologicalPhase || "initial_contact",
    activity_name: String(input.activity_name || input.activityName || "").trim().toUpperCase(),
    activity_variant: input.activity_variant || input.activityVariant || input.preset || null,
    channel_a_power: numberOrNull(input.channel_a_power ?? input.channelAPower),
    channel_b_power: numberOrNull(input.channel_b_power ?? input.channelBPower),
    frequency_range: input.frequency_range || input.frequencyRange || null,
    start_time: startedAt,
    end_time: input.end_time || input.endTime || null,
    approach_score_before: numberOrNull(input.approach_score_before ?? input.approachScoreBefore),
    approach_score_after: numberOrNull(input.approach_score_after ?? input.approachScoreAfter),
    hr_slope: numberOrNull(input.hr_slope ?? input.hrSlope),
    rr_slope: numberOrNull(input.rr_slope ?? input.rrSlope),
    hrv_change: numberOrNull(input.hrv_change ?? input.hrvChange),
    controller_confidence: numberOrNull(input.controller_confidence ?? input.controllerConfidence),
    signal_quality_score: numberOrNull(input.signal_quality_score ?? input.signalQualityScore),
    previous_activity: input.previous_activity || input.previousActivity || null,
    manual_increase: Boolean(input.manual_increase ?? input.manualIncrease),
    manual_decrease: Boolean(input.manual_decrease ?? input.manualDecrease),
    manual_activity_change: Boolean(input.manual_activity_change ?? input.manualActivityChange),
    manual_mute_or_emergency_stop: Boolean(input.manual_mute_or_emergency_stop ?? input.manualMuteOrEmergencyStop),
    recovery_followed: Boolean(input.recovery_followed ?? input.recoveryFollowed),
    final_approach_followed: Boolean(input.final_approach_followed ?? input.finalApproachFollowed),
    ended_early: Boolean(input.ended_early ?? input.endedEarly),
    selection_policy: input.selection_policy || input.selectionPolicy || "configured_weighted_random",
    created_at: input.created_at || new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

export function activityWeightInfluence(_context = {}) {
  return {};
}
