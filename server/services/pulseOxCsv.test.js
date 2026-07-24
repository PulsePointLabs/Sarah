import test from 'node:test';
import assert from 'node:assert/strict';
import { decodePulseOxCsvBytes, parsePulseOxCsv } from '../../src/utils/parsePulseOxCsv.js';

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

test('parsePulseOxCsv aligns rows to session start and filters outside session end', () => {
  const csv = [
    'Time,SpO2,PR',
    '6/5/2026 12:55:34 AM,94,88',
    '6/5/2026 12:55:35 AM,94,88',
    '6/5/2026 12:55:36 AM,95,89',
    '6/5/2026 12:55:37 AM,95,90',
  ].join('\n');

  const result = parsePulseOxCsv(csv, {
    sessionStartAt: new Date(2026, 5, 5, 0, 55, 35).toISOString(),
    sessionEndAt: new Date(2026, 5, 5, 0, 55, 36).toISOString(),
  });

  assert.equal(result.error, undefined);
  assert.equal(result.imported, 2);
  assert.equal(result.filteredBefore, 1);
  assert.equal(result.filteredAfter, 1);
  assert.equal(result.rows[0].time_offset_s, 0);
  assert.equal(result.rows[1].time_offset_s, 1);
  assert.equal(result.rows[0].spo2_percent, 94);
  assert.equal(result.rows[1].spo2_percent, 95);
});

test('parsePulseOxCsv finds metadata-prefixed semicolon exports with Unicode SpO2 headers', () => {
  const csv = [
    'EMAY Oximeter Data Export',
    'Generated;7/23/2026',
    'Date;Time;SpO₂ (%);Pulse Rate (bpm);PI',
    '7/23/2026;8:20:01 PM;97;104;4.2',
    '7/23/2026;8:20:02 PM;98;105;4.0',
  ].join('\n');

  const result = parsePulseOxCsv(csv);

  assert.equal(result.imported, 2);
  assert.equal(result.rows[0].spo2_percent, 97);
  assert.equal(result.rows[1].pulse_bpm, 105);
  assert.equal(result.rows[0].perfusion_index, 4.2);
});

test('decodePulseOxCsvBytes reads UTF-16LE EMAY exports', () => {
  const source = '\uFEFFTime\tSpO₂\tPR\r\n7/23/2026 8:20:01 PM\t97\t104';
  const bytes = new Uint8Array(2 + source.length * 2);
  bytes[0] = 0xff;
  bytes[1] = 0xfe;
  for (let index = 0; index < source.length; index += 1) {
    const code = source.charCodeAt(index);
    bytes[2 + index * 2] = code & 0xff;
    bytes[3 + index * 2] = code >> 8;
  }

  const result = parsePulseOxCsv(decodePulseOxCsvBytes(bytes));
  assert.equal(result.imported, 1);
  assert.equal(result.rows[0].spo2_percent, 97);
});
