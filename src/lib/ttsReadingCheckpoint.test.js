import assert from "node:assert/strict";
import test from "node:test";
import {
  buildTtsCheckpoint,
  hashTtsContent,
  isCheckpointCompatible,
  loadTtsCheckpoint,
  saveTtsCheckpoint,
  ttsCheckpointKey,
} from "./ttsReadingCheckpoint.js";

function createMemoryStorage() {
  const data = new Map();
  return {
    getItem: (key) => data.get(key) ?? null,
    setItem: (key, value) => data.set(key, String(value)),
  };
}

test("TTS checkpoint stores position metadata without report text", () => {
  const contentHash = hashTtsContent(["First paragraph", "Second paragraph"]);
  const checkpoint = buildTtsCheckpoint({
    route: "/profiler",
    sessionId: "abc",
    title: "Private long report",
    contentHash,
    currentPara: 3,
    currentSentenceIdx: 2,
    currentWordIdx: 17,
    playbackTime: 12.5,
    state: "playing",
    scrollY: 420,
  });

  assert.equal(checkpoint.contentHash, contentHash);
  assert.equal(checkpoint.currentPara, 3);
  assert.equal(checkpoint.currentSentenceIdx, 2);
  assert.equal(JSON.stringify(checkpoint).includes("First paragraph"), false);
});

test("TTS checkpoint compatibility requires matching content hash", () => {
  const checkpoint = buildTtsCheckpoint({
    contentHash: hashTtsContent(["old"]),
    currentPara: 1,
  });

  assert.equal(isCheckpointCompatible(checkpoint, { contentHash: hashTtsContent(["old"]) }), true);
  assert.equal(isCheckpointCompatible(checkpoint, { contentHash: hashTtsContent(["new"]) }), false);
});

test("TTS checkpoint save and load are deterministic", () => {
  const storage = createMemoryStorage();
  const key = ttsCheckpointKey("session-1", "Report");
  const checkpoint = buildTtsCheckpoint({
    contentHash: hashTtsContent(["stable"]),
    currentPara: 4,
  });

  assert.equal(saveTtsCheckpoint(key, checkpoint, storage), true);
  assert.deepEqual(loadTtsCheckpoint(key, storage), checkpoint);
});
