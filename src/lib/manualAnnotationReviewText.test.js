import test from "node:test";
import assert from "node:assert/strict";
import { formatManualAnnotationReviewText, formatSessionClock, stripNonBodyObjectContext } from "./manualAnnotationReviewText.js";

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

test("restores direct self-session language without changing the finding", () => {
  assert.equal(
    formatManualAnnotationReviewText("The subject remains supine while a clinician's hand approaches the subject's right thigh."),
    "You remain supine while your hand approaches your right thigh.",
  );
  assert.equal(
    formatManualAnnotationReviewText("Clinician hands reposition equipment; no clinician manipulation is visible afterward."),
    "Your hands reposition equipment; no hand adjustment is visible afterward.",
  );
  assert.equal(
    formatManualAnnotationReviewText("No clinician contact is visible before active clinician repositioning; clinician right hand then enters."),
    "No hand contact is visible before your active repositioning; your right hand then enters.",
  );
  assert.equal(
    formatManualAnnotationReviewText("At 8:16 clinician right hand enters; at 8:17your hand makes contact."),
    "At 8:16 your right hand enters; at 8:17 your hand makes contact.",
  );
  assert.equal(
    formatManualAnnotationReviewText("Subject remains supine. Patient appears relaxed. The clinician remains outside frame."),
    "You remain supine. You appear relaxed. You remain outside frame.",
  );
});

test("removes guessed object context while preserving body findings", () => {
  assert.equal(
    stripNonBodyObjectContext("A dark device is held near the side table. Your scrotum remains elevated. Both feet remain relaxed."),
    "Your scrotum remains elevated. Both feet remain relaxed.",
  );
});
