import { useState, useRef, useEffect } from "react";
import { Play, Pause, Square, Download, Settings, RotateCcw, Save } from "lucide-react";
import {
  cleanTextForSpeech,
  DEFAULT_TTS_SETTINGS,
  buildTTSInstructions,
  getTTSRuntime,
  getTTSMime,
  getTTSFileExtension,
  loadTTSSettings,
  normalizeTTSSettings,
  prepareTTSInput,
  saveTTSSettings,
  TTS_AUDIO_FORMATS,
  splitIntoChunks,
  TTS_PRESETS,
  TTS_CHUNK_TARGET_CHARS,
  TTS_ENGINES,
} from "./TTSButton";
import { Slider } from "@/components/ui/slider";
import { fmtSecondsInText } from "@/utils/formatSeconds";
import { base44 } from "@/api/base44Client";
import { idbGet, idbSet } from "@/lib/ttsCache";

const TTS_SAMPLE_TEXT = "Your build phase begins quietly, with stimulation becoming more focused while your body starts to organize around arousal. As climax approaches, the shift is meaningful: sensation, muscle tone, and heart rate begin telling the same story, then recovery arrives as stimulation stops and the body settles.";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const TTS_UNIT_MAX_CHARS = TTS_CHUNK_TARGET_CHARS;
const TTS_PREFETCH_AHEAD = 2;
const ttsCacheKey = (chunk, format, runtime, previousContext = "") =>
  `${runtime.cacheProfile}|${format}|${buildTTSInstructions(runtime.instructions, previousContext).trim()}|${chunk}`;

function splitForTTS(text) {
  return splitIntoChunks(text, TTS_UNIT_MAX_CHARS);
}

function getTrailingSentences(text, count = 2) {
  const sentences = String(text || "")
    .match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g)
    ?.map((s) => s.trim())
    .filter(Boolean) || [];
  return sentences.slice(-count).join(" ");
}

function buildSpeechChunks(paragraphs, startIdx = 0) {
  const chunks = [];
  let currentText = "";
  let currentStart = -1;
  let currentEnd = -1;

  const push = () => {
    if (!currentText.trim()) return;
    chunks.push({
      start: currentStart,
      end: currentEnd,
      text: currentText.trim(),
      previousContext: "",
    });
    currentText = "";
    currentStart = -1;
    currentEnd = -1;
  };

  for (let i = startIdx; i < paragraphs.length; i++) {
    const cleaned = cleanTextForSpeech(paragraphs[i] || "");
    if (!cleaned) continue;

    const parts = splitForTTS(cleaned);
    for (const part of parts) {
      const nextText = currentText ? `${currentText} ${part}` : part;
      if (currentText && nextText.length > TTS_UNIT_MAX_CHARS) {
        push();
      }

      currentText = currentText ? `${currentText} ${part}` : part;
      if (currentStart < 0) currentStart = i;
      currentEnd = i;
    }
  }

  push();

  for (let i = 1; i < chunks.length; i++) {
    chunks[i].previousContext = getTrailingSentences(chunks[i - 1].text, 2);
  }

  return chunks;
}

const getTtsErrorMessage = (err) => {
  const raw =
    err?.data?.message ||
    err?.data?.error ||
    err?.response?.data?.message ||
    err?.response?.data?.error ||
    err?.message ||
    "TTS request failed";

  if (typeof raw !== "string") return JSON.stringify(raw);

  // Base44/OpenAI sometimes returns a JSON string inside the error field.
  try {
    const parsed = JSON.parse(raw);
    return parsed?.error?.message || parsed?.message || raw;
  } catch {
    return raw;
  }
};

const getTtsStatus = (err) => {
  return err?.status || err?.response?.status || err?.data?.status || 500;
};

async function callTTSWithRetries(payload, attempts = 7) {
  let lastError;

  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const response = await base44.functions.invoke("openaiTTS", payload);

      if (response?.data?.error) {
        const error = new Error(getTtsErrorMessage(response));
        error.status = response.status || response?.data?.status || 502;
        error.data = response.data;
        throw error;
      }

      if (!response?.data?.audio) {
        const error = new Error(`TTS returned no audio. Status: ${response?.status || "unknown"}`);
        error.status = response?.status || 502;
        error.data = response?.data;
        throw error;
      }

      return response;
    } catch (err) {
      lastError = err;

      const status = getTtsStatus(err);
      const retryable = [408, 429, 500, 502, 503, 504].includes(status);

      if (!retryable || attempt === attempts - 1) {
        throw err;
      }

      const delay =
        Math.min(1500 * 2 ** attempt, 20000) +
        Math.floor(Math.random() * 1000);

      console.warn(
        `TTS failed (${status}), retry ${attempt + 1}/${attempts} in ${delay}ms:`,
        getTtsErrorMessage(err)
      );

      await sleep(delay);
    }
  }

  throw lastError;
}

const getChunkText = (chunk) => (typeof chunk === "string" ? chunk : chunk?.text || "");
const getChunkContext = (chunk) => (typeof chunk === "string" ? "" : chunk?.previousContext || "");

