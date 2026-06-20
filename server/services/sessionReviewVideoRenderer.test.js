import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReviewVideoPlan } from './sessionReviewVideoPlanner.js';
import { selectReviewVideoEventForSegment } from './sessionReviewVideoRenderer.js';

test('untimed Foley placement narration does not jump to drainage-bag b-roll', () => {
  const segment = {
    paragraphIndex: 0,
    text: 'Sarah is discussing meatal engagement, urethral advancement, the main resistance point, and how relaxation changed the insertion.',
  };
  const plan = buildReviewVideoPlan({
    paragraphs: [segment.text],
    session: {
      record_type: 'body_exploration',
      exploration_type: 'Foley catheter insertion',
      event_timeline: [
        {
          id: 'bag-held',
          time_s: 552,
          note: 'Standing near the table while holding the drainage bag and checking tubing slack.',
          category: 'procedure',
        },
      ],
    },
  });

  const selected = selectReviewVideoEventForSegment({
    segment,
    plan,
    clipByParagraph: new Map(),
    usedEventIds: new Set(),
  });

  assert.equal(selected, null);
});

test('explicit Foley timestamps still select the exact spoken timestamp', () => {
  const segment = {
    paragraphIndex: 0,
    text: 'At 4:32, the catheter advances through the main resistance point with deliberate relaxation.',
  };
  const selected = selectReviewVideoEventForSegment({
    segment,
    plan: buildReviewVideoPlan({ paragraphs: [segment.text] }),
    clipByParagraph: new Map(),
    usedEventIds: new Set(),
  });

  assert.ok(selected);
  assert.equal(Math.round(selected.session_time_s), 272);
  assert.equal(selected.source, 'spoken_segment_time');
});
