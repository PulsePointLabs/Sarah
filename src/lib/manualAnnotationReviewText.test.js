import test from "node:test";
import assert from "node:assert/strict";
import { formatManualAnnotationReviewText, formatSessionClock } from "./manualAnnotationReviewText.js";

test("formats long session-second references as minute clocks", () => {
  assert.equal(formatSessionClock(1214), "20:14");
  assert.equal(formatSessionClock(1221.5), "20:21.5");
  assert.equal(
    formatManualAnnotationReviewText("Across 1214–1224s, with a shift at 1221 seconds."),
    "Across 20:14–20:24, with a shift at 20:21.",
  );
});

test("leaves short relative durations alone", () => {
  assert.equal(formatManualAnnotationReviewText("Sarah's ±5s read covers 10 seconds."), "Sarah's ±5s read covers 10 seconds.");
});
