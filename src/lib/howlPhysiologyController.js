function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function seconds(value, fallback) {
  return Math.max(0, finite(value, fallback)) * 1000;
}

function normalizeActivity(value) {
  return String(value || "").trim().toUpperCase();
}

export const DEFAULT_HOWL_PATTERN_WEIGHTS = Object.freeze({
  initial_contact: Object.freeze({ SINETIME: 35, VIBRATOR: 40, SIMPLEX: 25 }),
  build: Object.freeze({ VIBRATOR: 35, SIMPLEX: 30, RELENTLESS: 25, OVERFLOWING: 10 }),
  plateau: Object.freeze({ SIMPLEX: 35, VIBRATOR: 30, RELENTLESS: 25, OVERFLOWING: 10 }),
  final_approach: Object.freeze({ VIBRATOR: 40, RELENTLESS: 25, SIMPLEX: 20, OVERFLOWING: 10, MILKMASTER: 5 }),
  recovery: Object.freeze({ SINETIME: 40, VIBRATOR: 35, SIMPLEX: 25 }),
});

export const DEFAULT_HOWL_PATTERN_INTERVALS = Object.freeze({
  initial_contact: Object.freeze({ minSeconds: 60, maxSeconds: 120 }),
  build: Object.freeze({ minSeconds: 75, maxSeconds: 150 }),
  plateau: Object.freeze({ minSeconds: 120, maxSeconds: 240 }),
  final_approach: Object.freeze({ minSeconds: 90, maxSeconds: 180 }),
  recovery: Object.freeze({ minSeconds: 45, maxSeconds: 90 }),
});

export const DEFAULT_HOWL_PHYSIOLOGY_SETTINGS = Object.freeze({
  buildRampEnabled: true,
  finalApproachEnabled: true,
  nearClimaxReductionEnabled: true,
  recoveryReductionEnabled: true,
  buildStep: 1,
  finalApproachStep: 1,
  reduceStep: 2,
  nearClimaxThreshold: 72,
  plateauThreshold: 60,
  buildThreshold: 32,
  recoveryThreshold: 55,
  buildExitThreshold: 27,
  plateauExitThreshold: 54,
  finalApproachExitThreshold: 66,
  recoveryExitThreshold: 61,
  buildConfirmationSeconds: 12,
  plateauConfirmationSeconds: 15,
  finalApproachConfirmationSeconds: 10,
  recoveryConfirmationSeconds: 15,
  confidenceFullThreshold: 75,
  confidenceConservativeThreshold: 65,
  confidenceHoldThreshold: 55,
  lowConfidenceHoldSeconds: 10,
  telemetryReduceIntervalSeconds: 10,
  telemetryMuteTimeoutSeconds: 45,
  telemetryFreshnessMs: 5000,
  breathHoldAmbiguitySeconds: 12,
  recoveryObservationSeconds: 20,
  autoCooldownSeconds: 8,
  responseObservationSeconds: 10,
  buildUpwardPointsPerMinute: 4,
  finalApproachUpwardPointsPerMinute: 6,
  patternDirectorEnabled: false,
  patternMinimumHoldSeconds: 45,
  patternWeights: DEFAULT_HOWL_PATTERN_WEIGHTS,
  patternIntervals: DEFAULT_HOWL_PATTERN_INTERVALS,
});

export function createHowlPhysiologyControllerState(currentIntensity = 0) {
  const intensity = Math.max(0, finite(currentIntensity));
  return {
    mode: "baseline",
    phase: "initial_contact",
    candidatePhase: "",
    candidatePhaseSince: 0,
    phaseChangedAt: 0,
    phasePatternPending: false,
    peakIntensity: intensity,
    recoveryFloor: intensity,
    recoveryConfirmedAt: 0,
    recoveryInitialReductionDone: false,
    lowSignalSince: 0,
    lastFallbackReductionAt: 0,
    breathHoldAmbiguousUntil: 0,
    lastIntensityChangeAt: 0,
    upwardChanges: [],
    patternPhase: "initial_contact",
    patternActivity: "",
    recentPatternActivities: [],
    patternChangedAt: 0,
    nextPatternEligibleAt: 0,
    lastReason: "Controller initialized disarmed.",
    faulted: false,
  };
}

