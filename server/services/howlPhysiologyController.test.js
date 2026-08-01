import test from "node:test";
import assert from "node:assert/strict";

import {
  computeHowlPatternAction,
  computeHowlPhysiologyAction,
  confidencePermissionBand,
  createHowlPhysiologyControllerState,
  selectWeightedHowlActivity,
} from "../../src/lib/howlPhysiologyController.js";
import { isRuntimeAutoArmValid } from "./howlAutoArm.js";
import { executeReconciledHowlCommand } from "./howlCommandReconciler.js";

function prediction(overrides = {}) {
  return {
    nearClimax: 40,
    recovery: 10,
    plateauScore: 20,
    plateauDwell: false,
    buildEligibleForNearClimax: true,
    controllerConfidence: 82,
    multimodalTrusted: true,
    approachVelocity: 2,
    confirmationCount: 3,
    hrvSignal: "compressed",
    rrCount: 60,
    rrAvailable: true,
    rrNormalizing: false,
    dropFromRecentPeak: 1,
    hrSlope: 1,
    currentHr: 100,
    localPeakHr: 101,
    ...overrides,
  };
}

function cycle({
  sample = prediction(),
  state = createHowlPhysiologyControllerState(10),
  now = 20_000,
  currentIntensity = 10,
  settings = {},
  telemetryFresh = true,
  commandPending = false,
} = {}) {
  return computeHowlPhysiologyAction({
    prediction: sample,
    currentIntensity,
    floor: 3,
    ceiling: 20,
    settings,
    state,
    now,
    telemetryFresh,
    commandPending,
  });
}

test("confidence permission bands use configurable thresholds", () => {
  assert.equal(confidencePermissionBand(75), "full");
  assert.equal(confidencePermissionBand(70), "conservative");
  assert.equal(confidencePermissionBand(60), "hold");
  assert.equal(confidencePermissionBand(54), "low");
  assert.equal(confidencePermissionBand(80, { confidenceFullThreshold: 90 }), "conservative");
});

test("phase entry requires dwell and build exit uses hysteresis", () => {
  const first = cycle({ now: 1_000 });
  assert.equal(first.phase, "initial_contact");
  assert.equal(first.candidatePhase, "build");

  const entered = cycle({ now: 13_000, state: first.state });
  assert.equal(entered.phase, "build");
  assert.equal(entered.phaseChanged, true);

  const insideHysteresis = cycle({
    now: 20_000,
    state: entered.state,
    sample: prediction({ nearClimax: 28 }),
    currentIntensity: entered.target,
  });
  assert.equal(insideHysteresis.phase, "build");

  const exitCandidate = cycle({
    now: 21_000,
    state: insideHysteresis.state,
    sample: prediction({ nearClimax: 26 }),
    currentIntensity: insideHysteresis.target,
  });
  assert.equal(exitCandidate.candidatePhase, "initial_contact");
  const exited = cycle({
    now: 33_000,
    state: exitCandidate.state,
    sample: prediction({ nearClimax: 26 }),
    currentIntensity: exitCandidate.target,
  });
  assert.equal(exited.phase, "initial_contact");
});

test("plateau does not become recovery from score alone", () => {
  const plateauState = {
    ...createHowlPhysiologyControllerState(12),
    phase: "plateau",
    mode: "plateau",
  };
  const scoreOnly = cycle({
    now: 10_000,
    state: plateauState,
    currentIntensity: 12,
    sample: prediction({ nearClimax: 60, plateauScore: 66, recovery: 80 }),
  });
  assert.equal(scoreOnly.phase, "plateau");
  assert.equal(scoreOnly.recoveryEvidence, false);

  const recoveryCandidate = cycle({
    now: 11_000,
    state: scoreOnly.state,
    currentIntensity: 12,
    sample: prediction({
      nearClimax: 60,
      plateauScore: 66,
      recovery: 80,
      currentHr: 94,
      localPeakHr: 100,
      dropFromRecentPeak: 6,
      hrSlope: -5,
      hrvSignal: "opening",
    }),
  });
  assert.equal(recoveryCandidate.candidatePhase, "recovery");
  const recovered = cycle({
    now: 26_000,
    state: recoveryCandidate.state,
    currentIntensity: 12,
    sample: prediction({
      nearClimax: 60,
      plateauScore: 66,
      recovery: 80,
      currentHr: 94,
      localPeakHr: 100,
      dropFromRecentPeak: 6,
      hrSlope: -5,
      hrvSignal: "opening",
    }),
  });
  assert.equal(recovered.phase, "recovery");
  assert.equal(recovered.action, "recovery_retreat");
});

test("suspected breath hold freezes phase and escalation", () => {
  const state = { ...createHowlPhysiologyControllerState(10), phase: "build", mode: "build" };
  const result = cycle({
    state,
    sample: prediction({ possibleBreathHold: true, breathHoldDurationSeconds: 9, nearClimax: 80 }),
  });
  assert.equal(result.breathHoldAmbiguous, true);
  assert.equal(result.action, "hold");
  assert.equal(result.phase, "build");
});

