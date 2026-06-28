const TTS_CACHE_DB_NAME = "pulsepoint-ai-chat-tts";
const TTS_CACHE_DB_VERSION = 1;
const TTS_CACHE_STORE_NAME = "audioChunks";

export function hashReportTtsText(value) {
  let hash = 2166136261;
  const text = String(value || "");
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

function openTtsCacheDb() {
  if (typeof window === "undefined" || !("indexedDB" in window)) return Promise.resolve(null);
  return new Promise((resolve) => {
    const request = window.indexedDB.open(TTS_CACHE_DB_NAME, TTS_CACHE_DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(TTS_CACHE_STORE_NAME)) {
        db.createObjectStore(TTS_CACHE_STORE_NAME, { keyPath: "key" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => resolve(null);
    request.onblocked = () => resolve(null);
  });
}

export async function getStoredReportTtsAudio(key) {
  const db = await openTtsCacheDb();
  if (!db) return null;
  return new Promise((resolve) => {
    const transaction = db.transaction(TTS_CACHE_STORE_NAME, "readonly");
    const request = transaction.objectStore(TTS_CACHE_STORE_NAME).get(key);
    request.onsuccess = () => resolve(request.result || null);
    request.onerror = () => resolve(null);
    transaction.oncomplete = () => db.close();
    transaction.onerror = () => db.close();
  });
}

export async function putStoredReportTtsAudio(record) {
  const db = await openTtsCacheDb();
  if (!db) return;
  await new Promise((resolve) => {
    const transaction = db.transaction(TTS_CACHE_STORE_NAME, "readwrite");
    transaction.objectStore(TTS_CACHE_STORE_NAME).put(record);
    transaction.oncomplete = resolve;
    transaction.onerror = resolve;
    transaction.onabort = resolve;
  });
  db.close();
}

function audioBase64ToObjectUrl(audio, mimeType, { decodeBase64, createObjectUrl }) {
  const binary = decodeBase64(audio);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return createObjectUrl(bytes.buffer, mimeType);
}

export function buildReportChatCacheKey(chunk, runtime) {
  const runtimeSignature = [
    runtime.cacheProfile,
    runtime.model,
    runtime.format,
    runtime.speed,
    hashReportTtsText(runtime.supportsInstructions ? runtime.instructions : ""),
  ].join(":");
  return `${runtimeSignature}:${chunk.length}:${hashReportTtsText(chunk)}`;
}

function abortError() {
  return new DOMException("TTS request cancelled", "AbortError");
}

function isAbortError(error) {
  return error?.name === "AbortError" || /cancelled|aborted/i.test(String(error?.message || ""));
}

export function createReportChatTtsPlayback({
  invokeTts,
  prepareText = (value) => value,
  getMimeType,
  playbackFormat = "mp3",
  cache = {
    get: getStoredReportTtsAudio,
    put: putStoredReportTtsAudio,
  },
  decodeBase64 = (value) => globalThis.atob(value),
  createObjectUrl = (buffer, mimeType) => URL.createObjectURL(new Blob([buffer], { type: mimeType })),
  revokeObjectUrl = (url) => URL.revokeObjectURL(url),
  createAudio = (src) => new Audio(src),
  onInitialBuffering = () => {},
  onChunkReady = () => {},
  onPlaybackStart = () => {},
  onPlaybackEnd = () => {},
  onComplete = () => {},
  onError = () => {},
} = {}) {
  if (typeof invokeTts !== "function") throw new Error("Report TTS requires an invokeTts function");

  const audioUrlCache = new Map();
  let runId = 0;
  let currentAudio = null;
  let currentChunk = null;
  let currentFetchController = null;
  let lookahead = null;
  let finishCurrentPlayback = null;
  let paused = false;

  const currentRun = (id) => id === runId;

  const cancelFetches = () => {
    currentFetchController?.abort();
    currentFetchController = null;
    lookahead?.controller?.abort();
    lookahead = null;
  };

  const haltAudio = () => {
    if (!currentAudio) return;
    try {
      currentAudio.onended = null;
      currentAudio.onerror = null;
      currentAudio.pause();
    } catch {
      // Stopping playback is best-effort.
    }
    currentAudio = null;
    currentChunk = null;
    finishCurrentPlayback?.();
    finishCurrentPlayback = null;
  };

  const fetchChunkAudio = async (chunk, runtime, id, controller) => {
    if (!currentRun(id) || controller.signal.aborted) throw abortError();
    const text = String(chunk?.text || chunk || "").trim();
    const cacheKey = buildReportChatCacheKey(text, runtime);
    const memoryUrl = audioUrlCache.get(cacheKey);
    if (memoryUrl) return { src: memoryUrl, fromCache: true, cacheKey };

    const stored = await cache.get(cacheKey);
    if (!currentRun(id) || controller.signal.aborted) throw abortError();
    if (stored?.audio && stored?.text === text) {
      const src = audioBase64ToObjectUrl(
        stored.audio,
        stored.mimeType || getMimeType(stored.format || runtime.format || playbackFormat),
        { decodeBase64, createObjectUrl }
      );
      audioUrlCache.set(cacheKey, src);
      return { src, fromCache: true, cacheKey };
    }

    const response = await invokeTts({
      text: prepareText(text),
      voice: "nova",
      model: runtime.model,
      speed: runtime.speed,
      instructions: runtime.supportsInstructions ? runtime.instructions : "",
      format: runtime.format,
    }, { signal: controller.signal });
    if (!currentRun(id) || controller.signal.aborted) throw abortError();

    const audio = response?.data?.audio;
    if (!audio) throw new Error(response?.data?.error || "TTS returned no audio");
    const format = response?.data?.format || runtime.format || playbackFormat;
    const mimeType = getMimeType(format);
    const src = audioBase64ToObjectUrl(audio, mimeType, { decodeBase64, createObjectUrl });
    audioUrlCache.set(cacheKey, src);
    cache.put({
      key: cacheKey,
      text,
      audio,
      format,
      mimeType,
      voice: "nova",
      model: runtime.model,
      speed: runtime.speed,
      createdAt: Date.now(),
    }).catch(() => {});
    return { src, fromCache: false, cacheKey };
  };

  const prepareLookahead = (chunks, nextIndex, runtime, id) => {
    if (!currentRun(id) || nextIndex >= chunks.length || lookahead) return;
    const controller = new AbortController();
    const promise = fetchChunkAudio(chunks[nextIndex], runtime, id, controller);
    promise.catch(() => {});
    lookahead = { index: nextIndex, controller, promise };
  };

  const takePreparedChunk = async (chunks, index, runtime, id) => {
    if (lookahead?.index === index) {
      const prepared = lookahead;
      lookahead = null;
      currentFetchController = prepared.controller;
      try {
        return await prepared.promise;
      } finally {
        currentFetchController = null;
      }
    }
    currentFetchController = new AbortController();
    try {
      return await fetchChunkAudio(chunks[index], runtime, id, currentFetchController);
    } finally {
      currentFetchController = null;
    }
  };

  const playAudio = (src, chunk, index, total, fromCache, id) => {
    let resolveStarted;
    let rejectStarted;
    const started = new Promise((resolve, reject) => {
      resolveStarted = resolve;
      rejectStarted = reject;
    });
    const ended = new Promise((resolve, reject) => {
    finishCurrentPlayback = resolve;
    if (!currentRun(id)) {
      resolveStarted();
      resolve();
      return;
    }
    haltAudio();
    const audio = createAudio(src);
    currentAudio = audio;
    currentChunk = chunk;
    audio.preload = "auto";
    audio.onended = () => {
      if (currentAudio === audio) currentAudio = null;
      finishCurrentPlayback = null;
      onPlaybackEnd({ chunk, index, total, audio });
      resolve();
    };
    audio.onerror = () => {
      if (currentAudio === audio) currentAudio = null;
      finishCurrentPlayback = null;
      reject(new Error("Audio playback failed"));
    };
    Promise.resolve(audio.play()).then(() => {
      if (!currentRun(id)) {
        audio.pause();
        resolveStarted();
        resolve();
        return;
      }
      paused = false;
      onPlaybackStart({ chunk, index, total, audio, fromCache });
      resolveStarted();
    }).catch((error) => {
      rejectStarted(error);
      reject(error);
    });
    });
    return { started, ended };
  };

  const start = async (chunks, runtime) => {
    const id = runId + 1;
    runId = id;
    cancelFetches();
    haltAudio();
    paused = false;
    if (!Array.isArray(chunks) || chunks.length === 0) throw new Error("Nothing to read");
    onInitialBuffering({ chunk: chunks[0], index: 0, total: chunks.length });

    try {
      for (let index = 0; index < chunks.length; index += 1) {
        if (!currentRun(id)) return;
        const prepared = await takePreparedChunk(chunks, index, runtime, id);
        if (!currentRun(id)) return;
        onChunkReady({ chunk: chunks[index], index, total: chunks.length, fromCache: prepared.fromCache });

        const playback = playAudio(prepared.src, chunks[index], index, chunks.length, prepared.fromCache, id);
        await playback.started;
        if (!currentRun(id)) return;

        // Match Chat's one-chunk lookahead, but wait until current playback has started.
        prepareLookahead(chunks, index + 1, runtime, id);

        await playback.ended;
      }
      if (currentRun(id)) onComplete();
    } catch (error) {
      if (!isAbortError(error) && currentRun(id)) onError(error);
    }
  };

  return {
    start,
    pause() {
      if (!currentAudio || currentAudio.paused) return false;
      currentAudio.pause();
      paused = true;
      return true;
    },
    async resume() {
      if (!currentAudio || !paused) return false;
      await currentAudio.play();
      paused = false;
      return true;
    },
    stop() {
      runId += 1;
      cancelFetches();
      haltAudio();
      paused = false;
    },
    dispose() {
      runId += 1;
      cancelFetches();
      haltAudio();
      for (const url of audioUrlCache.values()) {
        try { revokeObjectUrl(url); } catch {}
      }
      audioUrlCache.clear();
    },
    getCurrentAudio: () => currentAudio,
    getCurrentChunk: () => currentChunk,
    getLookaheadIndex: () => lookahead?.index ?? null,
  };
}
