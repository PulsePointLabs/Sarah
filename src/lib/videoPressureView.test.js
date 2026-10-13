import test from 'node:test';
import assert from 'node:assert/strict';
import { videoPressureSummary, pressureOverview, nearestPressureBurst } from './videoPressureView.js';
const row = (t, delta) => ({ t, pressure_kpa: 20 + delta, delta_kpa: delta, usable: true, calibration_valid: true, calibration: { id: 'ref', baseline: 20 }, duration_s: 0 });
test('video pressure statistics stop at playhead and compare the same reference', () => {
  const rows = [row(0, 1), row(.1, 2), row(.2, 100)];
  const summary = videoPressureSummary(rows, [], .1);
  assert.equal(summary.relative, true); assert.equal(summary.value, 2);
  assert.equal(summary.average, 1.5); assert.equal(summary.peak, 2);
  assert.deepEqual(summary.range, [0, 2]);
  assert.equal(videoPressureSummary(rows, [], 10).value, null);
});
test('overview envelopes retain a narrow peak without inventing joined samples', () => {
  const rows = Array.from({ length: 1000 }, (_, i) => row(i / 10, i === 451 ? 9 : 0));
  const envelope = pressureOverview(rows, 20);
  assert.ok(envelope.length <= 20); assert.equal(Math.max(...envelope.map(bin => bin.max)), 29);
  assert.equal(pressureOverview([{ ...row(0, 1), gap: true }]).length, 0);
});
test('burst navigation chooses the containing or nearest interval', () => {
  const trains = [{ start: 5, end: 9 }, { start: 20, end: 25 }];
  assert.equal(nearestPressureBurst(trains, 7), 0);
  assert.equal(nearestPressureBurst(trains, 24), 1);
  assert.equal(nearestPressureBurst([], 7), -1);
});