test("pattern schedule is elapsed-time based and independent of refresh count", () => {
  const state = {
    ...createHowlPhysiologyControllerState(10),
    phase: "initial_contact",
    patternPhase: "initial_contact",
    patternActivity: "VIBRATOR",
    recentPatternActivities: ["VIBRATOR"],
    patternChangedAt: 1_000,
    nextPatternEligibleAt: 61_000,
  };
  const decision = {
    action: "hold",
    phase: "initial_contact",
    permissionBand: "full",
    telemetryFresh: true,
    breathHoldAmbiguous: false,
    state,
  };
  for (const now of [10_000, 20_000, 30_000, 45_000, 60_999]) {
    const held = computeHowlPatternAction({
      decision,
      currentActivity: "VIBRATOR",
      settings: { patternDirectorEnabled: true },
      state,
      now,
      random: () => 0,
    });
    assert.equal(held.action, "hold");
  }
  const changed = computeHowlPatternAction({
    decision,
    currentActivity: "VIBRATOR",
    settings: { patternDirectorEnabled: true },
    state,
    now: 61_000,
    random: () => 0,
  });
  assert.equal(changed.action, "load_activity");
  assert.notEqual(changed.activityName, "VIBRATOR");
  assert.ok(changed.state.nextPatternEligibleAt >= 121_000);
});

test("weighted selection honors explicit weights and build OVERFLOWING gate", () => {
  const onlyRelentless = selectWeightedHowlActivity({
    phase: "build",
    approachScore: 40,
    weights: { build: { RELENTLESS: 10, OVERFLOWING: 1000 } },
    random: () => 0.99,
  });
  assert.equal(onlyRelentless, "RELENTLESS");

  const overflowing = selectWeightedHowlActivity({
    phase: "build",
    approachScore: 50,
    weights: { build: { RELENTLESS: 10, OVERFLOWING: 1000 } },
    random: () => 0.99,
  });
  assert.equal(overflowing, "OVERFLOWING");
});

test("weighted selection excludes the current and previous two activities", () => {
  const selected = selectWeightedHowlActivity({
    phase: "plateau",
    currentActivity: "SIMPLEX",
    recentActivities: ["VIBRATOR", "RELENTLESS"],
    weights: { plateau: { SIMPLEX: 100, VIBRATOR: 100, RELENTLESS: 100, OVERFLOWING: 1 } },
    random: () => 0,
  });
  assert.equal(selected, "OVERFLOWING");
});

test("build and final approach rolling upward limits are enforced", () => {
  let state = { ...createHowlPhysiologyControllerState(10), phase: "build", mode: "build" };
  const first = cycle({ state, now: 20_000, settings: { buildStep: 2 } });
  assert.equal(first.target, 12);
  const second = cycle({ state: first.state, now: 31_000, currentIntensity: 12, settings: { buildStep: 2 } });
  assert.equal(second.target, 14);
  const limited = cycle({ state: second.state, now: 42_000, currentIntensity: 14, settings: { buildStep: 2 } });
  assert.equal(limited.action, "hold");

  state = { ...createHowlPhysiologyControllerState(10), phase: "final_approach", mode: "final_approach" };
  const finalOne = cycle({
    state,
    now: 20_000,
    sample: prediction({ nearClimax: 80, plateauScore: 75 }),
    settings: { finalApproachStep: 3 },
  });
  const finalTwo = cycle({
    state: finalOne.state,
    now: 31_000,
    currentIntensity: 13,
    sample: prediction({ nearClimax: 80, plateauScore: 75 }),
    settings: { finalApproachStep: 3 },
  });
  const finalLimited = cycle({
    state: finalTwo.state,
    now: 42_000,
    currentIntensity: 16,
    sample: prediction({ nearClimax: 80, plateauScore: 75 }),
    settings: { finalApproachStep: 3 },
  });
  assert.equal(finalLimited.action, "hold");
});

test("confirmed recovery reduces, observes, permits deeper retreat, then returns toward retained peak", () => {
  const recoverySample = prediction({
    nearClimax: 60,
    plateauScore: 65,
    recovery: 80,
    currentHr: 92,
    localPeakHr: 100,
    dropFromRecentPeak: 8,
    hrSlope: -6,
    hrvSignal: "opening",
  });
  const state = { ...createHowlPhysiologyControllerState(15), phase: "final_approach", mode: "final_approach", peakIntensity: 15 };
  const candidate = cycle({ state, now: 1_000, currentIntensity: 15, sample: recoverySample });
  const confirmed = cycle({ state: candidate.state, now: 16_000, currentIntensity: 15, sample: recoverySample });
  assert.equal(confirmed.target, 13);
  const observing = cycle({ state: confirmed.state, now: 30_000, currentIntensity: 13, sample: recoverySample });
  assert.equal(observing.action, "hold");
  const deeper = cycle({ state: observing.state, now: 37_000, currentIntensity: 13, sample: recoverySample });
  assert.equal(deeper.target, 11);

  const clearingSample = prediction({ nearClimax: 70, plateauScore: 65, recovery: 10 });
  const clearCandidate = cycle({ state: deeper.state, now: 50_000, currentIntensity: 11, sample: clearingSample });
  const cleared = cycle({ state: clearCandidate.state, now: 65_000, currentIntensity: 11, sample: clearingSample });
  assert.notEqual(cleared.phase, "recovery");
  assert.equal(cleared.action, "reapproach");
  assert.equal(cleared.target, 12);
  assert.equal(cleared.state.peakIntensity, 15);
});

