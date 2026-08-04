import assert from 'node:assert/strict';
import test from 'node:test';
import { findRelevantSessionEvidence, findRelevantVitalEvidence } from './sarahConversationContext.js';

test('structured retrieval returns matching timestamped events instead of unrelated recent records', () => {
  const evidence = findRelevantSessionEvidence([
    {
      id: 'older-match',
      __entity: 'body_exploration',
      date: '2026-07-20',
      title: 'Foley insertion',
      notes: 'A catheter placement session.',
      event_timeline: [
        { time_s: 378, source: 'manual', note: 'Catheter fully seated after passing the sphincter.' },
      ],
    },
    {
      id: 'newer-unrelated',
      __entity: 'session',
      date: '2026-07-29',
      title: 'App test',
      notes: 'Video player and settings test.',
      event_timeline: [],
    },
  ], 'What happened when the catheter passed the sphincter?');

  assert.equal(evidence[0].sourceId, 'older-match');
  assert.ok(evidence.some((item) => /6:18/.test(item.text)));
  assert.ok(evidence.every((item) => item.sourceId !== 'newer-unrelated'));
});

test('vitals questions retrieve measured session-window glucose and session evidence', () => {
  const evidence = findRelevantVitalEvidence([{
    id: 'session-vitals',
    __entity: 'session',
    date: '2026-07-29',
    avg_hr: 92,
    max_hr: 118,
    blood_glucose_readings: [
      { measured_at: '2026-07-29T20:10:00-04:00', glucose_mg_dl: 108, source_app: 'OneTouch Reveal CSV' },
    ],
    pulse_ox_readings: [
      { measured_at: '2026-07-29T20:12:00-04:00', spo2_percent: 96, pulse_bpm: 92, source_app: 'EMAY app CSV' },
    ],
  }], 'How did my blood glucose and SpO2 look?', [{
    measured_at: '2026-07-29T20:10:00-04:00',
    glucose_mg_dl: 108,
  }]);

  assert.ok(evidence.length >= 2);
  assert.ok(evidence.every((item) => item.evidenceClass === 'measured'));
  assert.match(evidence.map((item) => item.text).join(' '), /Imported blood glucose history/i);
  assert.match(evidence.map((item) => item.text).join(' '), /108 mg\/dL/i);
});

test('vitals retrieval includes glucose, blood pressure, pulse ox, and body composition stores together', () => {
  const evidence = findRelevantVitalEvidence([], 'Can you see all my blood sugar, BP, SpO2, weight, and body composition?', {
    bloodGlucose: [{ measured_at: '2026-08-01T05:00:00-04:00', glucose_mg_dl: 90, source_app: 'OneTouch' }],
    bloodPressure: [{ measured_at: '2026-08-01T05:05:00-04:00', systolic_mm_hg: 125, diastolic_mm_hg: 88, pulse_bpm: 100 }],
    pulseOx: [{ measured_at: '2026-08-01T05:10:00-04:00', spo2_percent: 98, pulse_bpm: 96 }],
    bodyComposition: [{ measured_at: '2026-08-01T04:30:00-04:00', weight_kg: 81.48, body_fat_percent: 18.2 }],
  });
  const text = evidence.map((item) => item.text).join(' ');
  assert.match(text, /90 mg\/dL/);
  assert.match(text, /125\/88 mmHg/);
  assert.match(text, /SpO2 98%/);
  assert.match(text, /179\.6 lb/);
});

test('last night around midnight retrieves body exploration records by local time without keyword overlap', () => {
  const evidence = findRelevantSessionEvidence([
    {
      id: 'midnight-exploration',
      __entity: 'body_exploration',
      date: '2026-07-30T00:00:00',
      start_time: '00:25',
      capture_started_at: '2026-07-30T04:25:00.000Z',
      title: 'Live body exploration Jul 30',
      notes: 'Body exploration capture created from Live Capture.',
      event_timeline: [{ time_s: 120, note: 'Saved marker.' }],
    },
    {
      id: 'old-unrelated',
      __entity: 'session',
      date: '2026-07-20T00:00:00',
      start_time: '15:00',
      title: 'Old session',
      notes: 'Old unrelated record.',
    },
  ], 'Please find the body exploration I did last night around midnight.', {
    now: new Date('2026-07-30T15:30:00-04:00').getTime(),
  });

  assert.equal(evidence[0].sourceId, 'midnight-exploration');
  assert.ok(evidence.every((item) => item.sourceId !== 'old-unrelated'));
  assert.match(evidence[0].text, /relative time reference/i);
});
