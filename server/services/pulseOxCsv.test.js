import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePulseOxCsv } from '../../src/utils/parsePulseOxCsv.js';

test('parsePulseOxCsv accepts EMAY-style timestamp, SpO2, and PR columns', () => {
  const csv = [
    'Time,SpO2,PR',
    '6/5/2026 12:55:34 AM,94,88',
    '6/5/2026 12:55:35 AM,94,88',
    '6/5/2026 12:55:36 AM,95,89',
  ].join('\n');

  const result = parsePulseOxCsv(csv);

  assert.equal(result.error, undefined);
  assert.equal(result.imported, 3);
  assert.equal(result.rows[0].spo2_percent, 94);
  assert.equal(result.rows[0].pulse_bpm, 88);
  assert.equal(result.rows[1].time_offset_s, 1);
  assert.equal(result.rows[2].source_device, 'EMAY pulse oximeter');
});

test('parsePulseOxCsv falls back to second and third columns when EMAY headers are vague', () => {
  const csv = [
    'Time,Value1,Value2',
    '6/5/2026 12:55:34 AM,94,88',
    '6/5/2026 12:55:35 AM,93,89',
  ].join('\n');

  const result = parsePulseOxCsv(csv);

  assert.equal(result.imported, 2);
  assert.equal(result.rows[1].spo2_percent, 93);
  assert.equal(result.rows[1].pulse_bpm, 89);
});
