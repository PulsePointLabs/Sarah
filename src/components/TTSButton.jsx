import { useState, useRef } from "react";
import { Play, Pause, Square } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { repairDecimalSpacing, splitSentencesPreservingDecimals } from "@/utils/aiTextRepair";
import { normalizeNumericBandsForSpeech } from "@/utils/ttsTextNormalization";
import { buildSarahTTSVoicePrompt, readSarahPersonalitySettings } from "@/utils/sarahPersonality";

const TTS_SETTINGS_KEY = "pulsepoint_tts_settings_v1";
const TTS_REQUEST_TAIL = "\u200B";

export const DEFAULT_TTS_SETTINGS = {
  speed: 0.96,
  engine: "expressive",
  audioFormat: "mp3",
  normalizeExport: false,
  warmth: 8,
  enthusiasm: 5,
  soothing: 9,
  lightness: 8,
  femininity: 8,
  continuity: 10,
  naturalness: 10,
  pauses: 9,
  softStart: 10,
};

export const TTS_PRESETS = {
  "Base44 Flow": {
    speed: 0.96,
    engine: "expressive",
    audioFormat: "mp3",
    normalizeExport: false,
    warmth: 8,
    enthusiasm: 5,
    soothing: 9,
    lightness: 8,
    femininity: 8,
    continuity: 10,
    naturalness: 10,
    pauses: 9,
    softStart: 10,
  },
  "Soft ASMR": {
    speed: 0.94,
    engine: "expressive",
    audioFormat: "mp3",
    normalizeExport: false,
    warmth: 9,
    enthusiasm: 4,
    soothing: 10,
    lightness: 8,
    femininity: 9,
    continuity: 10,
    naturalness: 10,
    pauses: 10,
    softStart: 10,
  },
  "Bright Natural": {
    speed: 0.97,
    engine: "expressive",
    audioFormat: "mp3",
    normalizeExport: false,
    warmth: 8,
    enthusiasm: 6,
    soothing: 8,
    lightness: 9,
    femininity: 8,
    continuity: 9,
    naturalness: 10,
    pauses: 8,
    softStart: 9,
  },
  "Trusted Friend": {
    speed: 0.96,
    engine: "expressive",
    audioFormat: "mp3",
    normalizeExport: false,
    warmth: 9,
    enthusiasm: 5,
    soothing: 9,
    lightness: 7,
    femininity: 8,
    continuity: 10,
    naturalness: 10,
    pauses: 9,
    softStart: 10,
  },
  "HD Crisp": {
    speed: 0.96,
    engine: "hd",
    audioFormat: "mp3",
    normalizeExport: false,
    warmth: 8,
    enthusiasm: 5,
    soothing: 9,
    lightness: 8,
    femininity: 8,
    continuity: 10,
    naturalness: 10,
    pauses: 9,
    softStart: 10,
  },
  "Lossless Test": {
    speed: 0.96,
    engine: "expressive",
    audioFormat: "wav",
    normalizeExport: false,
    warmth: 8,
    enthusiasm: 5,
    soothing: 9,
    lightness: 8,
    femininity: 8,
    continuity: 10,
    naturalness: 10,
    pauses: 9,
    softStart: 10,
  },
};

export const TTS_ENGINES = {
  expressive: {
    label: "Expressive",
    model: "gpt-4o-mini-tts",
    supportsInstructions: true,
  },
  hd: {
    label: "HD Crisp",
    model: "tts-1-hd",
    supportsInstructions: false,
  },
};

export const TTS_AUDIO_FORMATS = {
  mp3: { label: "MP3", extension: "mp3", mime: "audio/mpeg" },
  m4a: { label: "M4A", extension: "m4a", mime: "audio/mp4" },
  wav: { label: "WAV", extension: "wav", mime: "audio/wav" },
};

export const BOOKMARKED_TTS_PROFILE = "bright-natural-analysis-mp3-100-v14";

export function loadTTSSettings() {
  if (typeof localStorage === "undefined") return DEFAULT_TTS_SETTINGS;
  try {
    const saved = JSON.parse(localStorage.getItem(TTS_SETTINGS_KEY) || "null");
    return normalizeTTSSettings(saved);
  } catch {
    return DEFAULT_TTS_SETTINGS;
  }
}

export function saveTTSSettings(settings) {
  const normalized = normalizeTTSSettings(settings);
  localStorage.setItem(TTS_SETTINGS_KEY, JSON.stringify(normalized));
  window.dispatchEvent(new CustomEvent("pulsepoint:tts-settings", { detail: normalized }));
  return normalized;
}