export function confidencePermissionBand(confidence, settings = {}) {
  const config = { ...DEFAULT_HOWL_PHYSIOLOGY_SETTINGS, ...settings };
  const score = finite(confidence, 0);
  if (score >= finite(config.confidenceFullThreshold, 75)) return "full";
  if (score >= finite(config.confidenceConservativeThreshold, 65)) return "conservative";
  if (score >= finite(config.confidenceHoldThreshold, 55)) return "hold";
  return "low";
}

function mergePatternConfig(defaults, custom) {
  const output = {};
  for (const [phase, values] of Object.entries(defaults)) {
    output[phase] = { ...values, ...(custom?.[phase] || {}) };
  }
  return output;
}

function controllerConfig(settings = {}) {
  return {
    ...DEFAULT_HOWL_PHYSIOLOGY_SETTINGS,
    ...settings,
    patternWeights: mergePatternConfig(DEFAULT_HOWL_PATTERN_WEIGHTS, settings.patternWeights),
    patternIntervals: mergePatternConfig(DEFAULT_HOWL_PATTERN_INTERVALS, settings.patternIntervals),
  };
}

function recoverySignals(prediction = {}, multimodal = {}, config = {}) {
  const currentHr = finite(
    prediction.currentHr,
    finite(multimodal?.currentHr, finite(multimodal?.hr, 0)),
  );
  const localPeakHr = finite(
    prediction.localPeakHr,
    finite(prediction.recentPeakHr, currentHr + finite(prediction.dropFromRecentPeak)),
  );
  const dropBpm = Math.max(
    finite(prediction.multimodalRecoveryDrop),
    finite(multimodal?.recovery?.currentDropBpm),
    finite(prediction.dropFromRecentPeak),
    Math.max(0, localPeakHr - currentHr),
  );
  const requiredDrop = Math.max(4, localPeakHr > 0 ? localPeakHr * 0.03 : 4);
  const hrSlope = finite(
    prediction.hrSlope,
    finite(multimodal?.recovery?.hrSlopeBpmPerMinute, finite(prediction.approachVelocity)),
  );
  const hrvOpening = ["release", "opening"].includes(String(prediction.hrvSignal || "").toLowerCase())
    || finite(prediction.hrvChange) > 0
    || finite(multimodal?.recovery?.hrvChange) > 0;
  const rrAvailable = prediction.rrAvailable === true
    || finite(prediction.rrCount) >= 8
    || multimodal?.respiration?.available === true;
  const rrNormalizing = prediction.rrNormalizing === true
    || multimodal?.respiration?.normalizing === true
    || finite(prediction.rrSlope) < 0;
  const multimodalRecovery = prediction.multimodalRecoverySlope === true
    || finite(multimodal?.recovery?.confidence) >= 0.6
    || finite(multimodal?.recovery?.score) >= 60;
  const recoveryScorePass = finite(prediction.recovery) >= finite(config.recoveryThreshold, 55);
  const hrDropPass = dropBpm >= requiredDrop;
  const hrSlopePass = hrSlope < 0;
  const corroboratingCount = [hrvOpening, rrNormalizing, multimodalRecovery].filter(Boolean).length;
  const additionalPass = rrAvailable
    ? (hrvOpening || rrNormalizing || multimodalRecovery)
    : (hrvOpening || multimodalRecovery);

  return {
    currentHr,
    localPeakHr,
    dropBpm,
    requiredDrop,
    hrSlope,
    hrvOpening,
    rrAvailable,
    rrNormalizing,
    multimodalRecovery,
    modalityCount: 1 + corroboratingCount,
    eligible: recoveryScorePass && hrDropPass && hrSlopePass && additionalPass,
  };
}

