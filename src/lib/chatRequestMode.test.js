import test from "node:test";
import assert from "node:assert/strict";
import {
  AI_CHAT_FOREGROUND_TIMEOUT_MS,
  isLongFormChatRequest,
} from "./chatRequestMode.js";

test("detects explicit long-form chat requests", () => {
  assert.equal(isLongFormChatRequest("Please give me a very long, long-form answer."), true);
  assert.equal(isLongFormChatRequest("Walk me through this step-by-step in depth."), true);
  assert.equal(isLongFormChatRequest("Be exhaustive and use as much detail as possible."), true);
});

test("keeps ordinary conversational turns in the foreground", () => {
  assert.equal(isLongFormChatRequest("What do you think about that?"), false);
  assert.equal(isLongFormChatRequest("Give me a concise answer."), false);
});

test("foreground fallback allows longer than the old 90-second deadline", () => {
  assert.equal(AI_CHAT_FOREGROUND_TIMEOUT_MS, 360000);
});

