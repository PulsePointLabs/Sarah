import assert from "node:assert/strict";
import test from "node:test";
import { buildBodyExplorationPhysiologyEvidence, buildSessionChatPhysiologyEvidence, buildSessionPhysiologyEvidence } from "./bodyExplorationPhysiology.js";

test("builds quality-gated high-resolution physiology across the full exploration", () => {
  const exploration = {
    id: "exploration-1",
    date: "2026-08-01",
    start_time: "04:50",
    duration_minutes: 2,
    title: "Enema review",
    event_timeline: [{ time_s: 60, note: "Nozzle fully inserted." }],
  };
  const timelineRows = Array.from({ length: 121 }, (_, time) => ({
    time_offset_s: time,
    hr: 80 + Math.floor(time / 30),
    hr_smoothed: 80 + Math.floor(time / 30),
    baseline_hr: 80,
    elevated_delta: Math.floor(time / 30),
    rr_intervals_ms: "750|745",
    hrv_rmssd_ms: time === 30 ? 0 : 28 - Math.floor(time / 60),
    hrv_sdnn_ms: 40 - Math.floor(time / 60),
    hrv_pnn50: 0.12,
    hrv_quality: time === 30 ? "unavailable" : "high",
    respiration_bpm: 0,
    respiration_unavailable_reason: "low_rr_periodicity",
    motion_class: "unavailable",
    motion_dynamic_rms_mg: 0,
    signal_confidence_level: "unavailable",
    multimodal_state: "recovering",
  }));
  const emgRows = [
    { time_s: 0, level_pct: 10, raw_env: 100 },
    { time_s: 1, level_pct: 20, raw_env: 200 },
  ];

  const evidence = buildBodyExplorationPhysiologyEvidence({ exploration, timelineRows, emgRows });
  assert.equal(evidence.provenance.heart_rate_timeline_rows, 121);
  assert.equal(evidence.signals.hrv.usable_rows, 120);
  assert.equal(evidence.signals.respiration.usable_rows, 0);
  assert.equal(evidence.signals.motion.usable_rows, 0);
  assert.deepEqual(evidence.signals.multimodal_states, {});
  assert.equal(evidence.signals.emg.channels.level_pct.mean, 15);
  assert.ok(evidence.high_resolution_trajectory.bins.length >= 20);
  assert.match(evidence.procedure_aligned_windows, /Nozzle fully inserted/);
  assert.ok(evidence.signals.hrv.rmssd_ms.min > 0);
  assert.equal(evidence.baseline_and_trends.reference_definition, "The first recorded window is an entry-state reference, not proof of a true resting baseline.");
  assert.equal(evidence.baseline_and_trends.trends.peak_hr_bpm, 84);
});

test("builds the same baseline and trend evidence for sessions without procedure text", () => {
  const timelineRows = Array.from({ length: 61 }, (_, time) => ({
    time_offset_s: time,
    hr: 80 + Math.floor(time / 20),
    baseline_hr: 78,
    elevated_delta: 2 + Math.floor(time / 20),
    hrv_rmssd_ms: 30 - Math.floor(time / 30),
    hrv_quality: "high",
    respiration_bpm: 12 + Math.floor(time / 30),
    respiration_confidence: "medium",
    respiration_source: "accelerometer",
    motion_class: "low",
    motion_dynamic_rms_mg: 25,
    signal_confidence_level: "medium",
    multimodal_state: "steady",
  }));
  const evidence = buildSessionPhysiologyEvidence({ session: { id: "session-1" }, timelineRows });
  assert.equal(evidence.baseline_and_trends.entry.label, "recorded_entry_reference");
  assert.equal(evidence.signals.respiration.confidence_levels.medium, 61);
  assert.equal(evidence.signals.respiration.sources.accelerometer, 61);
  assert.equal("procedure_aligned_windows" in evidence, false);

  const chatEvidence = buildSessionChatPhysiologyEvidence({ session: { id: "session-1" }, timelineRows });
  assert.ok(chatEvidence.baseline_and_trends);
  assert.ok(chatEvidence.signals.respiration);
  assert.equal("high_resolution_trajectory" in chatEvidence, false);
});
