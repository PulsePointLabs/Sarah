import { useState, useRef } from "react";
import { Play, Pause, Square } from "lucide-react";
import { base44 } from "@/api/base44Client";

// Convert large raw-second values to spoken minutes + seconds
function secondsToSpeech(n) {
  const sec = Math.round(Number(n));
  if (sec < 100) return `${sec} seconds`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s === 0
    ? `${m} minute${m !== 1 ? 's' : ''}`
    : `${m} minute${m !== 1 ? 's' : ''} and ${s} seconds`;
}

// Convert time string (HH:MM:SS or MM:SS) or seconds to spoken words
export function formatTimeAsWords(time) {
  if (typeof time === "number") {
    const m = Math.floor(time / 60);
    const s = Math.round(time % 60);
    return s === 0
      ? `${m} minute${m !== 1 ? 's' : ''}`
      : `${m} minute${m !== 1 ? 's' : ''} and ${s} seconds`;
  }
  
  const parts = String(time).split(":").map(Number);
  let totalSeconds = 0;
  if (parts.length === 3) totalSeconds = parts[0] * 3600 + parts[1] * 60 + parts[2];
  else if (parts.length === 2) totalSeconds = parts[0] * 60 + parts[1];
  else return time;
  
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return s === 0
    ? `${m} minute${m !== 1 ? 's' : ''}`
    : `${m} minute${m !== 1 ? 's' : ''} and ${s} seconds`;
}

