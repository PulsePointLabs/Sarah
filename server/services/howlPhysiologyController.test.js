import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeHowlPhysiologyAction,
  createHowlPhysiologyControllerState,
} from '../../src/lib/howlPhysiologyController.js';

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
