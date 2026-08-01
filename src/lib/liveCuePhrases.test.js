import assert from "node:assert/strict";
import test from "node:test";
import {
  LIVE_CUE_PRESETS,
  LIVE_CUE_TYPES,
  resolveLiveCuePhraseBank,
} from "./liveCuePhrases.js";

test("spoken presets provide a full adaptive rotation for every cue state", () => {
  for (const presetId of ["sarah_soft", "intimate_coaching", "intimate_lovers_voice"]) {
    for (const cueType of Object.values(LIVE_CUE_TYPES)) {
      assert.equal(
        LIVE_CUE_PRESETS[presetId].phrases[cueType].length,
        8,
        `${presetId}.${cueType} should contain eight adaptive phrases`,
      );
    }
  }
});

test("body exploration exposes no spoken phrase path", () => {
  const bank = resolveLiveCuePhraseBank({
    style: "intimate_lovers_voice",
    allowSessionStyleCues: false,
  }, {
    captureKind: "body_exploration",
  });

  assert.equal(bank.suppressed, true);
  assert.equal(bank.settings.enabled, false);
  assert.deepEqual(bank.phrases, {});
});

test("body exploration ignores generated custom phrases", () => {
  const bank = resolveLiveCuePhraseBank({
    style: "custom",
    allowSessionStyleCues: false,
    customPhrases: {
      recovery: ["First custom recovery.", "Second custom recovery."],
    },
  }, {
    captureKind: "body_exploration",
  });

  assert.deepEqual(bank.phrases, {});
});
