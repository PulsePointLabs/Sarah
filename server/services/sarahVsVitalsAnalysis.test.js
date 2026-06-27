import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildVitalsAnalysisInput,
  buildVitalsAnalysisPrompt,
  isCurrentVitalsAnalysis,
  wrapVitalsAnalysis,
} from './sarahVsVitalsAnalysis.js';

function transferFixture() {
  return {
    id: 'transfer-1',
    imported_at: '2026-06-26T23:10:00.000Z',
    exported_at_utc: '2026-06-26T23:09:00.000Z',
    payload: {
      scope: 'full_session_vitals_context',
      deviceTimezone: 'America/New_York',
      session: {
        sessionId: 'session-1',
        title: 'Test session',
        startedAtUtc: '2026-06-26T20:00:00.000Z',
        durationSeconds: 120,
        heartRate: { baselineBpm: 80, averageBpm: 92, maxBpm: 120, finalBpm: 86 },
        hrv: { rmssdMs: 22.4, quality: 'good' },
      },
      events: [{
        elapsedSeconds: 30,
        label: 'Activity',
        note: 'Walked upstairs',
        heartRateAtEvent: { currentBpm: 108, averageBpmSoFar: 91, maxBpmSoFar: 108 },
      }],
      bloodPressureReadings: [{
        timestampUtc: '2026-06-26T20:01:00.000Z',
        systolic: 126,
        diastolic: 82,
        meanArterialPressure: 97,
        pulse: 88,
        source: 'private-device-id',
      }],
      heartRateTrend: Array.from({ length: 500 }, (_, index) => ({ elapsedSeconds: index, heartRateBpm: 80 + (index % 20) })),
    },
  };
}

test('vital analysis input preserves clinical context while bounding trend data', () => {
  const input = buildVitalsAnalysisInput(transferFixture());
  assert.equal(input.session.title, 'Test session');
  assert.equal(input.events[0].note, 'Walked upstairs');
  assert.equal(input.bloodPressureReadings[0].pulsePressure, 44);
  assert.equal(input.bloodPressureReadings[0].source, undefined);
  assert.equal(input.heartRateTrend.length, 240);
  assert.equal(input.heartRateTrend[0].elapsedSeconds, 0);
  assert.equal(input.heartRateTrend.at(-1).elapsedSeconds, 499);
});

test('vital analysis prompt requires cautious event-linked interpretation', () => {
  const prompt = buildVitalsAnalysisPrompt(transferFixture());
  assert.match(prompt, /clinically literate but personal/i);
  assert.match(prompt, /Correlate event notes/i);
  assert.match(prompt, /Do not invent ECG findings/i);
  assert.match(prompt, /not evidence that a PulsePoint sexual/i);
  assert.match(prompt, /user-entered context only/i);
  assert.match(prompt, /Address the user only as "you" and "your"/i);
  assert.match(prompt, /spell out numbers and durations/i);
  assert.match(prompt, /Walked upstairs/);
});

test('wrapped analysis records generation and source export timestamps for cache display', () => {
  const transfer = transferFixture();
  const wrapped = wrapVitalsAnalysis({ headline: 'A steady recovery' }, {
    transfer,
    model: 'test-model',
    generatedAt: '2026-06-26T23:11:00.000Z',
  });
  assert.equal(wrapped.schema_version, 'sarah.vitals.analysis.v2');
  assert.equal(wrapped.generated_at, '2026-06-26T23:11:00.000Z');
  assert.equal(wrapped.source_exported_at_utc, transfer.exported_at_utc);
  assert.equal(wrapped.headline, 'A steady recovery');
  assert.equal(isCurrentVitalsAnalysis(wrapped), true);
  assert.equal(isCurrentVitalsAnalysis({ schema_version: 'sarah.vitals.analysis.v1' }), false);
});
