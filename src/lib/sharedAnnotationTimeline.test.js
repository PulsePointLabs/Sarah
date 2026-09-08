import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { annotationTimelineEntries, savedAnnotationReview } from './manualAnnotationFrameCoverage.js';
import { manualAnnotationReport } from './manualAnnotationReport.js';

test('one shared list preserves every old annotation, new Feet annotation, and session event with original indices', () => {
  const events = [
    ...Array.from({ length: 97 }, (_, i) => ({ event_id: `old-${i}`, note: `Original ${i}`, time_s: i, source: 'manual' })),
    ...Array.from({ length: 4 }, (_, i) => ({ event_id: `feet-${i}`, note: `Feet ${i}`, time_s: i, source: 'manual', annotation_camera: { role: 'feet' } })),
    { source: 'sarah_live_cue', note: 'Session-wide event', time_s: 100 },
  ];
  const before = JSON.stringify(events);
  const entries = annotationTimelineEntries(events);
  assert.equal(entries.length, 102);
  entries.forEach(({ ev, i }) => assert.equal(ev, events[i]));
  assert.equal(JSON.stringify(events), before);
});

test('each card keeps its saved report regardless of currently selected playback camera', () => {
  const old = { event_id: 'old', time_s: 72, note: 'Old observation' };
  const fresh = { event_id: 'feet', time_s: 72, note: 'Feet observation', annotation_camera: { role: 'feet' } };
  const mainReview = { event_id: 'old', source_video_role: 'main', summary: 'Original Main report.' };
  const feetReview = { event_id: 'feet', source_video_role: 'feet', summary: 'Your toes curl.' };
  assert.equal(savedAnnotationReview([mainReview, feetReview], old), mainReview);
  assert.equal(savedAnnotationReview([mainReview, feetReview], fresh), feetReview);
  assert.equal(savedAnnotationReview([mainReview, { ...feetReview, event_id: 'old' }], old), mainReview);
});

test('existing Main summary and findings are preserved verbatim, including uncertainty', () => {
  const review = { source_video_role: 'main', summary: 'Your posture does not appear changed.', findings: [{ anatomical_area: 'Trunk', observation: 'Original finding.', confidence: 'moderate' }] };
  const report = manualAnnotationReport(review);
  assert.equal(report.summary, review.summary);
  assert.equal(report.findings, review.findings);
});

test('production Feet filter accepts legs and visible pelvis but rejects genital or stimulation content', () => {
  const source = fs.readFileSync(new URL('../../server/routes/jobs.js', import.meta.url), 'utf8');
  const start = source.indexOf('const FEET_AUDIT_FORBIDDEN_RE');
  const end = source.indexOf('function sanitizeFeetLaneSnapshotText', start);
  const ctx = {};
  vm.runInNewContext(`${source.slice(start, end)}\nglobalThis.accept = isFeetLaneAuditItem;`, ctx);
  assert.equal(ctx.accept({ anatomical_area: 'Left toes', observation: 'Your toes extend.', response_domain: 'movement' }), true);
  assert.equal(ctx.accept({ anatomical_area: 'Pelvis', observation: 'Your pelvis lifts.', response_domain: 'posture' }), true);
  assert.equal(ctx.accept({ anatomical_area: 'Genitals', observation: 'Visible change.' }), false);
  assert.equal(ctx.accept({ anatomical_area: 'Pelvis', observation: 'Visible movement.', response_domain: 'stimulation' }), false);
});
