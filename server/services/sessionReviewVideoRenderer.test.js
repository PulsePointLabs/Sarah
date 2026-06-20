import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReviewVideoPlan } from './sessionReviewVideoPlanner.js';
import { resolveTimestampViolationVisualFallback, selectReviewVideoEventForSegment } from './sessionReviewVideoRenderer.js';

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

test('untimed Foley meatus narration selects the meatus event when one exists', () => {
  const segment = {
    paragraphIndex: 0,
    text: 'Sarah is discussing meatal engagement, the meatus, and the catheter tip beginning insertion.',
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
        {
          id: 'meatus-contact',
          time_s: 529,
          note: 'Foley tip makes initial contact with meatus; meatal engagement begins.',
          category: 'instrumentation',
          annotation_tags: ['catheter_tip_at_meatus', 'meatal_contact'],
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

  assert.ok(selected);
  assert.equal(selected.session_time_s, 529);
  assert.match(selected.label, /meatus/i);
});

test('Foley event chooser prefers a fresh matching event over repeating an already-used event', () => {
  const segment = {
    paragraphIndex: 0,
    text: 'Sarah is discussing Foley urethral advancement and the resistance point during insertion.',
  };
  const plan = buildReviewVideoPlan({
    paragraphs: [segment.text],
    session: {
      event_timeline: [
        {
          id: 'meatus-contact',
          time_s: 529,
          note: 'Foley tip makes initial contact with meatus; meatal engagement begins.',
          category: 'instrumentation',
          annotation_tags: ['catheter_tip_at_meatus', 'meatal_contact'],
        },
        {
          id: 'sphincter-resistance',
          time_s: 557,
          note: 'Mild to moderate resistance at the external sphincter as Foley advancement continues.',
          category: 'instrumentation',
          annotation_tags: ['external_sphincter', 'resistance', 'foley_advancement'],
        },
      ],
    },
  });

  const selected = selectReviewVideoEventForSegment({
    segment,
    plan,
    clipByParagraph: new Map(),
    usedEventIds: new Set(['logged-meatus-contact']),
  });

  assert.ok(selected);
  assert.equal(selected.session_time_s, 557);
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

test('out-of-range narrated timestamps clamp to source video instead of title cards', () => {
  const segment = {
    paragraphIndex: 0,
    text: 'At 34:00, Sarah describes the final placement state.',
  };
  const fallback = resolveTimestampViolationVisualFallback({
    segment,
    timestampRequirement: {
      required: true,
      primary: {
        seconds: 2040,
        text: '34:00',
        charIndex: 3,
        source: 'colon_time',
      },
    },
    audioDuration: 7,
    primaryVideo: { path: 'E:/recordings/source.mp4' },
    sourceDuration: 780,
    fallbackCursor: 120,
  });

  assert.ok(fallback);
  assert.equal(fallback.fallbackType, 'nearest_available_source_video');
  assert.equal(fallback.visualSource, 'clamped_source_video');
  assert.equal(fallback.sourceTimeStrategy, 'clamped_to_nearest_available_source_video');
  assert.equal(Math.round(fallback.event.session_time_s), 2040);
  assert.ok(fallback.window.start >= 0);
  assert.ok(fallback.window.end <= 780.1);
  assert.ok(fallback.window.sessionStartSeconds <= fallback.event.session_time_s);
  assert.notEqual(fallback.window.label, 'No Time-Matched Visual');
});

test('direct narrated timestamps keep clip lead-in on the timeline counter', () => {
  const segment = {
    paragraphIndex: 0,
    text: 'At 4:32, the catheter advances through the main resistance point with deliberate relaxation.',
  };
  const fallback = resolveTimestampViolationVisualFallback({
    segment,
    event: {
      id: 'direct-4-32',
      session_time_s: 272,
      spoken_char_index: 3,
      source: 'spoken_segment_time',
      direct_spoken_time: true,
      force_direct_cut: true,
      label: 'Referenced 4:32',
    },
    audioDuration: 8,
    primaryVideo: { path: 'E:/recordings/source.mp4' },
    sourceDuration: 780,
  });

  assert.ok(fallback.window.start < 272);
  assert.ok(fallback.window.sessionStartSeconds < 272);
  assert.equal(Math.round(fallback.window.sessionSeconds), 272);
});
