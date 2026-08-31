import test from "node:test";
import assert from "node:assert/strict";
import {
  manualAnnotationTargetFrameTimes,
  reviewedFrameTimesForVideo,
  uncoveredFrameTimes,
} from "./manualAnnotationFrameCoverage.js";

test("builds a centered eleven-frame review window", () => {
  assert.deepEqual(manualAnnotationTargetFrameTimes(20), [15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25]);
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

