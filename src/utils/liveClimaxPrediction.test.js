import test from "node:test";
import assert from "node:assert/strict";
import { computeLiveClimaxPrediction } from "./liveClimaxPrediction.js";

const history = (values) => values.map((hr, index) => ({
  ts: index * 1000,
  time: String(index),
  hr,
  hrSmoothed: hr,
  baseline: 82,
}));

test("baseline fixture preserves HR-only baseline/build behavior", () => {
  const result = computeLiveClimaxPrediction(
    { currentHr: 82, baselineHr: 80, phase: "baseline", buildConfidence: 5 },
    null,
    history([80, 81, 82, 82]),
  );
  assert.equal(result.nearClimax, 23);
  assert.equal(result.recovery, 45);
  assert.equal(result.hrvUsable, false);
  assert.equal(result.confidenceBand, "HR-only watch");
});

test("gradual build fixture preserves near-climax watch range", () => {
  const result = computeLiveClimaxPrediction(
    { currentHr: 104, baselineHr: 84, phase: "build", buildConfidence: 62 },
    null,
    history([84, 88, 92, 96, 100, 104]),
  );
  assert.equal(result.label, "Near-climax watch");
  assert.equal(result.nearClimax, 76);
  assert.equal(result.recovery, 10);
});

test("recovery fixture preserves recovery behavior", () => {
  const result = computeLiveClimaxPrediction(
    { currentHr: 92, baselineHr: 84, phase: "recovery", buildConfidence: 20 },
    null,
    history([84, 96, 108, 106, 98, 92]),
  );
  assert.equal(result.label, "Recovery likely");
  assert.equal(result.nearClimax, 22);
  assert.equal(result.recovery, 85);
  assert.equal(result.dropFromRecentPeak, 16);
});

test("usable H10 RR/HRV contributes without being fabricated", () => {
  const result = computeLiveClimaxPrediction(
    { currentHr: 101, baselineHr: 84, phase: "build", buildConfidence: 58, hrv: { rmssdMs: 18, quality: "high", sampleCount: 28 } },
    null,
    history([84, 90, 96, 101]),
  );
  assert.equal(result.hrvUsable, true);
  assert.equal(result.rrCount, 28);
  assert.equal(result.rmssd, 18);
  assert.equal(result.hrvSignal, "steady");
});

test("EMG remains optional but can raise high-watch confidence when present", () => {
  const result = computeLiveClimaxPrediction(
    { currentHr: 105, baselineHr: 84, phase: "build", buildConfidence: 62, hrv: { rmssdMs: 16, quality: "high", sampleCount: 30 } },
    { left_pct: 72, right_pct: 61 },
    history([84, 90, 96, 101, 105]),
  );
  assert.equal(result.label, "Climax approach watch");
  assert.equal(result.nearClimax, 90);
  assert.equal(result.confidenceBand, "high watch");
});
