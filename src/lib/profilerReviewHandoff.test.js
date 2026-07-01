import test from "node:test";
import assert from "node:assert/strict";

import { profilerReviewHandoffState } from "./profilerReviewHandoff.js";

test("local preparation is never presented as safe to background", () => {
  const state = profilerReviewHandoffState({
    loading: false,
    jobStatus: { status: "starting", progress: { phase: "preparing" } },
  });

  assert.equal(state.preparingLocally, true);
  assert.equal(state.backendConfirmed, false);
  assert.equal(state.safeToBackground, false);
});

test("payload handoff remains foreground-only until the backend returns a job id", () => {
  const state = profilerReviewHandoffState({
    loading: true,
    jobStatus: { status: "starting", progress: { phase: "handing_off" } },
  });

  assert.equal(state.uploading, true);
  assert.equal(state.safeToBackground, false);
});

test("a real queued backend job is safe to background", () => {
  const state = profilerReviewHandoffState({
    loading: false,
    jobStatus: { id: "job-123", status: "queued", progress: { phase: "queued" } },
  });

  assert.equal(state.backendConfirmed, true);
  assert.equal(state.backendQueued, true);
  assert.equal(state.backendRunning, false);
  assert.equal(state.preparingLocally, false);
  assert.equal(state.safeToBackground, true);
});

test("a running backend job is identified as running and remains safe to background", () => {
  const state = profilerReviewHandoffState({
    jobStatus: { id: "job-456", status: "running", progress: { phase: "batch_review" } },
  });

  assert.equal(state.backendQueued, false);
  assert.equal(state.backendRunning, true);
  assert.equal(state.safeToBackground, true);
});