export function normalizeTTSSettings(settings = {}) {
  const clamp = (value, min, max, fallback) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
  };
  return {
    speed: Number(clamp(settings.speed, 0.94, 1.04, DEFAULT_TTS_SETTINGS.speed).toFixed(2)),
    engine: TTS_ENGINES[settings.engine] ? settings.engine : DEFAULT_TTS_SETTINGS.engine,
    audioFormat: TTS_AUDIO_FORMATS[settings.audioFormat] ? settings.audioFormat : DEFAULT_TTS_SETTINGS.audioFormat,
    normalizeExport: Boolean(settings.normalizeExport ?? DEFAULT_TTS_SETTINGS.normalizeExport),
    warmth: Math.round(clamp(settings.warmth, 0, 10, DEFAULT_TTS_SETTINGS.warmth)),
    enthusiasm: Math.round(clamp(settings.enthusiasm, 0, 10, DEFAULT_TTS_SETTINGS.enthusiasm)),
    soothing: Math.round(clamp(settings.soothing, 0, 10, DEFAULT_TTS_SETTINGS.soothing)),
    lightness: Math.round(clamp(settings.lightness, 0, 10, DEFAULT_TTS_SETTINGS.lightness)),
    femininity: Math.round(clamp(settings.femininity, 0, 10, DEFAULT_TTS_SETTINGS.femininity)),
    continuity: Math.round(clamp(settings.continuity, 0, 10, DEFAULT_TTS_SETTINGS.continuity)),
    naturalness: Math.round(clamp(settings.naturalness, 0, 10, DEFAULT_TTS_SETTINGS.naturalness)),
    pauses: Math.round(clamp(settings.pauses, 0, 10, DEFAULT_TTS_SETTINGS.pauses)),
    softStart: Math.round(clamp(settings.softStart, 0, 10, DEFAULT_TTS_SETTINGS.softStart)),
  };
}

export function buildVoiceInstructions(settings = DEFAULT_TTS_SETTINGS) {
  const s = normalizeTTSSettings(settings);
  const enthusiasm =
    s.enthusiasm >= 8
      ? "Use a gentle, interested lift at meaningful physiological moments, especially stimulation changes, climax approach, release, recovery, and important findings; keep it bright but never big."
      : s.enthusiasm >= 5
        ? "Use subtle, natural enthusiasm only when the moment genuinely calls for it, like a soft smile in conversation."
        : "Keep enthusiasm quiet and understated, with only a slight lift at key moments.";
  const warmth =
    s.warmth >= 8
      ? "Keep the tone warmly human, reassuring, personally engaged, and gently affectionate without becoming performative."
      : s.warmth >= 5
        ? "Keep the tone gently warm and reassuring."
        : "Keep warmth restrained and simple.";
  const soothing =
    s.soothing >= 8
      ? "Let the cadence feel very soothing, soft, and ASMR-like, with relaxed pauses, easy breath, and no tension in the entrance of phrases."
      : s.soothing >= 5
        ? "Let the cadence feel soothing and relaxed."
        : "Keep the cadence natural, without adding extra softness.";
  const lightness =
    s.lightness >= 8
      ? "Use a brighter, lighter, clearly feminine sound with a soft smile in the voice; avoid heaviness, bassy emphasis, or a stern narrator feel."
      : s.lightness >= 5
        ? "Use a lightly feminine, easy, slightly bright sound."
        : "Keep the voice grounded and less bright.";
  const femininity =
    s.femininity >= 8
      ? "Lean into a distinctly feminine narrator presence: soft-edged, graceful, relaxed, and emotionally present, without becoming breathy, flirty, or performative."
      : s.femininity >= 5
        ? "Keep the narrator presence gently feminine and natural."
        : "Keep the narrator presence more neutral while still warm.";
  const continuity =
    s.continuity >= 8
      ? "Maintain one continuous narrator identity across all chunks and sections; begin new paragraphs like a continuation already in motion, never like a new announcement."
      : s.continuity >= 5
        ? "Keep transitions between sections smooth and connected."
        : "Keep transitions natural and simple.";
  const naturalness =
    s.naturalness >= 8
      ? "Sound like natural human conversation, not event narration; use varied, organic inflection and avoid repetitive sentence-start energy."
      : s.naturalness >= 5
        ? "Keep the performance conversational and natural."
        : "Keep the reading clear and simple.";
  const pauses =
    s.pauses >= 8
      ? "Use relaxed, natural pauses and tiny breath-like holds where a person would naturally breathe; never rush through transitions."
      : s.pauses >= 5
        ? "Use natural pauses without rushing."
        : "Keep pauses minimal and straightforward.";
  const softStart =
    s.softStart >= 8
      ? "Enter every new chunk, paragraph, and section softly, as if continuing mid-thought; make opening words light, unstressed, and unannounced."
      : s.softStart >= 5
        ? "Keep section entrances smooth and lightly stressed."
        : "Keep section starts plain and clear.";

  return `Read naturally in a warm, calm, feminine human voice.
Sound soothing, emotionally intelligent, relaxed, and subtly intimate.
Think trusted friend with strong anatomy and physiology knowledge explaining something thoughtfully.
Maintain identical warmth, pacing, and emotional tone across all sections.
Use natural conversational rhythm.
Slightly slower pacing.
Subtle enthusiasm only when naturally appropriate.
Natural human conversation, NOT event narration.
Keep final consonants complete and clean, especially words ending in "s"; let sibilants sound gentle, crisp, and finished, never clipped, slurred, hissy, or harsh.
${warmth}
${soothing}
${lightness}
${femininity}
${enthusiasm}
${continuity}
${naturalness}
${pauses}
${softStart}
Treat the start of every chunk or section as a soft pickup from the previous thought, not a headline.
Make first words smaller and lighter than the sentence that follows.
If a chunk or section begins with "you", "your", "this", or "the", pronounce that word lightly and unstressed, as a continuation, never as "YOU" or "YOUR".
Avoid hard emphasis on section starts or first words.
Do not sound robotic, theatrical, exaggerated, documentary-like, overly analytical, clinical-dictation-like, overly clinical, customer-service-like, or performative.`;
}