function desiredPhase({ prediction, state, recovery, config }) {
  const approach = finite(prediction.nearClimax);
  const plateau = finite(prediction.plateauScore);
  const current = state.phase || "initial_contact";

  if (recovery.eligible) return "recovery";
  if (current === "recovery") {
    if (approach <= finite(config.recoveryExitThreshold, 61)) return "recovery";
    if (approach >= finite(config.nearClimaxThreshold, 72)) return "final_approach";
    if (plateau >= finite(config.plateauThreshold, 60)) return "plateau";
    return approach >= finite(config.buildThreshold, 32) ? "build" : "initial_contact";
  }
  if (current === "final_approach") {
    if (approach >= finite(config.finalApproachExitThreshold, 66)) return "final_approach";
    return plateau >= finite(config.plateauExitThreshold, 54) ? "plateau" : "build";
  }
  if (current === "plateau") {
    if (approach >= finite(config.nearClimaxThreshold, 72) && prediction.buildEligibleForNearClimax !== false) {
      return "final_approach";
    }
    if (plateau >= finite(config.plateauExitThreshold, 54)) return "plateau";
    return approach >= finite(config.buildExitThreshold, 27) ? "build" : "initial_contact";
  }
  if (current === "build") {
    if (approach >= finite(config.nearClimaxThreshold, 72) && prediction.buildEligibleForNearClimax !== false) {
      return "final_approach";
    }
    if (plateau >= finite(config.plateauThreshold, 60)) return "plateau";
    return approach >= finite(config.buildExitThreshold, 27) ? "build" : "initial_contact";
  }
  if (approach >= finite(config.nearClimaxThreshold, 72) && prediction.buildEligibleForNearClimax !== false) {
    return "final_approach";
  }
  if (plateau >= finite(config.plateauThreshold, 60)) return "plateau";
  return approach >= finite(config.buildThreshold, 32) ? "build" : "initial_contact";
}

function confirmationMs(phase, config) {
  if (phase === "build") return seconds(config.buildConfirmationSeconds, 12);
  if (phase === "plateau") return seconds(config.plateauConfirmationSeconds, 15);
  if (phase === "final_approach") return seconds(config.finalApproachConfirmationSeconds, 10);
  if (phase === "recovery") return seconds(config.recoveryConfirmationSeconds, 15);
  return seconds(config.buildConfirmationSeconds, 12);
}

function advancePhase({ prediction, state, recovery, config, now, frozen }) {
  const previousPhase = state.phase || "initial_contact";
  if (frozen) {
    return {
      state: { ...state, candidatePhase: "", candidatePhaseSince: 0 },
      phaseChanged: false,
      candidateElapsedMs: 0,
    };
  }
  const wanted = desiredPhase({ prediction, state, recovery, config });
  if (wanted === previousPhase) {
    return {
      state: { ...state, candidatePhase: "", candidatePhaseSince: 0 },
      phaseChanged: false,
      candidateElapsedMs: 0,
    };
  }
  const candidateSince = state.candidatePhase === wanted && state.candidatePhaseSince > 0
    ? state.candidatePhaseSince
    : now;
  const candidateElapsedMs = Math.max(0, now - candidateSince);
  if (candidateElapsedMs < confirmationMs(wanted, config)) {
    return {
      state: { ...state, candidatePhase: wanted, candidatePhaseSince: candidateSince },
      phaseChanged: false,
      candidateElapsedMs,
    };
  }
  return {
    state: {
      ...state,
      phase: wanted,
      patternPhase: wanted,
      candidatePhase: "",
      candidatePhaseSince: 0,
      phaseChangedAt: now,
      phasePatternPending: true,
      recoveryConfirmedAt: wanted === "recovery" ? now : state.recoveryConfirmedAt,
      recoveryInitialReductionDone: wanted === "recovery" ? false : state.recoveryInitialReductionDone,
    },
    phaseChanged: true,
    candidateElapsedMs: 0,
  };
}

function cleanUpwardChanges(changes, now) {
  return (Array.isArray(changes) ? changes : [])
    .filter((entry) => now - finite(entry?.at) < 60_000)
    .map((entry) => ({ at: finite(entry.at), points: Math.max(0, finite(entry.points)) }));
}

function upwardBudget(phase, config, changes) {
  const limit = phase === "final_approach"
    ? finite(config.finalApproachUpwardPointsPerMinute, 6)
    : finite(config.buildUpwardPointsPerMinute, 4);
  return Math.max(0, limit - changes.reduce((sum, entry) => sum + entry.points, 0));
}

function clearlySustainedUpwardTrend(prediction = {}) {
  return finite(prediction.approachVelocity) > 0
    && finite(prediction.confirmationCount) >= 2
    && prediction.multimodalTrusted !== false;
}

