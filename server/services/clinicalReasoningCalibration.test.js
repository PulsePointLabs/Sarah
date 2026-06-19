import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClinicalReasoningCalibrationRule } from '../../src/utils/clinicalReasoningCalibration.js';

const rule = buildClinicalReasoningCalibrationRule();

test('clinical calibration ranks specific morphology and symptoms before broad history', () => {
  assert.match(rule, /direct visual observations/i);
  assert.match(rule, /user-reported symptoms/i);
  assert.match(rule, /high-specificity morphology-plus-symptom clusters before broad background explanations/i);
  assert.match(rule, /distinctive cluster should be surfaced as the leading possibility/i);
});

test('clinical calibration keeps history as contributor and risk modifier', () => {
  assert.match(rule, /Preserve longitudinal context/i);
  assert.match(rule, /contributing environment or risk modifiers/i);
  assert.match(rule, /modify likelihood, susceptibility, severity, healing risk, and next steps/i);
  assert.match(rule, /edema, venous disease/i);
});

test('clinical calibration softens diagnostic certainty when remote confirmation is limited', () => {
  assert.match(rule, /Avoid "almost certainly", "definitely", "clearly proves"/i);
  assert.match(rule, /most consistent with/i);
  assert.match(rule, /raises concern for/i);
  assert.match(rule, /the images alone cannot confirm/i);
});

test('clinical calibration allows coexisting processes without becoming generic', () => {
  assert.match(rule, /could coexist with/i);
  assert.match(rule, /may be contributing/i);
  assert.match(rule, /Continue Sarah's warm, detailed clinical storytelling/i);
  assert.match(rule, /Do not become terse, generic, alarmist, or disconnected/i);
});

test('clinical calibration covers the plantar maceration example without erasing context', () => {
  assert.match(rule, /localized plantar maceration/i);
  assert.match(rule, /severe odor/i);
  assert.match(rule, /shallow crater-like pits/i);
  assert.match(rule, /pitted keratolysis/i);
  assert.match(rule, /Moisture retention, occlusive footwear, sweating, edema, venous disease/i);
  assert.match(rule, /not automatic primary diagnoses/i);
});
