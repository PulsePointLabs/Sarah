import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { annotationCameraRole, annotationCameraFromFeed, cameraAnnotationEntries, missingManualAnnotationEvents } from './manualAnnotationFrameCoverage.js';

const note = (id, camera) => ({ event_id: id, time_s: 72, note: id, source: 'manual', ...(camera ? { annotation_camera: { role: camera } } : {}) });

test('97 main annotations and four feet annotations yield only four feet backfill candidates', () => {
  const events = [...Array.from({ length: 97 }, (_, i) => note(`main-${i}`, 'main')), ...Array.from({ length: 4 }, (_, i) => note(`feet-${i}`, 'feet'))];
  const feet = { role: 'feet' };
  assert.equal(missingManualAnnotationEvents(events, [], feet).length, 4);
  assert.equal(cameraAnnotationEntries(events, [], feet).length, 4);
  assert.equal(cameraAnnotationEntries(events, [], { role: 'main' }).length, 97);
  // Filtering must retain full-timeline indices for edit/delete operations.
  assert.deepEqual(cameraAnnotationEntries(events, [], feet).map(({ i }) => i), [97, 98, 99, 100]);
});

test('legacy ownership uses exact annotation IDs, leaves ambiguous notes unassigned, and honors explicit correction', () => {
  const event = note('legacy');
  const review = { event_id: 'legacy', source_video: { role: 'feet' } };
  assert.equal(annotationCameraRole(event, [review]), 'feet');
  assert.equal(annotationCameraRole(event, [{ ...review, event_id: 'different' }]), '');
  const conflicting = [review, { ...review, source_video: { role: 'main' } }];
  assert.equal(annotationCameraRole(event, conflicting), '');
  assert.equal(annotationCameraRole(note('legacy', 'feet'), conflicting), 'feet');
  assert.equal(annotationCameraRole({ ...event, annotation_camera: { role: '' } }, [review]), '');
});

test('unassigned annotations and session-wide telemetry remain accessible without joining camera backfill', () => {
  const events = [note('old'), { source: 'sarah_live_cue', note: 'Session cue', time_s: 72 }];
  assert.equal(missingManualAnnotationEvents(events, [], { role: 'feet' }).length, 0);
  assert.equal(cameraAnnotationEntries(events, [], { role: 'feet' }, 'unassigned').length, 1);
  assert.equal(cameraAnnotationEntries(events, [], { role: 'feet' }, 'session').length, 1);
});

test('manual save persists the camera captured when the draft began, despite a later camera switch', async () => {
  const source = fs.readFileSync(new URL('../components/VideoSyncPlayer.jsx', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('const commitAdd = async'), source.indexOf('  const startAddAtPlayhead'));
  const saved = [];
  const queued = [];
  const ctx = {
    annotationCameraFromFeed,
    newNote: 'Feet move', savingEvent: false, newMin: '1', newSec: '12', newCatsTouched: false,
    events: [note('existing-main', 'main')],
    annotationDraftFeedRef: { current: { key: 'lower_body', localPath: 'C:/feet.mp4', label: 'Feet' } },
    selectedAnnotationFeedRef: { current: { key: 'main', localPath: 'C:/main.mp4' } },
    getEventClassification: async () => ({ categories: ['movement'], annotation_tags: [] }),
    saveEvents: async (events) => saved.push(events),
    queueManualAnnotationVisualReview: (event, options) => queued.push({ event, options }),
    stopListening() {}, pulseHaptic() {},
    crypto: { randomUUID: () => 'new' },
  };
  for (const name of body.match(/\bset[A-Z]\w*(?=\()/g)) ctx[name] = () => {};
  vm.runInNewContext(`${body}\nglobalThis.save = commitAdd;`, ctx);
  await ctx.save();
  assert.equal(saved[0][0].annotation_camera.role, 'main');
  assert.equal(saved[0][1].annotation_camera.role, 'feet');
  assert.equal(queued[0].options.feedOverride.key, 'lower_body');
});
