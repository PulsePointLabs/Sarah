import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDirectH10Telemetry, sharedHrSourceUpdateAction } from './hrSources.js';

test('opening another H10 screen preserves the shared stream before and during OBS recording', () => {
  for (const recordingActive of [false, true]) {
    assert.equal(sharedHrSourceUpdateAction({ currentSource: 'direct_h10', requestedSource: 'direct_h10', recordingActive, h10CollectorActive: true }), 'preserve');
  }
});

test('stale preferences cannot replace a live phone collector or switch sources while recording', () => {
  assert.equal(sharedHrSourceUpdateAction({ currentSource: 'direct_h10', requestedSource: 'pulsoid', recordingActive: false, h10CollectorActive: true }), 'collector_locked');
  assert.equal(sharedHrSourceUpdateAction({ currentSource: 'direct_h10', requestedSource: 'pulsoid', recordingActive: true, h10CollectorActive: false }), 'recording_locked');
  assert.equal(sharedHrSourceUpdateAction({ currentSource: 'direct_h10', requestedSource: 'pulsoid', recordingActive: false, h10CollectorActive: false }), 'apply');
});

test('direct H10 normalization keeps multimodal summary but excludes raw sensor batches from live state', () => {
  const telemetry = normalizeDirectH10Telemetry({
    heartRate: 92,
    measuredAt: 1000,
    rrIntervalsMs: [650, 652],
    multimodal: {
      signalConfidence: { score: 82, level: 'high' },
      motion: { class: 'low_motion' },
      respiration: { available: true, bpm: 14.2 },
    },
    sensorBatch: {
      ecg: [{ timestampMs: 1000, microvolts: 120 }],
      accelerometer: [{ timestampMs: 1000, xMilliG: 0, yMilliG: 0, zMilliG: 1000 }],
    },
  }, 1000);

  assert.equal(telemetry.multimodal.respiration.bpm, 14.2);
  assert.equal(telemetry.raw.sensorBatch, undefined);
  assert.equal(telemetry.currentHr, 92);
});