// Clean text for natural speech
export function cleanTextForSpeech(text) {
  return text
    .replace(/•/g, ". ")
    .replace(/·/g, ". ")
    .replace(/–|—/g, ", ")
    .replace(/(\d+)\s*bpm/gi, "$1 beats per minute")
    .replace(/\b(\d{3,})\s*seconds\b/gi, (_, n) => secondsToSpeech(n))
    .replace(/\b(\d{3,})s\b/g, (_, n) => secondsToSpeech(n))
    .replace(/(\d+)\s*m(\d+)s/g, (_, m, s) => `${m} minute${m !== '1' ? 's' : ''} ${s} seconds`)
    .replace(/(\d+)\s*m(?=\b)/g, "$1 minutes")
    .replace(/(\d+)\s*s(?=\b)/g, "$1 seconds")
    .replace(/>=/g, " greater than or equal to ")
    .replace(/<=/g, " less than or equal to ")
    .replace(/>/g, " greater than ")
    .replace(/</g, " less than ")
    .replace(/±/g, " plus or minus ")
    .replace(/\+/g, " plus ")
    .replace(/\*/g, " times ")
    .replace(/%/g, " percent")
    .replace(/\/(?=\d)/g, " out of ")
    .replace(/→/g, " to ")
    .replace(/←/g, " from ")
    .replace(/≈/g, " approximately ")
    .replace(/~(\d)/g, "approximately $1")
    .replace(/\bHR\b/g, "heart rate")
    .replace(/\bhr\b/g, "heart rate")
    .replace(/\bavg\b/gi, "average")
    .replace(/\bmax\b/gi, "maximum")
    .replace(/\bmin\b/g, "minimum")
    .replace(/\bI:(\d+)/g, "intensity $1")
    .replace(/♥/g, "heart rate")
    .replace(/[#_*`]/g, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

// Split text into chunks only if it exceeds OpenAI's 4096-char limit
export function splitIntoChunks(text, maxLen = 4000) {
  if (text.length <= maxLen) return [text];
  const sentences = text.match(/[^.!?]+[.!?]*/g) || [text];
  const chunks = [];
  let current = "";
  for (const s of sentences) {
    if ((current + s).length > maxLen) {
      if (current.trim()) chunks.push(current.trim());
      current = s;
    } else {
      current += s;
    }
  }
  if (current.trim()) chunks.push(current.trim());
  return chunks.length ? chunks : [text];
}

/**
 * TTSButton — simple play/pause/stop button using OpenAI TTS.
 */
export default function TTSButton({ getText }) {
  const [state, setState] = useState("idle"); // idle | loading | playing | paused
  const stateRef = useRef("idle");
  const audioCtxRef = useRef(null);
  const sourceRef = useRef(null);
  const queueRef = useRef([]);
  const voiceRef = useRef(localStorage.getItem("tts_oai_voice") || "alloy");

  const setS = (s) => { stateRef.current = s; setState(s); };

  const getCtx = () => {
    if (!audioCtxRef.current || audioCtxRef.current.state === "closed") {
      audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
    }
    return audioCtxRef.current;
  };

  const stopSource = () => {
    if (sourceRef.current) { try { sourceRef.current.stop(); } catch (_) {} sourceRef.current = null; }
  };

  const stop = () => {
    stopSource();
    queueRef.current = [];
    setS("idle");
  };

  const playNextChunk = async () => {
    if (stateRef.current !== "playing") return;
    const chunk = queueRef.current.shift();
    if (!chunk) { setS("idle"); return; }

    let response;
    try {
      response = await base44.functions.invoke("openaiTTS", { text: chunk, voice: voiceRef.current });
    } catch (err) {
      console.error("TTS fetch failed:", err);
      stop();
      return;
    }
    if (stateRef.current !== "playing") return;

    const base64 = response.data.audio;
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
    // slice() to get a fresh, non-detachable ArrayBuffer
    const buffer = bytes.buffer.slice(0);

    const ctx = getCtx();
    if (ctx.state === "suspended") await ctx.resume();
    const decoded = await ctx.decodeAudioData(buffer);
    if (stateRef.current !== "playing") return;

    const source = ctx.createBufferSource();
    source.buffer = decoded;
    source.connect(ctx.destination);
    source.onended = () => { sourceRef.current = null; playNextChunk(); };
    sourceRef.current = source;
    source.start(0);
  };

  const handlePress = async () => {
    if (state === "playing") {
      stopSource();
      setS("paused");
      return;
    }
    if (state === "paused") {
      setS("playing");
      const ctx = getCtx();
      if (ctx.state === "suspended") await ctx.resume();
      playNextChunk();
      return;
    }
    // idle → start
    const raw = getText?.();
    if (!raw?.trim()) return;
    setS("loading");
    queueRef.current = splitIntoChunks(cleanTextForSpeech(raw));
    setS("playing");
    playNextChunk();
  };

  if (state === "idle") {
    return (
      <button
        onClick={handlePress}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-muted text-muted-foreground hover:text-foreground active:opacity-70 transition-colors text-xs font-medium select-none"
        style={{ WebkitTapHighlightColor: "transparent", touchAction: "manipulation" }}
      >
        <Play className="w-3.5 h-3.5" /> Read
      </button>
    );
  }

  if (state === "loading") {
    return (
      <button disabled className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-muted text-muted-foreground text-xs font-medium select-none">
        <span className="w-3 h-3 border-2 border-current border-t-transparent rounded-full animate-spin" /> Loading…
      </button>
    );
  }

  return (
    <div className="flex items-center gap-1">
      <button
        onClick={handlePress}
        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-primary/10 text-primary hover:bg-primary/20 active:opacity-70 transition-colors text-xs font-medium select-none"
        style={{ WebkitTapHighlightColor: "transparent", touchAction: "manipulation" }}
      >
        {state === "playing" ? <Pause className="w-3.5 h-3.5" /> : <Play className="w-3.5 h-3.5" />}
        {state === "playing" ? "Pause" : "Resume"}
      </button>
      <button
        onClick={stop}
        className="p-1.5 rounded-lg bg-muted text-muted-foreground hover:text-foreground active:opacity-70 transition-colors select-none"
        style={{ WebkitTapHighlightColor: "transparent", touchAction: "manipulation" }}
      >
        <Square className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}