test("telemetry fallback holds, reduces every interval, then mutes and faults", () => {
  const start = cycle({ now: 1_000, telemetryFresh: false });
  assert.equal(start.action, "hold");
  const reduce = cycle({ now: 12_000, telemetryFresh: false, state: start.state });
  assert.equal(reduce.action, "fallback_reduce");
  assert.equal(reduce.target, 9);
  const noDuplicate = cycle({ now: 15_000, telemetryFresh: false, state: reduce.state, currentIntensity: 9 });
  assert.equal(noDuplicate.action, "hold");
  const secondReduce = cycle({ now: 22_000, telemetryFresh: false, state: noDuplicate.state, currentIntensity: 9 });
  assert.equal(secondReduce.target, 8);
  const muted = cycle({ now: 47_000, telemetryFresh: false, state: secondReduce.state, currentIntensity: 8 });
  assert.equal(muted.action, "mute_disarm");
  assert.equal(muted.state.faulted, true);
});

test("low confidence with fresh telemetry holds verified output without draining it", () => {
  const start = cycle({
    now: 1_000,
    currentIntensity: 18,
    telemetryFresh: true,
    sample: prediction({
      controllerConfidence: 19,
      multimodalTrusted: false,
    }),
  });
  const later = cycle({
    now: 90_000,
    currentIntensity: 18,
    telemetryFresh: true,
    state: start.state,
    sample: prediction({
      controllerConfidence: 19,
      multimodalTrusted: false,
    }),
  });
  assert.equal(start.action, "hold");
  assert.equal(later.action, "hold");
  assert.equal(later.target, 18);
  assert.match(later.explanation, /holding verified output/i);
});

test("pending command prevents duplicate intensity and pattern commands", () => {
  const state = { ...createHowlPhysiologyControllerState(10), phase: "build", mode: "build" };
  const decision = cycle({ state, commandPending: true });
  assert.equal(decision.action, "hold");
  const pattern = computeHowlPatternAction({
    decision: { ...decision, telemetryFresh: true, permissionBand: "full" },
    state,
    settings: { patternDirectorEnabled: true },
    commandPending: true,
  });
  assert.equal(pattern.action, "hold");
});

test("timed-out command is reconciled by status without retry", async () => {
  let setCalls = 0;
  const result = await executeReconciledHowlCommand({
    command: { id: "cmd-1", action: "set_intensity", channel: "a", intensity: 12 },
    settings: { intensityCeiling: 20 },
    commandRequest: { endpoint: "/set_power", body: { power_a: 12 } },
    request: async (_settings, endpoint) => {
      if (endpoint === "/set_power") {
        setCalls += 1;
        const error = new Error("timeout");
        error.status = 504;
        throw error;
      }
      return { status: 200, data: { options: { power_a: 12, power_b: 8 } } };
    },
  });
  assert.equal(setCalls, 1);
  assert.equal(result.commandTimedOut, true);
  assert.equal(result.reconciliation.result, "applied");
  assert.equal(result.sent, true);
});

test("ceiling violation causes safety mute/disarm result", async () => {
  let muteCalls = 0;
  const result = await executeReconciledHowlCommand({
    command: { id: "cmd-2", action: "set_intensity", channel: "a", intensity: 12 },
    settings: { intensityCeiling: 20 },
    commandRequest: { endpoint: "/set_power", body: { power_a: 12 } },
    request: async (_settings, endpoint) => {
      if (endpoint === "/status") return { status: 200, data: { options: { power_a: 22, power_b: 8 } } };
      if (endpoint === "/set_mute") muteCalls += 1;
      return { status: 200, data: { options: { power_a: 12, power_b: 8 } } };
    },
  });
  assert.equal(result.safetyAction, "mute_disarm");
  assert.equal(muteCalls, 1);
});

test("saved auto-arm token does not survive a controller/server restart", () => {
  assert.equal(isRuntimeAutoArmValid({ sarahAutoEnabled: true, runtimeArmToken: "run-a" }, "run-a"), true);
  assert.equal(isRuntimeAutoArmValid({ sarahAutoEnabled: true, runtimeArmToken: "run-a" }, "run-b"), false);
  assert.equal(isRuntimeAutoArmValid({ sarahAutoEnabled: false, runtimeArmToken: "run-a" }, "run-a"), false);
});
