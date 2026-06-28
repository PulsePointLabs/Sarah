import test from "node:test";
import assert from "node:assert/strict";
import { createReportChatTtsPlayback } from "./reportChatTtsPlayback.js";

const runtime = {
  cacheProfile: "chat-parity-test",
  model: "gpt-4o-mini-tts",
  format: "mp3",
  speed: 1,
  supportsInstructions: true,
  instructions: "Speak naturally.",
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeAudioHarness() {
  const audios = [];
  const createAudio = (src) => {
    const audio = {
      src,
      paused: true,
      currentTime: 0,
      duration: 1,
      preload: "",
      playCalls: 0,
      pauseCalls: 0,
      play() {
        this.playCalls += 1;
        this.paused = false;
        return Promise.resolve();
      },
      pause() {
        this.pauseCalls += 1;
        this.paused = true;
      },
      end() {
        this.paused = true;
        this.onended?.();
      },
      fail() {
        this.onerror?.();
      },
      addEventListener() {},
    };
    audios.push(audio);
    return audio;
  };
  return { audios, createAudio };
}

function makeEngine(options = {}) {
  const audio = makeAudioHarness();
  let objectUrl = 0;
  const engine = createReportChatTtsPlayback({
    getMimeType: () => "audio/mpeg",
    prepareText: (text) => text,
    decodeBase64: (value) => value,
    createObjectUrl: () => `blob:test-${++objectUrl}`,
    revokeObjectUrl: () => {},
    createAudio: audio.createAudio,
    cache: options.cache || { get: async () => null, put: async () => {} },
    ...options,
  });
  return { engine, audios: audio.audios };
}

test("starts the first chunk before requesting exactly one lookahead chunk", async () => {
  const requests = [];
  const first = deferred();
  const second = deferred();
  const third = deferred();
  const pending = [first, second, third];
  const starts = [];
  const { engine, audios } = makeEngine({
    invokeTts: (payload) => {
      requests.push(payload.text);
      return pending[requests.length - 1].promise;
    },
    onPlaybackStart: ({ index }) => starts.push(index),
  });

  const run = engine.start([{ text: "one" }, { text: "two" }, { text: "three" }], runtime);
  await flush();
  assert.deepEqual(requests, ["one"], "later chunks must not delay first audio");

  first.resolve({ data: { audio: "first", format: "mp3" } });
  await flush();
  await flush();
  assert.deepEqual(starts, [0]);
  assert.deepEqual(requests, ["one", "two"], "only one lookahead starts after playback begins");

  audios[0].end();
  await flush();
  assert.deepEqual(requests, ["one", "two"], "a third request cannot start before chunk two plays");

  second.resolve({ data: { audio: "second", format: "mp3" } });
  await flush();
  await flush();
  assert.deepEqual(starts, [0, 1]);
  assert.deepEqual(requests, ["one", "two", "three"]);

  audios[1].end();
  third.resolve({ data: { audio: "third", format: "mp3" } });
  await flush();
  await flush();
  audios[2].end();
  await run;
  engine.dispose();
});

test("uses Chat IndexedDB-compatible cached audio without a network request", async () => {
  let networkCalls = 0;
  const cache = {
    get: async () => ({ audio: "cached", text: "cached words", format: "mp3", mimeType: "audio/mpeg" }),
    put: async () => {},
  };
  const { engine, audios } = makeEngine({
    cache,
    invokeTts: async () => {
      networkCalls += 1;
      return { data: { audio: "network" } };
    },
  });

  const run = engine.start([{ text: "cached words" }], runtime);
  await flush();
  await flush();
  assert.equal(networkCalls, 0);
  assert.equal(audios.length, 1);
  audios[0].end();
  await run;
  engine.dispose();
});

test("Stop aborts pending lookahead and stale results cannot restart playback", async () => {
  const requests = [];
  const first = deferred();
  const second = deferred();
  const { engine, audios } = makeEngine({
    invokeTts: (payload, { signal }) => {
      const item = requests.length === 0 ? first : second;
      requests.push({ text: payload.text, signal });
      signal.addEventListener("abort", () => item.reject(new DOMException("cancelled", "AbortError")), { once: true });
      return item.promise;
    },
  });

  const run = engine.start([{ text: "one" }, { text: "two" }], runtime);
  first.resolve({ data: { audio: "first", format: "mp3" } });
  await flush();
  await flush();
  assert.equal(audios.length, 1);
  assert.equal(requests.length, 2);

  engine.stop();
  await run;
  assert.equal(requests[1].signal.aborted, true);
  assert.equal(audios[0].pauseCalls > 0, true);
  assert.equal(audios.length, 1, "a stale lookahead response must not create new audio");
  engine.dispose();
});

test("Pause and Resume operate on the active Chat-style Audio object", async () => {
  const { engine, audios } = makeEngine({
    invokeTts: async () => ({ data: { audio: "first", format: "mp3" } }),
  });
  const run = engine.start([{ text: "one" }], runtime);
  await flush();
  await flush();
  assert.equal(engine.pause(), true);
  assert.equal(audios[0].paused, true);
  assert.equal(await engine.resume(), true);
  assert.equal(audios[0].playCalls, 2);
  audios[0].end();
  await run;
  engine.dispose();
});

test("playback callbacks receive progress ownership without controlling the engine", async () => {
  const events = [];
  const { engine, audios } = makeEngine({
    invokeTts: async () => ({ data: { audio: "first", format: "mp3" } }),
    onInitialBuffering: ({ index }) => events.push(["buffering", index]),
    onChunkReady: ({ index }) => events.push(["ready", index]),
    onPlaybackStart: ({ index, audio }) => events.push(["playing", index, audio.currentTime]),
    onPlaybackEnd: ({ index }) => events.push(["ended", index]),
    onComplete: () => events.push(["complete"]),
  });
  const run = engine.start([{ text: "one" }], runtime);
  await flush();
  await flush();
  audios[0].end();
  await run;
  assert.deepEqual(events.map((event) => event[0]), ["buffering", "ready", "playing", "ended", "complete"]);
  engine.dispose();
});