export function computeHowlPhysiologyAction({
  prediction = {},
  multimodal = {},
  currentIntensity = 0,
  floor = 0,
  ceiling = 20,
  settings = {},
  state = createHowlPhysiologyControllerState(currentIntensity),
  now = Date.now(),
  telemetryFresh = true,
  commandPending = false,
} = {}) {
  const config = controllerConfig(settings);
  const minimum = Math.max(0, finite(floor));
  const maximum = Math.max(minimum, finite(ceiling, 20));
  const current = clamp(Math.round(finite(currentIntensity)), minimum, maximum);
  const confidence = finite(prediction.controllerConfidence, 0);
  const permissionBand = confidencePermissionBand(confidence, config);
  const breathHold = Boolean(prediction.possibleBreathHold)
    && finite(prediction.breathHoldDurationSeconds) >= 8;
  const ambiguousUntil = breathHold
    ? Math.max(finite(state.breathHoldAmbiguousUntil), now + seconds(config.breathHoldAmbiguitySeconds, 12))
    : finite(state.breathHoldAmbiguousUntil);
  const breathHoldAmbiguous = breathHold || now < ambiguousUntil;
  const telemetryInvalid = telemetryFresh !== true;
  const confidenceLimited = permissionBand === "low" || prediction.multimodalTrusted === false;
  const signalInvalid = telemetryInvalid || confidenceLimited;
  const lowSignalSince = telemetryInvalid ? (finite(state.lowSignalSince) || now) : 0;
  const lowSignalElapsedMs = lowSignalSince ? Math.max(0, now - lowSignalSince) : 0;
  const staleHoldMs = seconds(config.lowConfidenceHoldSeconds, 10);
  const muteTimeoutMs = seconds(config.telemetryMuteTimeoutSeconds, 45);
  const fallbackIntervalMs = seconds(config.telemetryReduceIntervalSeconds, 10);
  const recovery = recoverySignals(prediction, multimodal, config);
  const frozen = signalInvalid || permissionBand === "hold" || breathHoldAmbiguous;
  const phaseResult = advancePhase({
    prediction,
    state: { ...state, breathHoldAmbiguousUntil: ambiguousUntil },
    recovery,
    config,
    now,
    frozen,
  });
  let nextState = {
    ...phaseResult.state,
    lowSignalSince,
    upwardChanges: cleanUpwardChanges(state.upwardChanges, now),
    peakIntensity: Math.max(finite(state.peakIntensity), current),
    recoveryFloor: minimum,
    faulted: Boolean(state.faulted),
  };
  const phase = nextState.phase || "initial_contact";
  let action = "hold";
  let target = current;
  let explanation = "Holding current bounded output.";

  if (commandPending) {
    explanation = "Holding while the previous Howl command is unresolved.";
  } else if (telemetryInvalid) {
    if (lowSignalElapsedMs >= muteTimeoutMs) {
      action = "mute_disarm";
      target = 0;
      nextState = { ...nextState, faulted: true, lastReason: "Telemetry timeout; muted and disarmed." };
      explanation = "Telemetry remained unavailable; muting and requiring explicit rearming.";
    } else if (
      lowSignalElapsedMs >= staleHoldMs
      && current > minimum
      && (
        !finite(state.lastFallbackReductionAt)
        || now - finite(state.lastFallbackReductionAt) >= fallbackIntervalMs
      )
    ) {
      action = "fallback_reduce";
      target = Math.max(minimum, current - 1);
      nextState = {
        ...nextState,
        lastFallbackReductionAt: now,
        lastIntensityChangeAt: now,
        lastReason: "Staged telemetry fallback reduced intensity by one point.",
      };
      explanation = `Signal remained invalid for ${Math.round(lowSignalElapsedMs / 1000)}s; reducing one point while awaiting recovery.`;
    } else {
      explanation = `Signal invalid for ${Math.round(lowSignalElapsedMs / 1000)}s; holding and freezing pattern changes.`;
    }
  } else if (confidenceLimited) {
    explanation = `Controller confidence ${Math.round(confidence)}% is limited; holding verified output and freezing automatic changes.`;
  } else if (breathHoldAmbiguous) {
    explanation = "Suspected breath hold is ambiguous; holding output and freezing phase changes pending the post-hold trajectory.";
  } else if (permissionBand === "hold") {
    explanation = `Controller confidence ${Math.round(confidence)}% permits hold only; no pattern or intensity escalation.`;
  } else if (phase === "recovery" && config.recoveryReductionEnabled !== false) {
    const observedMs = Math.max(0, now - finite(nextState.recoveryConfirmedAt, now));
    if (!nextState.recoveryInitialReductionDone) {
      target = Math.max(minimum, current - Math.max(0, finite(config.reduceStep, 2)));
      action = target < current ? "recovery_retreat" : "recovery_hold";
      nextState = {
        ...nextState,
        recoveryInitialReductionDone: true,
        lastIntensityChangeAt: target !== current ? now : nextState.lastIntensityChangeAt,
        lastReason: target !== current ? "Confirmed recovery initial reduction." : "Recovery confirmed at configured floor.",
      };
      explanation = target < current
        ? `Recovery confirmed; keeping the current activity and reducing intensity to ${target}.`
        : `Recovery confirmed at the configured floor ${minimum}.`;
    } else if (observedMs < seconds(config.recoveryObservationSeconds, 20)) {
      explanation = `Recovery confirmed; observing the current activity for ${Math.ceil((seconds(config.recoveryObservationSeconds, 20) - observedMs) / 1000)}s.`;
    } else if (recovery.eligible && current > minimum) {
      target = Math.max(minimum, current - Math.max(0, finite(config.reduceStep, 2)));
      action = target < current ? "recovery_retreat" : "recovery_hold";
      nextState = {
        ...nextState,
        lastIntensityChangeAt: target !== current ? now : nextState.lastIntensityChangeAt,
        lastReason: "Persistent recovery supported deeper bounded reduction.",
      };
      explanation = `Recovery trajectory persists; deeper bounded reduction to ${target} is permitted.`;
    } else {
      explanation = "Recovery observation continues with the current activity.";
    }
  } else if (state.phase === "recovery" && phase !== "recovery" && current < finite(nextState.peakIntensity)) {
    const responseWaitMs = seconds(config.responseObservationSeconds, 10);
    if (now - finite(nextState.lastIntensityChangeAt) < responseWaitMs) {
      explanation = "Recovery cleared; waiting for the last intensity response before re-approach.";
    } else {
      target = Math.min(maximum, finite(nextState.peakIntensity), current + 1);
      action = target > current ? "reapproach" : "hold";
      if (target > current) {
        nextState = {
          ...nextState,
          lastIntensityChangeAt: now,
          upwardChanges: [...nextState.upwardChanges, { at: now, points: target - current }],
          lastReason: "Recovery cleared; returning one point toward retained cycle peak.",
        };
      }
      explanation = `Recovery cleared; returning one point toward retained peak ${nextState.peakIntensity}.`;
    }
  } else {
    const isEscalationPhase = phase === "build" || phase === "plateau" || phase === "final_approach";
    const conservativePermits = permissionBand !== "conservative" || clearlySustainedUpwardTrend(prediction);
    const responseWaitMs = seconds(config.responseObservationSeconds, 10);
    const responseWaitPassed = now - finite(nextState.lastIntensityChangeAt) >= responseWaitMs;
    const phaseEnabled = phase === "build"
      ? config.buildRampEnabled !== false
      : config.finalApproachEnabled !== false;
    const requestedStep = phase === "build"
      ? Math.max(0, finite(config.buildStep, 1))
      : Math.max(0, finite(config.finalApproachStep, 1));
    const budget = upwardBudget(phase === "final_approach" ? "final_approach" : "build", config, nextState.upwardChanges);
    const step = Math.min(requestedStep, budget, maximum - current);

    if (!isEscalationPhase || !phaseEnabled) {
      explanation = `Holding in confirmed ${phase.replaceAll("_", " ")} phase.`;
    } else if (!conservativePermits) {
      explanation = `Confidence ${Math.round(confidence)}% is conservative; upward physiology is not yet clearly sustained.`;
    } else if (!responseWaitPassed) {
      explanation = `Waiting ${Math.ceil((responseWaitMs - (now - finite(nextState.lastIntensityChangeAt))) / 1000)}s to observe the prior intensity response.`;
    } else if (step <= 0) {
      explanation = current >= maximum
        ? `Holding configured ceiling ${maximum}.`
        : "Rolling upward rate limit is active.";
    } else {
      target = Math.min(maximum, current + step);
      action = phase === "build" ? "build_ramp" : "final_approach";
      nextState = {
        ...nextState,
        peakIntensity: Math.max(nextState.peakIntensity, target),
        lastIntensityChangeAt: now,
        upwardChanges: [...nextState.upwardChanges, { at: now, points: target - current }],
        lastReason: `Confirmed ${phase.replaceAll("_", " ")} escalation.`,
      };
      explanation = `Confirmed ${phase.replaceAll("_", " ")} physiology supports a bounded step to ${target}.`;
    }
  }

  target = action === "mute_disarm" ? 0 : clamp(Math.round(target), minimum, maximum);
  const mode = action === "fallback_reduce" || action === "mute_disarm"
    ? "signal_hold"
    : phase === "recovery"
      ? "recovery_retreat"
      : phase;
  nextState = {
    ...nextState,
    mode,
    lastReason: nextState.lastReason || explanation,
  };

  return {
    action,
    target,
    dwellMs: 0,
    explanation,
    trusted: !signalInvalid && permissionBand !== "hold",
    permissionBand,
    telemetryFresh: telemetryFresh === true,
    breathHoldAmbiguous,
    recoveryEvidence: recovery.eligible,
    recoverySignals: recovery,
    plateau: phase === "plateau",
    threshold: phase === "final_approach",
    phase,
    approachScore: finite(prediction.nearClimax),
    candidatePhase: nextState.candidatePhase,
    candidatePhaseElapsedMs: nextState.candidatePhaseSince ? Math.max(0, now - nextState.candidatePhaseSince) : 0,
    phaseChanged: phaseResult.phaseChanged,
    state: nextState,
  };
}

