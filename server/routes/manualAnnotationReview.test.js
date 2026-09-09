import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import * as coverage from '../../src/lib/manualAnnotationFrameCoverage.js';
import * as text from '../../src/lib/manualAnnotationReviewText.js';
import * as temporal from '../../src/lib/manualAnnotationTemporal.js';
import { directObservationText } from '../../src/lib/manualAnnotationReport.js';
import crypto from 'node:crypto';
import { polishFeetReview } from '../services/manualAnnotationNarrative.js';

// Execute the production handler with local file/AI/DB boundaries replaced.
// No session assets or paid API requests are used by these regressions.
const source = fs.readFileSync(new URL('./jobs.js', import.meta.url), 'utf8');
const handlerSource = source.slice(source.indexOf("registerJobHandler('manual_annotation_visual_review'"), source.indexOf('\nfunction visualSnapshotCoveredAt'));

function fixture(prior = [], { duration = 1200, offset = 0 } = {}) {
  let handler;
  let record = { duration_minutes: 18, ai_analysis: { _manual_annotation_visual_reviews: prior } };
  const calls = [];
  const sampled = [];
  const cleanup = [];
  let response = { summary: "", findings: [], narrative: { before: "Before, your left toes begin to curl.", around: "Around the mark, flexion increases.", after: "Afterward, toe flexion decreases while the ankle remains plantar-flexed." } };
  let aiError = null;
  const context = {
    ...coverage, ...text, ...temporal, crypto, directObservationText, polishFeetReview,
    withManualEvidenceWorkspace: async task => { try { return await task("synthetic-workspace"); } finally { cleanup.push("workspace"); } },
    probeAnnotationVideo: async () => ({ width: 1920, height: 1080, fps: 30, duration_s: duration }),
    mainDetailCrops: async () => [],
    retainedEvidenceAvailable: async () => true,
    retainAnnotationEvidence: async frames => frames.map(f => ({ ...f, url: "/mark.jpg" })),
    removeUnpersistedAnnotationEvidence: async () => cleanup.push("unpersisted"),
    denseFeetEvidence: async ({ start, end, offset }) => {
      const times = []; for(let t=start; t<=end+.0001; t+=.125) times.push(t);
      sampled.push(...times);
      const frames=times.map(time => ({ frameTimeSeconds: time, filename: "frame.jpg", mimeType: "image/jpeg", data: "test" }));
      return { frames, crops: [], motion: { sample_fps: 8, frame_times_s: times.map(t => t+offset), frame_metrics: [], tracks: [] } };
    },
    registerJobHandler: (_type, fn) => { handler = fn; },
    normalizeLocalVideoPath: (path) => path,
    localVideoMetadata: async () => ({ path: 'C:/camera.mp4', fingerprint: 'shared-file', durationSeconds: duration }),
    getEntity: () => record,
    upsertEntity: (_entity, _id, next) => { record = next; },
    extractNativeAnnotationFrames: async ({ timesSeconds }) => timesSeconds.map(time => ({ frameTimeSeconds: time, filename: "native.jpg", data: "test", mimeType: "image/jpeg" })),
    aiInvokeInternal: async (request) => {
      calls.push(request);
      if (aiError) throw aiError;
      return response;
    },
    FOOT_ASSESSMENT_SCHEMA: {}, FOOT_VISUAL_REVIEW_RULE: '',
    keepFootVisualItem: () => true, isFeetLaneAuditItem: () => true,
    sanitizeFootSummary: (v) => v, sanitizeFeetLaneSnapshotText: (v) => v,
  };
  vm.runInNewContext(handlerSource, context);
  return {
    calls, sampled, cleanup, record: () => record, setResponse: value => { response = value; }, fail: () => { aiError = new Error("provider failed"); },
    run: (time = 72, extra = {}) => handler({ recordId: 'session', recordType: 'session', event: { event_id: 'note', time_s: time, note: 'Movement', annotation_camera: { role: 'feet' } }, video: { path: 'C:/camera.mp4', role: 'feet', label: 'Feet', timelineOffsetSeconds: offset }, ...extra }, { jobId: 'test', signal: new AbortController().signal, updateProgress() {} }),
  };
}

test('feet review runs despite complete main-camera coverage and preserves both camera results', async () => {
  const prior = { event_id: 'note', note_time_s: 72, manual_note: 'Movement', source_video: { role: 'main', fingerprint: 'shared-file' }, sampled_frames: coverage.manualAnnotationTargetFrameTimes(72).map((recordTimeSeconds) => ({ recordTimeSeconds })) };
  const f = fixture([prior]);
  const result = await f.run();
  assert.equal(f.calls.length, 1);
  assert.equal(f.sampled.length, 81);
  assert.equal(result.source_video_role, 'feet');
  assert.equal(f.record().ai_analysis._manual_annotation_visual_reviews.length, 2);
  assert.match(f.calls[0].prompt, /ACTIVE CAMERA = FEET/);
});

