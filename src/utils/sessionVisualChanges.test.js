import test from "node:test";
import assert from "node:assert/strict";
import { buildHighConfidenceVisualChanges, visualChangeFocus } from "./sessionVisualChanges.js";

test("builds chronological high-confidence changes with anatomical feet-camera laterality", () => {
  const session = { ai_analysis: { _video_pass_findings: [{
    id: "feet-pass",
    source_video_role: "feet",
    clip: { start_s: 10, end_s: 20, thumbnail_url: "/frame.jpg" },
    draft_events: [
      { time_s: 18, note: "Screen-left foot sole flushes and toes curl.", confidence: "high", category: ["movement_observed"] },
      { time_s: 12, note: "Screen-right heel lifts as the toes flex.", confidence: "high", category: ["movement_observed"] },
      { time_s: 14, note: "Both feet remain stable.", confidence: "high", category: ["movement_observed"] },
    ],
  }] } };
  const result = buildHighConfidenceVisualChanges(session, [{ time_offset_s: 12, hr: 101, hrv_rmssd_ms: 18 }]);

  assert.equal(result.length, 2);
  assert.deepEqual(result.map((item) => item.timeS), [12, 18]);
  assert.match(result[0].overview, /your left heel/i);
  assert.match(result[1].overview, /your right foot/i);
  assert.equal(result[0].telemetry.hr, 101);
});

test("area focus maps anatomical left foot to the screen-right crop", () => {
  assert.deepEqual(visualChangeFocus("Your left foot toes curl"), {
    label: "Your left foot",
    origin: "76% 60%",
    scale: 2.2,
  });
});
