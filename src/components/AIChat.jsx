import { useCallback, useState, useRef, useEffect } from "react";
import ReactMarkdown from "react-markdown";
import { ArrowLeft, Send, ChevronDown, ChevronUp, Save, RefreshCw, Mic, MicOff, Volume2, VolumeX, Copy, Check, Maximize2, Paperclip, X, Image as ImageIcon, Film } from "lucide-react";
import { mergeDatedChatFindings } from "@/lib/chatFindings";
import { Button } from "@/components/ui/button";
import { base44 } from "@/api/base44Client";
import { cleanTextForSpeech, getTTSMime, getTTSRuntime, prepareTTSInput, splitIntoChunks, TTS_CHUNK_TARGET_CHARS, TTS_PLAYBACK_FORMAT } from "@/components/TTSButton";
import { ANATOMICAL_REFERENCE_FOCUS_RULE, buildAIGroundingContext } from "@/lib/aiGrounding";
import { extractVisualMediaContextFromConversation } from "@/lib/visualEvidence";
import { serverUrl } from "@/lib/mobileApiBase";
import { startBackgroundJob, waitForBackgroundJob } from "@/lib/backgroundJobs";
import { buildSarahVsVitalsPromptContext } from "@/lib/sarahVsVitalsContext";
import { finalizeWhisperTranscript } from "@/utils/whisperTranscript";
import { SarahAvatar } from "@/components/SarahBrand";
import { SARAH_CLINICAL_REASONING_CALIBRATION_RULE } from "@/utils/clinicalReasoningCalibration";
import { buildSarahPersonalityPrompt, readSarahPersonalitySettings, SARAH_PERSONALITY_EVENT } from "@/utils/sarahPersonality";
import { readSttProviderPreference } from "@/lib/sttSettings";

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
const VOICE_AUTO_STOP_ENABLED = true;
const VOICE_AUTO_STOP_SILENCE_MS = 3600;
const VOICE_AUTO_STOP_RMS = 0.024;
const VOICE_AUTO_STOP_MIN_RECORDING_MS = 1200;
const OPTIONAL_VITALS_CONTEXT_TIMEOUT_MS = 3500;
const REVIEW_PREP_SLOW_HINT_MS = 12000;
const REVIEW_BACKGROUND_SLOW_HINT_MS = 45000;
const CHAT_PROVIDER_HISTORY_LIMIT = 10;
const CHAT_INTERACTIVE_HISTORY_LIMIT = 6;
const CHAT_HISTORY_MESSAGE_MAX_CHARS = 520;
const CHAT_INTERACTIVE_CONTEXT_MAX_CHARS = 4200;
const CHAT_VISUAL_REVIEW_CONTEXT_MAX_CHARS = 9000;

function getSpeechRecognitionConstructor() {
  if (typeof window === "undefined") return null;
  return window.SpeechRecognition || window.webkitSpeechRecognition || null;
}

