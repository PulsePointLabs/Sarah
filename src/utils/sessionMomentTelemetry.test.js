import assert from "node:assert/strict";
import test from "node:test";
import { buildSessionMomentTelemetry, mapVideoTimeToSessionTime } from "./sessionMomentTelemetry.js";

test("maps source-video playhead time through its saved session offset", () => {
  assert.equal(mapVideoTimeToSessionTime(290, 12), 302);
  assert.equal(mapVideoTimeToSessionTime(3, -10), 0);
});

test("keeps exact moment physiology separate from wider session context", () => {
  const timelineRows = Array.from({ length: 41 }, (_, index) => ({
    time_offset_s: 280 + index,
    hr: index < 10 ? 90 : 100,
    baseline_hr: 88,
    elevated_delta: index < 10 ? 2 : 12,
    hrv_rmssd_ms: index < 10 ? 24 : 8,
    hrv_quality: "high",
    respiration_bpm: 14,
    respiration_confidence: "medium",
    respiration_source: "accelerometer",
    motion_class: index >= 10 && index <= 18 ? "high" : "low",
    motion_dynamic_rms_mg: index >= 10 && index <= 18 ? 300 : 30,
    multimodal_state: index >= 10 && index <= 18 ? "loaded" : "steady",
    signal_confidence_level: "high",
  }));
  const packet = buildSessionMomentTelemetry({ timelineRows, startSeconds: 290, endSeconds: 298, contextPadSeconds: 10 });
  assert.equal(packet.row_counts.timeline_exact, 9);
  assert.equal(packet.heart_rate.exact_window.bpm_avg, 100);
  assert.equal(packet.rr_hrv.exact_window.rmssd_ms.avg, 8);
  assert.equal(packet.multimodal.exact_window.motion.classes.high, 9);
  assert.equal(packet.multimodal.exact_window.respiration.breaths_per_minute.avg, 14);
});
