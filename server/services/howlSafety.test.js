import test from 'node:test';
import assert from 'node:assert/strict';

import { validateAutomaticHowlIncrease } from './howlSafety.js';

const settings = {
  recoveryThreshold: 55,
  nearClimaxThreshold: 72,
};

function automaticIncrease(overrides = {}) {
  return {
    intensity: 10,
    reason: 'sarah_auto_build_ramp',
    controller: {
      previousIntensity: 9,
      recentSlope: 2,
      controllerConfidence: 80,
      multimodalTrusted: true,
      recovery: 20,
      nearClimax: 50,
      ...overrides,
    },
  };
}

test('server policy accepts only a small increase with reliable rising-HR evidence', () => {
  assert.deepEqual(validateAutomaticHowlIncrease(automaticIncrease(), settings), {
    ok: true,
    increasing: true,
  });
});

test('server policy rejects an automatic increase while HR is falling', () => {
  const result = validateAutomaticHowlIncrease(automaticIncrease({ recentSlope: -1.5 }), settings);
  assert.equal(result.ok, false);
  assert.match(result.error, /rising-HR evidence/);
});

test('server policy rejects an automatic increase during recovery or near-climax protection', () => {
  assert.equal(validateAutomaticHowlIncrease(automaticIncrease({ recovery: 70 }), settings).ok, false);
  assert.equal(validateAutomaticHowlIncrease(automaticIncrease({ nearClimax: 80 }), settings).ok, false);
});

test('server policy rejects an automatic increase larger than two points', () => {
  const request = automaticIncrease();
  request.intensity = 12;
  const result = validateAutomaticHowlIncrease(request, settings);
  assert.equal(result.ok, false);
  assert.match(result.error, /maximum upward change is 2/);
});

test('holds and reductions do not require rising-HR evidence', () => {
  const request = automaticIncrease({ recentSlope: -4, recovery: 80 });
  request.intensity = 8;
  assert.deepEqual(validateAutomaticHowlIncrease(request, settings), {
    ok: true,
    increasing: false,
  });
});
