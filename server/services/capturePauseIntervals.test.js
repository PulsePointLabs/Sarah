import assert from 'node:assert/strict';
import test from 'node:test';
import {
  closeCapturePauseIntervals,
  summarizeCapturePauseIntervals,
} from './capturePauseIntervals.js';

test('closes an open pause at the recording stop while preserving local timestamps', () => {
  const intervals = closeCapturePauseIntervals([{
    pausedAtMs: Date.parse('2026-07-21T20:05:00-04:00'),
    pausedAt: '2026-07-22T00:05:00.000Z',
    resumedAtMs: null,
  }], Date.parse('2026-07-21T20:12:00-04:00'));

  assert.equal(intervals[0].resumedAt, '2026-07-22T00:12:00.000Z');
  assert.equal(intervals[0].durationMs, 7 * 60 * 1000);
});

test('reports wall time and active time separately', () => {
  const summary = summarizeCapturePauseIntervals([{
    pausedAtMs: 5 * 60 * 1000,
    resumedAtMs: 12 * 60 * 1000,
  }], 1, 20 * 60 * 1000);

  assert.equal(summary.pausedDurationMs, 7 * 60 * 1000);
  assert.equal(summary.wallDurationMs, 20 * 60 * 1000 - 1);
  assert.equal(summary.activeDurationMs, 13 * 60 * 1000 - 1);
});