function readAscii(bytes, offset, length) {
  let out = "";
  for (let i = 0; i < length; i++) out += String.fromCharCode(bytes[offset + i]);
  return out;
}

function writeAscii(bytes, offset, value) {
  for (let i = 0; i < value.length; i++) bytes[offset + i] = value.charCodeAt(i);
}

function writeUint32LE(bytes, offset, value) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >> 8) & 0xff;
  bytes[offset + 2] = (value >> 16) & 0xff;
  bytes[offset + 3] = (value >> 24) & 0xff;
}

function parseWavChunk(chunkBytes) {
  const bytes = chunkBytes instanceof Uint8Array ? chunkBytes : new Uint8Array(chunkBytes);
  if (readAscii(bytes, 0, 4) !== "RIFF" || readAscii(bytes, 8, 4) !== "WAVE") {
    throw new Error("TTS export returned non-WAV audio");
  }

  let fmt = null;
  let data = null;
  let offset = 12;
  while (offset + 8 <= bytes.length) {
    const id = readAscii(bytes, offset, 4);
    const size = new DataView(bytes.buffer, bytes.byteOffset + offset + 4, 4).getUint32(0, true);
    const start = offset + 8;
    const end = Math.min(start + size, bytes.length);
    if (id === "fmt ") fmt = bytes.slice(start, end);
    if (id === "data") data = bytes.slice(start, end);
    offset = end + (size % 2);
  }

  if (!fmt || !data) throw new Error("TTS export WAV is missing audio data");
  const fmtView = new DataView(fmt.buffer, fmt.byteOffset, fmt.byteLength);
  return {
    fmt,
    data,
    byteRate: fmtView.getUint32(8, true),
  };
}

function combineWavChunks(chunks) {
  const parsed = chunks.map(parseWavChunk);
  const firstFmt = parsed[0]?.fmt;
  if (!firstFmt) throw new Error("No WAV audio chunks to export");

  for (const item of parsed) {
    if (item.fmt.length !== firstFmt.length || item.fmt.some((value, idx) => value !== firstFmt[idx])) {
      throw new Error("TTS WAV chunks used different audio formats");
    }
  }

  const dataSize = parsed.reduce((sum, item) => sum + item.data.length, 0);
  const totalSize = 12 + 8 + firstFmt.length + 8 + dataSize;
  const output = new Uint8Array(totalSize);
  writeAscii(output, 0, "RIFF");
  writeUint32LE(output, 4, totalSize - 8);
  writeAscii(output, 8, "WAVE");
  writeAscii(output, 12, "fmt ");
  writeUint32LE(output, 16, firstFmt.length);
  output.set(firstFmt, 20);
  const dataHeaderOffset = 20 + firstFmt.length;
  writeAscii(output, dataHeaderOffset, "data");
  writeUint32LE(output, dataHeaderOffset + 4, dataSize);
  let writeOffset = dataHeaderOffset + 8;
  for (const item of parsed) {
    output.set(item.data, writeOffset);
    writeOffset += item.data.length;
  }

  return {
    bytes: output,
    durationSeconds: parsed[0].byteRate ? dataSize / parsed[0].byteRate : 0,
  };
}

