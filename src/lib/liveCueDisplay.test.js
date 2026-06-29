import test from "node:test";
import assert from "node:assert/strict";
import { LIVE_CUE_DISPLAY_LABELS, toLiveTelemetryNotice } from "./liveCueDisplay.js";
import { LIVE_CUE_TYPES } from "./liveCuePhrases.js";

test("every spoken live cue type has a matching distance-display label", () => {
  for (const cueType of Object.values(LIVE_CUE_TYPES)) {
    assert.ok(LIVE_CUE_DISPLAY_LABELS[cueType], `${cueType} needs a display label`);
  }
});

test("the latest spoken cue becomes the single displayed telemetry notice", () => {
  const notice = toLiveTelemetryNotice({
    id: "cue-1",
    type: "climax_imminent",
    phrase: "Climax appears imminent.",
    detector: { nearClimax: 91 },
    sessionTimeSec: 125,
    playback: { ok: true },
  });

  assert.deepEqual(notice, {
    id: "cue-1",
    label: "Near-climax probability high",
    message: "Climax appears imminent.",
    confidence: 91,
    sessionTimeSec: 125,
    spoken: true,
  });
});