function randomizedIntervalMs(phase, config, random) {
  const interval = config.patternIntervals?.[phase] || DEFAULT_HOWL_PATTERN_INTERVALS.initial_contact;
  const minMs = seconds(interval.minSeconds, 60);
  const maxMs = Math.max(minMs, seconds(interval.maxSeconds, 120));
  return minMs + clamp(finite(random(), 0), 0, 0.999999) * (maxMs - minMs);
}

export function selectWeightedHowlActivity({
  phase = "initial_contact",
  approachScore = 0,
  currentActivity = "",
  recentActivities = [],
  weights = DEFAULT_HOWL_PATTERN_WEIGHTS,
  random = Math.random,
} = {}) {
  const phaseWeights = { ...(weights?.[phase] || DEFAULT_HOWL_PATTERN_WEIGHTS[phase] || {}) };
  if (phase === "build" && finite(approachScore) < 50) delete phaseWeights.OVERFLOWING;
  const current = normalizeActivity(currentActivity);
  const excluded = new Set(
    [current, ...(Array.isArray(recentActivities) ? recentActivities.slice(0, 2) : [])]
      .map(normalizeActivity)
      .filter(Boolean),
  );
  let candidates = Object.entries(phaseWeights)
    .map(([activity, weight]) => [normalizeActivity(activity), Math.max(0, finite(weight))])
    .filter(([activity, weight]) => activity && weight > 0 && !excluded.has(activity));
  if (!candidates.length) {
    candidates = Object.entries(phaseWeights)
      .map(([activity, weight]) => [normalizeActivity(activity), Math.max(0, finite(weight))])
      .filter(([activity, weight]) => activity && weight > 0 && activity !== current);
  }
  if (!candidates.length) {
    candidates = Object.entries(phaseWeights)
      .map(([activity, weight]) => [normalizeActivity(activity), Math.max(0, finite(weight))])
      .filter(([activity, weight]) => activity && weight > 0);
  }
  const total = candidates.reduce((sum, [, weight]) => sum + weight, 0);
  if (total <= 0) return "";
  let cursor = clamp(finite(random(), 0), 0, 0.999999) * total;
  for (const [activity, weight] of candidates) {
    cursor -= weight;
    if (cursor < 0) return activity;
  }
  return candidates.at(-1)?.[0] || "";
}

