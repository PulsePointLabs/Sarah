import assert from 'node:assert/strict';
import test from 'node:test';
import { coalesceDuplicateHrRows } from './hrCaptureMerge.js';

test('coalesces near-identical relay and direct H10 samples into the richer row', () => {
  const rows = coalesceDuplicateHrRows([
    {
      time_offset_s: 4.1,
      hr: 101,
      hr_source: 'heartrateonstream',
      note: 'relay note',
    },
    {
      time_offset_s: 4.103,
      hr: 101,
      hr_source: 'direct_h10',
      rr_intervals_ms: '594',
      hrv_rmssd_ms: 21,
    },
  ]);

  assert.equal(rows.length, 1);
  assert.equal(rows[0].hr_source, 'direct_h10');
  assert.equal(rows[0].rr_intervals_ms, '594');
  assert.equal(rows[0].note, 'relay note');
});

test('preserves distinct samples and same-source updates', () => {
  const input = [
    { time_offset_s: 1, hr: 90, hr_source: 'direct_h10' },
    { time_offset_s: 1.02, hr: 91, hr_source: 'heartrateonstream' },
    { time_offset_s: 1.04, hr: 91, hr_source: 'heartrateonstream' },
  ];

  assert.deepEqual(coalesceDuplicateHrRows(input), input);
});
