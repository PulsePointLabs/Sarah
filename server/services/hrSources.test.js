import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDirectH10Telemetry } from './hrSources.js';

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
