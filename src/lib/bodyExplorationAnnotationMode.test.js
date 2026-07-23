import test from "node:test";
import assert from "node:assert/strict";
import {
  detectBodyExplorationAnnotationMode,
  isUnsupportedUrethralClaimForMode,
  removeUnsupportedUrethralSentences,
} from "./bodyExplorationAnnotationMode.js";

test("automatically recognizes an enema body exploration", () => {
  const mode = detectBodyExplorationAnnotationMode({
    exploration_type: "Enema",
    focus_areas: "Anal response, genital state, and abdominal reaction",
    devices: "Enema bag and rectal nozzle",
  });

  assert.equal(mode.mode, "enema");
  assert.equal(mode.enemaKnown, true);
  assert.equal(mode.urethralKnown, false);
});

test("preserves explicit urethral context in a mixed exploration", () => {
  const mode = detectBodyExplorationAnnotationMode({
    exploration_type: "Enema with urethral sounding",
    devices: "Enema bag and Hegar dilators",
  });

  assert.equal(mode.enemaKnown, true);
  assert.equal(mode.urethralKnown, true);
  assert.equal(mode.mode, "urethral");
});

test("does not treat incidental genital anatomy as a urethral procedure", () => {
  const mode = detectBodyExplorationAnnotationMode({
    title: "Fleet Enema",
    focus_areas: "Watch anal insertion, body response, erection, and pre-ejaculate at the meatus.",
    purpose: "Rectal instillation and expulsion review.",
  });

  assert.equal(mode.enemaKnown, true);
  assert.equal(mode.urethralKnown, false);
  assert.equal(mode.mode, "enema");
});

test("rejects unsupported Foley hunting in enema-only mode", () => {
  const mode = detectBodyExplorationAnnotationMode({ notes: "Rectal enema and retention review" });
  assert.equal(isUnsupportedUrethralClaimForMode("Foley tip approaches the meatus.", mode), true);
  assert.equal(isUnsupportedUrethralClaimForMode("Rectal nozzle remains at the anus.", mode), false);
  assert.equal(
    removeUnsupportedUrethralSentences(
      "Your abdomen braces briefly. Foley placement begins at the meatus.",
      mode,
    ),
    "Your abdomen braces briefly.",
  );
});
