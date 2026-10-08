import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeHowlPhysiologyAction,
  createHowlPhysiologyControllerState,
  observeHowlIntensity,
} from '../../src/lib/howlPhysiologyController.js';

test('manual increase becomes a floor while automatic ramp feedback does not ratchet it', () => {
  let state = observeHowlIntensity({}, 6);
  state = observeHowlIntensity(state, 10);
  assert.equal(state.manualFloor, 10);
  state = observeHowlIntensity({ ...state, expectedIntensity: 11 }, 10);
  assert.equal(state.expectedIntensity, 11);
  state = observeHowlIntensity(state, 11);
  assert.equal(state.manualFloor, 10);
  const recovery = computeHowlPhysiologyAction({
    state, currentIntensity: 11, ceiling: 16,
    prediction: loadedPrediction({ recovery: 80, dropFromRecentPeak: 8 }),
  });
  assert.equal(recovery.target, 10);
  const hold = computeHowlPhysiologyAction({
    state: recovery.state, currentIntensity: 10, ceiling: 16,
    prediction: loadedPrediction({ recovery: 80, dropFromRecentPeak: 8 }),
  });
  assert.equal(hold.target, 10);
});

test('manual baseline still permits gradual build and respects the configured ceiling', () => {
  const state = observeHowlIntensity(observeHowlIntensity({}, 5), 9);
  const build = computeHowlPhysiologyAction({
    state, currentIntensity: 9, ceiling: 10,
    prediction: loadedPrediction({ nearClimax: 45, plateauScore: 0, plateauDwell: false, recentSlope: 2 }),
  });
  assert.equal(build.target, 10);
  assert.equal(build.state.manualFloor, 9);
});

test('manual decrease resets the retained peak instead of bouncing back up', () => {
  const state = observeHowlIntensity({ observedIntensity: 12, manualFloor: 10, peakIntensity: 14 }, 4);
  assert.equal(state.manualFloor, 4);
  assert.equal(state.peakIntensity, 4);
  const result = computeHowlPhysiologyAction({ state, currentIntensity: 4, floor: 5, ceiling: 16,
    prediction: loadedPrediction({ recovery: 80, dropFromRecentPeak: 8 }) });
  assert.equal(result.target, 4);
});

test('missing readings do not reset floors and channels keep independent baselines', () => {
  const a = observeHowlIntensity(observeHowlIntensity({}, 4), 9);
  const b = observeHowlIntensity(observeHowlIntensity({}, 2), 3);
  assert.equal(observeHowlIntensity(a, null), a);
  assert.equal(a.manualFloor, 9);
  assert.equal(b.manualFloor, 3);
});

function loadedPrediction(overrides = {}) {
  return {
    nearClimax: 78,
    recovery: 12,
    plateauScore: 72,
    plateauDwell: true,
    buildEligibleForNearClimax: true,
    controllerConfidence: 82,
    multimodalTrusted: true,
    approachVelocity: 1.5,
    hrvSignal: 'compressed',
    dropFromRecentPeak: 1,
    ...overrides,
  };
}

test('near-climax and plateau protection hold instead of increasing', () => {
  const result = computeHowlPhysiologyAction({
    prediction: loadedPrediction(),
    currentIntensity: 12,
    floor: 4,
    ceiling: 16,
    state: createHowlPhysiologyControllerState(12),
  });

  assert.equal(result.action, 'protected_hold');
  assert.equal(result.target, 12);
  assert.equal(result.state.mode, 'near_climax_hold');
});

test('recovery retreat cannot accumulate below the retained cycle floor', () => {
  const initialState = { mode: 'final_approach', peakIntensity: 15, recoveryFloor: 12 };
  const first = computeHowlPhysiologyAction({
    prediction: loadedPrediction({ recovery: 72, dropFromRecentPeak: 8, hrvSignal: 'opening' }),
    currentIntensity: 15,
    floor: 4,
    ceiling: 18,
    settings: { reduceStep: 2, maxRecoveryRetreat: 3 },
    state: initialState,
  });
  const second = computeHowlPhysiologyAction({
    prediction: loadedPrediction({ recovery: 72, dropFromRecentPeak: 8, hrvSignal: 'opening' }),
    currentIntensity: first.target,
    floor: 4,
    ceiling: 18,
    settings: { reduceStep: 2, maxRecoveryRetreat: 3 },
    state: first.state,
  });

  assert.equal(first.target, 13);
  assert.equal(second.target, 12);
  const third = computeHowlPhysiologyAction({
    prediction: loadedPrediction({ recovery: 72, dropFromRecentPeak: 8, hrvSignal: 'opening' }),
    currentIntensity: second.target,
    floor: 4,
    ceiling: 18,
    settings: { reduceStep: 2, maxRecoveryRetreat: 3 },
    state: second.state,
  });
  assert.equal(third.action, 'recovery_hold');
  assert.equal(third.target, 12);
});

test('controller does not restore intensity after recovery clears without a rising HR trend', () => {
  const result = computeHowlPhysiologyAction({
    prediction: loadedPrediction({ nearClimax: 55, plateauScore: 48, plateauDwell: false }),
    currentIntensity: 12,
    floor: 4,
    ceiling: 18,
    state: { mode: 'recovery_retreat', peakIntensity: 15, recoveryFloor: 12 },
  });

  assert.equal(result.action, 'hold');
  assert.equal(result.target, 12);
});

test('falling HR cannot trigger an automatic increase even when build score is high', () => {
  const result = computeHowlPhysiologyAction({
    prediction: loadedPrediction({
      nearClimax: 50,
      plateauScore: 40,
      plateauDwell: false,
      recentSlope: -2.5,
    }),
    currentIntensity: 8,
    ceiling: 10,
  });

  assert.equal(result.action, 'hold');
  assert.equal(result.target, 8);
  assert.equal(result.risingHr, false);
});

test('reliable rising HR can advance only one configured build step', () => {
  const result = computeHowlPhysiologyAction({
    prediction: loadedPrediction({
      nearClimax: 50,
      plateauScore: 40,
      plateauDwell: false,
      recentSlope: 2.5,
    }),
    currentIntensity: 8,
    ceiling: 10,
  });

  assert.equal(result.action, 'build_ramp');
  assert.equal(result.target, 9);
  assert.equal(result.risingHr, true);
});

test('HRV relaxation evidence holds even when the build score remains elevated', () => {
  const result = computeHowlPhysiologyAction({
    prediction: loadedPrediction({
      nearClimax: 50,
      plateauScore: 40,
      plateauDwell: false,
      recentSlope: 2.5,
      hrvSignal: 'opening',
      recovery: 40,
    }),
    currentIntensity: 8,
    ceiling: 10,
  });

  assert.equal(result.action, 'protected_hold');
  assert.equal(result.target, 8);
  assert.equal(result.state.mode, 'relaxation_hold');
});

test('low-confidence multimodal input holds intensity', () => {
  const result = computeHowlPhysiologyAction({
    prediction: loadedPrediction({ controllerConfidence: 40, multimodalTrusted: false }),
    currentIntensity: 12,
    floor: 4,
    ceiling: 18,
  });

  assert.equal(result.action, 'hold');
  assert.equal(result.target, 12);
  assert.equal(result.state.mode, 'signal_hold');
});