test('18:02 gets the full window despite rounded 18-minute session duration', async () => {
  const f = fixture();
  const result = await f.run(1082);
  assert.equal(f.sampled[0], 1077);
  assert.equal(f.sampled.at(-1), 1087);
  assert.equal(result.reviewed_frame_times_s.at(-1), 1087);
  assert.equal(result.sampled_frames.length, 2);
});

test('source offset and actual video boundary retain correct frame timestamps', async () => {
  const f = fixture([], { duration: 70, offset: 10 });
  const result = await f.run(78);
  assert.equal(f.sampled[0], 63);
  assert.ok(f.sampled.at(-1) > 69.8 && f.sampled.at(-1) < 70);
  assert.equal(result.reviewed_frame_times_s[0], 73);
  assert.ok(result.analyzed_window.end_s > 79.9);
});

test('same-camera overlap never skips the current window and rerun replaces rather than duplicates', async () => {
  const prior = { event_id: 'note', note_time_s: 72, manual_note: 'Movement', source_video: { role: 'feet', fingerprint: 'shared-file' }, sampled_frames: coverage.manualAnnotationTargetFrameTimes(72).map((recordTimeSeconds) => ({ recordTimeSeconds })), findings: [{ anatomical_area: 'Toes', observation: 'Extend', evidence_time_s: 72 }] };
  const f = fixture([prior]);
  const reused = await f.run();
  assert.equal(f.calls.length, 1);
  assert.equal(reused.reviewed_frame_times_s.length, 81);
  const fresh = await f.run(72, { forceReview: true });
  assert.equal(f.calls.length, 2);
  assert.equal(fresh.sampled_frames.length, 2);
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

const finding = (confidence='low') => ({ anatomical_area: 'Left toes', observation: 'Possible slight toe flexion decreased while the ankle remained plantar-flexed.', laterality: 'left', state: 'flexed', magnitude: 'slight', asymmetry: 'left more than right', change: 'release', direction: 'decreasing', temporal_phase: 'after', start_s: 72, evidence_time_s: 73, end_s: 76, confidence, visibility: 'partial', response_domain: 'movement' });
test('uncertain local release remains visible but is not promoted; current narrative has no prior bias', async () => {
  const f=fixture([{event_id:'old',note_time_s:10,manual_note:'old',summary:'RELAXED_OLD_ANCHOR',source_video:{role:'feet'}}]);
  f.setResponse({summary:'', narrative:{before:'Before, toe flexion begins.',around:'Around the mark, the left curl increases.',after:'Afterward, toe flexion decreases while the ankle remains plantar-flexed.'},findings:[finding()]});
  const result=await f.run();
  assert.equal(result.findings.length,1); assert.equal(result.findings[0].evidence_status,'candidate');
  assert.match(result.summary,/Before.*Around.*Afterward/);
  assert.doesNotMatch(result.summary,/Reduced sampled movement/);
  assert.doesNotMatch(f.calls[0].prompt,/RELAXED_OLD_ANCHOR/);
  assert.equal(f.record().ai_analysis._video_pass_findings.length,0);
  assert.deepEqual(f.cleanup,['workspace']);
});
test('high-confidence rerun replaces its secondary card and keeps original timeline untouched',async()=>{
  const f=fixture(); f.setResponse({summary:'toe curl',narrative:{before:'Before, toe curl begins.',around:'Around the mark, left curl increases.',after:'Afterward, local toe flexion decreases.'},findings:[finding('high')]});
  const first=await f.run(); const second=await f.run(72,{forceReview:true});
  assert.equal(first.id,second.id); assert.equal(f.record().ai_analysis._video_pass_findings.length,1);
  assert.equal(f.record().event_timeline,undefined);
});
test('provider failure cleans workspace and never replaces a saved review',async()=>{
  const prior={event_id:'note',note_time_s:72,manual_note:'Movement',source_video:{role:'feet'},summary:'Preserve me'};
  const f=fixture([prior]);f.fail();await assert.rejects(f.run(),/provider failed/);
  assert.equal(f.record().ai_analysis._manual_annotation_visual_reviews[0],prior);
  assert.deepEqual(f.cleanup,['unpersisted','workspace']);
});
test('Main retains original output structure and accepts full original-resolution evidence',async()=>{
  const f=fixture();f.setResponse({summary:'Your abdominal tension increases.',findings:[{...finding('high'),anatomical_area:'Abdomen',observation:'Your abdominal tension increases.'}]});
  const result=await f.run(72,{event:{event_id:'note',time_s:72,note:'Tension',annotation_camera:{role:'main'}},video:{path:'C:/camera.mp4',role:'main'}});
  assert.equal(result.summary,'Your abdominal tension increases.');assert.equal(result.narrative,undefined);
  assert.equal(result.evidence_quality.full_frame_native,true);assert.equal(f.calls[0].response_json_schema.properties.note_assessment,undefined);
  assert.match(f.calls[0].prompt,/glans/);assert.match(f.calls[0].prompt,/grip/);
});
