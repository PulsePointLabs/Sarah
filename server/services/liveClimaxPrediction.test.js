import test from 'node:test';
import assert from 'node:assert/strict';

import { computeLiveClimaxPrediction } from '../../src/utils/liveClimaxPrediction.js';

function historyPoint(index, hr, rmssd = 18) {
  return {
    ts: 1_000_000 + index * 1000,
    hr,
    baseline: 92,
    hrvRmssd: rmssd,
    hrvQuality: 'high',
  };
}

test('HR rise plus compressed usable HRV increases live climax approach watch', () => {
  const history = Array.from({ length: 45 }, (_, index) => historyPoint(index, 96 + index * 0.45, 18));
  history.push(...Array.from({ length: 10 }, (_, index) => historyPoint(45 + index, 118 + index * 0.8, 5.5)));

  const prediction = computeLiveClimaxPrediction(
    {
      currentHr: 126,
      baselineHr: 92,
      buildConfidence: 72,
      phase: 'build',
      hrv: { rmssdMs: 5.2, sampleCount: 96, quality: 'high' },
    },
    { left_pct: 22, right_pct: 18 },
    history
  );

  assert.ok(prediction.nearClimax >= 68);
  assert.equal(prediction.hrvSignal, 'compressed');
  assert.match(prediction.hrvExplanation, /tightly loaded|compressed/i);
});

test('recovery phase caps live climax approach even with a recent peak', () => {
  const history = [
    historyPoint(0, 118, 9),
    historyPoint(1, 125, 8),
    historyPoint(2, 120, 13),
    historyPoint(3, 109, 22),
  ];

  const prediction = computeLiveClimaxPrediction(
    {
      currentHr: 108,
      baselineHr: 92,
      buildConfidence: 18,
      phase: 'recovery',
      hrv: { rmssdMs: 24, sampleCount: 88, quality: 'high' },
    },
    { left_pct: 4, right_pct: 6 },
    history
  );

  assert.ok(prediction.nearClimax <= 22);
  assert.ok(prediction.recovery >= 65);
  assert.equal(prediction.label, 'Recovery likely');
});

test('trusted multimodal respiratory strain strengthens an already loaded build', () => {
  const history = Array.from({ length: 130 }, (_, index) => ({
    ...historyPoint(index, 103 + Math.min(18, index * 0.16), index < 70 ? 16 : 6),
    sessionTimeSec: index,
    nearClimax: index < 80 ? 42 : 61,
    respirationBpm: index < 70 ? 13 : 17,
  }));
  const base = {
    currentHr: 121,
    baselineHr: 92,
    buildConfidence: 70,
    phase: 'build',
    hrv: { rmssdMs: 5.8, sampleCount: 100, quality: 'high' },
  };

  const withoutMultimodal = computeLiveClimaxPrediction(base, { left_pct: 23 }, history, { sessionTimeSec: 130 });
  const withMultimodal = computeLiveClimaxPrediction({
    ...base,
    multimodal: {
      signalConfidence: { score: 84 },
      streams: { accelerometer: { sampleCount: 1200 } },
      respiration: { available: true, bpm: 18, possibleBreathHold: true, holdDurationSeconds: 5.2 },
      motion: { class: 'moderate_motion', dynamicRmsMilliG: 115 },
      recovery: { currentDropBpm: 0 },
    },
  }, { left_pct: 23 }, history, { sessionTimeSec: 130 });

  assert.ok(withMultimodal.nearClimax >= withoutMultimodal.nearClimax);
  assert.equal(withMultimodal.respiratoryStrain, true);
  assert.equal(withMultimodal.plateauDwell, true);
  assert.ok(withMultimodal.controllerConfidence >= 70);
});

test('weak multimodal quality caps escalation instead of treating motion as arousal', () => {
  const history = Array.from({ length: 110 }, (_, index) => ({
    ...historyPoint(index, 105 + Math.min(16, index * 0.18), 7),
    sessionTimeSec: index,
    nearClimax: 58,
  }));
  const prediction = computeLiveClimaxPrediction({
    currentHr: 121,
    baselineHr: 92,
    buildConfidence: 76,
    phase: 'build',
    hrv: { rmssdMs: 6, sampleCount: 90, quality: 'moderate' },
    multimodal: {
      signalConfidence: { score: 28 },
      streams: { accelerometer: { sampleCount: 500 } },
      respiration: { available: false, reason: 'motion_limited' },
      motion: { class: 'high_motion', dynamicRmsMilliG: 420 },
    },
  }, null, history, { sessionTimeSec: 110 });

  assert.equal(prediction.multimodalTrusted, false);
  assert.equal(prediction.lowMultimodalConfidenceCapApplied, true);
  assert.ok(prediction.nearClimax <= 55);
  assert.equal(prediction.coordinatedMotion, false);
});
