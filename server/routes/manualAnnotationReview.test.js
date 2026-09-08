import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as coverage from '../../src/lib/manualAnnotationFrameCoverage.js';
import * as text from '../../src/lib/manualAnnotationReviewText.js';

// Execute the production handler with local file/AI/DB boundaries replaced.
// No session assets or paid API requests are used by these regressions.
const source = fs.readFileSync(new URL('./jobs.js', import.meta.url), 'utf8');
const handlerSource = source.slice(source.indexOf("registerJobHandler('manual_annotation_visual_review'"), source.indexOf('\nfunction visualSnapshotCoveredAt'));

function fixture(prior = [], { duration = 1200, offset = 0 } = {}) {
  let handler;
  let record = { duration_minutes: 18, ai_analysis: { _manual_annotation_visual_reviews: prior } };
  const calls = [];
  const sampled = [];
  const context = {
    ...coverage, ...text,
    registerJobHandler: (_type, fn) => { handler = fn; },
    normalizeLocalVideoPath: (path) => path,
    localVideoMetadata: async () => ({ path: 'C:/camera.mp4', fingerprint: 'shared-file', durationSeconds: duration }),
    getEntity: () => record,
    upsertEntity: (_entity, _id, next) => { record = next; },
    extractLocalVideoFramesAtTimes: async ({ timesSeconds }) => {
      sampled.push(...timesSeconds);
      return { meta: { fingerprint: 'shared-file' }, frames: timesSeconds.map((time) => ({ frameTimeSeconds: time, url: '/synthetic.jpg', filename: 'synthetic.jpg', mimeType: 'image/jpeg', data: 'test' })) };
    },
    aiInvokeInternal: async (request) => {
      calls.push(request);
      return { summary: '', findings: [], note_assessment: 'not_visually_confirmed' };
    },
    FOOT_ASSESSMENT_SCHEMA: {}, FOOT_VISUAL_REVIEW_RULE: '',
    keepFootVisualItem: () => true, isFeetLaneAuditItem: () => true,
    sanitizeFootSummary: (v) => v, sanitizeFeetLaneSnapshotText: (v) => v,
  };
  vm.runInNewContext(handlerSource, context);
  return {
    calls, sampled, record: () => record,
    run: (time = 72, extra = {}) => handler({ recordId: 'session', recordType: 'session', event: { event_id: 'note', time_s: time, note: 'Movement', annotation_camera: { role: 'feet' } }, video: { path: 'C:/camera.mp4', role: 'feet', label: 'Feet', timelineOffsetSeconds: offset }, ...extra }, { jobId: 'test', signal: new AbortController().signal, updateProgress() {} }),
  };
}

test('feet review runs despite complete main-camera coverage and preserves both camera results', async () => {
  const prior = { event_id: 'note', note_time_s: 72, manual_note: 'Movement', source_video: { role: 'main', fingerprint: 'shared-file' }, sampled_frames: coverage.manualAnnotationTargetFrameTimes(72).map((recordTimeSeconds) => ({ recordTimeSeconds })) };
  const f = fixture([prior]);
  const result = await f.run();
  assert.equal(f.calls.length, 1);
  assert.equal(f.sampled.length, 11);
  assert.equal(result.source_video_role, 'feet');
  assert.equal(f.record().ai_analysis._manual_annotation_visual_reviews.length, 2);
  assert.match(f.calls[0].prompt, /ACTIVE CAMERA = FEET/);
});

test('18:02 gets the full window despite rounded 18-minute session duration', async () => {
  const f = fixture();
  const result = await f.run(1082);
  assert.deepEqual(f.sampled, coverage.manualAnnotationTargetFrameTimes(1082));
  assert.equal(result.sampled_frames.at(-1).recordTimeSeconds, 1087);
});

test('source offset and actual video boundary retain correct frame timestamps', async () => {
  const f = fixture([], { duration: 70, offset: 10 });
  const result = await f.run(78);
  assert.deepEqual(f.sampled, [63, 64, 65, 66, 67, 68, 69]);
  assert.deepEqual(Array.from(result.reviewed_frame_times_s), [73, 74, 75, 76, 77, 78, 79]);
});

test('same-camera reuse retains evidence and explicit rerun analyzes the full window', async () => {
  const prior = { event_id: 'note', note_time_s: 72, manual_note: 'Movement', source_video: { role: 'feet', fingerprint: 'shared-file' }, sampled_frames: coverage.manualAnnotationTargetFrameTimes(72).map((recordTimeSeconds) => ({ recordTimeSeconds })), findings: [{ anatomical_area: 'Toes', observation: 'Extend', evidence_time_s: 72 }] };
  const f = fixture([prior]);
  const reused = await f.run();
  assert.equal(f.calls.length, 0);
  assert.equal(reused.reused_findings.length, 1);
  const fresh = await f.run(72, { forceReview: true });
  assert.equal(f.calls.length, 1);
  assert.equal(fresh.sampled_frames.length, 11);
  assert.equal(f.record().ai_analysis._manual_annotation_visual_reviews.length, 1);
});

test('an annotation outside the camera video fails visibly instead of claiming reuse', async () => {
  const f = fixture([], { duration: 10 });
  await assert.rejects(f.run(100), /outside the selected camera/);
  assert.equal(f.calls.length, 0);
});

test('backend refuses a feet review for an annotation owned by main', async () => {
  const f = fixture();
  await assert.rejects(f.run(72, { event: { event_id: 'note', time_s: 72, note: 'Movement', annotation_camera: { role: 'main' } } }), /belongs to another camera/);
  assert.equal(f.calls.length, 0);
});
