import test from "node:test";
import assert from "node:assert/strict";
import {
  LONG_RUNNING_NOTIFICATION_THRESHOLD_MS,
  shouldNotifyForJobDuration,
  shouldTrackNativeBackgroundJob,
} from "./backgroundJobNotificationPolicy.js";

const NOW = Date.parse("2026-06-28T18:30:00.000Z");

function job(overrides = {}) {
  return {
    id: "job-1",
    type: "ai_invoke",
    status: "complete",
    createdAt: new Date(NOW - 30_000).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
    meta: {},
    ...overrides,
  };
}

test("short analysis jobs do not produce completion notifications", () => {
  assert.equal(shouldNotifyForJobDuration(job(), { now: NOW }), false);
});

test("an analysis qualifies after the long-running threshold", () => {
  const duration = LONG_RUNNING_NOTIFICATION_THRESHOLD_MS + 1_000;
  assert.equal(shouldNotifyForJobDuration(job({
    createdAt: new Date(NOW - duration).toISOString(),
  }), { now: NOW }), true);
});

test("known heavy jobs are tracked immediately by Android", () => {
  assert.equal(shouldTrackNativeBackgroundJob(job({
    type: "profile_anatomy_video",
    status: "queued",
    createdAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
  }), {}, { now: NOW }), true);
});

test("short generic jobs are not tracked by Android", () => {
  assert.equal(shouldTrackNativeBackgroundJob(job({
    status: "running",
    createdAt: new Date(NOW - 30_000).toISOString(),
  }), {}, { now: NOW }), false);
});

test("quiet or foreground jobs never notify", () => {
  assert.equal(shouldNotifyForJobDuration(job({
    type: "profile_anatomy_video",
    meta: { quietInTray: true },
  }), { now: NOW }), false);
  assert.equal(shouldNotifyForJobDuration(job({
    type: "profile_anatomy_video",
    meta: { foreground: true },
  }), { now: NOW }), false);
});
