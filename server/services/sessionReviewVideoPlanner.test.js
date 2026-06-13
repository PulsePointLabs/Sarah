import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildReviewVideoPlan,
  extractCitedTimesFromParagraphs,
  extractCitedTimesFromText,
} from './sessionReviewVideoPlanner.js';

test('extractCitedTimesFromText handles numeric and natural session times', () => {
  const times = extractCitedTimesFromText(
    'At 15:43 there was a shift, with another note around fifteen minutes and forty-three seconds. Recovery was 943 seconds.'
  );
  assert.equal(times.length, 1);
  assert.equal(times[0].seconds, 943);
});

test('extractCitedTimesFromParagraphs keeps separate distant moments and paragraph indexes', () => {
  const times = extractCitedTimesFromParagraphs([
    'The first useful marker is around four minutes.',
    'The second useful marker is at 6:35.',
  ]);
  assert.deepEqual(times.map((time) => time.seconds), [240, 395]);
  assert.deepEqual(times.map((time) => time.paragraphIndex), [0, 1]);
});

test('buildReviewVideoPlan prefers existing clips over duplicate generated requests', () => {
  const plan = buildReviewVideoPlan({
    paragraphs: ['One section references 10:00.', 'Another section references 12:00.'],
    paragraphMeta: [{ type: 'summary' }, { sec: { label: 'Events' } }],
    existingClips: [{ id: 'clip-1', session_time_s: 604, file_url: '/uploads/existing.mp4', paragraphIndex: 0 }],
  });
  assert.equal(plan.citedTimes.length, 2);
  assert.equal(plan.existingClips.length, 1);
  assert.equal(plan.generatedClipRequests.length, 1);
  assert.equal(plan.generatedClipRequests[0].session_time_s, 720);
  assert.equal(plan.paragraphPlans[1].label, 'Events');
});

test('buildReviewVideoPlan maps physiology language to logged event anchors', () => {
  const plan = buildReviewVideoPlan({
    paragraphs: [
      'During ejaculation, your body appeared to maintain effort briefly before release completed.',
      'At 4:30, your penis was being supported by your left hand while the stimulation angle changed.',
    ],
    session: {
      climax_offset_s: 612,
      event_timeline: [
        { time_s: 270, note: 'Penis supported by left hand; stimulation angle changed', category: 'physical' },
      ],
    },
  });

  assert.equal(plan.generatedClipRequests[0].paragraphIndex, 0);
  assert.equal(plan.generatedClipRequests[0].session_time_s, 612);
  assert.equal(plan.generatedClipRequests[1].paragraphIndex, 1);
  assert.equal(plan.generatedClipRequests[1].session_time_s, 270);
});

test('buildReviewVideoPlan prefers pause/lubricant anchors over active stroking anchors', () => {
  const plan = buildReviewVideoPlan({
    paragraphs: [
      'You pause and apply lubricant before returning to more active stimulation.',
    ],
    session: {
      event_timeline: [
        { time_s: 432, note: 'Right hand contact continues with ongoing active stroking or repositioning', category: 'stimulation' },
        { time_s: 491, note: 'Lubricant bottle visible near glans; possible lubrication application or preparation around this point', category: 'physical' },
        { time_s: 636, note: 'Hand contact withdraws; penis settles to lower lateral angle', category: 'stimulation_paused' },
      ],
    },
  });

  assert.equal(plan.generatedClipRequests.length, 1);
  assert.equal(plan.generatedClipRequests[0].session_time_s, 491);
  assert.equal(plan.generatedClipRequests[0].startSeconds, 490);
});
