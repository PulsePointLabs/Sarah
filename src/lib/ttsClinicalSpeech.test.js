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