function compactInstructionHash(value = "") {
  const text = String(value || "");
  let hash = 0;
  for (let i = 0; i < text.length; i += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}

export function getTTSRuntime(settings = loadTTSSettings(), sarahPersonality = readSarahPersonalitySettings()) {
  const normalized = normalizeTTSSettings(settings);
  const baseInstructions = buildVoiceInstructions(normalized);
  const sarahVoiceInstructions = buildSarahTTSVoicePrompt(sarahPersonality);
  const instructions = sarahVoiceInstructions
    ? `${baseInstructions}

${sarahVoiceInstructions}

Priority: the TTS slider settings define the base voice. The Sarah voice delivery settings should meaningfully shape inflection, emphasis, and tone on top of those sliders.`
    : baseInstructions;
  const sarahVoiceProfile = sarahVoiceInstructions
    ? `-sarah-${compactInstructionHash(sarahVoiceInstructions)}`
    : "-sarah-off";
  return {
    settings: normalized,
    speed: normalized.speed,
    engine: normalized.engine,
    model: TTS_ENGINES[normalized.engine].model,
    format: normalized.audioFormat,
    supportsInstructions: TTS_ENGINES[normalized.engine].supportsInstructions,
    instructions,
    sarahVoiceInstructions,
    cacheProfile: `settings-v7-${normalized.engine}-${normalized.audioFormat}-speed-${normalized.speed}-w${normalized.warmth}-e${normalized.enthusiasm}-s${normalized.soothing}-l${normalized.lightness}-f${normalized.femininity}-c${normalized.continuity}-n${normalized.naturalness}-p${normalized.pauses}-ss${normalized.softStart}${sarahVoiceProfile}`,
  };
}

export function buildTTSInstructions(baseInstructions, previousContext = "") {
  const context = String(previousContext || "").trim();
  if (!context) return baseInstructions;
  return `${baseInstructions}

CONTEXT ONLY — DO NOT READ:
Previous narration:
"${context}"

Continue seamlessly from the previous narration.
This is the same continuous thought.
Do NOT restart energy, tone, pacing, or emphasis.
Read only the input text.`;
}

export function prepareTTSInput(text) {
  const cleaned = String(text || "").trim();
  return cleaned ? `${cleaned}${TTS_REQUEST_TAIL}` : cleaned;
}

export const VOICE_INSTRUCTIONS = buildVoiceInstructions(DEFAULT_TTS_SETTINGS);
export const TTS_SPEED = DEFAULT_TTS_SETTINGS.speed;
export const TTS_PLAYBACK_FORMAT = DEFAULT_TTS_SETTINGS.audioFormat;
export const TTS_EXPORT_FORMAT = DEFAULT_TTS_SETTINGS.audioFormat;
export const TTS_EXPORT_CONTAINER = TTS_AUDIO_FORMATS[DEFAULT_TTS_SETTINGS.audioFormat].extension;
export const TTS_EXPORT_MIME = TTS_AUDIO_FORMATS[DEFAULT_TTS_SETTINGS.audioFormat].mime;
export const TTS_MIME_BY_FORMAT = {
  mp3: "audio/mpeg",
  m4a: "audio/mp4",
  aac: "audio/aac",
  opus: "audio/ogg",
  flac: "audio/flac",
  wav: "audio/wav",
};
export const getTTSMime = (format = TTS_PLAYBACK_FORMAT) =>
  TTS_MIME_BY_FORMAT[String(format || "").toLowerCase()] || "audio/mpeg";
export const getTTSFileExtension = (format = TTS_EXPORT_FORMAT) =>
  TTS_AUDIO_FORMATS[String(format || "").toLowerCase()]?.extension || "mp3";
export const TTS_CHUNK_MAX_CHARS = 2500;
export const TTS_CHUNK_TARGET_CHARS = 2400;
export const TTS_CHUNK_MIN_CHARS = 1000;
export const TTS_CACHE_VOICE_PROFILE = getTTSRuntime(DEFAULT_TTS_SETTINGS).cacheProfile;

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

const RESUME_PRONUNCIATION = {
  resume: "re-zoom",
  resumes: "re-zooms",
  resumed: "re-zoomed",
  resuming: "re-zooming",
};

const RESUME_CONTEXT_WORDS = "(stimulation|contact|stroke|strokes|stroking|motion|movement|activity|rhythm|hand|hands|genital|penile|shaft|glans|perineal|pelvic|masturbation)";

function pronounceResumeVerb(word) {
  return RESUME_PRONUNCIATION[String(word || "").toLowerCase()] || word;
}

function applyTTSPronunciationHints(text) {
  return String(text || "")
    .replace(/\bpause\s*\/\s*resume\b/gi, "pause/re-zoom")
    .replace(
      new RegExp(`\\b${RESUME_CONTEXT_WORDS}\\s+(resume|resumes|resumed|resuming)\\b`, "gi"),
      (match, context, resumeWord) => `${context} ${pronounceResumeVerb(resumeWord)}`
    )
    .replace(
      new RegExp(`\\b(resume|resumes|resumed|resuming)\\s+${RESUME_CONTEXT_WORDS}\\b`, "gi"),
      (match, resumeWord, context) => `${pronounceResumeVerb(resumeWord)} ${context}`
    );
}

// Clean text for natural speech
export function cleanTextForSpeech(text) {
  return applyTTSPronunciationHints(normalizeNumericBandsForSpeech(repairDecimalSpacing(text)))
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\[(\d{1,2}:\d{2}(?::\d{2})?)\]/g, (_, time) => formatTimeAsWords(time))
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
    .replace(/(\d)\s*\*\s*(\d)/g, "$1 times $2")
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

// Split text only when needed. This mirrors the known-good bright natural profile.
export function splitIntoChunks(text, maxLen = TTS_CHUNK_MAX_CHARS) {
  if (text.length <= maxLen) return [text];
  const sentences = splitSentencesPreservingDecimals(text);
  const chunks = [];
  let current = "";
  for (const s of sentences) {
    const nextSentence = `${s} `;
    if ((current + nextSentence).length > maxLen) {
      if (current.trim()) chunks.push(current.trim());
      current = nextSentence;
    } else {
      current += nextSentence;
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
  const sourceRef = useRef(null);
  const queueRef = useRef([]);
  const previousChunkRef = useRef("");

  const setS = (s) => { stateRef.current = s; setState(s); };

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

  const stop = () => {
    stopSource();
    queueRef.current = [];
    previousChunkRef.current = "";
    setS("idle");
  };

  const playNextChunk = async () => {
    if (stateRef.current !== "playing") return;
    const chunk = queueRef.current.shift();
    if (!chunk) { setS("idle"); return; }

    const runtime = getTTSRuntime();
    let response;
    try {
      response = await base44.functions.invoke("openaiTTS", {
        text: prepareTTSInput(chunk),
        voice: "nova",
        model: runtime.model,
        speed: runtime.speed,
        instructions: runtime.supportsInstructions ? buildTTSInstructions(runtime.instructions, previousChunkRef.current) : "",
        format: runtime.format,
      });
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

    const url = URL.createObjectURL(new Blob([buffer], { type: getTTSMime(response.data?.format || runtime.format) }));
    const audio = new Audio(url);
    audio.preload = "auto";
    audio.onended = () => {
      URL.revokeObjectURL(url);
      sourceRef.current = null;
      previousChunkRef.current = chunk;
      playNextChunk();
    };
    audio.onerror = () => {
      URL.revokeObjectURL(url);
      sourceRef.current = null;
      stop();
    };
    sourceRef.current = { audio, url };
    await audio.play();
  };

  const handlePress = async () => {
    if (state === "playing") {
      try { sourceRef.current?.audio?.pause(); } catch {}
      setS("paused");
      return;
    }
    if (state === "paused") {
      setS("playing");
      if (sourceRef.current?.audio) {
        await sourceRef.current.audio.play();
      } else {
        playNextChunk();
      }
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
