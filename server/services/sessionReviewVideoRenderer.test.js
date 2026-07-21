import assert from 'node:assert/strict';
import test from 'node:test';
import { buildReviewVideoPlan } from './sessionReviewVideoPlanner.js';
import {
  buildActiveStimulationFallbackEvent,
  buildReusedNarrationSegmentPlan,
  inferReviewVisualFocus,
  matchAudioExport,
  canonicalPhaseAnchorForNarration,
  resolveReviewSegmentPhaseCarryover,
  resolveTimestampViolationVisualFallback,
  selectDistinctReviewSourceStart,
  selectReviewVideoEventForSegment,
  telemetryAtSessionTime,
} from './sessionReviewVideoRenderer.js';

test('review video focus targets named glans findings with a restrained push-in', () => {
  const focus = inferReviewVisualFocus('At 6:12, glans engorgement and meatal flushing become visible.');
  assert.equal(focus.target, 'glans');
  assert.equal(focus.preferredRole, 'main');
  assert.ok(focus.zoom > 1 && focus.zoom <= 1.3);
});

test('review video focus targets the named foot and prefers foot-camera imagery', () => {
  const focus = inferReviewVisualFocus('Right foot flushing increases near 12:40.');
  assert.equal(focus.target, 'right_foot');
  assert.equal(focus.preferredRole, 'feet');
});

test('review video focus preserves laterality for plantar flexion without the word foot', () => {
  const focus = inferReviewVisualFocus('Right plantar flexion and toe curl become visible at 10:54.');
  assert.equal(focus.target, 'right_foot');
  assert.equal(focus.preferredRole, 'feet');
});

test('review video leaves telemetry-only narration full frame', () => {
  assert.equal(inferReviewVisualFocus('Heart rate rises to 118 BPM while RMSSD falls.'), null);
});

test('review video telemetry uses the nearest session-time HR sample', () => {
  const telemetry = telemetryAtSessionTime({
    avg: 99,
    max: 119,
    baseline: 88,
    rows: [
      { time: 240, hr: 101, baseline: 88 },
      { time: 243, hr: 104, baseline: 88 },
      { time: 246, hr: 107, baseline: 88 },
    ],
  }, 243.4);

  assert.deepEqual(telemetry, { hr: 104, avg: 99, max: 119, load: 52 });
});

test('matching saved narration is split locally using persisted export timing', () => {
  const plan = buildReusedNarrationSegmentPlan({
    narrationSegments: [
      { paragraphIndex: 0, text: 'First saved sentence.' },
      { paragraphIndex: 1, text: 'Second saved sentence is longer.' },
    ],
    sourceChunks: ['First saved sentence.', 'Second saved sentence is longer.'],
    trimChunks: [
      { trimmed_duration_seconds: 1.25 },
      { trimmed_duration_seconds: 2.75 },
    ],
    durationSeconds: 99,
  });

  assert.equal(plan.length, 2);
  assert.equal(plan[0].startSeconds, 0);
  assert.equal(plan[0].timingSource, 'saved_export_chunk_durations');
  assert.ok(Math.abs(plan.reduce((sum, item) => sum + item.durationSeconds, 0) - 4) < 0.001);
});

test('legacy saved MP3 with exact source identity matches despite title formatting', () => {
  const request = {
    sessionId: 'session-july-1',
    title: 'AI Session Analysis · Jul 1, 2026',
    reviewType: 'session_ai_analysis',
    sourceGeneratedAt: '2026-07-03T18:31:39.069Z',
    voice: 'nova',
    model: 'tts-1-hd',
    speed: 0.98,
    outputFormat: 'mp3',
  };
  const legacyExport = {
    file_url: '/uploads/july-1-2026-ai-session-analysis.mp3',
    render_version: 'tts_export_leading_trim_v2',
    tts_session_key: 'session-july-1',
    source_generated_at: '2026-07-03T18:31:39.069Z',
    title: 'July 1 2026 – AI Session Analysis',
    voice: 'nova',
    model: 'tts-1-hd',
    speed: 0.98,
    format: 'mp3',
  };

  assert.equal(matchAudioExport(legacyExport, request), true);
  assert.equal(matchAudioExport({ ...legacyExport, source_generated_at: 'different' }, request), false);
});

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