export default function TTSReader({ paragraphs, renderParagraph, sessionId, title, sessionDate }) {
  const [state, setState] = useState("idle"); // idle | buffering | playing | paused
  const [currentPara, setCurrentPara] = useState(-1);
  const [bufferingPara, setBufferingPara] = useState(-1); // which paragraph is currently fetching
  const [ttsSettings, setTtsSettings] = useState(() => loadTTSSettings());
  const [draftSettings, setDraftSettings] = useState(() => loadTTSSettings());
  const [showSettings, setShowSettings] = useState(false);
  const [sampleState, setSampleState] = useState("idle");
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState({ current: 0, total: 0 });
  const [requestStatus, setRequestStatus] = useState(null); // { type: "fetching"|"ok"|"error", msg: string }
  const [currentWordIdx, setCurrentWordIdx] = useState(-1); // index of highlighted word in current para

  const stateRef = useRef("idle");
  const currentParaRef = useRef(-1);
  const userPausedRef = useRef(false); // true only when the user explicitly paused
  const sourceRef = useRef(null);
  const remainingParasRef = useRef([]);
  const chunkQueueRef = useRef([]);
  const currentChunkRef = useRef(null); // the chunk currently playing/buffering
  const voiceRef = useRef("nova");
  const runtimeRef = useRef(getTTSRuntime(ttsSettings));
  const sampleAudioRef = useRef(null);
  // Generation counter: increment on every startFrom to cancel stale async chains
  const genRef = useRef(0);
  // Prefetch cache: chunk text → decoded AudioBuffer (keyed by gen+chunk for staleness)
  const prefetchCacheRef = useRef(new Map()); // key: `${gen}:${chunk}` → Promise<AudioBuffer>
  const playbackTimeRef = useRef(0); // track playback time in seconds
  const wordRefs = useRef(new Map()); // map of word element refs for auto-scroll
  const updateIntervalRef = useRef(null); // track update interval to clear it
  const renderProgressTimerRef = useRef(null);

  useEffect(() => {
    const runtime = getTTSRuntime(ttsSettings);
    runtimeRef.current = runtime;
  }, [ttsSettings]);

  useEffect(() => {
    const sync = (event) => {
      const next = normalizeTTSSettings(event?.detail || loadTTSSettings());
      setTtsSettings(next);
      setDraftSettings(next);
      runtimeRef.current = getTTSRuntime(next);
      prefetchCacheRef.current.clear();
    };
    window.addEventListener("pulsepoint:tts-settings", sync);
    return () => window.removeEventListener("pulsepoint:tts-settings", sync);
  }, []);

  const setS = (s) => { stateRef.current = s; setState(s); };
  const setCP = (i) => {
    currentParaRef.current = i;
    setCurrentPara(i);
    setCurrentWordIdx(-1);
    playbackTimeRef.current = 0;
    if (sessionId && i >= 0) localStorage.setItem(`tts_progress_${sessionId}`, String(i));
  };

  const stopSource = () => {
    if (sourceRef.current) {
      try {
        if (sourceRef.current.audio) {
          sourceRef.current.audio.pause();
          sourceRef.current.audio.src = "";
          if (sourceRef.current.url) URL.revokeObjectURL(sourceRef.current.url);
        } else {
          sourceRef.current.stop();
        }
      } catch {}
      sourceRef.current = null;
    }
  };

  const stopSample = () => {
    if (sampleAudioRef.current) {
      try {
        sampleAudioRef.current.audio.pause();
        sampleAudioRef.current.audio.src = "";
        URL.revokeObjectURL(sampleAudioRef.current.url);
      } catch {}
      sampleAudioRef.current = null;
    }
    setSampleState("idle");
  };

  const playSettingsSample = async () => {
    stopSample();
    setSampleState("loading");
    try {
      const runtime = getTTSRuntime(draftSettings);
      const response = await callTTSWithRetries({
        text: prepareTTSInput(TTS_SAMPLE_TEXT),
        voice: "nova",
        model: runtime.model,
        speed: runtime.speed,
        instructions: runtime.supportsInstructions ? runtime.instructions : "",
        format: runtime.format,
      }, 4);
      const binary = atob(response.data.audio);
      const bytes = new Uint8Array(binary.length);
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes.buffer], { type: getTTSMime(response.data?.format || runtime.format) }));
      const audio = new Audio(url);
      audio.onended = stopSample;
      audio.onerror = stopSample;
      sampleAudioRef.current = { audio, url };
      setSampleState("playing");
      await audio.play();
    } catch (err) {
      console.error("TTS sample failed:", err);
      setSampleState("idle");
      setRequestStatus({ type: "error", msg: getTtsErrorMessage(err) });
    }
  };

  const applyTTSSettings = () => {
    const saved = saveTTSSettings(draftSettings);
    setTtsSettings(saved);
    runtimeRef.current = getTTSRuntime(saved);
    prefetchCacheRef.current.clear();
    setRequestStatus({ type: "ok", msg: "TTS settings saved" });
  };

  const resetTTSSettings = () => {
    const reset = normalizeTTSSettings(DEFAULT_TTS_SETTINGS);
    setDraftSettings(reset);
  };

  const stop = () => {
    genRef.current++; // invalidate any in-flight async chain
    stopSource();
    stopSample();
    remainingParasRef.current = [];
    chunkQueueRef.current = [];
    currentChunkRef.current = null;
    prefetchCacheRef.current.clear();
    if (updateIntervalRef.current) {
      clearInterval(updateIntervalRef.current);
      updateIntervalRef.current = null;
    }
    if (renderProgressTimerRef.current) {
      clearInterval(renderProgressTimerRef.current);
      renderProgressTimerRef.current = null;
    }
    setBufferingPara(-1);
    setRequestStatus(null);
    setS("idle");
    setCP(-1);
  };

  const playNextChunk = async (gen) => {
    if (gen !== genRef.current) return; // stale call — a new startFrom has taken over
    if (stateRef.current !== "playing") return;

    if (chunkQueueRef.current.length > 0) {
      const chunk = chunkQueueRef.current.shift();
      currentChunkRef.current = chunk;
      await fetchAndPlay(chunk, gen);
      return;
    }

    if (remainingParasRef.current.length === 0) {
      setBufferingPara(-1);
      setS("idle");
      setCP(-1);
      return;
    }

    const unit = remainingParasRef.current.shift();
    setCP(unit.start);
    chunkQueueRef.current = [unit];
    currentChunkRef.current = null;
    playNextChunk(gen);
  };

  // Fetch a chunk and cache the original MP3 bytes when available.
  // Each chunk fetch runs independently (not serialized) so prefetched chunks
  // are ready before the current one finishes — eliminating inter-chunk gaps.
  const fetchDecoded = async (chunk, gen) => {
    const chunkText = getChunkText(chunk);
    const previousContext = getChunkContext(chunk);
    const cacheKey = `${gen}:${previousContext}:${chunkText}`;
    if (prefetchCacheRef.current.has(cacheKey)) {
      return prefetchCacheRef.current.get(cacheKey);
    }
    const promise = (async () => {
      try {
        // Check IndexedDB persistent cache first
        const runtime = runtimeRef.current;
        const instructions = buildTTSInstructions(runtime.instructions, previousContext);
        const cacheText = ttsCacheKey(chunkText, runtime.format, runtime, previousContext);
        let mp3Buffer = await idbGet(cacheText, voiceRef.current, runtime.speed);

        if (!mp3Buffer) {
          setRequestStatus({ type: "fetching", msg: "Fetching audio…" });
          const response = await callTTSWithRetries({
            text: prepareTTSInput(chunkText),
            voice: voiceRef.current,
            model: runtime.model,
            speed: runtime.speed,
            instructions: runtime.supportsInstructions ? instructions : "",
            format: runtime.format,
          });
          if (response.data?.error) throw new Error(response.data.error);
          const base64 = response.data.audio;
          const binary = atob(base64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          mp3Buffer = bytes.buffer;
          idbSet(cacheText, voiceRef.current, runtime.speed, mp3Buffer); // fire-and-forget
          setRequestStatus({ type: "ok", msg: "Audio ready" });
        } else {
          setRequestStatus({ type: "ok", msg: "Audio ready (cached)" });
        }

        return mp3Buffer.slice(0);
      } catch (err) {
        prefetchCacheRef.current.delete(cacheKey); // allow retry on failure
        setRequestStatus({ type: "error", msg: getTtsErrorMessage(err) });
        throw err;
      }
    })();
    prefetchCacheRef.current.set(cacheKey, promise);
    return promise;
  };

  // Fire-and-forget: prefetch the next chunk into the cache without blocking playback.
  const prefetchNext = (gen) => {
    // Collect next upcoming chunk
    const upcoming = [];

    // First: remaining chunks already queued
    for (const c of chunkQueueRef.current) {
      upcoming.push(c);
      if (upcoming.length >= TTS_PREFETCH_AHEAD) break;
    }

    // Then: first upcoming speech chunk(s)
    let paraIdx = 0;
    while (upcoming.length < TTS_PREFETCH_AHEAD && paraIdx < remainingParasRef.current.length) {
      const nextUnit = remainingParasRef.current[paraIdx];
      if (nextUnit?.text) upcoming.push(nextUnit);
      paraIdx++;
    }

    for (const chunk of upcoming) {
      const cacheKey = `${gen}:${chunk}`;
      if (!prefetchCacheRef.current.has(cacheKey)) {
        fetchDecoded(chunk, gen).catch(() => {}); // errors cleared inside fetchDecoded
      }
    }
  };

  const fetchAndPlay = async (chunk, gen) => {
    if (gen !== genRef.current) return;
    if (stateRef.current !== "playing") return;

    setBufferingPara(currentParaRef.current);

    let mp3Buffer;
    try {
      mp3Buffer = await fetchDecoded(chunk, gen);
    } catch (err) {
      console.error("TTS fetch failed:", err);
      setRequestStatus({ type: "error", msg: getTtsErrorMessage(err) });
      stop();
      return;
    }

    if (gen !== genRef.current) return;
    if (stateRef.current !== "playing") return;

    setBufferingPara(-1);

    if (gen !== genRef.current) return;

    const url = URL.createObjectURL(new Blob([mp3Buffer], { type: getTTSMime(runtimeRef.current.format) }));
    const audio = new Audio(url);
    audio.preload = "auto";

    audio.onended = () => {
      URL.revokeObjectURL(url);
      sourceRef.current = null;
      // Move to next chunk after this one finishes
      playNextChunk(gen);
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      sourceRef.current = null;
      setRequestStatus({ type: "error", msg: "Audio playback failed" });
      stop();
    };
    sourceRef.current = { audio, url };
    
    // Clear previous interval if it exists
    if (updateIntervalRef.current) clearInterval(updateIntervalRef.current);
    
    // Track playback time during this chunk
    updateIntervalRef.current = setInterval(() => {
      if (gen !== genRef.current || stateRef.current !== "playing") {
        clearInterval(updateIntervalRef.current);
        updateIntervalRef.current = null;
        return;
      }
      playbackTimeRef.current = Math.max(0, audio.currentTime || 0);
      updateWordHighlight();
    }, 50);
    
    await audio.play();

    // Kick off background prefetch of the next chunk as soon as this one starts
    prefetchNext(gen);
  };

  const updateWordHighlight = () => {
    const paraIdx = currentParaRef.current;
    if (paraIdx < 0 || paraIdx >= paragraphs.length) return;
    
    const text = paragraphs[paraIdx];
    const words = text.split(/\s+/).filter(Boolean);
    if (!words.length) return;
    
    // Estimate word index based on playback time (~120 WPM = 2 words/sec)
    const estimatedWordIdx = Math.floor(playbackTimeRef.current * 2);
    const boundedIdx = Math.max(0, Math.min(estimatedWordIdx, words.length - 1));
    
    // Update state with new index
    setCurrentWordIdx(boundedIdx);
    
    // Auto-scroll using requestAnimationFrame for better mobile performance
    requestAnimationFrame(() => {
      const wordKey = `word-${paraIdx}-${boundedIdx}`;
      const wordEl = wordRefs.current.get(wordKey);
      if (wordEl) {
        try {
          wordEl.scrollIntoView({ behavior: "auto", block: "center" });
        } catch {
          // Silently handle scroll errors
        }
      }
    });
  };

  const startFrom = async (paraIdx) => {
    genRef.current++; // cancel any in-flight chain immediately
    const gen = genRef.current;
    userPausedRef.current = false;

    stopSource();
    prefetchCacheRef.current.clear();

    chunkQueueRef.current = [];
    currentChunkRef.current = null;
    remainingParasRef.current = buildSpeechChunks(paragraphs, paraIdx);
    setCP(paraIdx);
    setS("playing");
    setBufferingPara(paraIdx);
    playNextChunk(gen);
  };

  const handlePlayPause = async () => {
    if (state === "playing") {
      userPausedRef.current = true;
      try { sourceRef.current?.audio?.pause(); } catch {}
      setS("paused");
      return;
    }
    if (state === "buffering") {
      // Still fetching — cancel and mark paused; resume will re-fetch the same chunk
      userPausedRef.current = true;
      genRef.current++;
      setBufferingPara(-1);
      setS("paused");
      return;
    }
    if (state === "paused") {
      userPausedRef.current = false;
      if (sourceRef.current?.audio) {
        setS("playing"); // update state immediately
        await sourceRef.current.audio.play().catch(() => {});
      } else {
        // Was paused during buffering — re-fetch the current chunk
        const gen = genRef.current;
        setS("playing");
        if (currentChunkRef.current) {
          await fetchAndPlay(currentChunkRef.current, gen);
        } else {
          playNextChunk(gen);
        }
      }
      return;
    }
    // idle → start
    await startFrom(0);
  };

  const isActive = state === "playing" || state === "paused" || state === "buffering";
  const savedIdx = sessionId ? parseInt(localStorage.getItem(`tts_progress_${sessionId}`) || "-1", 10) : -1;

  // Build an ID3v2.3 tag — UTF-8 encoded text frames (encoding byte 0x03)
  const buildID3Tag = (meta) => {
    const enc = new TextEncoder(); // UTF-8

    const makeTextFrame = (id, text) => {
      const textBytes = enc.encode(text);
      const payload = new Uint8Array(1 + textBytes.length);
      payload[0] = 0x03; // UTF-8
      payload.set(textBytes, 1);
      const frame = new Uint8Array(10 + payload.length);
      for (let i = 0; i < 4; i++) frame[i] = id.charCodeAt(i);
      frame[4] = (payload.length >> 24) & 0xff;
      frame[5] = (payload.length >> 16) & 0xff;
      frame[6] = (payload.length >> 8) & 0xff;
      frame[7] = payload.length & 0xff;
      frame.set(payload, 10);
      return frame;
    };

    const makeCommentFrame = (text) => {
      const textBytes = enc.encode(text);
      const payload = new Uint8Array(1 + 3 + 1 + textBytes.length);
      payload[0] = 0x03; // UTF-8
      payload[1] = 0x65; payload[2] = 0x6e; payload[3] = 0x67; // "eng"
      payload[4] = 0x00; // empty short description
      payload.set(textBytes, 5);
      const frame = new Uint8Array(10 + payload.length);
      frame[0] = 0x43; frame[1] = 0x4f; frame[2] = 0x4d; frame[3] = 0x4d;
      frame[4] = (payload.length >> 24) & 0xff; frame[5] = (payload.length >> 16) & 0xff;
      frame[6] = (payload.length >> 8) & 0xff; frame[7] = payload.length & 0xff;
      frame.set(payload, 10);
      return frame;
    };

    const frames = [
      makeTextFrame("TIT2", meta.title || "Audio Export"),
      makeTextFrame("TPE1", "PhysioLog"),
      makeTextFrame("TALB", "PhysioLog Sessions"),
      makeTextFrame("TYER", meta.year || new Date().getFullYear().toString()),
      makeTextFrame("TCON", "Podcast"),
    ];
    if (meta.comment) frames.push(makeCommentFrame(meta.comment));

    const totalFrameSize = frames.reduce((a, f) => a + f.length, 0);
    const ss = (n) => [(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f];
    const tag = new Uint8Array(10 + totalFrameSize);
    tag[0] = 0x49; tag[1] = 0x44; tag[2] = 0x33; // "ID3"
    tag[3] = 0x03; tag[4] = 0x00; tag[5] = 0x00;
    const syncSize = ss(totalFrameSize);
    tag[6] = syncSize[0]; tag[7] = syncSize[1]; tag[8] = syncSize[2]; tag[9] = syncSize[3];
    let pos = 10;
    for (const f of frames) { tag.set(f, pos); pos += f.length; }
    return tag;
  };

  const downloadAudio = async () => {
    setDownloading(true);
    if (renderProgressTimerRef.current) {
      clearInterval(renderProgressTimerRef.current);
      renderProgressTimerRef.current = null;
    }
    try {
      const allChunks = buildSpeechChunks(paragraphs, 0);
      setDownloadProgress({ current: 0, total: allChunks.length });
      setRequestStatus({ type: "fetching", msg: `Rendering premium audio on server (${allChunks.length} chunks)…` });
      const jobId = crypto.randomUUID();
      renderProgressTimerRef.current = setInterval(async () => {
        try {
          const res = await fetch(`/api/functions/ttsRenderProgress/${encodeURIComponent(jobId)}`);
          if (!res.ok) return;
          const progress = await res.json();
          const current = Number(progress.current || 0);
          const total = Number(progress.total || allChunks.length || 0);
          if (total) setDownloadProgress({ current, total });
          const type = progress.phase === "error" ? "error" : progress.phase === "complete" ? "ok" : "fetching";
          setRequestStatus({
            type,
            msg: progress.message || `Rendering chunk ${current} of ${total || allChunks.length}…`,
          });
        } catch {
          // Progress polling is best-effort; the render request itself remains authoritative.
        }
      }, 1200);

      const dateObj = sessionDate ? new Date(sessionDate) : new Date();
      const monthName = dateObj.toLocaleDateString("en-US", { month: "long" });
      const dayNum = dateObj.getDate();
      const yearNum = dateObj.getFullYear();
      const friendlyDate = `${monthName} ${dayNum} ${yearNum}`;
      // If title already contains the date (e.g. CompareAIPanel passes "Session Comparison – Apr 3 & May 1"),
      // don't prepend the date again. Otherwise prepend it.
      const titleHasDate = title && /\d{4}|\bjan\b|\bfeb\b|\bmar\b|\bapr\b|\bmay\b|\bjun\b|\bjul\b|\baug\b|\bsep\b|\boct\b|\bnov\b|\bdec\b/i.test(title);
      const displayTitle = title
        ? (titleHasDate ? title : `${friendlyDate} – ${title}`)
        : `PhysioLog Analysis – ${friendlyDate}`;
      const exportFormat = runtimeRef.current.format;
      const runtime = runtimeRef.current;
      const renderRes = await base44.functions.invoke("renderTTSExport", {
        jobId,
        title: displayTitle,
        chunks: allChunks.map((chunk) => ({
          text: prepareTTSInput(getChunkText(chunk)),
          previousContext: getChunkContext(chunk),
        })),
        voice: voiceRef.current,
        model: runtime.model,
        speed: runtime.speed,
        instructions: runtime.instructions,
        outputFormat: exportFormat,
        normalize: runtime.settings.normalizeExport,
      });

      if (renderRes?.data?.error) throw new Error(renderRes.data.error);
      const rendered = renderRes?.data || renderRes;
      if (!rendered?.file_url) throw new Error("Server render did not return an audio file");
      if (renderProgressTimerRef.current) {
        clearInterval(renderProgressTimerRef.current);
        renderProgressTimerRef.current = null;
      }

      // Trigger download
      const a = document.createElement("a");
      a.href = rendered.file_url;
      a.download = rendered.filename || `${displayTitle.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase()}.${getTTSFileExtension(exportFormat)}`;
      a.click();

      await base44.entities.AudioExport.create({
        title: displayTitle,  // e.g. "April 23 Cascade Overview"
        file_url: rendered.file_url,
        duration_seconds: Math.round(rendered.duration_seconds || 0),
        voice: voiceRef.current,
        speed: runtimeRef.current.speed,
        model: runtime.model,
        format: rendered.format || exportFormat,
        size: rendered.size,
      });

      setRequestStatus({ type: "ok", msg: `Premium ${String(rendered.format || exportFormat).toUpperCase()} render complete` });
      setDownloadProgress({ current: 0, total: 0 });
      setDownloading(false);
    } catch (err) {
      if (renderProgressTimerRef.current) {
        clearInterval(renderProgressTimerRef.current);
        renderProgressTimerRef.current = null;
      }
      console.error("Download failed:", err);
      setRequestStatus({ type: "error", msg: getTtsErrorMessage(err) || "Download failed" });
      setDownloadProgress({ current: 0, total: 0 });
      setDownloading(false);
    }
  };

  return (
    <>
    <div className="space-y-1">
      {/* Controls */}
      <div className="flex items-center gap-1 mb-2 flex-wrap">
        <button
          onClick={handlePlayPause}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-primary/10 text-primary hover:bg-primary/20 active:opacity-70 transition-colors text-xs font-medium select-none"
          style={{ WebkitTapHighlightColor: "transparent", touchAction: "manipulation" }}
        >
          {state === "playing"
            ? <><Pause className="w-3.5 h-3.5" />Pause</>
            : state === "buffering"
              ? <><Pause className="w-3.5 h-3.5" />Pause</>
              : <><Play className="w-3.5 h-3.5" />{state === "idle" ? "Read" : "Resume"}</>}
        </button>

        {isActive && (
          <button
            onClick={stop}
            className="p-1.5 rounded-lg bg-muted text-muted-foreground hover:text-foreground active:opacity-70 transition-colors select-none"
            style={{ WebkitTapHighlightColor: "transparent", touchAction: "manipulation" }}
          >
            <Square className="w-3.5 h-3.5" />
          </button>
        )}

        {isActive && (
          <span className="text-[10px] text-muted-foreground ml-1">Tap paragraph to jump</span>
        )}

        <button
          onClick={downloadAudio}
          disabled={downloading}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-muted text-muted-foreground hover:text-foreground disabled:opacity-50 active:opacity-70 transition-colors text-xs font-medium select-none ml-auto"
          style={{ WebkitTapHighlightColor: "transparent", touchAction: "manipulation" }}
          title="Download full section audio"
        >
          {downloading ? (
            <>
              <span className="w-3 h-3 border-2 border-muted-foreground border-t-transparent rounded-full animate-spin" />
              Downloading…
            </>
          ) : (
            <>
              <Download className="w-3.5 h-3.5" /> Download
            </>
          )}
        </button>

        <button
          onClick={() => setShowSettings((v) => !v)}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-muted text-muted-foreground hover:text-foreground active:opacity-70 transition-colors text-xs font-medium select-none"
          style={{ WebkitTapHighlightColor: "transparent", touchAction: "manipulation" }}
          title="TTS settings"
        >
          <Settings className="w-3.5 h-3.5" /> TTS
        </button>
      </div>

      {showSettings && (
        <div className="rounded-xl border border-border bg-muted/25 p-3 mb-2 space-y-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-primary">TTS Settings</p>
              <p className="text-[10px] text-muted-foreground">Nova voice. Saved settings apply everywhere in PulsePoint.</p>
            </div>
            <div className="flex items-center gap-1.5">
              <span className="text-[10px] rounded-full bg-primary/10 px-2 py-1 text-primary font-medium">Nova</span>
              <span className="text-[10px] rounded-full bg-muted px-2 py-1 text-muted-foreground font-medium">
                {TTS_ENGINES[draftSettings.engine]?.label}
              </span>
              <span className="text-[10px] rounded-full bg-muted px-2 py-1 text-muted-foreground font-medium">
                {TTS_AUDIO_FORMATS[draftSettings.audioFormat]?.label}
              </span>
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-2">
            <div>
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Audio Engine</p>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(TTS_ENGINES).map(([key, engine]) => (
                  <button
                    key={key}
                    onClick={() => setDraftSettings((prev) => normalizeTTSSettings({ ...prev, engine: key }))}
                    className={`px-2 py-1 rounded-lg text-[10px] font-medium ${
                      draftSettings.engine === key
                        ? "bg-primary/10 text-primary"
                        : "bg-muted text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {engine.label}
                  </button>
                ))}
              </div>
              {draftSettings.engine === "hd" && (
                <p className="mt-1 text-[10px] text-muted-foreground">
                  HD Crisp prioritizes fidelity; tone sliders have less influence with this engine.
                </p>
              )}
            </div>
            <div>
              <p className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Audio Format</p>
              <div className="flex flex-wrap gap-1.5">
                {Object.entries(TTS_AUDIO_FORMATS).map(([key, format]) => (
                  <button
                    key={key}
                    onClick={() => setDraftSettings((prev) => normalizeTTSSettings({ ...prev, audioFormat: key }))}
                    className={`px-2 py-1 rounded-lg text-[10px] font-medium ${
                      draftSettings.audioFormat === key
                        ? "bg-primary/10 text-primary"
                        : "bg-muted text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    {format.label}
                  </button>
                ))}
              </div>
            </div>
          </div>

          <button
            onClick={() => setDraftSettings((prev) => normalizeTTSSettings({ ...prev, normalizeExport: !prev.normalizeExport }))}
            className={`w-full rounded-lg px-2.5 py-2 text-left text-[11px] font-medium transition-colors ${
              draftSettings.normalizeExport
                ? "bg-primary/10 text-primary"
                : "bg-muted text-muted-foreground hover:text-foreground"
            }`}
          >
            Gentle final loudness normalization: {draftSettings.normalizeExport ? "On" : "Off"}
            <span className="block text-[10px] font-normal opacity-75">
              Applies once during premium server download rendering only. Leave off for the most transparent fidelity.
            </span>
          </button>

          <div className="flex flex-wrap gap-1.5">
            {Object.entries(TTS_PRESETS).map(([name, preset]) => (
              <button
                key={name}
                onClick={() => setDraftSettings(normalizeTTSSettings(preset))}
                className="px-2 py-1 rounded-lg bg-muted text-[10px] font-medium text-muted-foreground hover:text-foreground hover:bg-muted/80"
              >
                {name}
              </button>
            ))}
          </div>

          {[
            ["speed", "Speed", 0.94, 1.04, 0.01],
            ["warmth", "Warmth", 0, 10, 1],
            ["enthusiasm", "Enthusiasm", 0, 10, 1],
            ["soothing", "Soothing", 0, 10, 1],
            ["lightness", "Lightness", 0, 10, 1],
            ["femininity", "Femininity", 0, 10, 1],
            ["continuity", "Section Flow", 0, 10, 1],
            ["naturalness", "Naturalness", 0, 10, 1],
            ["pauses", "Pauses", 0, 10, 1],
            ["softStart", "Soft Start", 0, 10, 1],
          ].map(([key, label, min, max, step]) => (
            <label key={key} className="grid grid-cols-[86px_1fr_42px] items-center gap-3 text-[11px]">
              <span className="font-medium text-muted-foreground">{label}</span>
              <Slider
                value={[draftSettings[key]]}
                min={min}
                max={max}
                step={step}
                onValueChange={([value]) => setDraftSettings((prev) => normalizeTTSSettings({ ...prev, [key]: value }))}
              />
              <span className="font-mono text-right text-muted-foreground">{draftSettings[key]}</span>
            </label>
          ))}

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={sampleState === "playing" ? stopSample : playSettingsSample}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-primary/10 text-primary hover:bg-primary/20 text-xs font-medium"
            >
              {sampleState === "loading"
                ? <><span className="w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />Preparing…</>
                : sampleState === "playing"
                  ? <><Square className="w-3.5 h-3.5" />Stop Sample</>
                  : <><Play className="w-3.5 h-3.5" />Play Sample</>}
            </button>
            <button
              onClick={applyTTSSettings}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 text-xs font-medium"
            >
              <Save className="w-3.5 h-3.5" />Save
            </button>
            <button
              onClick={resetTTSSettings}
              className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-muted text-muted-foreground hover:text-foreground text-xs font-medium"
            >
              <RotateCcw className="w-3.5 h-3.5" />Reset
            </button>
          </div>
        </div>
      )}

      {/* API Request Status */}
      {requestStatus && (
        <div className={`flex items-center gap-1.5 text-[10px] px-2 py-1 rounded-md mb-1 ${
          requestStatus.type === "fetching" ? "bg-primary/10 text-primary" :
          requestStatus.type === "ok" ? "bg-green-500/10 text-green-500" :
          "bg-destructive/10 text-destructive"
        }`}>
          {requestStatus.type === "fetching" && <span className="w-2.5 h-2.5 border-2 border-current border-t-transparent rounded-full animate-spin shrink-0" />}
          {requestStatus.type === "ok" && <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" />}
          {requestStatus.type === "error" && <span className="w-2 h-2 rounded-full bg-destructive shrink-0" />}
          {downloading && downloadProgress.total > 0
            ? `Downloading: chunk ${downloadProgress.current} / ${downloadProgress.total} — ${requestStatus.msg}`
            : requestStatus.msg}
        </div>
      )}

      {/* Resume from saved position */}
      {sessionId && currentPara === -1 && state === "idle" && savedIdx >= 0 && savedIdx < paragraphs.length && (
        <button
          onClick={() => startFrom(savedIdx)}
          className="mb-2 text-xs px-3 py-1.5 rounded-lg bg-primary/10 text-primary hover:bg-primary/20 font-medium transition-colors"
        >
          Resume from paragraph {savedIdx + 1}
        </button>
      )}

      {/* Paragraphs */}
      {paragraphs.map((text, paraIdx) => {
        const displayText = fmtSecondsInText(text);
        const isPlaying = currentPara === paraIdx && state === "playing";
        const isBuffering = bufferingPara === paraIdx && state !== "idle" && state !== "paused";
        const words = displayText.split(/\s+/).filter(Boolean);

        if (renderParagraph) {
          return (
            <div
              key={paraIdx}
              className={isActive ? "cursor-pointer" : ""}
              onClick={() => isActive && startFrom(paraIdx)}
            >
              {renderParagraph(displayText, paraIdx, isPlaying, isBuffering)}
            </div>
          );
        }

        return (
          <p
            key={paraIdx}
            onClick={() => isActive && startFrom(paraIdx)}
            className={[
              "text-sm leading-relaxed pl-3 border-l-2 py-1 transition-all duration-200 flex items-center gap-2 flex-wrap",
              isActive ? "cursor-pointer" : "",
              isPlaying ? "border-primary bg-primary/8 text-foreground font-medium rounded-r-md"
                : isBuffering ? "border-primary/60 bg-primary/5 text-foreground rounded-r-md"
                : "border-primary/30 text-foreground/80",
            ].join(" ")}
          >
            {isBuffering && (
              <span className="shrink-0 w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            )}
            {isPlaying ? (
              words.map((word, wordIdx) => {
                const key = `word-${paraIdx}-${wordIdx}`;
                const isHighlighted = wordIdx === currentWordIdx;
                return (
                  <span
                    key={key}
                    ref={(el) => {
                      if (el) {
                        wordRefs.current.set(key, el);
                      } else {
                        wordRefs.current.delete(key);
                      }
                    }}
                    className={isHighlighted ? "bg-primary text-primary-foreground font-bold px-1 rounded inline-block transition-all" : "inline-block"}
                  >
                    {word}
                  </span>
                );
              })
            ) : (
              displayText
            )}
          </p>
        );
      })}
    </div>

    {/* Floating play/pause button (bottom right) */}
    {isActive && (
      <button
        onClick={handlePlayPause}
        className="fixed bottom-6 right-6 flex items-center justify-center w-14 h-14 rounded-full bg-primary text-primary-foreground shadow-lg hover:bg-primary/90 active:opacity-70 transition-all z-40"
        style={{ WebkitTapHighlightColor: "transparent", touchAction: "manipulation" }}
        title={state === "playing" ? "Pause" : "Resume"}
      >
        {state === "playing" || state === "buffering"
          ? <Pause className="w-5 h-5" />
          : <Play className="w-5 h-5" />}
      </button>
    )}
    </>
  );
}