export function adjustActivityWeightsWithHistory({ baseWeights = {}, responseHistory = [] } = {}) {
  void responseHistory;
  return { ...baseWeights };
}

export function computeHowlPatternAction({
  decision = {},
  currentActivity = "",
  settings = {},
  state = createHowlPhysiologyControllerState(),
  now = Date.now(),
  random = Math.random,
  commandPending = false,
  manualRequest = false,
  sustainedResponseLoss = false,
  maximumDurationReached = false,
} = {}) {
  const config = controllerConfig(settings);
  const phase = decision.phase || state.phase || "initial_contact";
  const previousActivity = normalizeActivity(currentActivity || state.patternActivity);
  let nextState = {
    ...state,
    patternPhase: phase,
    patternActivity: previousActivity,
  };

  if (config.patternDirectorEnabled !== true) {
    return { action: "hold", activityName: "", phase, explanation: "Pattern director is off.", state: nextState };
  }
  if (commandPending) {
    return { action: "hold", activityName: "", phase, explanation: "Pattern locked while a Howl command is pending.", state: nextState };
  }
  if (decision.telemetryFresh !== true || ["hold", "low"].includes(decision.permissionBand) || decision.breathHoldAmbiguous) {
    return { action: "hold", activityName: "", phase, explanation: "Pattern locked by signal freshness, confidence, or breath-hold ambiguity.", state: nextState };
  }
  if (!["hold", "recovery_hold"].includes(decision.action)) {
    return { action: "hold", activityName: "", phase, explanation: "Pattern held so intensity and activity do not change in the same controller cycle.", state: nextState };
  }

  const minimumHoldMs = seconds(config.patternMinimumHoldSeconds, 45);
  const phaseChanged = decision.phaseChanged === true;
  const earlyReason = manualRequest
    || sustainedResponseLoss
    || maximumDurationReached
    || phaseChanged
    || state.phasePatternPending === true;
  const holdElapsed = !previousActivity || now - finite(state.patternChangedAt) >= minimumHoldMs;
  if (!holdElapsed && !earlyReason) {
    return { action: "hold", activityName: "", phase, explanation: `Holding ${previousActivity} through the minimum pattern window.`, state: nextState };
  }
  if (
    phase === "recovery"
    && finite(state.recoveryConfirmedAt) > 0
    && now - finite(state.recoveryConfirmedAt) < seconds(config.recoveryObservationSeconds, 20)
  ) {
    return { action: "hold", activityName: "", phase, explanation: "Keeping the current activity through the initial recovery observation window.", state: nextState };
  }

  let eligibleAt = finite(state.nextPatternEligibleAt);
  if (!eligibleAt && previousActivity) {
    eligibleAt = finite(state.patternChangedAt) + randomizedIntervalMs(phase, config, random);
    nextState = { ...nextState, nextPatternEligibleAt: eligibleAt };
  }
  if (previousActivity && !earlyReason && now < eligibleAt) {
    return { action: "hold", activityName: "", phase, explanation: `Next pattern selection is scheduled in ${Math.ceil((eligibleAt - now) / 1000)}s.`, state: nextState };
  }

  const effectiveWeights = adjustActivityWeightsWithHistory({
    baseWeights: config.patternWeights,
    responseHistory: [],
  });
  const activityName = selectWeightedHowlActivity({
    phase,
    approachScore: decision?.recoverySignals?.approachScore ?? decision?.approachScore ?? 0,
    currentActivity: previousActivity,
    recentActivities: state.recentPatternActivities,
    weights: effectiveWeights,
    random,
  });
  if (!activityName || (activityName === previousActivity && !manualRequest)) {
    return { action: "hold", activityName: "", phase, explanation: "No different eligible verified Howl activity is available.", state: nextState };
  }

  const recent = [activityName, previousActivity, ...(state.recentPatternActivities || [])]
    .map(normalizeActivity)
    .filter(Boolean)
    .slice(0, 2);
  const nextEligibleAt = now + randomizedIntervalMs(phase, config, random);
  return {
    action: "load_activity",
    activityName,
    phase,
    explanation: `Switching to ${activityName} for the confirmed ${phase.replaceAll("_", " ")} phase.`,
    state: {
      ...nextState,
      patternActivity: activityName,
      recentPatternActivities: recent,
      patternChangedAt: now,
      nextPatternEligibleAt: nextEligibleAt,
      phasePatternPending: false,
      lastReason: phaseChanged ? "Confirmed phase transition selected a new activity." : "Scheduled pattern interval elapsed.",
    },
  };
}