test('active stimulation fallback prefers on-table stimulation over empty-table or ambulatory context', () => {
  const fallback = buildActiveStimulationFallbackEvent({
    session: {
      event_timeline: [
        {
          id: 'empty-room',
          time_s: 18,
          note: 'Table vacant while the room is empty and setup remains visible.',
          category: ['context'],
        },
        {
          id: 'ambulatory',
          time_s: 44,
          note: 'Ambulatory and walking away from the table while checking tubing.',
          category: ['context'],
        },
        {
          id: 'active-contact',
          time_s: 96,
          note: 'Right-hand stroking continues on the penis with active stimulation on the table.',
          category: ['stimulation'],
          annotation_tags: ['hand_contact', 'stroking', 'active_stimulation'],
        },
      ],
    },
    segment: {
      paragraphIndex: 1,
      text: 'Sarah is still discussing active stimulation and visible masturbation technique.',
    },
    primaryVideo: { path: 'E:/recordings/source.mp4' },
    sourceDuration: 780,
    fallbackCursor: 90,
  });

  assert.ok(fallback);
  assert.equal(Math.round(fallback.session_time_s), 96);
  assert.match(fallback.note, /stroking continues/i);
});

test('active stimulation fallback returns null when only empty-room or off-table anchors exist', () => {
  const fallback = buildActiveStimulationFallbackEvent({
    session: {
      event_timeline: [
        {
          id: 'empty-room',
          time_s: 18,
          note: 'Table vacant while the room is empty and setup remains visible.',
          category: ['context'],
        },
        {
          id: 'ambulatory',
          time_s: 44,
          note: 'Ambulatory and walking away from the table while checking tubing.',
          category: ['context'],
        },
      ],
    },
    segment: {
      paragraphIndex: 1,
      text: 'Generic narration without a saved timed event.',
    },
    primaryVideo: { path: 'E:/recordings/source.mp4' },
    sourceDuration: 780,
    fallbackCursor: 30,
  });

  assert.equal(fallback, null);
});

test('missing phase offsets never create fake climax or recovery anchors at session zero', () => {
  const fallback = buildActiveStimulationFallbackEvent({
    session: {
      pre_climax_offset_s: null,
      climax_offset_s: null,
      recovery_offset_s: null,
      event_timeline: [
        {
          id: 'setup-zero',
          time_s: 0,
          note: 'Session recording begins with an empty exam table and no body or stimulation visible yet.',
          category: ['other'],
        },
        {
          id: 'active-contact',
          time_s: 102,
          note: 'Hand contact begins at the penis and active stimulation is visible on the table.',
          category: ['stimulation_resumed'],
          annotation_tags: ['hand_contact', 'stimulation_start'],
        },
      ],
    },
    segment: {
      paragraphIndex: 4,
      text: 'The final build and orgasm discussion continues here without an explicit timestamp.',
    },
    primaryVideo: { path: 'E:/recordings/source.mp4' },
    sourceDuration: 780,
    fallbackCursor: 0,
  });

  assert.ok(fallback);
  assert.equal(Math.round(fallback.session_time_s), 102);
  assert.equal(fallback.id, 'active-contact');
  assert.equal(canonicalPhaseAnchorForNarration({
    session: { climax_offset_s: null },
    narrationText: 'Climax and ejaculation are discussed here.',
  }), null);
  assert.equal(canonicalPhaseAnchorForNarration({
    session: { recovery_offset_s: 0 },
    narrationText: 'Recovery follows the climax.',
  }), null);
});

