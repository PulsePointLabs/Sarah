import { useCallback, useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import { Send, ChevronDown, ChevronUp, Save, RefreshCw, Mic, MicOff, Volume2, VolumeX, Copy, Check, Maximize2, Minimize2, Paperclip, X, Image as ImageIcon, Film } from "lucide-react";
import { Button } from "@/components/ui/button";
import { base44 } from "@/api/base44Client";
import { cleanTextForSpeech, getTTSMime, getTTSRuntime, prepareTTSInput, splitIntoChunks, TTS_CHUNK_TARGET_CHARS, TTS_PLAYBACK_FORMAT } from "@/components/TTSButton";
import { ANATOMICAL_REFERENCE_FOCUS_RULE, buildAIGroundingContext } from "@/lib/aiGrounding";
import { extractVisualMediaContextFromConversation } from "@/lib/visualEvidence";
import { serverUrl } from "@/lib/mobileApiBase";
import { cleanWhisperTranscript } from "@/utils/whisperTranscript";
import { SarahAvatar } from "@/components/SarahBrand";

const PROFILE_CATEGORIES = [
  { key: "physical", label: "Physical Baseline", emoji: "🫀", hint: "Body metrics, fitness, resting HR, medications" },
  { key: "arousal", label: "Arousal Profile", emoji: "📈", hint: "Build style, speed to climax, plateau patterns" },
  { key: "stimulation", label: "Stimulation Methods", emoji: "⚡", hint: "What works best, technique nuances, edging habits" },
  { key: "anatomical", label: "Anatomical Sensitivity", emoji: "🧬", hint: "Nerve sensitivity, pelvic floor, pressure responses" },
  { key: "climax", label: "Climax & Recovery", emoji: "🎯", hint: "Climax intensity, duration, refractory period" },
  { key: "contextual", label: "Contextual Factors", emoji: "🌡️", hint: "Mood, hydration, substances, time of day effects" },
];

const SESSION_CATEGORIES = [
  { key: "sensations", label: "Sensations", emoji: "✋", hint: "What you felt physically during this session" },
  { key: "stimulation", label: "Stimulation Details", emoji: "⚡", hint: "Settings, technique, pauses, adjustments made" },
  { key: "buildup", label: "Build & Edging", emoji: "📈", hint: "How arousal escalated, near-misses, control" },
  { key: "climax", label: "Climax Experience", emoji: "🎯", hint: "Intensity, duration, contractions, ejaculate" },
  { key: "discomfort", label: "Discomfort / Issues", emoji: "⚠️", hint: "Pain, pressure, anything unusual or unexpected" },
  { key: "recovery", label: "Recovery & Aftermath", emoji: "🔄", hint: "Post-climax feelings, refractory, residual sensations" },
];

const PROFILE_MECHANICAL_RULE = `STRUCTURED ANATOMICAL / FUNCTIONAL PROFILE RULE: If populated profile fields provide erect dimensions, glans or foreskin context, meatal or urethral dimensions, accommodation or device-fit observations, or functional response observations, you may use them to deepen A&P interpretation of the person's reported findings when analytically relevant. Connect dimensions to supported stimulation mechanics, fit, pressure distribution, sensitivity, device interaction, or repeated response patterns only when the available findings support that link. Do not force mention of measurements, and do not turn dimensional data into unsupported causal claims.`;
const ALLOWED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"];
const ALLOWED_VIDEO_TYPES = ["video/mp4", "video/webm", "video/quicktime", "video/x-matroska"];
const ALLOWED_VIDEO_EXTENSIONS = [".mp4", ".webm", ".mov", ".mkv"];
const MAX_IMAGE_COUNT = 5;
const MAX_IMAGE_SIZE_BYTES = 8 * 1024 * 1024;
const VIDEO_FRAME_SAMPLE_COUNT = 12;
const TTS_CACHE_DB_NAME = "pulsepoint-ai-chat-tts";
const TTS_CACHE_DB_VERSION = 1;
const TTS_CACHE_STORE_NAME = "audioChunks";
const VOICE_AUTO_STOP_ENABLED = false;

function extractProviderErrorMessage(error) {
  const candidates = [
    error?.data?.error,
    error?.data?.message,
    error?.message,
  ].filter(Boolean);

  for (const candidate of candidates) {
    const raw = typeof candidate === "string" ? candidate : JSON.stringify(candidate);
    try {
      const parsed = JSON.parse(raw);
      const nested = parsed?.error?.message || parsed?.message || parsed?.error;
      if (nested) return String(nested);
    } catch {
      // Not JSON; use the raw provider message below.
    }
    if (raw) return raw;
  }
  return "";
}

function friendlyWhisperError(error) {
  const message = extractProviderErrorMessage(error) || "Whisper transcription failed.";
  if (/Invalid URL\s+\(POST\s+\/v1\/audio\/transcriptions\)/i.test(message)) {
    return "Whisper is using a stale transcription route. Restart the local Sarah API or rebuild/reopen the Android app, then try the mic again.";
  }
  if (/Missing OPENAI_API_KEY/i.test(message)) {
    return "Whisper needs OPENAI_API_KEY in the local API environment.";
  }
  if (/invalid file format/i.test(message)) {
    return "Whisper received the recording but could not read the audio format. Try recording again; Sarah now normalizes Android recorder formats before sending them.";
  }
  return message;
}

function friendlySarahError(error) {
  const message = extractProviderErrorMessage(error) || "Sarah response failed.";
  if (/credit balance is too low|plans\s*&\s*billing|purchase credits|anthropic api/i.test(message)) {
    return "Sarah could not answer because Anthropic says the API credit balance is too low. Add credits in Anthropic Plans & Billing, then try again.";
  }
  return message;
}

function makeId(prefix) {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function hashText(value) {
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

async function getStoredTtsAudio(key) {
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

async function putStoredTtsAudio(record) {
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

function audioBase64ToObjectUrl(audio, mimeType) {
  const binary = atob(audio);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes.buffer], { type: mimeType }));
}

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ""));
    reader.onerror = () => reject(reader.error || new Error("Unable to read image."));
    reader.readAsDataURL(file);
  });
}

function dataUrlToFile(dataUrl, filename, mimeType = "image/jpeg") {
  const binary = atob(stripDataUrl(dataUrl));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], filename, { type: mimeType });
}

function loadVideoMetadata(file, existingUrl) {
  return new Promise((resolve) => {
    const url = existingUrl || URL.createObjectURL(file);
    const shouldRevoke = !existingUrl;
    const video = document.createElement("video");
    video.preload = "metadata";
    video.muted = true;
    video.playsInline = true;
    video.onloadedmetadata = () => {
      const duration = Number.isFinite(video.duration) ? video.duration : 0;
      if (shouldRevoke) URL.revokeObjectURL(url);
      resolve(duration);
    };
    video.onerror = () => {
      if (shouldRevoke) URL.revokeObjectURL(url);
      resolve(0);
    };
    video.src = url;
  });
}

function seekVideo(video, time) {
  return new Promise((resolve, reject) => {
    const cleanup = () => {
      video.removeEventListener("seeked", handleSeeked);
      video.removeEventListener("error", handleError);
    };
    const handleSeeked = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error("Could not sample this video clip."));
    };
    video.addEventListener("seeked", handleSeeked);
    video.addEventListener("error", handleError);
    video.currentTime = time;
  });
}

async function sampleVideoFrames({ file, startSeconds, endSeconds, label, maxFrames = VIDEO_FRAME_SAMPLE_COUNT }) {
  const url = URL.createObjectURL(file);
  const video = document.createElement("video");
  video.preload = "auto";
  video.muted = true;
  video.playsInline = true;
  video.crossOrigin = "anonymous";
  const loaded = new Promise((resolve, reject) => {
    video.onloadedmetadata = resolve;
    video.onerror = () => reject(new Error("Could not load this video clip."));
  });
  video.src = url;
  await loaded;

  const duration = Number.isFinite(video.duration) ? video.duration : 0;
  const start = Math.max(0, Math.min(Number(startSeconds) || 0, duration));
  const end = Math.max(start + 0.25, Math.min(Number(endSeconds) || duration || start + 1, duration || start + 1));
  const frameCount = Math.max(1, Math.min(maxFrames, VIDEO_FRAME_SAMPLE_COUNT));
  const width = Math.min(960, video.videoWidth || 960);
  const height = Math.max(1, Math.round(width * ((video.videoHeight || 540) / (video.videoWidth || 960))));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  const frames = [];

  for (let index = 0; index < frameCount; index += 1) {
    const ratio = frameCount === 1 ? 0 : index / (frameCount - 1);
    const time = start + (end - start) * ratio;
    await seekVideo(video, Math.max(0, Math.min(time, duration || time)));
    ctx.drawImage(video, 0, 0, width, height);
    const dataUrl = canvas.toDataURL("image/jpeg", 0.82);
    const filename = `${String(label || file.name || "video-clip").replace(/[^a-z0-9_-]+/gi, "-").slice(0, 52)}-frame-${index + 1}.jpg`;
    frames.push({
      dataUrl,
      filename,
      file: dataUrlToFile(dataUrl, filename, "image/jpeg"),
      time,
    });
  }

  URL.revokeObjectURL(url);
  return frames;
}

function stripDataUrl(dataUrl) {
  return String(dataUrl || "").replace(/^data:[^;]+;base64,/, "");
}

function formatSeconds(value) {
  const seconds = Math.max(0, Number(value) || 0);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds - minutes * 60;
  return minutes ? `${minutes}:${remainder.toFixed(1).padStart(4, "0")}` : `${remainder.toFixed(1)}s`;
}

function formatTimePhrase(value) {
  const total = Math.max(0, Number(value) || 0);
  const minutes = Math.floor(total / 60);
  const seconds = Math.round((total - minutes * 60) * 10) / 10;
  const secondsText = seconds % 1 === 0 ? String(Math.round(seconds)) : seconds.toFixed(1);
  if (!minutes) return `${secondsText} second${seconds === 1 ? "" : "s"}`;
  if (!seconds) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  return `${minutes} minute${minutes === 1 ? "" : "s"} and ${secondsText} second${seconds === 1 ? "" : "s"}`;
}

function isAllowedVideoFile(file) {
  const name = String(file?.name || "").toLowerCase();
  return ALLOWED_VIDEO_TYPES.includes(file?.type) || ALLOWED_VIDEO_EXTENSIONS.some((extension) => name.endsWith(extension));
}

function normalizeAIImageResult(result) {
  if (typeof result === "string") return { chatResponse: result, findings: [], limitations: [], followUpQuestions: [] };
  return {
    chatResponse: String(result?.chatResponse || result?.response || "").trim(),
    findings: Array.isArray(result?.findings) ? result.findings : [],
    limitations: Array.isArray(result?.limitations) ? result.limitations : [],
    followUpQuestions: Array.isArray(result?.followUpQuestions) ? result.followUpQuestions : [],
  };
}

function findingTextToBullet(finding, options = {}) {
  const title = finding?.title ? `${finding.title}: ` : "";
  const text = finding?.findingText || finding?.text || "";
  const confirmation = finding?.needsUserConfirmation || options.reviewCandidate ? ", review suggested" : "";
  const confidence = finding?.confidence ? ` (${finding.confidence} confidence${confirmation})` : options.reviewCandidate ? " (review suggested)" : "";
  return text ? `• ${title}${text}${confidence}` : "";
}

function findingsToBullets(findings = [], targetMode = "profile") {
  return findings
    .filter((finding) => {
      const persistTo = finding?.persistTo || "none";
      return persistTo === targetMode || persistTo === "both";
    })
    .map((finding) => findingTextToBullet(finding))
    .filter(Boolean)
    .join("\n");
}

function reviewCandidateBullets(findings = []) {
  return findings
    .filter((finding) => finding?.findingText || finding?.text)
    .map((finding) => findingTextToBullet({ ...finding, needsUserConfirmation: true }, { reviewCandidate: true }))
    .filter(Boolean)
    .join("\n");
}

