import test from "node:test";
import assert from "node:assert/strict";
import {
  isFootOfTableCamera,
  normalizeFootCameraLateralityText,
  sessionHasFootOfTableCamera,
} from "./anatomicalLaterality.js";

test("foot-of-table screen sides normalize to Ben's anatomical sides", () => {
  assert.equal(
    normalizeFootCameraLateralityText("The screen-left foot flushes while the screen-right toes curl."),
    "your right foot flushes while your left toes curl.",
  );
});

test("already anatomical laterality is preserved", () => {
  assert.equal(
    normalizeFootCameraLateralityText("Your left foot plants and your right sole relaxes."),
    "Your left foot plants and your right sole relaxes.",
  );
});

test("feet source role is recognized without guessing from unrelated cameras", () => {
  assert.equal(isFootOfTableCamera({ source_video_role: "feet" }), true);
  assert.equal(isFootOfTableCamera({ source_video_role: "lateral" }), false);
  assert.equal(sessionHasFootOfTableCamera({ ai_analysis: { _video_pass_findings: [{ source_video_role: "feet" }] } }), true);
});
