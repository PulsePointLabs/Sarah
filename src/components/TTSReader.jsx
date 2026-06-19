import { useState, useRef, useEffect, useMemo } from "react";
import { Play, Pause, Square, Download, Settings, Copy, Check, Minimize2, Maximize2 } from "lucide-react";
import { Link } from "react-router-dom";
import {
  cleanTextForSpeech,
  buildTTSInstructions,
  getTTSRuntime,
  getTTSMime,
  getTTSFileExtension,
  loadTTSSettings,
  normalizeTTSSettings,
  prepareTTSInput,
  splitIntoChunks,
  TTS_CHUNK_TARGET_CHARS,
} from "./TTSButton";
import { fmtSecondsInText } from "@/utils/formatSeconds";
import { buildAudioExportFilename } from "@/utils/exportFilenames";
import { base44 } from "@/api/base44Client";
import { buildAudioChapterBundle, downloadChapterSidecars } from "@/lib/audioChapters";
import { idbGet, idbSet } from "@/lib/ttsCache";
import { getBackgroundJob, listBackgroundJobs, startBackgroundJob, waitForBackgroundJob } from "@/lib/backgroundJobs";
import { serverUrl } from "@/lib/mobileApiBase";
import { repairCharacterSplitParagraph, repairDecimalSpacing, reduceConsistencyPhraseRepetition, splitSentencesPreservingDecimals } from "@/utils/aiTextRepair";

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (signal?.aborted) {
    reject(new DOMException("TTS request cancelled", "AbortError"));
    return;
  }
  const timer = setTimeout(resolve, ms);
  signal?.addEventListener("abort", () => {
    clearTimeout(timer);
    reject(new DOMException("TTS request cancelled", "AbortError"));
  }, { once: true });
});
const TTS_UNIT_MAX_CHARS = TTS_CHUNK_TARGET_CHARS;
const TTS_PREFETCH_AHEAD = 2;
const ttsCacheKey = (chunk, format, runtime, previousContext = "") =>
  `${runtime.cacheProfile}|${format}|${buildTTSInstructions(runtime.instructions, previousContext).trim()}|${chunk}`;
const ttsExportStorageKey = (sessionId, title = "") =>
  `pulsepoint.ttsExport.${sessionId || String(title || "global").replace(/[^a-z0-9]+/gi, "_").slice(0, 80)}`;
const ttsDownloadRecordKey = (sessionId, title = "") =>
  `pulsepoint.ttsDownload.${String(`${sessionId || "global"}-${title || "analysis"}`).replace(/[^a-z0-9]+/gi, "_").slice(0, 120)}`;
const TTS_AUTO_SCROLL_STORAGE_KEY = "pulsepoint.tts.autoScroll";
const TTS_SIDE_TAB_BOTTOM_KEY = "pulsepoint.tts.sideTabBottom";
const TTS_EXPORT_RENDER_VERSION = "tts_export_leading_trim_v2";
const TTS_SIDE_TAB_DEFAULT_BOTTOM = 300;
const SIDE_TAB_DRAG_THRESHOLD_PX = 6;

function clampSideTabBottom(value, tabHeight = 64) {
  if (typeof window === "undefined") return TTS_SIDE_TAB_DEFAULT_BOTTOM;
  const viewportHeight = window.innerHeight || 720;
  const min = 72;
  const max = Math.max(min, viewportHeight - tabHeight - 72);
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return Math.min(TTS_SIDE_TAB_DEFAULT_BOTTOM, max);
  return Math.max(min, Math.min(max, numeric));
}

function loadTtsSideTabBottom() {
  try {
    return clampSideTabBottom(window.localStorage.getItem(TTS_SIDE_TAB_BOTTOM_KEY));
  } catch {
    return TTS_SIDE_TAB_DEFAULT_BOTTOM;
  }
}

function isCurrentTtsExportRecord(entry) {
  return entry?.render_version === TTS_EXPORT_RENDER_VERSION;
}

function loadTtsAutoScrollPreference() {
  try {
    const stored = localStorage.getItem(TTS_AUTO_SCROLL_STORAGE_KEY);
    return stored == null ? true : stored !== "false";
  } catch {
    return true;
  }
}

function formatDownloadTimestamp(value) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toLocaleString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function splitForTTS(text) {
  return splitIntoChunks(text, TTS_UNIT_MAX_CHARS);
}

function countWords(text) {
  return String(text || "").split(/\s+/).filter(Boolean).length;
}

function sentenceRangesForText(text, offset = 0) {
  const sentences = splitSentencesPreservingDecimals(text);
  let cursor = offset;
  return sentences.map((sentence, index) => {
    const length = Math.max(1, countWords(sentence));
    const range = {
      index,
      startWord: cursor,
      endWord: cursor + length - 1,
    };
    cursor += length;
    return range;
  });
}

function getTrailingSentences(text, count = 2) {
  const sentences = splitSentencesPreservingDecimals(text);
  return sentences.slice(-count).join(" ");
}

function sentenceWordOffset(text, sentenceIdx = 0) {
  const sentences = splitSentencesPreservingDecimals(text);
  if (sentenceIdx <= 0 || sentenceIdx >= sentences.length) return 0;
  return countWords(sentences.slice(0, sentenceIdx).join(" "));
}

