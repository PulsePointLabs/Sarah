import assert from 'node:assert/strict';
import test from 'node:test';
import { HR_SOURCE_IDS, HR_SOURCE_LABELS } from './hrSources.js';
import { normalizeOverlayHeartRateSnapshot, normalizeOverlayPhysiology } from './overlayHeartRate.js';

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

test('overlay physiology exposes only validated live summary fields', () => {
  const physiology = normalizeOverlayPhysiology({
    hrv: { rmssdMs: 18.24, quality: 'high', sampleCount: 180 },
    multimodal: {
      signalConfidence: { score: 82 },
      state: { key: 'building_load', label: 'BUILDING LOAD', tone: 'warn' },
      respiration: { available: true, bpm: 14.26, confidence: 'high', source: 'ecg_derived' },
      motion: { available: true, class: 'moderate_motion', dynamicRmsMilliG: 143.8 },
      recovery: { available: true, currentDropBpm: 6.2 },
    },
  });

  assert.deepEqual(physiology, {
    stale: false,
    signalConfidence: 82,
    state: { key: 'building_load', label: 'BUILDING LOAD', tone: 'warn' },
    hrv: { available: true, rmssdMs: 18.2, quality: 'high', sampleCount: 180 },
    respiration: {
      available: true,
      bpm: 14.3,
      confidence: 'high',
      source: 'ecg_derived',
      possibleBreathHold: false,
      reason: null,
    },
    motion: { available: true, class: 'moderate_motion', dynamicRmsMilliG: 144, reason: null },
    recovery: { available: true, currentDropBpm: 6 },
  });
});

test('overlay physiology withholds invalid or stale estimates', () => {
  const invalid = normalizeOverlayPhysiology({
    hrv: { rmssdMs: 0 },
    multimodal: {
      signalConfidence: { score: 150 },
      respiration: { available: true, bpm: 0 },
      motion: { available: false, class: 'unavailable', dynamicRmsMilliG: 300 },
    },
  });
  assert.equal(invalid.hrv.available, false);
  assert.equal(invalid.respiration.available, false);
  assert.equal(invalid.motion.available, false);
  assert.equal(invalid.signalConfidence, null);

  const stale = normalizeOverlayPhysiology({
    hrv: { rmssdMs: 22 },
    multimodal: { respiration: { available: true, bpm: 16 } },
  }, { stale: true });
  assert.equal(stale.stale, true);
  assert.equal(stale.hrv.available, false);
  assert.equal(stale.respiration.available, false);
});
