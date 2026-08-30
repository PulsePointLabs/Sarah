import test from "node:test";
import assert from "node:assert/strict";
import {
  INTEGRATED_HEAD_TO_TOE_RULE,
  NO_CLIPBOARD_CLUTCHING_RULE,
  removeMedicalReferralAndWarningLanguage,
  SYSTEMATIC_VISIBLE_BODY_REVIEW_RULE,
  UNMIRRORED_ANATOMICAL_LATERALITY_RULE,
  VISUAL_TELEMETRY_SEPARATION_RULE,
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
  assert.match(INTEGRATED_HEAD_TO_TOE_RULE, /generalized or regional skin flushing/i);
  assert.match(INTEGRATED_HEAD_TO_TOE_RULE, /spasm-like movement/i);
  assert.match(INTEGRATED_HEAD_TO_TOE_RULE, /nearest comparable visible baseline/i);
});

test("annotation rule requires systematic coverage and keeps telemetry out of visual prose", () => {
  assert.match(SYSTEMATIC_VISIBLE_BODY_REVIEW_RULE, /head\/face; jaw\/neck; shoulders\/upper back/i);
  assert.match(SYSTEMATIC_VISIBLE_BODY_REVIEW_RULE, /arching or spinal extension/i);
  assert.match(SYSTEMATIC_VISIBLE_BODY_REVIEW_RULE, /cannot exclude a brief movement between frames/i);
  assert.match(VISUAL_TELEMETRY_SEPARATION_RULE, /Do not include heart rate, beats per minute/i);
  assert.match(VISUAL_TELEMETRY_SEPARATION_RULE, /remains saved as separate aligned metadata/i);
});

test("laterality rule uses Ben's anatomical side for unmirrored cameras", () => {
  assert.match(UNMIRRORED_ANATOMICAL_LATERALITY_RULE, /All cameras are unmirrored/i);
  assert.match(UNMIRRORED_ANATOMICAL_LATERALITY_RULE, /screen-left is Ben's anatomical RIGHT/i);
  assert.match(UNMIRRORED_ANATOMICAL_LATERALITY_RULE, /omit the side or mark it indeterminate/i);
});
