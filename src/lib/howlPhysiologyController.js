function finite(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export const DEFAULT_HOWL_PHYSIOLOGY_SETTINGS = Object.freeze({
  buildRampEnabled: true,
  finalApproachEnabled: true,
  nearClimaxReductionEnabled: true,
  recoveryReductionEnabled: true,
  buildStep: 1,
  finalApproachStep: 1,
  reduceStep: 2,
  maxRecoveryRetreat: 3,
  nearClimaxThreshold: 72,
  plateauThreshold: 60,
  buildThreshold: 32,
  recoveryThreshold: 55,
});

export function createHowlPhysiologyControllerState(currentIntensity = 0) {
  const intensity = Math.max(0, finite(currentIntensity));
  return {
    mode: "baseline",
    peakIntensity: intensity,
    recoveryFloor: intensity,
  };
}

export function computeHowlPhysiologyAction({
  prediction = {},
  multimodal = {},
  currentIntensity = 0,
  floor = 0,
  ceiling = 20,
  settings = {},
  state = createHowlPhysiologyControllerState(currentIntensity),
} = {}) {
  const config = { ...DEFAULT_HOWL_PHYSIOLOGY_SETTINGS, ...settings };
  const minimum = Math.max(0, finite(floor));
  const maximum = Math.max(minimum, finite(ceiling, 20));
  const current = clamp(Math.round(finite(currentIntensity)), minimum, maximum);
  const peakIntensity = clamp(Math.max(finite(state?.peakIntensity), current), minimum, maximum);
  const maxRetreat = Math.max(0, finite(config.maxRecoveryRetreat, 3));
  const recoveryFloor = config.nearClimaxReductionEnabled !== false
    ? clamp(peakIntensity - maxRetreat, minimum, maximum)
    : minimum;
  const confidence = finite(prediction.controllerConfidence, prediction.confirmationCount >= 2 ? 60 : 35);
  const trusted = prediction.multimodalTrusted !== false && confidence >= 55;
  const recoveryDrop = Math.max(
    finite(prediction.multimodalRecoveryDrop),
    finite(multimodal?.recovery?.currentDropBpm),
    finite(prediction.dropFromRecentPeak),
  );
  const hrvRelease = ["release", "opening"].includes(String(prediction.hrvSignal || "").toLowerCase());
  const extendedBreathHold = Boolean(prediction.possibleBreathHold) && finite(prediction.breathHoldDurationSeconds) >= 8;
  const recoveryEvidence = finite(prediction.recovery) >= finite(config.recoveryThreshold, 55)
    && (recoveryDrop >= 4 || hrvRelease || extendedBreathHold);
  const plateau = Boolean(prediction.plateauDwell)
    || finite(prediction.plateauScore) >= finite(config.plateauThreshold, 60);
  const threshold = finite(prediction.nearClimax) >= finite(config.nearClimaxThreshold, 72)
    && prediction.buildEligibleForNearClimax !== false;
  const build = finite(prediction.nearClimax) >= finite(config.buildThreshold, 32)
    && finite(prediction.recovery) < finite(config.recoveryThreshold, 55);

  let action = "hold";
  let target = current;
  let dwellMs = 0;
  let explanation = "Holding the current dose while physiology remains below the next control gate.";
  let mode = state?.mode || "baseline";

  if (!trusted) {
    mode = "signal_hold";
    explanation = `Holding at ${current}: controller confidence ${Math.round(confidence)}% is below the escalation gate.`;
  } else if (recoveryEvidence && config.recoveryReductionEnabled !== false) {
    mode = "recovery_retreat";
    target = Math.max(recoveryFloor, current - Math.max(0, finite(config.reduceStep, 2)));
    action = target < current ? "recovery_retreat" : "recovery_hold";
    dwellMs = 4500;
    explanation = target < current
      ? `Shallow recovery retreat to ${target}; cycle floor remains ${recoveryFloor} from peak ${peakIntensity}.`
      : `Recovery remains active, but the retained cycle floor ${recoveryFloor} prevents another intensity drop.`;
  } else if (state?.mode === "recovery_retreat" && current < peakIntensity && build) {
    mode = "reapproach";
    target = Math.min(peakIntensity, current + Math.max(0, finite(config.finalApproachStep, 1)));
    action = target > current ? "reapproach" : "hold";
    dwellMs = 5500;
    explanation = `Recovery evidence cleared; restoring the retained approach dose toward ${peakIntensity}.`;
  } else if ((threshold || plateau) && config.finalApproachEnabled !== false) {
    mode = threshold ? "final_approach" : "plateau_hold";
    const fallingFast = finite(prediction.approachVelocity) < -4;
    if (!fallingFast && current < maximum) {
      target = Math.min(maximum, current + Math.max(0, finite(config.finalApproachStep, 1)));
      action = target > current ? "final_approach" : "threshold_hold";
      dwellMs = 7000;
      explanation = `Threshold physiology is sustained; advancing one bounded step toward ceiling ${maximum}.`;
    } else {
      action = "threshold_hold";
      explanation = fallingFast
        ? `Holding at ${current} while approach velocity settles; no intensity is surrendered.`
        : `Holding the configured ceiling ${maximum} through the final approach.`;
    }
  } else if (build && config.buildRampEnabled !== false) {
    mode = "build";
    target = Math.min(maximum, current + Math.max(0, finite(config.buildStep, 1)));
    action = target > current ? "build_ramp" : "hold";
    dwellMs = 6000;
    explanation = target > current
      ? `Sustained loading supports a gradual build step to ${target}.`
      : `Holding the configured ceiling ${maximum}.`;
  }

  target = clamp(Math.round(target), minimum, maximum);
  return {
    action,
    target,
    dwellMs,
    explanation,
    trusted,
    recoveryEvidence,
    plateau,
    threshold,
    state: {
      mode,
      peakIntensity: Math.max(peakIntensity, target),
      recoveryFloor,
    },
  };
}
