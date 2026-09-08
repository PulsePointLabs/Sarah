import test from "node:test";
import assert from "node:assert/strict";
import {
  manualAnnotationTargetFrameTimes,
  reviewedFrameTimesForVideo,
  uncoveredFrameTimes,
  sameVideoEvidenceSource,
  findManualAnnotationReview,
  mergeManualAnnotationReview,
  reusedManualAnnotationEvidence,
} from "./manualAnnotationFrameCoverage.js";

test("builds a centered eleven-frame review window", () => {
  assert.deepEqual(manualAnnotationTargetFrameTimes(20), [15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25]);
});

test("different camera roles never share coverage, even with the same fingerprint", () => {
  const main = { source_video: { fingerprint: "same-file", role: "main" }, sampled_frames: [{ recordTimeSeconds: 72 }] };
  const feet = { fingerprint: "same-file", role: "feet" };
  assert.equal(sameVideoEvidenceSource(main, feet), false);
  assert.deepEqual(reviewedFrameTimesForVideo({ _video_pass_findings: [main] }, feet), []);
  assert.equal(sameVideoEvidenceSource({ source_video: { ...feet, role: "lower_body" } }, feet), true);
  assert.equal(sameVideoEvidenceSource({ source_video: { fingerprint: "same-file" } }, feet), false);
});

test("replacement files, unknown sources, and changed alignment do not inherit coverage", () => {
  const source = { role: "feet", fingerprint: "old", path: "C:/feet.mp4", timelineOffsetSeconds: 3 };
  assert.equal(sameVideoEvidenceSource({ source_video: source }, { ...source, fingerprint: "new" }), false);
  assert.equal(sameVideoEvidenceSource({ source_video: source }, { ...source, timelineOffsetSeconds: 4 }), false);
  assert.equal(sameVideoEvidenceSource({ source_video: { role: "feet" } }, { role: "feet" }), false);
});

test("saving the same annotation on feet preserves main review and lookup follows selected camera", () => {
  const event = { event_id: "note-1", time_s: 72, note: "Visible movement" };
  const main = { event_id: event.event_id, note_time_s: 72, manual_note: event.note, source_video: { role: "main", fingerprint: "file" } };
  const feet = { ...main, source_video: { role: "feet", fingerprint: "file" } };
  const saved = mergeManualAnnotationReview([main], feet);
  assert.equal(saved.length, 2);
  assert.equal(findManualAnnotationReview(saved, event, feet.source_video), feet);
  assert.equal(findManualAnnotationReview([main], event, feet.source_video), null);
  assert.equal(findManualAnnotationReview(saved, { ...event, note: "Edited note" }, feet.source_video), null);
  assert.equal(mergeManualAnnotationReview(saved, { ...feet, summary: "Updated" }).length, 2);
});

test("reused evidence includes actual same-camera findings only within the requested times", () => {
  const source_video = { role: "feet", fingerprint: "file" };
  const finding = { anatomical_area: "Left toes", observation: "Extend", evidence_time_s: 72 };
  const review = { source_video, sampled_frames: [{ recordTimeSeconds: 72 }], findings: [finding, { ...finding, evidence_time_s: 200 }] };
  const reused = reusedManualAnnotationEvidence({ _manual_annotation_visual_reviews: [review, { ...review, source_video: { ...source_video, role: "main" } }] }, source_video, [72]);
  assert.deepEqual(reused.findings, [finding]);
  assert.deepEqual(reused.sampled_frames, [{ recordTimeSeconds: 72 }]);
});

test("browser playback filenames do not hide a legacy labeled Main review or substitute Feet", () => {
  const event = { event_id: 'note', note: 'Observation', time_s: 72 };
  const main = { event_id: 'note', manual_note: 'Observation', note_time_s: 72, source_video: { role: 'main', filename: 'Main' }, summary: 'Main-camera report' };
  const feet = { ...main, source_video: { role: 'feet', filename: 'Feet' }, summary: 'Feet-camera report' };
  assert.equal(findManualAnnotationReview([main, feet], event, { role: 'main', filename: 'recording-2026-09-06.mp4' }), main);
  assert.equal(findManualAnnotationReview([main, feet], event, { role: 'feet', filename: 'feet-recording.mp4' }), feet);
});

test("clips early-session windows without losing the note frame", () => {
  assert.deepEqual(manualAnnotationTargetFrameTimes(2), [0, 1, 2, 3, 4, 5, 6, 7]);
});

test("excludes previously reviewed timestamps only for the same camera", () => {
  const analysis = {
    _video_pass_findings: [{
      source_video: { fingerprint: "feet-1", role: "feet" },
      sampled_frames: [{ recordTimeSeconds: 19 }, { recordTimeSeconds: 20.1 }],
    }, {
      source_video: { fingerprint: "main-1", role: "main" },
      sampled_frames: [{ recordTimeSeconds: 21 }],
    }],
  };
  const reviewed = reviewedFrameTimesForVideo(analysis, { fingerprint: "feet-1", role: "feet" });
  assert.deepEqual(reviewed, [19, 20.1]);
  assert.deepEqual(uncoveredFrameTimes([18, 19, 20, 21], reviewed), [18, 21]);
});
