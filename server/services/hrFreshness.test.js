import assert from 'node:assert/strict';
import test from 'node:test';
import {
  SHARED_HR_PACKET_STALE_MS,
  isSharedHrPacketFresh,
  parseHrTimestamp,
} from './hrFreshness.js';

test('shared Android HR remains connected across short background delivery gaps', () => {
  const now = Date.parse('2026-06-28T12:00:30.000Z');
  assert.equal(SHARED_HR_PACKET_STALE_MS, 30000);
  assert.equal(isSharedHrPacketFresh('2026-06-28T12:00:10.000Z', { now }), true);
  assert.equal(isSharedHrPacketFresh('2026-06-28T11:59:59.999Z', { now }), false);
});

test('shared HR freshness accepts numeric timestamps and small clock skew', () => {
  const now = Date.parse('2026-06-28T12:00:00.000Z');
  assert.equal(parseHrTimestamp(now - 1000), now - 1000);
  assert.equal(isSharedHrPacketFresh(now + 3000, { now }), true);
  assert.equal(isSharedHrPacketFresh(now + 6000, { now }), false);
});

test('missing or malformed packet timestamps are not treated as connected', () => {
  assert.equal(isSharedHrPacketFresh(null), false);
  assert.equal(isSharedHrPacketFresh('not-a-time'), false);
});