function compactSpeechPreview(value = "") {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function clipPromptText(value = "", maxChars = 800) {
  const normalized = String(value || "").replace(/\s+\n/g, "\n").trim();
  if (!normalized || normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, Math.max(0, maxChars - 29)).trimEnd()}\n\n[truncated for faster live chat]`;
}

function buildPromptHistory(messages = [], options = {}) {
  const {
    limit = CHAT_PROVIDER_HISTORY_LIMIT,
    perMessageChars = CHAT_HISTORY_MESSAGE_MAX_CHARS,
  } = options;
  return messages
    .slice(-Math.max(1, limit))
    .map((m) => {
      const attachmentLine = m.imageAttachments?.length ? ` [${m.imageAttachments.length} attached image${m.imageAttachments.length === 1 ? "" : "s"}]` : "";
      return `${m.role === "user" ? "User" : "AI"} (${formatMessagePromptTime(m)}): ${clipPromptText(m.text, perMessageChars)}${attachmentLine}`;
    })
    .join("\n");
}

function buildMessageSyncKey(messages = []) {
  return messages.map((message) => [
    message?.role || "",
    message?.createdAt || "",
    message?.text || "",
    message?.imageAttachments?.length || 0,
  ].join("::")).join("\u241e");
}

function lastSpokenWord(value = "") {
  const words = compactSpeechPreview(value).match(/[\p{L}\p{N}'-]+/gu);
  return words?.length ? words[words.length - 1] : "";
}

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
  const message = extractProviderErrorMessage(error) || "Speech-to-text failed.";
  if (/Invalid URL\s+\(POST\s+\/v1\/audio\/transcriptions\)/i.test(message)) {
    return "Whisper is using a stale transcription route. Restart the local Sarah API or rebuild/reopen the Android app, then try the mic again.";
  }
  if (/GROQ_API_KEY|OPENAI_API_KEY|speech-to-text provider is not configured|OpenAI transcription is not configured|Groq speech-to-text is not configured/i.test(message)) {
    return "Speech-to-text is not configured on the Sarah backend. Add GROQ_API_KEY for Groq, or enable OpenAI transcription, then try the mic again.";
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
  if (/local background job api did not respond/i.test(message)) {
    return "Sarah could not hand this review off to the desktop worker in time. Check that the local Sarah desktop API is awake and reachable, then try again.";
  }
  return message;
}

function friendlyMicError(error) {
  const name = String(error?.name || "");
  const message = String(error?.message || "");
  const combined = `${name} ${message}`;
  if (/notallowed|permission|denied/i.test(combined)) {
    return "Microphone permission is blocked for Sarah. Open Android app settings for Sarah, allow Microphone, then reopen the APK.";
  }
  if (/notfound|devicesnotfound/i.test(combined)) {
    return "No microphone was reported by Android for this app.";
  }
  if (/notreadable|trackstarterror|in use/i.test(combined)) {
    return "Android could not open the microphone. Another app may be using it; close recorder/camera apps and try again.";
  }
  if (/mediarecorder|mime|unsupported/i.test(combined)) {
    return "This Android WebView could access the mic but could not start the recorder format.";
  }
  return message || "Microphone recording could not start.";
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

function supportedAudioMimeType() {
  if (typeof MediaRecorder === "undefined") return "";
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
    "audio/ogg;codecs=opus",
    "audio/ogg",
  ];
  return candidates.find((type) => {
    try {
      return MediaRecorder.isTypeSupported(type);
    } catch {
      return false;
    }
  }) || "";
}

function formatSeconds(value) {
  const seconds = Math.max(0, Number(value) || 0);
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds - minutes * 60;
  return minutes ? `${minutes}:${remainder.toFixed(1).padStart(4, "0")}` : `${remainder.toFixed(1)}s`;
}

function localDateTimeParts(dateLike = new Date()) {
  if (!dateLike) return null;
  const date = dateLike instanceof Date ? dateLike : new Date(dateLike);
  if (Number.isNaN(date.getTime())) return null;
  const locale = typeof navigator !== "undefined" ? navigator.language : undefined;
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || "local timezone";
  return {
    date,
    locale,
    timezone,
    iso: date.toISOString(),
    shortTime: new Intl.DateTimeFormat(locale, {
      hour: "numeric",
      minute: "2-digit",
    }).format(date),
    full: new Intl.DateTimeFormat(locale, {
      weekday: "long",
      month: "long",
      day: "numeric",
      year: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    }).format(date),
  };
}

function messageCreatedAt(message) {
  return message?.createdAt || message?.created_at || message?.timestamp || message?.sentAt || null;
}

function formatMessageDisplayTime(message) {
  const parts = localDateTimeParts(messageCreatedAt(message));
  return parts?.shortTime || "earlier";
}

function formatMessagePromptTime(message) {
  const parts = localDateTimeParts(messageCreatedAt(message));
  return parts?.full || "older saved message; exact local time not stored";
}

function buildLocalTimeContext() {
  const parts = localDateTimeParts(new Date());
  if (!parts) return "";
  return `LOCAL TIME CONTEXT:
- The user's current local time is ${parts.full}.
- Browser timezone: ${parts.timezone}.
- Current UTC timestamp: ${parts.iso}.
- Use this for natural clinical/conversational timeline acknowledgement when relevant, such as "earlier today", "tonight", "this morning", or "a few minutes ago".
- Do not overdo time references; include them only when they help orient the conversation or timeline.`;
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

function formatElapsedShort(totalSeconds = 0) {
  const seconds = Math.max(0, Math.floor(Number(totalSeconds) || 0));
  if (seconds < 60) return `${seconds}s`;
  return `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

async function withTimeout(promise, timeoutMs, message = "Request timed out.") {
  let timeoutId = null;
  const timeoutPromise = new Promise((_, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error(message)), Math.max(1, Number(timeoutMs) || 0));
  });
  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    if (timeoutId) window.clearTimeout(timeoutId);
  }
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
  extraReviewContext = "",
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
  sessionVideoSources = [],
  pendingTimestampReview = null,
  onSaveMessages,
  onSaveNotes,
  autoScrollOnMount = true,
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
  const [liveSpeechPreview, setLiveSpeechPreview] = useState("");
  const [liveSpeechLastWord, setLiveSpeechLastWord] = useState("");
  const [liveSpeechSupported, setLiveSpeechSupported] = useState(() => Boolean(getSpeechRecognitionConstructor()));
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
  const [chatProcessingElapsedSeconds, setChatProcessingElapsedSeconds] = useState(0);
  const [activeReplyJobId, setActiveReplyJobId] = useState("");
  const [imageError, setImageError] = useState("");
  const [uploadingImages, setUploadingImages] = useState(false);
  const [sarahPersonality, setSarahPersonality] = useState(() => readSarahPersonalitySettings());
  const bottomRef = useRef(null);
  const messageRefs = useRef(new Map());
  const inputRef = useRef(null);
  const imageInputRef = useRef(null);
  const videoInputRef = useRef(null);
  const videoPreviewRef = useRef(null);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const micStreamRef = useRef(null);
  const speechRecognitionRef = useRef(null);
  const liveSpeechPreviewRef = useRef("");
  const speechDetectedRef = useRef(false);
  const silenceStartRef = useRef(null);
  const suppressNextTranscriptionRef = useRef(false);
  const vadFrameRef = useRef(null);
  const audioContextRef = useRef(null);
  const audioRef = useRef(null);
  const audioUrlCacheRef = useRef(new Map());
  const ttsRequestIdRef = useRef(0);
  const lastAssistantScrollKeyRef = useRef("");
  const initialAutoScrollSuppressedRef = useRef(false);
  const lastTimestampReviewRequestRef = useRef("");

  const categories = mode === "profile" ? PROFILE_CATEGORIES : SESSION_CATEGORIES;
  const evidenceScope = ["profile", "session", "body_exploration"].includes(visualEvidenceScope) ? visualEvidenceScope : mode;
  const conversationSubject = subjectLabel || (mode === "profile" ? "physiological and arousal profile" : "session");
  const timelineOffsetSeconds = Number(clipTimelineOffsetSeconds) || 0;

  const fetchUrlAsFile = useCallback(async (url, filename = "session-video.mp4") => {
    const response = await fetch(serverUrl(url));
    if (!response.ok) throw new Error("Could not load the session video for frame review.");
    const blob = await response.blob();
    const type = blob.type || "video/mp4";
    return new File([blob], filename, { type });
  }, []);

  const nextChatStatus = useCallback((status = {}) => ({
    startedAt: status.startedAt || chatProcessingStatus?.startedAt || Date.now(),
    ...status,
  }), [chatProcessingStatus?.startedAt]);

  const buildSavedMomentVideoFrames = useCallback(async (clip) => {
    const directClipUrl = clip?.clip_url || clip?.url || clip?.file_url || "";
    const normalizedSessionVideoSource = Array.isArray(sessionVideoSources)
      ? sessionVideoSources.find((source) => (typeof source === "string" ? source : source?.url || source?.src))
      : null;
    const fallbackSessionVideoUrl = typeof normalizedSessionVideoSource === "string"
      ? normalizedSessionVideoSource
      : normalizedSessionVideoSource?.url || normalizedSessionVideoSource?.src || "";
    const sourceUrl = clip?.sourceUrl || directClipUrl || fallbackSessionVideoUrl;
    if (!sourceUrl) return [];

    setChatProcessingStatus(nextChatStatus({
      phase: "processing",
      message: "Loading source video",
      detail: `Opening ${clip?.sourceLabel || clip?.label || "the saved session video"} so Sarah can sample still frames.`,
    }));

    const timelineOffset = Number(
      clip?.timelineOffsetSeconds
      ?? normalizedSessionVideoSource?.timelineOffsetSeconds
      ?? 0
    ) || 0;
    const sourceFile = await fetchUrlAsFile(sourceUrl, clip?.filename || clip?.label || "saved-session-moment.mp4");
    setChatProcessingStatus(nextChatStatus({
      phase: "processing",
      message: "Mapping the review window",
      detail: "Reading video metadata and aligning the requested moment to the session timeline.",
    }));
    const loadedDuration = await loadVideoMetadata(sourceFile);
    const hasDirectClipSource = Boolean(directClipUrl);
    const timelineRangeStart = Number.isFinite(Number(clip?.startSeconds))
      ? Number(clip.startSeconds)
      : Number.isFinite(Number(clip?.session_time_s))
        ? Math.max(0, Number(clip.session_time_s) - 4)
        : 0;
    const timelineRangeEnd = Number.isFinite(Number(clip?.endSeconds))
      ? Number(clip.endSeconds)
      : Number.isFinite(Number(clip?.session_time_s))
        ? Number(clip.session_time_s) + 4
        : Math.max(6, loadedDuration || 6);
    const localRangeStart = Math.max(0, timelineRangeStart - timelineOffset);
    const localRangeEnd = Math.max(localRangeStart + 0.3, timelineRangeEnd - timelineOffset);
    const sampleStart = hasDirectClipSource ? 0 : localRangeStart;
    const sampleEnd = hasDirectClipSource
      ? Math.max(0.3, loadedDuration || Number(clip?.durationSeconds) || 6)
      : Math.max(localRangeStart + 0.3, Math.min(localRangeEnd, loadedDuration || localRangeEnd));
    const timelineStartSeconds = Number.isFinite(Number(clip?.startSeconds))
      ? Number(clip.startSeconds)
      : Number.isFinite(Number(clip?.session_time_s))
        ? Math.max(0, Number(clip.session_time_s) - ((sampleEnd - sampleStart) / 2))
        : sampleStart;
    const timelineEndSeconds = Number.isFinite(Number(clip?.endSeconds))
      ? Number(clip.endSeconds)
      : timelineStartSeconds + (sampleEnd - sampleStart);
    const label = clip?.label?.trim() || "saved session moment";

    setChatProcessingStatus(nextChatStatus({
      phase: "sampling",
      message: "Pulling saved moment frames",
      detail: `Sampling ${Math.min(VIDEO_FRAME_SAMPLE_COUNT, MAX_IMAGE_COUNT - selectedImages.length)} stills from ${formatTimePhrase(timelineStartSeconds)} to ${formatTimePhrase(timelineEndSeconds)} for Sarah's review.`,
    }));

    const frames = await sampleVideoFrames({
      file: sourceFile,
      startSeconds: sampleStart,
      endSeconds: sampleEnd,
      label,
      maxFrames: Math.min(VIDEO_FRAME_SAMPLE_COUNT, MAX_IMAGE_COUNT - selectedImages.length),
    });

    return frames.map((frame, index) => ({
      id: makeId("saved-moment-frame"),
      file: frame.file,
      filename: frame.filename,
      mimeType: "image/jpeg",
      sizeBytes: frame.file.size,
      previewUrl: frame.dataUrl,
      createdAt: new Date().toISOString(),
      sourceVideo: {
        filename: sourceFile.name,
        label,
        startSeconds: sampleStart,
        endSeconds: sampleEnd,
        frameTimeSeconds: Number(frame.time.toFixed(2)),
        timelineStartSeconds,
        timelineEndSeconds,
        frameTimelineSeconds: Number((timelineStartSeconds + (frame.time - sampleStart)).toFixed(2)),
        timelineLabel: clip?.timelineLabel || (hasDirectClipSource ? "saved moment clip" : "session video"),
        frameIndex: index + 1,
        processedClipUrl: hasDirectClipSource ? serverUrl(sourceUrl) : "",
        motionSummary: null,
      },
    }));
  }, [fetchUrlAsFile, nextChatStatus, selectedImages.length, sessionVideoSources]);

  useEffect(() => {
    const incoming = Array.isArray(savedMessages) ? savedMessages : [];
    const incomingKey = buildMessageSyncKey(incoming);
    setMessages((current) => {
      const currentKey = buildMessageSyncKey(current);
      if (currentKey === incomingKey) return current;
      const hasUnsyncedLocalTail = current.length > incoming.length && (loading || Boolean(activeReplyJobId));
      if (hasUnsyncedLocalTail) return current;
      return incoming;
    });
  }, [savedMessages, loading, activeReplyJobId]);

  useEffect(() => {
    const handlePersonalityUpdate = (event) => {
      if (event?.detail) {
        setSarahPersonality(event.detail);
        return;
      }
      setSarahPersonality(readSarahPersonalitySettings());
    };
    if (typeof window === "undefined") return undefined;
    window.addEventListener(SARAH_PERSONALITY_EVENT, handlePersonalityUpdate);
    window.addEventListener("storage", handlePersonalityUpdate);
    return () => {
      window.removeEventListener(SARAH_PERSONALITY_EVENT, handlePersonalityUpdate);
      window.removeEventListener("storage", handlePersonalityUpdate);
    };
  }, []);

  const isMobileViewport = useCallback(() => (
    typeof window !== "undefined" && window.matchMedia?.("(max-width: 640px)")?.matches
  ), []);

  const scrollToBottom = useCallback((behavior = "smooth") => {
    requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ behavior, block: "end" }));
  }, []);

  useEffect(() => {
    if (!autoScrollOnMount && !initialAutoScrollSuppressedRef.current) {
      initialAutoScrollSuppressedRef.current = true;
      return;
    }
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
  }, [autoScrollOnMount, messages, loading, isMobileViewport, open, fullScreen, scrollToBottom]);

  useEffect(() => {
    if (!autoScrollOnMount && !initialAutoScrollSuppressedRef.current) return;
    if ((open || fullScreen) && autoScrollOnMount) scrollToBottom("auto");
  }, [autoScrollOnMount, open, fullScreen, scrollToBottom]);

  useEffect(() => () => {
    audioUrlCacheRef.current.forEach((url) => URL.revokeObjectURL(url));
    audioUrlCacheRef.current.clear();
    if (vadFrameRef.current) cancelAnimationFrame(vadFrameRef.current);
    speechRecognitionRef.current?.abort?.();
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
    const startedAt = Number(chatProcessingStatus?.startedAt || 0);
    if (!startedAt) {
      setChatProcessingElapsedSeconds(0);
      return undefined;
    }
    setChatProcessingElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    const timer = window.setInterval(() => {
      setChatProcessingElapsedSeconds(Math.max(0, Math.floor((Date.now() - startedAt) / 1000)));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [chatProcessingStatus?.startedAt]);

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

  const attachSavedVideoClipFrames = useCallback(async (clip) => {
    const clipPrompt = clip?.promptText
      || `Please review the saved moment "${clip.label || "session moment"}"${clip.session_time_s != null ? ` at ${formatTimePhrase(clip.session_time_s)}` : ""}. Focus on visible technique, body mechanics, telemetry, and what this moment likely represents in the session.`;
    const frames = Array.isArray(clip?.frames) ? clip.frames : [];
    if (!frames.length) {
      const slots = MAX_IMAGE_COUNT - selectedImages.length;
      if (slots <= 0) {
        setImageError(`Attach up to ${MAX_IMAGE_COUNT} images per message.`);
        return;
      }
      setProcessingVideoClip(true);
      try {
        const derivedFrames = await buildSavedMomentVideoFrames(clip);
        if (derivedFrames.length) {
          setSelectedImages((prev) => [...prev, ...derivedFrames].slice(0, MAX_IMAGE_COUNT));
          setImageError("");
          setInput((current) => current.trim() ? current : clipPrompt);
          return;
        }
      } catch (error) {
        setImageError(error?.message || "Could not pull frames for this saved moment.");
      } finally {
        setProcessingVideoClip(false);
      }
      setInput((current) => current.trim() ? current : clipPrompt);
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
    setInput((current) => current.trim() ? current : clipPrompt);
  }, [buildSavedMomentVideoFrames, selectedImages.length]);

  useEffect(() => {
    const requestId = String(pendingTimestampReview?.requestId || "");
    if (!requestId || lastTimestampReviewRequestRef.current === requestId) return;
    lastTimestampReviewRequestRef.current = requestId;

    const sessionSeconds = Math.max(0, Number(pendingTimestampReview?.timeSeconds) || 0);
    const promptText = `Please review the current session video moment at ${formatTimePhrase(sessionSeconds)}. Focus on visible technique, body mechanics, telemetry overlays, and what this moment likely represents in the session.`;
    setOpen(true);
    setImageError("");
    setChatProcessingStatus({
      phase: "queued",
      message: "Preparing moment review",
      detail: `Pulling frames from ${pendingTimestampReview?.sourceLabel || "the session video"} at ${formatTimePhrase(sessionSeconds)} before Sarah responds.`,
    });
    attachSavedVideoClipFrames({
      label: pendingTimestampReview?.sourceLabel || "Session video",
      session_time_s: sessionSeconds,
      startSeconds: Math.max(0, sessionSeconds - 4),
      endSeconds: sessionSeconds + 4,
      sourceUrl: pendingTimestampReview?.sourceUrl || "",
      timelineOffsetSeconds: Number(pendingTimestampReview?.timelineOffsetSeconds) || 0,
      timelineLabel: "session timeline",
      promptText,
    }).catch((error) => {
      setImageError(error?.message || "Could not pull frames for this session moment.");
      setInput((current) => current.trim() ? current : promptText);
    });
  }, [attachSavedVideoClipFrames, pendingTimestampReview]);

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
    setChatProcessingStatus(nextChatStatus({
      phase: "processing",
      message: "Preparing local video clip",
      detail: `Building a short review clip from ${formatTimePhrase(selectedVideoClip.startSeconds)} to ${formatTimePhrase(selectedVideoClip.endSeconds)}.`,
    }));
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
      setChatProcessingStatus(nextChatStatus({
        phase: "ready",
        message: "Video preview ready",
        detail: "Sarah will receive sampled frames plus local motion timing from this clip.",
      }));
      return processed;
    } catch (error) {
      const message = error?.status === 404
        ? "Video processing endpoint is not available yet. Restart the local API server, then try Generate MP4 Preview again."
        : error?.message || "Could not process this video clip.";
      updateSelectedVideoClip({ processingStatus: message }, { keepProcessed: true });
      setChatProcessingStatus(nextChatStatus({ phase: "error", message: "Video clip processing failed", detail: message }));
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
        setChatProcessingStatus(nextChatStatus({
          phase: "sampling",
          message: "Extracting video evidence",
          detail: `Using ${processed.frames.length} sampled frames from ${formatTimePhrase(selectedVideoClip.startSeconds)} to ${formatTimePhrase(selectedVideoClip.endSeconds)}.`,
        }));
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
      setChatProcessingStatus(nextChatStatus({
        phase: "sampling",
        message: "Sampling video frames in the browser",
        detail: `Using ${Math.min(slots, VIDEO_FRAME_SAMPLE_COUNT)} frames from ${formatTimePhrase(selectedVideoClip.startSeconds)} to ${formatTimePhrase(selectedVideoClip.endSeconds)}.`,
      }));
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
    setChatProcessingStatus(nextChatStatus({
      phase: "uploading",
      message: videoFrames.length ? "Uploading sampled video frames" : "Uploading images",
      detail: videoFrames.length
        ? `${videoFrames.length} frame${videoFrames.length === 1 ? "" : "s"} are queued for Sarah's review. Starting attachment upload now.`
        : `${pendingImages.length} image${pendingImages.length === 1 ? "" : "s"} are being attached.`,
    }));
    const uploaded = [];
    const aiImages = [];
    try {
      for (let index = 0; index < pendingImages.length; index += 1) {
        const image = pendingImages[index];
        const isReused = Boolean(image.storagePath);
        setChatProcessingStatus(nextChatStatus({
          phase: "uploading",
          message: isReused ? "Reusing saved image evidence" : "Uploading attachments",
          detail: `${isReused ? "Using saved media" : "Uploading media"} ${index + 1} of ${pendingImages.length}: ${image.filename || "attachment"}.`,
        }));
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
      setChatProcessingStatus(nextChatStatus({
        phase: "processing",
        message: "Preparing Sarah review request",
        detail: `${pendingImages.length} attachment${pendingImages.length === 1 ? "" : "s"} are ready. Building the final request with session context, motion notes, and telemetry.`,
      }));
      return { metadata: uploaded, aiImages };
    } finally {
      setUploadingImages(false);
    }
  };

  const WHISPER_PROMPT =
    "Transcribe only words actually spoken. Do not add greetings, sign-offs, thank-yous, or commentary. " +
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

  const clearLiveSpeechPreview = () => {
    liveSpeechPreviewRef.current = "";
    setLiveSpeechPreview("");
    setLiveSpeechLastWord("");
  };

  const stopLiveSpeechRecognition = ({ clear = false } = {}) => {
    const recognition = speechRecognitionRef.current;
    speechRecognitionRef.current = null;
    if (recognition) {
      recognition.onresult = null;
      recognition.onerror = null;
      recognition.onend = null;
      try {
        recognition.stop();
      } catch {
        try {
          recognition.abort?.();
        } catch {}
      }
    }
    if (clear) clearLiveSpeechPreview();
  };

  const startLiveSpeechRecognition = () => {
    const SpeechRecognition = getSpeechRecognitionConstructor();
    setLiveSpeechSupported(Boolean(SpeechRecognition));
    clearLiveSpeechPreview();
    if (!SpeechRecognition) return false;

    stopLiveSpeechRecognition();
    try {
      const recognition = new SpeechRecognition();
      recognition.continuous = true;
      recognition.interimResults = true;
      recognition.maxAlternatives = 1;
      recognition.lang = navigator.language || "en-US";
      recognition.onresult = (event) => {
        let transcript = "";
        for (let index = 0; index < event.results.length; index += 1) {
          transcript += event.results[index]?.[0]?.transcript || "";
        }
        const preview = compactSpeechPreview(transcript);
        liveSpeechPreviewRef.current = preview;
        setLiveSpeechPreview(preview);
        setLiveSpeechLastWord(lastSpokenWord(preview));
      };
      recognition.onerror = (event) => {
        const code = String(event?.error || "");
        if (!["no-speech", "aborted"].includes(code)) {
          setLiveSpeechSupported(false);
        }
      };
      recognition.onend = () => {
        if (speechRecognitionRef.current === recognition) speechRecognitionRef.current = null;
      };
      speechRecognitionRef.current = recognition;
      recognition.start();
      return true;
    } catch {
      speechRecognitionRef.current = null;
      setLiveSpeechSupported(false);
      return false;
    }
  };

  const releaseVoiceCaptureForPlayback = () => {
    if (!recording && !micStreamRef.current && !audioContextRef.current) return;
    suppressNextTranscriptionRef.current = true;
    stopLiveSpeechRecognition({ clear: true });
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
    stopLiveSpeechRecognition({ clear: true });
    stopVad();
    stopMicStream();
    setRecording(false);
  };

  const startVad = (stream) => {
    stopVad();
    speechDetectedRef.current = false;
    silenceStartRef.current = null;
    const startedAt = Date.now();
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextClass) return;
    const audioContext = new AudioContextClass();
    audioContextRef.current = audioContext;
    audioContext.resume?.().catch(() => {});
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
      if (rms > VOICE_AUTO_STOP_RMS) {
        speechDetectedRef.current = true;
        silenceStartRef.current = null;
      } else if (speechDetectedRef.current) {
        if (!silenceStartRef.current) silenceStartRef.current = now;
        if (
          VOICE_AUTO_STOP_ENABLED
          && now - startedAt >= VOICE_AUTO_STOP_MIN_RECORDING_MS
          && now - silenceStartRef.current > VOICE_AUTO_STOP_SILENCE_MS
          && mediaRecorderRef.current?.state === "recording"
        ) {
          setChatProcessingStatus({
            phase: "processing",
            message: "Pause detected",
            detail: "Sarah stopped listening and is transcribing the voice note.",
          });
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
    inputRef.current?.blur();
    setImageError("");
    setChatProcessingStatus({
      phase: "processing",
      message: "Opening microphone",
      detail: "Android may ask for microphone permission.",
    });
    if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === "undefined") {
      setChatProcessingStatus({
        phase: "error",
        message: "Microphone unavailable",
        detail: "This app view does not expose browser microphone recording.",
      });
      return;
    }

    let stream = null;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true,
        },
      });
      micStreamRef.current = stream;
      audioChunksRef.current = [];
      const mimeType = supportedAudioMimeType();
      const mr = mimeType
        ? new MediaRecorder(stream, { mimeType })
        : new MediaRecorder(stream);
      const recorderMimeType = mr.mimeType || mimeType || "audio/webm";
      mediaRecorderRef.current = mr;
      mr.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
      mr.onerror = (event) => {
        const message = friendlyMicError(event?.error || event);
        setChatProcessingStatus({ phase: "error", message: "Microphone recorder failed", detail: message });
      };
      mr.onstop = async () => {
        stopLiveSpeechRecognition();
        stopVad();
        stream.getTracks().forEach((t) => t.stop());
        if (micStreamRef.current === stream) micStreamRef.current = null;
        setRecording(false);
        if (suppressNextTranscriptionRef.current) {
          suppressNextTranscriptionRef.current = false;
          audioChunksRef.current = [];
          setTranscribing(false);
          setChatProcessingStatus(null);
          clearLiveSpeechPreview();
          return;
        }
        setTranscribing(true);
        setChatProcessingStatus({
          phase: "processing",
          message: "Transcribing voice note",
          detail: "Sarah is sending the captured audio to local Whisper routing.",
        });
        try {
          const chunks = audioChunksRef.current.slice();
          if (!chunks.length) throw new Error("No audio was captured.");
          const blob = new Blob(chunks, { type: recorderMimeType });
          const ab = await blob.arrayBuffer();
          const bytes = new Uint8Array(ab);
          let bin = "";
          for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
          const base64 = btoa(bin);
          const liveReferenceText = liveSpeechPreviewRef.current;
          const res = await base44.functions.invoke("whisperSTT", {
            audio_base64: base64,
            mime_type: recorderMimeType,
            prompt: WHISPER_PROMPT,
            provider: readSttProviderPreference(),
          });
          const rawText = String(res?.text || res?.data?.text || "").trim();
          const text = finalizeWhisperTranscript(rawText, { referenceText: liveReferenceText });
          if (text) {
            setInput((prev) => (prev ? `${prev} ${text}` : text));
            setChatProcessingStatus(null);
            clearLiveSpeechPreview();
          } else {
            setChatProcessingStatus({
              phase: "ready",
              message: "No speech detected",
              detail: liveSpeechPreviewRef.current
                ? `Live preview heard: "${liveSpeechPreviewRef.current}". Whisper did not return usable final text.`
                : "The recording completed, but Whisper did not return usable text.",
            });
          }
        } catch (error) {
          const message = friendlyWhisperError(error);
          setImageError("");
          setChatProcessingStatus({ phase: "error", message: "Whisper transcription failed", detail: message });
        } finally {
          audioChunksRef.current = [];
          setTranscribing(false);
        }
      };
      mr.start(500);
      const livePreviewStarted = startLiveSpeechRecognition();
      setRecording(true);
      setChatProcessingStatus({
        phase: "recording",
        message: "Listening",
        detail: livePreviewStarted
          ? "Live word preview is on. Tap the mic to stop, or pause for a few seconds after speaking and Sarah will stop automatically."
          : "Tap the mic to stop, or pause for a few seconds after speaking and Sarah will stop automatically. This Android WebView does not expose live word preview.",
      });
      startVad(stream);
    } catch (error) {
      stopLiveSpeechRecognition({ clear: true });
      stopVad();
      stream?.getTracks?.().forEach((track) => track.stop());
      if (micStreamRef.current === stream) micStreamRef.current = null;
      setRecording(false);
      setTranscribing(false);
      setChatProcessingStatus({
        phase: "error",
        message: "Microphone could not start",
        detail: friendlyMicError(error),
      });
    }
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
    const localTimeContext = buildLocalTimeContext();
    const history = messageList.map((m) => `${m.role === "user" ? "User" : "AI"} (${formatMessagePromptTime(m)}): ${m.text}`).join("\n");
    const groundingContext = buildAIGroundingContext(userProfile);
    const sarahVsVitalsContext = await buildSarahVsVitalsPromptContext();
    const profileMechanicalContext = mode === "profile" ? `\n\n${PROFILE_MECHANICAL_RULE}` : "";
    const sarahPersonalityPrompt = buildSarahPersonalityPrompt(sarahPersonality, {
      isTechnical: false,
    });
    const res = await base44.integrations.Core.InvokeLLM({
      prompt: `${localTimeContext}\n\n${groundingContext}${profileMechanicalContext}\n\nBased on this Q&A conversation about a person's ${conversationSubject}, write 2-4 concise bullet points summarizing only the NEW factual findings from the user's answers that would be useful to persist for future AI analysis. Do not repeat generic information already obvious from the base data. Be specific and factual. Do not preserve assumptions about intent unless the person explicitly stated them. Write every saved bullet in direct second person using "you" and "your"; do not use the person's name, "the user", "he", "she", "his", or "her".\n\nConversation:\n${history}\n\nOutput as plain bullet points starting with "•":`,
      source: "ai_chat_findings_summary",
      priority: 25,
    });
    return typeof res === "string" ? res.trim() : res?.response?.trim() ?? "";
  };

  const persistFindings = async (messageList) => {
    setSavingFindings(true);
    try {
      const findings = await summarizeFindings(messageList);
      if (findings) {
        const timestamp = new Date().toISOString().slice(0, 10);
        const merged = mode === "profile"
          ? findings
          : mergeDatedChatFindings(savedNotes, timestamp, findings);
        await onSaveNotes?.(merged, {
          date: timestamp,
          source: mode === "profile" ? "profile_ai_interview" : `${evidenceScope}_ai_interview`,
          conversation: messageList,
        });
      }
      setSavedFeedback(true);
      setTimeout(() => setSavedFeedback(false), 3000);
    } finally {
      setSavingFindings(false);
    }
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

  const summarizeChatJobPhase = useCallback((job = {}) => {
    const progress = job?.progress || {};
    const counts = Number.isFinite(Number(progress.current)) && Number.isFinite(Number(progress.total)) && Number(progress.total) > 0
      ? ` Step ${Math.max(1, Math.round(Number(progress.current) + 1))} of ${Math.max(1, Math.round(Number(progress.total)))}.`
      : "";
    const phaseLabel = progress.phase ? ` Phase: ${String(progress.phase).replace(/_/g, " ")}.` : "";
    return {
      phase: job?.status === "queued" ? "queued" : "background",
      message: job?.status === "queued" ? "Queued for Sarah" : "Sarah is reviewing this moment in the background",
      detail: `${progress.message || "This review can keep running even if you leave the page."}${counts}${phaseLabel} You can leave this page and come back; the job tray will keep tracking it.`,
      startedAt: Date.parse(job?.startedAt || job?.createdAt || "") || Date.now(),
      jobId: job?.id || "",
    };
  }, []);

  const finalizeAssistantReply = useCallback(async ({
    updatedMessages,
    imagePayload,
    response,
    startedAt,
  }) => {
    const normalized = imagePayload.aiImages.length ? normalizeAIImageResult(response) : null;
    const reply = imagePayload.aiImages.length
      ? normalized.chatResponse
      : typeof response === "string" ? response.trim() : response?.response?.trim() ?? "";
    const aiMsg = { role: "assistant", text: reply, createdAt: new Date().toISOString() };
    const finalMessages = [...updatedMessages, aiMsg];
    setMessages(finalMessages);
    setLoading(false);
    setActiveReplyJobId("");
    setChatProcessingStatus(null);
    persistChatMessages(finalMessages).catch(() => {});
    const newIdx = finalMessages.length - 1;
    if (ttsEnabled) speakText(reply, newIdx);
    if (imagePayload.aiImages.length) {
      persistStructuredImageFindings(normalized.findings, finalMessages, reply).catch(() => {});
    } else {
      persistFindings(finalMessages).catch(() => {
        setSavingFindings(false);
        setChatProcessingStatus({
          phase: "error",
          message: "Chat saved; findings summary needs attention",
          detail: "Your full conversation is saved. Sarah could not refresh the short findings summary yet.",
          startedAt: startedAt || Date.now(),
        });
      });
    }
  }, [persistChatMessages, persistFindings, persistStructuredImageFindings, ttsEnabled]);

  const sendMessage = async (overrideText = null) => {
    const requestedText = typeof overrideText === "string" ? overrideText : input;
    if ((!requestedText.trim() && !selectedImages.length && !selectedVideoClip) || loading || uploadingImages || processingVideoClip || activeReplyJobId) return;
    const text = requestedText.trim();
    const requestStartedAt = Date.now();
    setLoading(true);
    setChatProcessingStatus({
      phase: selectedVideoClip ? "queued" : selectedImages.length ? "queued" : "thinking",
      message: selectedVideoClip ? "Starting Sarah video review" : selectedImages.length ? "Starting Sarah image review" : "Sarah is thinking",
      detail: selectedVideoClip ? "Preparing the clip, frame evidence, motion summary, and session context." : "",
      startedAt: requestStartedAt,
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
    const userMsg = { role: "user", text: text || "Please review the attached media.", imageAttachments: imagePayload.metadata, createdAt: new Date().toISOString() };
    const updated = [...messages, userMsg];
    setMessages(updated);
    setChatProcessingStatus(nextChatStatus({
      phase: "processing",
      message: "Saving your review request",
      detail: "Writing this chat turn locally before Sarah starts the detailed review.",
      startedAt: requestStartedAt,
    }));
    persistChatMessages(updated).catch(() => {});
    setInput("");
    setSelectedImages([]);

    setChatProcessingStatus(nextChatStatus({
      phase: "processing",
      message: "Building session review context",
      detail: "Assembling the chat history, sampled frame timeline, and motion notes for Sarah.",
      startedAt: requestStartedAt,
    }));
    const localTimeContext = buildLocalTimeContext();
    const isVisualReviewRequest = imagePayload.aiImages.length > 0;
    const history = buildPromptHistory(updated, {
      limit: isVisualReviewRequest ? CHAT_PROVIDER_HISTORY_LIMIT : CHAT_INTERACTIVE_HISTORY_LIMIT,
      perMessageChars: isVisualReviewRequest ? 760 : CHAT_HISTORY_MESSAGE_MAX_CHARS,
    });
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

    const groundingContext = isVisualReviewRequest
      ? clipPromptText(buildAIGroundingContext(userProfile), CHAT_VISUAL_REVIEW_CONTEXT_MAX_CHARS)
      : "";
    let sarahVsVitalsContext = "";
    const shouldLoadSarahVsVitalsContext = mode === "session" && isVisualReviewRequest;
    if (shouldLoadSarahVsVitalsContext) {
      setChatProcessingStatus(nextChatStatus({
        phase: "processing",
        message: "Loading physiology context",
        detail: "Pulling grounding details and recent SarahVS vitals context before handing this review to Sarah.",
        startedAt: requestStartedAt,
      }));
      try {
        sarahVsVitalsContext = await withTimeout(
          buildSarahVsVitalsPromptContext(),
          OPTIONAL_VITALS_CONTEXT_TIMEOUT_MS,
          "Optional SarahVS vitals context timed out.",
        );
      } catch (error) {
        console.warn("AIChat: optional SarahVS vitals context was skipped:", error);
        setChatProcessingStatus(nextChatStatus({
          phase: "processing",
          message: "Continuing without extra vitals context",
          detail: "The optional SarahVS longitudinal vitals layer took too long, so Sarah is continuing with the saved frames, motion notes, and session context already in hand.",
          startedAt: requestStartedAt,
        }));
      }
    }
    const profileMechanicalContext = mode === "profile" ? `\n\n${PROFILE_MECHANICAL_RULE}` : "";
    const sarahPersonalityPrompt = buildSarahPersonalityPrompt(sarahPersonality, {
      isTechnical: false,
    });
    const combinedContext = clipPromptText([
      String(context || "").trim(),
      isVisualReviewRequest ? String(extraReviewContext || "").trim() : "",
    ].filter(Boolean).join("\n\n"), isVisualReviewRequest ? CHAT_VISUAL_REVIEW_CONTEXT_MAX_CHARS : CHAT_INTERACTIVE_CONTEXT_MAX_CHARS);

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

    const imageReviewPrompt = isVisualReviewRequest ? `SARAH IMAGE REVIEW MODE:
You are Sarah inside the Sarah app. The user may provide explicit adult anatomical or device images for private self-analysis. Analyze clinically/functionally, not erotically.
${ANATOMICAL_REFERENCE_FOCUS_RULE}
${SARAH_CLINICAL_REASONING_CALIBRATION_RULE}
${sarahPersonalityPrompt}
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

    setChatProcessingStatus(nextChatStatus({
      phase: "analyzing",
      message: isVisualReviewRequest ? "Sarah is reviewing the visual evidence" : "Sarah is composing a response",
      detail: isVisualReviewRequest
        ? `Sarah now has ${imagePayload.aiImages.length} attached frame${imagePayload.aiImages.length === 1 ? "" : "s"}. Long video reviews can take a bit while the model reads frames, motion context, and session notes.`
        : "",
      startedAt: requestStartedAt,
    }));

    const aiRequestPayload = {
      prompt: `${imageReviewPrompt || `${systemPrompt}\n\n${sarahPersonalityPrompt}`}\n\n${TIME_FORMAT_RULE}\n\n${localTimeContext}${profileMechanicalContext}\n\n${groundingContext}${sarahVsVitalsContext ? `\n\n${sarahVsVitalsContext}` : ""}\n\nSession/profile data:\n${combinedContext}\n\nConversation:\n${history}${videoContext ? `\n\nLocal video clip context represented by timestamped sampled still frames:\n${videoContext}` : ""}${motionContext ? `\n\nLocal video motion evidence:\n${motionContext}\n\nUse this motion evidence to discuss visible timing, continuity, speed shifts, and pause candidates. Treat it as an observational proxy only; do not claim confirmed technique, intent, pressure, or force unless the visual frames and user caption directly support it.` : ""}\n\nUser's current text with the attached image(s):\n${text || "(No extra text provided.)"}\n\nRespond now as Sarah:`,
      ...(!isVisualReviewRequest ? { max_tokens: 800 } : {}),
      ...(isVisualReviewRequest ? { images: imagePayload.aiImages, response_json_schema: imageSchema, max_tokens: 5000 } : {}),
      source: "ai_chat_interactive",
      foreground: true,
      interactive: true,
      priority: 100,
    };
    const shouldRunInBackground = imagePayload.metadata.some((item) => item?.sourceVideo);

    try {
      if (shouldRunInBackground) {
        setChatProcessingStatus(nextChatStatus({
          phase: "background",
          message: "Handing off to Sarah's background worker",
          detail: `Submitting ${imagePayload.aiImages.length} frame${imagePayload.aiImages.length === 1 ? "" : "s"} to the local desktop worker. This step should usually finish within a few seconds, then the job tray will keep tracking it.`,
          startedAt: requestStartedAt,
        }));
        const startedJob = await startBackgroundJob("ai_invoke", {
          ...aiRequestPayload,
          source: "ai_chat_session_moment_review",
          foreground: false,
          interactive: false,
          quietInTray: false,
          priority: 90,
          label: "Ask Sarah moment review",
        }, {
          sessionId: scopeId,
          title: "Ask Sarah moment review",
          label: "Ask Sarah moment review",
          source: "ai_chat_session_moment_review",
          route: scopeId ? `/sessions/${encodeURIComponent(scopeId)}#session-interview` : "/sessions",
          quietInTray: false,
        });
        setActiveReplyJobId(startedJob.id);
        setLoading(false);
        setChatProcessingStatus(summarizeChatJobPhase(startedJob));
        void waitForBackgroundJob(startedJob.id, {
          intervalMs: 1200,
          onProgress: (job) => {
            setChatProcessingStatus(summarizeChatJobPhase(job));
          },
        }).then((completedJob) => (
          finalizeAssistantReply({
            updatedMessages: updated,
            imagePayload,
            response: completedJob.result,
            startedAt: requestStartedAt,
          })
        )).catch((error) => {
          const message = friendlySarahError(error);
          setActiveReplyJobId("");
          setLoading(false);
          setChatProcessingStatus({
            phase: "error",
            message: "Sarah response failed",
            detail: message,
            startedAt: requestStartedAt,
          });
          setImageError(message);
        });
        return;
      }

      const res = await base44.integrations.Core.InvokeLLM(aiRequestPayload);
      await finalizeAssistantReply({
        updatedMessages: updated,
        imagePayload,
        response: res,
        startedAt: requestStartedAt,
      });
    } catch (error) {
      const message = friendlySarahError(error);
      setActiveReplyJobId("");
      setLoading(false);
      setChatProcessingStatus({ phase: "error", message: "Sarah response failed", detail: message, startedAt: requestStartedAt });
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
    ? "fixed inset-0 z-[100] flex w-full max-w-[100vw] min-w-0 flex-col overflow-hidden border-0 bg-[#f7f5fa] text-foreground dark:bg-[#0b0e14]"
    : "w-full max-w-full min-w-0 overflow-hidden rounded-xl border border-border";
  const bodyClass = fullScreen
    ? "flex min-h-0 min-w-0 max-w-full flex-1 flex-col overflow-hidden"
    : "min-w-0 max-w-full space-y-3 overflow-hidden p-3";
  const threadClass = fullScreen
    ? "flex min-h-0 min-w-0 max-w-full flex-1 basis-0 flex-col gap-3 overflow-x-hidden overflow-y-auto px-3 py-4 sm:px-6"
    : "min-h-[36rem] min-w-0 max-w-full space-y-2 overflow-x-hidden overflow-y-auto border-t border-border pr-1 pt-2";
  const messageClass = (role) => `group relative rounded-2xl px-3 py-2 text-sm leading-relaxed shadow-sm ${
    fullScreen ? "max-w-[84%] sm:max-w-[min(76%,46rem)] sm:px-4 sm:py-3 sm:text-[15px]" : "max-w-[85%]"
  } min-w-0 break-words [overflow-wrap:anywhere] ${
    role === "user"
      ? "bg-primary text-primary-foreground rounded-br-md"
      : `${fullScreen ? "border border-border/70 bg-card" : "bg-muted/70"} text-foreground rounded-bl-md cursor-pointer`
  }`;
  const composerClass = fullScreen
    ? "w-full shrink-0 border-t border-border/80 bg-card px-3 pt-3 pb-[calc(env(safe-area-inset-bottom)+0.75rem)] shadow-[0_-8px_24px_rgba(0,0,0,0.06)] sm:px-6"
    : "sticky bottom-0 space-y-2 bg-white pt-2 dark:bg-slate-900";
  const textareaClass = fullScreen
    ? "min-h-[5.75rem] max-h-40 w-full resize-none rounded-xl border border-border bg-background px-4 py-3 text-sm leading-5 shadow-sm focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50 sm:text-base"
    : "w-full resize-none rounded-lg border border-border bg-background px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50";
  const effectiveSendDisabled = (!input.trim() && !selectedImages.length && !selectedVideoClip) || loading || uploadingImages || processingVideoClip || Boolean(activeReplyJobId);

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

  const renderChatProcessingStatus = () => {
    if (!chatProcessingStatus || loading) return null;
    const tone = chatProcessingStatus.phase === "error"
      ? "border-destructive/30 bg-destructive/10 text-destructive"
      : chatProcessingStatus.phase === "recording"
        ? "border-primary/30 bg-primary/10 text-primary"
        : "border-border bg-muted/30 text-muted-foreground";
    return (
      <div className={`rounded-lg border px-3 py-2 text-xs ${tone}`}>
        <div className="flex items-center gap-2 font-semibold">
          {["processing", "recording", "background"].includes(chatProcessingStatus.phase) && (
            <span className="h-2.5 w-2.5 shrink-0 rounded-full border-2 border-current border-t-transparent animate-spin" />
          )}
          <span>{chatProcessingStatus.message}</span>
        </div>
        {chatProcessingStatus.detail && (
          <p className="mt-1 leading-relaxed opacity-90">{chatProcessingStatus.detail}</p>
        )}
        {chatProcessingElapsedSeconds > 0 && (
          <p className="mt-1 opacity-80">
            {chatProcessingElapsedSeconds < 60
              ? `${chatProcessingElapsedSeconds}s elapsed`
              : `${Math.floor(chatProcessingElapsedSeconds / 60)}m ${String(chatProcessingElapsedSeconds % 60).padStart(2, "0")}s elapsed`}
          </p>
        )}
        {chatProcessingStatus.phase === "recording" && liveSpeechLastWord && (
          <div className="mt-2 inline-flex max-w-full items-center gap-1.5 rounded-full border border-current/20 bg-background/70 px-2 py-1 text-[11px] font-semibold">
            <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-current" />
            <span className="shrink-0 opacity-80">Last heard</span>
            <span className="min-w-0 truncate text-foreground">{liveSpeechLastWord}</span>
          </div>
        )}
        {chatProcessingStatus.phase === "recording" && liveSpeechPreview && (
          <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-foreground/80">
            {liveSpeechPreview}
          </p>
        )}
        {chatProcessingStatus.phase === "recording" && !liveSpeechSupported && (
          <p className="mt-1 text-[11px] leading-relaxed opacity-75">
            Live word preview is not available in this Android WebView; final transcription still uses Whisper.
          </p>
        )}
      </div>
    );
  };

  const renderSavedVideoClips = () => {
    const clips = Array.isArray(savedVideoClips)
      ? savedVideoClips.filter((clip) => clip?.url || clip?.clip_url || clip?.frames?.length || clip?.session_time_s != null)
      : [];
    if (!clips.length || mode !== "session") return null;
    const previewClips = clips.slice(0, 6);
    const hasMoreClips = clips.length > previewClips.length;
    return (
      <div className="min-w-0 max-w-full overflow-hidden rounded-lg border border-primary/20 bg-primary/[0.05] p-2 text-xs">
        <p className="mb-2 font-semibold text-primary">Saved key video moments</p>
        <div className="flex max-w-full gap-2 overflow-x-auto overscroll-x-contain pb-1">
          {previewClips.map((clip) => (
            <button
              key={clip.id || `${clip.label}-${clip.session_time_s}`}
              type="button"
              onClick={() => attachSavedVideoClipFrames(clip)}
              disabled={loading || uploadingImages || processingVideoClip || activeReplyJobId || selectedImages.length >= MAX_IMAGE_COUNT}
              className="w-[11rem] max-w-[calc(100vw-4rem)] flex-none rounded-lg border border-border bg-background/75 px-2 py-1.5 text-left transition-colors hover:border-primary disabled:opacity-45"
              title={clip.frames?.length ? (clip.reason || "Attach sampled frames from this saved moment") : (clip.reason || "Ask Sarah about this saved moment")}
            >
              <span className="block truncate font-semibold text-foreground">{clip.label || "Saved clip"}</span>
              <span className="block text-[10px] text-muted-foreground">
                {clip.session_time_s != null ? formatSeconds(clip.session_time_s) : "time?"}
                {clip.camera_angle ? ` · ${clip.camera_angle}` : ""}
                {Array.isArray(clip.frames) && clip.frames.length ? ` · ${clip.frames.length} frames` : " · saved marker"}
              </span>
            </button>
          ))}
        </div>
        <details className="mt-2 rounded-lg border border-border bg-background/70 p-2">
          <summary className="cursor-pointer list-none font-semibold text-primary">
            All session moments ({clips.length})
          </summary>
          <div className="mt-2 max-h-52 space-y-2 overflow-y-auto pr-1">
            {clips.map((clip) => (
              <button
                key={`all-${clip.id || `${clip.label}-${clip.session_time_s}`}`}
                type="button"
                onClick={() => attachSavedVideoClipFrames(clip)}
                disabled={loading || uploadingImages || processingVideoClip || activeReplyJobId || selectedImages.length >= MAX_IMAGE_COUNT}
                className="block w-full rounded-lg border border-border bg-background/85 px-2 py-2 text-left transition-colors hover:border-primary disabled:opacity-45"
                title={clip.frames?.length ? (clip.reason || "Attach sampled frames from this saved moment") : (clip.reason || "Ask Sarah about this saved moment")}
              >
                <span className="block font-semibold text-foreground">{clip.label || "Saved clip"}</span>
                <span className="block text-[10px] text-muted-foreground">
                  {clip.session_time_s != null ? formatSeconds(clip.session_time_s) : "time?"}
                  {clip.camera_angle ? ` · ${clip.camera_angle}` : ""}
                  {Array.isArray(clip.frames) && clip.frames.length ? ` · ${clip.frames.length} frames` : clip?.url || clip?.clip_url || clip?.file_url || sessionVideoSources.length ? " · tap to pull frames" : " · saved marker"}
                </span>
              </button>
            ))}
          </div>
        </details>
        {hasMoreClips ? (
          <p className="mt-2 text-[10px] text-muted-foreground">
            The top row is just a preview. Open the full list for later climax, orgasm, ejaculation, and recovery moments.
          </p>
        ) : null}
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
          disabled={processingVideoClip || activeReplyJobId || selectedImages.length >= MAX_IMAGE_COUNT}
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
              disabled={loading || uploadingImages || processingVideoClip || activeReplyJobId}
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
        disabled={loading || transcribing || uploadingImages || processingVideoClip || activeReplyJobId || selectedImages.length >= MAX_IMAGE_COUNT}
        title="Attach images for Sarah"
        className={`flex h-9 w-9 shrink-0 items-center justify-center bg-muted text-muted-foreground transition-all hover:text-foreground disabled:opacity-40 ${fullScreen ? "rounded-full" : "rounded-lg"}`}
      >
        <Paperclip className="h-4 w-4" />
      </button>
      {!fullScreen && (
        <button
          type="button"
          onClick={() => videoInputRef.current?.click()}
          disabled={loading || transcribing || uploadingImages || processingVideoClip || activeReplyJobId || selectedImages.length >= MAX_IMAGE_COUNT}
          title="Select a local video clip for Sarah"
          className="flex h-9 w-9 shrink-0 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-all hover:text-foreground disabled:opacity-40"
        >
          <Film className="h-4 w-4" />
        </button>
      )}
    </>
  );

  const renderComposerControls = () => (
    <div className={fullScreen ? "mt-2 flex items-center justify-end gap-2" : "flex items-center justify-end gap-2"}>
      {renderAttachButton()}
      <button
        type="button"
        onClick={recording ? stopRecording : startRecording}
        disabled={loading || transcribing || uploadingImages || activeReplyJobId}
        title={recording ? "Stop recording" : "Tap to dictate"}
        className={`flex h-9 w-9 shrink-0 items-center justify-center transition-all disabled:opacity-40 ${fullScreen ? "rounded-full" : "rounded-lg"} ${recording ? "bg-destructive text-destructive-foreground animate-pulse" : "bg-muted text-muted-foreground hover:text-foreground"}`}
      >
        {transcribing
          ? <span className="h-3.5 w-3.5 rounded-full border-2 border-primary border-t-transparent animate-spin" />
          : recording ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
      </button>
      <button
        type="button"
        onClick={sendMessage}
        disabled={effectiveSendDisabled}
        className={`flex h-9 w-9 shrink-0 items-center justify-center bg-primary text-primary-foreground transition-opacity disabled:opacity-40 ${fullScreen ? "rounded-full" : "rounded-lg"}`}
      >
        {loading || uploadingImages || processingVideoClip || activeReplyJobId ? <span className="h-4 w-4 animate-spin rounded-full border-2 border-primary-foreground border-t-transparent" /> : <Send className="h-4 w-4" />}
      </button>
    </div>
  );

  const renderComposerStatus = () => {
    if (!chatProcessingStatus) return null;
    const tone = chatProcessingStatus.phase === "error"
      ? "border-destructive/30 bg-destructive/10 text-destructive"
      : "border-primary/20 bg-primary/[0.06] text-foreground";
    const showSpinner = ["queued", "sampling", "uploading", "analyzing", "processing", "thinking", "background"].includes(chatProcessingStatus.phase);
    const slowHint = (() => {
      if (chatProcessingStatus.phase === "error") return "";
      if (chatProcessingStatus.phase === "processing" && chatProcessingElapsedSeconds >= REVIEW_PREP_SLOW_HINT_MS / 1000) {
        return "Still preparing this review on the device before the background job can start. If this keeps climbing, the desktop Local API may be slow or unreachable.";
      }
      if (chatProcessingStatus.phase === "background" && chatProcessingElapsedSeconds >= REVIEW_BACKGROUND_SLOW_HINT_MS / 1000) {
        return "This is taking longer than usual. The background job is still active, but if it sits here for over a minute, the desktop worker may be backed up.";
      }
      if (chatProcessingStatus.phase === "queued" && chatProcessingElapsedSeconds >= 20) {
        return "This should usually leave the queue quickly. If it stays queued, check that the desktop app and local API are both running.";
      }
      return "";
    })();
    return (
      <div className={`rounded-lg border px-3 py-2 text-xs ${tone}`}>
        <div className="flex items-center gap-2 font-semibold">
          {showSpinner && <span className="h-3 w-3 shrink-0 rounded-full border-2 border-current border-t-transparent animate-spin" />}
          <span>{chatProcessingStatus.message}</span>
        </div>
        {chatProcessingStatus.detail ? (
          <p className="mt-1 leading-relaxed opacity-90">{chatProcessingStatus.detail}</p>
        ) : null}
        {chatProcessingElapsedSeconds > 0 ? (
          <p className="mt-1 text-[11px] opacity-80">
            {formatElapsedShort(chatProcessingElapsedSeconds)} elapsed
          </p>
        ) : null}
        {slowHint ? (
          <p className="mt-1 text-[11px] leading-relaxed opacity-85">{slowHint}</p>
        ) : null}
      </div>
    );
  };

  const renderComposer = (placeholder, compactRows = 5) => (
    <div className={composerClass}>
      <textarea
        ref={inputRef}
        value={input}
        onChange={(event) => setInput(event.target.value)}
        onKeyDown={(event) => event.key === "Enter" && !event.shiftKey && (event.preventDefault(), sendMessage())}
        placeholder={transcribing ? "Transcribing…" : recording ? "Recording… tap mic to stop" : placeholder}
        disabled={loading || transcribing || uploadingImages || activeReplyJobId}
        rows={fullScreen ? 3 : compactRows}
        className={textareaClass}
      />
      {(loading || chatProcessingStatus) && renderComposerStatus()}
      {renderComposerControls()}
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
      <div className={`flex items-center gap-2 text-left ${fullScreen ? "shrink-0 border-b border-border/80 bg-card/95 px-3 pb-3 pt-[calc(env(safe-area-inset-top)+0.75rem)] shadow-sm backdrop-blur-xl sm:px-6" : "bg-muted/40 px-4 py-3"}`}>
        {fullScreen && (
          <button
            type="button"
            onClick={() => setFullScreen(false)}
            title="Return to Chat with Sarah"
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-full text-foreground transition-colors hover:bg-muted"
          >
            <ArrowLeft className="h-5 w-5" />
          </button>
        )}
        <button
          type="button"
          className="flex min-w-0 flex-1 items-center gap-2 text-left"
          onClick={() => {
            if (fullScreen) return;
            open ? setOpen(false) : handleOpen();
          }}
        >
          <SarahAvatar className={fullScreen ? "h-10 w-10" : "h-8 w-8"} />
          <span className="min-w-0 flex-1">
            <span className={`block truncate font-semibold text-foreground ${fullScreen ? "text-base" : "text-xs"}`}>
              {fullScreen ? "Sarah" : mode === "profile" ? "Chat with Sarah" : "Sarah Session Chat"}
            </span>
            {fullScreen && <span className="block truncate text-[11px] text-muted-foreground">{mode === "profile" ? "Profile chat · autosaved" : "Session chat · autosaved"}</span>}
          </span>
          {hasMessages && !fullScreen && (
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
        {open && !fullScreen && (
          <button
            type="button"
            onClick={(event) => {
              event.stopPropagation();
              openFullScreen();
            }}
            title="Open full screen"
            className="rounded-md p-1 text-muted-foreground transition-colors hover:bg-black/10 hover:text-foreground"
          >
            <Maximize2 className="h-4 w-4" />
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
          {!fullScreen && mode !== "profile" && (
            <p className="text-[11px] text-muted-foreground">
              {mode === "profile"
                ? "Start a conversation about your physiology and arousal. Findings save automatically to your profile Q&A."
                : "Ask anything about this session or share observations. Findings are saved to session notes."}
            </p>
          )}

          {/* Message thread or input prompt */}
          {messages.length === 0 ? (
            <div className={fullScreen ? threadClass : "space-y-2"}>
              {renderSavedVideoClips()}
              {renderSelectedImages()}
              {imageError && <p className="text-xs text-destructive">{imageError}</p>}
              {renderChatProcessingStatus()}
              {!fullScreen && renderComposer(`Tell Sarah something about your ${mode === "profile" ? "physiology" : "session"}…`, 3)}
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
                  className={`scroll-mt-4 flex min-w-0 max-w-full items-start gap-2 ${msg.role === "user" ? "flex-row-reverse" : ""}`}
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
                    <div className={`mt-1 text-[10px] font-medium ${msg.role === "user" ? "text-primary-foreground/70" : "text-muted-foreground"}`}>
                      {formatMessageDisplayTime(msg)}
                    </div>
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
              {renderChatProcessingStatus()}
              {!fullScreen && renderComposer("Type or speak your response…")}
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
          {hasUserReplied && !fullScreen && (
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

          {fullScreen && renderComposer(
            messages.length ? "Type or speak your response…" : `Tell Sarah something about your ${mode === "profile" ? "physiology" : "session"}…`,
          )}
        </div>
      )}
    </div>
  );
}