function buildSpeechChunks(paragraphs, startIdx = 0, startSentenceIdx = 0) {
  const chunks = [];
  let currentText = "";
  let currentStart = -1;
  let currentEnd = -1;
  let currentParts = [];

  const push = () => {
    if (!currentText.trim()) return;
    const chunkText = currentText.trim();
    chunks.push({
      start: currentStart,
      end: currentEnd,
      text: chunkText,
      parts: currentParts,
      previousContext: "",
    });
    currentText = "";
    currentStart = -1;
    currentEnd = -1;
    currentParts = [];
  };

  for (let i = startIdx; i < paragraphs.length; i++) {
    const paragraphText = paragraphs[i] || "";
    const cleaned = cleanTextForSpeech(paragraphText);
    if (!cleaned) continue;
    const resumeWordOffset = i === startIdx ? sentenceWordOffset(cleaned, startSentenceIdx) : 0;

    const parts = splitForTTS(cleaned);
    for (const part of parts) {
      const nextText = currentText ? `${currentText} ${part}` : part;
      if (currentText && nextText.length > TTS_UNIT_MAX_CHARS) {
        push();
      }

      const startWord = countWords(currentText);
      const wordCount = countWords(part);
      currentText = currentText ? `${currentText} ${part}` : part;
      if (currentStart < 0) currentStart = i;
      currentEnd = i;
      currentParts.push({
        paraIdx: i,
        startWord,
        endWord: startWord + wordCount - 1,
        resumeWordOffset,
        sentenceRanges: sentenceRangesForText(part, startWord).map((range) => ({
          ...range,
        })),
      });
    }
  }

  push();

  if (startSentenceIdx > 0) {
    const resumeChunk = chunks.find((chunk) => chunk.parts?.some((part) => (
      part.paraIdx === startIdx &&
      part.resumeWordOffset >= part.startWord &&
      part.resumeWordOffset <= part.endWord
    )));
    if (resumeChunk) {
      const resumePart = resumeChunk.parts.find((part) => (
        part.paraIdx === startIdx &&
        part.resumeWordOffset >= part.startWord &&
        part.resumeWordOffset <= part.endWord
      ));
      resumeChunk.playbackStartWord = resumePart.resumeWordOffset;
    }
  }

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

const isAbortError = (err) => err?.name === "AbortError" || /cancelled|aborted/i.test(String(err?.message || ""));

async function callTTSWithRetries(payload, attempts = 7, signal) {
  let lastError;

  for (let attempt = 0; attempt < attempts; attempt++) {
    if (signal?.aborted) throw new DOMException("TTS request cancelled", "AbortError");
    try {
      const response = await base44.functions.invoke("openaiTTS", payload, { signal });

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
      if (isAbortError(err)) throw err;
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

      await sleep(delay, signal);
    }
  }

  throw lastError;
}

const getChunkText = (chunk) => (typeof chunk === "string" ? chunk : chunk?.text || "");
const getChunkContext = (chunk) => (typeof chunk === "string" ? "" : chunk?.previousContext || "");
const getChunkStatusKey = (chunk) => `${getChunkContext(chunk)}|${getChunkText(chunk)}`;

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

export default function TTSReader({ paragraphs, renderParagraph, sessionId, title, sessionDate, sourceGeneratedAt }) {
  const [state, setState] = useState("idle"); // idle | buffering | playing | paused
  const [currentPara, setCurrentPara] = useState(-1);
  const [currentSentenceIdx, setCurrentSentenceIdx] = useState(-1);
  const [bufferingPara, setBufferingPara] = useState(-1); // which paragraph is currently fetching
  const [ttsSettings, setTtsSettings] = useState(() => loadTTSSettings());
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState({ current: 0, total: 0 });
  const [requestStatus, setRequestStatus] = useState(null); // { type: "fetching"|"ok"|"error", msg: string }
  const [completedRender, setCompletedRender] = useState(null);
  const [lastDownloadRecord, setLastDownloadRecord] = useState(null);
  const [savedServerExport, setSavedServerExport] = useState(null);
  const [audioCacheStatus, setAudioCacheStatus] = useState({ ready: 0, total: 0, fetching: 0 });
  const [cacheStatusMinimized, setCacheStatusMinimized] = useState(false);
  const [sideTabBottom, setSideTabBottom] = useState(loadTtsSideTabBottom);
  const [currentWordIdx, setCurrentWordIdx] = useState(-1); // index of highlighted word in current para
  const [autoScrollEnabled, setAutoScrollEnabled] = useState(loadTtsAutoScrollPreference);
  const [copied, setCopied] = useState(false);

  const stateRef = useRef("idle");
  const currentParaRef = useRef(-1);
  const userPausedRef = useRef(false); // true only when the user explicitly paused
  const sourceRef = useRef(null);
  const remainingParasRef = useRef([]);
  const chunkQueueRef = useRef([]);
  const currentChunkRef = useRef(null); // the chunk currently playing/buffering
  const voiceRef = useRef("nova");
  const runtimeRef = useRef(getTTSRuntime(ttsSettings));
  const playbackAbortRef = useRef(null);
  const prefetchAbortRef = useRef(null);
  const wakeLockRef = useRef(null);
  // Generation counter: increment on every startFrom to cancel stale async chains
  const genRef = useRef(0);
  // Prefetch cache: chunk text → decoded AudioBuffer (keyed by gen+chunk for staleness)
  const prefetchCacheRef = useRef(new Map()); // key: `${gen}:${chunk}` → Promise<AudioBuffer>
  const cacheReadyRef = useRef(new Set());
  const cacheFetchingRef = useRef(new Set());
  const cacheTotalRef = useRef(0);
  const playbackTimeRef = useRef(0); // track playback time in seconds
  const wordRefs = useRef(new Map()); // map of word element refs for auto-scroll
  const paragraphRefs = useRef(new Map());
  const lastAutoScrollKeyRef = useRef("");
  const updateIntervalRef = useRef(null); // track update interval to clear it
  const renderProgressTimerRef = useRef(null);
  const copyContentRef = useRef(null);
  const sideTabDragRef = useRef(null);
  const suppressSideTabClickRef = useRef(false);
  const readableParagraphs = useMemo(
    () => (Array.isArray(paragraphs) ? paragraphs : [])
      .map(repairCharacterSplitParagraph)
      .map((text) => reduceConsistencyPhraseRepetition(text, 2)),
    [paragraphs]
  );

  useEffect(() => {
    try {
      localStorage.setItem(TTS_AUTO_SCROLL_STORAGE_KEY, autoScrollEnabled ? "true" : "false");
    } catch {
      // Preference persistence is optional.
    }
  }, [autoScrollEnabled]);

  useEffect(() => {
    const clampCurrentPosition = () => {
      setSideTabBottom((value) => {
        const next = clampSideTabBottom(value);
        try {
          window.localStorage.setItem(TTS_SIDE_TAB_BOTTOM_KEY, String(next));
        } catch {
          // Position persistence is optional.
        }
        return next;
      });
    };
    window.addEventListener("resize", clampCurrentPosition);
    return () => window.removeEventListener("resize", clampCurrentPosition);
  }, []);

  useEffect(() => {
    try {
      setLastDownloadRecord(JSON.parse(localStorage.getItem(ttsDownloadRecordKey(sessionId, title)) || "null"));
    } catch {
      setLastDownloadRecord(null);
    }
  }, [sessionId, sourceGeneratedAt, title]);

  const copyOutput = async () => {
    const renderedText = copyContentRef.current?.innerText || "";
    const cleanText = [title, renderedText]
      .filter(Boolean)
      .join("\n\n")
      .replace(/[ \t]+\n/g, "\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim();
    if (!cleanText) return;
    try {
      await navigator.clipboard.writeText(cleanText);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setRequestStatus({ type: "error", msg: "Could not copy analysis to clipboard" });
    }
  };

  useEffect(() => {
    const runtime = getTTSRuntime(ttsSettings);
    runtimeRef.current = runtime;
  }, [ttsSettings]);

  useEffect(() => {
    const sync = (event) => {
      const next = normalizeTTSSettings(event?.detail || loadTTSSettings());
      setTtsSettings(next);
      runtimeRef.current = getTTSRuntime(next);
      prefetchCacheRef.current.clear();
    };
    window.addEventListener("pulsepoint:tts-settings", sync);
    return () => window.removeEventListener("pulsepoint:tts-settings", sync);
  }, []);

  const setS = (s) => { stateRef.current = s; setState(s); };
  const beginSideTabDrag = (event) => {
    if (event.button != null && event.button !== 0) return;
    sideTabDragRef.current = {
      startY: event.clientY,
      startBottom: sideTabBottom,
      moved: false,
    };
    suppressSideTabClickRef.current = false;
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const moveSideTab = (event) => {
    const drag = sideTabDragRef.current;
    if (!drag) return;
    const delta = drag.startY - event.clientY;
    if (Math.abs(delta) > SIDE_TAB_DRAG_THRESHOLD_PX) drag.moved = true;
    if (!drag.moved) return;
    event.preventDefault();
    setSideTabBottom(clampSideTabBottom(drag.startBottom + delta));
  };

  const endSideTabDrag = () => {
    const drag = sideTabDragRef.current;
    sideTabDragRef.current = null;
    if (!drag?.moved) return;
    suppressSideTabClickRef.current = true;
    setSideTabBottom((value) => {
      const next = clampSideTabBottom(value);
      try {
        window.localStorage.setItem(TTS_SIDE_TAB_BOTTOM_KEY, String(next));
      } catch {
        // Position persistence is optional.
      }
      return next;
    });
    window.setTimeout(() => {
      suppressSideTabClickRef.current = false;
    }, 0);
  };

  const publishAudioCacheStatus = () => {
    setAudioCacheStatus({
      ready: Math.min(cacheReadyRef.current.size, cacheTotalRef.current),
      total: cacheTotalRef.current,
      fetching: cacheFetchingRef.current.size,
    });
  };
  const markCacheFetching = (key, fetching) => {
    if (!key) return;
    if (fetching) cacheFetchingRef.current.add(key);
    else cacheFetchingRef.current.delete(key);
    publishAudioCacheStatus();
  };
  const markCacheReady = (key) => {
    if (!key || cacheReadyRef.current.has(key)) return;
    cacheReadyRef.current.add(key);
    cacheFetchingRef.current.delete(key);
    publishAudioCacheStatus();
  };
  const setCP = (i, { resetPlayback = true } = {}) => {
    currentParaRef.current = i;
    setCurrentPara(i);
    if (resetPlayback) {
      setCurrentWordIdx(-1);
      setCurrentSentenceIdx(-1);
      playbackTimeRef.current = 0;
    }
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

  const abortSpeculativePrefetch = () => {
    if (prefetchAbortRef.current) {
      prefetchAbortRef.current.abort();
      prefetchAbortRef.current = null;
    }
  };

  const abortPlaybackFetch = () => {
    if (playbackAbortRef.current) {
      playbackAbortRef.current.abort();
      playbackAbortRef.current = null;
    }
  };

  const releaseWakeLock = async () => {
    const wakeLock = wakeLockRef.current;
    wakeLockRef.current = null;
    try { await wakeLock?.release?.(); } catch {}
  };

  const requestWakeLock = async () => {
    if (!("wakeLock" in navigator) || document.hidden || wakeLockRef.current) return;
    try {
      wakeLockRef.current = await navigator.wakeLock.request("screen");
      wakeLockRef.current.addEventListener?.("release", () => {
        wakeLockRef.current = null;
      });
    } catch {
      // Auto-scroll still provides a visible playback nudge on browsers without wake lock support.
    }
  };

  const stop = ({ clearStatus = true } = {}) => {
    genRef.current++; // invalidate any in-flight async chain
    abortPlaybackFetch();
    abortSpeculativePrefetch();
    stopSource();
    remainingParasRef.current = [];
    chunkQueueRef.current = [];
    currentChunkRef.current = null;
    prefetchCacheRef.current.clear();
    cacheReadyRef.current = new Set();
    cacheFetchingRef.current = new Set();
    cacheTotalRef.current = 0;
    publishAudioCacheStatus();
    if (updateIntervalRef.current) {
      clearInterval(updateIntervalRef.current);
      updateIntervalRef.current = null;
    }
    if (renderProgressTimerRef.current) {
      clearInterval(renderProgressTimerRef.current);
      renderProgressTimerRef.current = null;
    }
    releaseWakeLock();
    setBufferingPara(-1);
    if (clearStatus) setRequestStatus(null);
    setS("idle");
    setCP(-1);
  };

  useEffect(() => {
    const cancelPrefetchOnFocusLoss = () => {
      abortSpeculativePrefetch();
      prefetchCacheRef.current.clear();
    };
    const onVisibilityChange = () => {
      if (document.hidden) cancelPrefetchOnFocusLoss();
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("blur", cancelPrefetchOnFocusLoss);
    return () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("blur", cancelPrefetchOnFocusLoss);
    };
  }, []);

  useEffect(() => {
    if (state === "playing") {
      requestWakeLock();
    } else {
      releaseWakeLock();
    }
    return () => {
      releaseWakeLock();
    };
  }, [state]);

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
  const fetchDecoded = async (chunk, gen, { speculative = false } = {}) => {
    const chunkText = getChunkText(chunk);
    const previousContext = getChunkContext(chunk);
    const statusKey = getChunkStatusKey(chunk);
    const cacheKey = `${gen}:${previousContext}:${chunkText}`;
    if (prefetchCacheRef.current.has(cacheKey)) {
      return prefetchCacheRef.current.get(cacheKey);
    }
    const promise = (async () => {
      try {
        markCacheFetching(statusKey, true);
        // Check IndexedDB persistent cache first
        const runtime = runtimeRef.current;
        const instructions = buildTTSInstructions(runtime.instructions, previousContext);
        const cacheText = ttsCacheKey(chunkText, runtime.format, runtime, previousContext);
        let mp3Buffer = await idbGet(cacheText, voiceRef.current, runtime.speed);

        if (!mp3Buffer) {
          if (!speculative) {
            setRequestStatus({ type: "fetching", msg: "Fetching audio..." });
          }
          const response = await callTTSWithRetries({
            text: prepareTTSInput(chunkText),
            voice: voiceRef.current,
            model: runtime.model,
            speed: runtime.speed,
            instructions: runtime.supportsInstructions ? instructions : "",
            format: runtime.format,
          }, 7, speculative ? prefetchAbortRef.current?.signal : playbackAbortRef.current?.signal);
          if (response.data?.error) throw new Error(response.data.error);
          const base64 = response.data.audio;
          const binary = atob(base64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          mp3Buffer = bytes.buffer;
          idbSet(cacheText, voiceRef.current, runtime.speed, mp3Buffer); // fire-and-forget
          if (!speculative) {
            setRequestStatus({ type: "ok", msg: "Audio ready" });
          }
        } else {
          if (!speculative) {
            setRequestStatus({ type: "ok", msg: "Audio ready (cached)" });
          }
        }

        markCacheReady(statusKey);
        return mp3Buffer.slice(0);
      } catch (err) {
        markCacheFetching(statusKey, false);
        prefetchCacheRef.current.delete(cacheKey); // allow retry on failure
        if (isAbortError(err) || gen !== genRef.current) throw err;
        setRequestStatus({ type: "error", msg: getTtsErrorMessage(err) });
        throw err;
      }
    })();
    prefetchCacheRef.current.set(cacheKey, promise);
    return promise;
  };

  // Fire-and-forget: prefetch the next chunk into the cache without blocking playback.
  const prefetchNext = (gen) => {
    if (document.hidden || !document.hasFocus()) return;
    if (!prefetchAbortRef.current || prefetchAbortRef.current.signal.aborted) {
      prefetchAbortRef.current = new AbortController();
    }
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
        fetchDecoded(chunk, gen, { speculative: true }).catch(() => {}); // errors cleared inside fetchDecoded
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
      if (isAbortError(err) || gen !== genRef.current) return;
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
    const playbackStartWord = Number(chunk?.playbackStartWord || 0);

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
      updateWordHighlight(audio.duration);
    }, 50);
    
    try {
      if (playbackStartWord > 0) {
        const applyResumeOffset = () => {
          if (!Number.isFinite(audio.duration) || audio.duration <= 0) return;
          const words = getChunkText(chunk).split(/\s+/).filter(Boolean);
          if (!words.length) return;
          audio.currentTime = Math.min(audio.duration - 0.05, Math.max(0, audio.duration * (playbackStartWord / words.length)));
          playbackTimeRef.current = Math.max(0, audio.currentTime || 0);
          updateWordHighlight(audio.duration);
        };
        if (Number.isFinite(audio.duration) && audio.duration > 0) {
          applyResumeOffset();
        } else {
          audio.addEventListener("loadedmetadata", applyResumeOffset, { once: true });
        }
      }
      await audio.play();
      setRequestStatus(null);
    } catch (err) {
      URL.revokeObjectURL(url);
      sourceRef.current = null;
      stop({ clearStatus: false });
      setRequestStatus({ type: "error", msg: getTtsErrorMessage(err) || "Audio playback was blocked" });
      return;
    }

    // Kick off background prefetch of the next chunk as soon as this one starts
    prefetchNext(gen);
  };

  const scrollActiveReadingArea = (paraIdx, wordIdx = -1, sentenceIdx = -1) => {
    if (!autoScrollEnabled) return;
    const scrollKey = `${paraIdx}:${wordIdx}:${sentenceIdx}`;
    if (scrollKey === lastAutoScrollKeyRef.current) return;
    lastAutoScrollKeyRef.current = scrollKey;

    requestAnimationFrame(() => {
      const wordKey = `word-${paraIdx}-${wordIdx}`;
      const target = wordRefs.current.get(wordKey) || paragraphRefs.current.get(paraIdx);
      if (!target) return;
      try {
        target.scrollIntoView({ behavior: "smooth", block: "center", inline: "nearest" });
      } catch {
        try { target.scrollIntoView({ behavior: "auto", block: "center", inline: "nearest" }); } catch {}
      }
    });
  };

  const updateWordHighlight = (audioDuration = 0) => {
    const chunk = currentChunkRef.current;
    const chunkText = getChunkText(chunk);
    if (!chunkText) return;
    
    const words = chunkText.split(/\s+/).filter(Boolean);
    if (!words.length) return;
    
    const duration = Number.isFinite(audioDuration) && audioDuration > 0 ? audioDuration : 0;
    const playbackProgress = duration ? Math.min(0.995, Math.max(0, playbackTimeRef.current / duration)) : null;
    const estimatedWordIdx = playbackProgress == null
      ? Math.floor(playbackTimeRef.current * 2.8)
      : Math.floor(playbackProgress * words.length);
    const boundedIdx = Math.max(0, Math.min(estimatedWordIdx, words.length - 1));
    const part = chunk?.parts?.find((item) => boundedIdx >= item.startWord && boundedIdx <= item.endWord);
    const paraIdx = part?.paraIdx ?? currentParaRef.current;
    if (paraIdx < 0 || paraIdx >= readableParagraphs.length) return;
    const paraWordIdx = part ? Math.max(0, boundedIdx - part.startWord) : boundedIdx;
    const sentenceIdx = part?.sentenceRanges?.find((range) => boundedIdx >= range.startWord && boundedIdx <= range.endWord)?.index ?? -1;
    
    // Update state with new index
    if (paraIdx !== currentParaRef.current) setCP(paraIdx, { resetPlayback: false });
    setCurrentWordIdx(paraWordIdx);
    setCurrentSentenceIdx(sentenceIdx);
    scrollActiveReadingArea(paraIdx, paraWordIdx, sentenceIdx);
  };

  const startFrom = async (paraIdx, sentenceIdx = 0) => {
    genRef.current++; // cancel any in-flight chain immediately
    abortPlaybackFetch();
    abortSpeculativePrefetch();
    const gen = genRef.current;
    playbackAbortRef.current = new AbortController();
    userPausedRef.current = false;

    stopSource();
    prefetchCacheRef.current.clear();

    chunkQueueRef.current = [];
    currentChunkRef.current = null;
    const speechChunks = buildSpeechChunks(readableParagraphs, paraIdx, sentenceIdx);
    remainingParasRef.current = speechChunks;
    cacheReadyRef.current = new Set();
    cacheFetchingRef.current = new Set();
    cacheTotalRef.current = speechChunks.length;
    publishAudioCacheStatus();
    setCacheStatusMinimized(false);
    setCP(paraIdx);
    setCurrentSentenceIdx(sentenceIdx > 0 ? sentenceIdx : -1);
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

  const getDownloadDisplayTitle = () => {
    const dateObj = sessionDate ? new Date(sessionDate) : new Date();
    const monthName = dateObj.toLocaleDateString("en-US", { month: "long" });
    const dayNum = dateObj.getDate();
    const yearNum = dateObj.getFullYear();
    const friendlyDate = `${monthName} ${dayNum} ${yearNum}`;
    const titleHasDate = title && /\d{4}|\bjan\b|\bfeb\b|\bmar\b|\bapr\b|\bmay\b|\bjun\b|\bjul\b|\baug\b|\bsep\b|\boct\b|\bnov\b|\bdec\b/i.test(title);
    return title
      ? (titleHasDate ? title : `${friendlyDate} – ${title}`)
      : `PhysioLog Analysis – ${friendlyDate}`;
  };

  const getAudioDownloadFilename = (format = runtimeRef.current.format) => buildAudioExportFilename({
    title: title || "Audio Narration",
    sessionDate: sessionDate || sourceGeneratedAt || new Date(),
    extension: getTTSFileExtension(format),
  });

  const buildCurrentChapterBundle = (audioFilename = getAudioDownloadFilename(), durationSeconds = 0) =>
    buildAudioChapterBundle({
      title: getDownloadDisplayTitle(),
      audioFilename,
      paragraphs: readableParagraphs,
      durationSeconds,
      source: title && /profile|q&a|qa|interview/i.test(title) ? "profile_qa" : "analysis_section",
    });

  const getSavedChapterLinks = (exportRecord = savedServerExport) => ([
    exportRecord?.chapter_json_url,
    exportRecord?.chapter_cue_url,
    exportRecord?.chapter_txt_url,
  ].filter(Boolean));

  const triggerRemoteChapterDownloads = (exportRecord = savedServerExport) => {
    const links = [
      { url: serverUrl(exportRecord?.chapter_json_url), suffix: ".chapters.json" },
      { url: serverUrl(exportRecord?.chapter_cue_url), suffix: ".cue" },
      { url: serverUrl(exportRecord?.chapter_txt_url), suffix: ".chapters.txt" },
    ].filter((entry) => entry.url);
    links.forEach((entry, index) => {
      window.setTimeout(() => {
        const a = document.createElement("a");
        a.href = entry.url;
        a.download = `${String(exportRecord?.filename || getAudioDownloadFilename()).replace(/\.[^.]+$/, "")}${entry.suffix}`;
        a.click();
      }, index * 120);
    });
  };

  const downloadChapters = () => {
    const exportRecord = savedServerExport?.file_url ? savedServerExport : null;
    const remoteLinks = getSavedChapterLinks(exportRecord);
    if (remoteLinks.length) {
      triggerRemoteChapterDownloads(exportRecord);
      setRequestStatus({ type: "ok", msg: `Downloaded ${remoteLinks.length} saved chapter file${remoteLinks.length === 1 ? "" : "s"}` });
      return;
    }

    const audioFilename =
      exportRecord?.filename ||
      completedRender?.filename ||
      lastDownloadRecord?.filename ||
      getAudioDownloadFilename(completedRender?.format || exportRecord?.format || runtimeRef.current.format);
    const durationSeconds =
      Number(exportRecord?.duration_seconds || completedRender?.duration_seconds || 0);
    const bundle = buildCurrentChapterBundle(audioFilename, durationSeconds);
    downloadChapterSidecars(bundle, audioFilename);
    setRequestStatus({ type: "ok", msg: `Downloaded ${bundle.chapters.length} estimated chapter bookmarks` });
  };

  const clearSavedExportJob = () => {
    try {
      localStorage.removeItem(ttsExportStorageKey(sessionId, title));
    } catch {
      // localStorage may be unavailable in rare private browsing states.
    }
  };

  const saveActiveExportJob = (job, meta = {}) => {
    try {
      localStorage.setItem(ttsExportStorageKey(sessionId, title), JSON.stringify({
        jobId: job.id,
        savedAt: new Date().toISOString(),
        ...meta,
      }));
    } catch {
      // If storage fails, the server-side job still continues and can be found by session id.
    }
  };

  const saveDownloadRecord = (record) => {
    try {
      localStorage.setItem(ttsDownloadRecordKey(sessionId, title), JSON.stringify(record));
    } catch {
      // Download remains valid if local history storage is unavailable.
    }
    setLastDownloadRecord(record);
  };

  const triggerSavedExportDownload = (exportRecord) => {
    const a = document.createElement("a");
    a.href = serverUrl(exportRecord.file_url);
    a.download = getAudioDownloadFilename(exportRecord.format || runtimeRef.current.format);
    a.click();
    saveDownloadRecord({
      downloaded_at: new Date().toISOString(),
      source_generated_at: exportRecord.source_generated_at || sourceGeneratedAt || null,
      title: exportRecord.title || getDownloadDisplayTitle(),
      filename: a.download,
      format: exportRecord.format || runtimeRef.current.format,
      has_chapters: Boolean(exportRecord.has_chapters || exportRecord.sidecar_chapters_available),
      chapter_count: Number(exportRecord.chapter_count || 0),
    });
    setRequestStatus({
      type: "ok",
      msg: exportRecord.sidecar_chapters_available
        ? "Downloaded existing narration export; chapter files are available"
        : "Downloaded existing narration export without re-rendering audio",
    });
  };

  const triggerRenderedDownload = async (rendered, displayTitle = getDownloadDisplayTitle(), exportFormat = runtimeRef.current.format, runtime = runtimeRef.current) => {
    if (!rendered?.file_url) throw new Error("Server render did not return an audio file");
    const filename = getAudioDownloadFilename(rendered.format || exportFormat);
    const a = document.createElement("a");
    a.href = serverUrl(rendered.file_url);
    a.download = filename;
    a.click();

    const createdExport = await base44.entities.AudioExport.create({
      title: displayTitle,
      file_url: rendered.file_url,
      duration_seconds: Math.round(rendered.duration_seconds || 0),
      voice: voiceRef.current,
      speed: runtime.speed,
      model: runtime.model,
      format: rendered.format || exportFormat,
      render_version: rendered.render_version || TTS_EXPORT_RENDER_VERSION,
      silence_trim: rendered.silence_trim || null,
      size: rendered.size,
      filename,
      tts_session_key: sessionId || null,
      analysis_title: title || null,
      session_date: sessionDate || null,
      source_generated_at: rendered.sourceGeneratedAt || sourceGeneratedAt || null,
      exported_at: new Date().toISOString(),
      has_chapters: Boolean(rendered.has_chapters),
      chapter_format: rendered.chapter_format || "sidecar",
      chapter_count: Number(rendered.chapter_count || 0),
      chapter_source: rendered.chapter_source || "tts_export",
      chapter_generated_at: rendered.chapter_generated_at || null,
      chapters_embedded: Boolean(rendered.chapters_embedded),
      sidecar_chapters_available: Boolean(rendered.sidecar_chapters_available),
      chapter_json_url: rendered.chapter_json_url || null,
      chapter_cue_url: rendered.chapter_cue_url || null,
      chapter_txt_url: rendered.chapter_txt_url || null,
      audio_content_version: rendered.sourceGeneratedAt || sourceGeneratedAt || null,
    });

    saveDownloadRecord({
      downloaded_at: new Date().toISOString(),
      source_generated_at: rendered.sourceGeneratedAt || sourceGeneratedAt || null,
      title: displayTitle,
      filename,
      format: rendered.format || exportFormat,
      has_chapters: Boolean(rendered.has_chapters),
      chapter_count: Number(rendered.chapter_count || 0),
    });
    setSavedServerExport(createdExport);
    clearSavedExportJob();
    setCompletedRender(null);
    setRequestStatus({
      type: "ok",
      msg: rendered.sidecar_chapters_available
        ? `Premium ${String(rendered.format || exportFormat).toUpperCase()} render downloaded with chapter files ready`
        : `Premium ${String(rendered.format || exportFormat).toUpperCase()} render downloaded`,
    });
  };

  const resumeExportJob = async (jobId, saved = {}) => {
    if (!jobId) return;
    setDownloading(true);
    setRequestStatus({ type: "fetching", msg: "Reconnected to server audio render..." });
    try {
      const completedJob = await waitForBackgroundJob(jobId, {
        intervalMs: 1200,
        onProgress: (job) => {
          const progress = job.progress || {};
          const current = Number(progress.current || 0);
          const total = Number(progress.total || saved.total || saved.chunks || 0);
          if (total) setDownloadProgress({ current, total });
          setRequestStatus({
            type: job.status === "complete" ? "ok" : "fetching",
            msg: progress.message || `Server render ${job.status || "running"}...`,
          });
        },
      });
      const rendered = completedJob.result;
      if (rendered?.file_url) {
        setCompletedRender({
          ...rendered,
          displayTitle: saved.displayTitle || completedJob.meta?.title || getDownloadDisplayTitle(),
          exportFormat: rendered.format || saved.exportFormat || runtimeRef.current.format,
          sourceGeneratedAt: saved.sourceGeneratedAt || completedJob.meta?.sourceGeneratedAt || null,
        });
        setRequestStatus({ type: "ok", msg: "Audio render finished on the server. Tap Download to save it." });
      }
    } catch (err) {
      console.error("Could not resume TTS export job:", err);
      setRequestStatus({ type: "error", msg: getTtsErrorMessage(err) || "Could not reconnect to audio render" });
      clearSavedExportJob();
    } finally {
      setDownloadProgress({ current: 0, total: 0 });
      setDownloading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const reconnect = async () => {
      const key = ttsExportStorageKey(sessionId, title);
      let saved = null;
      try {
        saved = JSON.parse(localStorage.getItem(key) || "null");
      } catch {
        saved = null;
      }

      try {
        if (saved?.jobId) {
          const job = await getBackgroundJob(saved.jobId);
          if (cancelled || !job) return;
          if (["queued", "running"].includes(job.status)) {
            resumeExportJob(job.id, saved);
            return;
          }
          if (job.status === "complete" && job.result?.file_url) {
            if (!isCurrentTtsExportRecord(job.result)) {
              clearSavedExportJob();
              return;
            }
            setCompletedRender({
              ...job.result,
              displayTitle: saved.displayTitle || job.meta?.title || getDownloadDisplayTitle(),
              exportFormat: job.result.format || saved.exportFormat || runtimeRef.current.format,
              sourceGeneratedAt: saved.sourceGeneratedAt || job.meta?.sourceGeneratedAt || null,
            });
            setRequestStatus({ type: "ok", msg: "Audio render finished while the app was away. Tap Download to save it." });
            return;
          }
          clearSavedExportJob();
        }

        if (!sessionId) return;
        const completed = await listBackgroundJobs({
          type: "tts_export",
          status: "complete",
          metaSessionId: sessionId,
          metaSource: "TTSReader",
          limit: 6,
        });
        const completedJob = (completed?.jobs || []).find((job) => (
          job?.result?.file_url &&
          isCurrentTtsExportRecord(job.result) &&
          (!sourceGeneratedAt || !job?.meta?.sourceGeneratedAt || job.meta.sourceGeneratedAt === sourceGeneratedAt)
        ));
        if (!cancelled && completedJob?.result?.file_url) {
          setCompletedRender({
            ...completedJob.result,
            displayTitle: completedJob.meta?.title || getDownloadDisplayTitle(),
            exportFormat: completedJob.result.format || runtimeRef.current.format,
            sourceGeneratedAt: completedJob.meta?.sourceGeneratedAt || null,
          });
          setRequestStatus({ type: "ok", msg: "Recovered completed server audio render. Tap Download Ready to save it." });
          saveActiveExportJob(completedJob, {
            displayTitle: completedJob.meta?.title || getDownloadDisplayTitle(),
            exportFormat: completedJob.result.format || runtimeRef.current.format,
            chunks: completedJob.meta?.chunks || 0,
            sourceGeneratedAt: completedJob.meta?.sourceGeneratedAt || null,
          });
          return;
        }

        const recent = await listBackgroundJobs({
          type: "tts_export",
          status: "queued,running",
          metaSessionId: sessionId,
          metaSource: "TTSReader",
          limit: 1,
        });
        const job = recent?.jobs?.[0];
        if (!cancelled && job?.id) {
          saveActiveExportJob(job, {
            displayTitle: job.meta?.title || getDownloadDisplayTitle(),
            exportFormat: runtimeRef.current.format,
            chunks: job.meta?.chunks || 0,
            sourceGeneratedAt: job.meta?.sourceGeneratedAt || null,
          });
          resumeExportJob(job.id, job.meta || {});
        }
      } catch {
        // Server may be offline during purely local reading; avoid noisy UI on mount.
      }
    };
    reconnect();
    return () => {
      cancelled = true;
    };
  }, [sessionId, title]);

  useEffect(() => {
    let cancelled = false;
    const findExistingSavedExport = async () => {
      setSavedServerExport(null);
      const displayTitle = getDownloadDisplayTitle();
      try {
        const [matchingTitle, matchingSession] = await Promise.all([
          base44.entities.AudioExport.filter({ title: displayTitle }, "-created_date", 30),
          sessionId
            ? base44.entities.AudioExport.filter({ tts_session_key: sessionId }, "-created_date", 30)
            : Promise.resolve([]),
        ]);
        if (cancelled) return;
        const seen = new Set();
        const usableExports = [...matchingTitle, ...matchingSession].filter((entry) => {
          const key = entry?.id || entry?.file_url;
          if (!key || seen.has(key)) return false;
          seen.add(key);
          return entry.file_url && isCurrentTtsExportRecord(entry);
        });
        const exact = sourceGeneratedAt
          ? usableExports.find((entry) => entry.source_generated_at === sourceGeneratedAt)
          : usableExports.find((entry) => entry.file_url);
        const sourceTime = sourceGeneratedAt ? new Date(sourceGeneratedAt).getTime() : null;
        const compatibleLegacy = sourceGeneratedAt && Number.isFinite(sourceTime)
          ? usableExports.find((entry) => (
            entry.file_url &&
            !entry.source_generated_at &&
            new Date(entry.created_date).getTime() >= sourceTime
          ))
          : null;
        setSavedServerExport(exact || compatibleLegacy || null);
      } catch {
        if (!cancelled) setSavedServerExport(null);
      }
    };
    findExistingSavedExport();
    return () => {
      cancelled = true;
    };
  }, [sessionDate, sessionId, sourceGeneratedAt, title]);

  const downloadedForOlderOutput = Boolean(
    sourceGeneratedAt &&
    lastDownloadRecord &&
    lastDownloadRecord.source_generated_at !== sourceGeneratedAt
  );
  const completedRenderForOlderOutput = Boolean(
    sourceGeneratedAt &&
    completedRender?.file_url &&
    completedRender.sourceGeneratedAt !== sourceGeneratedAt
  );
  const completedRenderIsCurrent = Boolean(
    completedRender?.file_url &&
    !completedRenderForOlderOutput &&
    isCurrentTtsExportRecord(completedRender)
  );
  const showFloatingFetchStatus = requestStatus?.type === "fetching" && !downloading;
  const cachePercent = audioCacheStatus.total
    ? Math.round((audioCacheStatus.ready / audioCacheStatus.total) * 100)
    : 0;
  const showAudioCacheMonitor = isActive && audioCacheStatus.total > 0;

  const downloadAudio = async () => {
    if (savedServerExport?.file_url) {
      if (completedRenderForOlderOutput) {
        setCompletedRender(null);
        clearSavedExportJob();
      }
      triggerSavedExportDownload(savedServerExport);
      return;
    }

    if (completedRender?.file_url && !completedRenderIsCurrent) {
      setCompletedRender(null);
      clearSavedExportJob();
    }

    if (completedRenderIsCurrent) {
      try {
        setDownloading(true);
        await triggerRenderedDownload(
          completedRender,
          completedRender.displayTitle || getDownloadDisplayTitle(),
          completedRender.exportFormat || runtimeRef.current.format,
          runtimeRef.current
        );
      } catch (err) {
        setRequestStatus({ type: "error", msg: getTtsErrorMessage(err) || "Download failed" });
      } finally {
        setDownloading(false);
      }
      return;
    }

    if (completedRenderForOlderOutput) {
      setCompletedRender(null);
      clearSavedExportJob();
    }

    setDownloading(true);
    if (renderProgressTimerRef.current) {
      clearInterval(renderProgressTimerRef.current);
      renderProgressTimerRef.current = null;
    }
    try {
      const allChunks = buildSpeechChunks(readableParagraphs, 0);
      setDownloadProgress({ current: 0, total: allChunks.length });
      setRequestStatus({ type: "fetching", msg: `Rendering premium audio on server (${allChunks.length} chunks)…` });
      const displayTitle = getDownloadDisplayTitle();
      const exportFormat = runtimeRef.current.format;
      const runtime = runtimeRef.current;
      const plannedFilename = getAudioDownloadFilename(exportFormat);
      const chapterBundle = buildCurrentChapterBundle(plannedFilename);
      const renderPayload = {
        title: displayTitle,
        chunks: allChunks.map((chunk) => ({
          text: prepareTTSInput(getChunkText(chunk)),
          previousContext: getChunkContext(chunk),
        })),
        chapters: chapterBundle.chapters,
        voice: voiceRef.current,
        model: runtime.model,
        speed: runtime.speed,
        instructions: runtime.instructions,
        outputFormat: exportFormat,
        normalize: runtime.settings.normalizeExport,
      };

      const startedJob = await startBackgroundJob("tts_export", renderPayload, {
        title: displayTitle,
        chunks: allChunks.length,
        source: "TTSReader",
        sessionId,
        sourceGeneratedAt: sourceGeneratedAt || null,
      });
      saveActiveExportJob(startedJob, {
        displayTitle,
        exportFormat,
        chunks: allChunks.length,
        sourceGeneratedAt: sourceGeneratedAt || null,
      });
      const completedJob = await waitForBackgroundJob(startedJob.id, {
        intervalMs: 1200,
        onProgress: (job) => {
          const progress = job.progress || {};
          const current = Number(progress.current || 0);
          const total = Number(progress.total || allChunks.length || 0);
          if (total) setDownloadProgress({ current, total });
          const type = job.status === "error" ? "error" : job.status === "complete" ? "ok" : "fetching";
          setRequestStatus({
            type,
            msg: progress.message || `Rendering chunk ${current} of ${total || allChunks.length}…`,
          });
        },
      });

      const rendered = completedJob.result;
      if (!rendered?.file_url) throw new Error("Server render did not return an audio file");
      if (renderProgressTimerRef.current) {
        clearInterval(renderProgressTimerRef.current);
        renderProgressTimerRef.current = null;
      }

      await triggerRenderedDownload({ ...rendered, sourceGeneratedAt: sourceGeneratedAt || null }, displayTitle, exportFormat, runtime);

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
      if (["error", "cancelled"].includes(err?.job?.status)) clearSavedExportJob();
      setDownloadProgress({ current: 0, total: 0 });
      setDownloading(false);
    }
  };

  return (
    <>
    {showAudioCacheMonitor && cacheStatusMinimized && (
      <button
        type="button"
        onClick={(event) => {
          if (suppressSideTabClickRef.current) {
            event.preventDefault();
            return;
          }
          setCacheStatusMinimized(false);
        }}
        onPointerDown={beginSideTabDrag}
        onPointerMove={moveSideTab}
        onPointerUp={endSideTabDrag}
        onPointerCancel={endSideTabDrag}
        className="fixed right-0 z-50 flex touch-none items-center gap-1 rounded-l-xl border border-primary/25 bg-card/95 px-2 py-3 text-[10px] font-semibold uppercase tracking-wider text-primary shadow-2xl backdrop-blur"
        style={{ bottom: `${sideTabBottom}px` }}
        title="Show audio cache status"
      >
        <Maximize2 className="h-3.5 w-3.5" />
        {cachePercent}%
      </button>
    )}
    {showAudioCacheMonitor && !cacheStatusMinimized && (
      <div className="fixed bottom-24 left-3 right-3 z-50 rounded-xl border border-primary/25 bg-card/95 px-3 py-2 text-xs text-primary shadow-2xl backdrop-blur sm:left-auto sm:w-80">
        <div className="mb-2 flex items-center gap-2">
          {showFloatingFetchStatus && <span className="h-3 w-3 shrink-0 rounded-full border-2 border-current border-t-transparent animate-spin" />}
          <span className="min-w-0 flex-1 truncate">
            {showFloatingFetchStatus ? requestStatus.msg || "Fetching audio..." : "Audio cache ready"}
          </span>
          <button
            type="button"
            onClick={() => setCacheStatusMinimized(true)}
            className="rounded-md p-1 text-primary/80 hover:bg-primary/10 hover:text-primary"
            title="Minimize audio cache status"
          >
            <Minimize2 className="h-3.5 w-3.5" />
          </button>
        </div>
        <div className="h-1.5 overflow-hidden rounded-full bg-primary/15">
          <div className="h-full rounded-full bg-primary transition-all duration-300" style={{ width: `${cachePercent}%` }} />
        </div>
        <div className="mt-1.5 flex items-center justify-between text-[10px] text-muted-foreground">
          <span>{audioCacheStatus.ready} / {audioCacheStatus.total} chunks cached</span>
          <span>{audioCacheStatus.fetching ? `${audioCacheStatus.fetching} fetching` : "Playback active"}</span>
        </div>
      </div>
    )}
    <div className="ai-output-width-guard space-y-1 min-w-0 w-full max-w-full">
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
          type="button"
          onClick={copyOutput}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-muted text-muted-foreground hover:text-foreground active:opacity-70 transition-colors text-xs font-medium select-none ml-auto"
          style={{ WebkitTapHighlightColor: "transparent", touchAction: "manipulation" }}
          title="Copy formatted analysis text"
        >
          {copied
            ? <><Check className="w-3.5 h-3.5 text-emerald-400" /> Copied</>
            : <><Copy className="w-3.5 h-3.5" /> Copy</>}
        </button>

        <button
          type="button"
          onClick={() => setAutoScrollEnabled((value) => !value)}
          className={`flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg border active:opacity-70 transition-colors text-xs font-medium select-none ${
            autoScrollEnabled
              ? "border-primary/40 bg-primary/10 text-primary"
              : "border-border bg-muted text-muted-foreground hover:text-foreground"
          }`}
          style={{ WebkitTapHighlightColor: "transparent", touchAction: "manipulation" }}
          title={autoScrollEnabled ? "Disable automatic scrolling while TTS plays" : "Enable automatic scrolling while TTS plays"}
          aria-pressed={autoScrollEnabled}
        >
          Auto-scroll {autoScrollEnabled ? "On" : "Off"}
        </button>

        <button
          onClick={downloadAudio}
          disabled={downloading}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-muted text-muted-foreground hover:text-foreground disabled:opacity-50 active:opacity-70 transition-colors text-xs font-medium select-none"
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
              <Download className="w-3.5 h-3.5" /> {completedRenderForOlderOutput || (completedRender?.file_url && !completedRenderIsCurrent) ? "Download Updated" : savedServerExport?.file_url ? "Download Existing" : completedRenderIsCurrent ? "Download Ready" : "Download"}
            </>
          )}
        </button>

        <button
          type="button"
          onClick={downloadChapters}
          disabled={downloading || !readableParagraphs.length}
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-muted text-muted-foreground hover:text-foreground disabled:opacity-50 active:opacity-70 transition-colors text-xs font-medium select-none"
          style={{ WebkitTapHighlightColor: "transparent", touchAction: "manipulation" }}
          title="Download chapter bookmark files"
        >
          <Download className="w-3.5 h-3.5" /> Chapters
        </button>

        <Link
          to="/settings"
          className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-muted text-muted-foreground hover:text-foreground active:opacity-70 transition-colors text-xs font-medium select-none"
          style={{ WebkitTapHighlightColor: "transparent", touchAction: "manipulation" }}
          title="Open TTS settings"
        >
          <Settings className="w-3.5 h-3.5" /> Settings
        </Link>
      </div>

      {/* API Request Status */}
      {requestStatus && !showFloatingFetchStatus && (
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

      {lastDownloadRecord?.downloaded_at && (
        <div className={`text-[10px] px-2 py-1 rounded-md mb-1 ${
          downloadedForOlderOutput
            ? "border border-amber-400/30 bg-amber-400/10 text-amber-300"
            : "bg-muted/50 text-muted-foreground"
        }`}>
          Narration downloaded {formatDownloadTimestamp(lastDownloadRecord.downloaded_at) || "at an unknown time"}.
          {downloadedForOlderOutput
            ? " A newer AI output exists; download again for current narration."
            : sourceGeneratedAt && lastDownloadRecord.source_generated_at === sourceGeneratedAt
              ? " Matches this AI output."
              : ""}
          {lastDownloadRecord.has_chapters
            ? ` ${lastDownloadRecord.chapter_count || "Estimated"} chapters available.`
            : ""}
        </div>
      )}

      {savedServerExport?.file_url && (
        <div className="text-[10px] px-2 py-1 rounded-md mb-1 bg-primary/10 text-primary">
          Narration already exported {formatDownloadTimestamp(savedServerExport.exported_at || savedServerExport.created_date) || "previously"}.
          {" "}Download reuses the saved audio file without rendering again.
          {savedServerExport.sidecar_chapters_available
            ? ` Chapter sidecars available (${savedServerExport.chapter_count || 0}).`
            : " Chapter sidecars can be generated without re-rendering."}
        </div>
      )}

      {completedRenderForOlderOutput && (
        <div className="text-[10px] px-2 py-1 rounded-md mb-1 border border-amber-400/30 bg-amber-400/10 text-amber-300">
          A ready narration belongs to an older AI output and will not be downloaded. Use Download Updated to render the current version.
        </div>
      )}

      {/* Paragraphs */}
      <div ref={copyContentRef} className="ai-output-copy-surface space-y-1 min-w-0 w-full max-w-full">
      {readableParagraphs.map((text, paraIdx) => {
        const displayText = repairDecimalSpacing(fmtSecondsInText(text));
        const isPlaying = currentPara === paraIdx && state === "playing";
        const isBuffering = bufferingPara === paraIdx && state !== "idle" && state !== "paused";
        const words = displayText.split(/\s+/).filter(Boolean);

        if (renderParagraph) {
          return (
            <div
              key={paraIdx}
              ref={(el) => {
                if (el) paragraphRefs.current.set(paraIdx, el);
                else paragraphRefs.current.delete(paraIdx);
              }}
              className="ai-output-paragraph-shell w-full min-w-0 max-w-full cursor-pointer"
              onClick={() => startFrom(paraIdx)}
            >
              {renderParagraph(displayText, paraIdx, isPlaying, isBuffering, isPlaying ? currentSentenceIdx : -1, (sentenceIdx) => startFrom(paraIdx, sentenceIdx))}
            </div>
          );
        }

        return (
          <p
            key={paraIdx}
            ref={(el) => {
              if (el) paragraphRefs.current.set(paraIdx, el);
              else paragraphRefs.current.delete(paraIdx);
            }}
            onClick={() => startFrom(paraIdx)}
            className={[
              "text-sm leading-relaxed pl-3 border-l-2 py-1 transition-all duration-200 flex items-center gap-2 flex-wrap",
              "cursor-pointer",
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
                    className={isHighlighted ? "bg-primary text-primary-foreground font-bold px-1 rounded inline transition-all" : "inline"}
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
    </div>

    {/* Floating play/pause button (bottom right) */}
    {isActive && (
      <button
        onClick={handlePlayPause}
        className="fixed bottom-24 right-6 flex items-center justify-center w-14 h-14 rounded-full bg-primary text-primary-foreground shadow-lg hover:bg-primary/90 active:opacity-70 transition-all z-40 sm:bottom-6"
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
