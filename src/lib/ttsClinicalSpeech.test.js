import assert from "node:assert/strict";
import test from "node:test";
import { normalizeClinicalUnitsForSpeech } from "./ttsClinicalSpeech.js";

test("expands slash-form blood pressure and mmHg for natural speech", () => {
  assert.equal(
    normalizeClinicalUnitsForSpeech("Blood pressure was 146/101 mmHg."),
    "Blood pressure was 146 over 101 millimeters of mercury.",
  );
  assert.equal(
    normalizeClinicalUnitsForSpeech("It returned toward 136/96."),
    "It returned toward 136 over 96.",
  );
});

test("expands standalone pressure and glucose units", () => {
  assert.equal(
    normalizeClinicalUnitsForSpeech("Pressure rose 18 mmHg and glucose was 90 mg/dL."),
    "Pressure rose 18 millimeters of mercury and glucose was 90 milligrams per deciliter.",
  );
});

test("speaks motion mg as milli-g without corrupting glucose units", () => {
  assert.equal(
    normalizeClinicalUnitsForSpeech("Dynamic RMS climbed to fifty-five point six milligrams."),
    "Dynamic RMS climbed to fifty-five point six milli-g.",
  );
  assert.equal(
    normalizeClinicalUnitsForSpeech("Motion dynamic RMS was 55 mg while glucose was 90 mg/dL."),
    "Motion dynamic RMS was 55 milli-g while glucose was 90 milligrams per deciliter.",
  );
});

test("expands body exploration physiology and volume shorthand", () => {
  assert.equal(
    normalizeClinicalUnitsForSpeech("SpO2 was 99% with RMSSD 7 ms, HRV available, and 500 mL instilled at 104 bpm."),
    "oxygen saturation was 99% with R M S S D 7 ms, H R V available, and 500 milliliters instilled at 104 beats per minute.",
  );
});
