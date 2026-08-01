import assert from "node:assert/strict";
import test from "node:test";
import {
  buildConversationIntelligencePrompt,
  buildResponsePlan,
  extractExplicitCorrection,
  normalizeEvidenceClass,
  selectRelevantMemories,
  updateConversationTopicState,
} from "./sarahConversationIntelligence.js";

test("newest unrelated subject replaces the current topic and preserves the prior thread", () => {
  const state = updateConversationTopicState(
    { currentTopic: "enema / rectal procedure", previousTopics: [] },
    "Anyway, different subject: why did the APK video player time out?",
    "2026-07-29T12:00:00.000Z",
  );
  assert.equal(state.currentTopic, "app / technical");
  assert.equal(state.topicChanged, true);
  assert.deepEqual(state.previousTopics, ["enema / rectal procedure"]);
});

test("deferred topics can be resumed without guessing from the whole history", () => {
  const parked = updateConversationTopicState(
    { currentTopic: "physiology / telemetry", deferredThreads: [] },
    "Let's park this and come back to it later.",
  );
  const resumed = updateConversationTopicState(parked, "Okay, back to that.");
  assert.equal(resumed.currentTopic, "physiology / telemetry");
  assert.deepEqual(resumed.deferredThreads, []);
});

test("explicit corrections separate rejected and accepted interpretations", () => {
  const correction = extractExplicitCorrection(
    "Sarah thought it was a masturbation sleeve, but it was my bare hand with the catheter in place.",
  );
  assert.match(correction.rejected, /masturbation sleeve/i);
  assert.match(correction.accepted, /bare hand/i);
});

test("corrections outrank stale generic observations", () => {
  const memories = selectRelevantMemories([
    {
      id: "old",
      kind: "fact",
      value: "A translucent sleeve was observed.",
      evidenceClass: "visual",
      confidence: 0.6,
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    {
      id: "correction",
      kind: "correction",
      rejected: "translucent sleeve",
      accepted: "bare-hand stimulation with a Foley in place",
      confidence: 0.98,
      updatedAt: "2026-07-29T00:00:00.000Z",
    },
  ], "Was that a sleeve or bare-hand stimulation?", { nowMs: Date.parse("2026-07-29T12:00:00.000Z") });
  assert.equal(memories[0].id, "correction");
});

test("provenance labels normalize without inventing evidence", () => {
  assert.equal(normalizeEvidenceClass("sensor telemetry"), "measured");
  assert.equal(normalizeEvidenceClass("saved user note"), "user reported");
  assert.equal(normalizeEvidenceClass("video frame"), "visually observed");
  assert.equal(normalizeEvidenceClass("model inference"), "estimated");
  assert.equal(normalizeEvidenceClass(""), "unsupported");
});

test("long evidence requests use deep routing and suppress automatic questions", () => {
  const plan = buildResponsePlan({
    message: "Please give me a very long detailed comparison of the measured HRV around each insertion.",
    topicState: { topicChanged: false },
  });
  assert.equal(plan.routeTier, "deep");
  assert.equal(plan.responseLength, "long");
  assert.equal(plan.maxFollowUpQuestions, 0);
  assert.ok(plan.maxTokens >= 5000);
});

test("direct requests stay focused while casual chat may ask one question", () => {
  assert.equal(buildResponsePlan({ message: "Explain what happened." }).maxFollowUpQuestions, 0);
  assert.equal(buildResponsePlan({ message: "That date went surprisingly well." }).maxFollowUpQuestions, 1);
});

test("prompt makes correction and subject-change priority explicit", () => {
  const prompt = buildConversationIntelligencePrompt({
    topicState: { currentTopic: "relationship / dating", topicChanged: true, previousTopics: ["procedure"] },
    plan: { responseLength: "focused", maxFollowUpQuestions: 0 },
    memories: [{ kind: "correction", rejected: "sleeve", accepted: "bare hand" }],
  });
  assert.match(prompt, /changed subjects/i);
  assert.match(prompt, /avoid "sleeve"/i);
  assert.match(prompt, /follow-up questions allowed: 0/i);
});
