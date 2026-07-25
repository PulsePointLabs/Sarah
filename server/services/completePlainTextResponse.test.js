import test from "node:test";
import assert from "node:assert/strict";
import { completePlainTextResponse } from "./completePlainTextResponse.js";

test("returns a complete initial response without another provider call", async () => {
  let calls = 0;
  const result = await completePlainTextResponse({
    createMessage: async () => {
      calls += 1;
      return {};
    },
    initialMessage: {
      stop_reason: "end_turn",
      content: [{ type: "text", text: "Complete answer." }],
    },
    payload: { messages: [{ role: "user", content: "Prompt" }] },
  });

  assert.equal(result.text, "Complete answer.");
  assert.equal(result.continuationCount, 0);
  assert.equal(calls, 0);
});

test("continues and joins a max-token response as one answer", async () => {
  let continuationPayload;
  const result = await completePlainTextResponse({
    createMessage: async (payload) => {
      continuationPayload = payload;
      return {
        stop_reason: "end_turn",
        content: [{ type: "text", text: "floor engages, and the response reaches a clean ending." }],
      };
    },
    initialMessage: {
      stop_reason: "max_tokens",
      content: [{ type: "text", text: "Second plateau: your pelvic" }],
    },
    payload: {
      model: "claude-sonnet",
      max_tokens: 3200,
      messages: [{ role: "user", content: "Prompt" }],
    },
  });

  assert.equal(
    result.text,
    "Second plateau: your pelvic floor engages, and the response reaches a clean ending.",
  );
  assert.equal(result.continuationCount, 1);
  assert.equal(continuationPayload.messages[1].role, "assistant");
  assert.match(continuationPayload.messages[2].content, /exact point/);
});

test("fails visibly instead of silently returning a still-truncated answer", async () => {
  await assert.rejects(
    completePlainTextResponse({
      createMessage: async () => ({
        stop_reason: "max_tokens",
        content: [{ type: "text", text: "still unfinished" }],
      }),
      initialMessage: {
        stop_reason: "max_tokens",
        content: [{ type: "text", text: "unfinished" }],
      },
      payload: { messages: [{ role: "user", content: "Prompt" }] },
      maxContinuations: 1,
    }),
    /still incomplete/,
  );
});

