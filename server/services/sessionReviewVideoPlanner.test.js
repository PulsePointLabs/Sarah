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

test('relative durations are not treated as session timeline anchors', () => {
  const times = extractCitedTimesFromText(
    'Alcohol was consumed within the prior thirty minutes, cannabis approximately thirty to ninety minutes before, and the hold lasted for 30 seconds.'
  );
  assert.deepEqual(times, []);
});

test('natural-language session positions remain timeline anchors', () => {
  const times = extractCitedTimesFromText(
    'The massager was placed between roughly two minutes and twenty-five seconds and two minutes and forty-nine seconds.'
  );
  assert.deepEqual(times.map((time) => time.seconds), [145, 169]);
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

test('buildReviewVideoPlan maps Foley meatus narration to meatal event notes instead of post-procedure b-roll', () => {
  const plan = buildReviewVideoPlan({
    paragraphs: [
      'Sarah discusses the meatus, meatal engagement, and the catheter tip entering before urethral advancement begins.',
    ],
    session: {
      record_type: 'body_exploration',
      exploration_type: 'Foley catheter insertion',
      event_timeline: [
        {
          id: 'post-procedure-bag',
          time_s: 768,
          note: 'Ambulatory transition underway; Foley secured off camera and drainage bag held while getting off the exam table.',
          category: ['instrumentation', 'physical'],
          annotation_tags: ['ambulatory', 'foley_dwell', 'drainage_bag'],
        },
        {
          id: 'meatus-contact',
          time_s: 529,
          note: 'Foley tip makes initial contact with meatus; meatal engagement begins.',
          category: ['instrumentation', 'sensation'],
          annotation_tags: ['catheter_tip_at_meatus', 'meatal_contact', 'insertion_beginning'],
        },
      ],
    },
  });

  assert.equal(plan.generatedClipRequests.length, 1);
  assert.equal(plan.generatedClipRequests[0].session_time_s, 529);
  assert.match(plan.generatedClipRequests[0].label, /meatus/i);
});

test('buildReviewVideoPlan maps Foley balloon narration to balloon seating event notes', () => {
  const plan = buildReviewVideoPlan({
    paragraphs: [
      'The balloon inflation and seating phase is clinically important because urgency passed after traction.',
    ],
    session: {
      event_timeline: [
        {
          time_s: 529,
          note: 'Foley tip makes initial contact with meatus; meatal engagement begins.',
          category: ['instrumentation'],
          annotation_tags: ['catheter_tip_at_meatus'],
        },
        {
          time_s: 698,
          note: 'Balloon confirmed seated at bladder neck; urgency sensation passes, no discomfort, traction hold maintained.',
          category: ['instrumentation_change', 'comfort', 'sensation'],
          annotation_tags: ['balloon_seated', 'bladder_neck', 'urgency_resolved', 'no_discomfort'],
        },
      ],
    },
  });

  assert.equal(plan.generatedClipRequests.length, 1);
  assert.equal(plan.generatedClipRequests[0].session_time_s, 698);
  assert.match(plan.generatedClipRequests[0].label, /Balloon/i);
});
