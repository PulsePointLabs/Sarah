import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { buildManualReviewBackfillPlan, missingManualAnnotationEvents } from './manualAnnotationFrameCoverage.js';

const events = [1, 2, 3].map((id) => ({ event_id: String(id), time_s: id * 10, note: `Note ${id}`, source: 'manual' }));
const feet = { key: 'lower_body', role: 'feet', label: 'Feet', filename: 'Feet', fileName: 'Feet', localPath: 'C:/feet.mp4', fingerprint: 'shared' };
const review = (event, role, extra = {}) => ({ event_id: event.event_id, note_time_s: event.time_s, manual_note: event.note, source_video: { role, fingerprint: 'shared' }, coverage_status: 'new_frames_only', note_assessment: 'not_visually_confirmed', findings: [], summary: '', ...extra });

test('main-camera completion cannot remove feet entries from the backfill list', () => {
  assert.deepEqual(missingManualAnnotationEvents(events, events.map((event) => review(event, 'main')), feet), events);
});

test('feet backfill skips genuine empty completions but repairs frame-reuse placeholders', () => {
  const reviews = [review(events[0], 'feet'), review(events[1], 'feet', { coverage_status: 'fully_reused', note_assessment: undefined }), review(events[2], 'main')];
  assert.deepEqual(missingManualAnnotationEvents(events, reviews, feet), [events[1], events[2]]);
});

test('batch plan captures camera, alignment and notes without retaining mutable UI values', () => {
  const feed = { ...feet, timelineOffsetSeconds: 5 };
  const notes = events.map((event) => ({ ...event }));
  const plan = buildManualReviewBackfillPlan(notes, [], feed);
  feed.key = 'main';
  feed.localPath = 'C:/main.mp4';
  feed.timelineOffsetSeconds = 9;
  notes[0].note = 'Edited after batch started';
  assert.equal(plan.feed.key, 'lower_body');
  assert.equal(plan.feed.role, 'feet');
  assert.equal(plan.feed.localPath, 'C:/feet.mp4');
  assert.equal(plan.feed.timelineOffsetSeconds, 5);
  assert.equal(plan.events[0].note, 'Note 1');
});

const source = fs.readFileSync(new URL('../components/VideoSyncPlayer.jsx', import.meta.url), 'utf8');
const functionSource = source.slice(source.indexOf('const backfillMissingManualReviews = async'), source.indexOf('  const startOrResumeVisualSnapshotAudit'));

test('production backfill sends each missing note to the captured camera and forces a real review', async () => {
  let selectedFeed = { ...feet };
  const requests = [];
  const progress = [];
  const context = {
    buildManualReviewBackfillPlan, events,
    manualVisualReviews: [review(events[0], 'feet'), review(events[1], 'main')],
    manualBackfillState: { running: false }, videoOffset: 0,
    selectVisualReviewFeed: () => selectedFeed,
    setManualBackfillState: (state) => progress.push(state),
    showQuickNotice() {},
    queueManualAnnotationVisualReview: async (event, options) => {
      requests.push({ event, options });
      selectedFeed = { ...feet, key: 'main', localPath: 'C:/main.mp4' };
      return true;
    },
  };
  vm.runInNewContext(`${functionSource}\nglobalThis.runBackfill = backfillMissingManualReviews;`, context);
  await context.runBackfill();
  assert.deepEqual(requests.map(({ event }) => event.event_id), ['2', '3']);
  assert.ok(requests.every(({ options }) => options.forceReview && options.feedOverride.key === 'lower_body' && options.feedOverride.localPath === 'C:/feet.mp4'));
  assert.equal(progress.at(-1).current, 2);
  assert.equal(progress.at(-1).cameraLabel, 'Feet');
  assert.equal(progress.at(-1).running, false);
});

test('no linked selected camera produces no backfill requests', () => {
  assert.deepEqual(buildManualReviewBackfillPlan(events, [], { key: 'lower_body' }).events, []);
});
