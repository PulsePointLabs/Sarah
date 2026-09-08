import test from 'node:test';
import assert from 'node:assert/strict';
import { directObservationText, manualAnnotationReport } from './manualAnnotationReport.js';

test('omitting a disputed or uncertain sentence never reverses its meaning', () => {
  assert.equal(directObservationText('Your foot does not appear relaxed. Your toes curl.'), 'Your toes curl.');
});

test('uncertain or obscured structured states are omitted rather than asserted', () => {
  const report = manualAnnotationReport({ foot_assessment: { left: { ankle_state: 'uncertain', toe_state: 'obscured', movement_state: 'uncertain', bracing_state: 'uncertain', evidence_frames: [72] } } });
  assert.deepEqual(report.findings, []);
});

test('main and feet share the same direct findings format without duplicate findings', () => {
  const finding = { anatomical_area: 'Left toes', observation: 'Your toes extend.', evidence_time_s: 72 };
  const report = manualAnnotationReport({ summary: 'Your toes extend.', findings: [finding], reused_findings: [finding] });
  assert.deepEqual(report.findings, [finding]);
  assert.equal(report.summary, 'Your toes extend.');
});
