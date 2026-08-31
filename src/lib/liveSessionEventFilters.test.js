import test from "node:test";
import assert from "node:assert/strict";
import { shouldKeepLiveSessionEvent } from "./liveSessionEventFilters.js";

test("blocks only Sarah's noisy edging candidate cue", () => {
  assert.equal(shouldKeepLiveSessionEvent({ source: "sarah_live_cue", note: "edging pattern candidate" }), false);
  assert.equal(shouldKeepLiveSessionEvent({ source: "sarah_live_cue", label: " Edging Pattern Candidate " }), false);
  assert.equal(shouldKeepLiveSessionEvent({ source: "sarah_live_cue", note: "Sarah live cue: recovery" }), true);
  assert.equal(shouldKeepLiveSessionEvent({ source: "manual", note: "edging pattern candidate" }), true);
});
