import test from "node:test";
import assert from "node:assert/strict";
import { isVisualEvidenceQuestion, selectSavedVideoPassFramesForChat } from "./visualEvidence.js";

function pass({ id, role, start, summary }) {
  return {
    id,
    source_video_role: role,
    source_video: { filename: `${role}.mkv`, role },
    clip: { start_s: start, end_s: start + 24, url: `/uploads/${id}.mp4` },
    summary,
    sampled_frames: [
      { url: `/uploads/${id}-01.jpg`, frameTimeSeconds: start, recordTimeSeconds: start, frameIndex: 1 },
      { url: `/uploads/${id}-02.jpg`, frameTimeSeconds: start + 12, recordTimeSeconds: start + 12, frameIndex: 2 },
    ],
  };
}

test("recognizes a conversational request to use saved visual evidence", () => {
  assert.equal(isVisualEvidenceQuestion("What did you notice visually about the changes during this procedure?"), true);
  assert.equal(isVisualEvidenceQuestion("How did the pressure feel afterward?"), false);
});

test("genital visual questions select relevant main-camera frames instead of feet-camera frames", () => {
  const frames = selectSavedVideoPassFramesForChat([
    pass({ id: "feet", role: "feet", start: 0, summary: "Both soles remain relaxed with no toe curl." }),
    pass({ id: "main-a", role: "main", start: 30, summary: "The glans becomes more flushed and visibly engorged." }),
    pass({ id: "main-b", role: "main", start: 60, summary: "The shaft softens and the scrotum lowers after the procedure." }),
  ], "What visible changes happened to my genitals?", { limit: 5 });

  assert.deepEqual(frames.map((frame) => frame.sourceVideo.filename), ["main.mkv", "main.mkv"]);
  assert.deepEqual(frames.map((frame) => frame.frameTimelineSeconds), [30, 60]);
});
