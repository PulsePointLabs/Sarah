import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeVideoRespirationAssessment,
  respirationEventForAssessment,
  respirationFindingForAssessment,
} from "./videoRespirationAssessment.js";

test("respiratory rate requires enough visible cycles and observation time", () => {
  const assessment = normalizeVideoRespirationAssessment({
    assessable: true,
    visibility_quality: "good",
    breaths_observed: 4,
    observation_seconds: 16,
    estimated_rate_bpm: 15,
    possible_breath_hold: false,
    confidence: "moderate",
  }, { start: 120, end: 144 }, "main");

  assert.equal(assessment.estimatedRateBpm, 15);
  assert.match(respirationFindingForAssessment(assessment).text, /15 breaths\/min/);
});

test("low-evidence respiratory estimates are suppressed", () => {
  const assessment = normalizeVideoRespirationAssessment({
    assessable: true,
    visibility_quality: "limited",
    breaths_observed: 1,
    observation_seconds: 5,
    estimated_rate_bpm: 24,
    possible_breath_hold: true,
    hold_duration_seconds: 3,
    confidence: "low",
  }, { start: 120, end: 144 }, "main");

  assert.equal(assessment.estimatedRateBpm, null);
  assert.equal(assessment.possibleBreathHold, false);
  assert.equal(respirationFindingForAssessment(assessment), null);
});

test("possible breath hold requires at least four seconds and creates a cautious event", () => {
  const assessment = normalizeVideoRespirationAssessment({
    assessable: true,
    visibility_quality: "adequate",
    breaths_observed: 2,
    observation_seconds: 14,
    estimated_rate_bpm: 9,
    possible_breath_hold: true,
    hold_start_time_s: 128,
    hold_end_time_s: 133,
    hold_duration_seconds: 5,
    confidence: "high",
  }, { start: 120, end: 144 }, "lateral");

  assert.equal(assessment.possibleBreathHold, true);
  assert.equal(respirationEventForAssessment(assessment).time_s, 128);
  assert.match(respirationEventForAssessment(assessment).note, /shallow breathing remains/i);
});

test("feet-only video cannot produce respiratory estimates", () => {
  assert.equal(normalizeVideoRespirationAssessment({ assessable: true }, { start: 0, end: 24 }, "feet"), null);
});
