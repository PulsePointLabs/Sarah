import test from 'node:test';
import assert from 'node:assert/strict';
import { sessionContextEvidenceItems, sessionContextEvidenceText, structuredSessionContextForAI } from '../../src/lib/sessionContext.js';

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