test('final-build narration prefers late active evidence over stronger early setup contact', () => {
  const fallback = buildActiveStimulationFallbackEvent({
    session: {
      event_timeline: [
        {
          id: 'early-contact',
          time_s: 150,
          note: 'Hand contact at the scrotal-base and penis during early stimulation positioning.',
          category: ['stimulation'],
        },
        {
          id: 'late-build',
          time_s: 1070,
          note: 'Bilateral tension and high-load build continue immediately before the terminal recovery transition.',
          category: ['movement_observed'],
          annotation_tags: ['high_load_plateau', 'pre_recovery', 'build'],
        },
      ],
    },
    segment: {
      paragraphIndex: 8,
      text: 'The final build provides the cardiovascular correlate of orgasm and climax.',
    },
    primaryVideo: { path: 'E:/recordings/source.mp4' },
    sourceDuration: 1222,
    fallbackCursor: 0,
  });

  assert.ok(fallback);
  assert.equal(fallback.id, 'late-build');
  assert.equal(Math.round(fallback.session_time_s), 1070);
  assert.ok(fallback._phase_position_score > 150);
});

test('generic review b-roll avoids reusing a nearby source-video window', () => {
  const start = selectDistinctReviewSourceStart({
    preferredStart: 124,
    durationSeconds: 8,
    sourceDuration: 300,
    usedWindows: [{ start: 120, end: 130, label: 'Prior context' }],
  });

  assert.notEqual(start, null);
  assert.ok(Math.abs(start - 120) >= 18);
});

test('generic review b-roll falls back when no distinct source window exists', () => {
  const start = selectDistinctReviewSourceStart({
    preferredStart: 6,
    durationSeconds: 8,
    sourceDuration: 18,
    usedWindows: [{ start: 0, end: 10, label: 'Prior context' }],
  });

  assert.equal(start, null);
});

test('recovery narration retains its marker and generic context never rewinds to zero', () => {
  const canonicalRecovery = canonicalPhaseAnchorForNarration({
    session: {
      pre_climax_offset_s: 729,
      climax_offset_s: 828,
      recovery_offset_s: 837,
    },
    narrationText: 'Recovery, by contrast, showed the most open HRV of the session after the climax-to-recovery transition.',
  });
  assert.equal(canonicalRecovery.session_time_s, 837);

  const recovery = {
    id: 'recovery-marker',
    paragraphIndex: 7,
    session_time_s: 837,
    label: 'Recovery shift',
    reason: 'Logged recovery phase marker',
    source: 'phase_marker',
  };
  const first = resolveReviewSegmentPhaseCarryover({
    segment: { paragraphIndex: 7, text: 'Recovery begins after orgasm.' },
    directEvent: recovery,
    paragraphText: 'Recovery begins after orgasm. Your heart rate continues falling as contact lightens.',
  });
  const continued = resolveReviewSegmentPhaseCarryover({
    segment: { paragraphIndex: 7, text: 'Your heart rate continues falling as contact lightens.' },
    phaseAnchorEvent: first.nextPhaseAnchor,
    paragraphText: 'Recovery begins after orgasm. Your heart rate continues falling as contact lightens.',
  });
  assert.equal(continued.carried, true);
  assert.equal(continued.event.session_time_s, 837);

  const unrelated = resolveReviewSegmentPhaseCarryover({
    segment: { paragraphIndex: 1, text: 'The session opens at baseline.' },
    directEvent: recovery,
    paragraphText: 'The session opens at baseline before any stimulation contact.',
  });
  assert.equal(unrelated.nextPhaseAnchor, null);

  const sourceStart = selectDistinctReviewSourceStart({
    preferredStart: 875,
    durationSeconds: 20,
    sourceDuration: 905,
    usedWindows: [{ start: 870, end: 900 }],
    preventRewind: true,
  });
  assert.equal(sourceStart, null);
});

test('explicit review timestamps can reuse a nearby source-video window', () => {
  const start = selectDistinctReviewSourceStart({
    preferredStart: 124,
    durationSeconds: 8,
    sourceDuration: 300,
    usedWindows: [{ start: 120, end: 130, label: 'Prior context' }],
    allowNearRepeat: true,
  });

  assert.equal(start, 124);
});
