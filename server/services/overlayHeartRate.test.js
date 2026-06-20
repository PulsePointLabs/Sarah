import assert from 'node:assert/strict';
import test from 'node:test';
import { HR_SOURCE_IDS, HR_SOURCE_LABELS } from './hrSources.js';
import { normalizeOverlayHeartRateSnapshot } from './overlayHeartRate.js';

test('overlay snapshot normalizes heartRate aliases', () => {
  const snapshot = normalizeOverlayHeartRateSnapshot({
    telemetry: { currentHr: 109, receivedAt: 1000, source: HR_SOURCE_IDS.PULSOID },
    sourceStatus: { source: HR_SOURCE_IDS.PULSOID, label: HR_SOURCE_LABELS[HR_SOURCE_IDS.PULSOID], connected: true },
    now: 1200,
    sequence: 7,
  });

  assert.equal(snapshot.heartRate, 109);
  assert.equal(snapshot.currentHr, 109);
  assert.equal(snapshot.source, HR_SOURCE_IDS.PULSOID);
  assert.equal(snapshot.connected, true);
  assert.equal(snapshot.stale, false);
  assert.equal(snapshot.sequence, 7);
});

test('overlay snapshot hides stale heart rate instead of freezing old BPM', () => {
  const snapshot = normalizeOverlayHeartRateSnapshot({
    telemetry: { heartRate: 109, receivedAt: 1000 },
    sourceStatus: { connected: true },
    now: 10000,
    staleMs: 5000,
  });

  assert.equal(snapshot.heartRate, null);
  assert.equal(snapshot.currentHr, null);
  assert.equal(snapshot.connected, false);
  assert.equal(snapshot.stale, true);
});

test('overlay snapshot does not require client-side Pulsoid token data', () => {
  const snapshot = normalizeOverlayHeartRateSnapshot({
    telemetry: { hr: 88, receivedAt: 1000, sourceLabel: 'Pulsoid / Polar H10' },
    sourceStatus: { source: HR_SOURCE_IDS.PULSOID, connected: true },
    now: 1100,
  });

  assert.equal(snapshot.heartRate, 88);
  assert.equal(JSON.stringify(snapshot).includes('token'), false);
});
