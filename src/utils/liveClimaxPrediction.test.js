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

const sustainedHistory = (values) => values.map((hr, index) => ({
  ts: index * 30_000,
  time: String(index),
  sessionTimeSec: index * 30,
  hr,
  hrSmoothed: hr,
  baseline: 82,
  build: 65,
  phase: "build",
}));

test("baseline fixture preserves HR-only baseline/build behavior", () => {
  const result = computeLiveClimaxPrediction(
    { currentHr: 82, baselineHr: 80, phase: "baseline", buildConfidence: 5 },
    null,
    history([80, 81, 82, 82]),
  );
  assert.equal(result.nearClimax, 23);
  assert.equal(result.recovery, 0);
  assert.equal(result.recoveryEligible, false);
  assert.equal(result.hrvUsable, false);
  assert.equal(result.confidenceBand, "HR-only watch");
});

test("sustained gradual build reaches the gated near-climax watch range", () => {
  const result = computeLiveClimaxPrediction(
    { currentHr: 104, baselineHr: 84, phase: "build", buildConfidence: 62 },
    null,
    sustainedHistory([84, 88, 92, 96, 100, 104]),
    { sessionTimeSec: 180, elapsedMinutes: 16, buildDurationSec: 180 },
  );
  assert.equal(result.label, "Near-climax watch");
  assert.equal(result.nearClimax, 71);
  assert.equal(result.buildEligibleForNearClimax, true);
  assert.equal(result.recovery, 0);
});

test("recovery fixture preserves recovery behavior", () => {
  const result = computeLiveClimaxPrediction(
    { currentHr: 92, baselineHr: 84, phase: "recovery", buildConfidence: 20 },
    null,
    history([84, 96, 108, 106, 98, 92]).map((point, index) => ({
      ...point,
      nearClimax: index === 2 ? 74 : 45,
    })),
  );
  assert.equal(result.label, "Recovery likely");
  assert.equal(result.nearClimax, 12);
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

test("EMG remains optional but can raise sustained high-watch confidence when present", () => {
  const result = computeLiveClimaxPrediction(
    { currentHr: 105, baselineHr: 84, phase: "build", buildConfidence: 62, hrv: { rmssdMs: 16, quality: "high", sampleCount: 30 } },
    { left_pct: 72, right_pct: 61 },
    sustainedHistory([84, 90, 96, 101, 105]),
    { sessionTimeSec: 180, elapsedMinutes: 16, buildDurationSec: 180 },
  );
  assert.equal(result.label, "Climax approach watch");
  assert.equal(result.nearClimax, 90);
  assert.equal(result.confidenceBand, "high watch");
});
