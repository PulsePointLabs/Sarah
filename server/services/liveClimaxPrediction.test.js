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
