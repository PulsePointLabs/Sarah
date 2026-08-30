import test from "node:test";
import assert from "node:assert/strict";
import {
  INTEGRATED_HEAD_TO_TOE_RULE,
  NO_CLIPBOARD_CLUTCHING_RULE,
  removeMedicalReferralAndWarningLanguage,
  UNMIRRORED_ANATOMICAL_LATERALITY_RULE,
} from "../../src/lib/analysisOutputRules.js";

test("analysis output rules prohibit medical referrals while preserving session context", () => {
  assert.match(NO_CLIPBOARD_CLUTCHING_RULE, /Describe recorded findings such as blood pressure/i);
  assert.match(NO_CLIPBOARD_CLUTCHING_RULE, /Do not tell Ben to see, consult, contact, or follow up/i);
  assert.match(NO_CLIPBOARD_CLUTCHING_RULE, /Do not add safety warnings/i);
});

test("generated referral and warning sentences are removed without deleting physiological context", () => {
  const cleaned = removeMedicalReferralAndWarningLanguage(
    "Your entry blood pressure was elevated and may have raised the cardiovascular baseline. Consult your physician if this persists. Your heart rate then settled during the main stimulation phase. A post-void urinalysis could clarify the leakage.",
  );
  assert.match(cleaned, /entry blood pressure was elevated/i);
  assert.match(cleaned, /heart rate then settled/i);
  assert.doesNotMatch(cleaned, /physician|urinalysis|if this persists/i);
});

test("visual synthesis rule is broad, head-to-toe, and phase-oriented", () => {
  assert.match(INTEGRATED_HEAD_TO_TOE_RULE, /masturbation\/stimulation sessions, Body Exploration/i);
  assert.match(INTEGRATED_HEAD_TO_TOE_RULE, /face\/head orientation/i);
  assert.match(INTEGRATED_HEAD_TO_TOE_RULE, /timestamps as selective evidence anchors/i);
});

test("laterality rule uses Ben's anatomical side for unmirrored cameras", () => {
  assert.match(UNMIRRORED_ANATOMICAL_LATERALITY_RULE, /All cameras are unmirrored/i);
  assert.match(UNMIRRORED_ANATOMICAL_LATERALITY_RULE, /screen-left is Ben's anatomical RIGHT/i);
  assert.match(UNMIRRORED_ANATOMICAL_LATERALITY_RULE, /omit the side or mark it indeterminate/i);
});
