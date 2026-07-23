import test from "node:test";
import assert from "node:assert/strict";
import {
  getVideoSyncCorrection,
  mediaTimeToSessionTime,
  sessionTimeToMediaTime,
} from "./videoSyncClock.js";

test("maps feeds with different file starts onto the same session time", () => {
  const sessionTime = mediaTimeToSessionTime(240, 15);
  assert.equal(sessionTime, 255);
  assert.equal(sessionTimeToMediaTime(sessionTime, 35), 220);
});

test("clamps a feed before its session start to its first frame", () => {
  assert.equal(sessionTimeToMediaTime(10, 25, 100), 0);
});

test("hard-seeks material drift and gently corrects smaller drift", () => {
  assert.equal(getVideoSyncCorrection(10, 10.5, 1).seek, true);

  const soft = getVideoSyncCorrection(10, 10.2, 1.5);
  assert.equal(soft.seek, false);
  assert.ok(soft.playbackRate > 1.5);
  assert.ok(soft.playbackRate <= 1.62);

  const aligned = getVideoSyncCorrection(10, 10.02, 1);
  assert.equal(aligned.seek, false);
  assert.equal(aligned.playbackRate, 1);
});
