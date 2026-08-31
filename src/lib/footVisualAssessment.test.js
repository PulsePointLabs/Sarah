import test from "node:test";
import assert from "node:assert/strict";
import {
  footRelaxationIsSupported,
  keepFootVisualItem,
  sanitizeFootSummary,
} from "./footVisualAssessment.js";

const tenseFeet = {
  left: { ankle_state: "plantar_flexed", toe_state: "curled", bracing_state: "braced", movement_state: "stable", evidence_frames: [1, 4, 7] },
  right: { ankle_state: "plantar_flexed", toe_state: "curled", bracing_state: "braced", movement_state: "stable", evidence_frames: [1, 4, 7] },
  bilateral_change: "unchanged",
  relaxation_supported: false,
};

test("reduced oscillation cannot become foot relaxation while flexion and bracing remain", () => {
  const text = "Both feet settle to flatter, lower-tension position; cyclic plantar flexion is absent.";
  assert.equal(footRelaxationIsSupported(tenseFeet, text), false);
  assert.equal(keepFootVisualItem({ note: text }, tenseFeet), false);
  assert.match(sanitizeFootSummary(text, tenseFeet), /plantar flexed/i);
});

test("bilateral relaxation needs release evidence from both feet", () => {
  const released = {
    left: { ankle_state: "neutral", toe_state: "neutral", bracing_state: "not_braced", movement_state: "decreasing_flexion", evidence_frames: [2, 3] },
    right: { ankle_state: "neutral", toe_state: "extended_or_splayed", bracing_state: "not_braced", movement_state: "decreasing_flexion", evidence_frames: [2, 4] },
    bilateral_change: "decreased_tension",
    relaxation_supported: true,
  };
  assert.equal(footRelaxationIsSupported(released, "Both feet visibly relax toward neutral."), true);
  released.right.toe_state = "curled";
  assert.equal(footRelaxationIsSupported(released, "Both feet visibly relax toward neutral."), false);
});
