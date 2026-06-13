import test from 'node:test';
import assert from 'node:assert/strict';

import {
  deviceEvidenceStageForText,
  hasVisibleFoleyAdvancementCue,
  sanitizeSecondPersonProcedureLanguage,
  sanitizeFoleyProcedureText,
  sanitizeSleeveSessionText,
} from '../../src/lib/videoPassTextGuards.js';

test('blocks Foley tip-at-meatus claims when contact is not explicitly confirmed', () => {
  const input = 'Other hand introduces and begins advancing the lubricated 18Fr Foley catheter tip toward and at the meatus.';
  const result = sanitizeFoleyProcedureText(input);

  assert.match(result.text, /catheter tip at the meatus is not confirmed/i);
  assert.doesNotMatch(result.text, /toward and at the meatus/i);
  assert.ok(result.flags.some((flag) => /Meatus/.test(flag)));
});

test('blocks catheter contacting or advancing through meatus language', () => {
  const input = 'The catheter tip is contacting the meatus and advancing through the meatus.';
  const result = sanitizeFoleyProcedureText(input);

  assert.match(result.text, /not confirmed/i);
  assert.doesNotMatch(result.text, /contacting the meatus/i);
  assert.doesNotMatch(result.text, /advancing through the meatus/i);
});

test('allows visible Foley advancement from shortening external catheter length', () => {
  const input = 'Visible Foley advancement continues at the glans as less external catheter shaft remains visible across sampled frames.';
  const result = sanitizeFoleyProcedureText(input);

  assert.equal(hasVisibleFoleyAdvancementCue(input), true);
  assert.doesNotMatch(result.text, /not confirmed/i);
  assert.match(result.text, /less external catheter shaft remains visible/i);
});

test('device evidence badge accepts progressive Foley advancement cue', () => {
  const result = deviceEvidenceStageForText('External Foley length shortens while aligned with the meatus during active advancement.');

  assert.equal(result.blocked, false);
  assert.equal(result.stage, 'Foley evidence');
});

test('replaces detached subject language with you and your', () => {
  const input = "Subject visible seated on the procedure table; subject remains relaxed and the subject's glans is visible.";
  const result = sanitizeSecondPersonProcedureLanguage(input);

  assert.doesNotMatch(result, /\bsubject\b/i);
  assert.match(result, /you are visible seated/i);
  assert.match(result, /you remain relaxed/i);
  assert.match(result, /your glans/i);
});

test('replaces operator language with gloved-hand language', () => {
  const input = 'Operator hand withdraws from genital field while the operator handles drape material.';
  const result = sanitizeSecondPersonProcedureLanguage(input);

  assert.doesNotMatch(result, /\boperator\b/i);
  assert.match(result, /gloved hand withdraws/i);
  assert.match(result, /gloved person handles/i);
});

test('keeps the blue tray item from becoming Foley evidence', () => {
  const input = 'Blue-tipped object consistent with Foley drainage tubing or catheter port remains visible; Foley appears already in place.';
  const result = sanitizeFoleyProcedureText(input);

  assert.match(result.text, /blue item on the procedure tray/i);
  assert.match(result.text, /placement is not confirmed/i);
  assert.doesNotMatch(result.text, /blue-tipped object consistent with Foley/i);
});

test('demotes already-in-place and dwell claims without completion evidence', () => {
  const input = 'Yellow Foley tubing exits the glans, confirming the catheter is already in place during continued dwell interval.';
  const result = sanitizeFoleyProcedureText(input);

  assert.match(result.text, /not confirmed/i);
  assert.doesNotMatch(result.text, /already in place/i);
  assert.doesNotMatch(result.text, /dwell interval/i);
});

test('blocks sleeve-based stimulation before visible sleeve placement', () => {
  const input = 'Right hand gripping and stroking sleeve - sleeve-based stimulation underway continuing from prior window.';
  const result = sanitizeSleeveSessionText(input);

  assert.match(result.text, /sleeve.*not confirmed|sleeve\/hand preparation/i);
  assert.doesNotMatch(result.text, /sleeve-based stimulation underway/i);
});

test('device evidence badge marks blocked claims', () => {
  const result = deviceEvidenceStageForText('Catheter tip is contacting the meatus.');

  assert.equal(result.blocked, true);
  assert.equal(result.stage, 'meatus contact not confirmed');
});
