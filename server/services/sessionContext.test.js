import test from 'node:test';
import assert from 'node:assert/strict';
import { pulseOxReadingsFromSession, sessionContextEvidenceItems, sessionContextEvidenceText, structuredSessionContextForAI } from '../../src/lib/sessionContext.js';

const session = {
  session_context: {
    fatigue: 'tired',
    hydration_state: 'electrolyte_supported',
    food_state: 'normal_meal',
    alcohol: {
      used: true,
      qualitative_level: 'moderate',
      timing_relative_to_session: 'under_30_min',
    },
    cannabis: {
      used: true,
      route: 'smoked',
      qualitative_level: 'moderate',
      timing_relative_to_session: 'under_30_min',
    },
    mental_state: ['calm', 'mildly_distracted', 'meditative'],
    privacy_interruptibility: 'fully_private',
    environmental_preparation: ['tools_prepared', 'media_prepared', 'room_prepared', 'telemetry_active'],
  },
};

test('structured session context preserves logged influence categories for AI grounding', () => {
  const context = structuredSessionContextForAI(session);
  assert.equal(context.fatigue, 'tired');
  assert.equal(context.hydration_state, 'electrolyte_supported');
  assert.equal(context.food_state, 'normal_meal');
  assert.equal(context.alcohol.used, true);
  assert.equal(context.cannabis.route, 'smoked');
  assert.deepEqual(context.mental_state, ['calm', 'mildly_distracted', 'meditative']);
  assert.equal(context.privacy_interruptibility, 'fully_private');
  assert.deepEqual(context.environmental_preparation, ['tools_prepared', 'media_prepared', 'room_prepared', 'telemetry_active']);
});

test('session context evidence text does not collapse populated context into no influences', () => {
  const items = sessionContextEvidenceItems(session);
  const text = sessionContextEvidenceText(session);
  assert.ok(items.length >= 8);
  assert.match(text, /Alcohol: logged use/i);
  assert.match(text, /Cannabis: logged use \(Smoked, Moderate, Under 30 minutes before\)/i);
  assert.match(text, /Hydration: Intentionally hydrated \/ electrolyte supported/i);
  assert.doesNotMatch(text, /No influences/i);
});

test('structured session context accepts camelCase and legacy session fields', () => {
  const context = structuredSessionContextForAI({
    session_context: {
      hydrationState: 'electrolyte_supported',
      foodState: 'normal_meal',
      mentalState: ['calm', 'meditative'],
      privacy: 'fully_private',
      preparation: ['tools_prepared', 'telemetry_active'],
    },
    fatigue: 'tired',
  });

  assert.equal(context.fatigue, 'tired');
  assert.equal(context.hydration_state, 'electrolyte_supported');
  assert.equal(context.food_state, 'normal_meal');
  assert.deepEqual(context.mental_state, ['calm', 'meditative']);
  assert.equal(context.privacy_interruptibility, 'fully_private');
  assert.deepEqual(context.environmental_preparation, ['tools_prepared', 'telemetry_active']);
});

test('session context includes pulse oximetry as AI evidence', () => {
  const pulseOxSession = {
    pulse_ox_source: 'EMAY app CSV',
    pulse_ox_readings: [
      { measured_at: '2026-06-05T04:55:34.000Z', time_offset_s: 0, spo2_percent: 94, pulse_bpm: 88, source_app: 'EMAY app CSV' },
      { measured_at: '2026-06-05T04:55:35.000Z', time_offset_s: 1, spo2_percent: 95, pulse_bpm: 89, source_app: 'EMAY app CSV' },
      { measured_at: '2026-06-05T04:55:36.000Z', time_offset_s: 2, spo2_percent: 93, pulse_bpm: 90, source_app: 'EMAY app CSV' },
    ],
  };
  const readings = pulseOxReadingsFromSession(pulseOxSession);
  const context = structuredSessionContextForAI(pulseOxSession);
  const text = sessionContextEvidenceText(pulseOxSession);

  assert.equal(readings.length, 3);
  assert.equal(context.pulse_ox_summary.samples, 3);
  assert.equal(context.pulse_ox_summary.min_spo2_percent, 93);
  assert.match(text, /Pulse oximetry: 3 samples, average SpO2 94%, minimum SpO2 93%, average pulse 89 bpm/i);
});
