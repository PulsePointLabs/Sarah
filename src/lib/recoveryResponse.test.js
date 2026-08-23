import test from "node:test";
import assert from "node:assert/strict";
import { summarizeRecoveryResponse } from "./recoveryResponse.js";

test("selects one coherent, most-complete recovery snapshot", () => {
  const rows = [
    { time_offset_s: 10, hr: 92 },
    { time_offset_s: 40, hr: 130 },
    { time_offset_s: 70, hr: 120, recovery_drop_30_bpm: 10 },
    { time_offset_s: 100, hr: 112, recovery_drop_30_bpm: 10, recovery_drop_60_bpm: 18 },
    { time_offset_s: 130, hr: 108, recovery_drop_30_bpm: 10, recovery_drop_60_bpm: 18, recovery_drop_90_bpm: 22, signal_confidence_score: 84 },
  ];
  const result = summarizeRecoveryResponse(rows, { climax_offset_s: 42 });
  assert.equal(result.recovery.timeS, 130);
  assert.equal(result.recovery.peakHr, 130);
  assert.equal(result.recovery.peakTimeS, 40);
  assert.deepEqual(result.recovery.drops, { seconds30: 10, seconds60: 18, seconds90: 22 });
  assert.equal(result.recovery.trajectory.key, "continued_fall");
  assert.equal(result.recovery.phaseAnchor.label, "climax marker");
});

test("describes a late HR rebound without presenting a medical score", () => {
  const result = summarizeRecoveryResponse([
    { time_offset_s: 0, hr: 100 },
    { time_offset_s: 20, hr: 140 },
    { time_offset_s: 110, hr: 130, recovery_drop_30_bpm: 12, recovery_drop_60_bpm: 18, recovery_drop_90_bpm: 10 },
  ]);
  assert.equal(result.recovery.trajectory.key, "rebound");
  assert.match(result.recovery.trajectory.detail, /rose again/i);
});

test("preserves response-latency provenance and event counts", () => {
  const result = summarizeRecoveryResponse([
    {
      time_offset_s: 50,
      hr: 100,
      response_latency_seconds: 11,
      response_latency_sample_count: 3,
      response_latency_evaluated_count: 5,
    },
  ]);
  assert.deepEqual(result.response, {
    medianSeconds: 11,
    qualifyingCount: 3,
    evaluatedCount: 5,
    savedAtS: 50,
  });
});

