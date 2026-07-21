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

test('final approach advances one bounded step instead of reducing near threshold', () => {
  const result = computeHowlPhysiologyAction({
    prediction: loadedPrediction(),
    currentIntensity: 12,
    floor: 4,
    ceiling: 16,
    state: createHowlPhysiologyControllerState(12),
  });

  assert.equal(result.action, 'final_approach');
  assert.equal(result.target, 13);
  assert.equal(result.state.mode, 'final_approach');
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

test('controller restores retained intensity after recovery clears', () => {
  const result = computeHowlPhysiologyAction({
    prediction: loadedPrediction({ nearClimax: 55, plateauScore: 48, plateauDwell: false }),
    currentIntensity: 12,
    floor: 4,
    ceiling: 18,
    state: { mode: 'recovery_retreat', peakIntensity: 15, recoveryFloor: 12 },
  });

  assert.equal(result.action, 'reapproach');
  assert.equal(result.target, 13);
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
