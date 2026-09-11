import test from "node:test";
import assert from "node:assert/strict";
import { buildPhaseEvidence, phaseEvidenceAt, savedPhaseMarkers } from "./videoSyncPhaseEvidence.js";

const rows = (n, fn = () => ({})) => Array.from({ length: n }, (_, t) => ({
  time_offset_s: t, hr: 80, baseline_hr: 80, ...fn(t),
}));

test("missing values never become evidence or logged zero-time climax", () => {
  for (const hr of [null, undefined, "", 0, NaN]) {
    const result = buildPhaseEvidence(rows(30, () => ({ hr })));
    assert.equal(phaseEvidenceAt(result.points, 20).approach, null);
  }
  assert.equal(buildPhaseEvidence(rows(30, () => ({ baseline_hr: null }))).points.at(-1).approach, null);
  assert.deepEqual(savedPhaseMarkers({ climax_offset_s: null, recovery_offset_s: "" }), []);
  assert.equal(savedPhaseMarkers({ climax_offset_s: 0 })[0].t, 0);
});

test("warm-up, stable baseline, HR-only cap, and high-quality HRV contribution", () => {
  const baseline = buildPhaseEvidence(rows(40));
  assert.equal(phaseEvidenceAt(baseline.points, 5).approach, null);
  assert.equal(phaseEvidenceAt(baseline.points, 30).phase, "baseline");
  const input = rows(100, (t) => ({ hr: t < 30 ? 80 : 80 + (t - 30) * .8,
    hrv_rmssd_ms: t < 30 ? 40 : 15, hrv_quality: "high" }));
  const full = buildPhaseEvidence(input).points;
  const hrOnly = buildPhaseEvidence(input.map((r) => ({ ...r, hrv_quality: "low" }))).points;
  assert.ok(phaseEvidenceAt(full, 85).approach >= 70);
  assert.equal(phaseEvidenceAt(full, 85).phase, "approach");
  assert.ok(hrOnly.every((p) => p.approach <= 60));
});

test("plateau and recovery depend on a preceding build, never label confirmed climax", () => {
  const result = buildPhaseEvidence(rows(170, (t) => ({ hr: t < 20 ? 80 : t < 110 ? 105 : Math.max(80, 105 - (t - 110)) })));
  assert.equal(phaseEvidenceAt(result.points, 90).phase, "plateau");
  assert.equal(phaseEvidenceAt(result.points, 125).phase, "recovery");
  assert.ok(result.moments.some((m) => m.kind === "recovery"));
  assert.ok(result.points.every((p) => p.phase !== "climax"));
  assert.equal(buildPhaseEvidence(rows(80)).points.at(-1).recovery, 0);
});

test("playhead uses prior samples only; future telemetry cannot revise earlier scores", () => {
  const input = rows(100, (t) => ({ hr: 80 + t / 3 }));
  const prefix = buildPhaseEvidence(input.slice(0, 40));
  const full = buildPhaseEvidence(input);
  assert.deepEqual(full.points.slice(0, 40), prefix.points);
  assert.equal(phaseEvidenceAt(full.points, 39.9).t, 39);
  assert.equal(phaseEvidenceAt(full.points, -1).approach, null);
  assert.deepEqual(full.moments.filter((m) => m.detectedAt <= 39), prefix.moments);
});

test("gaps and invalid packets reset history, leave graph breaks, and do not imply recovery", () => {
  const result = buildPhaseEvidence([...rows(80, () => ({ hr: 110 })),
    ...rows(40).map((r) => ({ ...r, time_offset_s: r.time_offset_s + 100 }))]);
  assert.equal(phaseEvidenceAt(result.points, 90).approach, null);
  assert.equal(phaseEvidenceAt(result.points, 102).phase, "warming");
  assert.equal(phaseEvidenceAt(result.points, 120).recovery, 0);
  assert.ok(result.points.some((p) => p.t === 84 && p.approach === null));
  assert.equal(phaseEvidenceAt(result.points, 200).approach, null);
});

test("duration weighting handles irregular cadence, duplicates and repeated seeking", () => {
  const input = rows(200, (t) => ({ time_offset_s: t / 2, hr: 103 }));
  const result = buildPhaseEvidence(input);
  assert.equal(phaseEvidenceAt(result.points, 60.7).t, 60.5);
  assert.equal(phaseEvidenceAt(result.points, 60.7).dwell, 60.5);
  assert.deepEqual(buildPhaseEvidence(input.flatMap((r) => [r, r])), result);
  assert.deepEqual(phaseEvidenceAt(result.points, 20), phaseEvidenceAt(result.points, 20));
  assert.equal(phaseEvidenceAt(result.points, 60).phase, "plateau");
});

test("short rises and their crests survive; detected peaks are not visible before reversal", () => {
  const result = buildPhaseEvidence(rows(120, (t) => ({ hr: t < 35 ? 80 : t < 48 ? 80 + (t - 35) * 2 : Math.max(80, 106 - (t - 48) * 2) })));
  const crest = result.moments.find((m) => m.kind === "crest");
  assert.ok(crest);
  assert.ok(crest.detectedAt > crest.t);
  assert.ok(result.points.find((p) => p.t === 45).approach > result.points.find((p) => p.t === 35).approach);
});
