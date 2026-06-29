import test from "node:test";
import assert from "node:assert/strict";
import { isTransientBackgroundJobPollError } from "./backgroundJobPolling.js";

test("recognizes the mobile background-job polling timeout as transient", () => {
  assert.equal(isTransientBackgroundJobPollError(new Error("Local background job API did not respond within 15s")), true);
});

test("retries server and rate-limit polling failures", () => {
  assert.equal(isTransientBackgroundJobPollError({ status: 503, message: "Unavailable" }), true);
  assert.equal(isTransientBackgroundJobPollError({ status: 429, message: "Busy" }), true);
});

test("does not retry terminal client errors", () => {
  assert.equal(isTransientBackgroundJobPollError({ status: 404, message: "Job not found" }), false);
});
