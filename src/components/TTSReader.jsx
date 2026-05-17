import { useState, useRef } from "react";
import { Play, Pause, Square, ChevronDown, Download } from "lucide-react";
import { cleanTextForSpeech, splitIntoChunks } from "./TTSButton";
import { fmtSecondsInText } from "@/utils/formatSeconds";
import { base44 } from "@/api/base44Client";
import { idbGet, idbSet } from "@/lib/ttsCache";

const OAI_VOICES = ["alloy", "ash", "coral", "echo", "fable", "nova", "onyx", "sage", "shimmer"];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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


export default function TTSReader({ paragraphs, renderParagraph, sessionId, title, sessionDate }) {
  const [state, setState] = useState("idle"); // idle | buffering | playing | paused
  const [currentPara, setCurrentPara] = useState(-1);
  const [bufferingPara, setBufferingPara] = useState(-1); // which paragraph is currently fetching
  const [voice, setVoice] = useState(() => {
    const saved = localStorage.getItem("tts_oai_voice") || "alloy";
    const valid = OAI_VOICES.includes(saved) ? saved : "alloy";
    if (valid !== saved) localStorage.setItem("tts_oai_voice", valid);
    return valid;
  });
  const [showVoicePicker, setShowVoicePicker] = useState(false);
  // speed slider kept for UI state but not sent to API (tts-1-hd doesn't support it)
  const [speed, setSpeed] = useState(1.0);
  const [downloading, setDownloading] = useState(false);
  const [downloadProgress, setDownloadProgress] = useState({ current: 0, total: 0 });
  const [requestStatus, setRequestStatus] = useState(null); // { type: "fetching"|"ok"|"error", msg: string }
  const [currentWordIdx, setCurrentWordIdx] = useState(-1); // index of highlighted word in current para
  const speedRef = useRef(parseFloat(localStorage.getItem("tts_speed") || "1.0"));

  const stateRef = useRef("idle");
  const currentParaRef = useRef(-1);
  const userPausedRef = useRef(false); // true only when the user explicitly paused
  const audioCtxRef = useRef(null);
  const sourceRef = useRef(null);
  const remainingParasRef = useRef([]);
  const chunkQueueRef = useRef([]);
  const currentChunkRef = useRef(null); // the chunk currently playing/buffering
  const voiceRef = useRef(voice);
  // Generation counter: increment on every startFrom to cancel stale async chains
  const genRef = useRef(0);
  // Prefetch cache: chunk text → decoded AudioBuffer (keyed by gen+chunk for staleness)
  const prefetchCacheRef = useRef(new Map()); // key: `${gen}:${chunk}` → Promise<AudioBuffer>
  const playbackTimeRef = useRef(0); // track playback time in seconds
  const chunkStartTimeRef = useRef(0); // AudioContext time when current chunk started
  const wordRefs = useRef(new Map()); // map of word element refs for auto-scroll
  const updateIntervalRef = useRef(null); // track update interval to clear it
  // Global TTS request serializer — ensures only one fetch runs at a time
  const fetchQueueRef = useRef(Promise.resolve());


  const getAudioCtx = () => {
    if (!audioCtxRef.current || audioCtxRef.current.state === "closed") {
      const ctx = new (window.AudioContext || window.webkitAudioContext)();
      // Auto-resume if browser suspends context while we intend to be playing (not user-paused)
      ctx.addEventListener("statechange", () => {
        if (ctx.state === "suspended" && stateRef.current === "playing" && !userPausedRef.current) {
          ctx.resume().catch(() => {});
        }
      });
      audioCtxRef.current = ctx;
    }
    return audioCtxRef.current;
  };

  const setS = (s) => { stateRef.current = s; setState(s); };
  const setCP = (i) => {
    currentParaRef.current = i;
    setCurrentPara(i);
    setCurrentWordIdx(-1);
    playbackTimeRef.current = 0;
    if (sessionId && i >= 0) localStorage.setItem(`tts_progress_${sessionId}`, String(i));
  };

  const stopSource = () => {
    if (sourceRef.current) { try { sourceRef.current.stop(); } catch (_) {} sourceRef.current = null; }
  };

  const stop = () => {
    genRef.current++; // invalidate any in-flight async chain
    stopSource();
    remainingParasRef.current = [];
    chunkQueueRef.current = [];
    currentChunkRef.current = null;
    prefetchCacheRef.current.clear();
    if (updateIntervalRef.current) {
      clearInterval(updateIntervalRef.current);
      updateIntervalRef.current = null;
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

    const idx = remainingParasRef.current.shift();
    setCP(idx);
    const text = paragraphs[idx] || "";
    chunkQueueRef.current = splitIntoChunks(cleanTextForSpeech(text));
    currentChunkRef.current = null;
    playNextChunk(gen);
  };

  // Fetch a chunk and decode it, using the prefetch cache when available.
  // Each chunk fetch runs independently (not serialized) so prefetched chunks
  // are ready before the current one finishes — eliminating inter-chunk gaps.
  const fetchDecoded = async (chunk, gen) => {
    const cacheKey = `${gen}:${chunk}`;
    if (prefetchCacheRef.current.has(cacheKey)) {
      return prefetchCacheRef.current.get(cacheKey);
    }
    const promise = (async () => {
      try {
        // Check IndexedDB persistent cache first
        let mp3Buffer = await idbGet(chunk, voiceRef.current, 1.0);

        if (!mp3Buffer) {
          setRequestStatus({ type: "fetching", msg: "Fetching audio…" });
          const response = await callTTSWithRetries({ text: chunk, voice: voiceRef.current });
          if (response.data?.error) throw new Error(response.data.error);
          const base64 = response.data.audio;
          const binary = atob(base64);
          const bytes = new Uint8Array(binary.length);
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
          mp3Buffer = bytes.buffer;
          idbSet(chunk, voiceRef.current, 1.0, mp3Buffer); // fire-and-forget
          setRequestStatus({ type: "ok", msg: "Audio ready" });
        } else {
          setRequestStatus({ type: "ok", msg: "Audio ready (cached)" });
        }

        const ctx = getAudioCtx();
        const decoded = await ctx.decodeAudioData(mp3Buffer.slice(0));
        return decoded;
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

    // First: remaining chunks in the current paragraph's queue
    for (const c of chunkQueueRef.current) {
      upcoming.push(c);
      if (upcoming.length >= 1) break;
    }

    // Then: first chunk(s) from the next paragraph(s)
    let paraIdx = 0;
    while (upcoming.length < 1 && paraIdx < remainingParasRef.current.length) {
      const nextParaIdx = remainingParasRef.current[paraIdx];
      const nextChunks = splitIntoChunks(cleanTextForSpeech(paragraphs[nextParaIdx] || ""));
      for (const c of nextChunks) {
        upcoming.push(c);
        if (upcoming.length >= 1) break;
      }
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

    let decoded;
    try {
      decoded = await fetchDecoded(chunk, gen);
    } catch (err) {
      console.error("TTS fetch failed:", err);
      setRequestStatus({ type: "error", msg: getTtsErrorMessage(err) });
      stop();
      return;
    }

    if (gen !== genRef.current) return;
    if (stateRef.current !== "playing") return;

    setBufferingPara(-1);

    const ctx = getAudioCtx();
    if (ctx.state === "suspended") await ctx.resume();

    if (gen !== genRef.current) return;

    const source = ctx.createBufferSource();
    source.buffer = decoded;
    source.connect(ctx.destination);
    
    // Store chunk duration
    const chunkDuration = decoded.duration;
    let audioStartTime = null; // Will be set when audio actually starts
    
    source.onended = () => { 
      sourceRef.current = null;
      // Move to next chunk after this one finishes
      playNextChunk(gen);
    };
    sourceRef.current = source;
    
    // Clear previous interval if it exists
    if (updateIntervalRef.current) clearInterval(updateIntervalRef.current);
    
    // Track playback time during this chunk
    // Wait for audio to actually start playing before syncing to AudioContext time
    let hasStarted = false;
    let lastCtxTime = ctx.currentTime;
    
    updateIntervalRef.current = setInterval(() => {
      if (gen !== genRef.current || stateRef.current !== "playing") {
        clearInterval(updateIntervalRef.current);
        updateIntervalRef.current = null;
        return;
      }
      
      const currentCtxTime = ctx.currentTime;
      
      // Detect when audio actually starts (ctx.currentTime advances)
      if (!hasStarted && currentCtxTime > lastCtxTime) {
        hasStarted = true;
        audioStartTime = currentCtxTime;
      }
      
      lastCtxTime = currentCtxTime;
      
      // Only update highlighting after audio has started
      if (hasStarted && audioStartTime !== null) {
        const elapsed = currentCtxTime - audioStartTime;
        playbackTimeRef.current = Math.max(0, Math.min(elapsed, chunkDuration));
        updateWordHighlight();
      }
    }, 50);
    
    source.start(0);

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
        } catch (e) {
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
    // Suspend then resume to immediately silence any audio still playing
    const ctx = getAudioCtx();
    if (ctx.state === "running") await ctx.suspend();
    if (gen !== genRef.current) return; // another startFrom raced us
    await ctx.resume();

    chunkQueueRef.current = [];
    currentChunkRef.current = null;
    remainingParasRef.current = paragraphs.map((_, i) => i).filter(i => i >= paraIdx);
    setCP(paraIdx);
    setS("playing");
    setBufferingPara(paraIdx);

    const text = paragraphs[paraIdx] || "";
    chunkQueueRef.current = splitIntoChunks(cleanTextForSpeech(text));
    playNextChunk(gen);
  };

  const handlePlayPause = async () => {
    if (state === "playing") {
      // Suspend the AudioContext to freeze playback at exact position
      userPausedRef.current = true;
      const ctx = getAudioCtx();
      await ctx.suspend();
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
      const ctx = getAudioCtx();
      if (ctx.state === "suspended" && sourceRef.current) {
        // Audio is suspended mid-playback — resume the context first
        setS("playing"); // update state immediately
        await ctx.resume().catch(() => {}); // ensure context resumes even if it fails
      } else {
        // Was paused during buffering — re-fetch the current chunk
        const gen = genRef.current;
        setS("playing");
        if (currentChunkRef.current) {
          await fetchAndPlay(currentChunkRef.current, gen);
        } else {
          await ctx.resume();
          playNextChunk(gen);
        }
      }
      return;
    }
    // idle → start
    await startFrom(0);
  };

  const changeVoice = (v) => {
    setVoice(v);
    voiceRef.current = v;
    localStorage.setItem("tts_oai_voice", v);
    setShowVoicePicker(false);
  };

  const changeSpeed = (v) => {
    speedRef.current = v;
    setSpeed(v);
    localStorage.setItem("tts_speed", String(v));
    prefetchCacheRef.current.clear();
    // If currently playing, restart from the current paragraph at new speed
    if (stateRef.current === "playing" || stateRef.current === "paused") {
      const para = currentParaRef.current >= 0 ? currentParaRef.current : 0;
      startFrom(para);
    }
  };

  const isActive = state === "playing" || state === "paused" || state === "buffering";
  const savedIdx = sessionId ? parseInt(localStorage.getItem(`tts_progress_${sessionId}`) || "-1", 10) : -1;

  // Build an ID3v2.3 tag — UTF-8 encoded text frames (encoding byte 0x03)
  const buildID3Tag = (meta) => {
    const enc = new TextEncoder(); // UTF-8

    // ID3v2.3 text frame: encoding(1=UTF-8 as 0x03) + UTF-8 bytes
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

    // COMM frame
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
    try {
      const allChunks = [];
      for (const para of paragraphs) {
        const cleaned = cleanTextForSpeech(para);
        const chunks = splitIntoChunks(cleaned);
        allChunks.push(...chunks);
      }

      // Fetch MP3 chunks in parallel (max 3 concurrent) for speed
      const mp3Chunks = new Array(allChunks.length);
      setDownloadProgress({ current: 0, total: allChunks.length });
      let completed = 0;
      const CONCURRENCY = 2;

      const fetchChunk = async (i) => {
        const chunk = allChunks[i];

        // Check IndexedDB persistent cache first
        let mp3Buffer = await idbGet(chunk, voiceRef.current, 1.0);

        if (!mp3Buffer) {
          const res = await callTTSWithRetries({ text: chunk, voice: voiceRef.current });
          if (res.data?.error) throw new Error(res.data.error);
          if (!res.data?.audio) throw new Error(`TTS request failed (status ${res.status})`);
          const base64 = res.data.audio;
          const binary = atob(base64);
          const bytes = new Uint8Array(binary.length);
          for (let j = 0; j < binary.length; j++) bytes[j] = binary.charCodeAt(j);
          mp3Buffer = bytes.buffer;
          idbSet(chunk, voiceRef.current, 1.0, mp3Buffer); // fire-and-forget
        }

        mp3Chunks[i] = new Uint8Array(mp3Buffer);
        await sleep(1500);
        completed++;
        setDownloadProgress({ current: completed, total: allChunks.length });
        setRequestStatus({ type: "fetching", msg: `Fetching chunk ${completed} of ${allChunks.length}…` });
      };

      // Run sequentially to avoid rate limiting
      for (let i = 0; i < allChunks.length; i++) {
        await fetchChunk(i);
      }

      // Concatenate all MP3 frames
      const totalSize = mp3Chunks.reduce((a, c) => a + c.length, 0);
      const combined = new Uint8Array(totalSize);
      let offset = 0;
      for (const chunk of mp3Chunks) { combined.set(chunk, offset); offset += chunk.length; }

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
      const fileSlug = displayTitle.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").toLowerCase();
      const fileName = `${fileSlug}.mp3`;

      // Build ID3 tag
      const id3 = buildID3Tag({
        title: displayTitle,
        year: String(yearNum),
        comment: `Recorded ${friendlyDate}, ${yearNum}`,
      });

      // Prepend ID3 tag to MP3 data
      const mp3WithMeta = new Uint8Array(id3.length + combined.length);
      mp3WithMeta.set(id3, 0);
      mp3WithMeta.set(combined, id3.length);

      const mp3Blob = new Blob([mp3WithMeta], { type: "audio/mpeg" });

      // Trigger download
      const url = URL.createObjectURL(mp3Blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = fileName;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 100);

      // Save to library (approximate duration from file size at ~128kbps)
      const approxDuration = (combined.length * 8) / 128000;
      const file = new File([mp3Blob], fileName, { type: "audio/mpeg" });
      const uploadRes = await base44.integrations.Core.UploadFile({ file });

      await base44.entities.AudioExport.create({
        title: displayTitle,  // e.g. "April 23 Cascade Overview"
        file_url: uploadRes.file_url,
        duration_seconds: Math.round(approxDuration),
        voice: voiceRef.current,
        speed: speedRef.current,
      });

      setRequestStatus({ type: "ok", msg: "Download complete" });
      setDownloadProgress({ current: 0, total: 0 });
      setDownloading(false);
    } catch (err) {
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
          title="Download full section as MP3 with metadata"
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



        {/* Voice picker */}
        <div className="relative ml-auto">
          <button
            onClick={() => setShowVoicePicker(v => !v)}
            className="flex items-center gap-1 px-2 py-1.5 rounded-lg bg-muted text-muted-foreground hover:text-foreground text-[10px] select-none transition-colors capitalize"
            style={{ WebkitTapHighlightColor: "transparent" }}
          >
            {voice} <ChevronDown className="w-3 h-3" />
          </button>
          {showVoicePicker && (
            <div className="absolute right-0 top-full mt-1 z-50 bg-popover border border-border rounded-lg shadow-lg py-1 min-w-[120px]">
              {OAI_VOICES.map((v) => (
                <button
                  key={v}
                  className={`w-full text-left px-3 py-1.5 text-xs hover:bg-muted transition-colors capitalize ${voice === v ? "text-primary font-medium" : "text-foreground"}`}
                  onClick={() => changeVoice(v)}
                >
                  {v}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

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