function MessageMarkdown({ text }) {
  return (
    <ReactMarkdown
      className="space-y-2 text-[0.95rem] leading-7"
      components={{
        p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
        strong: ({ children }) => <strong className="font-semibold text-inherit">{children}</strong>,
        em: ({ children }) => <em className="italic text-inherit">{children}</em>,
        ul: ({ children }) => <ul className="my-2 list-disc space-y-1.5 pl-5">{children}</ul>,
        ol: ({ children }) => <ol className="my-2 list-decimal space-y-1.5 pl-5">{children}</ol>,
        li: ({ children }) => <li className="pl-0.5">{children}</li>,
        code: ({ children }) => <code className="rounded bg-black/15 px-1 py-0.5 text-[0.92em]">{children}</code>,
      }}
    >
      {String(text || "")}
    </ReactMarkdown>
  );
}

export default function AIChat({
  mode = "session",
  context,
  userProfile,
  savedMessages,
  savedNotes,
  latestSavedFinding,
  recentSavedFindings,
  scopeId,
  defaultOpen = false,
  visualEvidenceScope = mode,
  subjectLabel,
  clipTimelineOffsetSeconds = 0,
  savedVideoClips = [],
  onSaveMessages,
  onSaveNotes,
}) {
  const [copiedIndex, setCopiedIndex] = useState(null);
  const [open, setOpen] = useState(defaultOpen);
  const [fullScreen, setFullScreen] = useState(false);
  const [messages, setMessages] = useState(savedMessages || []);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const [savingFindings, setSavingFindings] = useState(false);
  const [savedFeedback, setSavedFeedback] = useState(false);
  const [recording, setRecording] = useState(false);
  const [transcribing, setTranscribing] = useState(false);
  const [ttsEnabled, setTtsEnabled] = useState(true);
  const [speakingIdx, setSpeakingIdx] = useState(null);
  const [ttsStatus, setTtsStatus] = useState(null);
  const [ttsElapsedSeconds, setTtsElapsedSeconds] = useState(0);
  const [selectedImages, setSelectedImages] = useState([]);
  const [selectedVideoClip, setSelectedVideoClip] = useState(null);
  const [videoPreviewSize, setVideoPreviewSize] = useState("large");
  const [videoPlayheadSeconds, setVideoPlayheadSeconds] = useState(0);
  const [processingVideoClip, setProcessingVideoClip] = useState(false);
  const [chatProcessingStatus, setChatProcessingStatus] = useState(null);
  const [imageError, setImageError] = useState("");
  const [uploadingImages, setUploadingImages] = useState(false);
  const bottomRef = useRef(null);
  const messageRefs = useRef(new Map());
  const inputRef = useRef(null);
  const imageInputRef = useRef(null);
  const videoInputRef = useRef(null);
  const videoPreviewRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const micStreamRef = useRef(null);
  const speechDetectedRef = useRef(false);
  const silenceStartRef = useRef(null);
  const suppressNextTranscriptionRef = useRef(false);
  const vadFrameRef = useRef(null);
  const audioContextRef = useRef(null);
  const audioRef = useRef(null);
  const audioUrlCacheRef = useRef(new Map());
  const ttsRequestIdRef = useRef(0);
  const lastAssistantScrollKeyRef = useRef("");

  const categories = mode === "profile" ? PROFILE_CATEGORIES : SESSION_CATEGORIES;
  const evidenceScope = ["profile", "session", "body_exploration"].includes(visualEvidenceScope) ? visualEvidenceScope : mode;
  const conversationSubject = subjectLabel || (mode === "profile" ? "physiological and arousal profile" : "session");
  const timelineOffsetSeconds = Number(clipTimelineOffsetSeconds) || 0;

  useEffect(() => {
    setMessages(savedMessages || []);
  }, [savedMessages]);

  const isMobileViewport = useCallback(() => (
    typeof window !== "undefined" && window.matchMedia?.("(max-width: 640px)")?.matches
  ), []);

  const scrollToBottom = useCallback((behavior = "smooth") => {
    requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ behavior, block: "end" }));
  }, []);

  useEffect(() => {
    const lastIndex = messages.length - 1;
    const lastMessage = messages[lastIndex];
    const assistantScrollKey = lastMessage?.role === "assistant"
      ? `${lastIndex}:${lastMessage.text?.length || 0}`
      : "";

    if (
      !loading
      && assistantScrollKey
      && assistantScrollKey !== lastAssistantScrollKeyRef.current
      && isMobileViewport()
    ) {
      lastAssistantScrollKeyRef.current = assistantScrollKey;
      requestAnimationFrame(() => {
        messageRefs.current.get(lastIndex)?.scrollIntoView({ behavior: "smooth", block: "start", inline: "nearest" });
      });
      return;
    }

    if (assistantScrollKey) lastAssistantScrollKeyRef.current = assistantScrollKey;
    scrollToBottom("smooth");
  }, [messages, loading, isMobileViewport, scrollToBottom]);

  useEffect(() => {
    if (open || fullScreen) scrollToBottom("auto");
  }, [open, fullScreen, scrollToBottom]);

  useEffect(() => () => {
    audioUrlCacheRef.current.forEach((url) => URL.revokeObjectURL(url));
    audioUrlCacheRef.current.clear();
    if (vadFrameRef.current) cancelAnimationFrame(vadFrameRef.current);
    micStreamRef.current?.getTracks().forEach((track) => track.stop());
    audioContextRef.current?.close?.();
  }, []);

  useEffect(() => () => {
    if (selectedVideoClip?.previewUrl) URL.revokeObjectURL(selectedVideoClip.previewUrl);
  }, [selectedVideoClip?.previewUrl]);

  useEffect(() => {
    if (!ttsStatus || !["preparing", "fetching"].includes(ttsStatus.phase)) {
      setTtsElapsedSeconds(0);
      return undefined;
    }
    setTtsElapsedSeconds(Math.max(0, Math.floor((Date.now() - ttsStatus.startedAt) / 1000)));
    const timer = window.setInterval(() => {
      setTtsElapsedSeconds(Math.max(0, Math.floor((Date.now() - ttsStatus.startedAt) / 1000)));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [ttsStatus]);

  useEffect(() => {
    if (!fullScreen) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event) => {
      if (event.key === "Escape") setFullScreen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [fullScreen]);

  const setCurrentTtsStatus = (requestId, status) => {
    if (requestId !== ttsRequestIdRef.current) return;
    setTtsStatus(status);
  };

  const playAudioUrl = (src, idx, requestId = ttsRequestIdRef.current, options = {}) => new Promise((resolve, reject) => {
    const {
      fromCache = false,
      chunkIndex = 0,
      totalChunks = 1,
      finalChunk = true,
    } = options;
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    const el = new Audio(src);
    audioRef.current = el;
    const suffix = totalChunks > 1 ? ` (${chunkIndex + 1}/${totalChunks})` : "";
    const cleanup = () => {
      if (audioRef.current === el) audioRef.current = null;
      setSpeakingIdx(null);
      if (requestId === ttsRequestIdRef.current && finalChunk) {
        setTtsStatus({ idx, phase: "complete", message: "Playback complete", startedAt: Date.now() });
        window.setTimeout(() => {
          if (requestId === ttsRequestIdRef.current) setTtsStatus(null);
        }, 1600);
      }
      resolve();
    };
    el.onended = cleanup;
    el.onerror = () => {
      if (audioRef.current === el) audioRef.current = null;
      setSpeakingIdx(null);
      const error = new Error("Audio playback failed");
      setCurrentTtsStatus(requestId, { idx, phase: "error", message: error.message, startedAt: Date.now() });
      reject(error);
    };
    setSpeakingIdx(idx);
    setCurrentTtsStatus(requestId, {
      idx,
      phase: "playing",
      message: `${fromCache ? "Playing cached audio" : "Playing"}${suffix}`,
      startedAt: Date.now(),
    });
    el.play().catch((error) => {
      setSpeakingIdx(null);
      setCurrentTtsStatus(requestId, {
        idx,
        phase: "error",
        message: error?.message || "Audio playback was blocked",
        startedAt: Date.now(),
      });
      reject(error);
    });
  });

  const speakText = async (text, idx) => {
    if (!ttsEnabled) return;
    releaseVoiceCaptureForPlayback();
    const requestId = ttsRequestIdRef.current + 1;
    ttsRequestIdRef.current = requestId;
    setSpeakingIdx(null);
    setTtsStatus({ idx, phase: "preparing", message: "Preparing TTS request", startedAt: Date.now() });
    try {
      const cleanedText = cleanTextForSpeech(text);
      const chunks = splitIntoChunks(cleanedText, TTS_CHUNK_TARGET_CHARS).filter((chunk) => chunk.trim());
      if (!chunks.length) {
        setCurrentTtsStatus(requestId, { idx, phase: "error", message: "Nothing to read", startedAt: Date.now() });
        return;
      }
      const runtime = getTTSRuntime();
      const fetchPromises = new Map();
      const runtimeSignature = [
        runtime.cacheProfile,
        runtime.model,
        runtime.format,
        runtime.speed,
        hashText(runtime.supportsInstructions ? runtime.instructions : ""),
      ].join(":");
      const cacheKeyForChunk = (chunk) => `${runtimeSignature}:${chunk.length}:${hashText(chunk)}`;
      const fetchChunkAudio = async (chunkIndex, { showStatus = false } = {}) => {
        const chunk = chunks[chunkIndex];
        const cacheKey = cacheKeyForChunk(chunk);
        const cached = audioUrlCacheRef.current.get(cacheKey);
        if (cached) {
          if (showStatus) {
            setCurrentTtsStatus(requestId, {
              idx,
              phase: "cached",
              message: chunks.length > 1 ? `Using cached audio chunk ${chunkIndex + 1}/${chunks.length}` : "Using cached audio",
              startedAt: Date.now(),
            });
          }
          return { src: cached, fromCache: true };
        }
        const stored = await getStoredTtsAudio(cacheKey);
        if (stored?.audio && stored?.text === chunk) {
          const src = audioBase64ToObjectUrl(stored.audio, stored.mimeType || getTTSMime(stored.format || runtime.format || TTS_PLAYBACK_FORMAT));
          audioUrlCacheRef.current.set(cacheKey, src);
          if (showStatus) {
            setCurrentTtsStatus(requestId, {
              idx,
              phase: "cached",
              message: chunks.length > 1 ? `Using saved audio chunk ${chunkIndex + 1}/${chunks.length}` : "Using saved audio",
              startedAt: Date.now(),
            });
          }
          return { src, fromCache: true };
        }
        if (fetchPromises.has(chunkIndex)) return fetchPromises.get(chunkIndex);
        const promise = (async () => {
          if (showStatus) {
            setCurrentTtsStatus(requestId, {
              idx,
              phase: "fetching",
              message: chunks.length > 1 ? `Fetching Sarah audio chunk ${chunkIndex + 1}/${chunks.length}` : "Fetching Sarah audio",
              startedAt: Date.now(),
            });
          }
          const res = await base44.functions.invoke("openaiTTS", {
            text: prepareTTSInput(chunk),
            voice: "nova",
            model: runtime.model,
            speed: runtime.speed,
            instructions: runtime.supportsInstructions ? runtime.instructions : "",
            format: runtime.format,
          });
          const audio = res.data?.audio;
          if (!audio) throw new Error(res.data?.error || "TTS returned no audio");
          const format = res.data?.format || runtime.format || TTS_PLAYBACK_FORMAT;
          const mimeType = getTTSMime(format);
          const src = audioBase64ToObjectUrl(audio, mimeType);
          audioUrlCacheRef.current.set(cacheKey, src);
          putStoredTtsAudio({
            key: cacheKey,
            text: chunk,
            audio,
            format,
            mimeType,
            voice: "nova",
            model: runtime.model,
            speed: runtime.speed,
            createdAt: Date.now(),
          }).catch(() => {});
          return { src, fromCache: false };
        })().finally(() => {
          fetchPromises.delete(chunkIndex);
        });
        fetchPromises.set(chunkIndex, promise);
        return promise;
      };

      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex += 1) {
        if (requestId !== ttsRequestIdRef.current) return;
        if (chunkIndex + 1 < chunks.length && !fetchPromises.has(chunkIndex + 1) && !audioUrlCacheRef.current.get(cacheKeyForChunk(chunks[chunkIndex + 1]))) {
          fetchChunkAudio(chunkIndex + 1, { showStatus: false }).catch(() => {});
        }
        const { src, fromCache } = await fetchChunkAudio(chunkIndex, { showStatus: true });
        if (requestId !== ttsRequestIdRef.current) return;
        if (chunkIndex + 1 < chunks.length && !fetchPromises.has(chunkIndex + 1) && !audioUrlCacheRef.current.get(cacheKeyForChunk(chunks[chunkIndex + 1]))) {
          fetchChunkAudio(chunkIndex + 1, { showStatus: false }).catch(() => {});
        }
        setCurrentTtsStatus(requestId, {
          idx,
          phase: "ready",
          message: chunks.length > 1 ? `Audio chunk ${chunkIndex + 1}/${chunks.length} ready` : "Audio ready, starting playback",
          startedAt: Date.now(),
        });
        await playAudioUrl(src, idx, requestId, {
          fromCache,
          chunkIndex,
          totalChunks: chunks.length,
          finalChunk: chunkIndex === chunks.length - 1,
        });
      }
    } catch (error) {
      setSpeakingIdx(null);
      setCurrentTtsStatus(requestId, {
        idx,
        phase: "error",
        message: error?.data?.error || error?.message || "TTS request failed",
        startedAt: Date.now(),
      });
    }
  };

  const toggleSpeechForMessage = (text, idx) => {
    if (audioRef.current && ttsStatus?.idx === idx) {
      if (audioRef.current.paused) {
        audioRef.current.play().then(() => {
          setSpeakingIdx(idx);
          setTtsStatus((status) => status?.idx === idx ? {
            ...status,
            phase: "playing",
            message: status.message?.startsWith("Paused") ? "Playing" : status.message,
            startedAt: Date.now(),
          } : status);
        }).catch((error) => {
          setSpeakingIdx(null);
          setTtsStatus({ idx, phase: "error", message: error?.message || "Audio playback was blocked", startedAt: Date.now() });
        });
        return;
      }

      audioRef.current.pause();
      setSpeakingIdx(idx);
      setTtsStatus((status) => status?.idx === idx ? {
        ...status,
        phase: "paused",
        message: "Paused. Tap this response to resume.",
        startedAt: Date.now(),
      } : status);
      return;
    }

    speakText(text, idx);
  };

  const stopSpeaking = () => {
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current = null;
    }
    ttsRequestIdRef.current += 1;
    setSpeakingIdx(null);
    setTtsStatus(null);
  };

  const clearAudioCache = () => {
    stopSpeaking();
    audioUrlCacheRef.current.forEach((url) => URL.revokeObjectURL(url));
    audioUrlCacheRef.current.clear();
  };

  const handleImageFiles = async (files) => {
    const incoming = Array.from(files || []);
    if (!incoming.length) return;
    setImageError("");
    const slots = MAX_IMAGE_COUNT - selectedImages.length;
    if (slots <= 0) {
      setImageError(`Attach up to ${MAX_IMAGE_COUNT} images per message.`);
      return;
    }
    const accepted = [];
    for (const file of incoming.slice(0, slots)) {
      if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
        setImageError("Images must be JPG, PNG, or WebP.");
        continue;
      }
      if (file.size > MAX_IMAGE_SIZE_BYTES) {
        setImageError("Each image must be 8 MB or smaller.");
        continue;
      }
      const dataUrl = await fileToDataUrl(file);
      accepted.push({
        id: makeId("pending-image"),
        file,
        filename: file.name,
        mimeType: file.type,
        sizeBytes: file.size,
        previewUrl: dataUrl,
        createdAt: new Date().toISOString(),
      });
    }
    setSelectedImages((prev) => [...prev, ...accepted].slice(0, MAX_IMAGE_COUNT));
    if (imageInputRef.current) imageInputRef.current.value = "";
  };

  const removeSelectedImage = (id) => {
    setSelectedImages((prev) => prev.filter((image) => image.id !== id));
  };

  const attachSavedVideoClipFrames = async (clip) => {
    const frames = Array.isArray(clip?.frames) ? clip.frames : [];
    if (!frames.length) {
      setImageError("This saved clip can be referenced in context, but it does not have sampled frames yet. Regenerate Session Analysis or Technical Deep Dive once to refresh it.");
      return;
    }
    const slots = MAX_IMAGE_COUNT - selectedImages.length;
    if (slots <= 0) {
      setImageError(`Attach up to ${MAX_IMAGE_COUNT} images per message.`);
      return;
    }
    const usableFrames = frames.filter((frame) => frame?.data || frame?.file_url || frame?.url).slice(0, slots);
    const accepted = [];
    setProcessingVideoClip(true);
    try {
      for (let index = 0; index < usableFrames.length; index += 1) {
        const frame = usableFrames[index];
        const frameUrl = frame.file_url || frame.url || "";
        let base64Data = frame.data || "";
        let previewUrl = frameUrl ? serverUrl(frameUrl) : `data:${frame.mimeType || "image/jpeg"};base64,${frame.data}`;
        if (!base64Data && previewUrl) {
          const response = await fetch(previewUrl);
          if (!response.ok) throw new Error("Could not load saved clip frame.");
          const dataUrl = await fileToDataUrl(await response.blob());
          base64Data = stripDataUrl(dataUrl);
          previewUrl = dataUrl;
        }
        const frameTimeSeconds = Number(frame.frameTimeSeconds);
        accepted.push({
          id: makeId("saved-clip-frame"),
          filename: frame.filename || `${clip.label || "saved-clip"}-frame-${index + 1}.jpg`,
          mimeType: frame.mimeType || "image/jpeg",
          sizeBytes: frame.sizeBytes || 0,
          storagePath: frameUrl,
          previewUrl,
          base64Data,
          createdAt: new Date().toISOString(),
          sourceVideo: {
            filename: clip.filename || clip.source_video_label || "saved key clip",
            label: clip.label || "Saved key video moment",
            startSeconds: clip.startSeconds ?? 0,
            endSeconds: clip.endSeconds ?? clip.durationSeconds ?? 0,
            frameTimeSeconds: Number.isFinite(frameTimeSeconds) ? frameTimeSeconds : null,
            timelineStartSeconds: clip.session_time_s != null && clip.durationSeconds != null
              ? Math.max(0, Number(clip.session_time_s) - Number(clip.durationSeconds) / 2)
              : clip.session_time_s,
            timelineEndSeconds: clip.session_time_s != null && clip.durationSeconds != null
              ? Number(clip.session_time_s) + Number(clip.durationSeconds) / 2
              : clip.session_time_s,
            frameTimelineSeconds: Number.isFinite(frameTimeSeconds)
              ? Number((frameTimeSeconds - Number(clip.timeline_offset_s || 0)).toFixed(2))
              : clip.session_time_s,
            timelineLabel: "saved session key clip",
            frameIndex: frame.frameIndex || index + 1,
            processedClipUrl: serverUrl(clip.clip_url || clip.url || clip.file_url || ""),
            motionSummary: clip.motion_summary || null,
          },
        });
      }
    } catch (error) {
      setImageError(error?.message || "Could not attach saved clip frames.");
      return;
    } finally {
      setProcessingVideoClip(false);
    }
    if (!accepted.length) {
      setImageError("This saved clip did not expose usable sampled frames.");
      return;
    }
    setSelectedImages((prev) => [...prev, ...accepted].slice(0, MAX_IMAGE_COUNT));
    setImageError("");
    const clipPrompt = `Please review the saved key clip "${clip.label || "session moment"}"${clip.session_time_s != null ? ` at ${formatTimePhrase(clip.session_time_s)}` : ""}. Focus on visible technique, grip, movement cadence, and body response.`;
    setInput((current) => current.trim() ? current : clipPrompt);
  };

  const seekVideoPreview = (seconds) => {
    const next = Math.max(0, Number(seconds) || 0);
    setVideoPlayheadSeconds(next);
    if (videoPreviewRef.current && Number.isFinite(videoPreviewRef.current.duration)) {
      videoPreviewRef.current.currentTime = Math.min(next, videoPreviewRef.current.duration);
    }
  };

  const markVideoBoundary = (boundary) => {
    if (!selectedVideoClip) return;
    const current = Number.isFinite(videoPreviewRef.current?.currentTime)
      ? videoPreviewRef.current.currentTime
      : videoPlayheadSeconds;
    updateSelectedVideoClip((clip) => {
      const duration = clip.duration || Math.max(clip.endSeconds || 0, current + 0.3);
      if (boundary === "start") {
        const startSeconds = Math.max(0, Math.min(current, Math.max(0, duration - 0.3)));
        return { ...clip, startSeconds, endSeconds: Math.max(startSeconds + 0.3, clip.endSeconds) };
      }
      const endSeconds = Math.min(Math.max(clip.startSeconds + 0.3, current), duration);
      return { ...clip, endSeconds };
    });
  };

  const handleVideoFile = async (files) => {
    const file = Array.from(files || [])[0];
    if (!file) return;
    setImageError("");
    if (!isAllowedVideoFile(file)) {
      setImageError("Video clips must be MP4, WebM, MOV, or MKV.");
      return;
    }
    try {
      const previewUrl = URL.createObjectURL(file);
      const duration = await loadVideoMetadata(file, previewUrl);
      const defaultEnd = Math.min(12, Math.max(1, duration || 12));
      setSelectedVideoClip({
        id: makeId("pending-video"),
        file,
        filename: file.name,
        sizeBytes: file.size,
        previewUrl,
        duration,
        startSeconds: 0,
        endSeconds: defaultEnd,
        label: "",
        processedClip: null,
        processingStatus: "",
      });
      setVideoPlayheadSeconds(0);
    } catch (error) {
      setImageError(error.message || "Could not inspect this video.");
    } finally {
      if (videoInputRef.current) videoInputRef.current.value = "";
    }
  };

  const updateSelectedVideoClip = (updater, options = {}) => {
    setSelectedVideoClip((clip) => {
      if (!clip) return clip;
      const next = typeof updater === "function" ? updater(clip) : { ...clip, ...updater };
      if (options.keepProcessed) return next;
      return { ...next, processedClip: null, processingStatus: "" };
    });
  };

  const processSelectedVideoClip = async () => {
    if (!selectedVideoClip) return null;
    const slots = VIDEO_FRAME_SAMPLE_COUNT;
    if (slots <= 0) {
      setImageError("No video frame slots are available.");
      return null;
    }
    const label = selectedVideoClip.label?.trim() || selectedVideoClip.filename || "video technique example";
    setProcessingVideoClip(true);
    setChatProcessingStatus({
      phase: "processing",
      message: "Preparing local video clip",
      detail: `Building a short review clip from ${formatTimePhrase(selectedVideoClip.startSeconds)} to ${formatTimePhrase(selectedVideoClip.endSeconds)}.`,
    });
    updateSelectedVideoClip({ processingStatus: "Processing clip with local FFmpeg..." }, { keepProcessed: true });
    try {
      const processed = await base44.integrations.Core.ProcessVideoClip({
        file: selectedVideoClip.file,
        startSeconds: selectedVideoClip.startSeconds,
        endSeconds: selectedVideoClip.endSeconds,
        label,
        frameCount: Math.min(slots, VIDEO_FRAME_SAMPLE_COUNT),
      });
      updateSelectedVideoClip({
        processedClip: processed,
        processingStatus: "MP4 preview ready. Raw source was discarded after processing.",
      }, { keepProcessed: true });
      setChatProcessingStatus({
        phase: "ready",
        message: "Video preview ready",
        detail: "Sarah will receive sampled frames plus local motion timing from this clip.",
      });
      return processed;
    } catch (error) {
      const message = error?.status === 404
        ? "Video processing endpoint is not available yet. Restart the local API server, then try Generate MP4 Preview again."
        : error?.message || "Could not process this video clip.";
      updateSelectedVideoClip({ processingStatus: message }, { keepProcessed: true });
      setChatProcessingStatus({ phase: "error", message: "Video clip processing failed", detail: message });
      setImageError(message);
      return null;
    } finally {
      setProcessingVideoClip(false);
    }
  };

  const sendSelectedVideoClipForReview = () => {
    if (!selectedVideoClip || processingVideoClip) return;
    const caption = selectedVideoClip.label?.trim();
    const fallback = caption
      ? `Please review this video clip: ${caption}`
      : "Please review this video clip.";
    sendMessage(input.trim() || fallback);
  };

  const resetVideoClipForNextRange = () => {
    if (!selectedVideoClip) return;
    const current = selectedVideoClip.processedClip
      ? selectedVideoClip.endSeconds
      : Number.isFinite(videoPreviewRef.current?.currentTime) ? videoPreviewRef.current.currentTime : videoPlayheadSeconds;
    const duration = selectedVideoClip.duration || Math.max(selectedVideoClip.endSeconds || 0, current + 12);
    const startSeconds = Math.max(0, Math.min(Number(current) || 0, Math.max(0, duration - 0.3)));
    const endSeconds = Math.min(duration, Math.max(startSeconds + 0.3, startSeconds + Math.min(12, Math.max(0.3, duration - startSeconds))));
    updateSelectedVideoClip((clip) => ({
      ...clip,
      startSeconds,
      endSeconds,
      processedClip: null,
      processingStatus: "Ready for another clip from the same source video.",
    }), { keepProcessed: true });
    window.setTimeout(() => seekVideoPreview(startSeconds), 0);
  };

  const materializeVideoClipFrames = async () => {
    if (!selectedVideoClip) return [];
    const slots = VIDEO_FRAME_SAMPLE_COUNT;
    if (slots <= 0) {
      setImageError("No video frame slots are available.");
      return [];
    }
    setProcessingVideoClip(true);
    try {
      const label = selectedVideoClip.label?.trim() || selectedVideoClip.filename || "video technique example";
      const processed = selectedVideoClip.processedClip || await processSelectedVideoClip();
      const timelineStartSeconds = selectedVideoClip.startSeconds + timelineOffsetSeconds;
      const timelineEndSeconds = selectedVideoClip.endSeconds + timelineOffsetSeconds;
      const timelineLabel = evidenceScope === "body_exploration" ? "body exploration timeline" : evidenceScope === "session" ? "session timeline" : "source video timeline";
      if (processed?.frames?.length) {
        setChatProcessingStatus({
          phase: "sampling",
          message: "Extracting video evidence",
          detail: `Using ${processed.frames.length} sampled frames from ${formatTimePhrase(selectedVideoClip.startSeconds)} to ${formatTimePhrase(selectedVideoClip.endSeconds)}.`,
        });
        return processed.frames.slice(0, slots).map((frame, index) => {
          const frameTimeSeconds = Number(frame.frameTimeSeconds ?? selectedVideoClip.startSeconds);
          const dataUrl = frame.data ? `data:${frame.mimeType || "image/jpeg"};base64,${frame.data}` : frame.url || frame.file_url || "";
          const filename = frame.filename || `${label}-frame-${index + 1}.jpg`;
          const file = dataUrl.startsWith("data:")
            ? dataUrlToFile(dataUrl, filename, frame.mimeType || "image/jpeg")
            : null;
          return {
            id: makeId("video-frame"),
            file,
            filename,
            mimeType: frame.mimeType || "image/jpeg",
            sizeBytes: file?.size || 0,
            previewUrl: frame.url || frame.file_url || dataUrl,
            base64Data: frame.data || (dataUrl.startsWith("data:") ? stripDataUrl(dataUrl) : ""),
            storagePath: frame.file_url || frame.url || "",
            createdAt: new Date().toISOString(),
            sourceVideo: {
              filename: selectedVideoClip.filename,
              label,
              startSeconds: selectedVideoClip.startSeconds,
              endSeconds: selectedVideoClip.endSeconds,
              frameTimeSeconds,
              timelineStartSeconds,
              timelineEndSeconds,
              frameTimelineSeconds: frameTimeSeconds + timelineOffsetSeconds,
              timelineLabel,
              frameIndex: frame.frameIndex || index + 1,
              processedClipUrl: processed.clip_url || processed.url || "",
              motionSummary: index === 0 ? processed.motion_summary || null : null,
            },
          };
        });
      }
      setChatProcessingStatus({
        phase: "sampling",
        message: "Sampling video frames in the browser",
        detail: `Using ${Math.min(slots, VIDEO_FRAME_SAMPLE_COUNT)} frames from ${formatTimePhrase(selectedVideoClip.startSeconds)} to ${formatTimePhrase(selectedVideoClip.endSeconds)}.`,
      });
      const frames = await sampleVideoFrames({
        file: selectedVideoClip.file,
        startSeconds: selectedVideoClip.startSeconds,
        endSeconds: selectedVideoClip.endSeconds,
        label,
        maxFrames: Math.min(slots, VIDEO_FRAME_SAMPLE_COUNT),
      });
      return frames.map((frame, index) => ({
        id: makeId("video-frame"),
        file: frame.file,
        filename: frame.filename,
        mimeType: "image/jpeg",
        sizeBytes: frame.file.size,
        previewUrl: frame.dataUrl,
        createdAt: new Date().toISOString(),
        sourceVideo: {
          filename: selectedVideoClip.filename,
          label,
          startSeconds: selectedVideoClip.startSeconds,
          endSeconds: selectedVideoClip.endSeconds,
          frameTimeSeconds: Number(frame.time.toFixed(2)),
          timelineStartSeconds,
          timelineEndSeconds,
          frameTimelineSeconds: Number((frame.time + timelineOffsetSeconds).toFixed(2)),
          timelineLabel,
          frameIndex: index + 1,
        },
      }));
    } finally {
      setProcessingVideoClip(false);
    }
  };

  const uploadSelectedImages = async () => {
    const videoFrames = await materializeVideoClipFrames();
    const maxPending = MAX_IMAGE_COUNT + (videoFrames.length ? VIDEO_FRAME_SAMPLE_COUNT : 0);
    const pendingImages = [...selectedImages, ...videoFrames].slice(0, maxPending);
    if (!pendingImages.length) return { metadata: [], aiImages: [] };
    setUploadingImages(true);
    setChatProcessingStatus({
      phase: videoFrames.length ? "uploading" : "uploading",
      message: videoFrames.length ? "Uploading sampled video frames" : "Uploading images",
      detail: videoFrames.length
        ? `${videoFrames.length} frames are being attached for Sarah's review.`
        : `${pendingImages.length} image${pendingImages.length === 1 ? "" : "s"} are being attached.`,
    });
    const uploaded = [];
    const aiImages = [];
    try {
      for (const image of pendingImages) {
        const upload = image.storagePath
          ? { file_url: image.storagePath, url: image.storagePath }
          : await base44.integrations.Core.UploadFile({ file: image.file });
        uploaded.push({
          id: makeId("image"),
          filename: image.filename,
          mimeType: image.mimeType,
          sizeBytes: image.sizeBytes,
          storagePath: upload?.file_url || upload?.url || "",
          previewUrl: upload?.file_url || upload?.url || image.previewUrl,
          createdAt: image.createdAt,
          scope: mode,
          sourceVideo: image.sourceVideo || null,
          profileId: mode === "profile" ? scopeId || userProfile?.id || null : null,
          sessionId: mode === "session" ? scopeId || null : null,
          bodyExplorationId: evidenceScope === "body_exploration" ? scopeId || null : null,
        });
        aiImages.push({
          filename: image.filename,
          media_type: image.mimeType,
          data: image.base64Data || stripDataUrl(image.previewUrl),
        });
      }
      if (videoFrames.length) {
        updateSelectedVideoClip({
          processingStatus: "Clip sent to Sarah. Keep this open to mark another range, or close it when finished.",
        }, { keepProcessed: true });
      }
      return { metadata: uploaded, aiImages };
    } finally {
      setUploadingImages(false);
    }
  };

  const WHISPER_PROMPT =
    "Session log note. Gentle strokes on the glans penis. Foreskin partially retracted. " +
    "Stimulation paused. Perineum pressure applied. Pelvic floor contraction. " +
    "E-stim via TENS unit. Foley catheter in place. Urethral stimulation. " +
    "Edging — arousal near climax. Frenulum contact. Prostate stimulation. " +
    "Ejaculation. Refractory period. Buildup plateau. Involuntary spasm. Discomfort noted.";

  const stopVad = () => {
    if (vadFrameRef.current) cancelAnimationFrame(vadFrameRef.current);
    vadFrameRef.current = null;
    audioContextRef.current?.close?.().catch(() => {});
    audioContextRef.current = null;
  };

  const stopMicStream = () => {
    micStreamRef.current?.getTracks().forEach((track) => track.stop());
    micStreamRef.current = null;
  };

  const releaseVoiceCaptureForPlayback = () => {
    if (!recording && !micStreamRef.current && !audioContextRef.current) return;
    suppressNextTranscriptionRef.current = true;
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
    } else {
      stopVad();
      stopMicStream();
      setRecording(false);
    }
  };

  const disableVoiceMode = () => {
    if (mediaRecorderRef.current?.state === "recording") mediaRecorderRef.current.stop();
    stopVad();
    stopMicStream();
    setRecording(false);
  };

  const startVad = (stream) => {
    stopVad();
    speechDetectedRef.current = false;
    silenceStartRef.current = null;
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    const audioContext = new AudioContextClass();
    audioContextRef.current = audioContext;
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 1024;
    const source = audioContext.createMediaStreamSource(stream);
    source.connect(analyser);
    const data = new Uint8Array(analyser.fftSize);
    const tick = () => {
      analyser.getByteTimeDomainData(data);
      let total = 0;
      for (let i = 0; i < data.length; i += 1) {
        const centered = (data[i] - 128) / 128;
        total += centered * centered;
      }
      const rms = Math.sqrt(total / data.length);
      const now = Date.now();
      if (rms > 0.035) {
        speechDetectedRef.current = true;
        silenceStartRef.current = null;
      } else if (speechDetectedRef.current) {
        if (!silenceStartRef.current) silenceStartRef.current = now;
        if (VOICE_AUTO_STOP_ENABLED && now - silenceStartRef.current > 2400 && mediaRecorderRef.current?.state === "recording") {
          mediaRecorderRef.current.stop();
          return;
        }
      }
      vadFrameRef.current = requestAnimationFrame(tick);
    };
    vadFrameRef.current = requestAnimationFrame(tick);
  };

  const startRecording = async () => {
    if (recording || transcribing || loading) return;
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    micStreamRef.current = stream;
    audioChunksRef.current = [];
    const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
      ? "audio/webm;codecs=opus"
      : MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "audio/ogg";
    const mr = new MediaRecorder(stream, { mimeType });
    mediaRecorderRef.current = mr;
    mr.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
    mr.onstop = async () => {
      stopVad();
      stream.getTracks().forEach((t) => t.stop());
      if (micStreamRef.current === stream) micStreamRef.current = null;
      setRecording(false);
      if (suppressNextTranscriptionRef.current) {
        suppressNextTranscriptionRef.current = false;
        audioChunksRef.current = [];
        setTranscribing(false);
        return;
      }
      setTranscribing(true);
      try {
        const chunks = audioChunksRef.current.slice();
        if (!chunks.length) throw new Error("No audio was captured.");
        const blob = new Blob(chunks, { type: mimeType });
        const ab = await blob.arrayBuffer();
        const bytes = new Uint8Array(ab);
        let bin = "";
        for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
        const base64 = btoa(bin);
        const res = await base44.functions.invoke("whisperSTT", { audio_base64: base64, mime_type: mimeType, prompt: WHISPER_PROMPT });
        const rawText = res.data?.text?.trim() || "";
        const text = cleanWhisperTranscript(rawText);
        if (text) setInput((prev) => (prev ? `${prev} ${text}` : text));
        setTimeout(() => inputRef.current?.focus(), 100);
      } catch (error) {
        const message = friendlyWhisperError(error);
        setImageError("");
        setChatProcessingStatus({ phase: "error", message: "Whisper transcription failed", detail: message });
      } finally {
        audioChunksRef.current = [];
        setTranscribing(false);
      }
    };
    mr.start();
    setRecording(true);
    startVad(stream);
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current?.state === "recording") mediaRecorderRef.current.stop();
    else disableVoiceMode();
  };



  const handleOpen = () => {
    setOpen(true);
    // Restore persisted messages but don't auto-generate — let user pick a category
  };

  const openFullScreen = () => {
    setOpen(true);
    setFullScreen(true);
    setTimeout(() => inputRef.current?.focus(), 80);
  };

  const summarizeFindings = async (messageList) => {
    const history = messageList.map((m) => `${m.role === "user" ? "User" : "AI"}: ${m.text}`).join("\n");
    const groundingContext = buildAIGroundingContext(userProfile);
    const profileMechanicalContext = mode === "profile" ? `\n\n${PROFILE_MECHANICAL_RULE}` : "";
    const res = await base44.integrations.Core.InvokeLLM({
      prompt: `${groundingContext}${profileMechanicalContext}\n\nBased on this Q&A conversation about a person's ${conversationSubject}, write 2-4 concise bullet points summarizing only the NEW factual findings from the user's answers that would be useful to persist for future AI analysis. Do not repeat generic information already obvious from the base data. Be specific and factual. Do not preserve assumptions about intent unless the person explicitly stated them. Write every saved bullet in direct second person using "you" and "your"; do not use the person's name, "the user", "he", "she", "his", or "her".\n\nConversation:\n${history}\n\nOutput as plain bullet points starting with "•":`,
      source: "ai_chat_findings_summary",
      priority: 25,
    });
    return typeof res === "string" ? res.trim() : res?.response?.trim() ?? "";
  };

  const persistFindings = async (messageList) => {
    setSavingFindings(true);
    const findings = await summarizeFindings(messageList);
    if (findings) {
      const timestamp = new Date().toISOString().slice(0, 10);
      const newNote = `\n\n[AI Interview — ${timestamp}]\n${findings}`;
      const merged = mode === "profile" ? findings : (savedNotes || "") + newNote;
      await onSaveNotes?.(merged, {
        date: timestamp,
        source: mode === "profile" ? "profile_ai_interview" : `${evidenceScope}_ai_interview`,
        conversation: messageList,
      });
    }
    setSavingFindings(false);
    setSavedFeedback(true);
    setTimeout(() => setSavedFeedback(false), 3000);
  };

  const persistStructuredImageFindings = async (findings, finalMessages, chatResponse = "") => {
    const normalizedFindings = findings.length ? findings : [{
      title: "Image review summary",
      category: "other",
      findingText: `Sarah reviewed the attached image(s), but no separate structured finding was extracted. Review the chat response before promoting details: ${String(chatResponse || "").slice(0, 420)}`,
      confidence: "low",
      persistTo: "none",
      needsUserConfirmation: true,
    }];
    const directBullets = findingsToBullets(normalizedFindings, mode);
    const bullets = directBullets || reviewCandidateBullets(normalizedFindings);
    if (!bullets) return;
    const timestamp = new Date().toISOString().slice(0, 10);
    const mediaContext = extractVisualMediaContextFromConversation(finalMessages);
    const hasVideoFrames = mediaContext.frame_count > 0;
    const source = hasVideoFrames ? `${evidenceScope}_sarah_video_review` : `${evidenceScope}_sarah_image_review`;
    const merged = mode === "profile" ? bullets : `${savedNotes || ""}\n\n[Sarah ${hasVideoFrames ? "Video" : "Image"} Review — ${timestamp}]\n${bullets}`;
    await onSaveNotes?.(merged, {
      date: timestamp,
      source,
      conversation: finalMessages,
      structured_findings: normalizedFindings,
      needs_review: !directBullets || normalizedFindings.some((finding) => finding?.needsUserConfirmation),
      persistence_status: directBullets ? "recommended" : "review_candidate",
      image_count: mediaContext.image_count,
      frame_count: mediaContext.frame_count,
      media_context: mediaContext,
    });
    setSavedFeedback(true);
    setTimeout(() => setSavedFeedback(false), 3000);
  };

  const persistChatMessages = async (messageList) => {
    try {
      await onSaveMessages?.(messageList);
    } catch (error) {
      const message = error?.message || "Chat save failed.";
      setImageError(message);
      setChatProcessingStatus({ phase: "error", message: "Chat save failed", detail: message });
    }
  };

  const sendMessage = async (overrideText = null) => {
    const requestedText = typeof overrideText === "string" ? overrideText : input;
    if ((!requestedText.trim() && !selectedImages.length && !selectedVideoClip) || loading || uploadingImages || processingVideoClip) return;
    const text = requestedText.trim();
    setLoading(true);
    setChatProcessingStatus({
      phase: selectedVideoClip ? "queued" : selectedImages.length ? "queued" : "thinking",
      message: selectedVideoClip ? "Starting Sarah video review" : selectedImages.length ? "Starting Sarah image review" : "Sarah is thinking",
      detail: selectedVideoClip ? "Preparing the clip, frame evidence, motion summary, and session context." : "",
    });
    setImageError("");
    let imagePayload = { metadata: [], aiImages: [] };
    try {
      imagePayload = await uploadSelectedImages();
    } catch (error) {
      setLoading(false);
      setChatProcessingStatus({ phase: "error", message: "Could not prepare attachments", detail: error.message || "Image upload failed." });
      setImageError(error.message || "Image upload failed.");
      return;
    }
    const userMsg = { role: "user", text: text || "Please review the attached media.", imageAttachments: imagePayload.metadata };
    const updated = [...messages, userMsg];
    setMessages(updated);
    await persistChatMessages(updated);
    setInput("");
    setSelectedImages([]);

    const history = updated.map((m) => {
      const attachmentLine = m.imageAttachments?.length ? ` [${m.imageAttachments.length} attached image${m.imageAttachments.length === 1 ? "" : "s"}]` : "";
      return `${m.role === "user" ? "User" : "AI"}: ${m.text}${attachmentLine}`;
    }).join("\n");
    const videoContext = imagePayload.metadata
      .filter((item) => item.sourceVideo)
      .map((item) => item.sourceVideo)
      .map((video) => {
        const sourceRange = `${formatTimePhrase(video.startSeconds)} to ${formatTimePhrase(video.endSeconds)}`;
        const sourceFrameTime = formatTimePhrase(video.frameTimeSeconds);
        const timelineRange = video.timelineStartSeconds != null && video.timelineEndSeconds != null
          ? ` This same clip spans ${formatTimePhrase(video.timelineStartSeconds)} to ${formatTimePhrase(video.timelineEndSeconds)} on the ${video.timelineLabel || "session timeline"}, and this frame is at ${formatTimePhrase(video.frameTimelineSeconds ?? video.frameTimeSeconds)} on that timeline.`
          : "";
        return `Video clip frame ${video.frameIndex}: "${video.label}" from ${sourceRange} in source video ${video.filename}, sampled at source time ${sourceFrameTime}.${timelineRange}`;
      })
      .join("\n");
    const motionSummary = imagePayload.metadata
      .map((item) => item.sourceVideo?.motionSummary)
      .find(Boolean);
    const motionContext = motionSummary
      ? [
          `Local motion summary method: ${motionSummary.method || "unknown"}.`,
          `Estimated motion level: ${motionSummary.motion_level || "unknown"}.`,
          motionSummary.average_motion != null ? `Average frame-to-frame motion: ${motionSummary.average_motion}.` : null,
          motionSummary.peak_motion != null ? `Peak frame-to-frame motion: ${motionSummary.peak_motion}.` : null,
          motionSummary.active_motion_pct != null ? `Active motion coverage: ${motionSummary.active_motion_pct}%.` : null,
          motionSummary.pause_candidates?.length ? `Possible low-motion pauses: ${motionSummary.pause_candidates.map((pause) => `${formatTimePhrase(pause.startSeconds)} to ${formatTimePhrase(pause.endSeconds)} (${formatTimePhrase(pause.durationSeconds)})`).join(", ")}.` : null,
          motionSummary.note || null,
        ].filter(Boolean).join("\n")
      : "";

    const shouldPivot = messages.length > 4 && Math.random() < 0.4;

    const groundingContext = buildAIGroundingContext(userProfile);
    const profileMechanicalContext = mode === "profile" ? `\n\n${PROFILE_MECHANICAL_RULE}` : "";

    const ANATOMY_RULE = `ANATOMY RULE: Use ONLY the anatomical and physiological details stated in the profile above. Never assume or infer biological sex, genitalia, or anatomy not explicitly mentioned. If anatomy is ambiguous, use neutral language (e.g. "genital stimulation", "pelvic region", "that area").`;

    const SESSION_SCOPE_RULE = `SCOPE RULE: Stay anchored to THIS specific ${conversationSubject}'s data only. Never compare to or reference other records unless the provided context explicitly asks for that comparison.`;
    const TIME_FORMAT_RULE = `TIME FORMAT RULE: When discussing clip or session timing, write times in natural minutes-and-seconds language, like "nine minutes and fifty-eight seconds" or "one minute and twelve seconds". Do not use raw second counts like "598 seconds", compact labels like "598s", or bracketed numeric timestamps like "[9:58]" in the user-facing response.`;

    const QUESTION_QUALITY_RULE = `QUESTION QUALITY — THIS IS THE MOST IMPORTANT RULE:
Questions should be rooted in the session's AROUSAL and STIMULATION experience, not heart rate numbers or timestamps. Good anchors to use:
  - A stimulation method or combination used: "you combined the foley with e-stim — how did the sensation feel different when both were active?"
  - A logged event note (paraphrase, don't just quote): "you noted switching technique partway through — what prompted that and did it change the feel?"
  - A subjective metric gap: "intensity was an 8 but satisfaction only a 5 — what felt like it was missing?"
  - An outcome or experience quality: "the build was rated high but climax duration was short — what did that arc feel like from the inside?"
  - A notable logged experience: "you noted discomfort at one point — did that affect how present you felt during the rest of the session?"
  - A broad session pattern: "the buildup went long this time — did it feel like a sustained plateau, a slower climb, or something else?"
  - Something they haven't mentioned yet: "what was the most physically intense moment for you, and what was driving it?"

TONE: Casual, warm, curious — like a knowledgeable friend who actually read the session notes, not a clinician reviewing a chart. Short sentences. Use "you" freely. Contractions are fine.

BANNED QUESTION TYPES — never ask these:
- Questions pinned to exact timestamps or minute markers ("at 14:22", "around the 9-minute mark")
- Questions that cite raw HR numbers as the main anchor ("your HR hit 112 — how did that feel?")
- Generic enjoyment questions with no session grounding ("what did you enjoy most?")
- Time-perception questions ("did it feel longer or shorter than usual?")
- Abstract cause-and-effect speculation with no data anchor
- Yes/no questions — always invite a narrative answer

If nothing specific stands out, ask what surprised them most or what they'd most want to remember from this session.`;

    const SARAH_QA_STYLE_RULE = `EMOJI STYLE RULE: In conversational Q&A replies, Sarah may use an occasional emoji when the user uses emojis or when one naturally fits the tone. Keep it light and human, not decorative or spammy. Do not put emojis in structured saved findings.`;

    const systemPrompt = messages.length === 1
      ? mode === "profile"
        ? `You're having a genuine, immersive conversation with someone about their physiology and arousal — like a knowledgeable friend who has studied their data closely. They've just shared something. Respond naturally, ask ONE follow-up question that goes deeper. Curious, specific, engaged. 2–3 sentences. No bullets, no clinical jargon. ${ANATOMY_RULE} ${SARAH_QA_STYLE_RULE}`
        : `You're a curious, knowledgeable friend helping someone unpack a specific ${conversationSubject}. They just shared something. React briefly and naturally, then ask ONE question grounded in a real detail from this ${conversationSubject} — a method used, a logged event or note, a subjective metric gap, or something about the body response. Sound like you actually read the record, not like you're scanning a graph. Keep it casual and conversational.

${SESSION_SCOPE_RULE}
${QUESTION_QUALITY_RULE}
${ANATOMY_RULE}
${SARAH_QA_STYLE_RULE}
2–3 sentences total. No affirmations, no "great!", no formal phrasing.`
      : shouldPivot
        ? mode === "profile"
          ? `You're having a warm conversation about someone's physiology. They just responded. Pivot to a DIFFERENT aspect of their profile not yet covered. ONE curious, specific question. No affirmations. 2–3 sentences. ${ANATOMY_RULE} ${SARAH_QA_STYLE_RULE}`
          : `You're digging into THIS session with someone. They just responded. Switch to a fresh angle — pick something not yet discussed (a different stimulation method, a metric gap, a logged event, something about how the session ended or how they felt afterward) and ask ONE casual, pointed question. Sound like you spotted something worth exploring, not like you're following a checklist.

${SESSION_SCOPE_RULE}
${QUESTION_QUALITY_RULE}
${ANATOMY_RULE}
${SARAH_QA_STYLE_RULE}
No affirmations. 2–3 sentences.`
        : mode === "profile"
          ? `Warm, immersive conversation about physiology. They just responded. Continue naturally — ONE follow-up that goes deeper on what they said. Curious, specific. No affirmations. 2–3 sentences. ${ANATOMY_RULE} ${SARAH_QA_STYLE_RULE}`
          : `You're digging into THIS session with someone. They just answered. Pick up the thread and ask ONE casual follow-up that goes deeper — reference something specific from the session (a method, a sensation they mentioned, a logged event, a metric gap, or how things unfolded) and invite them to expand. Make it feel like a genuine back-and-forth, not a checklist.

${SESSION_SCOPE_RULE}
${QUESTION_QUALITY_RULE}
${ANATOMY_RULE}
${SARAH_QA_STYLE_RULE}
No affirmations or pleasantries. 2–3 sentences.`;

    const imageReviewPrompt = imagePayload.aiImages.length ? `SARAH IMAGE REVIEW MODE:
You are Sarah inside the Sarah app. The user may provide explicit adult anatomical or device images for private self-analysis. Analyze clinically/functionally, not erotically.
${ANATOMICAL_REFERENCE_FOCUS_RULE}
- Do not shame, moralize, flirt, rate attractiveness, or write erotic commentary.
- Separate what is directly visible in the image from what is inferred from profile/session history.
- Flag uncertainty from angle, lighting, state, occlusion, or single-image limits.
- Focus on anatomy, physiology, device fit, marker/sticker placement, catheter/sleeve/e-stim/suction interaction, posture/positioning, and evidence-aware profile/session updates.
- Do not turn image/media review into broad personal history, psychological backstory, reclaiming/history framing, whole-life meaning, or a session optimization essay unless that context directly explains a visible/mechanical finding, device interaction, safety consideration, or session-specific physiological interpretation.
- Circular dots or bright reflective spots on the feet/body are tracking markers by default, not electrodes. Call them "tracking markers", "reflective markers", or "visible dots" unless e-stim, TENS, electrode pads, electrode leads, or an electrode setup is explicitly mentioned in the session/profile context, clip caption, or nearby events. Never write "foot electrode markers" from appearance alone.
- Use direct second-person language and be respectful, warm, and precise.
- In the conversational chatResponse only, Sarah may use an occasional emoji when the user uses emojis or when one naturally fits. Do not put emojis in structured findings.
- ${TIME_FORMAT_RULE}
- In chatResponse and every findingText, use "you" and "your"; do not use the person's name, "the user", "he", "she", "his", or "her".
- If you make any concrete visible observation that may matter later, include it in findings. Use persistTo "profile", "session", or "both" for durable evidence; use persistTo "none" with needsUserConfirmation true for cautious review candidates.
- Leave findings empty only if the image is unusable or has no useful observable information.

Return a conversational answer plus structured findings for review/persistence.` : "";

    const imageSchema = {
      type: "object",
      properties: {
        chatResponse: { type: "string" },
        findings: {
          type: "array",
          items: {
            type: "object",
            properties: {
              title: { type: "string" },
              category: { type: "string", enum: ["anatomy", "device_fit", "positioning", "marker_tracking", "physiology", "session_context", "other"] },
              findingText: { type: "string" },
              confidence: { type: "string", enum: ["low", "moderate", "high"] },
              persistTo: { type: "string", enum: ["profile", "session", "both", "none"] },
              needsUserConfirmation: { type: "boolean" },
            },
            required: ["title", "category", "findingText", "confidence", "persistTo", "needsUserConfirmation"],
          },
        },
        limitations: { type: "array", items: { type: "string" } },
        followUpQuestions: { type: "array", items: { type: "string" } },
      },
      required: ["chatResponse", "findings", "limitations", "followUpQuestions"],
    };

    setChatProcessingStatus({
      phase: "analyzing",
      message: imagePayload.aiImages.length ? "Sarah is reviewing the visual evidence" : "Sarah is composing a response",
      detail: imagePayload.aiImages.length
        ? "Long video reviews can take a bit while the model reads frames, motion context, and session notes."
        : "",
    });

    try {
    const res = await base44.integrations.Core.InvokeLLM({
      prompt: `${imageReviewPrompt || systemPrompt}\n\n${TIME_FORMAT_RULE}${profileMechanicalContext}\n\n${groundingContext}\n\nSession/profile data:\n${context}\n\nConversation:\n${history}${videoContext ? `\n\nLocal video clip context represented by timestamped sampled still frames:\n${videoContext}` : ""}${motionContext ? `\n\nLocal video motion evidence:\n${motionContext}\n\nUse this motion evidence to discuss visible timing, continuity, speed shifts, and pause candidates. Treat it as an observational proxy only; do not claim confirmed technique, intent, pressure, or force unless the visual frames and user caption directly support it.` : ""}\n\nUser's current text with the attached image(s):\n${text || "(No extra text provided.)"}\n\nRespond now as Sarah:`,
      ...(imagePayload.aiImages.length ? { images: imagePayload.aiImages, response_json_schema: imageSchema, max_tokens: 5000 } : {}),
      source: "ai_chat_interactive",
      foreground: true,
      interactive: true,
      priority: 100,
    });

    const normalized = imagePayload.aiImages.length ? normalizeAIImageResult(res) : null;
    const reply = imagePayload.aiImages.length
      ? normalized.chatResponse
      : typeof res === "string" ? res.trim() : res?.response?.trim() ?? "";
    const aiMsg = { role: "assistant", text: reply };
    const finalMessages = [...updated, aiMsg];
    setMessages(finalMessages);
    await persistChatMessages(finalMessages);
    setLoading(false);
    setChatProcessingStatus(null);
    const newIdx = finalMessages.length - 1;
    if (ttsEnabled) speakText(reply, newIdx);
    if (imagePayload.aiImages.length) {
      persistStructuredImageFindings(normalized.findings, finalMessages, reply).catch(() => {});
    } else if (mode === "profile") {
      persistFindings(finalMessages).catch(() => {
        setSavingFindings(false);
      });
    }
    } catch (error) {
      const message = friendlySarahError(error);
      setLoading(false);
      setChatProcessingStatus({ phase: "error", message: "Sarah response failed", detail: message });
      setImageError(message);
    }
  };

  const saveFindings = async () => {
    persistFindings(messages).catch(() => {
      setSavingFindings(false);
    });
  };

  const hasUserReplied = messages.some((m) => m.role === "user");
  const hasMessages = messages.length > 0;
  const ttsStatusLabel = (status) => {
    if (!status) return "";
    if (["preparing", "fetching"].includes(status.phase)) {
      return `${status.message}${ttsElapsedSeconds ? ` (${ttsElapsedSeconds}s)` : ""}`;
    }
    return status.message || status.phase;
  };
  const ttsStatusClass = (phase) => {
    if (phase === "error") return "border-destructive/30 bg-destructive/10 text-destructive";
    if (phase === "paused") return "border-amber-400/30 bg-amber-400/10 text-amber-200";
    if (phase === "playing" || phase === "cached" || phase === "complete") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-300";
    return "border-accent/30 bg-accent/10 text-accent";
  };
  const panelClass = fullScreen
    ? "fixed inset-0 z-50 flex flex-col overflow-hidden border-0 bg-background text-foreground"
    : "border border-border rounded-xl overflow-hidden";
  const bodyClass = fullScreen
    ? "flex min-h-0 flex-1 flex-col gap-3 p-3 sm:p-5"
    : "p-3 space-y-3";
  const threadClass = fullScreen
    ? "flex min-h-0 flex-1 basis-0 flex-col gap-2 overflow-y-auto border-t border-border px-1 pt-3 sm:px-3"
    : "min-h-[36rem] max-h-[70vh] space-y-2 overflow-y-auto pr-1 border-t border-border pt-2";
  const messageClass = (role) => `group relative rounded-2xl px-3 py-2 text-sm leading-relaxed shadow-sm ${
    fullScreen ? "max-w-[min(78%,52rem)] sm:text-[15px]" : "max-w-[85%]"
  } ${
    role === "user"
      ? "bg-primary text-primary-foreground rounded-br-md"
      : "bg-muted/70 text-foreground rounded-bl-md cursor-pointer"
  }`;
  const composerClass = fullScreen
    ? "sticky bottom-0 mt-auto space-y-2 border-t border-border bg-background/95 px-1 py-3 sm:px-3"
    : "sticky bottom-0 space-y-2 bg-white pt-2 dark:bg-slate-900";
  const textareaClass = fullScreen
    ? "min-h-24 w-full resize-none rounded-2xl border border-border bg-muted/30 px-4 py-3 text-sm focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50 sm:text-base"
    : "w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50";
  const effectiveSendDisabled = (!input.trim() && !selectedImages.length && !selectedVideoClip) || loading || uploadingImages || processingVideoClip;

  const renderSelectedImages = () => selectedImages.length ? (
    <div className="grid grid-cols-3 gap-2 sm:grid-cols-5">
      {selectedImages.map((image) => (
        <div key={image.id} className="relative overflow-hidden rounded-lg border border-border bg-muted/30">
          <img src={image.previewUrl} alt={image.filename} className="aspect-square w-full object-cover" />
          <button
            type="button"
            onClick={() => removeSelectedImage(image.id)}
            className="absolute right-1 top-1 rounded-full bg-black/70 p-1 text-white hover:bg-black"
            title="Remove image"
          >
            <X className="h-3 w-3" />
          </button>
          <p className="truncate px-1.5 py-1 text-[10px] text-muted-foreground">{image.filename}</p>
        </div>
      ))}
    </div>
  ) : null;

  const renderSavedVideoClips = () => {
    const clips = Array.isArray(savedVideoClips) ? savedVideoClips.filter((clip) => clip?.url || clip?.clip_url || clip?.frames?.length) : [];
    if (!clips.length || mode !== "session") return null;
    return (
      <div className="rounded-lg border border-primary/20 bg-primary/[0.05] p-2 text-xs">
        <p className="mb-2 font-semibold text-primary">Saved key video moments</p>
        <div className="flex gap-2 overflow-x-auto pb-1">
          {clips.slice(0, 8).map((clip) => (
            <button
              key={clip.id || `${clip.label}-${clip.session_time_s}`}
              type="button"
              onClick={() => attachSavedVideoClipFrames(clip)}
              disabled={loading || uploadingImages || processingVideoClip || selectedImages.length >= MAX_IMAGE_COUNT}
              className="min-w-[11rem] rounded-lg border border-border bg-background/75 px-2 py-1.5 text-left transition-colors hover:border-primary disabled:opacity-45"
              title={clip.reason || "Attach sampled frames from this saved moment"}
            >
              <span className="block truncate font-semibold text-foreground">{clip.label || "Saved clip"}</span>
              <span className="block text-[10px] text-muted-foreground">
                {clip.session_time_s != null ? formatSeconds(clip.session_time_s) : "time?"}
                {clip.camera_angle ? ` · ${clip.camera_angle}` : ""}
                {Array.isArray(clip.frames) && clip.frames.length ? ` · ${clip.frames.length} frames` : " · needs refresh"}
              </span>
            </button>
          ))}
        </div>
      </div>
    );
  };

  const renderSelectedVideoClip = () => {
    if (!selectedVideoClip) return null;
    const expandedPreview = videoPreviewSize === "expanded";
    const previewHeightClass = fullScreen
      ? expandedPreview ? "h-[clamp(28rem,62vh,48rem)]" : "h-[clamp(20rem,46vh,34rem)]"
      : expandedPreview ? "h-[clamp(24rem,52vh,38rem)]" : "h-[clamp(16rem,36vh,28rem)]";

    return (
    <div className="rounded-lg border border-primary/25 bg-primary/[0.05] p-3 text-xs">
      <div className="mb-2 flex items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate font-semibold text-primary">Local video clip</p>
          <p className="truncate text-[10px] text-muted-foreground">
            {selectedVideoClip.filename} · {selectedVideoClip.duration ? formatSeconds(selectedVideoClip.duration) : "duration pending"} · raw source is discarded after local processing
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setVideoPreviewSize((size) => size === "expanded" ? "large" : "expanded")}
            className="rounded-md p-1 text-muted-foreground hover:bg-muted hover:text-foreground"
            title={expandedPreview ? "Compact preview" : "Expand preview"}
          >
            {expandedPreview ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
          </button>
          <button
            type="button"
            onClick={() => setSelectedVideoClip(null)}
            className="inline-flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-muted-foreground hover:bg-muted hover:text-foreground"
            title="Remove video clip"
          >
            <X className="h-3.5 w-3.5" />
            Close
          </button>
        </div>
      </div>
      <div className={`mb-2 min-h-80 w-full resize-y overflow-hidden rounded-md border border-border bg-black ${previewHeightClass}`}>
        <video
          ref={videoPreviewRef}
          src={selectedVideoClip.processedClip?.clip_url || selectedVideoClip.processedClip?.url || selectedVideoClip.previewUrl}
          controls
          muted
          playsInline
          preload="metadata"
          onLoadedMetadata={(event) => {
            const duration = event.currentTarget.duration;
            if (selectedVideoClip.processedClip) {
              event.currentTarget.currentTime = 0;
              setVideoPlayheadSeconds(0);
              return;
            }
            if (Number.isFinite(duration) && duration > 0 && !selectedVideoClip.duration) {
              updateSelectedVideoClip({ duration }, { keepProcessed: true });
            }
          }}
          onTimeUpdate={(event) => {
            if (!selectedVideoClip.processedClip) setVideoPlayheadSeconds(event.currentTarget.currentTime || 0);
          }}
          className="h-full w-full bg-black object-contain"
        />
      </div>
      <input
        value={selectedVideoClip.label}
        onChange={(event) => updateSelectedVideoClip({ label: event.target.value })}
        placeholder='Label, e.g. "fingers-on-glans technique"'
        className="mb-2 w-full rounded-md border border-border bg-background px-2 py-1 text-xs focus:outline-none focus:ring-1 focus:ring-primary"
      />
      <div className="rounded-md border border-border bg-background/60 p-2">
        <div className="mb-1 flex items-center justify-between gap-2 text-[10px] text-muted-foreground">
          <span>{selectedVideoClip.processedClip ? "Trimmed preview" : "Playhead"} <span className="font-medium text-foreground">{formatSeconds(videoPlayheadSeconds)}</span></span>
          <span>
            In <span className="font-medium text-foreground">{formatSeconds(selectedVideoClip.startSeconds)}</span>
            {" · "}
            Out <span className="font-medium text-foreground">{formatSeconds(selectedVideoClip.endSeconds)}</span>
          </span>
        </div>
        {evidenceScope !== "profile" && (
          <p className="mb-1 text-[10px] text-muted-foreground">
            Sarah sees this as <span className="font-medium text-foreground">{formatSeconds(selectedVideoClip.startSeconds + timelineOffsetSeconds)}-{formatSeconds(selectedVideoClip.endSeconds + timelineOffsetSeconds)}</span> on the {evidenceScope === "body_exploration" ? "body exploration" : "session"} timeline.
          </p>
        )}
        <input
          type="range"
          min="0"
          max={Math.max(0.3, selectedVideoClip.duration || selectedVideoClip.endSeconds || 30)}
          step="0.1"
          value={Math.min(videoPlayheadSeconds, Math.max(0.3, selectedVideoClip.duration || selectedVideoClip.endSeconds || 30))}
          onChange={(event) => seekVideoPreview(event.target.value)}
          disabled={Boolean(selectedVideoClip.processedClip)}
          className="w-full accent-primary"
        />
        <div className="mt-2 grid grid-cols-2 gap-2">
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => markVideoBoundary("start")}
            disabled={Boolean(selectedVideoClip.processedClip)}
            className="h-7 px-2 text-[11px]"
          >
            Mark In
          </Button>
          <Button
            type="button"
            size="sm"
            variant="secondary"
            onClick={() => markVideoBoundary("end")}
            disabled={Boolean(selectedVideoClip.processedClip)}
            className="h-7 px-2 text-[11px]"
          >
            Mark Out
          </Button>
        </div>
        <div className="mt-2 grid grid-cols-2 gap-2">
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => seekVideoPreview(selectedVideoClip.startSeconds)}
            className="h-7 px-2 text-[11px]"
          >
            Jump to In
          </Button>
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => seekVideoPreview(selectedVideoClip.endSeconds)}
            className="h-7 px-2 text-[11px]"
          >
            Jump to Out
          </Button>
        </div>
      </div>
      <div className="mt-2 grid grid-cols-2 gap-2">
        <label className="text-[10px] text-muted-foreground">
          Start
          <input
            type="number"
            min="0"
            max={Math.max(0.3, selectedVideoClip.duration || selectedVideoClip.endSeconds || 30)}
            step="0.1"
            value={selectedVideoClip.startSeconds}
            onChange={(event) => {
              const nextStart = Math.max(0, Number(event.target.value) || 0);
              updateSelectedVideoClip((clip) => ({ ...clip, startSeconds: nextStart, endSeconds: Math.max(nextStart + 0.3, clip.endSeconds) }));
              seekVideoPreview(nextStart);
            }}
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
          />
        </label>
        <label className="text-[10px] text-muted-foreground">
          End
          <input
            type="number"
            min="0.3"
            max={Math.max(0.3, selectedVideoClip.duration || selectedVideoClip.endSeconds || 30)}
            step="0.1"
            value={selectedVideoClip.endSeconds}
            onChange={(event) => {
              const requested = Number(event.target.value) || selectedVideoClip.endSeconds;
              let nextEnd = requested;
              updateSelectedVideoClip((clip) => {
                const max = clip.duration || requested;
                nextEnd = Math.min(Math.max(clip.startSeconds + 0.3, requested), max);
                return { ...clip, endSeconds: nextEnd };
              });
              seekVideoPreview(nextEnd);
            }}
            className="mt-1 w-full rounded-md border border-border bg-background px-2 py-1 text-xs text-foreground"
          />
        </label>
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="secondary"
          onClick={processSelectedVideoClip}
          disabled={processingVideoClip || selectedImages.length >= MAX_IMAGE_COUNT}
          className="h-7 px-2 text-[11px]"
        >
          {processingVideoClip ? <RefreshCw className="mr-1 h-3 w-3 animate-spin" /> : <Film className="mr-1 h-3 w-3" />}
          {selectedVideoClip.processedClip ? "Rebuild MP4 Preview" : "Generate MP4 Preview"}
        </Button>
        {selectedVideoClip.processedClip && (
          <>
            <Button
              type="button"
              size="sm"
              onClick={sendSelectedVideoClipForReview}
              disabled={loading || uploadingImages || processingVideoClip}
              className="h-7 px-2 text-[11px]"
            >
              Send Clip to Sarah
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={resetVideoClipForNextRange}
              className="h-7 px-2 text-[11px]"
            >
              Next Clip
            </Button>
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => {
                updateSelectedVideoClip({ processedClip: null, processingStatus: "Marks unlocked for editing." });
                seekVideoPreview(selectedVideoClip.startSeconds);
              }}
              className="h-7 px-2 text-[11px]"
            >
              Edit This Clip
            </Button>
          </>
        )}
        <span className="text-[10px] text-muted-foreground">
          {selectedVideoClip.processedClip
            ? "Add or edit the caption in the text box, then send the clip for review."
            : `Sarah gets ${VIDEO_FRAME_SAMPLE_COUNT} timestamped stills plus a local motion summary from this range.`}
        </span>
      </div>
      {selectedVideoClip.processingStatus && (
        <p className={`mt-2 text-[10px] ${selectedVideoClip.processedClip ? "text-emerald-400" : "text-muted-foreground"}`}>
          {selectedVideoClip.processingStatus}
        </p>
      )}
    </div>
    );
  };

  const renderMessageImages = (attachments = []) => {
    if (!attachments?.length) return null;
    const videoClipMap = new Map();
    const regularImages = [];
    attachments.forEach((image) => {
      const video = image.sourceVideo || null;
      const clipUrl = video?.processedClipUrl;
      if (clipUrl) {
        const key = `${clipUrl}|${video.startSeconds}|${video.endSeconds}`;
        if (!videoClipMap.has(key)) videoClipMap.set(key, video);
      } else {
        regularImages.push(image);
      }
    });
    const videoClips = [...videoClipMap.values()];

    return (
      <div className="mb-2 space-y-2">
        {videoClips.map((video) => (
          <div key={`${video.processedClipUrl}-${video.startSeconds}-${video.endSeconds}`} className="overflow-hidden rounded-lg border border-white/20 bg-black/20">
            <div className="flex flex-wrap items-center justify-between gap-2 px-2 py-1 text-[10px] opacity-85">
              <span className="truncate font-semibold">{video.label || video.filename || "Attached video clip"}</span>
              <span className="shrink-0">
                {formatSeconds(video.timelineStartSeconds ?? video.startSeconds)}-{formatSeconds(video.timelineEndSeconds ?? video.endSeconds)}
              </span>
            </div>
            <video src={video.processedClipUrl} controls className="max-h-[28rem] w-full bg-black object-contain" />
          </div>
        ))}
        {regularImages.length > 0 && (
          <div className="grid grid-cols-2 gap-2">
            {regularImages.map((image) => (
        <a
          key={image.id || image.storagePath || image.previewUrl}
          href={image.previewUrl || image.storagePath}
          target="_blank"
          rel="noreferrer"
          className="block overflow-hidden rounded-lg border border-white/20 bg-black/10"
          onClick={(event) => event.stopPropagation()}
        >
          <img src={image.previewUrl || image.storagePath} alt={image.filename || "Attached image"} className="aspect-square w-full object-cover" />
          <span className="block truncate px-1.5 py-1 text-[10px] opacity-80">{image.filename || "image"}</span>
        </a>
            ))}
          </div>
        )}
      </div>
    );
  };

  const renderAttachButton = () => (
    <>
      <input
        ref={imageInputRef}
        type="file"
        accept={[...ALLOWED_IMAGE_TYPES, ...ALLOWED_VIDEO_TYPES, ...ALLOWED_VIDEO_EXTENSIONS].join(",")}
        multiple
        className="hidden"
        onChange={(event) => {
          const files = Array.from(event.target.files || []);
          const videos = files.filter((file) => isAllowedVideoFile(file));
          const images = files.filter((file) => ALLOWED_IMAGE_TYPES.includes(file.type));
          if (videos[0]) handleVideoFile([videos[0]]);
          if (images.length) handleImageFiles(images);
        }}
      />
      <input
        ref={videoInputRef}
        type="file"
        accept={[...ALLOWED_VIDEO_TYPES, ...ALLOWED_VIDEO_EXTENSIONS].join(",")}
        className="hidden"
        onChange={(event) => handleVideoFile(event.target.files)}
      />
      <button
        type="button"
        onClick={() => imageInputRef.current?.click()}
        disabled={loading || transcribing || uploadingImages || processingVideoClip || selectedImages.length >= MAX_IMAGE_COUNT}
        title="Attach images for Sarah"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-all hover:text-foreground disabled:opacity-40"
      >
        <Paperclip className="h-4 w-4" />
      </button>
      <button
        type="button"
        onClick={() => videoInputRef.current?.click()}
        disabled={loading || transcribing || uploadingImages || processingVideoClip || selectedImages.length >= MAX_IMAGE_COUNT}
        title="Select a local video clip for Sarah"
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-all hover:text-foreground disabled:opacity-40"
      >
        <Film className="h-4 w-4" />
      </button>
    </>
  );

  const renderComposerControls = () => (
    <div className="flex items-center justify-end gap-2">
      {renderAttachButton()}
      <button
        onClick={recording ? stopRecording : startRecording}
        disabled={loading || transcribing || uploadingImages}
        title={recording ? "Stop recording" : "Tap to dictate"}
        className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-lg transition-all disabled:opacity-40 ${recording ? "bg-destructive text-destructive-foreground animate-pulse" : "bg-muted text-muted-foreground hover:text-foreground"}`}
      >
        {transcribing
          ? <span className="h-3.5 w-3.5 rounded-full border-2 border-primary border-t-transparent animate-spin" />
          : recording ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
      </button>
      <button
        onClick={sendMessage}
        disabled={effectiveSendDisabled}
        className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground transition-opacity disabled:opacity-40"
      >
        {uploadingImages || processingVideoClip ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent" /> : <Send className="h-4 w-4" />}
      </button>
    </div>
  );

  const copyAssistantMessage = async (text, index) => {
    try {
      await navigator.clipboard.writeText(String(text || "").trim());
      setCopiedIndex(index);
      window.setTimeout(() => setCopiedIndex(null), 1800);
    } catch {
      setCopiedIndex(null);
    }
  };

  return (
    <div className={panelClass}>
      {/* Header */}
      <div className={`flex items-center gap-2 bg-muted/40 px-4 py-3 text-left ${fullScreen ? "border-b border-border" : ""}`}>
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => {
            if (fullScreen) return;
            open ? setOpen(false) : handleOpen();
          }}
        >
          <SarahAvatar className="h-8 w-8" />
          <span className="truncate text-xs font-semibold text-foreground">
            {mode === "profile" ? "Sarah Profile Chat" : "Sarah Session Chat"}
          </span>
          {hasMessages && (
            <span className="shrink-0 text-[10px] text-muted-foreground">{messages.length} msg{messages.length !== 1 ? "s" : ""}</span>
          )}
        </button>
        {open && (
          <button
            onClick={(e) => { e.stopPropagation(); if (ttsEnabled) stopSpeaking(); setTtsEnabled((v) => !v); }}
            title={ttsEnabled ? "Read questions aloud (on)" : "Read questions aloud (off)"}
            className="p-1 rounded-md transition-colors hover:bg-black/10"
          >
            {ttsEnabled
              ? <Volume2 className="w-4 h-4 text-accent" />
              : <VolumeX className="w-4 h-4 text-muted-foreground" />}
          </button>
        )}
        {open && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              fullScreen ? setFullScreen(false) : openFullScreen();
            }}
            title={fullScreen ? "Exit full screen" : "Open full screen"}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-black/10 hover:text-foreground"
          >
            {fullScreen ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
          </button>
        )}
        {!fullScreen && (
          <button
            type="button"
            onClick={() => open ? setOpen(false) : handleOpen()}
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-black/10 hover:text-foreground"
            title={open ? "Collapse" : "Expand"}
          >
            {open ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
          </button>
        )}
      </div>

      {open && (
        <div className={bodyClass}>
          {!fullScreen && (
            <p className="text-[11px] text-muted-foreground">
              {mode === "profile"
                ? "Start a conversation about your physiology and arousal. Findings save automatically to your profile Q&A."
                : "Ask anything about this session or share observations. Findings are saved to session notes."}
            </p>
          )}

          {/* Message thread or input prompt */}
          {messages.length === 0 ? (
            <div className={`${fullScreen ? "mx-auto mt-auto w-full max-w-4xl pb-4" : ""} space-y-2`}>
              {renderSavedVideoClips()}
              {renderSelectedImages()}
              {imageError && <p className="text-xs text-destructive">{imageError}</p>}
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => setInput(e.target.value)}
                onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), sendMessage())}
                placeholder={transcribing ? "Transcribing…" : recording ? "Recording… tap mic to stop" : `Tell Sarah something about your ${mode === "profile" ? "physiology" : "session"}…`}
                disabled={loading || transcribing || uploadingImages}
                rows={3}
                className={textareaClass}
              />
              {renderComposerControls()}
            </div>
          ) : (
            <div className={threadClass}>
              {messages.map((msg, i) => (
                <div
                  key={i}
                  ref={(el) => {
                    if (el) messageRefs.current.set(i, el);
                    else messageRefs.current.delete(i);
                  }}
                  className={`scroll-mt-4 flex gap-2 items-start ${msg.role === "user" ? "flex-row-reverse" : ""}`}
                >
                  {msg.role === "assistant" && (
                    <SarahAvatar className="mt-0.5 h-8 w-8" />
                  )}
                  <div
                    className={messageClass(msg.role)}
                    onClick={msg.role === "assistant" ? () => toggleSpeechForMessage(msg.text, i) : undefined}
                    title={msg.role === "assistant" ? (ttsStatus?.idx === i && ttsStatus.phase === "paused" ? "Tap to resume" : speakingIdx === i ? "Tap to pause" : "Tap to hear") : undefined}
                  >
                    {renderMessageImages(msg.imageAttachments)}
                    <MessageMarkdown text={msg.text} />
                    {msg.role === "assistant" && (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          copyAssistantMessage(msg.text, i);
                        }}
                        className="ml-2 inline-flex align-middle rounded p-0.5 text-muted-foreground hover:text-foreground"
                        title="Copy response"
                      >
                        {copiedIndex === i ? <Check className="h-3.5 w-3.5 text-emerald-400" /> : <Copy className="h-3.5 w-3.5" />}
                      </button>
                    )}
                    {msg.role === "assistant" && speakingIdx === i && (
                      <span className="ml-2 inline-flex items-center gap-0.5">
                        <span className="w-1 h-2 bg-accent rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                        <span className="w-1 h-3 bg-accent rounded-full animate-bounce" style={{ animationDelay: "100ms" }} />
                        <span className="w-1 h-2 bg-accent rounded-full animate-bounce" style={{ animationDelay: "200ms" }} />
                      </span>
                    )}
                    {msg.role === "assistant" && ttsStatus?.idx === i && (
                      <div className={`mt-2 flex max-w-full items-center gap-2 rounded-lg border px-2 py-1 text-[10px] ${ttsStatusClass(ttsStatus.phase)}`}>
                        {["preparing", "fetching"].includes(ttsStatus.phase) && (
                          <span className="h-2.5 w-2.5 shrink-0 rounded-full border-2 border-current border-t-transparent animate-spin" />
                        )}
                        {ttsStatus.phase === "playing" && (
                          <span className="inline-flex shrink-0 items-end gap-0.5">
                            <span className="h-2 w-1 rounded-full bg-current animate-bounce" style={{ animationDelay: "0ms" }} />
                            <span className="h-3 w-1 rounded-full bg-current animate-bounce" style={{ animationDelay: "100ms" }} />
                            <span className="h-2 w-1 rounded-full bg-current animate-bounce" style={{ animationDelay: "200ms" }} />
                          </span>
                        )}
                        {ttsStatus.phase === "paused" && <span className="h-2.5 w-2.5 shrink-0 rounded-sm bg-current" />}
                        {ttsStatus.phase === "error" && <span className="h-2 w-2 shrink-0 rounded-full bg-current" />}
                        <span className="min-w-0 flex-1 truncate">{ttsStatusLabel(ttsStatus)}</span>
                        {ttsStatus.phase === "error" && (
                          <button
                            type="button"
                            onClick={(event) => {
                              event.stopPropagation();
                              speakText(msg.text, i);
                            }}
                            className="shrink-0 rounded border border-current/30 px-1.5 py-0.5 font-semibold hover:bg-current/10"
                          >
                            Retry
                          </button>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              ))}

              {loading && (
                <div className="flex gap-2 items-start">
                  <SarahAvatar className="h-8 w-8" />
                  <div className="max-w-[min(85%,38rem)] rounded-xl rounded-tl-sm border border-accent/20 bg-muted/70 px-3 py-2">
                    <div className="flex items-center gap-2">
                      {uploadingImages || processingVideoClip ? <ImageIcon className="h-3.5 w-3.5 text-accent" /> : null}
                      <span className="w-2 h-2 bg-muted-foreground rounded-full animate-bounce" style={{ animationDelay: "0ms" }} />
                      <span className="w-2 h-2 bg-muted-foreground rounded-full animate-bounce" style={{ animationDelay: "150ms" }} />
                      <span className="w-2 h-2 bg-muted-foreground rounded-full animate-bounce" style={{ animationDelay: "300ms" }} />
                      <span className="text-xs font-semibold text-foreground">
                        {chatProcessingStatus?.message || "Sarah is analyzing"}
                      </span>
                    </div>
                    {chatProcessingStatus?.detail && (
                      <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{chatProcessingStatus.detail}</p>
                    )}
                    <span className="sr-only">{chatProcessingStatus?.message || "Sarah is analyzing"}</span>
                  </div>
                </div>
              )}
              <div ref={bottomRef} />

              {/* Input — shown after messages start */}
              {renderSavedVideoClips()}
              {renderSelectedImages()}
              {imageError && <p className="text-xs text-destructive">{imageError}</p>}
              <div className={composerClass}>
                <textarea
                    ref={inputRef}
                    value={input}
                    onChange={(e) => setInput(e.target.value)}
                    onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && (e.preventDefault(), sendMessage())}
                    placeholder={transcribing ? "Transcribing…" : recording ? "Recording… tap mic to stop" : "Type or speak your response…"}
                    disabled={loading || transcribing || uploadingImages}
                    rows={5}
                    className={textareaClass}
                  />
                {renderComposerControls()}
              </div>
              </div>
              )}

          {selectedVideoClip && (
            <div className={fullScreen ? "min-h-0 shrink-0" : ""}>
              {renderSelectedVideoClip()}
            </div>
          )}

          {mode === "profile" && Array.isArray(recentSavedFindings) && recentSavedFindings.length > 0 && !fullScreen && (
            <div className="rounded-lg border border-primary/20 bg-primary/[0.06] p-3 text-xs">
              <p className="font-semibold uppercase tracking-wider text-primary">Recently Logged Findings</p>
              <div className="mt-2 grid gap-2">
                {recentSavedFindings.slice(0, 3).map((entry) => (
                  <article key={entry.id} className="rounded-md border border-border/70 bg-background/45 p-2">
                    <div className="mb-1 flex flex-wrap items-center justify-between gap-2">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-primary">{entry.timestamp || entry.date || "Saved"}</p>
                      <div className="flex items-center gap-1.5">
                        {entry.needs_review && (
                          <span className="rounded-full border border-chart-3/40 bg-chart-3/10 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-chart-3">
                            review
                          </span>
                        )}
                        <span className="rounded-full border border-border bg-muted/40 px-1.5 py-0.5 text-[9px] uppercase tracking-wider text-muted-foreground">
                          {entry.sourceLabel || "saved"}
                        </span>
                      </div>
                    </div>
                    <p className="line-clamp-2 text-xs leading-relaxed text-foreground">{entry.finding}</p>
                  </article>
                ))}
              </div>
            </div>
          )}

          {mode === "profile" && latestSavedFinding && !fullScreen && !recentSavedFindings?.length && (
            <div className="rounded-lg border border-primary/20 bg-primary/[0.06] p-3 text-xs">
              <p className="font-semibold uppercase tracking-wider text-primary">Most Recent Saved Finding</p>
              <p className="mt-1 text-[10px] text-muted-foreground">{latestSavedFinding.date || "Saved Q&A"}</p>
              <ul className="mt-2 space-y-1 text-foreground">
                {(latestSavedFinding.findings || []).slice(0, 4).map((finding, index) => (
                  <li key={`${latestSavedFinding.id || "latest"}-${index}`} className="leading-relaxed">• {finding}</li>
                ))}
              </ul>
            </div>
          )}

          {/* Actions */}
          {hasUserReplied && (
            <div className="flex items-center gap-2 pt-2 border-t border-border flex-wrap">
              <Button
                size="sm"
                variant="outline"
                onClick={saveFindings}
                disabled={savingFindings}
                className="h-7 text-xs gap-1.5"
              >
                {savingFindings
                  ? <><span className="w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />Saving…</>
                  : savedFeedback
                  ? <><Save className="w-3 h-3 text-primary" />Saved!</>
                  : <><Save className="w-3 h-3" />{mode === "profile" ? "Save Findings Again" : "Save Findings"}</>}
              </Button>
              <button
                onClick={() => { clearAudioCache(); setMessages([]); onSaveMessages?.([]); }}
                className="flex items-center gap-1 text-[10px] text-muted-foreground hover:text-foreground transition-colors ml-auto"
              >
                <RefreshCw className="w-3 h-3" /> Clear chat
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
