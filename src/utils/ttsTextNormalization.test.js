import test from "node:test";
import assert from "node:assert/strict";
import { normalizeNumericBandsForSpeech } from "./ttsTextNormalization.js";

test("physiological numeric bands are not read as seconds", () => {
  assert.equal(normalizeNumericBandsForSpeech("heart rate stayed in the 90s"), "heart rate stayed in the nineties");
  assert.equal(normalizeNumericBandsForSpeech("diastolic in the 90s"), "diastolic in the nineties");
  assert.equal(normalizeNumericBandsForSpeech("systolic remained in the 120s"), "systolic remained in the 120 range");
});

test("actual shorthand durations remain available for seconds expansion", () => {
  assert.equal(normalizeNumericBandsForSpeech("pause for 90s"), "pause for 90s");
  assert.equal(normalizeNumericBandsForSpeech("clip at 120s"), "clip at 120s");
});
