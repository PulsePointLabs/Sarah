import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { BleClient } from "@capacitor-community/bluetooth-le";
import { Activity, AlertTriangle, Brain, CheckCircle2, ChevronDown, CircleDot, ExternalLink, FileText, Flag, Footprints, HeartPulse, Maximize2, Mic, MicOff, MoveDown, MoveUp, Pause, Play, Radio, RefreshCw, SlidersHorizontal, Undo2, UploadCloud, Video, Volume2, X, Zap } from "lucide-react";
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import PageHeader from "@/components/PageHeader";
import LiveFootLandmarkTracker from "@/components/LiveFootLandmarkTracker";
import LiveCaptureLaunchpad from "@/components/LiveCaptureLaunchpad";
import LiveSessionMobileRecorder from "@/components/LiveSessionMobileRecorder";
import { base44 } from "@/api/base44Client";
import { useToast } from "@/components/ui/use-toast";
import { HR_SOURCE_OPTIONS, PULSOID_MODE_OPTIONS, computeHrvFromRr, maskPulsoidToken, readHrSourceSettings, writeHrSourceSettings } from "@/lib/hrSources";
import { apiUrl, isSarahNativeShell } from "@/lib/mobileApiBase";
import { readSttProviderPreference } from "@/lib/sttSettings";
import {
  buildLaunchProfileFromRuntime,
  readLiveCaptureLaunchProfile,
  saveLiveCaptureLaunchProfile,
  summarizeLaunchProfile,
} from "@/lib/liveCaptureLaunchProfile";
import { DEFAULT_LIVE_CUE_SETTINGS, LIVE_CUE_PRESETS, resolveLiveCuePhraseBank } from "@/lib/liveCuePhrases";
import { useLiveCueAudio } from "@/hooks/useLiveCueAudio";
import { useLiveCueEngine } from "@/hooks/useLiveCueEngine";
import { toLiveTelemetryNotice } from "@/lib/liveCueDisplay";
import { computeLiveClimaxPrediction } from "@/utils/liveClimaxPrediction";
import {
  computeHowlPhysiologyAction,
  createHowlPhysiologyControllerState,
} from "@/lib/howlPhysiologyController";
import {
  H10_ACCELEROMETER_STOP_COMMAND,
  H10_ACCELEROMETER_START_COMMAND,
  H10_ECG_STOP_COMMAND,
  H10_ECG_START_COMMAND,
  H10_PMD_CONTROL_UUID,
  H10_PMD_DATA_UUID,
  H10_PMD_SERVICE_UUID,
  appendBoundedSamples,
  commandDataView,
  createH10PmdParserState,
  deriveH10MultimodalSnapshot,
  detectH10TapGesture,
  isH10PmdStreamActiveResponse,
  parseH10PmdControlResponse,
  parseH10PmdFrame,
} from "@/lib/h10Multimodal";
import {
  buildPerinealEmgCalibration,
  calibrationFromSession,
  createPerinealEmgDetector,
  perinealEventNote,
  processPerinealEmgSample,
  signalQualityFromCalibration,
} from "@/utils/perinealEmgDetector";
import {
  formatBloodPressure,
  formatBloodPressureTime,
  getBloodPressureStatus,
  ingestBloodPressureReadings,
  listRecentBloodPressure,
  openHealthConnectSettings,
  requestBloodPressurePermission,
  syncBloodPressureFromHealthConnect,
} from "@/lib/bloodPressure";
import {
  resetBloodPressureCaptureForSession,
  selectLiveSessionBloodPressure,
} from "@/lib/liveSessionBloodPressure";
import {
  getOmronBloodPressureListenerState,
  getRememberedOmronDevice,
  isOmronAutoListenEnabled,
  setOmronAutoListenEnabled,
  startOmronBloodPressureListener,
  stopOmronBloodPressureListener,
} from "@/lib/omronBloodPressureBle";

const MAX_TELEMETRY_POINTS = 240;
const TELEMETRY_DASHBOARD_STORAGE_KEY = "pulsepoint.telemetryDashboard.v1";
const TELEMETRY_DASHBOARD_PANELS = [
  { id: "notices", label: "Sarah live cue", helper: "Current physiological cue and confidence" },
  { id: "engine", label: "Acquisition health", helper: "Engine, sample rates, buffer, and storage" },
  { id: "howl", label: "Howl control", helper: "Current intensity and direct controls" },
  { id: "vitals", label: "Vital cards", helper: "HR, BP, HRV, respiration, motion, and EMG" },
  { id: "phase", label: "Phase watch", helper: "Approach, plateau, recovery, and markers" },
  { id: "multimodal", label: "Multimodal timelines", helper: "Threshold, respiration, motion, and Howl dose" },
  { id: "cardiac", label: "Cardiac timeline", helper: "HR, baseline, HRV, and approach" },
  { id: "emg", label: "EMG timeline", helper: "Perineal or dual-channel muscle activity" },
];

function defaultTelemetryDashboard() {
  return TELEMETRY_DASHBOARD_PANELS.map((panel) => ({ id: panel.id, enabled: true }));
}

function readTelemetryDashboard() {
  try {
    const stored = JSON.parse(localStorage.getItem(TELEMETRY_DASHBOARD_STORAGE_KEY) || "null");
    if (!Array.isArray(stored)) return defaultTelemetryDashboard();
    const known = new Map(stored.map((item) => [item?.id, item]));
    const ordered = stored
      .filter((item) => TELEMETRY_DASHBOARD_PANELS.some((panel) => panel.id === item?.id))
      .map((item) => ({ id: item.id, enabled: item.enabled !== false }));
    TELEMETRY_DASHBOARD_PANELS.forEach((panel) => {
      if (!known.has(panel.id)) ordered.push({ id: panel.id, enabled: true });
    });
    return ordered;
  } catch {
    return defaultTelemetryDashboard();
  }
}
const MAX_VOICE_NOTE_MS = 12000;
const VOICE_NOTE_MIN_MS = 900;
const VOICE_NOTE_SILENCE_MS = 1300;
const VOICE_NOTE_SILENCE_RMS = 0.018;
const LIVE_HEALTH_HR_GRACE_MS = 6000;
const LIVE_HEALTH_RR_USABLE_GRACE_MS = 8000;
const LIVE_HEALTH_RR_SEEN_GRACE_MS = 10000;
const LIVE_HEALTH_EMG_GRACE_MS = 6000;
const TERMINAL_WAKE_LISTENER_ERRORS = new Set([
  "network",
  "not-allowed",
  "service-not-allowed",
  "audio-capture",
]);
const WHISPER_PROMPT =
  "Sarah live session annotation. Timestamped observation during physiological recording. " +
  "Heart rate, arousal, stimulation, physical finding, legs tense, feet planted, toe curl, tremor, breathing, " +
  "stroke speed, grip pressure, repositioning, comfort adjustment, nearing climax, ejaculation, climax, recovery.";

function wakeListenerErrorMessage(errorCode) {
  if (errorCode === "network") {
    return "Wake phrase is unavailable in this app/browser right now. Use Record Now; Sarah will still timestamp and save the note.";
  }
  if (errorCode === "not-allowed" || errorCode === "service-not-allowed") {
    return "Wake phrase needs microphone/speech permission. Use Record Now or allow microphone access, then try Wake again.";
  }
  if (errorCode === "audio-capture") {
    return "Wake phrase cannot access the microphone. Check the selected mic, or use Record Now after mic access is restored.";
  }
  return errorCode ? `Wake listener: ${errorCode}` : "Wake listener stopped.";
}
const HEART_RATE_SERVICE_UUID = "0000180d-0000-1000-8000-00805f9b34fb";
const HEART_RATE_MEASUREMENT_UUID = "00002a37-0000-1000-8000-00805f9b34fb";
const BATTERY_SERVICE_UUID = "0000180f-0000-1000-8000-00805f9b34fb";
const DEVICE_INFORMATION_SERVICE_UUID = "0000180a-0000-1000-8000-00805f9b34fb";
const DIRECT_H10_REMEMBERED_DEVICE_KEY = "pulsepoint.directH10.rememberedDevice";
const DIRECT_H10_RECONNECT_DELAYS_MS = [1000, 2500, 5000, 10000, 15000, 30000];
const SHARED_HR_PACKET_STALE_MS = 30000;

function emptyH10MultimodalSnapshot() {
  return {
    signalConfidence: { score: 0, level: "unavailable", ecg: "unavailable", accelerometer: "unavailable", respiration: "unavailable", motionGate: "closed" },
    motion: { available: false, class: "unavailable" },
    position: { state: "unavailable" },
    respiration: { available: false, reason: "sensor_unavailable" },
    recovery: { available: false },
    responseLatency: { available: false, sampleCount: 0 },
    state: { key: "waiting", label: "WAITING", tone: "neutral" },
    streams: { ecg: { sampleCount: 0 }, accelerometer: { sampleCount: 0 } },
  };
}

function createH10PmdStore() {
  return {
    parserStates: {
      ecg: createH10PmdParserState(130),
      accelerometer: createH10PmdParserState(25),
    },
    ecgSamples: [],
    accelerometerSamples: [],
    pendingEcgSamples: [],
    pendingAccelerometerSamples: [],
    tapState: {},
    baselineOrientation: null,
    lastDerivedAt: 0,
  };
}

function readRememberedDirectH10Device() {
  try {
    const parsed = JSON.parse(localStorage.getItem(DIRECT_H10_REMEMBERED_DEVICE_KEY) || "null");
    const deviceId = String(parsed?.deviceId || "").trim();
    if (!deviceId) return null;
    return {
      deviceId,
      name: String(parsed?.name || "Polar H10").trim() || "Polar H10",
    };
  } catch {
    return null;
  }
}

function rememberDirectH10Device(device) {
  const deviceId = String(device?.deviceId || "").trim();
  if (!deviceId) return null;
  const remembered = {
    deviceId,
    name: String(device?.name || "Polar H10").trim() || "Polar H10",
  };
  try {
    localStorage.setItem(DIRECT_H10_REMEMBERED_DEVICE_KEY, JSON.stringify(remembered));
  } catch {
    // A storage failure should not prevent the current BLE connection.
  }
  return remembered;
}

function forgetRememberedDirectH10Device() {
  try {
    localStorage.removeItem(DIRECT_H10_REMEMBERED_DEVICE_KEY);
  } catch {
    // Nothing else is required when local storage is unavailable.
  }
}
const CAPTURE_MODES = [
  { value: "full", label: "Full telemetry", helper: "HR, EMG, OBS, and voice notes" },
  { value: "media", label: "Media", helper: "Video-first live review" },
  { value: "hr_emg", label: "HR + EMG", helper: "Telemetry-focused capture" },
  { value: "hr", label: "HR Only / Main Telemetry", helper: "Distance-readable HR and EMG dashboard" },
  { value: "video", label: "Video sync", helper: "OBS-first review workflow" },
];
const CAPTURE_KINDS = [
  { value: "session", label: "Session", helper: "Climax/build/recovery workflow with phase markers and Sarah session analysis." },
  { value: "body_exploration", label: "Body Exploration", helper: "Instrumentation/body observation workflow; suppresses climax and pre-climax prompts." },
];
const EMG_SENSOR_CONFIGS = [
  {
    value: "generic",
    label: "Generic EMG",
    helper: "Use the running single or dual EMG helper without placement-specific session defaults.",
    targetArea: "",
    sensorType: "MyoWare 2.0",
    channels: null,
    leftLabel: "Left EMG",
    rightLabel: "Right EMG",
    leftHelper: "normalized activation",
    rightHelper: "side-to-side comparison",
    trendTitle: "EMG Activation",
    trendSubtitle: "Left, right, and side-to-side differential",
    calibrationIntro: "These controls send calibration actions to the running local EMG helper and record each intentional maneuver for review and AI grounding. Confirm an applied acknowledgement below before relying on the new scale.",
    placementPatch: {},
  },
  {
    value: "perineal_body_small_electrodes",
    label: "Perineal Body EMG",
    helper: "Small surface electrodes over the perineal body; displays normalized contraction estimate from the local EMG feed.",
    targetArea: "Perineal body / pelvic floor",
    sensorType: "Small surface EMG electrodes (perineal body)",
    channels: "single",
    leftLabel: "Perineal EMG",
    rightLabel: "Aux EMG",
    leftHelper: "normalized contraction estimate",
    rightHelper: "optional second channel",
    trendTitle: "Perineal Body EMG",
    trendSubtitle: "Normalized contraction estimate from small-electrode perineal-body placement",
    calibrationIntro: "This preset treats the EMG feed as a best-effort perineal-body contraction estimate, not absolute force. Calibrate a quiet relaxed baseline first, then a brief comfortable contraction, and confirm the helper acknowledgement before relying on the scale.",
    placementPatch: {
      emg_enabled: true,
      emg_target_area: "Perineal body / pelvic floor",
      emg_sensor_type: "Small surface EMG electrodes (perineal body)",
      emg_channels: "single",
      emg_left_placement_notes: "Small surface electrode pair centered over the perineal body. Use normalized activation as a best-effort contraction estimate; expect movement/contact artifact and confirm with calibration.",
      emg_right_placement_notes: "Optional second channel only if using dual electrodes for lateral comparison or adjacent pelvic-floor reference.",
      emg_general_notes: "Live Capture preset: perineal-body small-electrode EMG. Interpret as normalized relative activation, not direct force. Best signal comes from a clean relaxed baseline, a brief comfortable contraction reference, stable electrode contact, and event notes for movement/contact changes.",
    },
  },
];
const MEDIA_VIDEO_EXTENSIONS = [".mp4", ".webm", ".mov", ".mkv", ".m4v", ".avi", ".wmv"];
const MEDIA_TRANSCODE_EXTENSIONS = [".wmv"];
const EMG_CALIBRATION_STEPS = [
  {
    key: "neutral",
    label: "Both neutral",
    instruction: "Relax both monitored sides and capture a quiet reference.",
  },
  {
    key: "both_max",
    label: "Both max tension",
    instruction: "Briefly contract both monitored sides as strongly as is comfortable.",
  },
  {
    key: "left_max",
    label: "Left max only",
    instruction: "Contract the left monitored side while keeping the right as relaxed as possible.",
  },
  {
    key: "right_max",
    label: "Right max only",
    instruction: "Contract the right monitored side while keeping the left as relaxed as possible.",
  },
];
const EMG_CALIBRATION_ACTIONS = {
  neutral: "set_both_rest",
  both_max: "set_both_max",
  left_max: "set_left_max",
  right_max: "set_right_max",
};
const PERINEAL_EMG_PROTOCOL_PHASES = [
  {
    key: "baseline_initial",
    label: "Relaxed baseline",
    instruction: "Relax pelvic floor/perineum, stay still, breathe normally.",
    durationS: 10,
    captureKey: "baseline",
  },
  {
    key: "light_kegels",
    label: "Light Kegels",
    instruction: "Perform 5 gentle Kegels, each about 1 second, separated by 2–3 seconds of relaxation.",
    durationS: 18,
    captureKey: "light",
  },
  {
    key: "strong_kegels",
    label: "Strong Kegels",
    instruction: "Perform 5 clear but comfortable strong Kegels, each about 1 second, separated by 2–3 seconds of relaxation.",
    durationS: 18,
    captureKey: "strong",
  },
  {
    key: "long_hold",
    label: "Long hold",
    instruction: "Perform one comfortable sustained Kegel hold for 5–10 seconds, then relax.",
    durationS: 12,
    captureKey: "hold",
  },
  {
    key: "cough_artifact",
    label: "Artifact check: cough",
    instruction: "Perform one cough, then relax.",
    durationS: 5,
    captureKey: "cough",
  },
  {
    key: "glute_artifact",
    label: "Artifact check: glute squeeze",
    instruction: "Perform one glute squeeze, then relax.",
    durationS: 5,
    captureKey: "glute",
  },
  {
    key: "adductor_artifact",
    label: "Artifact check: thigh/adductor squeeze",
    instruction: "Perform one thigh/adductor squeeze, then relax.",
    durationS: 5,
    captureKey: "adductor",
  },
  {
    key: "baseline_final",
    label: "Final relaxed baseline",
    instruction: "Relax pelvic floor/perineum again for a final quiet reference.",
    durationS: 10,
    captureKey: "baseline",
  },
];
const HOWL_TELEMETRY_POLL_MS = 2500;
const BLOOD_PRESSURE_SYNC_POLL_MS = 10000;
const ACTIVE_SESSION_REFRESH_MS = 5000;
const HEARTBEAT_PREDICTION_STALE_MS = 2600;
const HOWL_DEFAULT_CONTROL_FORM = {
  controlEnabled: false,
  sarahAutoEnabled: false,
  dispatchMode: "direct_http",
  controlUrl: "",
  remoteAccessKey: "",
  intensityFloor: 0,
  intensityCeiling: 20,
  rampRateLimitPerSecond: 5,
  buildRampEnabled: true,
  nearClimaxReductionEnabled: true,
  recoveryReductionEnabled: true,
  finalApproachEnabled: true,
  buildStep: 1,
  finalApproachStep: 1,
  reduceStep: 2,
  maxRecoveryRetreat: 3,
  nearClimaxThreshold: 72,
  plateauThreshold: 60,
  buildThreshold: 32,
  recoveryThreshold: 55,
  autoCooldownSeconds: 8,
};
const HOWL_DEFAULT_COMMAND_FORM = {
  channel: "a",
  intensity: 0,
  frequency_hz: 20,
  mode: "",
  waveform: "",
  enabled: true,
};
const HOWL_ACTIVITY_MODES = [
  { name: "LICKS", displayName: "Infinite licks", aliases: ["licks", "infinite licks", "lick"], description: "Repeating tongue-like pulse patterns with bidirectional, unidirectional, consistent, dip, ramp, and flick variations." },
  { name: "PENETRATION", displayName: "Penetration", aliases: ["penetration", "penetrate"], description: "Rhythmic penetration-style in/out pulse movement." },
  { name: "VIBRATOR", displayName: "Sliding vibrator", aliases: ["vibrator", "sliding vibrator", "vibe", "vibes"], description: "Vibration-focused sliding stimulation with pulse/hold behavior." },
  { name: "MILKMASTER", displayName: "Milkmaster 3000", aliases: ["milkmaster", "milk master", "milkmaster 3000", "milk master 3000"], description: "Milking-style waves with womp and buzz components." },
  { name: "CHAOS", displayName: "Chaos", aliases: ["chaos", "random"], description: "Unpredictable changing stimulation driven by short random cycles." },
  { name: "HJ", displayName: "Luxury HJ", aliases: ["hj", "handjob", "hand job", "luxury hj", "luxury handjob", "luxury hand job"], description: "Hand-stimulation style pattern with jitter and optional bonus pulses." },
  { name: "OPPOSITES", displayName: "Opposites", aliases: ["opposites", "opposite"], description: "A/B channels move in contrasting or opposing patterns." },
  { name: "CALIBRATION1", displayName: "Calibration 1", aliases: ["calibration one", "calibration 1", "cal one"], description: "Calibration pattern for checking channel behavior and range." },
  { name: "CALIBRATION2", displayName: "Calibration 2", aliases: ["calibration two", "calibration 2", "cal two"], description: "Second calibration pattern for checking output response." },
  { name: "BJ", displayName: "BJ Megamix", aliases: ["bj", "bj megamix", "blowjob", "blow job"], description: "Mixed mouth-stimulation style patterns with position and direction components." },
  { name: "FASTSLOW", displayName: "Fast/slow", aliases: ["fast slow", "fastslow", "fast and slow"], description: "Alternates speed using sawtooth-style ramp patterns." },
  { name: "SIMPLEX", displayName: "Simplex", aliases: ["simplex"], description: "Preset-driven waveform mode for clean, regular stimulation shapes." },
  { name: "RELENTLESS", displayName: "Relentless", aliases: ["relentless"], description: "Persistent long/short wave pattern with random-wave options." },
  { name: "OVERFLOWING", displayName: "Overflowing", aliases: ["overflowing", "overflow"], description: "Layered long and short waves with swelling/overflowing motion." },
  { name: "SUCCUBUS", displayName: "Succubus", aliases: ["succubus"], description: "Patterned wave mode with randomized wave behavior." },
  { name: "SINETIME", displayName: "Sine time", aliases: ["sine time", "sinetime", "sine"], description: "Smooth sine-wave timing pattern." },
];

function playToneSequence(audioContext, frequencies) {
  if (!audioContext || audioContext.state === "closed") return;
  const startedAt = audioContext.currentTime + 0.02;
  frequencies.forEach((frequency, index) => {
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    const t = startedAt + index * 0.13;
    osc.type = "sine";
    osc.frequency.setValueAtTime(frequency, t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.08, t + 0.015);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
    osc.connect(gain);
    gain.connect(audioContext.destination);
    osc.start(t);
    osc.stop(t + 0.12);
  });
}

function fmtTime(value) {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
  } catch {
    return "—";
  }
}

function fmtMmSs(value) {
  const total = Math.max(0, Math.round(Number(value) || 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtNumber(value, digits = 1) {
  const n = Number(value);
  return Number.isFinite(n) ? n.toFixed(digits) : "—";
}

function fmtAgeMs(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "—";
  if (n < 1000) return `${Math.round(n)} ms`;
  return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)} s`;
}

function timestampMs(value) {
  if (!value) return NaN;
  if (typeof value === "number") return value;
  const direct = Number(value);
  if (Number.isFinite(direct) && direct > 100000000000) return direct;
  return new Date(value).getTime();
}

function isRecent(value, maxAgeMs = 5000) {
  if (!value) return false;
  const t = timestampMs(value);
  return Number.isFinite(t) && Date.now() - t <= maxAgeMs;
}

function readNumber(...values) {
  for (const value of values) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

function readHowlChannelIntensity(telemetry, channel) {
  const normalized = String(channel || "").toLowerCase();
  const channelState = telemetry?.channel_state || telemetry?.channelState || telemetry?.channels || null;
  if (channelState && typeof channelState === "object") {
    const direct = channelState[normalized] || channelState[normalized.toUpperCase()];
    const value = readNumber(direct?.intensity, direct?.level, direct?.power);
    if (value != null) return value;
  }
  if (normalized === "b" || normalized === "1") {
    const value = readNumber(telemetry?.power_b, telemetry?.raw?.options?.power_b);
    if (value != null) return value;
  }
  const channelAValue = readNumber(telemetry?.power_a, telemetry?.raw?.options?.power_a);
  if (channelAValue != null) return channelAValue;
  return readNumber(telemetry?.intensity, telemetry?.power_level);
}

function readHowlChannelText(telemetry, channel, field) {
  const normalized = String(channel || "").toLowerCase();
  const channelState = telemetry?.channel_state || telemetry?.channelState || telemetry?.channels || null;
  if (channelState && typeof channelState === "object") {
    const direct = channelState[normalized] || channelState[normalized.toUpperCase()];
    const text = direct?.[field] == null ? "" : String(direct[field]).trim();
    if (text) return text;
  }
  const directText = telemetry?.[field] == null ? "" : String(telemetry[field]).trim();
  return directText || "";
}

function latestHowlCommandState(commands = []) {
  return (Array.isArray(commands) ? commands : []).find((command) => command?.dispatch?.howl) || null;
}

function readHowlActivityDisplayName(activityName) {
  const normalized = String(activityName || "").trim().toUpperCase();
  if (!normalized) return "";
  const match = HOWL_ACTIVITY_MODES.find((mode) => mode.name === normalized);
  return match?.displayName || normalized;
}

function buildHowlSessionEvent({
  action,
  timeS,
  channel = "a",
  intensity = null,
  requestedIntensity = null,
  activityName = "",
  activityDisplayName = "",
  waveform = "",
  frequencyHz = null,
  source = "howl_manual_control",
  reason = "",
} = {}) {
  const normalizedAction = String(action || "").trim().toLowerCase();
  const normalizedChannel = String(channel || "a").trim().toLowerCase() || "a";
  const modeLabel = String(activityDisplayName || readHowlActivityDisplayName(activityName) || activityName || waveform || "").trim();
  const roundedIntensity = Number.isFinite(Number(intensity)) ? Math.round(Number(intensity)) : null;
  const roundedRequested = Number.isFinite(Number(requestedIntensity)) ? Math.round(Number(requestedIntensity)) : null;
  const roundedFrequency = Number.isFinite(Number(frequencyHz)) ? Math.round(Number(frequencyHz)) : null;

  let note = "";
  let label = "Howl command";
  let tags = ["howl", "device_control"];
  if (normalizedAction === "load_activity") {
    note = `Howl mode changed to ${modeLabel || "new activity"}${roundedFrequency != null ? ` at ${roundedFrequency} Hz` : ""}.`;
    label = "Howl mode changed";
    tags = [...tags, "mode_change"];
  } else if (["set_power", "set_intensity", "increment_power", "decrement_power"].includes(normalizedAction)) {
    const channelLabel = normalizedChannel === "all" ? "all channels" : `channel ${normalizedChannel.toUpperCase()}`;
    if (roundedIntensity != null && roundedRequested != null && roundedRequested !== roundedIntensity) {
      note = `Howl intensity set to ${roundedIntensity} on ${channelLabel} (requested ${roundedRequested}).`;
    } else if (roundedIntensity != null) {
      note = `Howl intensity set to ${roundedIntensity} on ${channelLabel}.`;
    } else {
      note = `Howl intensity adjusted on ${channelLabel}.`;
    }
    if (modeLabel) note = `${note.slice(0, -1)} while ${modeLabel} was loaded.`;
    label = "Howl intensity adjusted";
    tags = [...tags, "intensity_change"];
  } else {
    return null;
  }

  return {
    id: `howl_${normalizedAction}_${Math.round(Number(timeS || 0) * 10)}_${Math.random().toString(36).slice(2, 7)}`,
    time_s: Math.max(0, Math.round(Number(timeS) || 0)),
    note,
    label,
    category: ["stimulation", "device_control"],
    annotation_tags: tags,
    source,
    created_at: new Date().toISOString(),
    howl_control: {
      action: normalizedAction,
      channel: normalizedChannel,
      intensity: roundedIntensity,
      requested_intensity: roundedRequested,
      activity_name: activityName || null,
      activity_display_name: modeLabel || null,
      waveform: waveform || null,
      frequency_hz: roundedFrequency,
      reason: reason || null,
    },
  };
}

function buildHowlWavePoints(type = "", amplitude = 50) {
  const normalized = String(type || "").toLowerCase();
  const amp = Math.max(8, Math.min(44, Number(amplitude) || 20));
  const mid = 50;
  const points = [];
  for (let i = 0; i <= 48; i += 1) {
    const x = (i / 48) * 100;
    let y;
    if (/square|pulse|step/.test(normalized)) {
      y = i % 8 < 4 ? mid - amp : mid + amp;
    } else if (/triangle|saw|ramp/.test(normalized)) {
      const phase = (i % 12) / 12;
      y = mid + (phase < 0.5 ? (phase * 4 - 1) : (3 - phase * 4)) * amp;
    } else {
      y = mid + Math.sin((i / 48) * Math.PI * 6) * amp;
    }
    points.push(`${x.toFixed(1)},${y.toFixed(1)}`);
  }
  return points.join(" ");
}

function HowlWaveformPreview({ label = "", intensity = 0, live = false }) {
  const amplitude = Math.max(0, Math.min(100, Number(intensity) || 0)) / 100 * 44;
  const points = buildHowlWavePoints(label, amplitude);

  return (
    <div className="rounded-lg border border-border bg-background/70 p-2">
      <div className="mb-1 flex items-center justify-between gap-2">
        <span className="truncate text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {label || "Waveform preview"}
        </span>
        <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${live ? "bg-emerald-500/10 text-emerald-400" : "bg-muted text-muted-foreground"}`}>
          {live ? "live" : "preview"}
        </span>
      </div>
      <svg viewBox="0 0 100 100" className="h-16 w-full overflow-visible" role="img" aria-label="Howl waveform preview">
        <line x1="0" y1="50" x2="100" y2="50" stroke="hsl(var(--border))" strokeWidth="1" strokeDasharray="4 4" />
        <polyline points={points} fill="none" stroke="hsl(var(--primary))" strokeWidth="4" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </div>
  );
}

function previewHowlControlUrl(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const withProtocol = /^https?:\/\//i.test(text) ? text : `http://${text}`;
  try {
    const parsed = new URL(withProtocol);
    const port = parsed.port || "4695";
    return `${parsed.protocol}//${parsed.hostname}${port ? `:${port}` : ""}`;
  } catch {
    return withProtocol;
  }
}

function maskHowlKey(value) {
  const text = String(value || "").trim();
  if (!text) return "not saved";
  if (text.length <= 4) return "saved";
  return `saved (${text.slice(0, 2)}...${text.slice(-2)})`;
}

function summarizeEmgCalibrationReading(history, telemetry) {
  const recent = history
    .slice(-12)
    .map((point) => ({ left: readNumber(point.left), right: readNumber(point.right) }))
    .filter((point) => point.left != null || point.right != null);
  const fallback = {
    left: readNumber(telemetry?.left_pct, telemetry?.level_pct),
    right: readNumber(telemetry?.right_pct),
  };
  const readings = recent.length ? recent : [fallback].filter((point) => point.left != null || point.right != null);
  const summary = (side) => {
    const values = readings.map((point) => point[side]).filter((value) => value != null);
    if (!values.length) return null;
    const average = values.reduce((total, value) => total + value, 0) / values.length;
    return {
      value: Math.round(average * 10) / 10,
      spread: Math.round((Math.max(...values) - Math.min(...values)) * 10) / 10,
    };
  };
  const left = summary("left");
  const right = summary("right");
  return {
    left,
    right,
    sampleCount: readings.length,
    diff: left && right ? Math.round((left.value - right.value) * 10) / 10 : null,
  };
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === "") return [];
  return [value];
}

function getFileExtension(file) {
  const name = String(file?.name || "").toLowerCase();
  const dotIndex = name.lastIndexOf(".");
  return dotIndex >= 0 ? name.slice(dotIndex) : "";
}

function isMediaVideoFile(file) {
  if (!file) return false;
  if (file.type?.startsWith("video/")) return true;
  return MEDIA_VIDEO_EXTENSIONS.includes(getFileExtension(file));
}

function needsMediaTranscode(file) {
  return MEDIA_TRANSCODE_EXTENSIONS.includes(getFileExtension(file));
}

function parseHeartRateMeasurement(value) {
  if (!value || value.byteLength < 2) return { heartRate: null, rrIntervalsMs: [] };
  const flags = value.getUint8(0);
  let offset = 1;
  const heartRate = (flags & 0x01)
    ? value.getUint16(offset, true)
    : value.getUint8(offset);
  offset += (flags & 0x01) ? 2 : 1;

  if (flags & 0x08) offset += 2; // Energy Expended field.

  const rrIntervalsMs = [];
  if (flags & 0x10) {
    while (offset + 1 < value.byteLength) {
      const raw = value.getUint16(offset, true);
      const ms = (raw / 1024) * 1000;
      if (Number.isFinite(ms)) rrIntervalsMs.push(Math.round(ms * 10) / 10);
      offset += 2;
    }
  }

  return { heartRate, rrIntervalsMs };
}

function appendRollingRrIntervals(current, next, maxSamples = 180) {
  const combined = [...(Array.isArray(current) ? current : []), ...(Array.isArray(next) ? next : [])]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 300 && value <= 2000);
  return combined.slice(-maxSamples);
}

function readHeartbeatIntervalMs(telemetry) {
  const rr = [
    ...(Array.isArray(telemetry?.rrIntervalsMs) ? telemetry.rrIntervalsMs : []),
    ...(Array.isArray(telemetry?.rr_intervals_ms) ? telemetry.rr_intervals_ms : []),
  ]
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value >= 300 && value <= 2000);
  if (rr.length) {
    const recent = rr.slice(-3);
    const average = recent.reduce((total, value) => total + value, 0) / recent.length;
    return Math.max(280, Math.min(1500, average));
  }
  const hr = readNumber(telemetry?.currentHr, telemetry?.hr, telemetry?.heartRate);
  if (!Number.isFinite(hr) || hr <= 0) return null;
  return Math.max(280, Math.min(1500, 60000 / Math.max(35, hr)));
}

function wait(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function withTimeout(promise, ms, message) {
  let timer = null;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = window.setTimeout(() => reject(new Error(message)), ms);
    }),
  ]).finally(() => {
    if (timer) window.clearTimeout(timer);
  });
}

function isCapacitorAndroidShell() {
  return Boolean(
    window.Capacitor?.isNativePlatform?.()
    && /android/i.test(window.Capacitor?.getPlatform?.() || "")
  );
}

function canUseNativeAndroidBle() {
  return isCapacitorAndroidShell();
}

function isAndroidRuntime() {
  return isCapacitorAndroidShell() || /android/i.test(window.navigator?.userAgent || "");
}

function isSarahDesktopRuntime() {
  return typeof window !== "undefined" && Boolean(window.sarahDesktop?.isDesktop);
}

async function getDirectH10Device({ preferSaved = false, silent = false } = {}) {
  const bluetooth = typeof navigator !== "undefined" ? navigator.bluetooth : undefined;
  if (!bluetooth) {
    throw new Error("This browser does not expose Web Bluetooth.");
  }
  const grantedDevices = typeof bluetooth.getDevices === "function"
    ? await bluetooth.getDevices().catch(() => [])
    : [];
  const pairedH10 = grantedDevices.find((device) => /polar\s+h10/i.test(device?.name || ""));
  if (preferSaved && pairedH10) return pairedH10;
  if (silent) {
    throw new Error("No saved H10 Bluetooth permission is available for automatic reconnect.");
  }

  try {
    return await bluetooth.requestDevice({
      filters: [{ namePrefix: "Polar H10" }],
      optionalServices: ["heart_rate", "battery_service", "device_information", H10_PMD_SERVICE_UUID],
    });
  } catch (error) {
    if (/user cancelled|user canceled|cancelled|canceled/i.test(error?.message || "")) throw error;
  }

  if (pairedH10) return pairedH10;
  return bluetooth.requestDevice({
    acceptAllDevices: true,
    optionalServices: ["heart_rate", "battery_service", "device_information", H10_PMD_SERVICE_UUID],
  });
}

async function getNativeDirectH10Device({ preferSaved = true, forcePicker = false, silent = false } = {}) {
  await BleClient.initialize({ androidNeverForLocation: true });
  if (typeof BleClient.isLocationEnabled === "function") {
    const enabled = await BleClient.isLocationEnabled().catch(() => true);
    if (!enabled) {
      throw new Error("Android Location services are off. Turn Location on, then try Connect H10 again so Android can scan for BLE devices.");
    }
  }
  const remembered = readRememberedDirectH10Device();
  if (preferSaved && !forcePicker && remembered) return remembered;
  if (silent) throw new Error("No remembered Polar H10 is available for automatic reconnect.");
  const selected = await BleClient.requestDevice({
    services: [HEART_RATE_SERVICE_UUID],
    optionalServices: [
      HEART_RATE_SERVICE_UUID,
      BATTERY_SERVICE_UUID,
      DEVICE_INFORMATION_SERVICE_UUID,
      H10_PMD_SERVICE_UUID,
    ],
    namePrefix: "Polar H10",
  });
  rememberDirectH10Device(selected);
  return selected;
}

async function getHeartRateMeasurementCharacteristic(device) {
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      await wait(attempt === 0 ? 400 : 900);
      const server = device.gatt.connected
        ? device.gatt
        : await withTimeout(
          device.gatt.connect(),
          12000,
          "Timed out connecting to the H10 GATT server.",
        );
      if (!server.connected) throw new Error("H10 GATT connection did not stay open.");
      const service = await withTimeout(
        server.getPrimaryService("heart_rate"),
        12000,
        "Timed out opening the H10 heart-rate service.",
      );
      return withTimeout(
        service.getCharacteristic("heart_rate_measurement"),
        12000,
        "Timed out opening the H10 heart-rate measurement stream.",
      );
    } catch (error) {
      lastError = error;
      try {
        if (device.gatt?.connected) device.gatt.disconnect();
      } catch {
        // Best-effort cleanup before retrying the H10 GATT session.
      }
      await wait(900 + attempt * 500);
    }
  }
  throw lastError || new Error("Could not open the H10 heart-rate service.");
}

function friendlyDirectH10Error(error) {
  const message = error?.message || String(error || "");
  if (/timed out/i.test(message)) {
    return isAndroidRuntime()
      ? `${message} Android browser Bluetooth is unstable with this H10 path on this device. Use Pulsoid for phone capture until native BLE support is added.`
      : `${message} Wake the strap, make sure no other app is holding the H10, then tap Connect H10 again.`;
  }
  if (/gatt server is disconnected|cannot retrieve services|networkerror/i.test(message)) {
    return isAndroidRuntime()
      ? "The phone paired with the H10 but the live BLE session dropped before services opened. Use Pulsoid for phone capture until native Direct H10 support is added."
      : "The browser paired with the H10 but the live BLE session dropped before services opened. Wake the strap, make sure Pulsoid/phone apps are not holding it, then tap Connect H10 again.";
  }
  if (/user cancelled|user canceled|cancelled|canceled/i.test(message)) {
    if (isSarahDesktopRuntime()) {
      return "Sarah desktop did not find a Polar H10 during the Bluetooth scan. Wet/wear the strap, make sure another app is not holding it, then tap Connect H10 again.";
    }
    return "H10 pairing was cancelled.";
  }
  if (/no device selected|no device found|notfounderror/i.test(message)) {
    return isSarahDesktopRuntime()
      ? "Sarah desktop could not find the Polar H10. Wake the strap, keep it close to the PC, and make sure Windows Bluetooth is on."
      : "No Polar H10 was selected.";
  }
  return message || "Could not connect to the Direct H10 source.";
}

function ReadinessItem({ label, value, helper, ready, optional = false }) {
  return (
    <div className={`rounded-lg border px-3 py-2.5 ${
      ready
        ? "border-primary/35 bg-primary/10"
        : optional
          ? "border-border bg-muted/20"
          : "border-border bg-card"
    }`}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
          <p className="mt-1 text-sm font-semibold text-foreground">{value}</p>
          <p className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{helper}</p>
        </div>
        <CheckCircle2 className={`mt-0.5 h-4 w-4 shrink-0 ${ready ? "text-primary" : "text-muted-foreground/45"}`} />
      </div>
    </div>
  );
}

function CollapsibleControlSection({
  icon: Icon,
  title,
  helper,
  status,
  defaultOpen = false,
  children,
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <details
      className="group rounded-xl border border-border bg-card"
      open={open}
      onToggle={(event) => setOpen(event.currentTarget.open)}
    >
      <summary className="grid cursor-pointer list-none grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2 p-4 [&::-webkit-details-marker]:hidden">
        {Icon && <Icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />}
        <div className="min-w-0 flex-1">
          <p className="break-normal text-xs font-semibold uppercase tracking-wider text-primary">{title}</p>
          {helper && <p className="mt-1 text-sm text-muted-foreground">{helper}</p>}
        </div>
        <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
        {status && (
          <span className="col-start-2 max-w-full justify-self-start truncate rounded-full border border-border bg-muted/30 px-2.5 py-1 text-[10px] font-semibold text-muted-foreground">
            {status}
          </span>
        )}
      </summary>
      <div className="border-t border-border p-4">{children}</div>
    </details>
  );
}

function HrSourceSelector({
  settings,
  status,
  recordingActive,
  saving,
  error,
  directStatus,
  onChange,
  onApply,
  onConnectDirectH10,
  onDisconnectDirectH10,
  onForgetDirectH10,
}) {
  const source = HR_SOURCE_OPTIONS.find((option) => option.value === settings.source) || HR_SOURCE_OPTIONS[0];
  const selectedSource = status?.hr?.selectedSource || settings.source;
  const sourceStatus = status?.hr?.sourceStatus || {};
  const pulsoidStatus = status?.hr?.pulsoid || {};
  const directH10Status = status?.hr?.directH10 || {};
  const isPulsoid = settings.source === "pulsoid";
  const isDirectH10 = settings.source === "direct_h10";
  const nativeAndroidBleAvailable = canUseNativeAndroidBle();
  const directH10BlockedOnAndroid = isDirectH10 && isAndroidRuntime() && !nativeAndroidBleAvailable;
  const connected = Boolean(sourceStatus.connected);
  let tokenSummary = "Token stays local to this browser and server session.";
  if (isPulsoid && settings.pulsoidToken) {
    tokenSummary = `Token ${maskPulsoidToken(settings.pulsoidToken)}`;
  } else if (isDirectH10 && directH10BlockedOnAndroid) {
    tokenSummary = "Direct H10 browser Bluetooth is blocked on Android because it can crash during H10 BLE connect.";
  } else if (isDirectH10 && nativeAndroidBleAvailable) {
    tokenSummary = "Uses native Android BLE for Polar H10 HR + RR intervals.";
  } else if (isDirectH10) {
    tokenSummary = "Pairs locally through this browser. RR intervals feed HRV when available.";
  }

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-primary">Heart-rate source</p>
          <p className="mt-1 text-sm text-muted-foreground">
            Select one live HR source for capture. OBS recording sync still comes from the local relay.
          </p>
        </div>
        <div className={`rounded-full border px-3 py-1 text-xs font-semibold ${
          connected ? "border-primary/40 bg-primary/10 text-primary" : "border-border bg-muted/30 text-muted-foreground"
        }`}>
          {sourceStatus.label || source.label}: {connected ? "Live" : sourceStatus.message || "Waiting"}
        </div>
      </div>

      <div className="mt-3 grid gap-2 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto]">
        <label className="space-y-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Provider</span>
          <select
            className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm"
            value={settings.source}
            disabled={recordingActive}
            onChange={(event) => onChange({ source: event.target.value })}
          >
            {HR_SOURCE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        {isDirectH10 ? (
          <div className="space-y-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Direct H10</span>
            <div className="flex h-10 items-center rounded-lg border border-border bg-background px-3 text-sm">
              {directStatus?.connected || directH10Status.connected
                ? directStatus?.deviceName || directH10Status.deviceName || "Polar H10 connected"
                : directStatus?.message || "Use Connect H10 after applying this source."}
            </div>
          </div>
        ) : (
          <label className="space-y-1">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Pulsoid token</span>
            <input
              className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm"
              value={settings.pulsoidToken}
              disabled={recordingActive || !isPulsoid}
              type="password"
              placeholder="Pulsoid access token"
              onChange={(event) => onChange({ pulsoidToken: event.target.value })}
            />
          </label>
        )}
        <div className="flex items-end gap-2">
          {isDirectH10 ? (
            <>
              <button
                type="button"
                className="h-10 rounded-lg border border-border bg-background px-4 text-sm font-semibold text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                disabled={selectedSource !== "direct_h10" || directStatus?.connecting || directH10BlockedOnAndroid}
                onClick={directStatus?.connected ? onDisconnectDirectH10 : onConnectDirectH10}
              >
                {directStatus?.connecting ? "Connecting" : directStatus?.connected ? "Disconnect" : directH10BlockedOnAndroid ? "Native BLE needed" : "Connect H10"}
              </button>
              <button
                type="button"
                className="h-10 rounded-lg border border-border bg-background px-3 text-xs font-semibold text-muted-foreground hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
                disabled={directStatus?.connecting}
                onClick={onForgetDirectH10}
              >
                Forget
              </button>
            </>
          ) : (
            <label className="min-w-32 flex-1 space-y-1">
              <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Mode</span>
              <select
                className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm"
                value={settings.pulsoidMode}
                disabled={recordingActive || !isPulsoid}
                onChange={(event) => onChange({ pulsoidMode: event.target.value })}
              >
                {PULSOID_MODE_OPTIONS.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
          )}
          <button
            type="button"
            className="h-10 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
            disabled={recordingActive || saving || (isPulsoid && !settings.pulsoidToken.trim())}
            onClick={onApply}
          >
            {saving ? "Applying" : selectedSource === settings.source ? "Apply" : "Switch"}
          </button>
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>{source.helper}</span>
        <span>{tokenSummary}</span>
        {isPulsoid && pulsoidStatus.lastMessageAt && <span>Last Pulsoid HR {fmtTime(pulsoidStatus.lastMessageAt)}</span>}
        {isPulsoid && pulsoidStatus.error && <span className="text-destructive">{pulsoidStatus.error}</span>}
        {(directStatus?.lastMessageAt || directH10Status.lastMessageAt) && <span>Last H10 HR {fmtTime(directStatus?.lastMessageAt || directH10Status.lastMessageAt)}</span>}
        {isDirectH10 && <span>{directStatus?.pmdMessage || "Raw ECG and chest motion start after HR/RR connects; failures fall back to HR/RR without stopping capture."}</span>}
        {isDirectH10 && directStatus?.pmdActive && <span className="text-primary">Triple-tap the H10 for a hands-free timeline/sync marker.</span>}
        {nativeAndroidBleAvailable && isDirectH10 && <span className="text-primary">Android native BLE bridge enabled for Direct H10.</span>}
        {directH10BlockedOnAndroid && <span className="text-amber-300">Use Pulsoid on Android browser for now. Install/open Sarah for native Direct H10; browser Bluetooth stays disabled on phones to avoid crashes.</span>}
        {(directStatus?.error || directH10Status.error) && <span className="text-destructive">{directStatus?.error || directH10Status.error}</span>}
        {error && <span className="text-destructive">{error}</span>}
        {recordingActive && <span>Stop recording before switching HR sources.</span>}
      </div>
    </div>
  );
}

function levelColor(percent) {
  const p = Math.max(0, Math.min(100, Number(percent) || 0));
  const hue = Math.round(142 - (142 * p) / 100);
  return `hsl(${hue} 74% 45%)`;
}

function phaseMarkerColor(label = "") {
  const normalized = String(label).toLowerCase();
  if (normalized.includes("recovery")) return "hsl(var(--chart-2))";
  if (normalized.includes("climax")) return "hsl(var(--destructive))";
  if (normalized.includes("build")) return "hsl(var(--primary))";
  return "hsl(var(--chart-4))";
}

function hrLevelPercent(value, baseline) {
  const hr = Number(value);
  if (!Number.isFinite(hr)) return null;
  const base = Number(baseline);
  if (Number.isFinite(base)) return Math.max(0, Math.min(100, ((hr - base) / 45) * 100));
  return Math.max(0, Math.min(100, ((hr - 70) / 70) * 100));
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => resolve(String(reader.result || "").split(",")[1] || "");
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

function normalizeVoiceAnnotationText(value) {
  let text = String(value || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2")
    .replace(/\s+/g, " ")
    .trim();
  text = text.replace(/^(sarah|pulse\s*point|pulsepoint)[,:\-\s]+/i, "").trim();
  text = text.replace(/\b(?:stop|end|done|save|stop recording|end recording)\b[\s.!?]*$/i, "").trim();
  text = text.replace(/\s+([,.!?;:])/g, "$1").trim();
  return text;
}

function categorizeVoiceNote(note) {
  const text = String(note || "").toLowerCase();
  const categories = new Set();
  if (/\b(stroke|stroking|grip|squeeze|speed|pressure|manual|sleeve|vibrat|estim|e-stim|foley|catheter|perine|glans|shaft|stimulation)\b/.test(text)) {
    categories.add("stimulation");
  }
  if (/\b(start|started|begin|began|first contact)\b/.test(text)) categories.add("stimulation_started");
  if (/\b(pause|paused|break|stop touching|stopped touching)\b/.test(text)) categories.add("stimulation_paused");
  if (/\b(resume|resumed|restart|restarted)\b/.test(text)) categories.add("stimulation_resumed");
  if (/\b(stopped|stop stimulation|ended stimulation|stimulation stopped)\b/.test(text)) categories.add("stimulation_stopped");
  if (/\b(leg|legs|feet|foot|toe|curl|plant|planted|tense|tensing|relax|shudder|tremor|spasm|pelvic|breath|erection|foreskin|scrot|body)\b/.test(text)) {
    categories.add("physical");
  }
  if (/\b(feel|felt|sensation|pleasure|pressure|tingle|urge|near|climax|release|recovery|sensitive|discomfort|pain)\b/.test(text)) {
    categories.add("sensation");
  }
  return categories.size ? [...categories] : ["other"];
}

function tagVoiceNote(note) {
  const text = String(note || "").toLowerCase();
  const tags = new Set();
  if (/\b(leg|legs|feet|foot|toe|curl|plant|planted|tense|tensing|shudder|tremor|spasm|breath|erection|foreskin|scrot|body)\b/.test(text)) tags.add("physical_finding");
  if (/\b(hr|heart rate|bpm|sympathetic|parasympathetic|arousal|climax|ejaculat|release|recovery|autonomic)\b/.test(text)) tags.add("physiological_observation");
  if (/\b(stroke|stroking|grip|squeeze|speed|pressure|manual|sleeve|vibrat|estim|e-stim|foley|catheter|perine|glans|shaft|stimulation)\b/.test(text)) tags.add("stimulation_action");
  if (/\b(increase|increasing|decrease|decreasing|faster|slower|firmer|lighter|pause|resume|stop|start|switch|adjust)\b/.test(text)) tags.add("stimulation_change");
  if (/\b(feel|felt|sensation|pleasure|pressure|tingle|urge|near|sensitive|discomfort|pain)\b/.test(text)) tags.add("sensation_report");
  if (/\b(position|reposition|moved|shifted|table|comfort|pillow|supine|lithotomy)\b/.test(text)) tags.add("position_or_comfort");
  return tags.size ? [...tags] : ["other_context"];
}

function isEndListeningCommand(text) {
  const words = String(text || "").toLowerCase().replace(/[^a-z]+/g, " ").trim().split(/\s+/).filter(Boolean);
  const phrase = words.join(" ");
  if (!phrase) return false;
  if (phrase === "end" || phrase === "stop") return true;
  if (phrase.includes("end listening") || phrase.includes("stop listening")) return true;
  if (phrase.includes("sarah end")) return true;
  if (phrase.includes("pulse point end") || phrase.includes("pulsepoint end")) return true;
  return words.includes("end") && words.length <= 3;
}

function normalizeHowlVoicePhrase(value) {
  return String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function getHowlActivityByVoicePhrase(phrase) {
  const normalized = normalizeHowlVoicePhrase(phrase);
  if (!normalized) return null;
  return HOWL_ACTIVITY_MODES.find((mode) => {
    const names = [mode.name, mode.displayName, ...(mode.aliases || [])].map(normalizeHowlVoicePhrase);
    return names.some((alias) => alias && new RegExp(`\\b${alias.replace(/\s+/g, "\\s+")}\\b`).test(normalized));
  }) || null;
}

function parseHowlVoiceCommand(text, { ceiling = 20 } = {}) {
  const phrase = normalizeHowlVoicePhrase(text);
  if (!phrase || !/\bsarah\b/.test(phrase)) return null;

  if (/\b(emergency stop|panic|kill|mute|stop howl|howl stop)\b/.test(phrase)) {
    return {
      action: "emergency_stop",
      extra: { reason: "voice_howl_emergency_stop" },
      status: "Sarah heard emergency stop.",
      requiresConnection: false,
    };
  }

  const activity = getHowlActivityByVoicePhrase(phrase);
  if (activity && /\b(switch|change|load|select|start|play|mode)\b/.test(phrase)) {
    return {
      action: "load_activity",
      extra: { activityName: activity.name, activityDisplayName: activity.displayName, play: /\b(start|play|run)\b/.test(phrase), reason: "voice_howl_activity" },
      status: `Sarah switching Howl to ${activity.displayName}.`,
      requiresConnection: true,
    };
  }

  const numberMatch = phrase.match(/\b(?:to|level|intensity|power)?\s*(\d{1,3})\b/);
  if (numberMatch && /\b(howl|intensity|power|level)\b/.test(phrase)) {
    const requested = Number(numberMatch[1]);
    const capped = Math.max(0, Math.min(Number.isFinite(Number(ceiling)) ? Number(ceiling) : 20, requested));
    const channel = /\b(channel )?b\b/.test(phrase) ? "b" : /\b(channel )?a\b/.test(phrase) ? "a" : "all";
    return {
      action: "set_power",
      extra: { channel, intensity: capped, requestedIntensity: requested, reason: "voice_howl_intensity" },
      status: requested === capped ? `Sarah setting Howl to ${capped}.` : `Sarah capped Howl at ${capped}.`,
      requiresConnection: true,
    };
  }

  if (/\b(power|turn|bump|step|increase|raise|up|decrease|lower|down)\b/.test(phrase)) {
    const channel = /\b(channel )?b\b/.test(phrase) ? "b" : "a";
    if (/\b(up|increase|raise|bump)\b/.test(phrase)) {
      return {
        action: "increment_power",
        extra: { channel, step: 1, reason: "voice_howl_power_up" },
        status: `Sarah powering up channel ${channel.toUpperCase()}.`,
        requiresConnection: true,
      };
    }
    if (/\b(down|decrease|lower|reduce)\b/.test(phrase)) {
      return {
        action: "decrement_power",
        extra: { channel, step: 1, reason: "voice_howl_power_down" },
        status: `Sarah powering down channel ${channel.toUpperCase()}.`,
        requiresConnection: true,
      };
    }
  }

  return null;
}

function parseLiveCommand(text) {
  const phrase = String(text || "").toLowerCase().replace(/[^a-z]+/g, " ").trim();
  if (!phrase) return null;
  if (/\b(undo last|delete last|remove last)\b/.test(phrase)) return { type: "undo_last" };
  if (/\b(mark pre climax|mark preclimax|pre climax)\b/.test(phrase)) return { type: "mark_phase", key: "pre_climax_offset_s", label: "Pre-climax" };
  if (/\b(mark climax|climax now)\b/.test(phrase)) return { type: "mark_phase", key: "climax_offset_s", label: "Climax" };
  if (/\b(mark recovery|recovery now)\b/.test(phrase)) return { type: "mark_phase", key: "recovery_offset_s", label: "Recovery" };
  if (/\b(pause annotation|pause annotations)\b/.test(phrase)) return { type: "stop_listening" };
  return null;
}

function makeTelemetryPoint(hrTelemetry, emgTelemetry, options = {}) {
  const now = Date.now();
  const hrv = hrTelemetry?.hrv || {};
  const multimodal = hrTelemetry?.multimodal || {};
  return {
    ts: now,
    time: new Date(now).toLocaleTimeString([], { minute: "2-digit", second: "2-digit" }),
    hr: readNumber(hrTelemetry?.currentHr, hrTelemetry?.hr, hrTelemetry?.heartRate),
    hrSmoothed: readNumber(hrTelemetry?.hrSmoothed, hrTelemetry?.smoothedHr, hrTelemetry?.hr_smoothed),
    baseline: readNumber(hrTelemetry?.baselineHr, hrTelemetry?.baseline_hr),
    build: readNumber(hrTelemetry?.buildConfidence, hrTelemetry?.build_confidence),
    phase: hrTelemetry?.phase || null,
    sessionTimeSec: readNumber(options?.sessionTimeSec),
    hrSource: hrTelemetry?.source || hrTelemetry?.hr_source || null,
    hrvRmssd: readNumber(hrv.rmssdMs, hrTelemetry?.hrv_rmssd_ms),
    hrvSdnn: readNumber(hrv.sdnnMs, hrTelemetry?.hrv_sdnn_ms),
    hrvPnn50: readNumber(hrv.pnn50, hrTelemetry?.hrv_pnn50),
    hrvQuality: hrv.quality || hrTelemetry?.hrv_quality || null,
    motionClass: multimodal.motion?.class || null,
    motionRms: readNumber(multimodal.motion?.dynamicRmsMilliG),
    respirationBpm: readNumber(multimodal.respiration?.bpm),
    respirationConfidence: multimodal.respiration?.confidence || null,
    possibleBreathHold: Boolean(multimodal.respiration?.possibleBreathHold),
    breathHoldDurationSeconds: readNumber(multimodal.respiration?.holdDurationSeconds),
    signalConfidence: readNumber(multimodal.signalConfidence?.score),
    autonomicState: multimodal.state?.key || null,
    recoveryDropBpm: readNumber(multimodal.recovery?.currentDropBpm),
    howlIntensity: readNumber(options?.howlIntensity),
    left: readNumber(emgTelemetry?.left_pct, emgTelemetry?.level_pct),
    right: readNumber(emgTelemetry?.right_pct),
    diff: readNumber(emgTelemetry?.diff_pct),
  };
}

function StatusDot({ active }) {
  return (
    <span className={`h-2.5 w-2.5 rounded-full ${active ? "bg-primary shadow-[0_0_12px_hsl(var(--primary))]" : "bg-muted-foreground/40"}`} />
  );
}

function MetricCard({ icon, label, value, helper, active, level, large = false, display = false, beatPulse = 0, valueClassName = "" }) {
  const hasLevel = Number.isFinite(Number(level));
  const color = hasLevel ? levelColor(level) : null;
  return (
    <div
      className={`relative min-w-0 overflow-hidden rounded-xl border transition-shadow ${display ? "min-h-[14rem] p-6" : large ? "min-h-[10.5rem] p-5" : "min-h-[8rem] p-4"} ${active ? "border-primary/40 bg-primary/8" : "border-border bg-card"} ${beatPulse ? "shadow-[0_0_30px_rgba(244,63,94,0.55)] ring-2 ring-rose-400/70" : ""}`}
      style={hasLevel ? { borderColor: `${color}9a`, background: `linear-gradient(135deg, ${color}38, ${color}10 55%, hsl(var(--card)) 100%)` } : undefined}
    >
      {beatPulse ? <span key={`metric-beat-${label}-${beatPulse}`} className="pointer-events-none absolute right-4 top-4 h-5 w-5 rounded-full bg-rose-400/45 animate-ping" /> : null}
      {hasLevel && (
        <div
          className="absolute inset-x-0 bottom-0 h-1 transition-all"
          style={{ width: `${Math.max(4, Math.min(100, Number(level)))}%`, background: color }}
        />
      )}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          {icon}
          {label}
        </div>
        <StatusDot active={active || hasLevel} />
      </div>
      <p className={`mt-3 min-w-0 whitespace-nowrap font-bold leading-none tracking-normal text-foreground tabular-nums ${display ? "text-[clamp(3.75rem,6.5vw,7.5rem)]" : large ? "text-5xl" : "text-3xl"} ${valueClassName}`}>{value}</p>
      {helper && <p className={`mt-2 min-h-[2.5rem] text-muted-foreground ${display ? "text-xl" : large ? "text-sm" : "text-xs"}`}>{helper}</p>}
    </div>
  );
}

function CompactStat({ label, value, helper, level, emphasis = false, beatPulse = 0 }) {
  const hasLevel = Number.isFinite(Number(level));
  const color = hasLevel ? levelColor(level) : null;
  return (
    <div
      className={`relative flex overflow-hidden rounded-xl border px-4 py-3 transition-shadow ${emphasis ? "h-[7.5rem]" : "h-[6.75rem]"} ${hasLevel ? "" : "border-border bg-muted/25"} ${beatPulse ? "shadow-[0_0_26px_rgba(244,63,94,0.55)] ring-2 ring-rose-400/70" : ""}`}
      style={hasLevel ? { borderColor: `${color}9a`, background: `linear-gradient(135deg, ${color}42, ${color}12 54%, hsl(var(--card)) 100%)` } : undefined}
    >
      {beatPulse ? <span key={`compact-beat-${label}-${beatPulse}`} className="pointer-events-none absolute right-4 top-4 h-4 w-4 rounded-full bg-rose-400/45 animate-ping" /> : null}
      {hasLevel && <div className="absolute inset-x-0 bottom-0 h-1.5" style={{ backgroundColor: color }} />}
      <div className="flex min-w-0 flex-1 flex-col justify-between">
        <p className="truncate text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</p>
        <p className={`mt-2 truncate font-bold tabular-nums leading-none tracking-tight text-foreground ${emphasis ? "text-5xl" : "text-4xl"}`}>{value}</p>
        <p className="mt-1 h-5 truncate text-sm font-medium leading-5 text-foreground/75">{helper || "\u00a0"}</p>
      </div>
    </div>
  );
}

function FileCard({ title, file }) {
  return (
    <div className="rounded-lg border border-border bg-muted/30 px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</p>
      <p className="mt-1 truncate text-sm font-medium text-foreground">{file?.name || "No file detected"}</p>
      <p className="mt-0.5 text-[10px] text-muted-foreground">{file?.modifiedAt ? `Updated ${fmtTime(file.modifiedAt)}` : "Waiting for finalized capture"}</p>
    </div>
  );
}

function ChartTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border bg-popover px-3 py-2 text-xs shadow-lg">
      <p className="mb-1 font-semibold text-foreground">{label}</p>
      {payload.map((entry) => (
        <div key={entry.dataKey} className="flex items-center justify-between gap-4">
          <span style={{ color: entry.color }}>{entry.name}</span>
          <span className="font-mono text-foreground">{fmtNumber(entry.value, 0)}</span>
        </div>
      ))}
    </div>
  );
}

function EmptyChartState() {
  return (
    <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-border bg-muted/20 text-sm text-muted-foreground">
      Waiting for live samples
    </div>
  );
}

function TrendPanel({ title, subtitle, children, empty, heightClass = "h-56", distanceView = false }) {
  return (
    <div className="rounded-xl border border-border bg-muted/20 p-3">
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <p className={`${distanceView ? "text-sm" : "text-xs"} font-semibold uppercase tracking-wider text-primary`}>{title}</p>
          {subtitle && <p className={`mt-0.5 text-muted-foreground ${distanceView ? "text-sm" : "text-[11px]"}`}>{subtitle}</p>}
        </div>
      </div>
      <div className={heightClass}>
        {empty ? <EmptyChartState /> : children}
      </div>
    </div>
  );
}

function SetupTile({ icon, label, value, helper, active, tone = "default", children }) {
  const toneClass = active
    ? "border-primary/35 bg-primary/10"
    : tone === "warn"
      ? "border-amber-400/35 bg-amber-400/10"
      : "border-border bg-card/80";
  return (
    <div className={`rounded-xl border p-3 ${toneClass}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
            {icon}
            <span>{label}</span>
          </div>
          <p className="mt-2 text-lg font-bold tracking-tight text-foreground">{value}</p>
          {helper && <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{helper}</p>}
        </div>
        <StatusDot active={active} />
      </div>
      {children && <div className="mt-3 flex flex-wrap gap-2">{children}</div>}
    </div>
  );
}

function liveHealthToneClasses(tone = "neutral") {
  if (tone === "good") return "border-emerald-400/30 bg-emerald-500/10 text-emerald-200";
  if (tone === "warn") return "border-amber-400/30 bg-amber-400/10 text-amber-200";
  if (tone === "bad") return "border-destructive/30 bg-destructive/10 text-destructive";
  return "border-border bg-muted/30 text-muted-foreground";
}

function LiveHealthPill({ label, value, helper, tone = "neutral" }) {
  return (
    <div className={`rounded-xl border px-3 py-2 ${liveHealthToneClasses(tone)}`}>
      <div className="flex items-center justify-between gap-3">
        <p className="text-[10px] font-semibold uppercase tracking-wider">{label}</p>
        <span className="text-xs font-bold">{value}</span>
      </div>
      <p className="mt-1 text-[11px] leading-relaxed opacity-90">{helper}</p>
    </div>
  );
}

export default function LiveCapture() {
  const [searchParams, setSearchParams] = useSearchParams();
  const focusView = searchParams.get("display") === "focus";
  const { toast } = useToast();
  const liveCaptureWakeLockRef = useRef(null);
  const [status, setStatus] = useState(null);
  const [hrTelemetry, setHrTelemetry] = useState(null);
  const [emgTelemetry, setEmgTelemetry] = useState(null);
  const [recording, setRecording] = useState(null);
  const [files, setFiles] = useState(null);
  const [liveSession, setLiveSession] = useState(null);
  const [activeSessionDoc, setActiveSessionDoc] = useState(null);
  const [endingSession, setEndingSession] = useState(false);
  const [connected, setConnected] = useState(false);
  const [telemetryHistory, setTelemetryHistory] = useState([]);
  const [liveEvents, setLiveEvents] = useState([]);
  const [phaseMarkers, setPhaseMarkers] = useState([]);
  const [hrSourceSettings, setHrSourceSettings] = useState(() => readHrSourceSettings());
  const [hrSourceSaving, setHrSourceSaving] = useState(false);
  const [hrSourceError, setHrSourceError] = useState("");
  const [directH10Status, setDirectH10Status] = useState(() => {
    const remembered = readRememberedDirectH10Device();
    return {
      connected: false,
      connecting: false,
      deviceName: remembered?.name || "",
      message: remembered ? `Saved ${remembered.name} ready to reconnect` : "Direct H10 not connected",
      error: "",
      lastMessageAt: null,
      rrCount: 0,
    };
  });
  const [hrLossDialog, setHrLossDialog] = useState(null);
  const [h10Multimodal, setH10Multimodal] = useState(() => emptyH10MultimodalSnapshot());
  const [captureKind, setCaptureKind] = useState(() => localStorage.getItem("pulsepoint.captureKind") || "session");
  const [captureKindError, setCaptureKindError] = useState("");
  const [captureMode, setCaptureMode] = useState(() => localStorage.getItem("pulsepoint.captureMode") || "full");
  const [emgSensorConfig, setEmgSensorConfig] = useState(() => localStorage.getItem("pulsepoint.emgSensorConfig") || "generic");
  const [telemetryNoticesEnabled, setTelemetryNoticesEnabled] = useState(() => localStorage.getItem("pulsepoint.telemetryNotices") !== "off");
  const [latestTelemetryNotice, setLatestTelemetryNotice] = useState(null);
  const [heartbeatAudioEnabled, setHeartbeatAudioEnabled] = useState(() => localStorage.getItem("pulsepoint.heartbeatAudio") === "on");
  const [heartbeatPulseId, setHeartbeatPulseId] = useState(0);
  const [voiceWakeEnabled, setVoiceWakeEnabled] = useState(false);
  const [wakeListening, setWakeListening] = useState(false);
  const [annotationRecording, setAnnotationRecording] = useState(false);
  const [voiceStatus, setVoiceStatus] = useState("Say “Sarah” to start a voice annotation. Say “end” to stop listening.");
  const [voiceError, setVoiceError] = useState("");
  const [lastVoiceNote, setLastVoiceNote] = useState("");
  const [mediaVideo, setMediaVideo] = useState(null);
  const [mediaDragging, setMediaDragging] = useState(false);
  const [mediaFullscreen, setMediaFullscreen] = useState(false);
  const [mediaPlaying, setMediaPlaying] = useState(false);
  const [mediaProcessing, setMediaProcessing] = useState("");
  const [mediaError, setMediaError] = useState("");
  const [presetModalOpen, setPresetModalOpen] = useState(false);
  const [telemetryDashboardOpen, setTelemetryDashboardOpen] = useState(false);
  const [telemetryDashboard, setTelemetryDashboard] = useState(() => readTelemetryDashboard());
  const [calibrationOpen, setCalibrationOpen] = useState(false);
  const [calibrationSaving, setCalibrationSaving] = useState("");
  const [calibrationStatus, setCalibrationStatus] = useState("");
  const [calibrationError, setCalibrationError] = useState("");
  const [calibrationCommandStatus, setCalibrationCommandStatus] = useState(null);
  const [perinealDetectorSnapshot, setPerinealDetectorSnapshot] = useState(() => createPerinealEmgDetector());
  const [perinealProtocol, setPerinealProtocol] = useState({
    running: false,
    phaseIndex: -1,
    phaseStartedAtMs: null,
    phaseEndsAtMs: null,
    captures: {},
    message: "Ready",
  });
  const [howlTelemetry, setHowlTelemetry] = useState(null);
  const [howlCapabilities, setHowlCapabilities] = useState(null);
  const [howlError, setHowlError] = useState("");
  const [howlRefreshing, setHowlRefreshing] = useState(false);
  const [howlControlOpen, setHowlControlOpen] = useState(false);
  const [howlControlForm, setHowlControlForm] = useState(HOWL_DEFAULT_CONTROL_FORM);
  const [howlCommandForm, setHowlCommandForm] = useState(HOWL_DEFAULT_COMMAND_FORM);
  const [howlControlBusy, setHowlControlBusy] = useState("");
  const [howlControlStatus, setHowlControlStatus] = useState("");
  const [howlCommandHistory, setHowlCommandHistory] = useState([]);
  const [howlAutoStatus, setHowlAutoStatus] = useState("Sarah auto-control is off.");
  const [howlSettingsDirty, setHowlSettingsDirty] = useState(false);
  const [howlConnectionTest, setHowlConnectionTest] = useState({ status: "idle", message: "" });
  const [howlAdvancedOpen, setHowlAdvancedOpen] = useState(false);
  const [howlQuickModalOpen, setHowlQuickModalOpen] = useState(false);
  const [bpCapture, setBpCapture] = useState({
    sessionId: null,
    status: "idle",
    message: "Blood pressure sync is watching the local PulsePoint database.",
    lastReading: null,
    lastCapturedAt: null,
    capturedCount: 0,
    permissionGranted: false,
    native: null,
    syncing: false,
    error: "",
  });
  const [bpOmronListening, setBpOmronListening] = useState(false);
  const [launchProfile, setLaunchProfile] = useState(() => readLiveCaptureLaunchProfile());
  const [advancedSetupOpen, setAdvancedSetupOpen] = useState(false);
  const [launchState, setLaunchState] = useState({ phase: "idle", message: "", steps: [], busy: false, error: "" });
  const [liveCueSettings, setLiveCueSettings] = useState(() => ({
    ...DEFAULT_LIVE_CUE_SETTINGS,
    enabled: readLiveCaptureLaunchProfile().livePhysiologyCuesEnabled,
    style: readLiveCaptureLaunchProfile().cueStyle,
    volume: readLiveCaptureLaunchProfile().cueVolume,
    pan: readLiveCaptureLaunchProfile().cuePan,
    mediaDucking: readLiveCaptureLaunchProfile().mediaDucking,
  }));
  const latestHrRef = useRef(null);
  const latestEmgRef = useRef(null);
  const perinealDetectorRef = useRef(createPerinealEmgDetector());
  const perinealProtocolRef = useRef(perinealProtocol);
  const perinealSaveQueueRef = useRef(Promise.resolve());
  const lastPerinealSampleSignatureRef = useRef("");
  const recognitionRef = useRef(null);
  const wakeRestartTimerRef = useRef(null);
  const voiceWakeEnabledRef = useRef(false);
  const annotationRecordingRef = useRef(false);
  const applyLiveCommandRef = useRef(null);
  const startVoiceAnnotationRef = useRef(null);
  const desktopWakeHoldoffUntilRef = useRef(0);
  const mediaRecorderRef = useRef(null);
  const voiceChunksRef = useRef([]);
  const voiceNoteTimeRef = useRef(0);
  const voiceNoteTimeoutRef = useRef(null);
  const voiceSilenceRafRef = useRef(null);
  const voiceAudioSourceRef = useRef(null);
  const voiceSilenceStartedRef = useRef(null);
  const audioContextRef = useRef(null);
  const heartbeatAudioContextRef = useRef(null);
  const heartbeatAudioBusRef = useRef(null);
  const heartbeatAudioEnabledRef = useRef(heartbeatAudioEnabled);
  const lastHeartbeatAtRef = useRef(0);
  const lastHeartbeatTelemetryKeyRef = useRef("");
  const lastHeartbeatSampleAtRef = useRef(0);
  const lastHeartbeatIntervalMsRef = useRef(0);
  const heartbeatPredictionTimerRef = useRef(null);
  const lastPhaseMarkerRef = useRef({ label: "", ts: 0 });
  const mediaVideoRef = useRef(null);
  const mediaInputRef = useRef(null);
  const mediaObjectUrlRef = useRef(null);
  const appliedCalibrationCommandRef = useRef("");
  const pendingCalibrationCommandRef = useRef("");
  const directH10DeviceRef = useRef(null);
  const directH10NativeDeviceIdRef = useRef("");
  const directH10TransportRef = useRef("");
  const directH10CharacteristicRef = useRef(null);
  const directH10NotificationHandlerRef = useRef(null);
  const directH10RrRef = useRef([]);
  const directH10PmdStoreRef = useRef(createH10PmdStore());
  const directH10PmdNativeActiveRef = useRef(false);
  const directH10PmdBrowserRef = useRef(null);
  const directH10PmdControlWaitersRef = useRef(new Map());
  const h10MultimodalRef = useRef(h10Multimodal);
  const telemetryHistoryRef = useRef(telemetryHistory);
  const appendTelemetryPointRef = useRef(() => {});
  const liveEventsRef = useRef(liveEvents);
  const directH10StatusRef = useRef(directH10Status);
  const directH10RelaySocketRef = useRef(null);
  const directH10IntentionalDisconnectRef = useRef(false);
  const directH10ReconnectAttemptRef = useRef(0);
  const directH10ReconnectTimerRef = useRef(null);
  const directH10ForegroundReconnectCooldownRef = useRef(0);
  const directH10ReconnectEnabledRef = useRef(false);
  const directH10ConnectRef = useRef(null);
  const directH10AutoConnectStartedRef = useRef(false);
  const howlAutoLastActionRef = useRef({ at: 0, intensity: null, reason: "" });
  const howlAutoCandidateRef = useRef({ key: "", since: 0, target: null });
  const howlPhysiologyControllerRef = useRef(createHowlPhysiologyControllerState());
  const appendLiveSessionEventsRef = useRef(null);
  const bpSyncInFlightRef = useRef(false);
  const bpOmronActionInFlightRef = useRef(false);
  const bpForegroundRefreshCooldownRef = useRef(0);
  const bpOmronSeenRef = useRef(new Set());
  const bpSessionIdRef = useRef(null);
  const howlSettingsDirtyRef = useRef(false);
  const howlFocusedFieldRef = useRef("");
  const launchInFlightRef = useRef(null);
  const restoredLaunchProfileRef = useRef(false);
  const liveRecordEntity = liveSession?.entity || (captureKind === "body_exploration" ? "BodyExploration" : "Session");
  const liveRecordApi = base44.entities[liveRecordEntity] || base44.entities.Session;
  const captureIsBodyExploration = liveRecordEntity === "BodyExploration" || captureKind === "body_exploration";

  useEffect(() => {
    directH10StatusRef.current = directH10Status;
  }, [directH10Status]);

  useEffect(() => {
    h10MultimodalRef.current = h10Multimodal;
  }, [h10Multimodal]);

  useEffect(() => {
    telemetryHistoryRef.current = telemetryHistory;
  }, [telemetryHistory]);

  useEffect(() => {
    liveEventsRef.current = liveEvents;
  }, [liveEvents]);

  useEffect(() => {
    const activeSessionId = liveSession?.activeSessionId || null;
    if (bpSessionIdRef.current === activeSessionId) return;
    bpSessionIdRef.current = activeSessionId;
    setBpCapture((previous) => resetBloodPressureCaptureForSession(previous, activeSessionId));
  }, [liveSession?.activeSessionId]);

  useEffect(() => {
    if (restoredLaunchProfileRef.current) return;
    restoredLaunchProfileRef.current = true;
    const profile = readLiveCaptureLaunchProfile();
    setLaunchProfile(profile);
    setCaptureKind(profile.captureKind || "session");
    setCaptureMode(profile.captureMode || "full");
    setEmgSensorConfig(profile.emgSensorConfig || "generic");
    setTelemetryNoticesEnabled(profile.telemetryNoticesEnabled !== false);
    setHeartbeatAudioEnabled(Boolean(profile.heartbeatAudioEnabled));
    setHrSourceSettings((prev) => ({
      ...prev,
      source: profile.hrSource || prev.source,
      pulsoidMode: profile.pulsoidMode || prev.pulsoidMode,
    }));
    setLiveCueSettings((prev) => ({
      ...prev,
      enabled: profile.livePhysiologyCuesEnabled !== false,
      style: profile.cueStyle || prev.style,
      volume: profile.cueVolume ?? prev.volume,
      pan: profile.cuePan || prev.pan,
      mediaDucking: profile.mediaDucking !== false,
    }));
  }, []);

  const getHeartbeatAudioContext = useCallback(async () => {
    if (!heartbeatAudioContextRef.current || heartbeatAudioContextRef.current.state === "closed") {
      const AudioCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtor) return null;
      heartbeatAudioContextRef.current = new AudioCtor();
      heartbeatAudioBusRef.current = null;
    }
    if (heartbeatAudioContextRef.current.state === "suspended") {
      await heartbeatAudioContextRef.current.resume();
    }
    if (!heartbeatAudioBusRef.current) {
      const ctx = heartbeatAudioContextRef.current;
      const master = ctx.createGain();
      const compressor = ctx.createDynamicsCompressor();
      master.gain.value = 0.82;
      compressor.threshold.value = -22;
      compressor.knee.value = 18;
      compressor.ratio.value = 3.5;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.11;
      master.connect(compressor);
      compressor.connect(ctx.destination);
      heartbeatAudioBusRef.current = { master, compressor };
    }
    return heartbeatAudioContextRef.current;
  }, []);

  const playHeartbeatBeep = useCallback(async () => {
    if (!heartbeatAudioEnabledRef.current) return;
    try {
      const ctx = await getHeartbeatAudioContext();
      if (!ctx || ctx.state === "closed") return;
      const t = ctx.currentTime + 0.004;
      const bus = heartbeatAudioBusRef.current?.master || ctx.destination;
      const bodyOsc = ctx.createOscillator();
      const bodyGain = ctx.createGain();
      const clickOsc = ctx.createOscillator();
      const clickGain = ctx.createGain();

      bodyOsc.type = "triangle";
      bodyOsc.frequency.setValueAtTime(980, t);
      bodyOsc.frequency.exponentialRampToValueAtTime(820, t + 0.042);
      bodyGain.gain.setValueAtTime(0.0001, t);
      bodyGain.gain.exponentialRampToValueAtTime(0.022, t + 0.0075);
      bodyGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.05);

      clickOsc.type = "sine";
      clickOsc.frequency.setValueAtTime(1320, t);
      clickOsc.frequency.exponentialRampToValueAtTime(1120, t + 0.018);
      clickGain.gain.setValueAtTime(0.0001, t);
      clickGain.gain.exponentialRampToValueAtTime(0.014, t + 0.0045);
      clickGain.gain.exponentialRampToValueAtTime(0.0001, t + 0.018);

      bodyOsc.connect(bodyGain);
      clickOsc.connect(clickGain);
      bodyGain.connect(bus);
      clickGain.connect(bus);

      bodyOsc.start(t);
      bodyOsc.stop(t + 0.06);
      clickOsc.start(t);
      clickOsc.stop(t + 0.024);
    } catch {}
  }, [getHeartbeatAudioContext]);

  const clearHeartbeatPrediction = useCallback(() => {
    if (heartbeatPredictionTimerRef.current) {
      window.clearTimeout(heartbeatPredictionTimerRef.current);
      heartbeatPredictionTimerRef.current = null;
    }
  }, []);

  const emitHeartbeatPulse = useCallback((telemetry = latestHrRef.current, { eventTimeMs = Date.now(), mode = "actual" } = {}) => {
    if (!heartbeatAudioEnabledRef.current) return;
    const hr = readNumber(telemetry?.currentHr, telemetry?.hr, telemetry?.heartRate);
    if (hr == null) return false;
    const baseIntervalMs = 60000 / Math.max(40, hr);
    const minInterval = Math.max(280, Math.min(1100, baseIntervalMs * 0.72));
    if (eventTimeMs - lastHeartbeatAtRef.current < minInterval) return false;
    lastHeartbeatAtRef.current = eventTimeMs;
    setHeartbeatPulseId((value) => value + 1);
    playHeartbeatBeep();
    return true;
  }, [playHeartbeatBeep]);

  const schedulePredictedHeartbeat = useCallback((intervalMs) => {
    clearHeartbeatPrediction();
    const safeIntervalMs = Math.max(280, Math.min(1500, Number(intervalMs) || 0));
    if (!safeIntervalMs) return;
    lastHeartbeatIntervalMsRef.current = safeIntervalMs;
    const targetMs = lastHeartbeatAtRef.current + safeIntervalMs;
    const delayMs = Math.max(0, targetMs - Date.now());
    heartbeatPredictionTimerRef.current = window.setTimeout(() => {
      heartbeatPredictionTimerRef.current = null;
      if (!heartbeatAudioEnabledRef.current) return;
      if (Date.now() - lastHeartbeatSampleAtRef.current > HEARTBEAT_PREDICTION_STALE_MS) return;
      const fired = emitHeartbeatPulse(latestHrRef.current, { eventTimeMs: targetMs, mode: "predicted" });
      if (fired) schedulePredictedHeartbeat(lastHeartbeatIntervalMsRef.current || safeIntervalMs);
    }, delayMs);
  }, [clearHeartbeatPrediction, emitHeartbeatPulse]);

  const maybeTriggerHeartbeatFromTelemetry = useCallback((telemetry) => {
    const hr = readNumber(telemetry?.currentHr, telemetry?.hr, telemetry?.heartRate);
    if (hr == null) return;
    const now = Date.now();
    const key = [
      telemetry?.source || "",
      telemetry?.measuredAt || telemetry?.source_at || telemetry?.receivedAt || telemetry?.lastMessageAt || "",
      telemetry?.rrIntervalsMs?.join?.(":") || telemetry?.rr_intervals_ms?.join?.(":") || "",
      hr,
    ].join("|");
    if (key && key === lastHeartbeatTelemetryKeyRef.current) return;
    lastHeartbeatTelemetryKeyRef.current = key;
    lastHeartbeatSampleAtRef.current = now;
    emitHeartbeatPulse(telemetry, { eventTimeMs: now, mode: "actual" });
    const intervalMs = readHeartbeatIntervalMs(telemetry);
    if (intervalMs) schedulePredictedHeartbeat(intervalMs);
  }, [emitHeartbeatPulse, schedulePredictedHeartbeat]);

  const markHowlSettingsDirty = useCallback((dirty) => {
    howlSettingsDirtyRef.current = Boolean(dirty);
    setHowlSettingsDirty(Boolean(dirty));
  }, []);

  const updateHowlControlForm = useCallback((patch = {}, { resetConnection = true } = {}) => {
    setHowlControlForm((prev) => ({ ...prev, ...patch }));
    markHowlSettingsDirty(true);
    if (resetConnection) {
      setHowlConnectionTest({ status: "idle", message: "Connection needs a fresh test after these edits." });
    }
  }, [markHowlSettingsDirty]);

  const refreshHowlTelemetry = useCallback(async ({ quiet = false, forceSettings = false } = {}) => {
    if (!quiet) setHowlRefreshing(true);
    try {
      const [recentResponse, statusResponse, capabilitiesResponse, settingsResponse, commandsResponse] = await Promise.all([
        fetch(apiUrl("/howl/telemetry/recent?limit=1")),
        fetch(apiUrl("/howl/control/status")),
        fetch(apiUrl("/howl/control-capabilities")),
        fetch(apiUrl("/howl/control/settings")),
        fetch(apiUrl("/howl/control/commands?limit=5")),
      ]);
      if (!recentResponse.ok) throw new Error("Howl telemetry route is not responding.");
      const recent = await recentResponse.json();
      const liveStatus = statusResponse.ok ? await statusResponse.json() : null;
      const capabilities = capabilitiesResponse.ok ? await capabilitiesResponse.json() : null;
      const settingsPayload = settingsResponse.ok ? await settingsResponse.json() : null;
      const commandsPayload = commandsResponse.ok ? await commandsResponse.json() : null;
      const liveHowlTelemetry = liveStatus?.ok && liveStatus?.howl ? {
        ...liveStatus.howl,
        source: "howl_status",
        measured_at: liveStatus.measured_at || new Date().toISOString(),
        received_at: new Date().toISOString(),
        mode: liveStatus.howl?.player?.filename || liveStatus.howl?.player?.title || null,
        raw: liveStatus.raw || null,
      } : null;
      setHowlTelemetry(liveHowlTelemetry || recent?.samples?.[0] || null);
      setHowlCapabilities(capabilities);
      if (liveStatus?.ok) {
        setHowlConnectionTest({ status: "ok", message: "Howl /status is live. Sarah is synced to the current Howl state." });
      }
      if (settingsPayload?.settings) {
        const canApplySettings = forceSettings || (!howlSettingsDirtyRef.current && !howlFocusedFieldRef.current);
        if (canApplySettings) {
          setHowlControlForm((prev) => ({ ...prev, ...settingsPayload.settings }));
          markHowlSettingsDirty(false);
          if (forceSettings) {
            setHowlConnectionTest((prev) => prev.status === "ok"
              ? prev
              : { status: "idle", message: "Saved Howl settings reloaded. Test the connection before manual control." });
          }
        }
      }
      if (commandsPayload?.commands) {
        setHowlCommandHistory(commandsPayload.commands);
      }
      setHowlError("");
    } catch (error) {
      setHowlError(error?.message || "Howl telemetry is unavailable.");
    } finally {
      if (!quiet) setHowlRefreshing(false);
    }
  }, [markHowlSettingsDirty]);

  const handleH10PmdData = useCallback((value) => {
    const store = directH10PmdStoreRef.current;
    try {
      const parsed = parseH10PmdFrame(value, store.parserStates);
      if (parsed.type === "ecg") {
        store.ecgSamples = appendBoundedSamples(store.ecgSamples, parsed.samples, {
          maxAgeMs: 70_000,
          maxSamples: 9_500,
        });
        store.pendingEcgSamples.push(...parsed.samples);
        if (store.pendingEcgSamples.length > 520) store.pendingEcgSamples.splice(0, store.pendingEcgSamples.length - 520);
        return;
      }

      store.accelerometerSamples = appendBoundedSamples(store.accelerometerSamples, parsed.samples, {
        maxAgeMs: 70_000,
        maxSamples: 1_900,
      });
      store.pendingAccelerometerSamples.push(...parsed.samples);
      if (store.pendingAccelerometerSamples.length > 100) {
        store.pendingAccelerometerSamples.splice(0, store.pendingAccelerometerSamples.length - 100);
      }
      const tapResult = detectH10TapGesture(parsed.samples, store.tapState);
      store.tapState = tapResult.state;
      if (tapResult.gesture && !recording?.paused && appendLiveSessionEventsRef.current) {
        const sessionStartMs = Number(recording?.startedAtMs || recording?.startEpochMs || 0);
        const timeS = sessionStartMs > 0
          ? Math.max(0, (tapResult.gesture.timestampMs - sessionStartMs) / 1000)
          : 0;
        appendLiveSessionEventsRef.current({
          id: `h10_tap_${Math.round(tapResult.gesture.timestampMs)}`,
          time_s: Math.round(timeS * 10) / 10,
          label: "H10 tap marker",
          note: "Hands-free triple-tap marker detected on the Polar H10 chest sensor.",
          category: ["physical", "manual_marker"],
          annotation_tags: ["h10", "accelerometer", "triple_tap", "sync_anchor"],
          source: "h10_accelerometer_gesture",
          created_at: new Date(tapResult.gesture.timestampMs).toISOString(),
        }).catch(() => {});
      }
    } catch (error) {
      setDirectH10Status((previous) => ({
        ...previous,
        pmdMessage: `Raw sensor frame rejected: ${error?.message || error}`,
      }));
    }
  }, [recording?.paused, recording?.startEpochMs, recording?.startedAtMs]);

  useEffect(() => {
    const timer = window.setInterval(() => {
      const store = directH10PmdStoreRef.current;
      const telemetry = latestHrRef.current || {};
      const recordingStartMs = Number(recording?.startedAtMs || recording?.startEpochMs || 0);
      const eventHistory = liveEventsRef.current.map((event) => ({
        ...event,
        timestampMs: recordingStartMs > 0 && Number.isFinite(Number(event?.time_s))
          ? recordingStartMs + Number(event.time_s) * 1000
          : Date.parse(event?.created_at || ""),
      }));
      const snapshot = deriveH10MultimodalSnapshot({
        accelerometerSamples: store.accelerometerSamples,
        ecgSamples: store.ecgSamples,
        rrQuality: telemetry?.hrv?.quality || telemetry?.hrv_quality || "unavailable",
        hrHistory: telemetryHistoryRef.current,
        eventHistory,
        currentHr: telemetry?.currentHr ?? telemetry?.heartRate ?? telemetry?.hr,
        baselineHr: telemetry?.baselineHr ?? telemetry?.baseline_hr,
        baselineOrientation: store.baselineOrientation,
      });
      if (!store.baselineOrientation && snapshot.motion?.class === "low_motion" && snapshot.position?.currentOrientation) {
        store.baselineOrientation = snapshot.position.currentOrientation;
      }
      store.lastDerivedAt = Date.now();
      h10MultimodalRef.current = snapshot;
      setH10Multimodal(snapshot);
    }, 1000);
    return () => window.clearInterval(timer);
  }, [recording?.startEpochMs, recording?.startedAtMs]);

  const publishDirectH10Measurement = useCallback((parsed, deviceName = "Polar H10") => {
    if (!parsed?.heartRate) return;
    const receivedAt = Date.now();
    directH10ReconnectAttemptRef.current = 0;
    setHrLossDialog(null);
    directH10RrRef.current = appendRollingRrIntervals(directH10RrRef.current, parsed.rrIntervalsMs);
    const hrv = computeHrvFromRr(directH10RrRef.current);
    const pmdStore = directH10PmdStoreRef.current;
    const sensorBatch = {
      ecg: pmdStore.pendingEcgSamples.splice(0),
      accelerometer: pmdStore.pendingAccelerometerSamples.splice(0),
    };
    const telemetry = {
      source: "direct_h10",
      sourceLabel: "Direct Polar H10",
      deviceName,
      measuredAt: receivedAt,
      receivedAt,
      heartRate: parsed.heartRate,
      currentHr: parsed.heartRate,
      hr: parsed.heartRate,
      rrIntervalsMs: parsed.rrIntervalsMs,
      hrv,
      multimodal: h10MultimodalRef.current,
      quality: {
        stale: false,
        ageMs: 0,
        rrCount: directH10RrRef.current.length,
        hrvQuality: hrv?.quality || "unavailable",
      },
    };

    const sendTelemetryToRelay = () => {
      if (typeof WebSocket === "undefined") return;
      let relayUrl = "";
      try {
        const base = new URL(apiUrl("/live-capture/status"), window.location.href);
        base.protocol = base.protocol === "https:" ? "wss:" : "ws:";
        base.port = "8765";
        base.pathname = "/";
        base.search = "";
        base.hash = "";
        relayUrl = base.toString();
      } catch {
        return;
      }

      const payload = JSON.stringify({ type: "telemetry", data: telemetry });
      let socket = directH10RelaySocketRef.current;
      if (!socket || [WebSocket.CLOSING, WebSocket.CLOSED].includes(socket.readyState)) {
        socket = new WebSocket(relayUrl);
        directH10RelaySocketRef.current = socket;
      }
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(payload);
      } else if (socket.readyState === WebSocket.CONNECTING) {
        socket.addEventListener("open", () => socket.send(payload), { once: true });
      }
    };

    latestHrRef.current = telemetry;
    setHrTelemetry(telemetry);
    sendTelemetryToRelay();
    setDirectH10Status((prev) => ({
      ...prev,
      connected: true,
      connecting: false,
      deviceName: telemetry.deviceName,
      message: parsed.rrIntervalsMs.length ? "Direct H10 HR + RR live" : "Direct H10 HR live; waiting for RR intervals",
      error: "",
      lastMessageAt: new Date(receivedAt).toISOString(),
      rrCount: directH10RrRef.current.length,
    }));

    fetch(apiUrl("/live-capture/hr-direct-h10/telemetry"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...telemetry, sensorBatch }),
    })
      .then(async (response) => {
        if (!response.ok) {
          const text = await response.text();
          if (response.status === 404 && text.includes("Cannot POST /api/live-capture/hr-direct-h10/telemetry")) {
            throw new Error("Sarah server needs a restart to receive Direct H10 telemetry.");
          }
          throw new Error(text?.startsWith("<!DOCTYPE") ? "Direct H10 telemetry was rejected by the server." : text || "Direct H10 telemetry was rejected.");
        }
      })
      .catch((error) => {
        setDirectH10Status((prev) => ({
          ...prev,
          error: error.message || String(error),
        }));
      });
  }, []);

  const appendTelemetryPoint = (nextHr = latestHrRef.current, nextEmg = latestEmgRef.current) => {
    if (!nextHr && !nextEmg) return;
    setTelemetryHistory((prev) => {
      const point = makeTelemetryPoint(nextHr, nextEmg, {
        sessionTimeSec: getCurrentSessionTime(),
        howlIntensity: readHowlChannelIntensity(howlTelemetry, howlCommandForm.channel),
      });
      const previous = prev[prev.length - 1];
      if (
        previous
        && previous.hr === point.hr
        && previous.hrSmoothed === point.hrSmoothed
        && previous.left === point.left
        && previous.right === point.right
        && point.ts - previous.ts < 750
      ) {
        return prev;
      }
      const pointPrediction = computeLiveClimaxPrediction(nextHr, nextEmg, [...prev, point], {
        sessionTimeSec: point.sessionTimeSec,
      });
      point.nearClimax = pointPrediction.nearClimax;
      point.recovery = pointPrediction.recovery;
      point.hrvSignal = pointPrediction.hrvSignal;
      point.plateau = pointPrediction.plateauScore;
      point.controllerConfidence = pointPrediction.controllerConfidence;
      point.physiologicalIntensity = pointPrediction.physiologicalIntensity;
      return [...prev, point].slice(-MAX_TELEMETRY_POINTS);
    });
  };
  appendTelemetryPointRef.current = appendTelemetryPoint;

  const updateHrSourceSettings = useCallback((patch) => {
    setHrSourceSettings((prev) => {
      const next = { ...prev, ...patch };
      writeHrSourceSettings(next);
      return next;
    });
    setHrSourceError("");
  }, []);

  const applyHrSourceSettings = useCallback(async (settings = hrSourceSettings) => {
    setHrSourceSaving(true);
    setHrSourceError("");
    writeHrSourceSettings(settings);
    try {
      const response = await fetch(apiUrl("/live-capture/hr-source"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          source: settings.source,
          pulsoidToken: settings.pulsoidToken,
          pulsoidMode: settings.pulsoidMode,
        }),
      });
      const responseText = await response.text();
      const data = responseText ? JSON.parse(responseText) : {};
      if (!response.ok) {
        if (response.status === 404 && responseText.includes("Cannot POST /api/live-capture/hr-source")) {
          throw new Error("Sarah server needs a restart to load the new heart-rate source route.");
        }
        throw new Error(data.error || "Could not apply HR source.");
      }
      setStatus((prev) => ({ ...(prev || {}), hr: { ...(prev?.hr || {}), ...(data.hr || {}) } }));
    } catch (error) {
      const message = error instanceof SyntaxError
        ? "Sarah server returned an unexpected response. Restart the server and try again."
        : error.message || String(error);
      setHrSourceError(message);
    } finally {
      setHrSourceSaving(false);
    }
  }, [hrSourceSettings]);

  const saveHowlControlSettings = useCallback(async (patch = {}) => {
    const nextSettings = { ...howlControlForm, ...patch };
    setHowlControlBusy("settings");
    setHowlError("");
    try {
      const response = await fetch(apiUrl("/howl/control/settings"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(nextSettings),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Could not save Howl control settings.");
      setHowlControlForm((prev) => ({ ...prev, ...(data.settings || nextSettings) }));
      markHowlSettingsDirty(false);
      setHowlControlStatus(data.settings?.controlEnabled ? "Howl manual control enabled." : "Howl manual control disabled.");
      await refreshHowlTelemetry({ quiet: true, forceSettings: true });
      return data.settings;
    } catch (error) {
      setHowlError(error?.message || "Unable to save Howl control settings.");
      return null;
    } finally {
      setHowlControlBusy("");
    }
  }, [howlControlForm, markHowlSettingsDirty, refreshHowlTelemetry]);

  const testHowlConnection = useCallback(async () => {
    setHowlControlBusy("test");
    setHowlError("");
    setHowlControlStatus("");
    setHowlConnectionTest({ status: "testing", message: "Testing Howl /status..." });
    try {
      const response = await fetch(apiUrl("/howl/control/test"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(howlControlForm),
      });
      const responseText = await response.text();
      let data = {};
      try {
        data = responseText ? JSON.parse(responseText) : {};
      } catch {
        if (response.status === 404 || responseText.includes("Cannot POST /api/howl/control/test")) {
          throw new Error("Sarah server needs a restart to load the new Howl connection test route.");
        }
        throw new Error(responseText?.startsWith("<!DOCTYPE")
          ? "Sarah server returned an unexpected page instead of a Howl test result. Restart the server and try again."
          : responseText || "Howl connection test returned an unreadable response.");
      }
      if (!response.ok || data.ok === false) {
        throw new Error(data.message || data.error || "Howl connection test failed.");
      }
      setHowlConnectionTest({ status: "ok", message: "Howl connection works. Manual control can be enabled." });
      setHowlControlStatus("Howl /status responded successfully.");
      return data;
    } catch (error) {
      setHowlConnectionTest({ status: "error", message: error?.message || "Howl connection test failed." });
      setHowlError(error?.message || "Howl connection test failed.");
      return null;
    } finally {
      setHowlControlBusy("");
    }
  }, [howlControlForm]);

  const getCurrentSessionTime = useCallback(() => {
    const startMs = Number(recording?.startedAtMs) || (liveSession?.startedAt ? new Date(liveSession.startedAt).getTime() : 0);
    if (!startMs || Number.isNaN(startMs)) return 0;
    return Math.max(0, Math.round((Date.now() - startMs) / 1000));
  }, [liveSession?.startedAt, recording?.startedAtMs]);

  const sendHowlControlCommand = useCallback(async (action = "set_state", extra = {}) => {
    setHowlControlBusy(action);
    setHowlError("");
    try {
      const payload = {
        action,
        ...howlCommandForm,
        ...extra,
        session: liveSession?.activeSessionId || activeSessionDoc?.id || null,
      };
      const response = await fetch(apiUrl("/howl/control"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Howl command was rejected.");
      setHowlControlStatus(data.dispatch?.message || "Howl command queued.");
      await refreshHowlTelemetry({ quiet: true });
      const eventSource = String(extra.reason || "").startsWith("voice_")
        ? "howl_voice_control"
        : String(extra.reason || "").startsWith("sarah_auto_")
          ? "howl_auto_control"
          : "howl_manual_control";
      const sessionEvent = eventSource === "howl_auto_control"
        ? null
        : buildHowlSessionEvent({
          action,
          timeS: getCurrentSessionTime(),
          channel: extra.channel ?? howlCommandForm.channel,
          intensity: extra.intensity,
          requestedIntensity: extra.requestedIntensity,
          activityName: extra.activityName ?? howlCommandForm.mode,
          activityDisplayName: extra.activityDisplayName,
          waveform: extra.waveform,
          frequencyHz: extra.frequency_hz,
          source: eventSource,
          reason: extra.reason,
        });
      if (sessionEvent) {
        appendLiveSessionEventsRef.current?.(sessionEvent)?.catch?.(() => {});
      }
      return data;
    } catch (error) {
      setHowlError(error?.message || "Unable to send Howl command.");
      return null;
    } finally {
      setHowlControlBusy("");
    }
  }, [
    activeSessionDoc?.id,
    getCurrentSessionTime,
    howlCommandForm,
    liveSession?.activeSessionId,
    refreshHowlTelemetry,
  ]);

  const sendHowlEmergencyStop = useCallback(async () => {
    setHowlControlBusy("emergency_stop");
    setHowlError("");
    try {
      const response = await fetch(apiUrl("/howl/control/emergency-stop"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          channel: "all",
          session: liveSession?.activeSessionId || activeSessionDoc?.id || null,
          reason: "manual_live_capture_emergency_stop",
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(data.error || "Emergency stop was rejected.");
      setHowlCommandForm((prev) => ({ ...prev, intensity: 0, enabled: false }));
      setHowlControlStatus(data.dispatch?.message || "Emergency stop queued.");
      await refreshHowlTelemetry({ quiet: true });
      return data;
    } catch (error) {
      setHowlError(error?.message || "Unable to send emergency stop.");
      return null;
    } finally {
      setHowlControlBusy("");
    }
  }, [activeSessionDoc?.id, liveSession?.activeSessionId, refreshHowlTelemetry]);

  const runHowlVoiceCommand = useCallback(async (voiceCommand) => {
    if (!voiceCommand) return false;
    const manualControlEnabled = Boolean(howlControlForm.controlEnabled);
    const manualControlsUnlocked = manualControlEnabled && howlConnectionTest.status === "ok";
    if (voiceCommand.action === "emergency_stop") {
      if (!manualControlEnabled) {
        setVoiceStatus("Sarah heard the stop command, but Howl manual control is not enabled.");
        setVoiceError("Enable manual Howl control before voice commands can control the device.");
        return true;
      }
      setVoiceStatus(voiceCommand.status);
      await sendHowlEmergencyStop();
      setVoiceStatus("Sarah sent mute / emergency stop to Howl.");
      return true;
    }

    if (!manualControlsUnlocked) {
      setVoiceStatus("Sarah heard the Howl command, but manual control is locked.");
      setVoiceError("Test the Howl connection, then enable manual control before using voice Howl commands.");
      return true;
    }

    setVoiceStatus(voiceCommand.status);
    const result = await sendHowlControlCommand(voiceCommand.action, voiceCommand.extra);
    if (result) {
      setVoiceStatus(voiceCommand.status || "Sarah sent the Howl command.");
      setVoiceError("");
    }
    return true;
  }, [howlConnectionTest.status, howlControlForm.controlEnabled, sendHowlControlCommand, sendHowlEmergencyStop]);

  const scheduleNativeH10Reconnect = useCallback(({ reason = "The H10 connection dropped." } = {}) => {
    if (!canUseNativeAndroidBle() || !directH10ReconnectEnabledRef.current || !readRememberedDirectH10Device()) return false;
    if (directH10ReconnectTimerRef.current) return true;

    const attempt = directH10ReconnectAttemptRef.current;
    if (attempt >= DIRECT_H10_RECONNECT_DELAYS_MS.length) {
      setDirectH10Status((prev) => ({
        ...prev,
        connected: false,
        connecting: false,
        message: "Automatic H10 reconnect paused",
        error: reason,
      }));
      setHrLossDialog({
        title: "H10 needs attention",
        message: `${reason} Automatic reconnect was unable to restore the saved strap. Wake or moisten the strap, then tap Reconnect H10.`,
        reconnecting: false,
      });
      return false;
    }

    const delayMs = DIRECT_H10_RECONNECT_DELAYS_MS[attempt];
    directH10ReconnectAttemptRef.current = attempt + 1;
    setHrLossDialog(null);
    setDirectH10Status((prev) => ({
      ...prev,
      connected: false,
      connecting: false,
      message: `Reconnecting saved H10 (attempt ${attempt + 1})`,
      error: "",
    }));
    directH10ReconnectTimerRef.current = window.setTimeout(() => {
      directH10ReconnectTimerRef.current = null;
      if (!directH10ReconnectEnabledRef.current) return;
      const current = directH10StatusRef.current || {};
      const lastPacketMs = timestampMs(current.lastMessageAt);
      const hasFreshPacket = current.connected && Number.isFinite(lastPacketMs) && Date.now() - lastPacketMs <= 9000;
      if (current.connecting || hasFreshPacket) return;
      directH10ConnectRef.current?.({ autoReconnect: true }).catch(() => {
        // connectDirectH10 records the specific error and schedules the next attempt.
      });
    }, delayMs);
    return true;
  }, []);

  const handleH10PmdControl = useCallback((value) => {
    const response = parseH10PmdControlResponse(value);
    if (!response) return;
    const streamActive = isH10PmdStreamActiveResponse(response);
    const waiterKey = `${response.command}:${response.measurement}`;
    const waiter = directH10PmdControlWaitersRef.current.get(waiterKey);
    if (waiter) {
      directH10PmdControlWaitersRef.current.delete(waiterKey);
      window.clearTimeout(waiter.timerId);
      waiter.resolve(response);
    }
    const streamName = response.measurement === 0 ? "ECG" : response.measurement === 2 ? "accelerometer" : "PMD";
    setDirectH10Status((previous) => ({
      ...previous,
      pmdActive: previous.pmdActive,
      pmdMessage: streamActive
        ? `${streamName} start accepted; awaiting sensor samples${response.status === 6 ? " after stale-stream reset" : ""}`
        : `${streamName} raw stream unavailable (PMD status ${response.status})`,
    }));
  }, []);

  useEffect(() => {
    if (!restoredLaunchProfileRef.current) return;
    const saved = saveLiveCaptureLaunchProfile({
      ...readLiveCaptureLaunchProfile(),
      livePhysiologyCuesEnabled: liveCueSettings.enabled,
      cueStyle: liveCueSettings.style,
      cueVolume: liveCueSettings.volume,
      cuePan: liveCueSettings.pan,
      mediaDucking: liveCueSettings.mediaDucking,
    });
    setLaunchProfile(saved);
  }, [liveCueSettings.enabled, liveCueSettings.mediaDucking, liveCueSettings.pan, liveCueSettings.style, liveCueSettings.volume]);

  const waitForH10PmdControlResponse = useCallback((measurement, command = 2, timeoutMs = 5000) => new Promise((resolve, reject) => {
    const waiterKey = `${command}:${measurement}`;
    const previous = directH10PmdControlWaitersRef.current.get(waiterKey);
    if (previous) {
      window.clearTimeout(previous.timerId);
      previous.reject(new Error("H10 PMD command superseded"));
    }
    const timerId = window.setTimeout(() => {
      directH10PmdControlWaitersRef.current.delete(waiterKey);
      reject(new Error(`H10 PMD ${measurement === 0 ? "ECG" : "accelerometer"} ${command === 3 ? "stop" : "start"} response timed out`));
    }, timeoutMs);
    directH10PmdControlWaitersRef.current.set(waiterKey, { resolve, reject, timerId });
  }), []);

  const waitForH10PmdSamples = useCallback(async (timeoutMs = 7000) => {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const store = directH10PmdStoreRef.current;
      if (store.ecgSamples.length > 0 && store.accelerometerSamples.length > 0) return true;
      await wait(200);
    }
    const store = directH10PmdStoreRef.current;
    throw new Error(`H10 PMD started but delivered no complete sensor stream (ECG ${store.ecgSamples.length}, accelerometer ${store.accelerometerSamples.length})`);
  }, []);

  const startNativeH10Pmd = useCallback(async (deviceId) => {
    directH10PmdStoreRef.current = createH10PmdStore();
    await BleClient.startNotifications(
      deviceId,
      H10_PMD_SERVICE_UUID,
      H10_PMD_CONTROL_UUID,
      handleH10PmdControl,
      { timeout: 12000 },
    );
    await BleClient.startNotifications(
      deviceId,
      H10_PMD_SERVICE_UUID,
      H10_PMD_DATA_UUID,
      handleH10PmdData,
      { timeout: 12000 },
    );
    const resetMeasurement = async (measurement, command) => {
      const responsePromise = waitForH10PmdControlResponse(measurement, 3, 2500);
      await Promise.all([
        BleClient.write(deviceId, H10_PMD_SERVICE_UUID, H10_PMD_CONTROL_UUID, commandDataView(command), { timeout: 5000 }),
        responsePromise,
      ]).catch(() => {});
    };
    await resetMeasurement(0, H10_ECG_STOP_COMMAND);
    await resetMeasurement(2, H10_ACCELEROMETER_STOP_COMMAND);
    const ecgResponsePromise = waitForH10PmdControlResponse(0, 2);
    const [, ecgResponse] = await Promise.all([
      BleClient.write(deviceId, H10_PMD_SERVICE_UUID, H10_PMD_CONTROL_UUID, commandDataView(H10_ECG_START_COMMAND), { timeout: 12000 }),
      ecgResponsePromise,
    ]);
    if (!isH10PmdStreamActiveResponse(ecgResponse)) throw new Error(`H10 rejected ECG stream (status ${ecgResponse.status})`);
    const accelerometerResponsePromise = waitForH10PmdControlResponse(2, 2);
    const [, accelerometerResponse] = await Promise.all([
      BleClient.write(deviceId, H10_PMD_SERVICE_UUID, H10_PMD_CONTROL_UUID, commandDataView(H10_ACCELEROMETER_START_COMMAND), { timeout: 12000 }),
      accelerometerResponsePromise,
    ]);
    if (!isH10PmdStreamActiveResponse(accelerometerResponse)) throw new Error(`H10 rejected accelerometer stream (status ${accelerometerResponse.status})`);
    directH10PmdNativeActiveRef.current = true;
    setDirectH10Status((previous) => ({ ...previous, pmdActive: false, pmdMessage: "Confirming ECG + chest motion samples" }));
    await waitForH10PmdSamples();
    setDirectH10Status((previous) => ({ ...previous, pmdActive: true, pmdMessage: "ECG + chest motion verified" }));
  }, [handleH10PmdControl, handleH10PmdData, waitForH10PmdControlResponse, waitForH10PmdSamples]);

  const startBrowserH10Pmd = useCallback(async (device) => {
    const server = device?.gatt;
    if (!server?.connected) throw new Error("H10 GATT disconnected before PMD setup");
    directH10PmdStoreRef.current = createH10PmdStore();
    const service = await withTimeout(server.getPrimaryService(H10_PMD_SERVICE_UUID), 12000, "Timed out opening H10 PMD service.");
    const control = await withTimeout(service.getCharacteristic(H10_PMD_CONTROL_UUID), 12000, "Timed out opening H10 PMD control.");
    const data = await withTimeout(service.getCharacteristic(H10_PMD_DATA_UUID), 12000, "Timed out opening H10 PMD data.");
    const controlHandler = (event) => handleH10PmdControl(event.target.value);
    const dataHandler = (event) => handleH10PmdData(event.target.value);
    control.addEventListener("characteristicvaluechanged", controlHandler);
    data.addEventListener("characteristicvaluechanged", dataHandler);
    await withTimeout(control.startNotifications(), 12000, "Timed out starting H10 PMD control notifications.");
    await withTimeout(data.startNotifications(), 12000, "Timed out starting H10 PMD data notifications.");
    directH10PmdBrowserRef.current = { control, data, controlHandler, dataHandler };
    const resetMeasurement = async (measurement, command) => {
      const responsePromise = waitForH10PmdControlResponse(measurement, 3, 2500);
      await Promise.all([
        control.writeValueWithResponse(command),
        responsePromise,
      ]).catch(() => {});
    };
    await resetMeasurement(0, H10_ECG_STOP_COMMAND);
    await resetMeasurement(2, H10_ACCELEROMETER_STOP_COMMAND);
    const ecgResponsePromise = waitForH10PmdControlResponse(0, 2);
    const [, ecgResponse] = await Promise.all([
      control.writeValueWithResponse(H10_ECG_START_COMMAND),
      ecgResponsePromise,
    ]);
    if (!isH10PmdStreamActiveResponse(ecgResponse)) throw new Error(`H10 rejected ECG stream (status ${ecgResponse.status})`);
    const accelerometerResponsePromise = waitForH10PmdControlResponse(2, 2);
    const [, accelerometerResponse] = await Promise.all([
      control.writeValueWithResponse(H10_ACCELEROMETER_START_COMMAND),
      accelerometerResponsePromise,
    ]);
    if (!isH10PmdStreamActiveResponse(accelerometerResponse)) throw new Error(`H10 rejected accelerometer stream (status ${accelerometerResponse.status})`);
    setDirectH10Status((previous) => ({ ...previous, pmdActive: false, pmdMessage: "Confirming ECG + chest motion samples" }));
    await waitForH10PmdSamples();
    setDirectH10Status((previous) => ({ ...previous, pmdActive: true, pmdMessage: "ECG + chest motion verified" }));
  }, [handleH10PmdControl, handleH10PmdData, waitForH10PmdControlResponse, waitForH10PmdSamples]);

  const disconnectDirectH10 = useCallback(async ({ updateStatus = true, preserveAutoReconnect = false } = {}) => {
    if (!preserveAutoReconnect) {
      directH10ReconnectEnabledRef.current = false;
      if (directH10ReconnectTimerRef.current) {
        window.clearTimeout(directH10ReconnectTimerRef.current);
        directH10ReconnectTimerRef.current = null;
      }
    }
    directH10IntentionalDisconnectRef.current = true;
    const nativeDeviceId = directH10NativeDeviceIdRef.current;
    if (nativeDeviceId) {
      if (directH10PmdNativeActiveRef.current) {
        await BleClient.write(nativeDeviceId, H10_PMD_SERVICE_UUID, H10_PMD_CONTROL_UUID, commandDataView(H10_ECG_STOP_COMMAND), { timeout: 3000 }).catch(() => {});
        await BleClient.write(nativeDeviceId, H10_PMD_SERVICE_UUID, H10_PMD_CONTROL_UUID, commandDataView(H10_ACCELEROMETER_STOP_COMMAND), { timeout: 3000 }).catch(() => {});
        await BleClient.stopNotifications(nativeDeviceId, H10_PMD_SERVICE_UUID, H10_PMD_DATA_UUID).catch(() => {});
        await BleClient.stopNotifications(nativeDeviceId, H10_PMD_SERVICE_UUID, H10_PMD_CONTROL_UUID).catch(() => {});
      }
      try {
        await BleClient.stopNotifications(nativeDeviceId, HEART_RATE_SERVICE_UUID, HEART_RATE_MEASUREMENT_UUID);
      } catch {
        // Native BLE notifications may already be stopped.
      }
      try {
        await BleClient.disconnect(nativeDeviceId);
      } catch {
        // Native BLE may already be disconnected.
      }
    }

    const browserPmd = directH10PmdBrowserRef.current;
    if (browserPmd) {
      await browserPmd.control?.writeValueWithResponse?.(H10_ECG_STOP_COMMAND).catch?.(() => {});
      await browserPmd.control?.writeValueWithResponse?.(H10_ACCELEROMETER_STOP_COMMAND).catch?.(() => {});
      browserPmd.control?.removeEventListener?.("characteristicvaluechanged", browserPmd.controlHandler);
      browserPmd.data?.removeEventListener?.("characteristicvaluechanged", browserPmd.dataHandler);
      await browserPmd.data?.stopNotifications?.().catch?.(() => {});
      await browserPmd.control?.stopNotifications?.().catch?.(() => {});
    }

    const characteristic = directH10CharacteristicRef.current;
    const handler = directH10NotificationHandlerRef.current;
    if (characteristic && handler) {
      try {
        characteristic.removeEventListener("characteristicvaluechanged", handler);
      } catch {
        // Ignore stale browser BLE listener cleanup.
      }
      try {
        await characteristic.stopNotifications();
      } catch {
        // Some browsers throw if notifications already stopped.
      }
    }

    const device = directH10DeviceRef.current;
    if (device?.gatt?.connected) {
      try {
        device.gatt.disconnect();
      } catch {
        // The disconnected event will settle visible state when available.
      }
    }

    directH10CharacteristicRef.current = null;
    directH10NotificationHandlerRef.current = null;
    directH10DeviceRef.current = null;
    directH10NativeDeviceIdRef.current = "";
    directH10TransportRef.current = "";
    directH10RrRef.current = [];
    directH10PmdNativeActiveRef.current = false;
    directH10PmdBrowserRef.current = null;
    directH10PmdStoreRef.current = createH10PmdStore();
    directH10PmdControlWaitersRef.current.forEach((waiter) => {
      window.clearTimeout(waiter.timerId);
      waiter.reject(new Error("H10 disconnected"));
    });
    directH10PmdControlWaitersRef.current.clear();
    h10MultimodalRef.current = emptyH10MultimodalSnapshot();
    setH10Multimodal(emptyH10MultimodalSnapshot());
    if (updateStatus) {
      setDirectH10Status((prev) => ({
        ...prev,
        connected: false,
        connecting: false,
        message: "Direct H10 disconnected",
        error: "",
        rrCount: 0,
        pmdActive: false,
        pmdMessage: "Raw ECG + motion stopped",
      }));
    }
    window.setTimeout(() => {
      directH10IntentionalDisconnectRef.current = false;
    }, 1500);
  }, []);

  const connectDirectH10 = useCallback(async (options = {}) => {
    const autoReconnect = options?.autoReconnect === true;
    const forcePicker = options?.forcePicker === true;
    if (hrSourceSettings.source !== "direct_h10") {
      setDirectH10Status((prev) => ({
        ...prev,
        error: "Switch to Direct Polar H10 and apply it first.",
      }));
      return;
    }
    const useNativeAndroidBle = canUseNativeAndroidBle();
    if (isAndroidRuntime() && !useNativeAndroidBle) {
      setDirectH10Status((prev) => ({
        ...prev,
        connected: false,
        connecting: false,
        message: "Native BLE needed for Android H10.",
        error: "Direct H10 browser Bluetooth is disabled on Android because it can crash during BLE connect. Use the installed Sarah app for native H10, or Pulsoid in mobile Chrome.",
      }));
      return;
    }
    if (useNativeAndroidBle) {
      if (!autoReconnect) directH10ReconnectAttemptRef.current = 0;
      directH10ReconnectEnabledRef.current = true;
      if (directH10ReconnectTimerRef.current) {
        window.clearTimeout(directH10ReconnectTimerRef.current);
        directH10ReconnectTimerRef.current = null;
      }
      setDirectH10Status((prev) => ({
        ...prev,
        connecting: true,
        error: "",
        message: autoReconnect
          ? "Reconnecting the saved Polar H10."
          : readRememberedDirectH10Device() && !forcePicker
            ? "Connecting the saved Polar H10."
            : "Opening Android BLE picker for Polar H10.",
      }));

      try {
        await disconnectDirectH10({ updateStatus: false, preserveAutoReconnect: true });
        const device = await getNativeDirectH10Device({
          preferSaved: !forcePicker,
          forcePicker,
          silent: autoReconnect,
        });
        rememberDirectH10Device(device);
        const deviceName = device?.name || "Polar H10";
        directH10TransportRef.current = "native";
        directH10NativeDeviceIdRef.current = device.deviceId;
        directH10DeviceRef.current = device;

        const handleNativeDisconnected = () => {
          const intentionalDisconnect = directH10IntentionalDisconnectRef.current;
          directH10IntentionalDisconnectRef.current = false;
          directH10NativeDeviceIdRef.current = "";
          directH10TransportRef.current = "";
          directH10DeviceRef.current = null;
          directH10RrRef.current = [];
          setDirectH10Status((prev) => ({
            ...prev,
            connected: false,
            connecting: false,
            message: intentionalDisconnect ? "Direct H10 disconnected" : "H10 disconnected; automatic reconnect scheduled",
            rrCount: 0,
          }));
          if (!intentionalDisconnect) {
            scheduleNativeH10Reconnect({ reason: "The native Android BLE connection dropped." });
          }
        };

        setDirectH10Status((prev) => ({
          ...prev,
          connecting: true,
          deviceName,
          message: "Opening native H10 heart-rate service.",
          error: "",
        }));

        // Clear stale Android GATT state before opening a fresh connection to the remembered ID.
        directH10IntentionalDisconnectRef.current = true;
        await BleClient.disconnect(device.deviceId).catch(() => {});
        await wait(250);
        directH10IntentionalDisconnectRef.current = false;
        await BleClient.connect(device.deviceId, handleNativeDisconnected, { timeout: 15000 });
        await BleClient.startNotifications(
          device.deviceId,
          HEART_RATE_SERVICE_UUID,
          HEART_RATE_MEASUREMENT_UUID,
          (value) => publishDirectH10Measurement(parseHeartRateMeasurement(value), deviceName),
          { timeout: 12000 },
        );
        startNativeH10Pmd(device.deviceId).catch((error) => {
          setDirectH10Status((previous) => ({
            ...previous,
            pmdActive: false,
            pmdMessage: `HR/RR live; raw ECG/motion unavailable: ${error?.message || error}`,
          }));
        });

        setDirectH10Status((prev) => ({
          ...prev,
          connected: true,
          connecting: false,
          deviceName,
          message: "Native Direct H10 connected. Waiting for first HR packet.",
          error: "",
        }));
        setHrLossDialog(null);
      } catch (error) {
        const message = friendlyDirectH10Error(error);
        directH10NativeDeviceIdRef.current = "";
        directH10TransportRef.current = "";
        directH10DeviceRef.current = null;
        directH10RrRef.current = [];
        setDirectH10Status((prev) => ({
          ...prev,
          connected: false,
          connecting: false,
          message: "Direct H10 not connected",
          error: message,
        }));
        if (directH10ReconnectEnabledRef.current && readRememberedDirectH10Device()) {
          scheduleNativeH10Reconnect({ reason: message });
        }
      }
      return;
    }
    if (!navigator.bluetooth) {
      setDirectH10Status((prev) => ({
        ...prev,
        error: "This browser does not expose Web Bluetooth. Use Chrome/Edge on localhost, or use Pulsoid in the installed Android app.",
      }));
      return;
    }

    setDirectH10Status((prev) => ({
      ...prev,
      connecting: true,
      error: "",
      message: autoReconnect
        ? "Trying to reconnect the saved H10 permission."
        : "Opening the browser Bluetooth picker. Select the Polar H10, even if Windows already says paired.",
    }));

    try {
      const devicePromise = getDirectH10Device({ preferSaved: autoReconnect, silent: autoReconnect });
      await disconnectDirectH10({ updateStatus: false });
      const device = await devicePromise;
      directH10DeviceRef.current = device;
      const handleDisconnected = () => {
        const intentionalDisconnect = directH10IntentionalDisconnectRef.current;
        directH10IntentionalDisconnectRef.current = false;
        directH10CharacteristicRef.current = null;
        directH10NotificationHandlerRef.current = null;
        directH10DeviceRef.current = null;
        directH10RrRef.current = [];
        if (!intentionalDisconnect) {
          setHrLossDialog({
            title: "H10 disconnected",
            message: "The browser BLE connection dropped. Tap Reconnect H10 if it does not resume on its own.",
            reconnecting: false,
          });
        }
        setDirectH10Status((prev) => ({
          ...prev,
          connected: false,
          connecting: false,
          message: "Direct H10 disconnected",
          rrCount: 0,
        }));
      };
      device.addEventListener("gattserverdisconnected", handleDisconnected, { once: true });

      setDirectH10Status((prev) => ({
        ...prev,
        connecting: true,
        deviceName: device.name || "Polar H10",
        message: "Opening H10 heart-rate service.",
        error: "",
      }));

      const characteristic = await getHeartRateMeasurementCharacteristic(device);
      directH10CharacteristicRef.current = characteristic;

      const handleMeasurement = (event) => {
        const parsed = parseHeartRateMeasurement(event.target.value);
        publishDirectH10Measurement(parsed, device.name || "Polar H10");
      };

      directH10NotificationHandlerRef.current = handleMeasurement;
      characteristic.addEventListener("characteristicvaluechanged", handleMeasurement);
      await withTimeout(
        characteristic.startNotifications(),
        12000,
        "Timed out starting H10 heart-rate notifications.",
      );
      startBrowserH10Pmd(device).catch((error) => {
        setDirectH10Status((previous) => ({
          ...previous,
          pmdActive: false,
          pmdMessage: `HR/RR live; raw ECG/motion unavailable: ${error?.message || error}`,
        }));
      });
      setDirectH10Status((prev) => ({
        ...prev,
        connected: true,
        connecting: false,
        deviceName: device.name || "Polar H10",
        message: "Direct H10 connected. Waiting for first HR packet.",
        error: "",
      }));
    } catch (error) {
      const message = friendlyDirectH10Error(error);
      if (autoReconnect) {
        setHrLossDialog({
          title: "H10 needs a tap",
          message,
          reconnecting: false,
        });
      }
      setDirectH10Status((prev) => ({
        ...prev,
        connected: false,
        connecting: false,
        message: "Direct H10 not connected",
        error: message,
      }));
    }
  }, [disconnectDirectH10, hrSourceSettings.source, publishDirectH10Measurement, scheduleNativeH10Reconnect, startBrowserH10Pmd, startNativeH10Pmd]);

  useEffect(() => {
    directH10ConnectRef.current = connectDirectH10;
    return () => {
      if (directH10ConnectRef.current === connectDirectH10) directH10ConnectRef.current = null;
    };
  }, [connectDirectH10]);

  useEffect(() => {
    if (hrSourceSettings.source !== "direct_h10") {
      directH10ReconnectEnabledRef.current = false;
      directH10AutoConnectStartedRef.current = false;
      if (directH10ReconnectTimerRef.current) {
        window.clearTimeout(directH10ReconnectTimerRef.current);
        directH10ReconnectTimerRef.current = null;
      }
      return undefined;
    }

    directH10ReconnectEnabledRef.current = true;
    if (!canUseNativeAndroidBle() || !readRememberedDirectH10Device()) return undefined;

    let mounted = true;
    let appStateHandle = null;
    const reconnectRememberedH10 = () => {
      if (!mounted || document.visibilityState === "hidden") return;
      const now = Date.now();
      const current = directH10StatusRef.current || {};
      const lastPacketMs = timestampMs(current.lastMessageAt);
      const hasFreshPacket = current.connected && Number.isFinite(lastPacketMs) && Date.now() - lastPacketMs <= 9000;
      if (current.connecting || hasFreshPacket) return;
      if (now - directH10ForegroundReconnectCooldownRef.current < 12000) return;
      directH10ForegroundReconnectCooldownRef.current = now;
      scheduleNativeH10Reconnect({ reason: "Restoring the remembered Polar H10 connection." });
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") reconnectRememberedH10();
    };

    if (!directH10AutoConnectStartedRef.current) {
      directH10AutoConnectStartedRef.current = true;
      window.setTimeout(reconnectRememberedH10, 500);
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    import("@capacitor/app")
      .then(({ App: CapacitorApp }) => CapacitorApp?.addListener?.("appStateChange", ({ isActive } = {}) => {
        if (isActive) reconnectRememberedH10();
      }))
      .then((handle) => {
        appStateHandle = handle;
      })
      .catch(() => {});

    return () => {
      mounted = false;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      appStateHandle?.remove?.();
    };
  }, [hrSourceSettings.source, scheduleNativeH10Reconnect]);

  useEffect(() => {
    if (hrSourceSettings.source !== "direct_h10") return undefined;
    const timer = window.setInterval(() => {
      const serverDirect = status?.hr?.directH10 || {};
      const sourceStatus = status?.hr?.sourceStatus || {};
      const lastMessageAt = directH10Status.lastMessageAt || serverDirect.lastMessageAt || sourceStatus.lastMessageAt;
      const lastMs = timestampMs(lastMessageAt);
      const connectedFlag = Boolean(directH10Status.connected || serverDirect.connected || sourceStatus.connected);
      const signalLost = serverDirect.error && /signal lost|no hr packets/i.test(serverDirect.error);
      const sharedSample = latestHrRef.current || hrTelemetry || status?.hr?.latestTelemetry;
      const sharedHr = readNumber(sharedSample?.currentHr, sharedSample?.hr, sharedSample?.heartRate);
      const sharedStamp = sharedSample?.engineReceivedAt || sharedSample?.receivedAt || sharedSample?.lastMessageAt || sharedSample?.measuredAt || sharedSample?.source_at;
      const sharedAgeMs = sharedStamp ? Date.now() - timestampMs(sharedStamp) : NaN;
      const sharedHrRecent = sharedHr != null
        && Number.isFinite(sharedAgeMs)
        && sharedAgeMs >= -5000
        && sharedAgeMs <= SHARED_HR_PACKET_STALE_MS;

      if (sharedHrRecent) {
        directH10ReconnectAttemptRef.current = 0;
        setHrLossDialog((prev) => (prev?.title === "H10 signal lost" ? null : prev));
        return;
      }

      if (signalLost) {
        setHrLossDialog((prev) => prev || {
          title: "H10 signal lost",
          message: serverDirect.error,
          reconnecting: false,
        });
      }

      if (!connectedFlag || !Number.isFinite(lastMs)) return;
      const ageMs = Date.now() - lastMs;
      if (ageMs <= 9000) {
        directH10ReconnectAttemptRef.current = 0;
        return;
      }

      const nativeAndroidBle = canUseNativeAndroidBle();
      if (nativeAndroidBle) {
        setHrLossDialog(null);
      } else {
        setHrLossDialog({
          title: "H10 signal lost",
          message: `No heart-rate packet has arrived for ${Math.round(ageMs / 1000)} seconds. Sarah will try the saved H10 once; tap reconnect if Chrome needs permission again.`,
          reconnecting: directH10ReconnectAttemptRef.current < 2,
        });
      }
      setDirectH10Status((prev) => ({
        ...prev,
        connected: false,
        error: "Direct H10 signal lost - no HR packets received recently.",
        message: nativeAndroidBle ? "H10 signal stale; reconnecting saved strap." : "Trying to reconnect Direct H10.",
      }));

      if (nativeAndroidBle) {
        scheduleNativeH10Reconnect({ reason: `No heart-rate packet arrived for ${Math.round(ageMs / 1000)} seconds.` });
      } else if (directH10ReconnectAttemptRef.current < 2) {
        directH10ReconnectAttemptRef.current += 1;
        connectDirectH10({ autoReconnect: true }).catch(() => {
          // Visible state is already updated by connectDirectH10.
        });
      }
    }, 2500);
    return () => window.clearInterval(timer);
  }, [
    connectDirectH10,
    directH10Status.connected,
    directH10Status.lastMessageAt,
    hrTelemetry,
    hrSourceSettings.source,
    scheduleNativeH10Reconnect,
    status?.hr?.directH10?.connected,
    status?.hr?.directH10?.error,
    status?.hr?.directH10?.lastMessageAt,
    status?.hr?.latestTelemetry,
    status?.hr?.sourceStatus?.connected,
    status?.hr?.sourceStatus?.lastMessageAt,
  ]);

  const forgetDirectH10 = useCallback(async () => {
    if (canUseNativeAndroidBle()) {
      forgetRememberedDirectH10Device();
      directH10AutoConnectStartedRef.current = false;
      await disconnectDirectH10({ updateStatus: false });
      directH10RrRef.current = [];
      setDirectH10Status((prev) => ({
        ...prev,
        connected: false,
        connecting: false,
        deviceName: "",
        message: "Forgot the saved H10. Tap Connect H10 to choose a strap.",
        error: "",
        lastMessageAt: null,
        rrCount: 0,
      }));
      return;
    }
    if (!navigator.bluetooth?.getDevices) {
      setDirectH10Status((prev) => ({
        ...prev,
        error: "This browser cannot list saved Bluetooth permissions. Use the browser site settings to clear Bluetooth access.",
      }));
      return;
    }
    setDirectH10Status((prev) => ({
      ...prev,
      connecting: true,
      error: "",
      message: "Clearing saved H10 Bluetooth permission.",
    }));
    try {
      await disconnectDirectH10({ updateStatus: false });
      forgetRememberedDirectH10Device();
      const devices = await navigator.bluetooth.getDevices();
      const h10Devices = devices.filter((device) => /polar\s+h10/i.test(device?.name || ""));
      for (const device of h10Devices) {
        if (typeof device.forget === "function") await device.forget();
      }
      directH10RrRef.current = [];
      setDirectH10Status((prev) => ({
        ...prev,
        connected: false,
        connecting: false,
        deviceName: "",
        message: h10Devices.length
          ? "Forgot saved H10 permission. Tap Connect H10 and choose it again."
          : "No saved H10 permission found. Tap Connect H10 and choose the strap.",
        error: "",
        lastMessageAt: null,
        rrCount: 0,
      }));
    } catch (error) {
      setDirectH10Status((prev) => ({
        ...prev,
        connected: false,
        connecting: false,
        error: error?.message || String(error),
      }));
    }
  }, [disconnectDirectH10]);

  useEffect(() => {
    const settings = readHrSourceSettings();
    setHrSourceSettings(settings);
  }, []);

  useEffect(() => () => {
    directH10RelaySocketRef.current?.close?.();
    directH10RelaySocketRef.current = null;
    disconnectDirectH10();
  }, [disconnectDirectH10]);

  useEffect(() => {
    fetch(apiUrl("/live-capture/status")).then((res) => res.json()).then((data) => {
      setStatus(data);
      const nextHr = data.hr?.latestTelemetry || null;
      const nextEmg = data.emg?.latestTelemetry || null;
      latestHrRef.current = nextHr;
      latestEmgRef.current = nextEmg;
      setHrTelemetry(nextHr);
      setEmgTelemetry(nextEmg);
      setRecording(data.hr?.recording || null);
      setFiles(data.files || null);
      setLiveSession(data.session || null);
      setCalibrationCommandStatus(data.emg?.calibrationCommandStatus || null);
    }).catch(() => {});

    const events = new EventSource(apiUrl("/live-capture/stream"));
    events.onopen = () => setConnected(true);
    events.onerror = () => setConnected(false);
    events.addEventListener("status", (event) => {
      const data = JSON.parse(event.data);
      const nextHr = data.hr?.latestTelemetry || null;
      const nextEmg = data.emg?.latestTelemetry || null;
      latestHrRef.current = nextHr;
      latestEmgRef.current = nextEmg;
      setStatus(data);
      setHrTelemetry(nextHr);
      setEmgTelemetry(nextEmg);
      setRecording(data.hr?.recording || null);
      setFiles(data.files || null);
      setLiveSession(data.session || null);
      setCalibrationCommandStatus(data.emg?.calibrationCommandStatus || null);
    });
    events.addEventListener("hr_telemetry", (event) => {
      const data = JSON.parse(event.data);
      latestHrRef.current = data;
      setHrTelemetry(data);
      appendTelemetryPointRef.current(data, latestEmgRef.current);
      maybeTriggerHeartbeatFromTelemetry(data);
    });
    events.addEventListener("emg_telemetry", (event) => {
      const data = JSON.parse(event.data);
      latestEmgRef.current = data;
    });
    events.addEventListener("telemetry_snapshot", (event) => {
      const snapshot = JSON.parse(event.data);
      const nextHr = snapshot.hr || latestHrRef.current;
      const nextEmg = snapshot.emg || latestEmgRef.current;
      latestHrRef.current = nextHr;
      latestEmgRef.current = nextEmg;
      setStatus((prev) => ({ ...(prev || {}), engine: snapshot.engine || null }));
      setHrTelemetry(nextHr);
      setEmgTelemetry(nextEmg);
      appendTelemetryPointRef.current(nextHr, nextEmg);
    });
    events.addEventListener("emg_calibration_status", (event) => {
      setCalibrationCommandStatus(JSON.parse(event.data));
    });
    events.addEventListener("recording", (event) => setRecording(JSON.parse(event.data)));
    events.addEventListener("recording_finalized", (event) => setRecording(JSON.parse(event.data)));
    events.addEventListener("files", (event) => setFiles(JSON.parse(event.data)));
    events.addEventListener("live_session", (event) => setLiveSession(JSON.parse(event.data)));
    events.addEventListener("live_session_imported", (event) => {
      setLiveSession((prev) => ({ ...(prev || {}), lastImportedAt: new Date().toISOString(), lastImportResult: JSON.parse(event.data) }));
    });
    return () => events.close();
  }, [maybeTriggerHeartbeatFromTelemetry]);

  useEffect(() => {
    localStorage.setItem("pulsepoint.captureKind", captureKind);
    setCaptureKindError("");
    fetch(apiUrl("/live-capture/capture-kind"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ captureKind }),
    })
      .then(async (response) => {
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(data.error || "Could not update capture type.");
        if (data.session) setLiveSession((prev) => ({ ...(prev || {}), ...data.session }));
      })
      .catch((error) => {
        setCaptureKindError(error?.message || "Could not update capture type.");
      });
  }, [captureKind]);

  useEffect(() => {
    localStorage.setItem("pulsepoint.captureMode", captureMode);
  }, [captureMode]);

  useEffect(() => {
    localStorage.setItem("pulsepoint.emgSensorConfig", emgSensorConfig);
  }, [emgSensorConfig]);

  useEffect(() => {
    refreshHowlTelemetry({ quiet: true });
    const timer = window.setInterval(() => {
      refreshHowlTelemetry({ quiet: true });
    }, HOWL_TELEMETRY_POLL_MS);
    return () => window.clearInterval(timer);
  }, [refreshHowlTelemetry]);

  useEffect(() => {
    localStorage.setItem("pulsepoint.telemetryNotices", telemetryNoticesEnabled ? "on" : "off");
  }, [telemetryNoticesEnabled]);

  useEffect(() => {
    heartbeatAudioEnabledRef.current = heartbeatAudioEnabled;
    localStorage.setItem("pulsepoint.heartbeatAudio", heartbeatAudioEnabled ? "on" : "off");
    if (heartbeatAudioEnabled) getHeartbeatAudioContext();
    else clearHeartbeatPrediction();
  }, [clearHeartbeatPrediction, getHeartbeatAudioContext, heartbeatAudioEnabled]);

  useEffect(() => () => {
    clearHeartbeatPrediction();
    heartbeatAudioContextRef.current?.close?.().catch?.(() => {});
  }, [clearHeartbeatPrediction]);

  useEffect(() => {
    maybeTriggerHeartbeatFromTelemetry(hrTelemetry);
  }, [hrTelemetry, maybeTriggerHeartbeatFromTelemetry]);

  useEffect(() => {
    if (!presetModalOpen) return undefined;
    const onKeyDown = (event) => {
      if (event.key === "Escape") setPresetModalOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [presetModalOpen]);

  useEffect(() => {
    const sessionId = liveSession?.activeSessionId;
    if (!sessionId) {
      setLiveEvents([]);
      setActiveSessionDoc(null);
      return;
    }
    let cancelled = false;
    const refreshActiveSessionDoc = () => liveRecordApi.filter({ id: sessionId }).then((rows) => {
      if (cancelled) return;
      const session = rows[0] || null;
      setActiveSessionDoc(session);
      const events = session?.event_timeline || [];
      setLiveEvents([...events].sort((a, b) => Number(a.time_s || 0) - Number(b.time_s || 0)));
    }).catch(() => {});
    refreshActiveSessionDoc();
    const timer = window.setInterval(refreshActiveSessionDoc, ACTIVE_SESSION_REFRESH_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [liveRecordApi, liveSession?.activeSessionId, liveSession?.lastImportedAt]);

  useEffect(() => {
    const sessionId = liveSession?.activeSessionId;
    const calibration = calibrationCommandStatus?.calibration;
    if (
      !sessionId
      || calibrationCommandStatus?.status !== "applied"
      || !calibrationCommandStatus?.id
      || pendingCalibrationCommandRef.current !== calibrationCommandStatus.id
      || appliedCalibrationCommandRef.current === calibrationCommandStatus.id
      || !calibration
    ) {
      return;
    }
    appliedCalibrationCommandRef.current = calibrationCommandStatus.id;
    const patch = {};
    if (calibration.rest_l != null) patch.emg_rest_left = calibration.rest_l;
    if (calibration.max_l != null) patch.emg_max_left = calibration.max_l;
    if (calibration.rest_r != null) patch.emg_rest_right = calibration.rest_r;
    if (calibration.max_r != null) patch.emg_max_right = calibration.max_r;
    if (calibration.rest != null) patch.emg_rest_left = calibration.rest;
    if (calibration.max_contract != null) patch.emg_max_left = calibration.max_contract;
    if (calibration.flip_lr != null) patch.emg_left_right_flipped = calibration.flip_lr;
    if (!Object.keys(patch).length) return;
    liveRecordApi.update(sessionId, patch).then(() => {
      setActiveSessionDoc((prev) => (prev ? { ...prev, ...patch } : prev));
      setCalibrationStatus(`${calibrationCommandStatus.message} Calibration values have been saved with this session.`);
    }).catch(() => {
      setCalibrationError("Calibration was applied by the helper, but its raw reference values could not be saved to this session.");
    });
  }, [calibrationCommandStatus, liveRecordApi, liveSession?.activeSessionId]);

  const hasRecentHrPacket = useCallback(() => {
    const sample = latestHrRef.current || hrTelemetry;
    const hr = readNumber(sample?.currentHr, sample?.hr, sample?.heartRate);
    if (hr == null) return false;
    const stamp = sample?.engineReceivedAt || sample?.receivedAt || sample?.lastMessageAt || sample?.measuredAt || sample?.source_at;
    const ageMs = stamp ? Date.now() - timestampMs(stamp) : 0;
    return !stamp || (
      Number.isFinite(ageMs)
      && ageMs >= -5000
      && ageMs < SHARED_HR_PACKET_STALE_MS
    );
  }, [hrTelemetry]);

  const prediction = useMemo(() => computeLiveClimaxPrediction(hrTelemetry, emgTelemetry, telemetryHistory, {
    sessionTimeSec: getCurrentSessionTime(),
  }), [emgTelemetry, getCurrentSessionTime, hrTelemetry, telemetryHistory]);
  const recordingTransportActive = Boolean(recording?.active);
  const recordingPaused = Boolean(recordingTransportActive && recording?.paused);
  const recordingActive = Boolean(recordingTransportActive && !recordingPaused);

  useEffect(() => {
    let cancelled = false;

    const releaseWakeLock = async () => {
      const wakeLock = liveCaptureWakeLockRef.current;
      liveCaptureWakeLockRef.current = null;
      try {
        await wakeLock?.release?.();
      } catch {
        // The browser may already have released it when the app was backgrounded.
      }
    };

    const requestWakeLock = async () => {
      if (!recordingActive || document.hidden || liveCaptureWakeLockRef.current || !("wakeLock" in navigator)) return;
      try {
        const wakeLock = await navigator.wakeLock.request("screen");
        if (cancelled || !recordingActive) {
          await wakeLock.release();
          return;
        }
        liveCaptureWakeLockRef.current = wakeLock;
        wakeLock.addEventListener?.("release", () => {
          if (liveCaptureWakeLockRef.current === wakeLock) liveCaptureWakeLockRef.current = null;
        });
      } catch {
        // Unsupported or denied wake locks must not interrupt an active capture.
      }
    };

    const onVisibilityChange = () => {
      if (document.hidden) {
        releaseWakeLock();
      } else {
        requestWakeLock();
      }
    };

    if (recordingActive) requestWakeLock();
    else releaseWakeLock();
    document.addEventListener("visibilitychange", onVisibilityChange);

    return () => {
      cancelled = true;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      releaseWakeLock();
    };
  }, [recordingActive]);

  const recentHrPacket = hasRecentHrPacket();
  const hrConnected = Boolean(recentHrPacket || status?.hr?.sourceStatus?.connected || status?.hr?.connected);
  const emgSourceAt = emgTelemetry?.source_at || status?.emg?.lastSourceAt || status?.emg?.lastMessageAt;
  const emgLive = captureMode !== "hr" && recordingActive && isRecent(emgSourceAt);
  const mainTelemetryView = captureMode === "hr";
  const telemetryEmgLive = recordingActive && isRecent(emgSourceAt);
  const distanceTelemetryView = true;
  const hasHrTrend = telemetryHistory.some((point) => point.hr != null || point.hrSmoothed != null);
  const hasEmgTrend = telemetryHistory.some((point) => point.left != null || point.right != null || point.diff != null);
  const currentHrLevel = hrLevelPercent(hrTelemetry?.currentHr, hrTelemetry?.baselineHr);
  const buildLevel = readNumber(hrTelemetry?.buildConfidence, hrTelemetry?.build_confidence);
  const hrv = hrTelemetry?.hrv || {};
  const rrCount = readNumber(hrTelemetry?.quality?.rrCount, hrv.sampleCount);
  const hrvRmssd = readNumber(hrv.rmssdMs, hrTelemetry?.hrv_rmssd_ms);
  const hrvQuality = hrv.quality || hrTelemetry?.hrv_quality || null;
  const directH10Source = hrSourceSettings.source === "direct_h10";
  const effectiveH10Multimodal = hrTelemetry?.multimodal?.streams?.ecg?.sampleCount > 0
    ? hrTelemetry.multimodal
    : h10Multimodal;
  const h10SignalConfidence = effectiveH10Multimodal?.signalConfidence || {};
  const h10Motion = effectiveH10Multimodal?.motion || {};
  const h10Respiration = effectiveH10Multimodal?.respiration || {};
  const h10Recovery = effectiveH10Multimodal?.recovery || {};
  const h10Position = effectiveH10Multimodal?.position || {};
  const h10Latency = effectiveH10Multimodal?.responseLatency || {};
  const h10State = effectiveH10Multimodal?.state || { label: "WAITING", tone: "neutral" };
  const rawRrUsable = Boolean(
    directH10Source
    && Number(rrCount) >= 10
    && ["high", "moderate"].includes(String(hrvQuality || "").toLowerCase())
  );
  const rawRrWeak = Boolean(
    directH10Source
    && recentHrPacket
    && !rawRrUsable
  );
  const emgConfigured = captureMode !== "hr" && emgSensorConfig !== "generic";
  const liveHealthHrSeenAtRef = useRef(recentHrPacket ? Date.now() : 0);
  const liveHealthHrLinkAtRef = useRef(hrConnected ? Date.now() : 0);
  const liveHealthRrUsableAtRef = useRef(rawRrUsable ? Date.now() : 0);
  const liveHealthRrSeenAtRef = useRef(rawRrWeak ? Date.now() : 0);
  const liveHealthEmgSeenAtRef = useRef(telemetryEmgLive ? Date.now() : 0);
  const [liveHealthNowMs, setLiveHealthNowMs] = useState(() => Date.now());

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      setLiveHealthNowMs(Date.now());
    }, 1000);
    return () => window.clearInterval(intervalId);
  }, []);

  useEffect(() => {
    const now = Date.now();
    if (recentHrPacket) liveHealthHrSeenAtRef.current = now;
    if (hrConnected) liveHealthHrLinkAtRef.current = now;
    if (rawRrUsable) liveHealthRrUsableAtRef.current = now;
    if (rawRrWeak || (directH10Source && Number(rrCount) > 0)) liveHealthRrSeenAtRef.current = now;
    if (telemetryEmgLive) liveHealthEmgSeenAtRef.current = now;
  }, [recentHrPacket, hrConnected, rawRrUsable, rawRrWeak, directH10Source, rrCount, telemetryEmgLive]);

  const healthRecentHrPacket = recentHrPacket || (liveHealthNowMs - liveHealthHrSeenAtRef.current) <= LIVE_HEALTH_HR_GRACE_MS;
  const healthHrConnected = hrConnected || (liveHealthNowMs - liveHealthHrLinkAtRef.current) <= LIVE_HEALTH_HR_GRACE_MS;
  const healthRrUsable = rawRrUsable || (
    directH10Source
    && (liveHealthNowMs - liveHealthRrUsableAtRef.current) <= LIVE_HEALTH_RR_USABLE_GRACE_MS
  );
  const healthRrWeak = Boolean(
    directH10Source
    && healthRecentHrPacket
    && !healthRrUsable
    && (
      rawRrWeak
      || (liveHealthNowMs - liveHealthRrSeenAtRef.current) <= LIVE_HEALTH_RR_SEEN_GRACE_MS
    )
  );
  const healthTelemetryEmgLive = telemetryEmgLive || (
    emgConfigured
    && (liveHealthNowMs - liveHealthEmgSeenAtRef.current) <= LIVE_HEALTH_EMG_GRACE_MS
  );
  const latestBpReading = selectLiveSessionBloodPressure({
    activeSessionId: liveSession?.activeSessionId,
    activeSessionDoc,
    captureState: bpCapture,
  });
  const latestBpValue = latestBpReading?.systolic_mm_hg && latestBpReading?.diastolic_mm_hg
    ? `${latestBpReading.systolic_mm_hg}/${latestBpReading.diastolic_mm_hg}`
    : "--";
  const latestBpHelper = latestBpReading
    ? `${latestBpReading.pulse_bpm ? `${Math.round(Number(latestBpReading.pulse_bpm))} bpm pulse · ` : ""}${formatBloodPressureTime(latestBpReading.measured_at)}`
    : "waiting for OMRON";
  const leftEmgLevel = readNumber(emgTelemetry?.left_pct, emgTelemetry?.level_pct);
  const rightEmgLevel = readNumber(emgTelemetry?.right_pct);
  const engineStatus = status?.engine || null;
  const engineRunning = Boolean(engineStatus?.running);
  const engineStorageOk = engineStatus?.storage?.ok !== false && Number(engineStatus?.queue?.droppedStored || 0) === 0;
  const engineBufferFill = Math.max(
    Number(engineStatus?.buffers?.hr?.fillRatio || 0),
    Number(engineStatus?.buffers?.emg?.fillRatio || 0),
    Number(engineStatus?.buffers?.events?.fillRatio || 0),
  );
  const engineBufferPct = Math.round(engineBufferFill * 100);
  const calibrationReading = useMemo(
    () => summarizeEmgCalibrationReading(telemetryHistory, emgTelemetry),
    [emgTelemetry, telemetryHistory],
  );
  const captureDigest = activeSessionDoc?.capture_digest || null;
  const postCaptureWrap = useMemo(() => {
    const events = [...(activeSessionDoc?.event_timeline || [])]
      .filter((event) => Number.isFinite(Number(event?.time_s)))
      .sort((a, b) => Number(a.time_s) - Number(b.time_s));
    if (!events.length && !captureDigest) return null;
    const artifacts = events.filter((event) => {
      const categories = asArray(event.category).map((category) => String(category).toLowerCase());
      const note = String(event.note || "").toLowerCase();
      return categories.includes("artifact") || note.includes("artifact") || note.includes("telemetry noise");
    });
    const bpEvents = events.filter((event) => event?.blood_pressure || asArray(event.category).includes("blood_pressure"));
    const phaseMoments = [
      activeSessionDoc?.pre_climax_offset_s != null ? { label: "Pre-Climax", timeS: Number(activeSessionDoc.pre_climax_offset_s) } : null,
      activeSessionDoc?.climax_offset_s != null ? { label: "Climax", timeS: Number(activeSessionDoc.climax_offset_s) } : null,
      activeSessionDoc?.recovery_offset_s != null ? { label: "Recovery", timeS: Number(activeSessionDoc.recovery_offset_s) } : null,
    ].filter(Boolean);
    return {
      totalEvents: events.length,
      quickPadEvents: events.filter((event) => asArray(event.annotation_tags).includes("quick_pad")).length,
      artifactCount: artifacts.length,
      bpCount: bpEvents.length,
      phaseMoments,
      notableEvents: [...events].reverse().slice(0, 5),
    };
  }, [activeSessionDoc, captureDigest]);
  const recentLiveEvents = useMemo(() => [...liveEvents].sort((a, b) => Number(b.time_s || 0) - Number(a.time_s || 0)).slice(0, 8), [liveEvents]);
  const recentPhaseMarkers = useMemo(() => [...phaseMarkers].reverse().slice(0, 5), [phaseMarkers]);
  const quickEventPads = useMemo(() => (
    captureIsBodyExploration
      ? [
        {
          key: "instrument_change",
          label: "Instrument Change",
          category: ["instrumentation", "instrumentation_change"],
          note: "Instrumentation changed.",
        },
        {
          key: "finding",
          label: "Physical Finding",
          category: ["physical"],
          note: "New physical finding observed.",
        },
        {
          key: "comfort",
          label: "Comfort Check",
          category: ["comfort", "sensation"],
          note: "Comfort or tolerance changed.",
        },
        {
          key: "setup_change",
          label: "Setup Change",
          category: ["setup"],
          note: "Position or setup changed.",
        },
        {
          key: "artifact",
          label: "Artifact",
          category: ["other"],
          note: "Movement or contact artifact likely affected telemetry.",
        },
        {
          key: "bp_taken",
          label: "BP Taken",
          category: ["physical", "other"],
          note: latestBpReading ? `Blood pressure captured: ${formatBloodPressure(latestBpReading)}.` : "Blood pressure check performed.",
        },
      ]
      : [
        {
          key: "stim_start",
          label: "Stim Start",
          category: ["stimulation", "stimulation_started"],
          note: "Stimulation started.",
        },
        {
          key: "stim_pause",
          label: "Stim Pause",
          category: ["stimulation", "stimulation_paused"],
          note: "Stimulation paused.",
        },
        {
          key: "position_change",
          label: "Position",
          category: ["movement_observed", "other"],
          note: "Position or body mechanics changed.",
        },
        {
          key: "edging_window",
          label: "Edging",
          category: ["sensation", "other"],
          note: "Edging or threshold hold started.",
        },
        {
          key: "climax",
          label: "Climax",
          category: ["physical", "other"],
          note: "Climax or release observed.",
          phaseKey: "climax_offset_s",
          phaseLabel: "Climax",
        },
        {
          key: "recovery_start",
          label: "Recovery",
          category: ["physical", "other"],
          note: "Recovery started.",
          phaseKey: "recovery_offset_s",
          phaseLabel: "Recovery",
        },
        {
          key: "howl_change",
          label: "Howl Change",
          category: ["stimulation", "other"],
          note: "Howl or device setting changed.",
        },
        {
          key: "artifact",
          label: "Artifact",
          category: ["movement_observed", "other"],
          note: "Movement or contact artifact likely affected telemetry.",
        },
        {
          key: "bp_taken",
          label: "BP Taken",
          category: ["physical", "other"],
          note: latestBpReading ? `Blood pressure captured: ${formatBloodPressure(latestBpReading)}.` : "Blood pressure check performed.",
        },
      ]
  ), [captureIsBodyExploration, latestBpReading]);
  const selectedCaptureMode = CAPTURE_MODES.find((mode) => mode.value === captureMode) || CAPTURE_MODES[0];
  const selectedEmgConfig = EMG_SENSOR_CONFIGS.find((config) => config.value === emgSensorConfig) || EMG_SENSOR_CONFIGS[0];
  const usingPerinealEmgConfig = selectedEmgConfig.value === "perineal_body_small_electrodes";
  const perinealCalibration = useMemo(() => calibrationFromSession(activeSessionDoc || {}), [activeSessionDoc]);
  const perinealSignalQuality = useMemo(
    () => signalQualityFromCalibration(perinealCalibration, calibrationReading.left?.spread ?? null),
    [calibrationReading.left?.spread, perinealCalibration],
  );
  const selectedHrSource = HR_SOURCE_OPTIONS.find((option) => option.value === hrSourceSettings.source) || HR_SOURCE_OPTIONS[0];
  const howlMeasuredAt = howlTelemetry?.measured_at || howlTelemetry?.received_at || null;
  const howlLive = isRecent(howlMeasuredAt, 10000);
  const howlModeSummary = [
    howlTelemetry?.mode,
    howlTelemetry?.waveform,
    howlTelemetry?.frequency_hz != null ? `${fmtNumber(howlTelemetry.frequency_hz, 0)} Hz` : null,
    howlTelemetry?.intensity != null ? `intensity ${fmtNumber(howlTelemetry.intensity, 0)}` : null,
    howlTelemetry?.power_level != null ? `power ${fmtNumber(howlTelemetry.power_level, 0)}` : null,
  ].filter(Boolean).join(" · ");
  const howlEndpointText = `${apiUrl("/howl/telemetry").replace(/^https?:\/\/[^/]+/, "")}`;
  const howlControlEnabled = Boolean(howlControlForm.controlEnabled);
  const howlSarahAutoEnabled = Boolean(howlControlForm.sarahAutoEnabled);
  const howlControlCeiling = readNumber(howlControlForm.intensityCeiling) ?? 20;
  const howlControlFloor = readNumber(howlControlForm.intensityFloor) ?? 0;
  const howlHelperPollPath = apiUrl("/howl/control/next?client=howl-helper").replace(/^https?:\/\/[^/]+/, "");
  const howlControlUrlPreview = previewHowlControlUrl(howlControlForm.controlUrl);
  const howlRemoteKeyReady = Boolean(String(howlControlForm.remoteAccessKey || "").trim());
  const howlConnectionSucceeded = howlConnectionTest.status === "ok";
  const howlManualControlsUnlocked = howlControlEnabled && howlConnectionSucceeded;
  const selectedHowlActivity = HOWL_ACTIVITY_MODES.find((mode) => mode.name === howlCommandForm.mode) || HOWL_ACTIVITY_MODES.find((mode) => mode.name === "MILKMASTER");
  const latestHowlStateCommand = latestHowlCommandState(howlCommandHistory);
  const howlChannelAIntensity = readNumber(
    readHowlChannelIntensity(howlTelemetry, "a"),
    howlTelemetry?.raw?.options?.power_a,
    latestHowlStateCommand?.dispatch?.howl?.power_a,
    howlCommandForm.channel === "a" ? howlCommandForm.intensity : null,
  );
  const howlChannelBIntensity = readNumber(
    readHowlChannelIntensity(howlTelemetry, "b"),
    howlTelemetry?.raw?.options?.power_b,
    latestHowlStateCommand?.dispatch?.howl?.power_b,
    howlCommandForm.channel === "b" ? howlCommandForm.intensity : null,
  );
  const howlSelectedChannelIntensity = readNumber(
    howlCommandForm.channel === "b" ? howlChannelBIntensity : howlChannelAIntensity,
    howlCommandForm.intensity,
    0,
  ) ?? 0;
  const physiologyChartData = useMemo(() => telemetryHistory.map((point) => ({
    ...point,
    motionLoad: point.motionRms == null ? null : Math.min(100, Number(point.motionRms) / 3.6),
    howlDose: point.howlIntensity == null || howlControlCeiling <= 0
      ? null
      : Math.min(100, (Number(point.howlIntensity) / howlControlCeiling) * 100),
    breathHoldBand: point.possibleBreathHold ? 100 : null,
  })), [howlControlCeiling, telemetryHistory]);
  const hasThresholdPhysiologyTrend = physiologyChartData.some((point) => (
    point.plateau != null
    || point.controllerConfidence != null
    || point.respirationBpm != null
    || point.motionLoad != null
  ));
  const howlControllerMode = String(howlPhysiologyControllerRef.current?.mode || "baseline").replaceAll("_", " ");
  const howlWaveformLabel = readHowlChannelText(howlTelemetry, howlCommandForm.channel, "waveform")
    || readHowlChannelText(howlTelemetry, howlCommandForm.channel, "mode")
    || selectedHowlActivity?.displayName
    || howlCommandForm.mode
    || "";
  const howlTelemetryHasWaveform = Boolean(
    readHowlChannelText(howlTelemetry, howlCommandForm.channel, "waveform")
    || readHowlChannelText(howlTelemetry, howlCommandForm.channel, "mode")
    || howlTelemetry?.waveform
    || howlTelemetry?.mode,
  );
  const howlDisplayStatus = howlSarahAutoEnabled
    ? howlAutoStatus
    : howlManualControlsUnlocked
      ? "Manual Howl control ready."
      : howlConnectionSucceeded
        ? "Connection tested; enable manual control to send commands."
        : "Set up and test Howl before sending commands.";
  const howlControlModeLabel = howlControlEnabled
    ? howlControlForm.dispatchMode === "direct_http"
      ? "Direct HTTP"
      : howlControlForm.dispatchMode === "queue_and_direct"
        ? "Queue + direct"
        : "Helper queue"
    : "Disabled";
  const visibleHeartbeatPulseId = heartbeatAudioEnabled ? heartbeatPulseId : 0;

  useEffect(() => {
    if (!howlManualControlsUnlocked || !howlSarahAutoEnabled) {
      howlAutoCandidateRef.current = { key: "", since: 0, target: null };
      howlPhysiologyControllerRef.current = createHowlPhysiologyControllerState(howlCommandForm.intensity);
      setHowlAutoStatus(howlManualControlsUnlocked ? "Sarah auto-control is off." : "Manual Howl control must be enabled and tested first.");
      return;
    }
    if (!hrTelemetry || !hrConnected) {
      howlAutoCandidateRef.current = { key: "", since: 0, target: null };
      setHowlAutoStatus("Sarah is armed, waiting for live HR/HRV.");
      return;
    }
    if (howlControlBusy) return;

    const now = Date.now();
    const cooldownMs = Math.max(2000, (readNumber(howlControlForm.autoCooldownSeconds) ?? 8) * 1000);
    const last = howlAutoLastActionRef.current || { at: 0, intensity: null };
    if (now - last.at < cooldownMs) {
      const remaining = Math.ceil((cooldownMs - (now - last.at)) / 1000);
      setHowlAutoStatus(`Sarah holding for ${remaining}s after last adjustment.`);
      return;
    }

    const channel = howlCommandForm.channel || "a";
    const observedIntensity = readHowlChannelIntensity(howlTelemetry, channel);
    const currentIntensity = readNumber(observedIntensity, last.intensity, howlCommandForm.intensity, 0) ?? 0;
    const floor = Math.max(0, howlControlFloor);
    const ceiling = Math.max(floor, howlControlCeiling);
    const decision = computeHowlPhysiologyAction({
      prediction,
      multimodal: hrTelemetry?.multimodal || {},
      currentIntensity,
      floor,
      ceiling,
      settings: howlControlForm,
      state: howlPhysiologyControllerRef.current,
    });
    howlPhysiologyControllerRef.current = decision.state;
    const target = decision.target;
    const desiredAction = decision.action;
    const dwellMs = decision.dwellMs;
    const reason = `sarah_auto_${desiredAction} near=${prediction.nearClimax} plateau=${prediction.plateauScore} recovery=${prediction.recovery} confidence=${prediction.controllerConfidence}`;

    if (target === Math.round(currentIntensity)) {
      howlAutoCandidateRef.current = { key: "", since: 0, target: null };
      setHowlAutoStatus(`${decision.explanation} ${prediction.reason || prediction.label}`);
      return;
    }

    const candidateKey = `${desiredAction}:${target}`;
    const candidate = howlAutoCandidateRef.current || { key: "", since: 0, target: null };
    if (candidate.key !== candidateKey) {
      howlAutoCandidateRef.current = { key: candidateKey, since: now, target };
      const waitSeconds = Math.max(1, Math.ceil(dwellMs / 1000));
      setHowlAutoStatus(
        desiredAction === "build_ramp"
          ? `Sarah is watching a sustained build before nudging intensity to ${target}. Holding about ${waitSeconds}s to confirm it is not just noise.`
          : desiredAction === "final_approach" || desiredAction === "reapproach"
            ? `Sarah is confirming ${desiredAction === "reapproach" ? "recovery clearance" : "threshold stability"} for about ${waitSeconds}s before advancing to ${target}.`
            : `Sarah is confirming a genuine recovery window for about ${waitSeconds}s before the shallow retreat to ${target}.`
      );
      return;
    }

    if (now - candidate.since < dwellMs) {
      const remaining = Math.max(1, Math.ceil((dwellMs - (now - candidate.since)) / 1000));
      setHowlAutoStatus(
        desiredAction === "build_ramp"
          ? `Sarah build watch holding ${remaining}s more before stepping up. ${prediction.reason || prediction.label}`
          : desiredAction === "final_approach" || desiredAction === "reapproach"
            ? `Sarah final-approach watch holding ${remaining}s more before stepping up. ${prediction.reason || prediction.label}`
            : `Sarah recovery watch holding ${remaining}s more before the bounded retreat. ${prediction.reason || prediction.label}`
      );
      return;
    }

    howlAutoLastActionRef.current = { at: now, intensity: target, reason };
    howlAutoCandidateRef.current = { key: "", since: 0, target: null };
    setHowlCommandForm((prev) => ({ ...prev, intensity: target }));
    setHowlAutoStatus(
      `Sarah ${target > currentIntensity ? "increased" : "reduced"} Howl intensity to ${target} after ${Math.round(dwellMs / 1000)}s of stable ${decision.state.mode.replaceAll("_", " ")} evidence.`
    );
    sendHowlControlCommand("set_intensity", {
      channel,
      intensity: target,
      reason,
      controller: {
        source: "sarah_live_hrv_controller",
        nearClimax: prediction.nearClimax,
        recovery: prediction.recovery,
        label: prediction.label,
        hrvSignal: prediction.hrvSignal,
        hrvUsable: prediction.hrvUsable,
        rmssd: prediction.rmssd,
        rrCount: prediction.rrCount,
        currentHr: readNumber(hrTelemetry?.currentHr, hrTelemetry?.hr, hrTelemetry?.heartRate),
        observedIntensity,
        previousIntensity: currentIntensity,
        targetIntensity: target,
        desiredAction,
        dwellMs,
        confirmationCount: prediction.confirmationCount,
        buildEligibleForNearClimax: prediction.buildEligibleForNearClimax,
        plateauScore: prediction.plateauScore,
        physiologicalIntensity: prediction.physiologicalIntensity,
        controllerConfidence: prediction.controllerConfidence,
        multimodalTrusted: prediction.multimodalTrusted,
        respirationBpm: prediction.respirationBpm,
        possibleBreathHold: prediction.possibleBreathHold,
        motionClass: prediction.motionClass,
        retainedPeakIntensity: decision.state.peakIntensity,
        recoveryFloor: decision.state.recoveryFloor,
      },
    });
  }, [
    howlCommandForm.channel,
    howlCommandForm.intensity,
    howlControlBusy,
    howlControlCeiling,
    howlControlFloor,
    howlControlForm.autoCooldownSeconds,
    howlControlForm.buildRampEnabled,
    howlControlForm.buildStep,
    howlControlForm.buildThreshold,
    howlControlForm.finalApproachEnabled,
    howlControlForm.finalApproachStep,
    howlControlForm.maxRecoveryRetreat,
    howlControlForm.nearClimaxReductionEnabled,
    howlControlForm.nearClimaxThreshold,
    howlControlForm.plateauThreshold,
    howlControlForm.recoveryReductionEnabled,
    howlControlForm.recoveryThreshold,
    howlControlForm.reduceStep,
    howlManualControlsUnlocked,
    howlSarahAutoEnabled,
    howlTelemetry,
    hrConnected,
    hrTelemetry,
    prediction,
    sendHowlControlCommand,
  ]);
  const emgCalibrationSteps = useMemo(() => {
    if (!usingPerinealEmgConfig) return EMG_CALIBRATION_STEPS;
    return EMG_CALIBRATION_STEPS.map((step) => {
      if (step.key === "neutral") {
        return {
          ...step,
          label: "Relaxed baseline",
          instruction: "Relax the pelvic floor/perineal body and hold still for a quiet reference.",
        };
      }
      if (step.key === "both_max") {
        return {
          ...step,
          label: "Comfortable contraction",
          instruction: "Briefly contract the perineal body/pelvic floor as clearly as is comfortable, then release.",
        };
      }
      if (step.key === "left_max") {
        return {
          ...step,
          label: "Primary channel contraction",
          instruction: "Use this only with dual-channel placement when the primary perineal channel should be calibrated separately.",
        };
      }
      if (step.key === "right_max") {
        return {
          ...step,
          label: "Aux channel contraction",
          instruction: "Use this only with dual-channel placement when the aux/reference channel should be calibrated separately.",
        };
      }
      return step;
    });
  }, [usingPerinealEmgConfig]);
  const maxHr = useMemo(() => {
    const values = telemetryHistory.map((point) => point.hr).filter((value) => value != null);
    const current = readNumber(hrTelemetry?.currentHr, hrTelemetry?.hr, hrTelemetry?.heartRate);
    if (current != null) values.push(current);
    return values.length ? Math.max(...values) : null;
  }, [hrTelemetry, telemetryHistory]);

  const setFocusView = useCallback((enabled) => {
    const nextParams = new URLSearchParams(searchParams);
    if (enabled) {
      nextParams.set("display", "focus");
    } else {
      nextParams.delete("display");
    }
    setSearchParams(nextParams);
  }, [searchParams, setSearchParams]);

  useEffect(() => {
    localStorage.setItem(TELEMETRY_DASHBOARD_STORAGE_KEY, JSON.stringify(telemetryDashboard));
  }, [telemetryDashboard]);

  const telemetryPanelEnabled = useCallback((id) => (
    telemetryDashboard.find((panel) => panel.id === id)?.enabled !== false
  ), [telemetryDashboard]);

  const telemetryPanelOrder = useCallback((id) => {
    const index = telemetryDashboard.findIndex((panel) => panel.id === id);
    return index < 0 ? TELEMETRY_DASHBOARD_PANELS.length : index;
  }, [telemetryDashboard]);

  const updateTelemetryPanel = useCallback((id, update) => {
    setTelemetryDashboard((previous) => previous.map((panel) => (
      panel.id === id ? { ...panel, ...update } : panel
    )));
  }, []);

  const moveTelemetryPanel = useCallback((id, direction) => {
    setTelemetryDashboard((previous) => {
      const index = previous.findIndex((panel) => panel.id === id);
      const nextIndex = index + direction;
      if (index < 0 || nextIndex < 0 || nextIndex >= previous.length) return previous;
      const next = [...previous];
      [next[index], next[nextIndex]] = [next[nextIndex], next[index]];
      return next;
    });
  }, []);

  const clearMediaVideo = useCallback(() => {
    if (mediaObjectUrlRef.current) {
      URL.revokeObjectURL(mediaObjectUrlRef.current);
      mediaObjectUrlRef.current = null;
    }
    setMediaVideo(null);
    setMediaPlaying(false);
    setMediaProcessing("");
    setMediaError("");
    if (mediaInputRef.current) mediaInputRef.current.value = "";
  }, []);

  const loadMediaFile = useCallback(async (file) => {
    if (!isMediaVideoFile(file)) {
      setMediaError("Choose a video file. WMV, MP4, WebM, MOV, MKV, M4V, and AVI are accepted.");
      return;
    }
    if (mediaObjectUrlRef.current) URL.revokeObjectURL(mediaObjectUrlRef.current);
    mediaObjectUrlRef.current = null;
    setMediaError("");
    if (needsMediaTranscode(file)) {
      setMediaProcessing(`Converting ${file.name} to MP4 for browser playback...`);
      setMediaVideo(null);
      try {
        const converted = await base44.integrations.Core.ConvertVideoForPlayback({ file, label: file.name });
        setMediaVideo({
          url: converted.url || converted.file_url,
          name: file.name,
          size: file.size,
          convertedName: converted.filename,
          convertedSize: converted.size,
          converted: true,
        });
        setMediaPlaying(false);
      } catch (error) {
        setMediaError(error?.data?.error || error?.message || "Could not convert that WMV for playback.");
      } finally {
        setMediaProcessing("");
      }
      return;
    }
    const url = URL.createObjectURL(file);
    mediaObjectUrlRef.current = url;
    setMediaVideo({ url, name: file.name, size: file.size, converted: false });
    setMediaPlaying(false);
    setMediaProcessing("");
  }, []);

  const loadMediaFiles = useCallback((filesList) => {
    const file = Array.from(filesList || []).find(isMediaVideoFile);
    if (file) loadMediaFile(file);
    else setMediaError("Drop or choose a video file. WMV, MP4, WebM, MOV, MKV, M4V, and AVI are accepted.");
  }, [loadMediaFile]);

  const openMediaFullscreen = useCallback(async () => {
    const video = mediaVideoRef.current;
    if (!video) return;
    if (video.requestFullscreen) await video.requestFullscreen();
    else if (video.webkitRequestFullscreen) video.webkitRequestFullscreen();
  }, []);

  useEffect(() => {
    const onFullscreenChange = () => {
      setMediaFullscreen(document.fullscreenElement === mediaVideoRef.current || document.webkitFullscreenElement === mediaVideoRef.current);
    };
    document.addEventListener("fullscreenchange", onFullscreenChange);
    document.addEventListener("webkitfullscreenchange", onFullscreenChange);
    return () => {
      document.removeEventListener("fullscreenchange", onFullscreenChange);
      document.removeEventListener("webkitfullscreenchange", onFullscreenChange);
    };
  }, []);

  useEffect(() => () => {
    if (mediaObjectUrlRef.current) URL.revokeObjectURL(mediaObjectUrlRef.current);
  }, []);

  useEffect(() => {
    const video = mediaVideoRef.current;
    if (!video) {
      setMediaPlaying(false);
      return undefined;
    }
    const syncPlaying = () => setMediaPlaying(!video.paused && !video.ended);
    syncPlaying();
    video.addEventListener("play", syncPlaying);
    video.addEventListener("pause", syncPlaying);
    video.addEventListener("ended", syncPlaying);
    return () => {
      video.removeEventListener("play", syncPlaying);
      video.removeEventListener("pause", syncPlaying);
      video.removeEventListener("ended", syncPlaying);
    };
  }, [mediaVideo]);

  const toggleMediaPlayback = useCallback(async () => {
    const video = mediaVideoRef.current;
    if (!video) return;
    try {
      if (video.paused || video.ended) {
        await video.play();
      } else {
        video.pause();
      }
    } catch (error) {
      setMediaError(error?.message || "Could not start video playback.");
    }
  }, []);

  const refreshFiles = async () => {
    const res = await fetch(apiUrl("/live-capture/refresh-files"), { method: "POST" });
    if (res.ok) setFiles(await res.json());
  };

  const ensureSession = async () => {
    const res = await fetch(apiUrl("/live-capture/ensure-session"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recording, captureKind }),
    });
    if (res.ok) {
      const data = await res.json();
      setLiveSession(data.session);
      return data.session;
    }
    return null;
  };

  const endLiveSession = useCallback(async () => {
    if (!liveSession?.activeSessionId || !liveSession?.active) return null;
    setEndingSession(true);
    try {
      const res = await fetch(apiUrl("/live-capture/end-session"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ recording }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Could not end the live session.");
      if (data.session) setLiveSession(data.session);
      toast({
        title: "Session finalized",
        description: data.result?.hr_rows
          ? `Merged ${data.result.hr_rows} HR rows into the session.`
          : "Live capture session ended.",
      });
      return data.session || null;
    } catch (error) {
      toast({
        title: "End session failed",
        description: error?.message || "Could not end the live session.",
        variant: "destructive",
      });
      return null;
    } finally {
      setEndingSession(false);
    }
  }, [liveSession?.activeSessionId, liveSession?.active, recording, toast]);

  useEffect(() => {
    voiceWakeEnabledRef.current = voiceWakeEnabled;
  }, [voiceWakeEnabled]);

  useEffect(() => {
    annotationRecordingRef.current = annotationRecording;
  }, [annotationRecording]);

  const speechRecognitionSupported = typeof window !== "undefined" && Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
  const voiceRecordingSupported = typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== "undefined";
  const desktopVoiceWakeAvailable = typeof window !== "undefined" && Boolean(window.sarahDesktop?.startVoiceWake && window.sarahDesktop?.onVoiceWakeEvent);
  const voiceWakeSupported = speechRecognitionSupported || desktopVoiceWakeAvailable;
  const desktopWakeUnsupported = isSarahDesktopRuntime() && voiceRecordingSupported && !voiceWakeSupported;
  const desktopWakeFallbackActive = isSarahDesktopRuntime() && desktopVoiceWakeAvailable && !speechRecognitionSupported;
  const voiceReady = voiceWakeSupported && voiceRecordingSupported;
  const embeddedObsStatus = status?.hr?.relay?.obs || null;
  const obsReady = Boolean(recordingActive || embeddedObsStatus?.identified);
  const emgRecent = isRecent(emgSourceAt);
  const liveSessionPaused = Boolean(liveSession?.activeSessionId && liveSession?.active && !recordingActive);

  useEffect(() => {
    perinealProtocolRef.current = perinealProtocol;
  }, [perinealProtocol]);

  useEffect(() => {
    const detector = createPerinealEmgDetector({ calibration: perinealCalibration });
    perinealDetectorRef.current = detector;
    setPerinealDetectorSnapshot({ ...detector, counts: { ...detector.counts } });
    lastPerinealSampleSignatureRef.current = "";
  }, [
    perinealCalibration?.id,
    perinealCalibration?.baseline_mean_pct,
    perinealCalibration?.suggested_detection_threshold_pct,
    perinealCalibration?.suggested_strong_threshold_pct,
  ]);

  const appendLiveSessionEvents = useCallback(async (eventsToAdd, extraPatch = {}) => {
    const additions = Array.isArray(eventsToAdd) ? eventsToAdd.filter(Boolean) : [eventsToAdd].filter(Boolean);
    if (!additions.length && !Object.keys(extraPatch).length) return;
    const sessionState = liveSession?.activeSessionId ? liveSession : await ensureSession();
    const sessionId = sessionState?.activeSessionId;
    if (!sessionId) throw new Error("No active live session is available.");
    const rows = await liveRecordApi.filter({ id: sessionId });
    const session = rows[0] || activeSessionDoc || {};
    const existing = Array.isArray(session.event_timeline) ? session.event_timeline : [];
    const seen = new Set(existing.map((event) => event.id).filter(Boolean));
    const merged = [...existing];
    for (const event of additions) {
      if (event.id && seen.has(event.id)) continue;
      if (event.id) seen.add(event.id);
      merged.push(event);
    }
    const patch = {
      ...extraPatch,
      event_timeline: merged.sort((a, b) => Number(a.time_s || 0) - Number(b.time_s || 0)),
    };
    await liveRecordApi.update(sessionId, patch);
    setLiveEvents(patch.event_timeline);
    setActiveSessionDoc((prev) => ({ ...(prev || session), ...patch }));
  }, [activeSessionDoc, ensureSession, liveRecordApi, liveSession]);

  useEffect(() => {
    appendLiveSessionEventsRef.current = appendLiveSessionEvents;
  }, [appendLiveSessionEvents]);

  const resolveLiveSessionStartMs = useCallback((session = activeSessionDoc) => {
    const direct = Number(recording?.startedAtMs) || (liveSession?.startedAt ? new Date(liveSession.startedAt).getTime() : 0);
    if (direct && Number.isFinite(direct)) return direct;
    const sessionDateMs = new Date(session?.date || session?.capture_started_at || 0).getTime();
    if (!Number.isFinite(sessionDateMs) || sessionDateMs <= 0) return 0;
    if (session?.start_time && /^\d{1,2}:\d{2}/.test(String(session.start_time))) {
      const date = new Date(sessionDateMs);
      const [hour, minute] = String(session.start_time).split(":").map(Number);
      date.setHours(hour, minute, 0, 0);
      return date.getTime();
    }
    return sessionDateMs;
  }, [activeSessionDoc, liveSession?.startedAt, recording?.startedAtMs]);

  const readingIsInActiveSession = useCallback((reading, session = activeSessionDoc) => {
    const measuredMs = new Date(reading?.measured_at || 0).getTime();
    const startMs = resolveLiveSessionStartMs(session);
    if (!Number.isFinite(measuredMs) || measuredMs <= 0 || !startMs) return false;
    const durationMs = Math.max(0, Number(session?.duration_minutes || 0)) * 60000;
    const endMs = recordingActive ? Date.now() + 15000 : startMs + durationMs + 10 * 60000;
    return measuredMs >= startMs - 60000 && measuredMs <= endMs;
  }, [activeSessionDoc, recordingActive, resolveLiveSessionStartMs]);

  const stampBloodPressureReadings = useCallback(async (readings = [], { source = "health_connect_auto" } = {}) => {
    const sessionState = liveSession?.activeSessionId ? liveSession : null;
    const sessionId = sessionState?.activeSessionId;
    if (!sessionId) return { stamped: 0, latest: null };
    const rows = await liveRecordApi.filter({ id: sessionId });
    const session = rows[0] || activeSessionDoc || {};
    const startMs = resolveLiveSessionStartMs(session);
    if (!startMs) return { stamped: 0, latest: null };

    const existingIds = new Set((session.event_timeline || []).map((event) => event.id).filter(Boolean));
    const usable = readings
      .filter((reading) => readingIsInActiveSession(reading, session))
      .filter((reading) => !existingIds.has(`blood-pressure-${reading.id || new Date(reading.measured_at).getTime()}`))
      .sort((a, b) => new Date(a.measured_at).getTime() - new Date(b.measured_at).getTime());
    if (!usable.length) return { stamped: 0, latest: null };

    const events = usable.map((reading) => {
      const measuredMs = new Date(reading.measured_at).getTime();
      const timeS = Math.max(0, Math.round((measuredMs - startMs) / 1000));
      return {
        id: `blood-pressure-${reading.id || measuredMs}`,
        time_s: timeS,
        note: `Blood pressure captured: ${formatBloodPressure(reading)}`,
        label: "Blood pressure captured",
        category: ["physiology", "blood_pressure"],
        source,
        created_at: new Date().toISOString(),
        blood_pressure: {
          reading_id: reading.id,
          measured_at: reading.measured_at,
          systolic_mm_hg: reading.systolic_mm_hg,
          diastolic_mm_hg: reading.diastolic_mm_hg,
          pulse_bpm: reading.pulse_bpm ?? null,
          source_app: reading.source_app || "Health Connect",
          source_device: reading.source_device || "",
        },
      };
    });
    const latest = usable[usable.length - 1];
    await appendLiveSessionEvents(events, {
      session_context: {
        ...(session.session_context || {}),
        blood_pressure: {
          reading_id: latest.id,
          measured_at: latest.measured_at,
          systolic_mm_hg: latest.systolic_mm_hg,
          diastolic_mm_hg: latest.diastolic_mm_hg,
          pulse_bpm: latest.pulse_bpm ?? null,
          source_app: latest.source_app || "Health Connect",
          source_device: latest.source_device || "",
          relationship: "captured_during_live_session",
        },
      },
      latest_blood_pressure_reading: {
        id: latest.id,
        measured_at: latest.measured_at,
        systolic_mm_hg: latest.systolic_mm_hg,
        diastolic_mm_hg: latest.diastolic_mm_hg,
        pulse_bpm: latest.pulse_bpm ?? null,
        source_app: latest.source_app || "Health Connect",
      },
    });
    return { stamped: events.length, latest };
  }, [
    activeSessionDoc,
    appendLiveSessionEvents,
    liveRecordApi,
    liveSession,
    readingIsInActiveSession,
    resolveLiveSessionStartMs,
  ]);

  const syncBloodPressureForLiveSession = useCallback(async ({ manual = false } = {}) => {
    if (bpSyncInFlightRef.current) {
      if (manual) {
        setBpCapture((prev) => ({
          ...prev,
          message: "BP refresh is already running. Give it a second, then the latest reading will update here.",
        }));
      }
      return;
    }
    if (!manual && bpOmronListening) return;
    bpSyncInFlightRef.current = true;
    if (manual) {
      setBpCapture((prev) => ({
        ...prev,
        syncing: true,
        status: "syncing",
        error: "",
        message: "Refreshing BP readings...",
      }));
    } else {
      setBpCapture((prev) => ({
        ...prev,
        error: "",
      }));
    }
    try {
      const nativeStatus = await getBloodPressureStatus().catch(() => ({ native: false, permissionGranted: false }));
      let readings = [];
      let nativeSyncAttempted = false;
      let nativePermissionGranted = Boolean(nativeStatus?.permissionGranted);

      if (nativeStatus?.native !== false && nativeStatus?.permissionGranted) {
        nativeSyncAttempted = true;
        const result = await syncBloodPressureFromHealthConnect({ days: 2, limit: 25 });
        readings = Array.isArray(result?.readings) ? result.readings : [];
      } else {
        const recent = await listRecentBloodPressure(25);
        readings = Array.isArray(recent?.readings) ? recent.readings : [];
      }

      if (!readings.length && nativeSyncAttempted) {
        const recent = await listRecentBloodPressure(25);
        readings = Array.isArray(recent?.readings) ? recent.readings : [];
      }

      const stamped = await stampBloodPressureReadings(readings, {
        source: nativeSyncAttempted
          ? manual ? "health_connect_manual_sync" : "health_connect_auto_sync"
          : manual ? "blood_pressure_database_manual_refresh" : "blood_pressure_database_auto_refresh",
      });
      const latestStoredReading = readings[0] || null;
      const activeSessionId = liveSession?.activeSessionId || null;
      const needsPermission = nativeStatus?.native !== false && !nativePermissionGranted;
      setBpCapture((prev) => ({
        ...prev,
        sessionId: stamped.latest
          ? activeSessionId
          : prev.sessionId === activeSessionId ? prev.sessionId : null,
        native: nativeStatus?.native !== false,
        permissionGranted: nativePermissionGranted,
        syncing: false,
        status: stamped.stamped
          ? "captured"
          : !manual && prev.status === "captured"
            ? "captured"
            : needsPermission
              ? "permission_needed"
              : "idle",
        lastReading: stamped.latest
          ? stamped.latest
          : prev.sessionId === activeSessionId ? prev.lastReading : null,
        lastCapturedAt: stamped.latest ? new Date().toISOString() : prev.lastCapturedAt,
        capturedCount: prev.capturedCount + stamped.stamped,
        message: stamped.stamped
          ? `Captured ${stamped.stamped} BP reading${stamped.stamped === 1 ? "" : "s"} into this session.`
          : latestStoredReading
            ? "Saved BP readings exist, but none were captured during this session."
            : needsPermission
              ? "Health Connect BP permission is not granted on this device. Desktop will still show readings after the phone syncs them."
              : (manual ? "No saved BP reading found yet." : prev.message || "BP sync is watching the local database."),
      }));
    } catch (error) {
      setBpCapture((prev) => ({
        ...prev,
        syncing: false,
        status: "error",
        error: error?.message || "Could not sync BP.",
        message: error?.message || "Could not sync BP.",
      }));
    } finally {
      bpSyncInFlightRef.current = false;
    }
  }, [bpOmronListening, liveSession?.activeSessionId, stampBloodPressureReadings]);

  const saveOmronBloodPressureForLiveSession = useCallback(async (reading) => {
    if (!reading) throw new Error("OMRON did not return a blood pressure reading.");

    const readingKey = reading.external_id || reading.id || `${reading.measured_at}-${reading.systolic_mm_hg}-${reading.diastolic_mm_hg}-${reading.pulse_bpm || ""}`;
    if (bpOmronSeenRef.current.has(readingKey)) return;
    bpOmronSeenRef.current.add(readingKey);

    setBpCapture((prev) => ({
      ...prev,
      native: true,
      syncing: false,
      status: "syncing",
      error: "",
      message: `Received OMRON reading ${formatBloodPressure(reading)}. Saving...`,
    }));

    const saved = await ingestBloodPressureReadings([reading]);
    const savedReadings = Array.isArray(saved?.readings) && saved.readings.length ? saved.readings : [reading];
    const latestReading = savedReadings[0] || reading;

    setBpCapture((prev) => ({
      ...prev,
      native: true,
      permissionGranted: prev.permissionGranted,
      syncing: false,
      status: "ready",
      message: `OMRON captured ${formatBloodPressure(latestReading)} and saved it to PulsePoint.`,
    }));

    stampBloodPressureReadings(savedReadings, { source: "omron_direct_ble_listener" })
      .then((stamped) => {
        if (!stamped?.stamped) return;
        setBpCapture((prev) => ({
          ...prev,
          sessionId: liveSession?.activeSessionId || null,
          status: "captured",
          lastReading: stamped.latest || latestReading,
          lastCapturedAt: new Date().toISOString(),
          capturedCount: prev.capturedCount + stamped.stamped,
          message: `OMRON captured ${formatBloodPressure(stamped.latest || latestReading)} and stamped it into this session.`,
        }));
      })
      .catch((error) => {
        setBpCapture((prev) => ({
          ...prev,
          error: error?.message || "Saved BP, but could not stamp it into the live session.",
          message: `OMRON captured ${formatBloodPressure(latestReading)} and saved it to PulsePoint. Session stamp failed.`,
        }));
      });
  }, [liveSession?.activeSessionId, stampBloodPressureReadings]);

  const startOmronBloodPressureListenerForLiveSession = useCallback(async ({ auto = false, forceDevicePicker = false } = {}) => {
    if (bpOmronActionInFlightRef.current) {
      if (!auto) {
        setBpCapture((prev) => ({
          ...prev,
          message: "OMRON listener is already handling the previous tap.",
        }));
      }
      return false;
    }
    if (auto && !isOmronAutoListenEnabled()) return false;
    if (auto && !getRememberedOmronDevice()) return false;
    if (auto && getOmronBloodPressureListenerState()?.listening) {
      setBpOmronListening(true);
      return true;
    }

    bpOmronActionInFlightRef.current = true;
    setBpCapture((prev) => ({
      ...prev,
      syncing: true,
      status: "syncing",
      error: "",
      message: auto ? "Re-arming saved OMRON listener..." : "Starting OMRON listener...",
    }));
    try {
      await startOmronBloodPressureListener({
        forceDevicePicker,
        onStatus: (message) => {
          setBpCapture((prev) => ({
            ...prev,
            syncing: false,
            status: "syncing",
            error: "",
            message,
          }));
        },
        onReading: (reading) => {
          setBpCapture((prev) => ({
            ...prev,
            syncing: false,
            status: "syncing",
            error: "",
            sessionId: liveSession?.activeSessionId || null,
            lastReading: reading,
            message: `Received OMRON reading ${formatBloodPressure(reading)}. Saving...`,
          }));
          saveOmronBloodPressureForLiveSession(reading).catch((error) => {
            setBpCapture((prev) => ({
              ...prev,
              syncing: false,
              status: "error",
              error: error?.message || "Could not save OMRON blood pressure.",
              message: error?.message || "Could not save OMRON blood pressure.",
            }));
          });
        },
        onDisconnect: ({ stopped } = {}) => {
          const stillArmed = !stopped && Boolean(getOmronBloodPressureListenerState()?.listening);
          setBpOmronListening(stillArmed);
          setBpCapture((prev) => ({
            ...prev,
            syncing: false,
            status: stillArmed ? "syncing" : (prev.lastReading ? "ready" : "idle"),
            message: stillArmed
              ? "OMRON is armed and waiting for the cuff to wake."
              : (prev.lastReading ? "OMRON listener stopped. Latest BP is saved." : "OMRON listener stopped before a BP reading arrived."),
          }));
        },
        onError: (error) => {
          setBpCapture((prev) => ({
            ...prev,
            syncing: false,
            status: "error",
            error: error?.message || "Could not parse OMRON blood pressure.",
            message: error?.message || "Could not parse OMRON blood pressure.",
          }));
        },
      });
      setOmronAutoListenEnabled(true);
      setBpOmronListening(true);
      setBpCapture((prev) => ({
        ...prev,
        syncing: false,
        status: prev.lastReading ? "ready" : "syncing",
        message: auto
          ? "Saved OMRON listener is re-armed. Take a BP reading or wake/transmit the cuff."
          : "OMRON listener is active. Take a BP reading or press the cuff Bluetooth/Transfer button once until the O flashes.",
      }));
      return true;
    } catch (error) {
      setBpOmronListening(false);
      setBpCapture((prev) => ({
        ...prev,
        syncing: false,
        status: auto ? (prev.lastReading ? "ready" : "idle") : "error",
        error: auto ? "" : error?.message || "Could not start OMRON listener.",
        message: auto
          ? (prev.lastReading ? "Latest BP is saved. OMRON will re-arm when the cuff/app is available." : "OMRON auto-listen is waiting for the saved cuff to be available.")
          : error?.message || "Could not start OMRON listener.",
      }));
      return false;
    } finally {
      bpOmronActionInFlightRef.current = false;
    }
  }, [saveOmronBloodPressureForLiveSession]);

  const toggleOmronBloodPressureListener = useCallback(async () => {
    if (bpOmronActionInFlightRef.current) {
      setBpCapture((prev) => ({
        ...prev,
        message: "OMRON listener is already handling the previous tap.",
      }));
      return;
    }

    if (bpOmronListening) {
      bpOmronActionInFlightRef.current = true;
      setBpCapture((prev) => ({
        ...prev,
        syncing: true,
        error: "",
        message: "Stopping OMRON listener...",
      }));
      try {
        setOmronAutoListenEnabled(false);
        await stopOmronBloodPressureListener();
        setBpOmronListening(false);
        setBpCapture((prev) => ({
          ...prev,
          syncing: false,
          status: prev.lastReading ? "ready" : "idle",
          message: prev.lastReading ? "OMRON listener stopped. Latest BP is saved." : "OMRON listener stopped.",
        }));
      } catch (error) {
        setBpCapture((prev) => ({
          ...prev,
          syncing: false,
          status: "error",
          error: error?.message || "Could not stop OMRON listener.",
          message: error?.message || "Could not stop OMRON listener.",
        }));
      } finally {
        bpOmronActionInFlightRef.current = false;
      }
      return;
    }

    await startOmronBloodPressureListenerForLiveSession();
  }, [bpOmronListening, startOmronBloodPressureListenerForLiveSession]);

  useEffect(() => () => {
    stopOmronBloodPressureListener().catch(() => {});
  }, []);

  const requestBloodPressureForLiveCapture = useCallback(async () => {
    setBpCapture((prev) => ({
      ...prev,
      syncing: true,
      status: "syncing",
      error: "",
      message: "Requesting Health Connect BP permission...",
    }));
    try {
      const status = await requestBloodPressurePermission();
      setBpCapture((prev) => ({
        ...prev,
        native: status?.native !== false,
        permissionGranted: Boolean(status?.permissionGranted),
        syncing: false,
        status: status?.permissionGranted ? "ready" : "permission_needed",
        message: status?.permissionGranted ? "BP permission granted. Watching for readings." : "BP permission was not granted yet. Open Health Connect and grant Sarah blood pressure access manually.",
      }));
      if (status?.permissionGranted) {
        syncBloodPressureForLiveSession({ manual: true });
      }
    } catch (error) {
      setBpCapture((prev) => ({
        ...prev,
        syncing: false,
        status: "error",
        error: error?.message || "Could not request BP permission.",
        message: error?.message || "Could not request BP permission.",
      }));
    }
  }, [syncBloodPressureForLiveSession]);

  const openBloodPressureSettingsForLiveCapture = useCallback(async () => {
    setBpCapture((prev) => ({
      ...prev,
      syncing: true,
      error: "",
      message: "Opening Health Connect settings...",
    }));
    try {
      await openHealthConnectSettings();
      setBpCapture((prev) => ({
        ...prev,
        syncing: false,
        status: "permission_needed",
        message: "Health Connect opened. Grant Sarah blood pressure access, then return here and tap Sync BP now.",
      }));
    } catch (error) {
      setBpCapture((prev) => ({
        ...prev,
        syncing: false,
        status: "error",
        error: error?.message || "Could not open Health Connect settings.",
        message: error?.message || "Could not open Health Connect settings.",
      }));
    }
  }, []);

  useEffect(() => {
    syncBloodPressureForLiveSession({ manual: false });
    const timer = window.setInterval(() => {
      syncBloodPressureForLiveSession({ manual: false });
    }, BLOOD_PRESSURE_SYNC_POLL_MS);
    return () => window.clearInterval(timer);
  }, [liveSession?.activeSessionId, syncBloodPressureForLiveSession]);

  useEffect(() => {
    if (!isSarahNativeShell()) return undefined;

    let mounted = true;
    let appStateHandle = null;
    const refreshAndRearmBloodPressure = () => {
      if (!mounted) return;
      const now = Date.now();
      if (now - bpForegroundRefreshCooldownRef.current < 12000) return;
      bpForegroundRefreshCooldownRef.current = now;
      const listenerState = getOmronBloodPressureListenerState();
      const listenerActive = Boolean(bpOmronListening || listenerState?.listening);
      if (!listenerActive && !bpOmronActionInFlightRef.current) {
        syncBloodPressureForLiveSession({ manual: false });
      }
      if (isOmronAutoListenEnabled() && !listenerActive && !bpOmronActionInFlightRef.current) {
        startOmronBloodPressureListenerForLiveSession({ auto: true }).catch(() => {});
      }
    };
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") refreshAndRearmBloodPressure();
    };

    if (isOmronAutoListenEnabled()) {
      window.setTimeout(refreshAndRearmBloodPressure, 500);
    }
    document.addEventListener("visibilitychange", onVisibilityChange);
    import("@capacitor/app")
      .then(({ App: CapacitorApp }) => CapacitorApp?.addListener?.("appStateChange", ({ isActive } = {}) => {
        if (isActive) refreshAndRearmBloodPressure();
      }))
      .then((handle) => {
        appStateHandle = handle;
      })
      .catch(() => {});

    return () => {
      mounted = false;
      document.removeEventListener("visibilitychange", onVisibilityChange);
      appStateHandle?.remove?.();
    };
  }, [
    bpOmronListening,
    liveSession?.activeSessionId,
    startOmronBloodPressureListenerForLiveSession,
    syncBloodPressureForLiveSession,
  ]);

  const liveCuePhraseBank = useMemo(
    () => resolveLiveCuePhraseBank(liveCueSettings, { captureKind }),
    [captureKind, liveCueSettings],
  );
  const liveCueAudio = useLiveCueAudio({
    phrases: liveCuePhraseBank.phrases,
    settings: liveCuePhraseBank.settings,
    enabled: liveCueSettings.enabled,
  });
  const liveCueEngine = useLiveCueEngine({
    captureKind,
    cueSettings: liveCueSettings,
    audio: liveCueAudio,
    sessionId: liveSession?.activeSessionId,
    getSessionTime: getCurrentSessionTime,
    microphoneActive: annotationRecording,
    onTimelineEvent: (event) => {
      const finalEvent = {
        id: `live-cue-${event.type}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
        source: "sarah_live_cue",
        label: event.label,
        note: event.label,
        time_s: event.time_s,
        category: event.type,
        metadata: event.metadata,
      };
      appendLiveSessionEvents(finalEvent).catch(() => {});
    },
  });

  const toggleLiveEncouragement = useCallback(async () => {
    if (liveCueSettings.enabled) {
      liveCueAudio.stop();
      liveCueEngine.reset();
      setLiveCueSettings((previous) => ({ ...previous, enabled: false }));
      return;
    }
    try {
      await liveCueAudio.unlock();
      setLiveCueSettings((previous) => ({ ...previous, enabled: true }));
    } catch (error) {
      toast({
        title: "Sarah encouragement could not start",
        description: error?.message || "Audio playback is unavailable in this browser context.",
        variant: "destructive",
      });
    }
  }, [liveCueAudio, liveCueEngine, liveCueSettings.enabled, toast]);

  useEffect(() => {
    if (!recordingActive || !liveCueSettings.enabled || liveCueAudio.ready || liveCueAudio.status.phase === "preparing") return;
    liveCueAudio.prepare().catch((error) => {
      toast({
        title: "Sarah encouragement is unavailable",
        description: error?.message || "The encouragement clips could not be prepared.",
        variant: "destructive",
      });
    });
  }, [liveCueAudio, liveCueSettings.enabled, recordingActive, toast]);

  const waitForRecentHrPacket = useCallback((timeoutMs = 25000) => new Promise((resolve) => {
    const started = Date.now();
    const timer = window.setInterval(() => {
      if (hasRecentHrPacket()) {
        window.clearInterval(timer);
        resolve(true);
      } else if (Date.now() - started >= timeoutMs) {
        window.clearInterval(timer);
        resolve(false);
      }
    }, 350);
  }), [hasRecentHrPacket]);

  const setLaunchStep = useCallback((label, state = "active") => {
    setLaunchState((prev) => {
      const labels = ["Restoring setup", "Preparing voice", "Connecting H10", "Waiting for heart rate", "Checking OBS", "Starting session", "Live"];
      const currentIndex = labels.indexOf(label);
      return {
        ...prev,
        phase: state === "done" && label === "Live" ? "live" : label,
        message: label,
        steps: labels.map((item, index) => ({
          label: item,
          active: item === label && state !== "done",
          done: currentIndex >= 0 && index < currentIndex || (item === label && state === "done"),
        })),
      };
    });
  }, []);

  const saveSuccessfulLaunchProfile = useCallback((sessionState) => {
    const next = saveLiveCaptureLaunchProfile(buildLaunchProfileFromRuntime({
      captureKind,
      captureMode,
      hrSourceSettings,
      emgSensorConfig,
      telemetryNoticesEnabled,
      heartbeatAudioEnabled,
      howlControlForm,
      mediaVideo,
      cueSettings: liveCueSettings,
      liveSession: sessionState || liveSession,
    }));
    setLaunchProfile(next);
  }, [captureKind, captureMode, emgSensorConfig, heartbeatAudioEnabled, howlControlForm, hrSourceSettings, liveCueSettings, liveSession, mediaVideo, telemetryNoticesEnabled]);

  const startFromLaunchpad = useCallback(async ({ allowWithoutVoice = false } = {}) => {
    if (launchInFlightRef.current) return launchInFlightRef.current;
    const transaction = (async () => {
      setLaunchState({ phase: "starting", message: "Starting session...", steps: [], busy: true, error: "" });
      try {
        setLaunchStep("Restoring setup");
        writeHrSourceSettings(hrSourceSettings);
        await applyHrSourceSettings(hrSourceSettings);

        setLaunchStep("Preparing voice");
        let voiceReadyForLaunch = false;
        if (liveCueSettings.enabled) {
          try {
            await liveCueAudio.unlock();
            const prepared = await liveCueAudio.prepare();
            voiceReadyForLaunch = Boolean(prepared?.ok);
          } catch (error) {
            if (!allowWithoutVoice) {
              throw new Error(`${error?.message || "Sarah voice cues could not be prepared."} You can start without voice cues from advanced setup.`);
            }
          }
        }

        const directH10Launch = hrSourceSettings.source === "direct_h10";
        if (directH10Launch && !hasRecentHrPacket()) {
          const currentH10 = directH10StatusRef.current || {};
          setLaunchStep("Connecting H10");
          if (!currentH10.connected && !currentH10.connecting) {
            await connectDirectH10({ launch: true });
          }
        }

        setLaunchStep("Waiting for heart rate");
        let receivedHr = await waitForRecentHrPacket(directH10Launch ? 60000 : 25000);
        if (!receivedHr && directH10Launch) {
          const currentH10 = directH10StatusRef.current || {};
          if (!currentH10.connected && !currentH10.connecting) {
            setLaunchStep("Connecting H10");
            await connectDirectH10({ autoReconnect: true, launch: true });
            setLaunchStep("Waiting for heart rate");
            receivedHr = await waitForRecentHrPacket(45000);
          }
        }
        if (!receivedHr) {
          throw new Error(directH10Launch
            ? "H10 is selected, but Sarah has not received the first heart-rate packet yet. Wake the strap, then tap Retry failed step."
            : "H10/source is connected or configured, but no recent heart-rate packet has arrived.");
        }

        setLaunchStep("Checking OBS");
        if (launchProfile.obsEnabled && !obsReady && !launchProfile.telemetryOnlyFallback) {
          throw new Error("OBS is unavailable. Reconnect OBS or enable telemetry-only fallback.");
        }

        setLaunchStep("Starting session");
        const sessionState = liveSession?.activeSessionId ? liveSession : await ensureSession();
        if (!sessionState?.activeSessionId) throw new Error("Sarah could not create or reuse the live session shell.");

        saveSuccessfulLaunchProfile(sessionState);
        setLaunchStep("Live", "done");
        setLaunchState((prev) => ({
          ...prev,
          phase: "live",
          busy: false,
          error: "",
          message: voiceReadyForLaunch || !liveCueSettings.enabled ? "Session live." : "Session live without voice cues.",
        }));
        return sessionState;
      } catch (error) {
        setLaunchState((prev) => ({
          ...prev,
          busy: false,
          error: error?.message || String(error),
          message: error?.message || "Launch failed.",
        }));
        throw error;
      } finally {
        launchInFlightRef.current = null;
      }
    })();
    launchInFlightRef.current = transaction;
    return transaction;
  }, [
    applyHrSourceSettings,
    connectDirectH10,
    ensureSession,
    hasRecentHrPacket,
    hrSourceSettings,
    launchProfile.obsEnabled,
    launchProfile.telemetryOnlyFallback,
    liveCueAudio,
    liveCueSettings.enabled,
    liveSession,
    obsReady,
    saveSuccessfulLaunchProfile,
    setLaunchStep,
    waitForRecentHrPacket,
  ]);

  const queuePerinealSessionEvents = useCallback((eventsToAdd, extraPatch = {}) => {
    perinealSaveQueueRef.current = perinealSaveQueueRef.current
      .catch(() => {})
      .then(() => appendLiveSessionEvents(eventsToAdd, extraPatch))
      .catch((err) => {
        setCalibrationError(err?.message || "Unable to save perineal EMG timeline event.");
      });
  }, [appendLiveSessionEvents]);

  const perinealTimelineEventFromDetection = useCallback((event) => {
    const timeS = Math.max(0, Math.round(Number(event.peak_time_s ?? event.start_time_s ?? getCurrentSessionTime()) || 0));
    return {
      id: `perineal_emg_${event.event_type}_${Math.round(Number(event.start_time_s || 0) * 10)}_${Math.round(Number(event.peak_time_s || 0) * 10)}`,
      time_s: timeS,
      note: perinealEventNote(event),
      category: ["physical"],
      annotation_tags: ["emg", "perineal_emg", "pelvic_floor", event.contraction_type, event.confidence].filter(Boolean),
      source: "perineal_emg",
      created_at: new Date().toISOString(),
      perineal_emg: event,
      ai_annotation: {
        source: "perineal_emg_detector",
        rationale: "Automatically detected from calibrated perineal-body EMG signal.",
      },
    };
  }, [getCurrentSessionTime]);

  const perinealProtocolAnchorEvent = useCallback((phase, boundary, timeS = getCurrentSessionTime()) => ({
    id: `perineal_protocol_${phase.key}_${boundary}_${Math.round(Number(timeS || 0) * 10)}`,
    time_s: Math.max(0, Math.round(Number(timeS) || 0)),
    note: `Perineal EMG test ${boundary}: ${phase.label}`,
    category: ["other"],
    annotation_tags: ["emg", "perineal_emg", "calibration", "test_protocol", phase.key, boundary],
    source: "perineal_emg_protocol",
    created_at: new Date().toISOString(),
    perineal_emg_protocol: {
      phase_key: phase.key,
      phase_label: phase.label,
      boundary,
      instruction: phase.instruction,
      duration_s: phase.durationS,
    },
  }), [getCurrentSessionTime]);

  useEffect(() => {
    if (!usingPerinealEmgConfig || !recordingActive || !emgTelemetry) return;
    const pct = readNumber(emgTelemetry.level_pct, emgTelemetry.left_pct);
    if (pct == null) return;
    const timeS = getCurrentSessionTime();
    const signature = [
      emgTelemetry.source_at || status?.emg?.lastSourceAt || "",
      timeS,
      Math.round(Number(pct) * 10),
    ].join(":");
    if (lastPerinealSampleSignatureRef.current === signature) return;
    lastPerinealSampleSignatureRef.current = signature;

    const sample = {
      time_s: timeS,
      pct,
      source_at: emgTelemetry.source_at || null,
    };
    const protocolState = perinealProtocolRef.current;
    if (protocolState?.running) {
      const phase = PERINEAL_EMG_PROTOCOL_PHASES[protocolState.phaseIndex];
      if (phase?.captureKey) {
        const captures = {
          ...(protocolState.captures || {}),
          [phase.captureKey]: [
            ...((protocolState.captures || {})[phase.captureKey] || []),
            sample,
          ],
        };
        const nextProtocol = { ...protocolState, captures };
        perinealProtocolRef.current = nextProtocol;
        setPerinealProtocol(nextProtocol);
      }
    }

    const result = processPerinealEmgSample(perinealDetectorRef.current, sample, {
      calibration: perinealCalibration,
    });
    perinealDetectorRef.current = result.detector;
    setPerinealDetectorSnapshot({
      ...result.detector,
      counts: { ...result.detector.counts },
      current: result.detector.current ? { ...result.detector.current, samples: [] } : null,
    });
    if (result.event) {
      queuePerinealSessionEvents(perinealTimelineEventFromDetection(result.event));
    }
  }, [
    emgTelemetry,
    getCurrentSessionTime,
    perinealCalibration,
    perinealTimelineEventFromDetection,
    queuePerinealSessionEvents,
    recordingActive,
    status?.emg?.lastSourceAt,
    usingPerinealEmgConfig,
  ]);

  const startPerinealProtocol = useCallback(async () => {
    if (!usingPerinealEmgConfig) {
      setCalibrationError("Select Perineal Body EMG before starting the pelvic-floor test protocol.");
      return;
    }
    if (!emgRecent) {
      setCalibrationError("Start the EMG feed first. Sarah needs a recent perineal EMG signal before the protocol can run.");
      return;
    }
    await ensureSession();
    const firstPhase = PERINEAL_EMG_PROTOCOL_PHASES[0];
    const nowMs = Date.now();
    const timeS = getCurrentSessionTime();
    const nextProtocol = {
      running: true,
      phaseIndex: 0,
      phaseStartedAtMs: nowMs,
      phaseEndsAtMs: nowMs + firstPhase.durationS * 1000,
      captures: {},
      message: firstPhase.instruction,
      startedAt: new Date().toISOString(),
    };
    perinealProtocolRef.current = nextProtocol;
    setPerinealProtocol(nextProtocol);
    setCalibrationStatus(`Perineal EMG test started: ${firstPhase.label}.`);
    setCalibrationError("");
    queuePerinealSessionEvents(perinealProtocolAnchorEvent(firstPhase, "start", timeS));
  }, [emgRecent, ensureSession, getCurrentSessionTime, perinealProtocolAnchorEvent, queuePerinealSessionEvents, usingPerinealEmgConfig]);

  const stopPerinealProtocol = useCallback(() => {
    const protocolState = perinealProtocolRef.current;
    const phase = PERINEAL_EMG_PROTOCOL_PHASES[protocolState?.phaseIndex];
    if (protocolState?.running && phase) {
      queuePerinealSessionEvents(perinealProtocolAnchorEvent(phase, "stopped", getCurrentSessionTime()));
    }
    const nextProtocol = {
      running: false,
      phaseIndex: -1,
      phaseStartedAtMs: null,
      phaseEndsAtMs: null,
      captures: protocolState?.captures || {},
      message: "Stopped",
    };
    perinealProtocolRef.current = nextProtocol;
    setPerinealProtocol(nextProtocol);
    setCalibrationStatus("Perineal EMG test protocol stopped.");
  }, [getCurrentSessionTime, perinealProtocolAnchorEvent, queuePerinealSessionEvents]);

  useEffect(() => {
    if (!perinealProtocol.running) return undefined;
    const timer = setInterval(() => {
      const protocolState = perinealProtocolRef.current;
      if (!protocolState?.running) return;
      const phase = PERINEAL_EMG_PROTOCOL_PHASES[protocolState.phaseIndex];
      if (!phase || Date.now() < Number(protocolState.phaseEndsAtMs || 0)) return;
      const timeS = getCurrentSessionTime();
      const endEvent = perinealProtocolAnchorEvent(phase, "end", timeS);
      const nextIndex = protocolState.phaseIndex + 1;
      const nextPhase = PERINEAL_EMG_PROTOCOL_PHASES[nextIndex];
      if (!nextPhase) {
        const calibration = buildPerinealEmgCalibration({
          baseline: protocolState.captures?.baseline || [],
          light: protocolState.captures?.light || [],
          strong: protocolState.captures?.strong || [],
          hold: protocolState.captures?.hold || [],
          artifacts: {
            cough: protocolState.captures?.cough || [],
            glute: protocolState.captures?.glute || [],
            adductor: protocolState.captures?.adductor || [],
          },
        });
        const completedEvent = {
          id: `perineal_protocol_completed_${Math.round(Number(timeS || 0) * 10)}`,
          time_s: Math.max(0, Math.round(Number(timeS) || 0)),
          note: "Perineal EMG test protocol completed",
          category: ["other"],
          annotation_tags: ["emg", "perineal_emg", "calibration", "test_protocol", "completed"],
          source: "perineal_emg_protocol",
          created_at: new Date().toISOString(),
          perineal_emg_protocol: {
            completed: true,
            calibration_id: calibration.id,
            baseline_sample_count: calibration.baseline_sample_count,
            detection_threshold_pct: calibration.suggested_detection_threshold_pct,
            strong_threshold_pct: calibration.suggested_strong_threshold_pct,
          },
        };
        const calibrationLine = `[${fmtMmSs(timeS)}] Perineal EMG protocol completed. Baseline ${fmtNumber(calibration.baseline_mean_pct)}% +/- ${fmtNumber(calibration.baseline_std_pct)}%; detection threshold ${fmtNumber(calibration.suggested_detection_threshold_pct)}%; strong threshold ${fmtNumber(calibration.suggested_strong_threshold_pct)}%.`;
        queuePerinealSessionEvents([endEvent, completedEvent], {
          emg_enabled: true,
          emg_target_area: "Perineal body / pelvic floor",
          emg_sensor_type: "Small surface EMG electrodes (perineal body)",
          emg_channels: "single",
          emg_perineal_calibration: calibration,
          emg_rest_left: calibration.baseline_mean_pct,
          emg_max_left: calibration.strong_median_peak_pct ?? calibration.suggested_strong_threshold_pct,
          emg_calibration_notes: [activeSessionDoc?.emg_calibration_notes, calibrationLine].filter(Boolean).join("\n"),
        });
        const detector = createPerinealEmgDetector({ calibration });
        perinealDetectorRef.current = detector;
        setPerinealDetectorSnapshot({ ...detector, counts: { ...detector.counts } });
        const doneProtocol = {
          running: false,
          phaseIndex: -1,
          phaseStartedAtMs: null,
          phaseEndsAtMs: null,
          captures: protocolState.captures || {},
          message: "Completed",
          completedAt: new Date().toISOString(),
        };
        perinealProtocolRef.current = doneProtocol;
        setPerinealProtocol(doneProtocol);
        setCalibrationStatus("Perineal EMG test protocol completed and calibration values queued for saving.");
        return;
      }
      const nowMs = Date.now();
      const nextProtocol = {
        ...protocolState,
        phaseIndex: nextIndex,
        phaseStartedAtMs: nowMs,
        phaseEndsAtMs: nowMs + nextPhase.durationS * 1000,
        message: nextPhase.instruction,
      };
      perinealProtocolRef.current = nextProtocol;
      setPerinealProtocol(nextProtocol);
      setCalibrationStatus(`Perineal EMG test: ${nextPhase.label}.`);
      queuePerinealSessionEvents([
        endEvent,
        perinealProtocolAnchorEvent(nextPhase, "start", timeS),
      ]);
    }, 500);
    return () => clearInterval(timer);
  }, [
    activeSessionDoc?.emg_calibration_notes,
    getCurrentSessionTime,
    perinealProtocol.running,
    perinealProtocolAnchorEvent,
    queuePerinealSessionEvents,
  ]);

  useEffect(() => {
    if (captureIsBodyExploration || !recordingActive || !telemetryHistory.length) return;
    const strongLabel = prediction.nearClimax >= 75 && prediction.buildEligibleForNearClimax && prediction.confirmationCount >= 2
      ? "Near-climax possibility"
      : prediction.recovery >= 70
        ? "Recovery watch"
        : Number(buildLevel) >= 55 && prediction.recentSlope > 0
          ? "Sustained build observed"
        : prediction.nearClimax >= 45 && (prediction.elapsedMinutes >= 5 || prediction.buildDurationSec >= 60)
          ? "Build intensifying"
          : prediction.nearClimax >= 35
            ? "Arousal/build signal rising"
          : "";
    if (!strongLabel) return;
    const now = Date.now();
    if (lastPhaseMarkerRef.current.label === strongLabel && now - lastPhaseMarkerRef.current.ts < 30000) return;
    lastPhaseMarkerRef.current = { label: strongLabel, ts: now };
    const lastPoint = telemetryHistory[telemetryHistory.length - 1];
    setPhaseMarkers((prev) => [
      ...prev,
      {
        time_s: getCurrentSessionTime(),
        chartTime: lastPoint.time,
        label: strongLabel,
        confidence: strongLabel.includes("Recovery") ? prediction.recovery : prediction.nearClimax,
        reason: prediction.reason || strongLabel,
      },
    ].slice(-20));
  }, [buildLevel, captureIsBodyExploration, getCurrentSessionTime, prediction, recordingActive, telemetryHistory]);

  useEffect(() => {
    if (!recordingActive || !telemetryHistory.length || !hrTelemetry) return;
    liveCueEngine.step(prediction, {
      hr: readNumber(hrTelemetry?.currentHr, hrTelemetry?.hr, hrTelemetry?.heartRate),
      baselineHr: readNumber(hrTelemetry?.baselineHr, hrTelemetry?.baseline_hr),
      recentSlope: prediction.recentSlope,
      emgContribution: readNumber(emgTelemetry?.left_pct, emgTelemetry?.level_pct) != null ? 1 : 0,
      hasMultipleSignalFamilies: Boolean(prediction.hrvUsable || emgTelemetry),
      sessionTimeSec: getCurrentSessionTime(),
    });
  }, [emgTelemetry, getCurrentSessionTime, hrTelemetry, liveCueEngine, prediction, recordingActive, telemetryHistory.length]);

  useEffect(() => {
    const cue = liveCueEngine.latestCue;
    if (!cue) return;
    setLatestTelemetryNotice(toLiveTelemetryNotice(cue));
  }, [liveCueEngine.latestCue]);

  useEffect(() => {
    if (recordingActive) return;
    setLatestTelemetryNotice(null);
    lastPhaseMarkerRef.current = { label: "", ts: 0 };
    liveCueEngine.reset();
  }, [liveCueEngine.reset, recordingActive]);

  const getAudioContext = useCallback(async () => {
    if (!audioContextRef.current || audioContextRef.current.state === "closed") {
      const AudioCtor = window.AudioContext || window.webkitAudioContext;
      if (!AudioCtor) return null;
      audioContextRef.current = new AudioCtor();
    }
    if (audioContextRef.current.state === "suspended") {
      await audioContextRef.current.resume();
    }
    return audioContextRef.current;
  }, []);

  const playVoiceFeedback = useCallback(async (type) => {
    try {
      const ctx = await getAudioContext();
      if (!ctx) return;
      if (type === "start") playToneSequence(ctx, [660, 880]);
      else if (type === "stop") playToneSequence(ctx, [520, 330]);
      else if (type === "wake") playToneSequence(ctx, [740, 988, 1175]);
    } catch {}
  }, [getAudioContext]);

  const appendVoiceAnnotation = useCallback(async (text, timeS) => {
    const clean = normalizeVoiceAnnotationText(text);
    if (!clean) return;
    const sessionState = liveSession?.activeSessionId ? liveSession : await ensureSession();
    const sessionId = sessionState?.activeSessionId;
    if (!sessionId) throw new Error("No active live session is available for the annotation.");
    const rows = await liveRecordApi.filter({ id: sessionId });
    const session = rows[0] || {};
    const nextEvent = {
      time_s: Math.max(0, Math.round(Number(timeS) || 0)),
      note: clean,
      category: categorizeVoiceNote(clean),
      annotation_tags: tagVoiceNote(clean),
      ai_annotation: {
        source: "live-voice-local",
        rationale: "Live voice annotation tagged locally for immediate review.",
      },
      source: "live_voice_annotation",
      created_at: new Date().toISOString(),
      hr_bpm: readNumber(latestHrRef.current?.currentHr, latestHrRef.current?.hr),
    };
    const updated = [...(session.event_timeline || []), nextEvent].sort((a, b) => Number(a.time_s || 0) - Number(b.time_s || 0));
    await liveRecordApi.update(sessionId, { event_timeline: updated });
    setLiveEvents(updated);
    setActiveSessionDoc((prev) => (prev ? { ...prev, event_timeline: updated } : prev));
    setLastVoiceNote(`[${Math.floor(nextEvent.time_s / 60)}:${String(nextEvent.time_s % 60).padStart(2, "0")}] ${clean}`);
  }, [ensureSession, liveRecordApi, liveSession]);

  const updateActiveSession = useCallback(async (patch) => {
    const sessionState = liveSession?.activeSessionId ? liveSession : await ensureSession();
    const sessionId = sessionState?.activeSessionId;
    if (!sessionId) throw new Error("No active live session is available.");
    await liveRecordApi.update(sessionId, patch);
    setActiveSessionDoc((prev) => (prev ? { ...prev, ...patch } : prev));
    return sessionId;
  }, [ensureSession, liveRecordApi, liveSession]);

  const applyEmgSensorConfig = useCallback(async (config) => {
    if (!config) return;
    setEmgSensorConfig(config.value);
    setCalibrationStatus("");
    setCalibrationError("");
    if (!config.placementPatch || !Object.keys(config.placementPatch).length) {
      return;
    }
    try {
      const sessionId = await updateActiveSession(config.placementPatch);
      setCalibrationStatus(`${config.label} configuration saved to this live session.`);
      setLiveSession((prev) => prev ? { ...prev, activeSessionId: sessionId } : prev);
    } catch (err) {
      setCalibrationError(err?.message || "Unable to save the EMG sensor configuration to this session.");
    }
  }, [updateActiveSession]);

  const handleFootTrackingSnapshot = useCallback(async (summary) => {
    if (!summary || !liveSession?.activeSessionId) return;
    const patch = {
      live_foot_tracking: summary,
      live_foot_tracking_updated_at: summary.updated_at || new Date().toISOString(),
    };
    try {
      await liveRecordApi.update(liveSession.activeSessionId, patch);
      setActiveSessionDoc((prev) => (prev ? { ...prev, ...patch } : prev));
    } catch (err) {
      console.warn("Unable to save live foot tracking summary", err);
    }
  }, [liveRecordApi, liveSession?.activeSessionId]);

  const captureEmgCalibrationReference = useCallback(async (step) => {
    const reading = summarizeEmgCalibrationReading(telemetryHistory, latestEmgRef.current);
    if (!reading.left && !reading.right) {
      setCalibrationError("No recent EMG signal is available. Start the EMG feed, then capture this reference again.");
      return;
    }
    setCalibrationSaving(step.key);
    setCalibrationStatus("");
    setCalibrationError("");
    try {
      const sessionState = liveSession?.activeSessionId ? liveSession : await ensureSession();
      const sessionId = sessionState?.activeSessionId;
      if (!sessionId) throw new Error("No active live session is available for calibration.");
      const commandResponse = await fetch(apiUrl("/live-capture/emg/calibration-command"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: EMG_CALIBRATION_ACTIONS[step.key], save: true }),
      });
      const commandStatus = await commandResponse.json();
      if (!commandResponse.ok) throw new Error(commandStatus?.error || "Unable to send calibration command to the EMG helper.");
      pendingCalibrationCommandRef.current = commandStatus.id;
      setCalibrationCommandStatus(commandStatus);
      const rows = await liveRecordApi.filter({ id: sessionId });
      const session = rows[0] || {};
      const timeS = getCurrentSessionTime();
      const leftText = reading.left ? `left ${reading.left.value}%` : "left unavailable";
      const rightText = reading.right ? `right ${reading.right.value}%` : "right unavailable";
      const note = `EMG calibration command requested: ${step.label.toLowerCase()} (${leftText}, ${rightText} on the live display). Intentional calibration maneuver; exclude this window from spontaneous response interpretation.`;
      const nextEvent = {
        time_s: timeS,
        note,
        category: ["other"],
        annotation_tags: ["calibration", "emg_calibration", "context", "exclude_from_response_interpretation"],
        source: "emg_calibration",
        created_at: new Date().toISOString(),
        emg_calibration: {
          step: step.key,
          label: step.label,
          left_pct: reading.left?.value ?? null,
          right_pct: reading.right?.value ?? null,
          diff_pct: reading.diff,
          sample_count: reading.sampleCount,
          left_spread_pct: reading.left?.spread ?? null,
          right_spread_pct: reading.right?.spread ?? null,
          command_id: commandStatus.id,
          backend_action: EMG_CALIBRATION_ACTIONS[step.key],
          status: "requested",
        },
      };
      const calibrationLine = `[${fmtMmSs(timeS)}] Requested ${step.label} calibration in the active EMG helper (${leftText}, ${rightText} on the live display; ${reading.sampleCount} recent normalized sample${reading.sampleCount === 1 ? "" : "s"}). Intentional calibration maneuver; exclude from spontaneous physiological response interpretation.`;
      const patch = {
        emg_enabled: true,
        emg_calibration_notes: [session.emg_calibration_notes, calibrationLine].filter(Boolean).join("\n"),
        event_timeline: [...(session.event_timeline || []), nextEvent].sort((a, b) => Number(a.time_s || 0) - Number(b.time_s || 0)),
      };
      if (selectedEmgConfig?.placementPatch && selectedEmgConfig.value !== "generic") {
        Object.entries(selectedEmgConfig.placementPatch).forEach(([key, value]) => {
          if (patch[key] == null && (session[key] == null || session[key] === "")) {
            patch[key] = value;
          }
        });
      }
      if (reading.right) patch.emg_channels = "dual";
      await liveRecordApi.update(sessionId, patch);
      setLiveEvents(patch.event_timeline);
      setActiveSessionDoc((prev) => ({ ...(prev || session), ...patch }));
      setCalibrationStatus(`${step.label} sent at ${fmtMmSs(timeS)}. Waiting for the running EMG helper to confirm it applied the new calibration.`);
    } catch (err) {
      setCalibrationError(err?.message || "Unable to save EMG calibration reference.");
    } finally {
      setCalibrationSaving("");
    }
  }, [ensureSession, getCurrentSessionTime, liveRecordApi, liveSession, selectedEmgConfig, telemetryHistory]);

  const undoLastVoiceAnnotation = useCallback(async () => {
    const sessionId = liveSession?.activeSessionId;
    if (!sessionId) return;
    const rows = await liveRecordApi.filter({ id: sessionId });
    const session = rows[0] || {};
    const events = [...(session.event_timeline || [])].sort((a, b) => Number(a.time_s || 0) - Number(b.time_s || 0));
    const idx = [...events].reverse().findIndex((event) => event.source === "live_voice_annotation");
    if (idx === -1) {
      setVoiceStatus("No live voice annotation to undo.");
      return;
    }
    const removeIndex = events.length - 1 - idx;
    const removed = events[removeIndex];
    const updated = events.filter((_event, index) => index !== removeIndex);
    await liveRecordApi.update(sessionId, { event_timeline: updated });
    setLiveEvents(updated);
    setActiveSessionDoc((prev) => (prev ? { ...prev, event_timeline: updated } : prev));
    setVoiceStatus(`Removed last voice note at ${fmtMmSs(removed.time_s)}.`);
  }, [liveRecordApi, liveSession?.activeSessionId]);

  const captureLiveMoment = useCallback(() => ({
    timeS: getCurrentSessionTime(),
    chartTime: telemetryHistory[telemetryHistory.length - 1]?.time,
    createdAt: new Date().toISOString(),
    hrBpm: readNumber(latestHrRef.current?.currentHr, latestHrRef.current?.hr),
  }), [getCurrentSessionTime, telemetryHistory]);

  const recordQuickLiveEvent = useCallback(async (command) => {
    if (!command) return false;
    const moment = captureLiveMoment();
    const event = {
      id: `livepad_${command.key || "event"}_${moment.timeS}_${Math.random().toString(36).slice(2, 7)}`,
      time_s: moment.timeS,
      note: typeof command.note === "function" ? command.note(moment) : command.note,
      label: command.label,
      category: Array.isArray(command.category) ? command.category : [command.category || "other"],
      annotation_tags: command.annotationTags || ["quick_pad"],
      source: command.source || "live_quick_pad",
      created_at: moment.createdAt,
      hr_bpm: moment.hrBpm ?? null,
    };
    await appendLiveSessionEvents(event);
    if (command.phaseKey && !captureIsBodyExploration) {
      await updateActiveSession({ [command.phaseKey]: moment.timeS });
      setPhaseMarkers((prev) => [
        ...prev,
        {
          time_s: moment.timeS,
          chartTime: moment.chartTime,
          label: command.phaseLabel || command.label,
          kind: command.phaseKey,
          confidence: 100,
          reason: "Marked by quick pad",
        },
      ].slice(-20));
    }
    setVoiceStatus(`${command.label} marked at ${fmtMmSs(moment.timeS)}.`);
    return true;
  }, [appendLiveSessionEvents, captureIsBodyExploration, captureLiveMoment, updateActiveSession]);

  const applyLiveCommand = useCallback(async (command) => {
    if (!command) return false;
    if (command.type === "stop_listening") {
      setVoiceWakeEnabled(false);
      setVoiceStatus("Wake listening paused.");
      return true;
    }
    if (command.type === "undo_last") {
      await undoLastVoiceAnnotation();
      return true;
    }
    if (command.type === "quick_event") {
      await recordQuickLiveEvent(command);
      return true;
    }
    if (command.type === "mark_phase") {
      if (captureIsBodyExploration) {
        setVoiceStatus("Body Exploration mode is active; climax phase marks are disabled.");
        return false;
      }
      const { timeS, chartTime } = captureLiveMoment();
      await updateActiveSession({ [command.key]: timeS });
      setPhaseMarkers((prev) => [...prev, { time_s: timeS, chartTime, label: command.label, kind: command.key, confidence: 100, reason: "Marked by voice command" }].slice(-20));
      setVoiceStatus(`${command.label} marked at ${fmtMmSs(timeS)}.`);
      return true;
    }
    return false;
  }, [captureIsBodyExploration, captureLiveMoment, recordQuickLiveEvent, undoLastVoiceAnnotation, updateActiveSession]);

  useEffect(() => {
    applyLiveCommandRef.current = applyLiveCommand;
  }, [applyLiveCommand]);

  const stopWakeListening = useCallback(() => {
    clearTimeout(wakeRestartTimerRef.current);
    wakeRestartTimerRef.current = null;
    if (desktopWakeFallbackActive) {
      try { window.sarahDesktop?.stopVoiceWake?.(); } catch {}
    }
    const recognition = recognitionRef.current;
    recognitionRef.current = null;
    if (recognition) {
      recognition.onstart = null;
      recognition.onerror = null;
      recognition.onresult = null;
      recognition.onend = null;
      try { recognition.stop(); } catch {}
    }
    setWakeListening(false);
  }, [desktopWakeFallbackActive]);

  const handleWakeTranscript = useCallback(async (heard) => {
    const normalized = String(heard || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
    if (!normalized) return false;
    if (isEndListeningCommand(normalized)) {
      desktopWakeHoldoffUntilRef.current = Date.now() + 1500;
      setVoiceWakeEnabled(false);
      setVoiceStatus("Wake listening stopped.");
      playVoiceFeedback("stop");
      stopWakeListening();
      return true;
    }
    const howlVoiceCommand = parseHowlVoiceCommand(heard, { ceiling: howlControlCeiling });
    if (howlVoiceCommand) {
      desktopWakeHoldoffUntilRef.current = Date.now() + 1500;
      stopWakeListening();
      await runHowlVoiceCommand(howlVoiceCommand);
      return true;
    }
    const command = parseLiveCommand(normalized);
    if (command) {
      desktopWakeHoldoffUntilRef.current = Date.now() + 1500;
      stopWakeListening();
      await applyLiveCommandRef.current?.(command);
      return true;
    }
    if (/\bsarah\b/.test(normalized)) {
      desktopWakeHoldoffUntilRef.current = Date.now() + 2500;
      setVoiceStatus("Wake phrase heard. Recording annotation…");
      playVoiceFeedback("wake");
      stopWakeListening();
      window.setTimeout(() => {
        if (voiceWakeEnabledRef.current && !annotationRecordingRef.current) {
          startVoiceAnnotationRef.current?.();
        }
      }, 120);
      return true;
    }
    return false;
  }, [howlControlCeiling, playVoiceFeedback, runHowlVoiceCommand, stopWakeListening]);

  const stopVoiceAnnotation = useCallback(() => {
    clearTimeout(voiceNoteTimeoutRef.current);
    voiceNoteTimeoutRef.current = null;
    if (voiceSilenceRafRef.current) {
      cancelAnimationFrame(voiceSilenceRafRef.current);
      voiceSilenceRafRef.current = null;
    }
    voiceSilenceStartedRef.current = null;
    try { voiceAudioSourceRef.current?.disconnect(); } catch {}
    voiceAudioSourceRef.current = null;
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== "inactive") {
      recorder.stop();
    }
  }, []);

  const startWakeListening = useCallback(async () => {
    if (!voiceWakeEnabledRef.current || annotationRecordingRef.current || !voiceWakeSupported) return;
    stopWakeListening();
    if (desktopWakeFallbackActive) {
      try {
        const result = await window.sarahDesktop.startVoiceWake();
        if (!result?.ok) throw new Error(result?.error || "Windows wake listening could not start.");
        setWakeListening(true);
        setVoiceStatus("Listening for “Sarah”… say “end” to stop.");
        setVoiceError("");
      } catch (error) {
        setVoiceWakeEnabled(false);
        voiceWakeEnabledRef.current = false;
        setWakeListening(false);
        setVoiceError(error?.message || "Wake phrase could not start here. Use Record Now for timestamped voice notes.");
        setVoiceStatus("Wake phrase paused. Record Now still works for timestamped voice notes.");
      }
      return;
    }
    const Recognition = window.SpeechRecognition || window.webkitSpeechRecognition;
    const recognition = new Recognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = "en-US";
    recognition.onstart = () => {
      setWakeListening(true);
      setVoiceStatus("Listening for “Sarah”… say “end” to stop.");
      setVoiceError("");
    };
    recognition.onerror = (event) => {
      const errorCode = event?.error || "";
      const transient = event?.error === "no-speech" || event?.error === "aborted";
      const terminal = TERMINAL_WAKE_LISTENER_ERRORS.has(errorCode);
      if (terminal) {
        voiceWakeEnabledRef.current = false;
        setVoiceWakeEnabled(false);
        clearTimeout(wakeRestartTimerRef.current);
        wakeRestartTimerRef.current = null;
      }
      if (terminal || !voiceWakeEnabledRef.current || annotationRecordingRef.current) {
        setWakeListening(false);
      }
      if (!transient) {
        setVoiceError(wakeListenerErrorMessage(errorCode));
        if (terminal) {
          setVoiceStatus("Wake phrase paused. Record Now still works for timestamped voice notes.");
        }
      }
    };
    recognition.onresult = (event) => {
      let heard = "";
      let hasFinal = false;
      for (let i = event.resultIndex; i < event.results.length; i += 1) {
        heard += event.results[i][0]?.transcript || "";
        if (event.results[i].isFinal) hasFinal = true;
      }
      if (!hasFinal) return;
      handleWakeTranscript(heard).catch((error) => setVoiceError(error.message || String(error)));
    };
    recognition.onend = () => {
      const shouldRestart = voiceWakeEnabledRef.current && !annotationRecordingRef.current;
      if (shouldRestart) {
        setWakeListening(true);
        wakeRestartTimerRef.current = window.setTimeout(startWakeListening, 900);
      } else {
        setWakeListening(false);
      }
    };
    recognitionRef.current = recognition;
    try {
      recognition.start();
    } catch {
      setVoiceWakeEnabled(false);
      voiceWakeEnabledRef.current = false;
      setWakeListening(false);
      setVoiceError("Wake phrase could not start here. Use Record Now for timestamped voice notes.");
      setVoiceStatus("Wake phrase paused. Record Now still works for timestamped voice notes.");
    }
  }, [desktopWakeFallbackActive, handleWakeTranscript, stopWakeListening, voiceWakeSupported]);

  useEffect(() => {
    if (typeof window === "undefined" || !window.sarahDesktop?.onVoiceWakeEvent) return undefined;
    return window.sarahDesktop.onVoiceWakeEvent((payload) => {
      if (!payload || (!voiceWakeEnabledRef.current && payload.type !== "error")) return;
      if (payload.type === "ready") {
        setWakeListening(true);
        setVoiceError("");
        setVoiceStatus("Listening for “Sarah”… say “end” to stop.");
        return;
      }
      if (payload.type === "recognized") {
        handleWakeTranscript(payload.transcript || payload.text || "").catch((error) => {
          setVoiceError(error?.message || String(error));
        });
        return;
      }
      if (payload.type === "error") {
        setWakeListening(false);
        setVoiceError(payload.message || "Windows wake listener failed.");
        setVoiceStatus("Wake phrase paused. Record Now still works for timestamped voice notes.");
        if (voiceWakeEnabledRef.current && !annotationRecordingRef.current && Date.now() >= desktopWakeHoldoffUntilRef.current) {
          clearTimeout(wakeRestartTimerRef.current);
          wakeRestartTimerRef.current = window.setTimeout(() => {
            startWakeListening();
          }, 1200);
        }
        return;
      }
      if (payload.type === "stopped") {
        const shouldRestart = voiceWakeEnabledRef.current
          && !annotationRecordingRef.current
          && Date.now() >= desktopWakeHoldoffUntilRef.current;
        if (shouldRestart) {
          setWakeListening(false);
          clearTimeout(wakeRestartTimerRef.current);
          wakeRestartTimerRef.current = window.setTimeout(() => {
            startWakeListening();
          }, 900);
        } else {
          setWakeListening(false);
        }
      }
    });
  }, [handleWakeTranscript, startWakeListening]);

  const startVoiceAnnotation = useCallback(async () => {
    if (!voiceRecordingSupported || annotationRecordingRef.current) return;
    desktopWakeHoldoffUntilRef.current = Date.now() + 2500;
    stopWakeListening();
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = MediaRecorder.isTypeSupported("audio/webm;codecs=opus")
        ? "audio/webm;codecs=opus"
        : MediaRecorder.isTypeSupported("audio/webm") ? "audio/webm" : "audio/ogg";
      const recorder = new MediaRecorder(stream, { mimeType });
      voiceChunksRef.current = [];
      voiceNoteTimeRef.current = getCurrentSessionTime();
      const startedAt = Date.now();
      recorder.ondataavailable = (event) => {
        if (event.data?.size > 0) voiceChunksRef.current.push(event.data);
      };
      recorder.onstop = async () => {
        if (voiceSilenceRafRef.current) {
          cancelAnimationFrame(voiceSilenceRafRef.current);
          voiceSilenceRafRef.current = null;
        }
        voiceSilenceStartedRef.current = null;
        try { voiceAudioSourceRef.current?.disconnect(); } catch {}
        voiceAudioSourceRef.current = null;
        stream.getTracks().forEach((track) => track.stop());
        mediaRecorderRef.current = null;
        setAnnotationRecording(false);
        setVoiceStatus("Transcribing annotation…");
        try {
          const blob = new Blob(voiceChunksRef.current, { type: mimeType });
          voiceChunksRef.current = [];
          const audioBase64 = await blobToBase64(blob);
          const res = await base44.functions.invoke("whisperSTT", {
            audio_base64: audioBase64,
            mime_type: mimeType,
            prompt: WHISPER_PROMPT,
            provider: readSttProviderPreference(),
          });
          const text = normalizeVoiceAnnotationText(res.data?.text);
          if (text) {
            await appendVoiceAnnotation(text, voiceNoteTimeRef.current);
            setVoiceStatus("Annotation saved. Listening for “Sarah”… say “end” to stop.");
          } else {
            setVoiceStatus("No speech detected. Listening for “Sarah”… say “end” to stop.");
          }
        } catch (error) {
          setVoiceError(error.message || String(error));
          setVoiceStatus("Annotation failed. Listening can continue.");
        } finally {
          if (voiceWakeEnabledRef.current) {
            window.setTimeout(startWakeListening, 600);
          }
        }
      };
      mediaRecorderRef.current = recorder;
      setAnnotationRecording(true);
      setVoiceError("");
      setVoiceStatus("Recording annotation… pause briefly after the note to save.");
      recorder.start();

      try {
        const ctx = await getAudioContext();
        if (ctx) {
          const source = ctx.createMediaStreamSource(stream);
          const analyser = ctx.createAnalyser();
          analyser.fftSize = 1024;
          source.connect(analyser);
          voiceAudioSourceRef.current = source;
          const samples = new Uint8Array(analyser.fftSize);
          const monitorSilence = () => {
            if (recorder.state === "inactive") return;
            analyser.getByteTimeDomainData(samples);
            let sum = 0;
            for (let i = 0; i < samples.length; i += 1) {
              const centered = (samples[i] - 128) / 128;
              sum += centered * centered;
            }
            const rms = Math.sqrt(sum / samples.length);
            const now = Date.now();
            const oldEnough = now - startedAt >= VOICE_NOTE_MIN_MS;
            if (oldEnough && rms < VOICE_NOTE_SILENCE_RMS) {
              if (!voiceSilenceStartedRef.current) voiceSilenceStartedRef.current = now;
              if (now - voiceSilenceStartedRef.current >= VOICE_NOTE_SILENCE_MS) {
                stopVoiceAnnotation();
                return;
              }
            } else {
              voiceSilenceStartedRef.current = null;
            }
            voiceSilenceRafRef.current = requestAnimationFrame(monitorSilence);
          };
          voiceSilenceRafRef.current = requestAnimationFrame(monitorSilence);
        }
      } catch {}

      voiceNoteTimeoutRef.current = window.setTimeout(stopVoiceAnnotation, MAX_VOICE_NOTE_MS);
    } catch (error) {
      setVoiceError(error.message || String(error));
      setAnnotationRecording(false);
      if (voiceWakeEnabledRef.current) window.setTimeout(startWakeListening, 600);
    }
  }, [appendVoiceAnnotation, getAudioContext, getCurrentSessionTime, startWakeListening, stopVoiceAnnotation, stopWakeListening, voiceRecordingSupported]);

  useEffect(() => {
    startVoiceAnnotationRef.current = startVoiceAnnotation;
  }, [startVoiceAnnotation]);

  const toggleVoiceWake = useCallback(async () => {
    await getAudioContext();
    if (voiceWakeEnabled) playVoiceFeedback("stop");
    setVoiceError("");
    setVoiceWakeEnabled((value) => !value);
  }, [getAudioContext, playVoiceFeedback, voiceWakeEnabled]);

  const startManualVoiceNote = useCallback(() => {
    startVoiceAnnotation();
  }, [startVoiceAnnotation]);

  useEffect(() => {
    if (voiceWakeEnabled) startWakeListening();
    else {
      stopWakeListening();
      stopVoiceAnnotation();
      setVoiceStatus("Say “Sarah” to start a voice annotation. Say “end” to stop listening.");
    }
    return () => {
      stopWakeListening();
      stopVoiceAnnotation();
      clearTimeout(voiceNoteTimeoutRef.current);
    };
  }, [startWakeListening, stopVoiceAnnotation, stopWakeListening, voiceWakeEnabled]);

  const voiceAnnotationPanel = (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-primary flex items-center gap-1.5">
            <Mic className="h-4 w-4" /> Voice Annotation
          </p>
          <div className="mt-2 flex items-center gap-2 text-sm text-muted-foreground">
            <Mic className={`h-4 w-4 ${annotationRecording || wakeListening ? "text-primary" : "text-muted-foreground"}`} />
            <span>{voiceStatus}</span>
          </div>
          {desktopWakeUnsupported && (
            <p className="mt-1 text-xs text-destructive">Wake phrase listening is not available in the Windows EXE right now. Use Record Now for timestamped notes.</p>
          )}
          {!desktopWakeUnsupported && !speechRecognitionSupported && (
            <p className="mt-1 text-xs text-destructive">Wake phrase listening is not supported in this browser. Use Record Now instead.</p>
          )}
          {!voiceRecordingSupported && (
            <p className="mt-1 text-xs text-destructive">Microphone recording is not available in this browser context.</p>
          )}
          {voiceError && <p className="mt-1 text-xs text-destructive">{voiceError}</p>}
          {lastVoiceNote && <p className="mt-1 text-xs text-muted-foreground">Last saved: {lastVoiceNote}</p>}
        </div>
        <div className="flex flex-wrap gap-2">
          <button
            type="button"
            onClick={async () => {
              await getAudioContext();
              if (voiceWakeEnabled) playVoiceFeedback("stop");
              setVoiceError("");
              setVoiceWakeEnabled((value) => !value);
            }}
            disabled={!voiceReady}
            className={`inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition-colors disabled:opacity-50 ${
              voiceWakeEnabled ? "bg-primary text-primary-foreground hover:bg-primary/90" : "bg-muted text-foreground hover:bg-muted/80"
            }`}
          >
            <Mic className="h-3.5 w-3.5" />
            {desktopWakeUnsupported ? "Wake Unavailable" : voiceWakeEnabled ? "Wake Listening On" : "Enable Wake"}
          </button>
          {annotationRecording ? (
            <button
              type="button"
              onClick={stopVoiceAnnotation}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-destructive/15 px-3 py-2 text-xs font-semibold text-destructive hover:bg-destructive/20"
            >
              <MicOff className="h-3.5 w-3.5" /> Stop & Save
            </button>
          ) : (
            <button
              type="button"
              onClick={startVoiceAnnotation}
              disabled={!voiceRecordingSupported}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-muted px-3 py-2 text-xs font-semibold text-foreground hover:bg-muted/80 disabled:opacity-50"
            >
              <Mic className="h-3.5 w-3.5" /> Record Now
            </button>
          )}
          <button
            type="button"
            onClick={undoLastVoiceAnnotation}
            disabled={!recentLiveEvents.length}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-muted px-3 py-2 text-xs font-semibold text-foreground hover:bg-muted/80 disabled:opacity-50"
          >
            <Undo2 className="h-3.5 w-3.5" /> Undo Last
          </button>
        </div>
      </div>
      <div className="mt-3 rounded-lg border border-border bg-muted/25 px-3 py-2">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          Commands: “Sarah”, “end”, “undo last”, “mark climax”, “Sarah set Howl intensity to 10”, “Sarah switch to milkmaster mode”
        </p>
      </div>
      {recentLiveEvents.length > 0 && (
        <div className="mt-3 rounded-lg border border-border bg-muted/20 p-3">
          <div className="flex items-center justify-between gap-2">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-primary">Live Annotations</p>
            <span className="text-[10px] text-muted-foreground">{liveEvents.length} total</span>
          </div>
          <div className="mt-2 grid gap-2 lg:grid-cols-2">
            {recentLiveEvents.slice(0, captureMode === "media" ? 4 : 8).map((event, index) => (
              <div key={`${event.created_at || event.time_s}-${index}`} className="rounded-lg bg-card/70 px-3 py-2">
                <div className="flex flex-wrap items-center gap-1.5">
                  <span className="font-mono text-[10px] text-primary">{fmtMmSs(event.time_s)}</span>
                  {asArray(event.annotation_tags || event.category).slice(0, 4).map((tag) => (
                    <span key={tag} className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[9px] font-medium text-primary">
                      {String(tag).replace(/_/g, " ")}
                    </span>
                  ))}
                </div>
                <p className="mt-1 line-clamp-2 text-xs text-foreground">{event.note}</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );

  const howlQuickControlPanel = (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-[minmax(0,1fr)_10rem]">
        <div className="rounded-xl border border-border bg-muted/20 p-3">
          <div className="flex items-start justify-between gap-3">
            <div>
              <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-primary">
                <Zap className="h-4 w-4" /> Howl Live Control
              </p>
              <p className="mt-1 text-sm font-semibold text-foreground">
                {howlLive ? howlModeSummary || "Howl telemetry live" : "No recent Howl telemetry"}
              </p>
            </div>
            <span className={`rounded-full px-2 py-1 text-[10px] font-semibold uppercase tracking-wider ${
              howlSarahAutoEnabled ? "bg-primary/15 text-primary" : howlManualControlsUnlocked ? "bg-emerald-500/10 text-emerald-400" : "bg-muted text-muted-foreground"
            }`}>
              {howlSarahAutoEnabled ? "Sarah auto" : howlManualControlsUnlocked ? "manual" : "locked"}
            </span>
          </div>
          <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{howlDisplayStatus}</p>
          <div className="mt-3 grid grid-cols-2 gap-2">
            <CompactStat label="Channel A" value={fmtNumber(howlChannelAIntensity, 0)} helper="power" level={howlChannelAIntensity} />
            <CompactStat label="Channel B" value={fmtNumber(howlChannelBIntensity, 0)} helper="power" level={howlChannelBIntensity} />
          </div>
        </div>
        <div className="rounded-xl border border-border bg-muted/20 p-3">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Ceiling</p>
          <p className="mt-1 font-mono text-4xl font-bold text-foreground">{fmtNumber(howlControlCeiling, 0)}</p>
          <p className="mt-1 text-xs text-muted-foreground">floor {fmtNumber(howlControlFloor, 0)} · selected {String(howlCommandForm.channel || "a").toUpperCase()}</p>
        </div>
      </div>

      <HowlWaveformPreview
        label={howlWaveformLabel}
        intensity={howlSelectedChannelIntensity}
        live={howlLive && howlTelemetryHasWaveform}
      />

      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
        <label className="space-y-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Howl activity</span>
          <select
            className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm"
            value={selectedHowlActivity?.name || ""}
            onChange={(event) => setHowlCommandForm((prev) => ({ ...prev, mode: event.target.value }))}
          >
            {HOWL_ACTIVITY_MODES.map((mode) => (
              <option key={mode.name} value={mode.name}>{mode.displayName}</option>
            ))}
          </select>
        </label>
        <label className="space-y-1">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Channel</span>
          <select
            className="h-10 rounded-lg border border-border bg-background px-3 text-sm"
            value={howlCommandForm.channel || "a"}
            onChange={(event) => setHowlCommandForm((prev) => ({ ...prev, channel: event.target.value }))}
          >
            <option value="a">A</option>
            <option value="b">B</option>
            <option value="all">All</option>
          </select>
        </label>
      </div>

      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <button
          type="button"
          onClick={() => sendHowlControlCommand("load_activity", { activityName: selectedHowlActivity?.name, activityDisplayName: selectedHowlActivity?.displayName, play: false })}
          disabled={!howlManualControlsUnlocked || Boolean(howlControlBusy) || !selectedHowlActivity}
          className="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-45"
        >
          Load activity
        </button>
        <button
          type="button"
          onClick={() => sendHowlControlCommand("increment_power", { channel: howlCommandForm.channel || "a", step: 1 })}
          disabled={!howlManualControlsUnlocked || Boolean(howlControlBusy)}
          className="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-45"
        >
          Power up
        </button>
        <button
          type="button"
          onClick={() => sendHowlControlCommand("decrement_power", { channel: howlCommandForm.channel || "a", step: 1 })}
          disabled={!howlManualControlsUnlocked || Boolean(howlControlBusy)}
          className="rounded-lg bg-primary/10 px-3 py-2 text-xs font-semibold text-primary hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-45"
        >
          Power down
        </button>
        <button
          type="button"
          onClick={sendHowlEmergencyStop}
          disabled={!howlControlEnabled || Boolean(howlControlBusy)}
          className="rounded-lg bg-destructive px-3 py-2 text-xs font-semibold text-destructive-foreground hover:bg-destructive/90 disabled:cursor-not-allowed disabled:opacity-45"
        >
          Mute / stop
        </button>
      </div>

      <div className="flex flex-col gap-2 rounded-xl border border-primary/20 bg-primary/[0.05] p-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-primary">Sarah HR/HRV Auto</p>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            When armed, Sarah uses live phase watch plus HR/HRV quality to step intensity within the saved floor/ceiling and cooldown.
          </p>
        </div>
        <button
          type="button"
          onClick={() => saveHowlControlSettings({ sarahAutoEnabled: !howlSarahAutoEnabled })}
          disabled={!howlManualControlsUnlocked || howlControlBusy === "settings"}
          className={`rounded-lg px-3 py-2 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
            howlSarahAutoEnabled ? "bg-primary/15 text-primary hover:bg-primary/25" : "bg-primary text-primary-foreground hover:bg-primary/90"
          }`}
        >
          {howlSarahAutoEnabled ? "Disarm auto" : "Arm auto"}
        </button>
      </div>

      {howlControlStatus && (
        <div className="rounded-lg border border-primary/25 bg-primary/10 px-3 py-2 text-xs text-primary">{howlControlStatus}</div>
      )}
      {howlError && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{howlError}</div>
      )}
    </div>
  );

  const mediaPanel = captureMode === "media" ? (
    <div className={focusView ? "flex h-full flex-col bg-background p-3" : "rounded-xl border border-border bg-card p-3 md:p-4"}>
      <div className="mb-3 flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <p className={`${focusView ? "text-sm" : "text-xs"} font-semibold uppercase tracking-wider text-primary flex items-center gap-1.5`}>
            <Video className="h-4 w-4" /> Media Review
          </p>
          <p className={`mt-1 text-muted-foreground ${focusView ? "text-base" : "text-sm"}`}>
            Local video playback with live HR context kept in view.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <label className="inline-flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm font-semibold text-foreground">
            <input
              type="checkbox"
              checked={telemetryNoticesEnabled}
              onChange={(event) => setTelemetryNoticesEnabled(event.target.checked)}
              className="h-4 w-4 accent-primary"
            />
            Live notices
          </label>
          <label className="inline-flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm font-semibold text-foreground">
            <input
              type="checkbox"
              checked={heartbeatAudioEnabled}
              onChange={async (event) => {
                const enabled = event.target.checked;
                setHeartbeatAudioEnabled(enabled);
                if (enabled) {
                  await getHeartbeatAudioContext();
                  triggerHeartbeatPulse(latestHrRef.current);
                }
              }}
              className="h-4 w-4 accent-rose-400"
            />
            Beat beep
          </label>
          <button
            type="button"
            onClick={() => setHowlQuickModalOpen(true)}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-primary/35 bg-primary/10 px-3 py-2 text-sm font-semibold text-foreground hover:bg-primary/15"
          >
            <Zap className="h-4 w-4 text-primary" />
            Howl {fmtNumber(howlSelectedChannelIntensity, 0)}
          </button>
          <button
            type="button"
            onClick={() => setFocusView(!focusView)}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg border border-border bg-muted px-3 py-2 text-sm font-semibold text-foreground hover:bg-muted/80"
          >
            {focusView ? <X className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
            {focusView ? "Exit Display View" : "Display View"}
          </button>
          <input
            ref={mediaInputRef}
            type="file"
            accept="video/*,.wmv"
            className="hidden"
            onChange={(event) => loadMediaFiles(event.target.files)}
          />
          <button
            type="button"
            onClick={() => mediaInputRef.current?.click()}
            className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
          >
            <UploadCloud className="h-4 w-4" />
            {mediaVideo ? "Change Video" : "Load Video"}
          </button>
          {mediaVideo && (
            <>
              <button
                type="button"
                onClick={openMediaFullscreen}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-muted px-3 py-2 text-sm font-semibold text-foreground hover:bg-muted/80"
              >
                <Maximize2 className="h-4 w-4" /> Full Screen
              </button>
              <button
                type="button"
                onClick={clearMediaVideo}
                className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-muted px-3 py-2 text-sm font-semibold text-muted-foreground hover:bg-muted/80 hover:text-foreground"
              >
                <X className="h-4 w-4" /> Clear
              </button>
            </>
          )}
        </div>
      </div>
      {(mediaProcessing || mediaError) && (
        <div className={`mb-3 rounded-lg border px-3 py-2 text-sm ${
          mediaError
            ? "border-destructive/30 bg-destructive/10 text-destructive"
            : "border-primary/30 bg-primary/10 text-primary"
        }`}>
          {mediaProcessing || mediaError}
        </div>
      )}

      <div className={`grid gap-3 ${focusView ? "min-h-0 flex-1 xl:grid-cols-[minmax(0,1fr)_30rem]" : "min-h-[calc(100vh-15rem)] xl:grid-cols-[minmax(0,1fr)_27rem]"}`}>
        <div
          className={`relative flex items-center justify-center overflow-hidden rounded-xl border ${focusView ? "min-h-0" : "min-h-[22rem]"} ${
            mediaDragging ? "border-primary bg-primary/10" : "border-border bg-black"
          }`}
          onDragEnter={(event) => {
            event.preventDefault();
            setMediaDragging(true);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setMediaDragging(true);
          }}
          onDragLeave={(event) => {
            event.preventDefault();
            if (event.currentTarget === event.target) setMediaDragging(false);
          }}
          onDrop={(event) => {
            event.preventDefault();
            setMediaDragging(false);
            loadMediaFiles(event.dataTransfer.files);
          }}
        >
          {mediaVideo ? (
            <>
              <video
                ref={mediaVideoRef}
                src={mediaVideo.url}
                controls
                preload="metadata"
                playsInline
                onClick={() => {
                  toggleMediaPlayback().catch(() => {});
                }}
                className={`${focusView ? "h-full min-h-0 max-h-full" : "max-h-[calc(100vh-17rem)] min-h-[22rem]"} w-full cursor-pointer bg-black object-contain`}
              />
              {!mediaFullscreen && (
                <div className="absolute bottom-3 left-3 flex items-center gap-2 rounded-lg border border-white/15 bg-black/70 px-2 py-2 text-white shadow-xl backdrop-blur-sm">
                  <button
                    type="button"
                    onClick={() => {
                      toggleMediaPlayback().catch(() => {});
                    }}
                    className="inline-flex items-center gap-1.5 rounded-md bg-white/10 px-3 py-1.5 text-xs font-semibold text-white transition-colors hover:bg-white/20"
                  >
                    {mediaPlaying ? <Pause className="h-3.5 w-3.5" /> : <Play className="h-3.5 w-3.5" />}
                    {mediaPlaying ? "Pause" : "Play"}
                  </button>
                  <span className="text-[11px] text-white/75">{mediaVideo.name}</span>
                </div>
              )}
            </>
          ) : mediaProcessing ? (
            <div className="flex h-full min-h-[22rem] w-full flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground">
              <RefreshCw className="h-10 w-10 animate-spin text-primary" />
              <span className="text-base font-semibold text-foreground">Preparing browser playback</span>
              <span className="max-w-md text-sm">{mediaProcessing}</span>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => mediaInputRef.current?.click()}
              className="flex h-full min-h-[22rem] w-full flex-col items-center justify-center gap-3 px-6 text-center text-muted-foreground hover:text-foreground"
            >
              <UploadCloud className="h-10 w-10 text-primary" />
              <span className="text-base font-semibold text-foreground">Drop a local video here</span>
              <span className="max-w-md text-sm">or use Load Video above to start media review. WMV files will be converted locally to MP4 first.</span>
            </button>
          )}
          {mediaVideo && !mediaFullscreen && (
            <div className="pointer-events-none absolute left-3 top-3 max-w-[70%] rounded-lg bg-black/65 px-3 py-2 text-xs text-white backdrop-blur-sm">
              <p className="truncate font-semibold">Loaded video</p>
              {mediaVideo.converted && <p className="mt-0.5 text-[10px] text-white/75">WMV converted to MP4 preview</p>}
            </div>
          )}
          {!mediaFullscreen && (
            <button
              type="button"
              onClick={() => setHowlQuickModalOpen(true)}
              className="absolute right-3 top-3 max-w-[min(22rem,calc(100%-1.5rem))] rounded-lg border border-white/15 bg-black/70 px-3 py-2 text-left text-white shadow-xl backdrop-blur-sm transition-colors hover:bg-black/80"
            >
              <div className="flex items-center justify-between gap-3">
                <span className="inline-flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-white/75">
                  <Zap className="h-3.5 w-3.5 text-primary" /> Howl
                </span>
                <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${howlSarahAutoEnabled ? "bg-primary/25 text-primary" : "bg-white/10 text-white/75"}`}>
                  {howlSarahAutoEnabled ? "auto" : "manual"}
                </span>
              </div>
              <div className="mt-1 flex items-end gap-3">
                <span className="font-mono text-3xl font-bold leading-none">{fmtNumber(howlSelectedChannelIntensity, 0)}</span>
                <span className="pb-1 text-xs text-white/75">A {fmtNumber(howlChannelAIntensity, 0)} · B {fmtNumber(howlChannelBIntensity, 0)}</span>
              </div>
              <p className="mt-1 line-clamp-1 text-[10px] text-white/70">{howlWaveformLabel || howlDisplayStatus}</p>
            </button>
          )}
        </div>

        {!mediaFullscreen && (
          <div className={`grid content-start gap-3 ${focusView ? "min-h-0 overflow-y-auto pr-1" : "xl:sticky xl:top-4 xl:max-h-[calc(100vh-9rem)] xl:overflow-hidden"}`}>
            <div className="grid auto-rows-fr grid-cols-2 items-stretch gap-2">
              <CompactStat label="Current HR" value={fmtNumber(hrTelemetry?.currentHr, 0)} helper="bpm" level={currentHrLevel} emphasis beatPulse={visibleHeartbeatPulseId} />
              <CompactStat label="Blood Pressure" value={latestBpValue} helper={latestBpHelper} emphasis />
              <CompactStat label="Max HR" value={fmtNumber(maxHr, 0)} helper="session peak" level={hrLevelPercent(maxHr, hrTelemetry?.baselineHr)} emphasis />
              {!captureIsBodyExploration && (
                <>
                  <CompactStat label="Build" value={`${fmtNumber(hrTelemetry?.buildConfidence, 0)}%`} helper={hrTelemetry?.phase || "phase"} level={buildLevel} />
                  <CompactStat
                    label="AI Magic"
                    value={`${prediction.nearClimax}%`}
                    helper={prediction.hrvUsable ? `${prediction.label} · HRV ${prediction.hrvSignal}` : prediction.label}
                    level={prediction.nearClimax}
                  />
                </>
              )}
            </div>

            {!captureIsBodyExploration && (
              <div
                className="min-h-[12.25rem] rounded-xl border p-4"
                style={{ borderColor: `${levelColor(prediction.nearClimax)}80`, background: `linear-gradient(135deg, ${levelColor(prediction.nearClimax)}28, hsl(var(--card)) 65%)` }}
              >
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold uppercase tracking-wider text-primary">Real-Time Phase Watch</p>
                    <p className="mt-1 h-6 truncate text-base font-medium leading-6 text-foreground">{prediction.label}</p>
                  </div>
                  <Brain className="h-5 w-5 text-primary" />
                </div>
                <div className="mt-3 h-3 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full transition-all" style={{ width: `${prediction.nearClimax}%`, backgroundColor: levelColor(prediction.nearClimax) }} />
                </div>
                <p className="mt-3 line-clamp-3 min-h-[3.75rem] text-sm leading-5 text-muted-foreground">{prediction.reason || "\u00a0"}</p>
                <p className="mt-2 line-clamp-2 min-h-8 text-xs leading-4 text-muted-foreground">
                  {prediction.hrvExplanation}
                </p>
              </div>
            )}

            <TrendPanel title="HR Trend" subtitle="Compact live view" empty={!hasHrTrend} heightClass="h-48" distanceView>
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={telemetryHistory} margin={{ top: 8, right: 8, bottom: 0, left: -22 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.35} />
                  <XAxis dataKey="time" hide />
                  <YAxis yAxisId="hr" hide domain={["dataMin - 4", "dataMax + 4"]} />
                  <YAxis yAxisId="watch" hide orientation="right" domain={[0, 100]} />
                  <Tooltip content={<ChartTooltip />} />
                  {phaseMarkers.map((marker, index) => marker.chartTime ? (
                    <ReferenceLine
                      key={`${marker.label}-${marker.chartTime}-media-${index}`}
                      yAxisId="hr"
                      x={marker.chartTime}
                      stroke={phaseMarkerColor(marker.label)}
                      strokeDasharray="4 3"
                      ifOverflow="extendDomain"
                    />
                  ) : null)}
                  <Line yAxisId="hr" type="monotone" dataKey="baseline" name="Baseline" stroke="hsl(var(--muted-foreground))" strokeDasharray="5 5" strokeWidth={1.25} dot={false} connectNulls />
                  <Line yAxisId="hr" type="monotone" dataKey="hrSmoothed" name="Smoothed" stroke="hsl(var(--chart-2))" strokeWidth={1.75} dot={false} connectNulls />
                  <Line yAxisId="hr" type="monotone" dataKey="hr" name="HR" stroke="hsl(var(--primary))" strokeWidth={2.25} dot={false} connectNulls />
                  {!captureIsBodyExploration && <Line yAxisId="watch" type="monotone" dataKey="nearClimax" name="Approach" stroke="hsl(var(--destructive))" strokeWidth={1.75} dot={false} connectNulls />}
                </LineChart>
              </ResponsiveContainer>
            </TrendPanel>

            {!captureIsBodyExploration && (
              <div className="rounded-xl border border-border bg-muted/20 p-3">
                <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Quick Phase Marks</p>
                <div className="mt-2 grid grid-cols-3 gap-1.5">
                  {[
                    { key: "pre_climax_offset_s", label: "Pre" },
                    { key: "climax_offset_s", label: "Climax" },
                    { key: "recovery_offset_s", label: "Recovery" },
                  ].map((item) => (
                    <button
                      key={item.key}
                      type="button"
                      onClick={() => applyLiveCommand({ type: "mark_phase", key: item.key, label: item.label === "Pre" ? "Pre-climax" : item.label })}
                      className="rounded-lg bg-muted px-2 py-2 text-sm font-semibold text-foreground hover:bg-muted/80"
                    >
                      {item.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  ) : null;

  const launchSetupSummary = summarizeLaunchProfile({
    ...launchProfile,
    captureKind,
    captureMode,
    hrSource: hrSourceSettings.source,
    pulsoidMode: hrSourceSettings.pulsoidMode,
    emgEnabled: emgSensorConfig !== "generic",
    emgSensorConfig,
    livePhysiologyCuesEnabled: liveCueSettings.enabled,
    cueStyle: liveCueSettings.style,
    cueVolume: liveCueSettings.volume,
    mediaLayout: mediaVideo ? "loaded" : "none",
    howlEnabled: howlControlEnabled,
    howlAutoControlEnabled: howlSarahAutoEnabled,
    telemetryNoticesEnabled,
    heartbeatAudioEnabled,
  });
  const h10Recent = recentHrPacket;
  const serverHrSource = status?.hr?.sourceStatus?.source || status?.hr?.latestTelemetry?.source || hrTelemetry?.source || "";
  const serverHrLabel = status?.hr?.sourceStatus?.label || hrTelemetry?.sourceLabel || selectedHrSource.label;
  const sharedServerHr = Boolean(
    h10Recent
    && serverHrSource
    && (serverHrSource !== hrSourceSettings.source || !directH10Status.connected)
  );
  const launchActive = recordingActive || Boolean(liveSession?.activeSessionId);
  const launchReadiness = {
    h10: {
      label: sharedServerHr ? "Shared HR" : hrSourceSettings.source === "direct_h10" ? "H10" : "HR Source",
      value: sharedServerHr
        ? "Receiving"
        : hrSourceSettings.source === "direct_h10"
        ? h10Recent
          ? "Connected"
          : directH10Status.connecting
            ? "Connecting"
            : directH10Status.connected
              ? "Waiting packet"
              : "Needs connection"
        : selectedHrSource.label,
      helper: sharedServerHr
        ? `${serverHrLabel} from the shared Sarah backend.`
        : hrSourceSettings.source === "direct_h10" ? directH10Status.message || "Direct H10 HR + RR source" : selectedHrSource.helper,
      tone: h10Recent || hrSourceSettings.source !== "direct_h10" ? "good" : directH10Status.connected || directH10Status.connecting ? "warn" : "bad",
    },
    hr: {
      value: h10Recent ? `${fmtNumber(hrTelemetry?.currentHr, 0)} BPM` : "Waiting",
      helper: h10Recent ? `${serverHrLabel} packet received.` : "Sarah will wait for an actual HR packet.",
      tone: h10Recent ? "good" : "warn",
    },
    obs: {
      value: recordingActive ? "Recording" : obsReady ? "Ready" : "Optional",
      helper: recordingActive ? recording?.filename || "OBS recording is live." : obsReady ? "OBS relay identified." : "Start telemetry-only or reconnect OBS.",
      tone: recordingActive || obsReady ? "good" : "neutral",
    },
    emg: {
      value: emgRecent ? "Live" : emgSensorConfig !== "generic" ? "Configured" : "Optional",
      helper: emgRecent ? "Recent EMG telemetry received." : "Does not block a normal HR session.",
      tone: emgRecent ? "good" : "neutral",
    },
    voice: {
      value: liveCueAudio.ready ? "Preloaded" : liveCueSettings.enabled ? (liveCueAudio.status.phase === "preparing" ? "Preparing" : "Enabled") : "Disabled",
      helper: liveCueAudio.status.message || `${LIVE_CUE_PRESETS[liveCueSettings.style]?.label || "Sarah"} · ${Math.round((liveCueSettings.volume ?? 0.28) * 100)}%`,
      tone: liveCueAudio.ready ? "good" : liveCueSettings.enabled ? "warn" : "neutral",
      required: false,
    },
    media: {
      value: mediaVideo ? "Loaded" : "None",
      helper: mediaVideo?.name || "Media is optional.",
      tone: mediaVideo ? "good" : "neutral",
    },
    howl: {
      value: howlSarahAutoEnabled ? "Sarah armed" : howlManualControlsUnlocked ? "Ready" : howlControlEnabled ? "Needs test" : "Disabled",
      helper: howlSarahAutoEnabled ? howlAutoStatus : "Howl does not block launch.",
      tone: howlSarahAutoEnabled || howlManualControlsUnlocked ? "good" : howlControlEnabled ? "warn" : "neutral",
    },
  };
  const launchPrimaryLabel = launchActive
    ? "Session Live"
    : !h10Recent && hrSourceSettings.source === "direct_h10"
      ? "Connect H10 and Start Session"
      : liveCueSettings.enabled && !liveCueAudio.ready
        ? "Prepare Sarah and Start Session"
        : "Start Session";
  const showAdvancedSetupConsole = advancedSetupOpen;
  const obsPreferred = Boolean(launchProfile.obsEnabled && !launchProfile.telemetryOnlyFallback);
  const h10RawStreamsActive = Boolean(
    directH10Source
    && effectiveH10Multimodal?.streams?.ecg?.sampleCount > 0
    && effectiveH10Multimodal?.streams?.accelerometer?.sampleCount > 0
  );
  const h10RawStreamFailure = Boolean(
    directH10Source
    && healthHrConnected
    && !h10RawStreamsActive
    && /unavailable|rejected|timed out|delivered no complete sensor stream|failed/i.test(directH10Status.pmdMessage || "")
  );
  const liveGuidanceMode = !healthRecentHrPacket
    ? {
      label: "Telemetry unstable",
      tone: "bad",
      helper: "No recent HR packet. Sarah should not trust live phase/build guidance until heart-rate telemetry is current again.",
    }
    : healthRrWeak
      ? {
        label: "HR-only watch",
        tone: "warn",
        helper: "Heart rate is live, but RR/HRV quality is weak. Treat AI Magic as lower-confidence and lean on manual marks.",
      }
      : emgConfigured && !healthTelemetryEmgLive
        ? {
          label: "HR-led watch",
          tone: "warn",
          helper: "HR and RR are live, but the configured EMG feed is not current. EMG-specific cues are stepped down until the feed stabilizes.",
        }
        : directH10Source && !h10RawStreamsActive
          ? {
            label: "HR / HRV only",
            tone: "warn",
            helper: h10RawStreamFailure
              ? `Raw H10 physiology failed: ${directH10Status.pmdMessage}. Motion and respiration are not being collected.`
              : "HR and RR are live. Sarah is still confirming real ECG and accelerometer packets before enabling motion or respiration tracking.",
          }
          : {
          label: h10RawStreamsActive ? h10State.label || "Multimodal tracking" : "Full guidance",
          tone: "good",
          helper: h10RawStreamsActive
            ? `Raw H10 ECG and chest motion are active. Signal confidence ${fmtNumber(h10SignalConfidence.score, 0)}%; motion and respiration claims remain quality-gated.`
            : "Heart rate is current and Sarah has enough live signal quality for the normal guidance stack.",
          };
  const liveHealthPills = [
    {
      label: "HR Source",
      value: healthRecentHrPacket ? "Live" : healthHrConnected ? "Link only" : "Offline",
      helper: healthRecentHrPacket
        ? `${serverHrLabel} packets are current.`
        : healthHrConnected
          ? "Connection exists, but Sarah is waiting for a fresh HR packet."
          : "No live HR telemetry.",
      tone: healthRecentHrPacket ? "good" : healthHrConnected ? "warn" : "bad",
    },
    {
      label: "RR / HRV",
      value: directH10Source ? (healthRrUsable ? "Usable" : healthRrWeak ? "Weak" : "Waiting") : "N/A",
      helper: directH10Source
        ? healthRrUsable
          ? `RR ${fmtNumber(rrCount, 0)} · HRV ${String(hrvQuality || "").toLowerCase() || "usable"}`
          : healthRrWeak
            ? `RR ${fmtNumber(rrCount, 0)} · HRV ${String(hrvQuality || "low").toLowerCase()}`
            : "Direct H10 is live, but the RR window is not ready yet."
        : "RR-driven HRV only applies to direct H10 sessions.",
      tone: directH10Source ? (healthRrUsable ? "good" : healthRrWeak ? "warn" : "neutral") : "neutral",
    },
    {
      label: "Raw H10 Sensors",
      value: h10RawStreamsActive ? `${fmtNumber(h10SignalConfidence.score, 0)}%` : h10RawStreamFailure ? "FAILED" : directH10Source ? "Confirming" : "N/A",
      helper: h10RawStreamsActive
        ? `ECG ${h10SignalConfidence.ecg || "waiting"} · accelerometer ${h10SignalConfidence.accelerometer || "waiting"}`
        : directH10Source
          ? directH10Status.pmdMessage || "HR/RR remains live while ECG and chest motion start."
          : "Available with Direct Polar H10.",
      tone: h10RawStreamsActive ? (h10SignalConfidence.level === "high" ? "good" : "warn") : h10RawStreamFailure ? "bad" : "neutral",
    },
    {
      label: "Respiration",
      value: h10Respiration.possibleBreathHold ? "HOLD?" : h10Respiration.available ? `${fmtNumber(h10Respiration.bpm, 1)}/min` : "Withheld",
      helper: h10Respiration.available
        ? `${h10Respiration.source?.replaceAll?.("_", " ") || "H10"} · ${h10Respiration.confidence || "limited"} confidence${h10Respiration.possibleBreathHold ? " · at least 4 s low-motion stillness" : ""}`
        : `Reason: ${(h10Respiration.reason || "waiting for 45 s low-motion window").replaceAll?.("_", " ")}`,
      tone: h10Respiration.available ? (h10Respiration.confidence === "high" ? "good" : "warn") : "neutral",
    },
    {
      label: "Chest Motion / Position",
      value: (h10Motion.class || "unavailable").replaceAll?.("_", " "),
      helper: `${(h10Position.state || "unavailable").replaceAll?.("_", " ")}${h10Position.orientationChangeDegrees != null ? ` · ${h10Position.orientationChangeDegrees}° from reference` : ""}`,
      tone: h10Motion.class === "low_motion" ? "good" : h10Motion.available ? "warn" : "neutral",
    },
    {
      label: "Recovery / Response",
      value: h10Recovery.available ? `-${fmtNumber(h10Recovery.currentDropBpm, 0)} bpm` : "Learning",
      helper: h10Recovery.available
        ? `30 s ${h10Recovery.drop30Bpm != null ? `-${h10Recovery.drop30Bpm}` : "--"} · 60 s ${h10Recovery.drop60Bpm != null ? `-${h10Recovery.drop60Bpm}` : "--"} · latency ${h10Latency.available ? `${h10Latency.medianSeconds}s` : "learning"}`
        : `Response latency ${h10Latency.available ? `${h10Latency.medianSeconds}s median` : `needs ${Math.max(0, 2 - Number(h10Latency.sampleCount || 0))} more marked response${Math.max(0, 2 - Number(h10Latency.sampleCount || 0)) === 1 ? "" : "s"}`}`,
      tone: h10Recovery.available ? "good" : "neutral",
    },
    {
      label: "EMG",
      value: healthTelemetryEmgLive ? "Live" : emgConfigured ? "Stale" : "Optional",
      helper: healthTelemetryEmgLive
        ? selectedEmgConfig.trendSubtitle || "Recent EMG telemetry received."
        : emgConfigured
          ? "Configured, but no current EMG sample is landing."
          : "No EMG preset selected for this capture.",
      tone: healthTelemetryEmgLive ? "good" : emgConfigured ? "warn" : "neutral",
    },
    {
      label: "Session / OBS",
      value: recordingActive ? "Recording" : obsReady ? "Ready" : obsPreferred ? "Missing" : "Optional",
      helper: recordingActive
        ? recording?.filename || "OBS recording is live."
        : obsReady
          ? "OBS relay/session shell identified."
          : obsPreferred
            ? "This launch profile expects OBS, but it is not currently ready."
            : "Telemetry-only capture is acceptable here.",
      tone: recordingActive || obsReady ? "good" : obsPreferred ? "warn" : "neutral",
    },
    {
      label: "Blood Pressure",
      value: latestBpReading ? "Recent" : bpOmronListening ? "Armed" : "Idle",
      helper: latestBpReading
        ? latestBpHelper
        : bpOmronListening
          ? "OMRON listener is armed and waiting for the cuff."
          : "No recent BP reading is attached.",
      tone: latestBpReading ? "good" : bpOmronListening ? "warn" : "neutral",
    },
  ];

  return (
    <div className={`${focusView ? "h-screen overflow-hidden bg-[#071016] p-0" : "p-4 md:p-6"} space-y-4`}>
      {hrLossDialog && (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/45 p-4">
          <div
            className="w-full max-w-md rounded-xl border border-destructive/40 bg-card p-4 shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="h10-loss-title"
          >
            <div className="flex items-start gap-3">
              <div className="mt-0.5 rounded-full bg-destructive/15 p-2 text-destructive">
                <AlertTriangle className="h-5 w-5" />
              </div>
              <div className="min-w-0 flex-1">
                <p id="h10-loss-title" className="text-base font-semibold text-foreground">{hrLossDialog.title}</p>
                <p className="mt-2 text-sm leading-relaxed text-muted-foreground">{hrLossDialog.message}</p>
                {hrLossDialog.reconnecting && (
                  <p className="mt-2 text-xs font-semibold uppercase tracking-wider text-primary">Trying automatic reconnect</p>
                )}
              </div>
            </div>
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <button
                type="button"
                className="rounded-lg border border-border bg-background px-3 py-2 text-sm font-semibold text-muted-foreground hover:text-foreground"
                onClick={() => setHrLossDialog(null)}
              >
                Dismiss
              </button>
              <button
                type="button"
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground"
                onClick={() => {
                  directH10ReconnectAttemptRef.current = 0;
                  setHrLossDialog(null);
                  connectDirectH10();
                }}
              >
                <RefreshCw className="h-4 w-4" />
                Reconnect H10
              </button>
            </div>
          </div>
        </div>
      )}

      {howlQuickModalOpen && (
        <div className="fixed inset-0 z-[75] flex items-center justify-center bg-black/45 p-4" onMouseDown={() => setHowlQuickModalOpen(false)}>
          <div
            className="max-h-[88vh] w-full max-w-2xl overflow-y-auto rounded-xl border border-border bg-card p-4 shadow-2xl"
            role="dialog"
            aria-modal="true"
            aria-labelledby="howl-quick-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="mb-4 flex items-start justify-between gap-4">
              <div>
                <p id="howl-quick-title" className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-primary">
                  <Zap className="h-4 w-4" /> Howl Quick Access
                </p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Live e-stim state, bounded manual controls, and Sarah auto status.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setHowlQuickModalOpen(false)}
                className="rounded-lg bg-muted p-2 text-muted-foreground hover:text-foreground"
                aria-label="Close Howl quick access"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            {howlQuickControlPanel}
          </div>
        </div>
      )}

      {!focusView && (<section className={`rounded-2xl border p-4 shadow-sm ${liveHealthToneClasses(liveGuidanceMode.tone)}`} aria-live="polite">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div className="min-w-0">
            <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider">
              {liveGuidanceMode.tone === "good"
                ? <CheckCircle2 className="h-4 w-4" />
                : <AlertTriangle className="h-4 w-4" />}
              Live Capture Health
            </p>
            <p className="mt-1 text-lg font-semibold">{liveGuidanceMode.label}</p>
            <p className="mt-1 max-w-3xl text-sm leading-relaxed opacity-90">{liveGuidanceMode.helper}</p>
          </div>
          <div className="shrink-0 rounded-xl border border-current/15 bg-black/10 px-3 py-2 text-xs font-semibold uppercase tracking-wider">
            {captureMode === "hr" ? "HR Distance View" : captureIsBodyExploration ? "Body Exploration Capture" : "Full Capture"}
          </div>
        </div>
        <div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-5">
          {liveHealthPills.map((item) => (
            <LiveHealthPill
              key={item.label}
              label={item.label}
              value={item.value}
              helper={item.helper}
              tone={item.tone}
            />
          ))}
        </div>
        <div className="mt-4 rounded-xl border border-current/15 bg-black/10 p-3">
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider">
                <CircleDot className="h-4 w-4" /> Quick Event Pads
              </p>
              <p className="mt-1 text-sm opacity-90">
                One tap stamps the current live moment into the session timeline.
              </p>
            </div>
            <p className="text-[11px] font-semibold uppercase tracking-wider opacity-75">
              Uses the same timestamp path as voice and live markers
            </p>
          </div>
          <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
            {quickEventPads.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => applyLiveCommand({ type: "quick_event", ...item })}
                className="inline-flex items-center justify-between gap-3 rounded-lg border border-current/15 bg-background/70 px-3 py-2 text-left text-sm font-semibold text-foreground transition hover:bg-background/90"
              >
                <span>{item.label}</span>
                <CircleDot className="h-4 w-4 shrink-0 opacity-70" />
              </button>
            ))}
          </div>
        </div>
      </section>)}

      {!focusView && !mainTelemetryView && !launchActive && (
        <LiveCaptureLaunchpad
          setupSummary={launchSetupSummary}
          readiness={launchReadiness}
          primaryLabel={launchPrimaryLabel}
          primaryBusy={launchState.busy}
          primaryDisabled={launchActive}
          progress={launchState.steps}
          active={launchActive}
          onStart={() => startFromLaunchpad().catch((error) => {
            toast({
              title: "Live Capture launch paused",
              description: error?.message || "Sarah could not complete the launch sequence.",
              variant: "destructive",
            });
          })}
        />
      )}

      {!focusView && !mainTelemetryView && showAdvancedSetupConsole && (
        <CollapsibleControlSection
          icon={Activity}
          title="Blood Pressure"
          helper={bpCapture.lastReading
            ? `Last reading: ${formatBloodPressure(bpCapture.lastReading)} · ${formatBloodPressureTime(bpCapture.lastReading.measured_at)}`
            : "OMRON and Health Connect controls"}
          status={bpOmronListening ? "OMRON armed" : bpCapture.lastReading ? "Latest ready" : "Not connected"}
        >
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-primary">
                <Activity className="h-4 w-4" /> Blood Pressure
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {bpCapture.lastReading
                  ? `Last reading: ${formatBloodPressure(bpCapture.lastReading)} · ${formatBloodPressureTime(bpCapture.lastReading.measured_at)}`
                  : bpCapture.message || "Waiting for a saved BP reading."}
              </p>
              {bpCapture.lastCapturedAt && (
                <p className="mt-1 text-xs text-primary">
                  Successfully stamped into this session {formatBloodPressureTime(bpCapture.lastCapturedAt)}.
                </p>
              )}
              {bpCapture.error && <p className="mt-1 text-xs text-destructive">{bpCapture.error}</p>}
              <p className="mt-2 text-[11px] text-muted-foreground">
                Phone APK can sync the OMRON BP7000 directly over Bluetooth. Desktop reads the same local PulsePoint BP database and refreshes the active session.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <span className={`rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-wider ${
                bpCapture.status === "captured"
                  ? "border-primary/30 bg-primary/10 text-primary"
                  : bpCapture.status === "error"
                    ? "border-destructive/30 bg-destructive/10 text-destructive"
                    : bpCapture.status === "permission_needed"
                      ? "border-amber-400/30 bg-amber-400/10 text-amber-300"
                      : "border-border bg-muted/40 text-muted-foreground"
              }`}>
                {bpCapture.syncing ? "Syncing" : bpCapture.status === "captured" ? "Captured" : bpCapture.status === "permission_needed" ? "Permission needed" : bpCapture.lastReading ? "Latest ready" : "Watching"}
              </span>
              {bpOmronListening && (
                <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-emerald-300">
                  OMRON listening
                </span>
              )}
              {bpCapture.status === "permission_needed" && (
                <button
                  type="button"
                  onClick={requestBloodPressureForLiveCapture}
                  disabled={bpCapture.syncing}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Allow BP
                </button>
              )}
              {(bpCapture.status === "permission_needed" || bpCapture.status === "error") && bpCapture.native !== false && (
                <button
                  type="button"
                  onClick={openBloodPressureSettingsForLiveCapture}
                  disabled={bpCapture.syncing}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-muted px-3 py-2 text-xs font-semibold text-foreground hover:bg-muted/80 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  <ExternalLink className="h-3.5 w-3.5" />
                  Health Connect
                </button>
              )}
              <button
                type="button"
                onClick={toggleOmronBloodPressureListener}
                disabled={bpCapture.syncing}
                className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold disabled:cursor-not-allowed disabled:opacity-50 ${
                  bpOmronListening
                    ? "bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25"
                    : "bg-primary text-primary-foreground hover:bg-primary/90"
                }`}
              >
                {bpCapture.syncing ? (
                  <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-current border-t-transparent" />
                ) : (
                  <Radio className="h-3.5 w-3.5" />
                )}
                {bpOmronListening ? "Stop OMRON" : "Listen OMRON"}
              </button>
              <button
                type="button"
                onClick={() => syncBloodPressureForLiveSession({ manual: true })}
                disabled={bpCapture.syncing}
                className="inline-flex items-center gap-1.5 rounded-lg bg-primary/10 px-3 py-2 text-xs font-semibold text-primary hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {bpCapture.syncing ? (
                  <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                ) : (
                  <RefreshCw className="h-3.5 w-3.5" />
                )}
                Refresh BP
              </button>
            </div>
          </div>
        </CollapsibleControlSection>
      )}

      {!focusView && !mainTelemetryView && showAdvancedSetupConsole && (
        <LiveSessionMobileRecorder
          activeSessionDoc={activeSessionDoc}
          liveSession={liveSession}
          ensureSession={ensureSession}
          telemetryHistory={telemetryHistory}
          hrTelemetry={hrTelemetry}
          emgTelemetry={emgTelemetry}
          latestBpReading={latestBpReading}
          latestSpo2Reading={activeSessionDoc?.latest_pulse_ox_reading || activeSessionDoc?.session_context?.pulse_ox || null}
        />
      )}

      {!focusView && !mainTelemetryView && launchState.error && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive">
          <p className="font-semibold">Launch stopped at: {launchState.message}</p>
          <p className="mt-1">{launchState.error}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => startFromLaunchpad().catch(() => {})}
              className="rounded-lg bg-destructive px-3 py-2 text-xs font-semibold text-destructive-foreground"
            >
              Retry failed step
            </button>
            <button
              type="button"
              onClick={() => startFromLaunchpad({ allowWithoutVoice: true }).catch(() => {})}
              className="rounded-lg border border-border bg-card px-3 py-2 text-xs font-semibold text-foreground"
            >
              Start without optional voice
            </button>
            <button
              type="button"
              onClick={() => setAdvancedSetupOpen(true)}
              className="rounded-lg border border-border bg-card px-3 py-2 text-xs font-semibold text-foreground"
            >
              Open advanced setup
            </button>
          </div>
        </div>
      )}

      {!focusView && <div className="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
        <PageHeader
          title="Live Capture"
          subtitle={captureIsBodyExploration
            ? "Real-time HR, EMG, OBS recording state, and body exploration telemetry"
            : "Real-time HR, EMG, OBS recording state, and prediction telemetry"}
          icon={Radio}
        />
        <div className="flex flex-wrap items-center gap-2 md:mt-1">
          <button
            type="button"
            onClick={() => setFocusView(true)}
            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2 text-sm font-semibold text-foreground shadow-sm hover:bg-primary/15"
          >
            <Maximize2 className="h-4 w-4 text-primary" />
            <span>Display View</span>
          </button>
          <button
            type="button"
            onClick={() => setAdvancedSetupOpen((open) => !open)}
            aria-expanded={advancedSetupOpen}
            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm font-semibold text-foreground shadow-sm hover:bg-muted/50"
          >
            <SlidersHorizontal className="h-4 w-4 text-primary" />
            <span>Settings & Devices</span>
            <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${advancedSetupOpen ? "rotate-180" : ""}`} />
          </button>
        </div>
      </div>}

      {!focusView && !mainTelemetryView && showAdvancedSetupConsole && (
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-primary">Session Settings</p>
              <p className="mt-1 text-sm text-muted-foreground">Capture type, notices, presets, and optional devices.</p>
            </div>
            <div className="flex flex-wrap gap-2">
              <div className="inline-flex rounded-lg border border-border bg-muted/25 p-1">
                {CAPTURE_KINDS.map((kind) => (
                  <button
                    key={kind.value}
                    type="button"
                    disabled={recordingActive}
                    onClick={() => setCaptureKind(kind.value)}
                    className={`rounded-md px-2.5 py-1.5 text-sm font-semibold ${captureKind === kind.value ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:bg-background"}`}
                  >
                    {kind.label}
                  </button>
                ))}
              </div>
              <label className="inline-flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm font-semibold text-foreground">
                <input
                  type="checkbox"
                  checked={telemetryNoticesEnabled}
                  onChange={(event) => setTelemetryNoticesEnabled(event.target.checked)}
                  className="h-4 w-4 accent-primary"
                />
                Live notices
              </label>
              <button
                type="button"
                onClick={() => setPresetModalOpen(true)}
                className="inline-flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm font-semibold text-foreground hover:bg-muted"
              >
                <SlidersHorizontal className="h-4 w-4 text-primary" />
                {selectedCaptureMode.label}
              </button>
            </div>
          </div>
        </div>
      )}

      {!focusView && captureKindError && (
        <div className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {captureKindError}
        </div>
      )}

      {!focusView && presetModalOpen && (
        <div className="fixed inset-0 z-50 flex items-start justify-end bg-black/20 p-4 pt-20 md:p-6 md:pt-24" onMouseDown={() => setPresetModalOpen(false)}>
          <div
            className="w-full max-w-lg rounded-xl border border-border bg-card p-4 shadow-2xl"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-primary">Capture Preset</p>
                <p className="mt-1 text-sm text-muted-foreground">Choose the live capture view without moving the workspace around.</p>
              </div>
              <button
                type="button"
                onClick={() => setPresetModalOpen(false)}
                className="rounded-lg bg-muted p-2 text-muted-foreground hover:text-foreground"
                aria-label="Close preset selector"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="mt-4 grid gap-2 sm:grid-cols-2">
              {CAPTURE_MODES.map((mode) => (
                <button
                  key={mode.value}
                  type="button"
                  onClick={() => {
                    setCaptureMode(mode.value);
                    setPresetModalOpen(false);
                  }}
                  className={`rounded-lg border px-3 py-3 text-left transition-colors ${
                    captureMode === mode.value
                      ? "border-primary bg-primary/12 text-foreground"
                      : "border-border bg-muted/30 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                  }`}
                >
                  <span className="block text-sm font-semibold">{mode.label}</span>
                  <span className="mt-1 block text-xs">{mode.helper}</span>
                </button>
              ))}
            </div>
            <div className="mt-5 border-t border-border pt-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-primary">EMG Sensor Configuration</p>
                  <p className="mt-1 text-sm text-muted-foreground">Choose how Live Capture labels and saves EMG placement context.</p>
                </div>
                {activeSessionDoc?.emg_target_area && (
                  <span className="rounded-full border border-primary/25 bg-primary/10 px-2 py-1 text-[10px] font-semibold text-primary">
                    {activeSessionDoc.emg_target_area}
                  </span>
                )}
              </div>
              <div className="mt-3 grid gap-2">
                {EMG_SENSOR_CONFIGS.map((config) => (
                  <button
                    key={config.value}
                    type="button"
                    onClick={() => applyEmgSensorConfig(config)}
                    className={`rounded-lg border px-3 py-3 text-left transition-colors ${
                      emgSensorConfig === config.value
                        ? "border-primary bg-primary/12 text-foreground"
                        : "border-border bg-muted/30 text-muted-foreground hover:bg-muted/60 hover:text-foreground"
                    }`}
                  >
                    <span className="block text-sm font-semibold">{config.label}</span>
                    <span className="mt-1 block text-xs leading-relaxed">{config.helper}</span>
                    {config.value !== "generic" && (
                      <span className="mt-2 block text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                        Saves target area, sensor type, and placement notes to the active session
                      </span>
                    )}
                  </button>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {!focusView && !mainTelemetryView && showAdvancedSetupConsole && (
        <div className="rounded-xl border border-primary/20 bg-primary/[0.05] p-3">
          <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
            {[
              { label: "1. Sources", value: hrConnected ? "HR ready" : "Check HR source", active: hrConnected },
              { label: "2. Session", value: recordingActive ? "Recording live" : liveSession?.activeSessionId ? "Shell ready" : "Waiting for OBS", active: recordingActive || Boolean(liveSession?.activeSessionId) },
              { label: "3. Annotate", value: annotationRecording ? "Recording note" : voiceWakeEnabled ? "Wake listening on" : "Record when needed", active: annotationRecording || voiceWakeEnabled },
              { label: "4. Watch", value: hrTelemetry?.currentHr != null ? `${fmtNumber(hrTelemetry.currentHr, 0)} bpm live` : "Waiting for telemetry", active: hrTelemetry?.currentHr != null },
            ].map((item) => (
              <div key={item.label} className={`rounded-lg border px-3 py-2 ${item.active ? "border-primary/30 bg-primary/10" : "border-border bg-card/70"}`}>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{item.label}</p>
                <p className="mt-1 text-sm font-semibold text-foreground">{item.value}</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {!focusView && !mainTelemetryView && showAdvancedSetupConsole && (
        <div className="rounded-2xl border border-primary/25 bg-card p-4 shadow-sm">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-primary">
                <Radio className="h-4 w-4" />
                Session Start
              </p>
              <p className="mt-1 max-w-3xl text-sm leading-relaxed text-muted-foreground">
                Start here: confirm HR acquisition, OBS boundary, EMG target, Howl ingest, and annotation readiness before the recording gets rolling.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <button
                type="button"
                onClick={() => setPresetModalOpen(true)}
                className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-muted px-3 py-2 text-sm font-semibold text-foreground hover:bg-muted/80"
              >
                <SlidersHorizontal className="h-4 w-4" />
                Presets
              </button>
              {!liveSession?.activeSessionId && (
                <button
                  type="button"
                  onClick={ensureSession}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
                >
                  <FileText className="h-4 w-4" />
                  Create Shell
                </button>
              )}
              {liveSession?.activeSessionId && (
                <Link
                  to={`/sessions/${liveSession.activeSessionId}`}
                  className="inline-flex items-center gap-1.5 rounded-lg bg-muted px-3 py-2 text-sm font-semibold text-foreground hover:bg-muted/80"
                >
                  <ExternalLink className="h-4 w-4" />
                  Open Session
                </Link>
              )}
            </div>
          </div>

          <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            <SetupTile
              icon={<HeartPulse className="h-3.5 w-3.5 text-primary" />}
              label="Heart Rate Acquisition"
              value={hrConnected ? `${fmtNumber(hrTelemetry?.currentHr, 0)} bpm` : selectedHrSource.label}
              helper={hrConnected
                ? `${status?.hr?.sourceStatus?.label || selectedHrSource.label} live${rrCount ? ` · ${rrCount} RR samples` : ""}`
                : status?.hr?.sourceStatus?.message || selectedHrSource.helper}
              active={hrConnected}
              tone={hrConnected ? "default" : "warn"}
            >
              <button
                type="button"
                onClick={() => setPresetModalOpen(true)}
                className="rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-semibold text-foreground hover:bg-muted"
              >
                Provider
              </button>
              <button
                type="button"
                onClick={() => applyHrSourceSettings()}
                disabled={hrSourceSaving}
                className="rounded-md bg-primary/10 px-2.5 py-1.5 text-xs font-semibold text-primary hover:bg-primary/20 disabled:opacity-50"
              >
                {hrSourceSaving ? "Applying..." : "Apply HR"}
              </button>
              {hrSourceSettings.source === "direct_h10" && (
                <button
                  type="button"
                  onClick={() => connectDirectH10()}
                  disabled={directH10Status.connecting}
                  className="rounded-md bg-primary px-2.5 py-1.5 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
                >
                  {directH10Status.connecting ? "Connecting..." : "Connect H10"}
                </button>
              )}
            </SetupTile>

            <SetupTile
              icon={<Video className="h-3.5 w-3.5 text-primary" />}
              label="OBS Session Boundary"
              value={recordingPaused ? "Paused" : recordingActive ? "Recording" : obsReady ? "Ready" : "Waiting"}
              helper={recordingPaused
                ? "OBS pause is timestamped; resume continues this session."
                : recordingActive
                ? recording?.filename || "OBS recording is driving the live session."
                : obsReady
                  ? "OBS relay identified. Start recording when ready."
                  : embeddedObsStatus?.error || "OBS relay status will appear here once identified."}
              active={obsReady}
              tone={obsReady ? "default" : "warn"}
            >
              <button
                type="button"
                onClick={refreshFiles}
                className="rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-semibold text-foreground hover:bg-muted"
              >
                Refresh Files
              </button>
            </SetupTile>

            <SetupTile
              icon={<Activity className="h-3.5 w-3.5 text-primary" />}
              label="EMG Target"
              value={usingPerinealEmgConfig ? "Perineum" : selectedEmgConfig.label}
              helper={emgRecent
                ? `${selectedEmgConfig.leftLabel} live at ${fmtNumber(leftEmgLevel)}%`
                : usingPerinealEmgConfig
                  ? "Perineal-body preset saved; start the EMG helper for live signal."
                  : "Choose Perineal Body EMG here when tracking pelvic-floor/perineal activation."}
              active={usingPerinealEmgConfig || emgRecent}
            >
              <button
                type="button"
                onClick={() => applyEmgSensorConfig(EMG_SENSOR_CONFIGS.find((config) => config.value === "perineal_body_small_electrodes"))}
                className="rounded-md bg-primary/10 px-2.5 py-1.5 text-xs font-semibold text-primary hover:bg-primary/20"
              >
                Track Perineum
              </button>
              <button
                type="button"
                onClick={() => setCalibrationOpen(true)}
                className="rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-semibold text-foreground hover:bg-muted"
              >
                Calibrate
              </button>
            </SetupTile>

            <SetupTile
              icon={<Zap className="h-3.5 w-3.5 text-primary" />}
              label="Howl Control"
              value={howlSarahAutoEnabled ? "Sarah armed" : howlManualControlsUnlocked ? "Manual ready" : howlConnectionSucceeded ? "Tested" : howlLive ? "Telemetry live" : "Setup needed"}
              helper={howlLive
                ? `${howlModeSummary || `Last sample ${fmtTime(howlMeasuredAt)}`} · ${howlSarahAutoEnabled ? howlAutoStatus : howlControlModeLabel}`
                : howlError || `Direct HTTP ${howlControlUrlPreview || "http://PHONE_IP:4695"}; telemetry POST ${howlEndpointText}`}
              active={howlLive || howlControlEnabled || howlSarahAutoEnabled || howlConnectionSucceeded}
            >
              <button
                type="button"
                onClick={() => setHowlControlOpen((open) => !open)}
                className="rounded-md bg-primary/10 px-2.5 py-1.5 text-xs font-semibold text-primary hover:bg-primary/20"
              >
                Controls
              </button>
              {howlControlEnabled && (
                <button
                  type="button"
                  onClick={sendHowlEmergencyStop}
                  disabled={howlControlBusy === "emergency_stop"}
                  className="rounded-md bg-destructive/15 px-2.5 py-1.5 text-xs font-semibold text-destructive hover:bg-destructive/25 disabled:opacity-50"
                >
                  Stop
                </button>
              )}
              <button
                type="button"
                onClick={() => refreshHowlTelemetry({ forceSettings: true })}
                disabled={howlRefreshing}
                className="rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-semibold text-foreground hover:bg-muted disabled:opacity-50"
              >
                {howlRefreshing ? "Checking..." : "Refresh"}
              </button>
              <span className="rounded-md bg-muted px-2.5 py-1.5 text-xs font-semibold text-muted-foreground">
                {howlCapabilities?.mode || "manual_control"}
              </span>
            </SetupTile>

            <SetupTile
              icon={voiceWakeEnabled ? <Mic className="h-3.5 w-3.5 text-primary" /> : <MicOff className="h-3.5 w-3.5 text-primary" />}
              label="Voice Notes"
              value={annotationRecording ? "Recording" : voiceWakeEnabled ? "Listening" : "Manual"}
              helper={desktopWakeUnsupported
                ? "Wake phrase is unavailable in the Windows EXE right now. Record Note still timestamps the session."
                : voiceReady
                  ? "Timestamp notes during the session."
                  : "Microphone capture unavailable in this browser context."}
              active={annotationRecording || voiceWakeEnabled}
            >
              <button
                type="button"
                onClick={toggleVoiceWake}
                disabled={!voiceReady}
                className="rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-semibold text-foreground hover:bg-muted disabled:opacity-50"
              >
                {desktopWakeUnsupported ? "Wake Unavailable" : voiceWakeEnabled ? "Wake Off" : "Wake On"}
              </button>
              <button
                type="button"
                onClick={startManualVoiceNote}
                disabled={!voiceRecordingSupported || annotationRecording}
                className="rounded-md bg-primary/10 px-2.5 py-1.5 text-xs font-semibold text-primary hover:bg-primary/20 disabled:opacity-50"
              >
                Record Note
              </button>
            </SetupTile>

            {!captureIsBodyExploration && (
              <SetupTile
                icon={<Volume2 className="h-3.5 w-3.5 text-primary" />}
                label="Sarah Encouragement"
                value={liveCueSettings.enabled ? "On" : "Off"}
                helper={liveCueSettings.enabled
                  ? `${LIVE_CUE_PRESETS[liveCueSettings.style]?.label || "Sarah"} · ${liveCueAudio.ready ? "voice ready" : liveCueAudio.status.message || "prepares at session start"}`
                  : "Opt-in calming encouragement during build, plateau, final approach, and recovery."}
                active={liveCueSettings.enabled}
              >
                <button
                  type="button"
                  onClick={toggleLiveEncouragement}
                  className={`rounded-md px-2.5 py-1.5 text-xs font-semibold ${liveCueSettings.enabled ? "bg-primary text-primary-foreground" : "border border-border bg-background text-foreground hover:bg-muted"}`}
                >
                  {liveCueSettings.enabled ? "Encouragement On" : "Turn On"}
                </button>
                <select
                  value={liveCueSettings.style}
                  onChange={(event) => setLiveCueSettings((previous) => ({ ...previous, style: event.target.value }))}
                  className="rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-semibold text-foreground"
                  aria-label="Sarah encouragement style"
                >
                  <option value="clinical_minimal">Clinical minimal</option>
                  <option value="sarah_soft">Warm encouragement</option>
                  <option value="intimate_coaching">Direct encouragement</option>
                </select>
              </SetupTile>
            )}

            {!captureIsBodyExploration && (
              <SetupTile
                icon={<Brain className="h-3.5 w-3.5 text-primary" />}
                label="Phase Watch"
                value={`${prediction.nearClimax}%`}
                helper={prediction.reason || prediction.label}
                active={prediction.nearClimax >= 35 || prediction.recovery >= 35}
              >
                <button
                  type="button"
                  onClick={() => setFocusView(true)}
                  className="rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-semibold text-foreground hover:bg-muted"
                >
                  Display View
                </button>
              </SetupTile>
            )}
          </div>

          {(hrSourceError || directH10Status.error || calibrationError || howlError) && (
            <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs leading-relaxed text-destructive">
              {[hrSourceError, directH10Status.error, calibrationError, howlError].filter(Boolean)[0]}
            </div>
          )}
        </div>
      )}

      {mediaPanel}

      {!focusView && !mainTelemetryView && showAdvancedSetupConsole && (
        <CollapsibleControlSection
          icon={HeartPulse}
          title="Heart-Rate Source Settings"
          helper="Switch providers, connect Direct H10, or update Pulsoid settings."
          status={hrConnected ? `${status?.hr?.sourceStatus?.label || "HR"} live` : "Needs attention"}
        >
          <HrSourceSelector
            settings={hrSourceSettings}
            status={status}
            recordingActive={recordingActive}
            saving={hrSourceSaving}
            error={hrSourceError}
            directStatus={directH10Status}
            onChange={updateHrSourceSettings}
            onApply={() => applyHrSourceSettings()}
            onConnectDirectH10={connectDirectH10}
            onDisconnectDirectH10={disconnectDirectH10}
            onForgetDirectH10={forgetDirectH10}
          />
        </CollapsibleControlSection>
      )}

      {!focusView && !mainTelemetryView && showAdvancedSetupConsole && <CollapsibleControlSection
        icon={CheckCircle2}
        title="Capture Readiness"
        helper="OBS is the session boundary; HR can run alone and EMG stays optional."
        status={recordingActive ? "Recording live" : hrConnected && obsReady ? "Ready" : "Review setup"}
        defaultOpen={!hrConnected || !obsReady}
      >
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-sm text-muted-foreground">Quick check before the recording window starts.</p>
          </div>
          <p className="text-xs text-muted-foreground">
            {recordingActive ? "Recording is live" : liveSession?.activeSessionId ? "Session shell ready" : "Waiting for capture start"}
          </p>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
          <ReadinessItem
            label="HR Source"
            value={hrConnected ? "Ready" : "Waiting"}
            helper={status?.hr?.sourceStatus?.message || (hrConnected ? "Live Capture is connected to the selected HR source." : status?.hr?.error || status?.hr?.url || "Start the Sarah server and HR source.")}
            ready={hrConnected}
          />
          <ReadinessItem
            label="Raw H10 Physiology"
            value={!directH10Source ? "N/A" : h10RawStreamsActive ? "Verified" : h10RawStreamFailure ? "Failed" : "Confirming"}
            helper={!directH10Source
              ? "Select Direct Polar H10 to collect ECG-derived respiration and chest motion."
              : h10RawStreamsActive
                ? `Real ECG and accelerometer packets are landing: ECG ${effectiveH10Multimodal?.streams?.ecg?.sampleCount || 0} · motion ${effectiveH10Multimodal?.streams?.accelerometer?.sampleCount || 0}.`
                : h10RawStreamFailure
                  ? `${directH10Status.pmdMessage}. Reconnect the H10 before recording if motion and respiration are required.`
                  : "Waiting for real ECG and accelerometer packets. Do not treat this as ready until it says Verified."}
            ready={h10RawStreamsActive}
            optional={!directH10Source}
          />
          <ReadinessItem
            label="OBS Sync"
            value={recordingPaused ? "Paused" : recordingActive ? "Recording" : obsReady ? "Ready" : embeddedObsStatus ? "Waiting" : "Relay connected"}
            helper={
              recordingPaused
                ? "Physiology persistence is paused; OBS Resume continues the same timestamped session."
                : recordingActive
                ? recording?.filename || "OBS recording is driving the live session."
                : embeddedObsStatus?.error
                  ? embeddedObsStatus.error
                  : embeddedObsStatus?.identified
                    ? "OBS websocket is ready to start a session."
                    : "OBS readiness appears once the embedded relay identifies."
            }
            ready={obsReady}
          />
          <ReadinessItem
            label="Voice Notes"
            value={voiceReady ? "Available" : "Unavailable"}
            helper={desktopWakeFallbackActive
              ? "Windows local wake listening is active in the EXE, and Record Now still handles the actual timestamped note."
              : voiceReady
                ? "Wake phrase and Record Now can timestamp annotations."
                : "This browser context cannot provide wake listening or microphone capture."}
            ready={voiceReady}
          />
          <ReadinessItem
            label="EMG Feed"
            value={emgRecent ? "Live" : "Optional"}
            helper={emgRecent ? status?.emg?.textDir || "Recent EMG telemetry is available." : "Start the EMG helper only when this session uses EMG."}
            ready={emgRecent}
            optional
          />
        </div>
      </CollapsibleControlSection>}

      {!focusView && !mainTelemetryView && showAdvancedSetupConsole && (
        <div className="rounded-xl border border-border bg-card">
          <button
            type="button"
            onClick={() => setHowlControlOpen((open) => !open)}
            className="grid w-full grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-2 p-4 text-left"
            aria-expanded={howlControlOpen}
          >
            <Zap className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wider text-primary">Howl Connection Setup</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Connect to Howl remote access, test /status, then unlock bounded manual controls.
              </p>
            </div>
            <ChevronDown className={`h-4 w-4 shrink-0 text-muted-foreground transition-transform ${howlControlOpen ? "rotate-180" : ""}`} />
            <span className={`col-start-2 max-w-full justify-self-start truncate rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
              howlControlEnabled ? "border-primary/35 bg-primary/10 text-primary" : "border-border bg-muted/30 text-muted-foreground"
            }`}>
              {howlControlModeLabel}
            </span>
          </button>
          {howlControlOpen && (
            <div className="space-y-4 border-t border-border p-4">
              <div className="grid gap-3 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
                <div className="rounded-lg border border-primary/20 bg-primary/[0.06] p-3">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <p className="text-sm font-semibold text-foreground">Howl Connection Setup</p>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        Open Howl settings on the phone, enable Allow remote access, then copy the remote access key here.
                      </p>
                    </div>
                    <span className={`rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider ${
                      howlConnectionSucceeded ? "bg-emerald-500/10 text-emerald-300" : "bg-muted text-muted-foreground"
                    }`}>
                      {howlConnectionSucceeded ? "Connection tested" : "Needs test"}
                    </span>
                  </div>

                  <div className="mt-4 space-y-4">
                    <div className="rounded-lg border border-border bg-background/70 p-3">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Step 1</p>
                      <p className="mt-1 text-sm font-semibold text-foreground">Enable remote access in Howl</p>
                      <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                        Open Howl settings, turn on Allow remote access, then copy the remote access key.
                      </p>
                    </div>

                    <label className="block space-y-1">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Step 2 · Phone IP or Howl URL</span>
                      <input
                        className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm"
                        value={howlControlForm.controlUrl}
                        placeholder="192.168.1.42 or http://192.168.1.42:4695"
                        onFocus={() => { howlFocusedFieldRef.current = "controlUrl"; }}
                        onBlur={() => { howlFocusedFieldRef.current = ""; }}
                        onChange={(event) => updateHowlControlForm({ controlUrl: event.target.value })}
                      />
                      <span className="block text-[11px] text-muted-foreground">Bridge target for the phone or helper that exposes Howl control endpoints.</span>
                      <span className="block text-[11px] text-muted-foreground">
                        URL preview: <span className="font-mono text-foreground">{howlControlUrlPreview || "http://PHONE_IP:4695"}</span>
                      </span>
                    </label>

                    <label className="block space-y-1">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Step 3 · Remote access key</span>
                      <input
                        className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm"
                        type="password"
                        value={howlControlForm.remoteAccessKey || ""}
                        placeholder="Paste Howl remote access key"
                        autoComplete="off"
                        onFocus={() => { howlFocusedFieldRef.current = "remoteAccessKey"; }}
                        onBlur={() => { howlFocusedFieldRef.current = ""; }}
                        onChange={(event) => updateHowlControlForm({ remoteAccessKey: event.target.value })}
                      />
                      <span className="block text-[11px] text-muted-foreground">Shared secret copied from Howl so PulsePoint can authenticate remote-control requests.</span>
                      <span className="block text-[11px] text-muted-foreground">Local setting: {maskHowlKey(howlControlForm.remoteAccessKey)}</span>
                    </label>

                    <div className="grid gap-2 sm:grid-cols-2">
                      <label className="space-y-1">
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Intensity ceiling</span>
                        <input
                          className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm"
                          type="number"
                          min="0"
                          max="100"
                          value={howlControlForm.intensityCeiling}
                          onChange={(event) => updateHowlControlForm({ intensityCeiling: event.target.value }, { resetConnection: false })}
                        />
                        <span className="block text-[11px] text-muted-foreground">Upper safety bound applied to manual commands and Sarah auto-control.</span>
                      </label>
                      <label className="space-y-1">
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Default dispatch</span>
                        <div className="flex h-10 items-center rounded-lg border border-border bg-background px-3 text-sm font-semibold text-foreground">
                          Direct HTTP
                        </div>
                        <span className="block text-[11px] text-muted-foreground">Primary command path: send requests straight to the configured Howl endpoint.</span>
                      </label>
                    </div>

                    <button
                      type="button"
                      onClick={() => setHowlAdvancedOpen((open) => !open)}
                      className="inline-flex items-center gap-1.5 text-xs font-semibold text-muted-foreground hover:text-foreground"
                    >
                      <ChevronDown className={`h-3.5 w-3.5 transition-transform ${howlAdvancedOpen ? "rotate-180" : ""}`} />
                      Advanced dispatch modes
                    </button>
                    {howlAdvancedOpen && (
                      <div className="rounded-lg border border-border bg-background/70 p-3">
                        <label className="space-y-1">
                          <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Dispatch mode</span>
                          <select
                            className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm"
                            value={howlControlForm.dispatchMode}
                            onChange={(event) => updateHowlControlForm({ dispatchMode: event.target.value }, { resetConnection: false })}
                          >
                            <option value="direct_http">Direct HTTP</option>
                            <option value="queue">Helper queue</option>
                            <option value="queue_and_direct">Queue + direct</option>
                          </select>
                          <span className="block text-[11px] text-muted-foreground">Choose whether commands go directly to Howl, through the helper queue, or both for redundancy.</span>
                        </label>
                        <p className="mt-2 text-[11px] text-muted-foreground">
                          Helper queue exposes commands at <span className="font-mono text-foreground">{howlHelperPollPath}</span>. Normal setup should stay on Direct HTTP.
                        </p>
                      </div>
                    )}
                  </div>

                  <div className="mt-4 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={testHowlConnection}
                      disabled={howlControlBusy === "test" || !howlControlForm.controlUrl || !howlRemoteKeyReady}
                      className="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      {howlControlBusy === "test" ? "Testing..." : "Test Howl Connection"}
                    </button>
                    <button
                      type="button"
                      onClick={() => saveHowlControlSettings()}
                      disabled={howlControlBusy === "settings"}
                      className="rounded-lg border border-border bg-background px-3 py-2 text-xs font-semibold text-foreground hover:bg-muted disabled:opacity-50"
                    >
                      {howlControlBusy === "settings" ? "Saving..." : "Save bridge settings"}
                    </button>
                    <button
                      type="button"
                      onClick={() => refreshHowlTelemetry({ forceSettings: true })}
                      disabled={howlRefreshing}
                      className="rounded-lg border border-border bg-background px-3 py-2 text-xs font-semibold text-foreground hover:bg-muted disabled:opacity-50"
                    >
                      {howlRefreshing ? "Checking..." : "Refresh state"}
                    </button>
                  </div>
                  {(howlSettingsDirty || howlConnectionTest.message) && (
                    <div className={`mt-3 rounded-lg border px-3 py-2 text-xs ${
                      howlConnectionTest.status === "ok"
                        ? "border-emerald-500/25 bg-emerald-500/10 text-emerald-300"
                        : howlConnectionTest.status === "error"
                          ? "border-destructive/30 bg-destructive/10 text-destructive"
                          : "border-border bg-background/70 text-muted-foreground"
                    }`}>
                      {howlConnectionTest.message || "Unsaved Howl settings."}
                    </div>
                  )}
                </div>

                <div className="rounded-lg border border-border bg-muted/20 p-3">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <p className="text-sm font-semibold text-foreground">Step 5 · Manual control</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Manual control unlocks after /status succeeds. Commands are capped at {fmtNumber(howlControlCeiling, 0)} server-side and client-side.
                      </p>
                    </div>
                    <button
                      type="button"
                      onClick={() => saveHowlControlSettings({ controlEnabled: !howlControlEnabled, sarahAutoEnabled: false })}
                      disabled={howlControlBusy === "settings" || (!howlControlEnabled && !howlConnectionSucceeded)}
                      className={`rounded-lg px-3 py-2 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
                        howlControlEnabled ? "bg-primary/15 text-primary hover:bg-primary/25" : "bg-primary text-primary-foreground hover:bg-primary/90"
                      }`}
                    >
                      {howlControlBusy === "settings" ? "Saving..." : howlControlEnabled ? "Disable manual control" : "Enable manual control"}
                    </button>
                  </div>

                  <div className="mt-3 grid gap-2 sm:grid-cols-2">
                    <label className="space-y-1 sm:col-span-2">
                      <span className="flex items-center justify-between text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        <span>Intensity ceiling</span>
                        <span>{fmtNumber(howlControlCeiling, 0)}</span>
                      </span>
                      <input
                        className="w-full accent-primary"
                        type="range"
                        min="0"
                        max="100"
                        step="1"
                        value={Math.max(0, Math.min(100, Number(howlControlForm.intensityCeiling) || 0))}
                        onChange={(event) => updateHowlControlForm({ intensityCeiling: Number(event.target.value) }, { resetConnection: false })}
                      />
                      <span className="block text-[11px] text-muted-foreground">Hard cap for manual and Sarah-driven intensity changes so the helper never ramps above this level.</span>
                    </label>
                    <label className="space-y-1 sm:col-span-2">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Howl activity mode</span>
                      <select
                        className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm"
                        value={selectedHowlActivity?.name || ""}
                        onChange={(event) => setHowlCommandForm((prev) => ({ ...prev, mode: event.target.value }))}
                      >
                        {HOWL_ACTIVITY_MODES.map((mode) => (
                          <option key={mode.name} value={mode.name}>{mode.displayName}</option>
                        ))}
                      </select>
                      {selectedHowlActivity && (
                        <span className="block text-[11px] text-muted-foreground">{selectedHowlActivity.description}</span>
                      )}
                    </label>
                  </div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => sendHowlControlCommand("load_activity", { activityName: selectedHowlActivity?.name, activityDisplayName: selectedHowlActivity?.displayName, play: false })}
                      disabled={!howlManualControlsUnlocked || Boolean(howlControlBusy) || !selectedHowlActivity}
                      className="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      Load activity
                    </button>
                    <button
                      type="button"
                      onClick={() => sendHowlControlCommand("increment_power", { channel: "a", step: 1 })}
                      disabled={!howlManualControlsUnlocked || Boolean(howlControlBusy)}
                      className="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      Power up A
                    </button>
                    <button
                      type="button"
                      onClick={() => sendHowlControlCommand("decrement_power", { channel: "a", step: 1 })}
                      disabled={!howlManualControlsUnlocked || Boolean(howlControlBusy)}
                      className="rounded-lg bg-primary/10 px-3 py-2 text-xs font-semibold text-primary hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      Power down A
                    </button>
                    <button
                      type="button"
                      onClick={() => sendHowlControlCommand("increment_power", { channel: "b", step: 1 })}
                      disabled={!howlManualControlsUnlocked || Boolean(howlControlBusy)}
                      className="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      Power up B
                    </button>
                    <button
                      type="button"
                      onClick={() => sendHowlControlCommand("decrement_power", { channel: "b", step: 1 })}
                      disabled={!howlManualControlsUnlocked || Boolean(howlControlBusy)}
                      className="rounded-lg bg-primary/10 px-3 py-2 text-xs font-semibold text-primary hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      Power down B
                    </button>
                    <button
                      type="button"
                      onClick={sendHowlEmergencyStop}
                      disabled={!howlControlEnabled || Boolean(howlControlBusy)}
                      className="rounded-lg bg-destructive px-3 py-2 text-xs font-semibold text-destructive-foreground hover:bg-destructive/90 disabled:cursor-not-allowed disabled:opacity-45"
                    >
                      Mute / emergency stop
                    </button>
                  </div>
                  {!howlManualControlsUnlocked && (
                    <p className="mt-3 rounded-lg border border-border bg-background/70 px-3 py-2 text-xs text-muted-foreground">
                      Test the Howl connection, then enable manual control. Closed-loop remains off until you explicitly arm it later.
                    </p>
                  )}
                  <details className="mt-3 rounded-lg border border-border bg-background/70 px-3 py-2 text-xs text-muted-foreground">
                    <summary className="cursor-pointer font-semibold text-foreground">Howl modes Sarah understands</summary>
                    <div className="mt-2 grid gap-2 sm:grid-cols-2">
                      {HOWL_ACTIVITY_MODES.map((mode) => (
                        <div key={mode.name} className="rounded-md border border-border/70 bg-muted/20 p-2">
                          <p className="font-semibold text-foreground">{mode.displayName}</p>
                          <p>{mode.description}</p>
                        </div>
                      ))}
                    </div>
                  </details>
                </div>
              </div>

              <div className="rounded-lg border border-primary/20 bg-primary/[0.045] p-3">
                <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
                  <div>
                    <p className="text-sm font-semibold text-foreground">Sarah multimodal threshold controller</p>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      Closed-loop stays off by default. Manual Howl control must be tested and enabled before Sarah can be armed.
                    </p>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      Sarah now stamps manual Howl mode and intensity changes into the active session timeline so later analysis can see when device control changed.
                    </p>
                  </div>
                  <button
                    type="button"
                    onClick={() => saveHowlControlSettings({ sarahAutoEnabled: !howlSarahAutoEnabled })}
                    disabled={!howlManualControlsUnlocked || howlControlBusy === "settings"}
                    className={`rounded-lg px-3 py-2 text-xs font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-45 ${
                      howlSarahAutoEnabled ? "bg-primary/15 text-primary hover:bg-primary/25" : "bg-primary text-primary-foreground hover:bg-primary/90"
                    }`}
                  >
                    {howlSarahAutoEnabled ? "Sarah auto off" : "Arm Sarah auto"}
                  </button>
                </div>

                <div className="mt-3 grid gap-2 md:grid-cols-5">
                  <label className="space-y-1">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Build starts</span>
                    <input
                      className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm"
                      type="number"
                      min="0"
                      max="100"
                      value={howlControlForm.buildThreshold}
                      onChange={(event) => updateHowlControlForm({ buildThreshold: event.target.value }, { resetConnection: false })}
                    />
                    <span className="block text-[11px] text-muted-foreground">Minimum Sarah approach score before auto-ramp is allowed to start nudging intensity upward.</span>
                  </label>
                  <label className="space-y-1">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Final approach</span>
                    <input
                      className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm"
                      type="number"
                      min="0"
                      max="100"
                      value={howlControlForm.nearClimaxThreshold}
                      onChange={(event) => updateHowlControlForm({ nearClimaxThreshold: event.target.value }, { resetConnection: false })}
                    />
                    <span className="block text-[11px] text-muted-foreground">Approach score where Sarah begins the bounded final-approach push instead of automatically reducing intensity.</span>
                  </label>
                  <label className="space-y-1">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Plateau gate</span>
                    <input
                      className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm"
                      type="number"
                      min="0"
                      max="100"
                      value={howlControlForm.plateauThreshold}
                      onChange={(event) => updateHowlControlForm({ plateauThreshold: event.target.value }, { resetConnection: false })}
                    />
                    <span className="block text-[11px] text-muted-foreground">Minimum sustained-load score before plateau is treated as a stable launch point.</span>
                  </label>
                  <label className="space-y-1">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Recovery</span>
                    <input
                      className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm"
                      type="number"
                      min="0"
                      max="100"
                      value={howlControlForm.recoveryThreshold}
                      onChange={(event) => updateHowlControlForm({ recoveryThreshold: event.target.value }, { resetConnection: false })}
                    />
                    <span className="block text-[11px] text-muted-foreground">Requires a corroborated HR drop, HRV opening, H10 recovery slope, or extended possible breath hold before retreat.</span>
                  </label>
                  <label className="space-y-1">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Final step</span>
                    <input
                      className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm"
                      type="number"
                      min="0"
                      max="10"
                      value={howlControlForm.finalApproachStep}
                      onChange={(event) => updateHowlControlForm({ finalApproachStep: event.target.value }, { resetConnection: false })}
                    />
                    <span className="block text-[11px] text-muted-foreground">Bounded step used during plateau, final approach, and recovery re-approach.</span>
                  </label>
                  <label className="space-y-1">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Step up</span>
                    <input
                      className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm"
                      type="number"
                      min="0"
                      max="10"
                      value={howlControlForm.buildStep}
                      onChange={(event) => updateHowlControlForm({ buildStep: event.target.value }, { resetConnection: false })}
                    />
                    <span className="block text-[11px] text-muted-foreground">How many intensity points Sarah adds per auto-ramp action while the build window is active.</span>
                  </label>
                  <label className="space-y-1">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Step down</span>
                    <input
                      className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm"
                      type="number"
                      min="0"
                      max="25"
                      value={howlControlForm.reduceStep}
                      onChange={(event) => updateHowlControlForm({ reduceStep: event.target.value }, { resetConnection: false })}
                    />
                    <span className="block text-[11px] text-muted-foreground">Size of each temporary retreat when recovery is physiologically corroborated.</span>
                  </label>
                  <label className="space-y-1">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Max retreat</span>
                    <input
                      className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm"
                      type="number"
                      min="0"
                      max="25"
                      value={howlControlForm.maxRecoveryRetreat}
                      onChange={(event) => updateHowlControlForm({ maxRecoveryRetreat: event.target.value }, { resetConnection: false })}
                    />
                    <span className="block text-[11px] text-muted-foreground">Hard limit below the highest intensity reached in the current build cycle.</span>
                  </label>
                  <label className="space-y-1">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Cooldown sec</span>
                    <input
                      className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm"
                      type="number"
                      min="2"
                      max="120"
                      value={howlControlForm.autoCooldownSeconds}
                      onChange={(event) => updateHowlControlForm({ autoCooldownSeconds: event.target.value }, { resetConnection: false })}
                    />
                    <span className="block text-[11px] text-muted-foreground">Minimum wait between Sarah auto-actions so intensity does not thrash up and down every telemetry refresh.</span>
                  </label>
                  <label className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-xs font-semibold text-muted-foreground md:col-span-2">
                    <input
                      type="checkbox"
                      checked={howlControlForm.finalApproachEnabled !== false}
                      onChange={(event) => updateHowlControlForm({ finalApproachEnabled: event.target.checked }, { resetConnection: false })}
                    />
                    <span>
                      Push through sustained plateau
                      <span className="block text-[11px] font-normal text-muted-foreground">Uses trusted multimodal plateau/threshold evidence to continue bounded increases toward the configured ceiling.</span>
                    </span>
                  </label>
                  <label className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-xs font-semibold text-muted-foreground md:col-span-2">
                    <input
                      type="checkbox"
                      checked={howlControlForm.buildRampEnabled !== false}
                      onChange={(event) => updateHowlControlForm({ buildRampEnabled: event.target.checked }, { resetConnection: false })}
                    />
                    <span>
                      Gradually increase during build
                      <span className="block text-[11px] font-normal text-muted-foreground">Lets Sarah use the build threshold plus Step up to gently ramp intensity during sustained loading.</span>
                    </span>
                  </label>
                  <label className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-xs font-semibold text-muted-foreground md:col-span-2">
                    <input
                      type="checkbox"
                      checked={howlControlForm.nearClimaxReductionEnabled !== false}
                      onChange={(event) => updateHowlControlForm({ nearClimaxReductionEnabled: event.target.checked }, { resetConnection: false })}
                    />
                    <span>
                      Protect retained cycle intensity
                      <span className="block text-[11px] font-normal text-muted-foreground">Prevents repeated recovery actions from walking intensity below the configured Max retreat from the cycle peak.</span>
                    </span>
                  </label>
                  <label className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-xs font-semibold text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={howlControlForm.recoveryReductionEnabled !== false}
                      onChange={(event) => updateHowlControlForm({ recoveryReductionEnabled: event.target.checked }, { resetConnection: false })}
                    />
                    <span>
                      Allow verified recovery retreat
                      <span className="block text-[11px] font-normal text-muted-foreground">Allows a shallow temporary reduction only when multiple physiological signals support recovery.</span>
                    </span>
                  </label>
                </div>

                <div className="mt-3 flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
                  <div className="rounded-lg border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
                    <span className="font-semibold text-foreground">Sarah status:</span> {howlAutoStatus}
                  </div>
                  <button
                    type="button"
                    onClick={() => saveHowlControlSettings()}
                    disabled={howlControlBusy === "settings"}
                    className="rounded-lg border border-border bg-background px-3 py-2 text-xs font-semibold text-foreground hover:bg-muted disabled:opacity-50"
                  >
                    Save Sarah controller
                  </button>
                </div>
              </div>

              <div className="grid gap-3 lg:grid-cols-2">
                <div className="rounded-lg border border-border bg-muted/20 p-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Latest Howl telemetry</p>
                  <p className="mt-1 text-sm font-semibold text-foreground">{howlLive ? howlModeSummary || "Howl sample received" : "No recent Howl sample"}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Telemetry ingest: <span className="font-mono text-foreground">{howlEndpointText}</span>
                  </p>
                </div>
                <div className="rounded-lg border border-border bg-muted/20 p-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Recent commands</p>
                  <div className="mt-2 space-y-1">
                    {howlCommandHistory.length ? howlCommandHistory.slice(0, 4).map((command) => (
                      <div key={command.id} className="flex items-center justify-between gap-2 rounded-md bg-card px-2 py-1.5 text-xs">
                        <span className="truncate text-foreground">{command.action} · {command.channel}{command.intensity != null ? ` · ${command.intensity}` : ""}</span>
                        <span className="shrink-0 text-muted-foreground">{command.status}</span>
                      </div>
                    )) : (
                      <p className="text-xs text-muted-foreground">No commands sent yet.</p>
                    )}
                  </div>
                </div>
              </div>

              {howlControlStatus && (
                <div className="rounded-lg border border-primary/25 bg-primary/10 px-3 py-2 text-xs text-primary">{howlControlStatus}</div>
              )}
              {howlError && (
                <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{howlError}</div>
              )}
            </div>
          )}
        </div>
      )}

      {!focusView && !mainTelemetryView && showAdvancedSetupConsole && voiceAnnotationPanel}

      {!focusView && captureMode !== "media" && (
        <div className="rounded-xl border border-border bg-card">
          <button
            type="button"
            onClick={() => setCalibrationOpen((open) => !open)}
            className="flex w-full items-start gap-3 p-4 text-left"
            aria-expanded={calibrationOpen}
          >
            <Activity className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wider text-primary">
                {usingPerinealEmgConfig ? "Perineal Body EMG Reference Capture" : "EMG Calibration Reference Capture"}
              </p>
              <p className="mt-1 text-sm text-muted-foreground">
                {usingPerinealEmgConfig
                  ? "Track best-effort perineal-body contraction changes from small electrodes with explicit calibration context."
                  : "Record neutral and intentional contraction references so later AI interpretation can recognize calibration maneuvers."}
              </p>
            </div>
            <ChevronDown className={`ml-auto h-4 w-4 shrink-0 text-muted-foreground transition-transform ${calibrationOpen ? "rotate-180" : ""}`} />
          </button>
          {calibrationOpen && (
            <div className="space-y-4 border-t border-border p-4">
              <div className="rounded-lg border border-primary/20 bg-primary/[0.06] p-3 text-xs text-muted-foreground">
                {selectedEmgConfig.calibrationIntro}
              </div>

              {usingPerinealEmgConfig && (
                <div className="rounded-lg border border-primary/25 bg-primary/[0.05] p-3">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-wider text-primary">Perineal contraction detector</p>
                      <p className="mt-1 text-xs text-muted-foreground">
                        Automatic Kegel markers are saved only while recording is active and this preset is selected.
                      </p>
                    </div>
                    <span className={`rounded-full border px-2 py-1 text-[10px] font-semibold uppercase tracking-wider ${
                      perinealSignalQuality.tone === "good"
                        ? "border-primary/30 bg-primary/10 text-primary"
                        : perinealSignalQuality.tone === "warn"
                          ? "border-amber-400/30 bg-amber-400/10 text-amber-300"
                          : "border-border bg-muted/30 text-muted-foreground"
                    }`}>
                      {perinealSignalQuality.label}
                    </span>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    <div className="rounded-md bg-card px-3 py-2">
                      <p className="text-[10px] text-muted-foreground">Current</p>
                      <p className="mt-1 font-mono text-lg font-semibold text-foreground">{leftEmgLevel != null ? `${fmtNumber(leftEmgLevel)}%` : "--"}</p>
                    </div>
                    <div className="rounded-md bg-card px-3 py-2">
                      <p className="text-[10px] text-muted-foreground">Baseline</p>
                      <p className="mt-1 font-mono text-lg font-semibold text-foreground">{fmtNumber(perinealCalibration.baseline_mean_pct)}%</p>
                    </div>
                    <div className="rounded-md bg-card px-3 py-2">
                      <p className="text-[10px] text-muted-foreground">Detect</p>
                      <p className="mt-1 font-mono text-lg font-semibold text-foreground">{fmtNumber(perinealCalibration.suggested_detection_threshold_pct)}%</p>
                    </div>
                    <div className="rounded-md bg-card px-3 py-2">
                      <p className="text-[10px] text-muted-foreground">State</p>
                      <p className="mt-1 text-sm font-semibold capitalize text-foreground">{perinealDetectorSnapshot.phase || "relaxed"}</p>
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
                    {[
                      ["Total", perinealDetectorSnapshot.counts?.total || 0],
                      ["Light", perinealDetectorSnapshot.counts?.light || 0],
                      ["Moderate", perinealDetectorSnapshot.counts?.moderate || 0],
                      ["Strong", perinealDetectorSnapshot.counts?.strong || 0],
                      ["Hold", perinealDetectorSnapshot.counts?.sustained || 0],
                    ].map(([label, value]) => (
                      <div key={label} className="rounded-md border border-border bg-muted/20 px-3 py-2">
                        <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
                        <p className="mt-1 font-mono text-base font-semibold text-foreground">{value}</p>
                      </div>
                    ))}
                  </div>
                  {perinealDetectorSnapshot.lastEvent && (
                    <p className="mt-3 rounded-md border border-border bg-card px-3 py-2 text-xs text-muted-foreground">
                      Last: <span className="font-semibold text-foreground">{perinealEventNote(perinealDetectorSnapshot.lastEvent)}</span>{" "}
                      at {fmtMmSs(perinealDetectorSnapshot.lastEvent.peak_time_s)} · peak {fmtNumber(perinealDetectorSnapshot.lastEvent.peak_pct)}% · {perinealDetectorSnapshot.lastEvent.confidence} confidence
                    </p>
                  )}
                  <div className="mt-3 rounded-md border border-border bg-card px-3 py-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <p className="text-sm font-semibold text-foreground">
                          {perinealProtocol.running
                            ? PERINEAL_EMG_PROTOCOL_PHASES[perinealProtocol.phaseIndex]?.label || "Protocol running"
                            : "Guided calibration/test protocol"}
                        </p>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {perinealProtocol.running
                            ? perinealProtocol.message
                            : "Runs baseline, light Kegels, strong Kegels, long hold, artifact checks, and final baseline."}
                        </p>
                      </div>
                      <div className="flex gap-2">
                        {perinealProtocol.running ? (
                          <button
                            type="button"
                            onClick={stopPerinealProtocol}
                            className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs font-semibold text-destructive"
                          >
                            Stop protocol
                          </button>
                        ) : (
                          <button
                            type="button"
                            onClick={startPerinealProtocol}
                            disabled={!emgRecent}
                            className="rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground disabled:cursor-not-allowed disabled:opacity-50"
                          >
                            Start Perineal EMG Test Protocol
                          </button>
                        )}
                      </div>
                    </div>
                    <div className="mt-3 grid gap-1.5">
                      {PERINEAL_EMG_PROTOCOL_PHASES.map((phase, index) => (
                        <div
                          key={phase.key}
                          className={`rounded border px-2 py-1.5 text-[10px] ${
                            perinealProtocol.running && index === perinealProtocol.phaseIndex
                              ? "border-primary/40 bg-primary/10 text-primary"
                              : "border-border bg-muted/20 text-muted-foreground"
                          }`}
                        >
                          <span className="font-semibold">{phase.label}</span>
                          <span className="ml-2">{phase.durationS}s</span>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}

              <div className="grid gap-3 sm:grid-cols-3">
                <div className="rounded-lg border border-border bg-muted/20 p-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{selectedEmgConfig.leftLabel}</p>
                  <p className="mt-1 text-2xl font-bold text-primary">{calibrationReading.left ? `${fmtNumber(calibrationReading.left.value)}%` : "—"}</p>
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    {calibrationReading.left ? `Recent spread ${fmtNumber(calibrationReading.left.spread)}%` : "No live sample"}
                  </p>
                </div>
                <div className="rounded-lg border border-border bg-muted/20 p-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{selectedEmgConfig.rightLabel}</p>
                  <p className="mt-1 text-2xl font-bold text-chart-2">{calibrationReading.right ? `${fmtNumber(calibrationReading.right.value)}%` : "—"}</p>
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    {calibrationReading.right ? `Recent spread ${fmtNumber(calibrationReading.right.spread)}%` : "Single channel or no sample"}
                  </p>
                </div>
                <div className="rounded-lg border border-border bg-muted/20 p-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Verification</p>
                  <p className="mt-1 text-sm font-semibold text-foreground">
                    {!calibrationReading.left && !calibrationReading.right
                      ? "Waiting for EMG"
                      : Math.max(calibrationReading.left?.spread || 0, calibrationReading.right?.spread || 0) <= 8
                        ? "Stable capture window"
                        : "Signal moving"}
                  </p>
                  <p className="mt-1 text-[10px] text-muted-foreground">
                    {calibrationReading.sampleCount
                      ? `${calibrationReading.sampleCount} recent sample${calibrationReading.sampleCount === 1 ? "" : "s"} averaged`
                      : "Hold the intended state briefly before saving."}
                  </p>
                </div>
              </div>

              <div className="grid gap-2 lg:grid-cols-2">
                {emgCalibrationSteps.map((step) => {
                  const requiresDualChannel = step.key === "left_max" || step.key === "right_max";
                  const hasReference = step.key === "neutral"
                    ? activeSessionDoc?.emg_rest_left != null || activeSessionDoc?.emg_rest_right != null
                    : step.key === "left_max"
                      ? activeSessionDoc?.emg_max_left != null
                      : step.key === "right_max"
                        ? activeSessionDoc?.emg_max_right != null
                        : activeSessionDoc?.emg_max_left != null && activeSessionDoc?.emg_max_right != null;
                  return (
                    <div key={step.key} className="rounded-lg border border-border bg-muted/20 p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div>
                          <p className="text-sm font-semibold text-foreground">{step.label}</p>
                          <p className="mt-1 text-xs text-muted-foreground">{step.instruction}</p>
                        </div>
                        {hasReference && (
                          <span className="rounded-full border border-primary/25 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                            Saved
                          </span>
                        )}
                      </div>
                      <button
                        type="button"
                        disabled={Boolean(calibrationSaving) || (!calibrationReading.left && !calibrationReading.right) || (requiresDualChannel && !calibrationReading.right)}
                        onClick={() => captureEmgCalibrationReference(step)}
                        className="mt-3 inline-flex items-center gap-1.5 rounded-lg bg-primary/10 px-3 py-2 text-xs font-semibold text-primary transition-colors hover:bg-primary/20 disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        {calibrationSaving === step.key ? (
                          <span className="h-3 w-3 animate-spin rounded-full border-2 border-primary border-t-transparent" />
                        ) : (
                          <CircleDot className="h-3.5 w-3.5" />
                        )}
                        {calibrationSaving === step.key ? "Sending command..." : "Apply calibration now"}
                      </button>
                      {requiresDualChannel && !calibrationReading.right && (
                        <p className="mt-2 text-[10px] text-muted-foreground">Requires the dual-channel EMG feed.</p>
                      )}
                    </div>
                  );
                })}
              </div>

              {(activeSessionDoc?.emg_rest_left != null || activeSessionDoc?.emg_max_left != null || activeSessionDoc?.emg_rest_right != null || activeSessionDoc?.emg_max_right != null) && (
                <div className="rounded-lg border border-border bg-muted/20 p-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Stored Raw Calibration Values</p>
                  <div className="mt-2 grid grid-cols-2 gap-2 sm:grid-cols-4">
                    {[
                      [usingPerinealEmgConfig ? "Perineal baseline" : "Left neutral", activeSessionDoc?.emg_rest_left],
                      [usingPerinealEmgConfig ? "Aux baseline" : "Right neutral", activeSessionDoc?.emg_rest_right],
                      [usingPerinealEmgConfig ? "Perineal max" : "Left max", activeSessionDoc?.emg_max_left],
                      [usingPerinealEmgConfig ? "Aux max" : "Right max", activeSessionDoc?.emg_max_right],
                    ].map(([label, value]) => (
                      <div key={label} className="rounded-md bg-card px-3 py-2">
                        <p className="text-[10px] text-muted-foreground">{label}</p>
                        <p className="mt-1 font-mono text-sm font-semibold text-foreground">{value != null ? fmtNumber(value) : "—"}</p>
                      </div>
                    ))}
                  </div>
                  {activeSessionDoc?.emg_left_right_flipped && (
                    <p className="mt-2 text-xs text-amber-300">Left/right channel flip is enabled for this session; interpret displayed sides using that saved orientation.</p>
                  )}
                </div>
              )}

              {calibrationCommandStatus && (
                <div className={`rounded-lg border px-3 py-3 text-xs ${
                  calibrationCommandStatus.status === "applied"
                    ? "border-primary/25 bg-primary/10"
                    : calibrationCommandStatus.status === "rejected"
                      ? "border-destructive/30 bg-destructive/10"
                      : "border-border bg-muted/20"
                }`}>
                  <div className="flex items-center justify-between gap-2">
                    <p className="font-semibold uppercase tracking-wider text-foreground">EMG Helper Status</p>
                    <span className="rounded-full border border-current/20 px-2 py-0.5 font-semibold uppercase tracking-wider">
                      {calibrationCommandStatus.status}
                    </span>
                  </div>
                  <p className="mt-2 text-muted-foreground">{calibrationCommandStatus.message}</p>
                  {calibrationCommandStatus.status === "applied" && calibrationCommandStatus.calibration && (
                    <p className="mt-2 text-muted-foreground">
                      Raw calibration:{" "}
                      {calibrationCommandStatus.calibration.rest_l != null
                        ? `left ${fmtNumber(calibrationCommandStatus.calibration.rest_l)} / ${fmtNumber(calibrationCommandStatus.calibration.max_l)}, right ${fmtNumber(calibrationCommandStatus.calibration.rest_r)} / ${fmtNumber(calibrationCommandStatus.calibration.max_r)}`
                        : `rest ${fmtNumber(calibrationCommandStatus.calibration.rest)} / max ${fmtNumber(calibrationCommandStatus.calibration.max_contract)}`}
                    </p>
                  )}
                </div>
              )}

              {calibrationStatus && (
                <div className="rounded-lg border border-primary/25 bg-primary/10 px-3 py-2 text-xs text-primary">{calibrationStatus}</div>
              )}
              {calibrationError && (
                <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">{calibrationError}</div>
              )}
            </div>
          )}
        </div>
      )}

      {captureMode !== "media" && (
        <>
      {!focusView && !mainTelemetryView && showAdvancedSetupConsole && <CollapsibleControlSection
        icon={Radio}
        title="Connection Details"
        helper="Relay, provider, EMG, and OBS status for troubleshooting."
        status={connected && hrConnected ? "Core feeds connected" : "Review connections"}
      >
        <div className={`grid gap-3 ${emgLive ? "md:grid-cols-4" : "md:grid-cols-3"}`}>
          <MetricCard icon={<Radio className="w-4 h-4" />} label="Sarah Stream" value={connected ? "Live" : "Offline"} helper="App telemetry bridge" active={connected} />
          <MetricCard icon={<HeartPulse className="w-4 h-4" />} label="HR Source" value={hrConnected ? "Connected" : "Waiting"} helper={status?.hr?.sourceStatus?.label || status?.hr?.url || "ws://127.0.0.1:8765"} active={hrConnected} />
          {emgLive && <MetricCard icon={<Activity className="w-4 h-4" />} label="EMG Feed" value="Live" helper={status?.emg?.textDir || "EMG text files"} active />}
          <MetricCard
            icon={<Video className="w-4 h-4" />}
            label="OBS Recording"
            value={recordingPaused ? "Paused" : recordingActive ? "Recording" : "Stopped"}
            helper={recordingPaused ? "Same session remains open; resume in OBS when ready." : recording?.filename || "No active capture"}
            active={recordingActive}
          />
        </div>
      </CollapsibleControlSection>}

      {!focusView && !mainTelemetryView && showAdvancedSetupConsole && <div className="rounded-xl border border-border bg-card p-4">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-primary flex items-center gap-1.5">
              <FileText className="w-4 h-4" /> Live Session
            </p>
            <p className="mt-1 text-sm text-muted-foreground">
              {liveSession?.activeSessionId
                ? liveSession.importing
                  ? "Finalizing telemetry and attaching capture files…"
                  : liveSession.active
                    ? recordingPaused
                      ? "OBS is paused. Sarah is preserving this break and will resume the same session."
                      : "Recording into a new Sarah session shell."
                    : "Capture session ready for review and detail entry."
                : "A new session will be created automatically when OBS recording starts."}
            </p>
            {liveSession?.lastImportError && (
              <p className="mt-1 text-xs text-destructive">{liveSession.lastImportError}</p>
            )}
            {liveSession?.lastImportResult && (
              <p className="mt-1 text-xs text-muted-foreground">
                HR rows {liveSession.lastImportResult.hr_rows || 0}
                {liveSession.lastImportResult.emg_attached ? " · EMG attached" : " · EMG pending"}
              </p>
            )}
            {liveSessionPaused && (
              <p className="mt-2 rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-200">
                {recordingPaused
                  ? `OBS paused at ${new Date(liveSession?.pausedAt || Date.now()).toLocaleTimeString()}. Sarah is not saving physiology during the break; Resume Recording in OBS continues this same session with a timestamped boundary.`
                  : "OBS is not actively recording, but this live session is still open. Start OBS again to add another segment or press End Session."}
              </p>
            )}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {!liveSession?.activeSessionId && (
              <button
                type="button"
                onClick={ensureSession}
                className="rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
              >
                Create Session Shell
              </button>
            )}
            {liveSession?.activeSessionId && (
              <Link
                to={`/sessions/${liveSession.activeSessionId}`}
                className="inline-flex items-center gap-1.5 rounded-lg bg-muted px-3 py-2 text-sm font-semibold text-foreground hover:bg-muted/80"
              >
                <ExternalLink className="h-4 w-4" /> Open Session
              </Link>
            )}
            {liveSession?.activeSessionId && liveSession?.active && (
              <button
                type="button"
                onClick={endLiveSession}
                disabled={endingSession}
                className="inline-flex items-center gap-1.5 rounded-lg bg-destructive px-3 py-2 text-sm font-semibold text-destructive-foreground hover:bg-destructive/90 disabled:opacity-60"
              >
                <X className="h-4 w-4" /> {endingSession ? "Ending..." : "End Session"}
              </button>
            )}
          </div>
        </div>
        {captureDigest && (
          <div className="mt-4 grid gap-3 border-t border-border pt-4 lg:grid-cols-[1.1fr_0.9fr]">
            <div className="rounded-lg border border-border bg-muted/25 p-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-primary">Post-Capture Review</p>
              <div className="mt-3 grid gap-2 sm:grid-cols-4">
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Duration</p>
                  <p className="text-lg font-bold text-foreground">{captureDigest.duration_text || "—"}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Avg HR</p>
                  <p className="text-lg font-bold text-foreground">{captureDigest.avg_hr || "—"}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Peak HR</p>
                  <p className="text-lg font-bold text-foreground">{captureDigest.peak_hr || "—"}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Rows</p>
                  <p className="text-lg font-bold text-foreground">{captureDigest.hr_rows || 0}</p>
                </div>
              </div>
              {postCaptureWrap && (
                <div className="mt-3 grid gap-2 sm:grid-cols-4">
                  <div>
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Events</p>
                    <p className="text-lg font-bold text-foreground">{postCaptureWrap.totalEvents}</p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Quick Pads</p>
                    <p className="text-lg font-bold text-foreground">{postCaptureWrap.quickPadEvents}</p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground">BP Stamps</p>
                    <p className="text-lg font-bold text-foreground">{postCaptureWrap.bpCount}</p>
                  </div>
                  <div>
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Artifacts</p>
                    <p className="text-lg font-bold text-foreground">{postCaptureWrap.artifactCount}</p>
                  </div>
                </div>
              )}
              <div className="mt-3 flex flex-wrap gap-1.5">
                {(captureDigest.findings || []).slice(0, 8).map((finding) => (
                  <span key={finding} className="rounded-full bg-primary/10 px-2 py-1 text-[10px] font-medium text-primary">
                    {finding}
                  </span>
                ))}
              </div>
              {postCaptureWrap?.phaseMoments?.length > 0 && (
                <div className="mt-3 flex flex-wrap gap-1.5">
                  {postCaptureWrap.phaseMoments.map((moment) => (
                    <span key={moment.label} className="rounded-full border border-primary/20 bg-background/70 px-2 py-1 text-[10px] font-semibold text-foreground">
                      {moment.label} {fmtMmSs(moment.timeS)}
                    </span>
                  ))}
                </div>
              )}
            </div>
            <div className="space-y-3">
              <div className="rounded-lg border border-border bg-muted/25 p-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Review Queue</p>
                <div className="mt-2 space-y-1.5">
                  {(captureDigest.review_items || []).map((item) => (
                    <div key={item} className="flex gap-2 text-xs text-muted-foreground">
                      <Flag className="mt-0.5 h-3.5 w-3.5 shrink-0 text-primary" />
                      <span>{item}</span>
                    </div>
                  ))}
                </div>
              </div>
              {postCaptureWrap?.notableEvents?.length > 0 && (
                <div className="rounded-lg border border-border bg-muted/25 p-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Recent Markers</p>
                  <div className="mt-2 space-y-2">
                    {postCaptureWrap.notableEvents.map((event, index) => (
                      <div key={`${event.time_s}-${index}`} className="rounded-lg bg-card/70 px-3 py-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="font-mono text-[10px] font-semibold text-primary">{fmtMmSs(event.time_s)}</span>
                          <span className="text-[10px] text-muted-foreground">{asArray(event.category).slice(0, 2).join(" · ") || "event"}</span>
                        </div>
                        <p className="mt-1 line-clamp-2 text-xs text-foreground">{event.note || event.label || "Event note"}</p>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>}

      {!focusView && !mainTelemetryView && showAdvancedSetupConsole && (
        <CollapsibleControlSection
          icon={Footprints}
          title="Lower-Body Tracking"
          helper="Optional foot and leg landmark capture"
          status={recordingActive ? "Session active" : "Optional"}
        >
          <LiveFootLandmarkTracker
            sessionId={liveSession?.activeSessionId}
            recordingActive={recordingActive}
            getSessionTimeS={getCurrentSessionTime}
            onTrackingSnapshot={handleFootTrackingSnapshot}
            compact
          />
        </CollapsibleControlSection>
      )}

      <div
        className={`rounded-xl border border-border bg-card ${distanceTelemetryView ? "p-5 md:p-6 space-y-6" : "p-4 space-y-4"} ${focusView ? "fixed inset-0 z-[60] h-screen overflow-y-auto rounded-none border-0 p-5 md:p-7" : ""}`}
        style={focusView ? {
          "--background": "204 46% 7%",
          "--card": "204 38% 11%",
          "--popover": "204 38% 11%",
          "--foreground": "198 33% 96%",
          "--muted": "204 26% 18%",
          "--muted-foreground": "199 18% 70%",
          "--border": "199 28% 25%",
        } : undefined}
      >
        <div className="flex items-center justify-between gap-3">
          <h3 className={`${focusView ? "text-2xl md:text-3xl" : distanceTelemetryView ? "text-lg" : "text-xs"} font-semibold uppercase tracking-wider text-primary flex items-center gap-2`}>
            <CircleDot className={distanceTelemetryView ? "w-6 h-6" : "w-4 h-4"} /> Live Telemetry
            {focusView && <span className="ml-2 font-mono text-xl font-medium tracking-normal text-muted-foreground">{new Date(liveHealthNowMs).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" })}</span>}
          </h3>
          <div className="flex flex-wrap items-center justify-end gap-2">
            <span className={`${distanceTelemetryView ? "text-sm" : "text-[10px]"} text-muted-foreground`}>
              HR {fmtTime(status?.hr?.lastMessageAt)}{telemetryEmgLive ? ` · EMG ${fmtTime(status?.emg?.lastMessageAt || status?.emg?.lastPollAt)}` : ""}
            </span>
            <label className="inline-flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm font-semibold text-foreground">
              <input
                type="checkbox"
                checked={heartbeatAudioEnabled}
                onChange={async (event) => {
                  const enabled = event.target.checked;
                  setHeartbeatAudioEnabled(enabled);
                  if (enabled) {
                    await getHeartbeatAudioContext();
                    triggerHeartbeatPulse(latestHrRef.current);
                  }
                }}
                className="h-4 w-4 accent-rose-400"
              />
              Beat beep
            </label>
            {focusView && (
              <>
                <label className="inline-flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-sm font-semibold text-foreground">
                  <input
                    type="checkbox"
                    checked={telemetryNoticesEnabled}
                    onChange={(event) => setTelemetryNoticesEnabled(event.target.checked)}
                    className="h-4 w-4 accent-primary"
                  />
                  Live notices
                </label>
                <button
                  type="button"
                  onClick={() => setTelemetryDashboardOpen(true)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-muted px-3 py-2 text-sm font-semibold text-foreground hover:bg-muted/80"
                >
                  <SlidersHorizontal className="h-4 w-4" /> Customize display
                </button>
                <button
                  type="button"
                  onClick={() => setFocusView(false)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-muted px-3 py-2 text-sm font-semibold text-foreground hover:bg-muted/80"
                >
                  <X className="h-4 w-4" /> Exit Display View
                </button>
              </>
            )}
          </div>
        </div>

        {telemetryDashboardOpen && (
          <div className="fixed inset-0 z-[80] flex items-start justify-end bg-black/55 p-4 pt-20 md:p-7 md:pt-24" onMouseDown={() => setTelemetryDashboardOpen(false)}>
            <div className="max-h-[calc(100vh-7rem)] w-full max-w-xl overflow-y-auto rounded-2xl border border-border bg-card p-5 shadow-2xl" onMouseDown={(event) => event.stopPropagation()}>
              <div className="flex items-start justify-between gap-4">
                <div>
                  <p className="text-xs font-bold uppercase tracking-[0.16em] text-primary">Custom telemetry dashboard</p>
                  <p className="mt-1 text-sm text-muted-foreground">Choose the blocks you want and put them in viewing order. This device remembers the layout.</p>
                </div>
                <button type="button" onClick={() => setTelemetryDashboardOpen(false)} className="rounded-lg bg-muted p-2 text-muted-foreground hover:text-foreground" aria-label="Close dashboard customization">
                  <X className="h-4 w-4" />
                </button>
              </div>
              <div className="mt-5 space-y-2">
                {telemetryDashboard.map((item, index) => {
                  const definition = TELEMETRY_DASHBOARD_PANELS.find((panel) => panel.id === item.id);
                  if (!definition) return null;
                  return (
                    <div key={item.id} className={`flex items-center gap-3 rounded-xl border p-3 ${item.enabled ? "border-primary/30 bg-primary/[0.07]" : "border-border bg-muted/20"}`}>
                      <input
                        type="checkbox"
                        checked={item.enabled}
                        onChange={(event) => updateTelemetryPanel(item.id, { enabled: event.target.checked })}
                        className="h-5 w-5 shrink-0 accent-primary"
                        aria-label={`Show ${definition.label}`}
                      />
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold text-foreground">{definition.label}</p>
                        <p className="text-xs text-muted-foreground">{definition.helper}</p>
                      </div>
                      <button type="button" disabled={index === 0} onClick={() => moveTelemetryPanel(item.id, -1)} className="rounded-lg border border-border p-2 text-foreground disabled:opacity-25" aria-label={`Move ${definition.label} up`}>
                        <MoveUp className="h-4 w-4" />
                      </button>
                      <button type="button" disabled={index === telemetryDashboard.length - 1} onClick={() => moveTelemetryPanel(item.id, 1)} className="rounded-lg border border-border p-2 text-foreground disabled:opacity-25" aria-label={`Move ${definition.label} down`}>
                        <MoveDown className="h-4 w-4" />
                      </button>
                    </div>
                  );
                })}
              </div>
              <div className="mt-5 flex items-center justify-between border-t border-border pt-4">
                <button type="button" onClick={() => setTelemetryDashboard(defaultTelemetryDashboard())} className="rounded-lg border border-border px-3 py-2 text-sm font-semibold text-foreground hover:bg-muted">Reset default</button>
                <button type="button" onClick={() => setTelemetryDashboardOpen(false)} className="rounded-lg bg-primary px-4 py-2 text-sm font-bold text-primary-foreground">Use this dashboard</button>
              </div>
            </div>
          </div>
        )}

        <div className="flex flex-col gap-6">

        {telemetryPanelEnabled("notices") && telemetryNoticesEnabled && latestTelemetryNotice && (
          <div
            className={`rounded-xl border border-primary/40 bg-primary/10 shadow-lg ${distanceTelemetryView ? "p-6" : "p-4"}`}
            style={{ order: telemetryPanelOrder("notices") }}
            role="status"
            aria-live="polite"
          >
            <div className="flex min-w-0 items-start gap-3">
              <Brain className={`${distanceTelemetryView ? "h-8 w-8" : "h-6 w-6"} mt-0.5 shrink-0 text-primary`} />
              <div className="min-w-0 flex-1">
                <p className={`font-bold tracking-normal text-foreground ${distanceTelemetryView ? "text-3xl md:text-4xl" : "text-xl md:text-2xl"}`}>
                  {latestTelemetryNotice.label}
                </p>
                <p className={`mt-2 leading-snug text-muted-foreground ${distanceTelemetryView ? "text-xl md:text-2xl" : "text-base md:text-lg"}`}>
                  {latestTelemetryNotice.message}
                </p>
                <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1 text-xs font-semibold text-primary">
                  {Number.isFinite(Number(latestTelemetryNotice.confidence)) && (
                    <span>{Math.round(Number(latestTelemetryNotice.confidence))}% confidence</span>
                  )}
                  {Number.isFinite(Number(latestTelemetryNotice.sessionTimeSec)) && (
                    <span>{fmtMmSs(latestTelemetryNotice.sessionTimeSec)}</span>
                  )}
                  <span>{latestTelemetryNotice.spoken ? "Sarah announced this cue" : "Visual cue only"}</span>
                </div>
              </div>
            </div>
          </div>
        )}

        {telemetryPanelEnabled("engine") && <div className="grid gap-2 rounded-lg border border-border bg-muted/20 p-3 text-xs sm:grid-cols-2 lg:grid-cols-6" style={{ order: telemetryPanelOrder("engine") }}>
          <div className="flex items-center gap-2">
            {engineRunning ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <AlertTriangle className="h-4 w-4 text-amber-500" />}
            <div>
              <p className="font-semibold text-foreground">Engine</p>
              <p className="text-muted-foreground">{engineRunning ? "Running" : "Waiting"}</p>
            </div>
          </div>
          <div>
            <p className="font-semibold text-foreground">Rates</p>
            <p className="text-muted-foreground">HR {fmtNumber(engineStatus?.sampleRate?.hrHz, 1)} Hz · EMG {fmtNumber(engineStatus?.sampleRate?.emgHz, 1)} Hz</p>
          </div>
          <div>
            <p className="font-semibold text-foreground">Latest HR</p>
            <p className="text-muted-foreground">{fmtAgeMs(engineStatus?.latest?.hrAgeMs)} old</p>
          </div>
          <div>
            <p className="font-semibold text-foreground">Buffer</p>
            <p className="text-muted-foreground">{engineBufferPct}% used · queue {engineStatus?.queue?.pending ?? 0}</p>
          </div>
          <div>
            <p className="font-semibold text-foreground">Display</p>
            <p className="text-muted-foreground">{engineStatus?.display?.droppedDisplayUpdates ?? 0} dropped frames</p>
          </div>
          <div className="flex items-center gap-2">
            {engineStorageOk ? <CheckCircle2 className="h-4 w-4 text-emerald-500" /> : <AlertTriangle className="h-4 w-4 text-amber-500" />}
            <div>
              <p className="font-semibold text-foreground">Storage</p>
              <p className="text-muted-foreground">{engineStorageOk ? "OK" : engineStatus?.storage?.lastError || engineStatus?.queue?.lastWarning || "Review"}</p>
            </div>
          </div>
        </div>}

        {telemetryPanelEnabled("howl") && <div className="rounded-xl border border-cyan-400/25 bg-cyan-500/[0.06] p-4 shadow-sm" style={{ order: telemetryPanelOrder("howl") }}>
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
            <div className="min-w-0">
              <div className="flex flex-wrap items-center gap-2">
                <p className="flex items-center gap-2 text-sm font-bold uppercase tracking-[0.16em] text-cyan-500">
                  <Zap className="h-5 w-5" /> Howl Control
                </p>
                <span className={`rounded-full px-2 py-1 text-[10px] font-bold uppercase tracking-wider ${howlSarahAutoEnabled ? "bg-primary/20 text-primary" : howlManualControlsUnlocked ? "bg-emerald-500/15 text-emerald-500" : "bg-muted text-muted-foreground"}`}>
                  {howlSarahAutoEnabled ? "Sarah auto armed" : howlManualControlsUnlocked ? "Manual ready" : "Locked"}
                </span>
              </div>
              <p className="mt-1 truncate text-sm text-muted-foreground">{howlDisplayStatus}</p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <select
                value={howlCommandForm.channel || "a"}
                onChange={(event) => setHowlCommandForm((previous) => ({ ...previous, channel: event.target.value }))}
                className="h-11 rounded-lg border border-border bg-card px-3 text-sm font-bold text-foreground"
                aria-label="Howl control channel"
              >
                <option value="a">Channel A</option>
                <option value="b">Channel B</option>
                <option value="all">Both channels</option>
              </select>
              <span className="min-w-20 rounded-lg border border-border bg-card px-4 py-2 text-center font-mono text-2xl font-bold tabular-nums text-foreground">
                {fmtNumber(howlSelectedChannelIntensity, 0)}
              </span>
              <button type="button" onClick={() => sendHowlControlCommand("decrement_power", { channel: howlCommandForm.channel || "a", step: 1 })} disabled={!howlManualControlsUnlocked || Boolean(howlControlBusy)} className="h-11 rounded-lg border border-border bg-card px-4 text-lg font-bold text-foreground disabled:opacity-40">-</button>
              <button type="button" onClick={() => sendHowlControlCommand("increment_power", { channel: howlCommandForm.channel || "a", step: 1 })} disabled={!howlManualControlsUnlocked || Boolean(howlControlBusy)} className="h-11 rounded-lg bg-primary px-4 text-lg font-bold text-primary-foreground disabled:opacity-40">+</button>
              <button type="button" onClick={sendHowlEmergencyStop} disabled={!howlControlEnabled || Boolean(howlControlBusy)} className="h-11 rounded-lg bg-destructive px-4 text-sm font-bold text-destructive-foreground disabled:opacity-40">Mute</button>
              <button type="button" onClick={() => setHowlQuickModalOpen(true)} className="h-11 rounded-lg border border-border bg-muted px-4 text-sm font-bold text-foreground">Details</button>
            </div>
          </div>
        </div>}

        {telemetryPanelEnabled("vitals") && <div className={`grid gap-3 sm:grid-cols-2 ${focusView ? "xl:grid-cols-3 2xl:grid-cols-5" : telemetryEmgLive || hrTelemetry?.source === "direct_h10" ? "lg:grid-cols-4 xl:grid-cols-5" : "lg:grid-cols-3"}`} style={{ order: telemetryPanelOrder("vitals") }}>
          <MetricCard icon={<HeartPulse className="w-4 h-4" />} label="Current HR" value={fmtNumber(hrTelemetry?.currentHr, 0)} helper="beats per minute" active={hrTelemetry?.currentHr != null} level={currentHrLevel} large display={focusView} beatPulse={visibleHeartbeatPulseId} />
          <MetricCard icon={<Activity className="w-4 h-4" />} label="Blood Pressure" value={latestBpValue} helper={latestBpHelper} active={Boolean(latestBpReading)} valueClassName={focusView ? "!text-[clamp(3rem,5vw,6rem)]" : "!text-[clamp(2rem,8vw,3rem)]"} large display={focusView} />
          {!captureIsBodyExploration && (
            <>
              <MetricCard icon={<Zap className="w-4 h-4" />} label="Build Confidence" value={`${fmtNumber(hrTelemetry?.buildConfidence, 0)}%`} helper={hrTelemetry?.phase || "No HR phase"} active={Number(hrTelemetry?.buildConfidence) > 40} level={buildLevel} large display={focusView} />
              <MetricCard
                icon={<Brain className="w-4 h-4" />}
                label="AI Magic"
                value={`${prediction.nearClimax}%`}
                helper={prediction.confidenceBand}
                active={prediction.nearClimax >= 42}
                level={prediction.nearClimax}
                large
                display={focusView}
              />
            </>
          )}
          {hrTelemetry?.source === "direct_h10" && (
            <>
              <MetricCard icon={<HeartPulse className="w-4 h-4" />} label="RR Samples" value={fmtNumber(rrCount, 0)} helper="rolling H10 interval window" active={Number(rrCount) > 0} level={Math.min(100, (Number(rrCount) || 0) * 1.25)} large display={focusView} />
              <MetricCard icon={<Activity className="w-4 h-4" />} label="RMSSD" value={fmtNumber(hrvRmssd, 1)} helper={hrvQuality ? `HRV quality: ${hrvQuality}` : "waiting for RR window"} active={hrvRmssd != null} level={hrvQuality === "high" ? 90 : hrvQuality === "moderate" ? 65 : hrvQuality === "low" ? 35 : 0} large display={focusView} />
              <MetricCard
                icon={<Activity className="w-4 h-4" />}
                label="Respiration"
                value={h10Respiration.possibleBreathHold ? "HOLD?" : h10Respiration.available ? fmtNumber(h10Respiration.bpm, 1) : h10RawStreamsActive ? "WARMING" : "NO PMD"}
                helper={h10Respiration.available ? `breaths/min · ${h10Respiration.confidence} confidence${h10Respiration.possibleBreathHold ? " · possible 4 s hold" : ""}` : h10RawStreamsActive ? `withheld · ${(h10Respiration.reason || "collecting sensor window").replaceAll?.("_", " ")}` : "ECG and accelerometer stream unavailable"}
                active={h10Respiration.available}
                level={h10Respiration.available ? (h10Respiration.confidence === "high" ? 90 : 65) : 0}
                large
                display={focusView}
                valueClassName={!h10Respiration.available && focusView ? "!text-[clamp(2.5rem,4vw,4.5rem)]" : ""}
              />
              <MetricCard
                icon={<Radio className="w-4 h-4" />}
                label="Chest Motion"
                value={h10Motion.dynamicRmsMilliG != null ? fmtNumber(h10Motion.dynamicRmsMilliG, 0) : h10RawStreamsActive ? "WARMING" : "NO PMD"}
                helper={h10Motion.available ? `mg RMS · ${(h10Motion.class || "").replaceAll?.("_", " ")}` : h10RawStreamsActive ? "collecting H10 accelerometer window" : "H10 accelerometer stream unavailable"}
                active={h10Motion.available}
                level={h10Motion.available ? Math.min(100, Number(h10Motion.dynamicRmsMilliG || 0) / 3.6) : 0}
                large
                display={focusView}
                valueClassName={!h10Motion.available && focusView ? "!text-[clamp(2.5rem,4vw,4.5rem)]" : ""}
              />
              <MetricCard
                icon={<RefreshCw className="w-4 h-4" />}
                label="Recovery"
                value={h10Recovery.available ? `-${fmtNumber(h10Recovery.currentDropBpm, 0)}` : "LEARNING"}
                helper={h10Recovery.available ? `bpm from ${fmtNumber(h10Recovery.peakHr, 0)} peak · ${fmtNumber(h10Recovery.secondsSincePeak, 0)} s` : "learns after a sustained HR peak"}
                active={h10Recovery.available}
                level={h10Recovery.available ? Math.min(100, Number(h10Recovery.currentDropBpm || 0) * 5) : 0}
                large
                display={focusView}
                valueClassName={!h10Recovery.available && focusView ? "!text-[clamp(2.5rem,4vw,4.5rem)]" : ""}
              />
            </>
          )}
          {telemetryEmgLive && (
            <>
              <MetricCard icon={<Activity className="w-4 h-4" />} label={selectedEmgConfig.leftLabel} value={`${fmtNumber(emgTelemetry?.left_pct ?? emgTelemetry?.level_pct)}%`} helper={selectedEmgConfig.leftHelper} active={(emgTelemetry?.left_pct ?? emgTelemetry?.level_pct) != null} level={leftEmgLevel} large display={focusView} />
              <MetricCard icon={<Activity className="w-4 h-4" />} label={selectedEmgConfig.rightLabel} value={`${fmtNumber(emgTelemetry?.right_pct)}%`} helper={emgTelemetry?.right_pct != null ? `diff ${fmtNumber(emgTelemetry?.diff_pct)}%` : selectedEmgConfig.rightHelper} active={emgTelemetry?.right_pct != null} level={rightEmgLevel} large display={focusView} />
            </>
          )}
        </div>}

        {telemetryPanelEnabled("phase") && !captureIsBodyExploration && (
          <div className="rounded-xl border border-border bg-muted/20 p-4" style={{ order: telemetryPanelOrder("phase") }}>
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-primary flex items-center gap-1.5">
                <Brain className="w-4 h-4" /> Real-Time Phase Watch
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-2">
                <p className="text-lg font-medium text-foreground">{prediction.label}</p>
                <span className="rounded-full border border-rose-400/45 bg-rose-500/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-rose-600 dark:text-rose-300">
                  {prediction.physiologicalIntensityLabel}
                </span>
                {howlSarahAutoEnabled && (
                  <span className="rounded-full border border-cyan-400/45 bg-cyan-500/10 px-2.5 py-1 text-[10px] font-bold uppercase tracking-[0.18em] text-cyan-700 dark:text-cyan-300">
                    Howl: {howlControllerMode}
                  </span>
                )}
              </div>
              <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                {prediction.hrvExplanation}
              </p>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={toggleLiveEncouragement}
                  className={`inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition ${liveCueSettings.enabled ? "bg-primary text-primary-foreground hover:bg-primary/90" : "border border-border bg-card text-foreground hover:bg-muted"}`}
                >
                  <Volume2 className="h-3.5 w-3.5" />
                  {liveCueSettings.enabled ? "Sarah Encouragement On" : "Turn Sarah Encouragement On"}
                </button>
                <select
                  value={liveCueSettings.style}
                  onChange={(event) => setLiveCueSettings((previous) => ({ ...previous, style: event.target.value }))}
                  className="rounded-lg border border-border bg-card px-3 py-2 text-xs font-semibold text-foreground"
                  aria-label="Sarah encouragement style"
                >
                  <option value="clinical_minimal">Clinical minimal</option>
                  <option value="sarah_soft">Warm encouragement</option>
                  <option value="intimate_coaching">Direct encouragement</option>
                </select>
                <label className="flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-xs font-medium text-muted-foreground">
                  Volume
                  <input
                    type="range"
                    min="0.1"
                    max="0.7"
                    step="0.05"
                    value={liveCueSettings.volume}
                    onChange={(event) => setLiveCueSettings((previous) => ({ ...previous, volume: Number(event.target.value) }))}
                    className="w-24 accent-primary"
                    aria-label="Sarah encouragement volume"
                  />
                  <span className="w-8 text-right tabular-nums text-foreground">{Math.round(liveCueSettings.volume * 100)}%</span>
                </label>
              </div>
              {liveCueSettings.enabled && liveCueEngine.latestCue?.phrase && (
                <p className="mt-2 rounded-lg border border-primary/20 bg-primary/[0.06] px-3 py-2 text-xs text-muted-foreground">
                  Last encouragement: <span className="font-medium text-foreground">{liveCueEngine.latestCue.phrase}</span>
                </p>
              )}
            </div>
            <div className="grid grid-cols-2 gap-2 text-right lg:grid-cols-4">
              <div className="rounded-lg border px-4 py-3" style={{ borderColor: `${levelColor(prediction.nearClimax)}80`, backgroundColor: `${levelColor(prediction.nearClimax)}20` }}>
                <p className="text-xs uppercase tracking-wider text-primary font-semibold">Near-Climax</p>
                <p className="text-4xl font-bold text-foreground">{prediction.nearClimax}%</p>
              </div>
              <div className="rounded-lg border border-amber-400/45 bg-amber-500/10 px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-wider text-amber-700 dark:text-amber-300">Plateau</p>
                <p className="text-4xl font-bold text-foreground">{prediction.plateauScore}%</p>
              </div>
              <div className="rounded-lg border border-cyan-400/45 bg-cyan-500/10 px-4 py-3">
                <p className="text-xs font-semibold uppercase tracking-wider text-cyan-700 dark:text-cyan-300">Control Trust</p>
                <p className="text-4xl font-bold text-foreground">{prediction.controllerConfidence}%</p>
              </div>
              <div className="rounded-lg border px-4 py-3" style={{ borderColor: `${levelColor(prediction.recovery)}80`, backgroundColor: `${levelColor(prediction.recovery)}20` }}>
                <p className="text-xs uppercase tracking-wider text-chart-2 font-semibold">Recovery</p>
                <p className="text-4xl font-bold text-foreground">{prediction.recovery}%</p>
              </div>
            </div>
          </div>
          <div className="mt-3 h-3 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full transition-all" style={{ width: `${prediction.nearClimax}%`, backgroundColor: levelColor(prediction.nearClimax) }} />
          </div>
          <div className="mt-3 grid gap-2 text-xs sm:grid-cols-2 lg:grid-cols-4">
            <div className="rounded-lg border border-border bg-card/70 px-3 py-2"><span className="text-muted-foreground">Respiratory load</span><p className="mt-1 font-semibold text-foreground">{prediction.possibleBreathHold ? `Possible ${fmtNumber(prediction.breathHoldDurationSeconds, 1)}s hold` : prediction.respirationBpm != null ? `${fmtNumber(prediction.respirationBpm, 1)} breaths/min` : "Withheld"}</p></div>
            <div className="rounded-lg border border-border bg-card/70 px-3 py-2"><span className="text-muted-foreground">Somatic motion</span><p className="mt-1 font-semibold capitalize text-foreground">{String(prediction.motionClass || "unavailable").replaceAll("_", " ")}</p></div>
            <div className="rounded-lg border border-border bg-card/70 px-3 py-2"><span className="text-muted-foreground">Approach velocity</span><p className="mt-1 font-semibold text-foreground">{prediction.approachVelocity > 0 ? "+" : ""}{fmtNumber(prediction.approachVelocity, 1)} points/30s</p></div>
            <div className="rounded-lg border border-border bg-card/70 px-3 py-2"><span className="text-muted-foreground">Signal gate</span><p className="mt-1 font-semibold text-foreground">{prediction.multimodalTrusted ? "Trusted multimodal" : "Hold escalation"}</p></div>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            {[
              { key: "pre_climax_offset_s", label: "Mark Pre-Climax" },
              { key: "climax_offset_s", label: "Mark Climax" },
              { key: "recovery_offset_s", label: "Mark Recovery" },
            ].map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => applyLiveCommand({ type: "mark_phase", key: item.key, label: item.label.replace("Mark ", "") })}
                className="inline-flex items-center gap-1.5 rounded-lg bg-muted px-2.5 py-1.5 text-xs font-semibold text-foreground hover:bg-muted/80"
              >
                <Flag className="h-3.5 w-3.5" />
                {item.label}
              </button>
            ))}
          </div>
          {recentPhaseMarkers.length > 0 && (
            <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
              {recentPhaseMarkers.map((marker, index) => (
                <div key={`${marker.label}-${marker.time_s}-${index}`} className="rounded-lg border border-border bg-card/70 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold text-foreground">{marker.label}</p>
                    <span className="font-mono text-[10px] text-muted-foreground">{fmtMmSs(marker.time_s)}</span>
                  </div>
                  <p className="mt-1 line-clamp-2 text-[10px] text-muted-foreground">{marker.reason}</p>
                </div>
              ))}
            </div>
          )}
          </div>
        )}

        {telemetryPanelEnabled("multimodal") && directH10Source && (
          <div className="grid gap-4 xl:grid-cols-2" style={{ order: telemetryPanelOrder("multimodal") }}>
            <TrendPanel
              title="Threshold Load Matrix"
              subtitle="Approach, sustained plateau, controller trust, recovery, and normalized Howl dose"
              empty={!hasThresholdPhysiologyTrend}
              heightClass="h-80 md:h-[24rem]"
              distanceView={distanceTelemetryView}
            >
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={physiologyChartData} margin={{ top: 8, right: 12, bottom: 0, left: -18 }}>
                  <defs>
                    <linearGradient id="approachLoadFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#fb7185" stopOpacity={0.52} />
                      <stop offset="100%" stopColor="#fb7185" stopOpacity={0.03} />
                    </linearGradient>
                    <linearGradient id="plateauLoadFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#f59e0b" stopOpacity={0.38} />
                      <stop offset="100%" stopColor="#f59e0b" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.4} />
                  <XAxis dataKey="time" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} minTickGap={28} />
                  <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} width={36} />
                  <Tooltip content={<ChartTooltip />} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <ReferenceLine y={60} stroke="#f59e0b" strokeDasharray="5 5" opacity={0.65} />
                  <ReferenceLine y={72} stroke="#fb7185" strokeDasharray="5 5" opacity={0.65} />
                  <Area type="monotone" dataKey="nearClimax" name="Approach" stroke="#fb7185" fill="url(#approachLoadFill)" strokeWidth={2.5} dot={false} connectNulls />
                  <Area type="monotone" dataKey="plateau" name="Plateau" stroke="#f59e0b" fill="url(#plateauLoadFill)" strokeWidth={2} dot={false} connectNulls />
                  <Line type="monotone" dataKey="controllerConfidence" name="Control trust" stroke="#22d3ee" strokeWidth={2} dot={false} connectNulls />
                  <Line type="monotone" dataKey="recovery" name="Recovery" stroke="#34d399" strokeWidth={1.75} dot={false} connectNulls />
                  <Line type="stepAfter" dataKey="howlDose" name="Howl dose %" stroke="#e879f9" strokeWidth={2} dot={false} connectNulls />
                </ComposedChart>
              </ResponsiveContainer>
            </TrendPanel>

            <TrendPanel
              title="Respiratory & Somatic Response"
              subtitle="Quality-gated breathing estimate, chest movement load, and possible breath-hold windows"
              empty={!hasThresholdPhysiologyTrend}
              heightClass="h-80 md:h-[24rem]"
              distanceView={distanceTelemetryView}
            >
              <ResponsiveContainer width="100%" height="100%">
                <ComposedChart data={physiologyChartData} margin={{ top: 8, right: 12, bottom: 0, left: -18 }}>
                  <defs>
                    <linearGradient id="motionLoadFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#38bdf8" stopOpacity={0.42} />
                      <stop offset="100%" stopColor="#38bdf8" stopOpacity={0.02} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.4} />
                  <XAxis dataKey="time" tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} minTickGap={28} />
                  <YAxis yAxisId="resp" domain={[0, "auto"]} tick={{ fontSize: 11, fill: "#14b8a6" }} tickLine={false} axisLine={false} width={36} />
                  <YAxis yAxisId="load" orientation="right" domain={[0, 100]} tick={{ fontSize: 11, fill: "#38bdf8" }} tickLine={false} axisLine={false} width={36} />
                  <Tooltip content={<ChartTooltip />} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  <Area yAxisId="load" type="monotone" dataKey="motionLoad" name="Chest motion load" stroke="#38bdf8" fill="url(#motionLoadFill)" strokeWidth={2} dot={false} connectNulls />
                  <Line yAxisId="resp" type="monotone" dataKey="respirationBpm" name="Respiration/min" stroke="#14b8a6" strokeWidth={2.5} dot={false} connectNulls />
                  <Line yAxisId="load" type="stepAfter" dataKey="breathHoldBand" name="Possible hold" stroke="#f97316" strokeWidth={3} dot={false} connectNulls />
                  <Line yAxisId="load" type="monotone" dataKey="signalConfidence" name="Signal confidence" stroke="#a3e635" strokeWidth={1.75} dot={false} connectNulls />
                </ComposedChart>
              </ResponsiveContainer>
            </TrendPanel>
          </div>
        )}

        <div className="contents">
        {telemetryPanelEnabled("cardiac") && <div style={{ order: telemetryPanelOrder("cardiac") }}>
        <TrendPanel title="Cardiac & Autonomic Trend" subtitle="Heart rate, smoothed baseline, RMSSD, SDNN, and session approach load" empty={!hasHrTrend} heightClass={distanceTelemetryView ? "h-80 md:h-[26rem]" : "h-72 md:h-80"} distanceView={distanceTelemetryView}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={telemetryHistory} margin={{ top: 8, right: 12, bottom: 0, left: -18 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.45} />
              <XAxis dataKey="time" tick={{ fontSize: distanceTelemetryView ? 13 : 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} minTickGap={28} />
              <YAxis yAxisId="hr" tick={{ fontSize: distanceTelemetryView ? 13 : 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} domain={["dataMin - 4", "dataMax + 4"]} width={distanceTelemetryView ? 44 : 34} />
              <YAxis yAxisId="hrv" orientation="right" tick={{ fontSize: distanceTelemetryView ? 13 : 10, fill: "#22d3ee" }} tickLine={false} axisLine={false} domain={[0, "auto"]} width={distanceTelemetryView ? 44 : 34} />
              <YAxis yAxisId="watch" hide domain={[0, 100]} />
              <Tooltip content={<ChartTooltip />} />
              <Legend wrapperStyle={{ fontSize: distanceTelemetryView ? 14 : 11 }} />
              {phaseMarkers.map((marker, index) => marker.chartTime ? (
                <ReferenceLine
                  key={`${marker.label}-${marker.chartTime}-${index}`}
                  yAxisId="hr"
                  x={marker.chartTime}
                  stroke={phaseMarkerColor(marker.label)}
                  strokeDasharray="4 3"
                  ifOverflow="extendDomain"
                  label={{ value: marker.label, position: "top", fill: phaseMarkerColor(marker.label), fontSize: 10 }}
                />
              ) : null)}
              <Line yAxisId="hr" type="monotone" dataKey="baseline" name="Baseline" stroke="hsl(var(--muted-foreground))" strokeDasharray="5 5" strokeWidth={1.5} dot={false} connectNulls />
              <Line yAxisId="hr" type="monotone" dataKey="hrSmoothed" name="Smoothed" stroke="hsl(var(--chart-2))" strokeWidth={2} dot={false} connectNulls />
              <Line yAxisId="hr" type="monotone" dataKey="hr" name="HR" stroke="hsl(var(--primary))" strokeWidth={2.5} dot={false} connectNulls />
              <Line yAxisId="hrv" type="monotone" dataKey="hrvRmssd" name="RMSSD" stroke="#22d3ee" strokeWidth={2.25} dot={false} connectNulls />
              <Line yAxisId="hrv" type="monotone" dataKey="hrvSdnn" name="SDNN" stroke="#a78bfa" strokeWidth={1.75} dot={false} connectNulls />
              {!captureIsBodyExploration && <Line yAxisId="watch" type="monotone" dataKey="nearClimax" name="Approach" stroke="hsl(var(--destructive))" strokeWidth={2} dot={false} connectNulls />}
            </LineChart>
          </ResponsiveContainer>
        </TrendPanel>
        </div>}

        {telemetryPanelEnabled("emg") && telemetryEmgLive && (
          <div style={{ order: telemetryPanelOrder("emg") }}><TrendPanel title={selectedEmgConfig.trendTitle} subtitle={selectedEmgConfig.trendSubtitle} empty={!hasEmgTrend} heightClass={distanceTelemetryView ? "h-80 md:h-[26rem]" : "h-64 md:h-72"} distanceView={distanceTelemetryView}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={telemetryHistory} margin={{ top: 8, right: 12, bottom: 0, left: -18 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.45} />
                <XAxis dataKey="time" tick={{ fontSize: distanceTelemetryView ? 13 : 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} minTickGap={28} />
                <YAxis tick={{ fontSize: distanceTelemetryView ? 13 : 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} domain={[0, 100]} width={distanceTelemetryView ? 44 : 34} />
                <Tooltip content={<ChartTooltip />} />
                <Legend wrapperStyle={{ fontSize: distanceTelemetryView ? 14 : 11 }} />
                <Line type="monotone" dataKey="left" name={usingPerinealEmgConfig ? "Perineal" : "Left"} stroke="hsl(var(--primary))" strokeWidth={2.5} dot={false} connectNulls />
                <Line type="monotone" dataKey="right" name={usingPerinealEmgConfig ? "Aux" : "Right"} stroke="hsl(var(--chart-2))" strokeWidth={2.5} dot={false} connectNulls />
                <Line type="monotone" dataKey="diff" name="Diff" stroke="hsl(var(--chart-4))" strokeWidth={1.75} dot={false} connectNulls />
              </LineChart>
            </ResponsiveContainer>
          </TrendPanel></div>
        )}
        </div>
        </div>
      </div>

      {!focusView && showAdvancedSetupConsole && <CollapsibleControlSection
        icon={FileText}
        title="Capture Files"
        helper="Latest finalized HR and EMG exports."
        status={files?.latestHrCsv ? "HR CSV available" : "Waiting for capture"}
      >
        <div className="flex items-center justify-end gap-2">
          <button
            onClick={refreshFiles}
            className="rounded-lg bg-muted px-2.5 py-1.5 text-xs font-medium text-muted-foreground hover:text-foreground"
          >
            <RefreshCw className="mr-1 inline h-3.5 w-3.5" /> Refresh
          </button>
        </div>
        <div className={`grid gap-3 ${emgLive ? "md:grid-cols-2" : ""}`}>
          <FileCard title="Latest Heart Rate CSV" file={files?.latestHrCsv} />
          {emgLive && <FileCard title="Latest EMG CSV" file={files?.latestEmgCsv} />}
        </div>
      </CollapsibleControlSection>}
        </>
      )}
    </div>
  );
}
