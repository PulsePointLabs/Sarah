import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { BleClient } from "@capacitor-community/bluetooth-le";
import { Activity, AlertTriangle, Brain, CheckCircle2, ChevronDown, CircleDot, ExternalLink, FileText, Flag, Footprints, HeartPulse, Maximize2, Mic, MicOff, Radio, RefreshCw, ScanSearch, SlidersHorizontal, Undo2, UploadCloud, Video, X, Zap } from "lucide-react";
import {
  CartesianGrid,
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
import { apiUrl } from "@/lib/mobileApiBase";
import {
  buildLaunchProfileFromRuntime,
  readLiveCaptureLaunchProfile,
  saveLiveCaptureLaunchProfile,
  summarizeLaunchProfile,
} from "@/lib/liveCaptureLaunchProfile";
import { DEFAULT_LIVE_CUE_SETTINGS, LIVE_CUE_PRESETS, resolveLiveCuePhraseBank } from "@/lib/liveCuePhrases";
import { useLiveCueAudio } from "@/hooks/useLiveCueAudio";
import { useLiveCueEngine } from "@/hooks/useLiveCueEngine";
import { computeLiveClimaxPrediction } from "@/utils/liveClimaxPrediction";
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
  startOmronBloodPressureListener,
  stopOmronBloodPressureListener,
} from "@/lib/omronBloodPressureBle";
import AppVersionBadge from "@/components/AppVersionBadge";

const MAX_TELEMETRY_POINTS = 240;
const MAX_VOICE_NOTE_MS = 12000;
const VOICE_NOTE_MIN_MS = 900;
const VOICE_NOTE_SILENCE_MS = 1300;
const VOICE_NOTE_SILENCE_RMS = 0.018;
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
const BLOOD_PRESSURE_SYNC_POLL_MS = 30000;
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
  buildStep: 1,
  reduceStep: 2,
  nearClimaxThreshold: 72,
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

function isRecent(value, maxAgeMs = 5000) {
  if (!value) return false;
  const t = new Date(value).getTime();
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
  return Boolean(window.sarahDesktop?.isDesktop);
}

async function getDirectH10Device({ preferSaved = false, silent = false } = {}) {
  const grantedDevices = typeof navigator.bluetooth.getDevices === "function"
    ? await navigator.bluetooth.getDevices().catch(() => [])
    : [];
  const pairedH10 = grantedDevices.find((device) => /polar\s+h10/i.test(device?.name || ""));
  if (preferSaved && pairedH10) return pairedH10;
  if (silent) {
    throw new Error("No saved H10 Bluetooth permission is available for automatic reconnect.");
  }

  try {
    return await navigator.bluetooth.requestDevice({
      filters: [{ namePrefix: "Polar H10" }],
      optionalServices: ["heart_rate", "battery_service", "device_information"],
    });
  } catch (error) {
    if (/user cancelled|user canceled|cancelled|canceled/i.test(error?.message || "")) throw error;
  }

  if (pairedH10) return pairedH10;
  return navigator.bluetooth.requestDevice({
    acceptAllDevices: true,
    optionalServices: ["heart_rate", "battery_service", "device_information"],
  });
}

async function getNativeDirectH10Device() {
  await BleClient.initialize({ androidNeverForLocation: true });
  if (typeof BleClient.isLocationEnabled === "function") {
    const enabled = await BleClient.isLocationEnabled().catch(() => true);
    if (!enabled) {
      throw new Error("Android Location services are off. Turn Location on, then try Connect H10 again so Android can scan for BLE devices.");
    }
  }
  return BleClient.requestDevice({
    services: [HEART_RATE_SERVICE_UUID],
    optionalServices: [
      HEART_RATE_SERVICE_UUID,
      BATTERY_SERVICE_UUID,
      DEVICE_INFORMATION_SERVICE_UUID,
    ],
    namePrefix: "Polar H10",
  });
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
      <summary className="flex cursor-pointer list-none items-start gap-3 p-4 [&::-webkit-details-marker]:hidden">
        {Icon && <Icon className="mt-0.5 h-4 w-4 shrink-0 text-primary" />}
        <div className="min-w-0 flex-1">
          <p className="text-xs font-semibold uppercase tracking-wider text-primary">{title}</p>
          {helper && <p className="mt-1 text-sm text-muted-foreground">{helper}</p>}
        </div>
        {status && (
          <span className="shrink-0 rounded-full border border-border bg-muted/30 px-2.5 py-1 text-[10px] font-semibold text-muted-foreground">
            {status}
          </span>
        )}
        <ChevronDown className="mt-0.5 h-4 w-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180" />
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
        {isDirectH10 && <span>ECG waveform is not enabled yet; this pass captures standard H10 HR + RR intervals for HRV.</span>}
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

function makeTelemetryPoint(hrTelemetry, emgTelemetry) {
  const now = Date.now();
  const hrv = hrTelemetry?.hrv || {};
  return {
    ts: now,
    time: new Date(now).toLocaleTimeString([], { minute: "2-digit", second: "2-digit" }),
    hr: readNumber(hrTelemetry?.currentHr, hrTelemetry?.hr, hrTelemetry?.heartRate),
    hrSmoothed: readNumber(hrTelemetry?.hrSmoothed, hrTelemetry?.smoothedHr, hrTelemetry?.hr_smoothed),
    baseline: readNumber(hrTelemetry?.baselineHr, hrTelemetry?.baseline_hr),
    build: readNumber(hrTelemetry?.buildConfidence, hrTelemetry?.build_confidence),
    hrSource: hrTelemetry?.source || hrTelemetry?.hr_source || null,
    hrvRmssd: readNumber(hrv.rmssdMs, hrTelemetry?.hrv_rmssd_ms),
    hrvSdnn: readNumber(hrv.sdnnMs, hrTelemetry?.hrv_sdnn_ms),
    hrvPnn50: readNumber(hrv.pnn50, hrTelemetry?.hrv_pnn50),
    hrvQuality: hrv.quality || hrTelemetry?.hrv_quality || null,
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

function MetricCard({ icon, label, value, helper, active, level, large = false, beatPulse = 0 }) {
  const hasLevel = Number.isFinite(Number(level));
  const color = hasLevel ? levelColor(level) : null;
  return (
    <div
      className={`relative overflow-hidden rounded-xl border transition-shadow ${large ? "p-5" : "p-4"} ${active ? "border-primary/40 bg-primary/8" : "border-border bg-card"} ${beatPulse ? "shadow-[0_0_30px_rgba(244,63,94,0.55)] ring-2 ring-rose-400/70" : ""}`}
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
      <p className={`mt-3 font-bold tracking-tight text-foreground ${large ? "text-5xl" : "text-3xl"}`}>{value}</p>
      {helper && <p className={`mt-1 text-muted-foreground ${large ? "text-sm" : "text-xs"}`}>{helper}</p>}
    </div>
  );
}

function CompactStat({ label, value, helper, level, emphasis = false, beatPulse = 0 }) {
  const hasLevel = Number.isFinite(Number(level));
  const color = hasLevel ? levelColor(level) : null;
  return (
    <div
      className={`relative overflow-hidden rounded-xl border px-4 py-3 transition-shadow ${emphasis ? "min-h-[7.5rem]" : "min-h-[6.75rem]"} ${hasLevel ? "" : "border-border bg-muted/25"} ${beatPulse ? "shadow-[0_0_26px_rgba(244,63,94,0.55)] ring-2 ring-rose-400/70" : ""}`}
      style={hasLevel ? { borderColor: `${color}9a`, background: `linear-gradient(135deg, ${color}42, ${color}12 54%, hsl(var(--card)) 100%)` } : undefined}
    >
      {beatPulse ? <span key={`compact-beat-${label}-${beatPulse}`} className="pointer-events-none absolute right-4 top-4 h-4 w-4 rounded-full bg-rose-400/45 animate-ping" /> : null}
      {hasLevel && <div className="absolute inset-x-0 bottom-0 h-1.5" style={{ backgroundColor: color }} />}
      <p className="text-xs font-semibold uppercase tracking-[0.12em] text-muted-foreground">{label}</p>
      <p className={`mt-2 font-bold tracking-tight text-foreground ${emphasis ? "text-5xl" : "text-4xl"}`}>{value}</p>
      {helper && <p className="mt-1 text-sm font-medium text-foreground/75">{helper}</p>}
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

export default function LiveCapture() {
  const [searchParams, setSearchParams] = useSearchParams();
  const focusView = searchParams.get("display") === "focus";
  const { toast } = useToast();
  const [status, setStatus] = useState(null);
  const [hrTelemetry, setHrTelemetry] = useState(null);
  const [emgTelemetry, setEmgTelemetry] = useState(null);
  const [recording, setRecording] = useState(null);
  const [files, setFiles] = useState(null);
  const [liveSession, setLiveSession] = useState(null);
  const [activeSessionDoc, setActiveSessionDoc] = useState(null);
  const [connected, setConnected] = useState(false);
  const [telemetryHistory, setTelemetryHistory] = useState([]);
  const [liveEvents, setLiveEvents] = useState([]);
  const [phaseMarkers, setPhaseMarkers] = useState([]);
  const [hrSourceSettings, setHrSourceSettings] = useState(() => readHrSourceSettings());
  const [hrSourceSaving, setHrSourceSaving] = useState(false);
  const [hrSourceError, setHrSourceError] = useState("");
  const [directH10Status, setDirectH10Status] = useState({
    connected: false,
    connecting: false,
    deviceName: "",
    message: "Direct H10 not connected",
    error: "",
    lastMessageAt: null,
    rrCount: 0,
  });
  const [hrLossDialog, setHrLossDialog] = useState(null);
  const [captureKind, setCaptureKind] = useState(() => localStorage.getItem("pulsepoint.captureKind") || "session");
  const [captureKindError, setCaptureKindError] = useState("");
  const [captureMode, setCaptureMode] = useState(() => localStorage.getItem("pulsepoint.captureMode") || "full");
  const [emgSensorConfig, setEmgSensorConfig] = useState(() => localStorage.getItem("pulsepoint.emgSensorConfig") || "generic");
  const [telemetryNoticesEnabled, setTelemetryNoticesEnabled] = useState(() => localStorage.getItem("pulsepoint.telemetryNotices") !== "off");
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
  const [mediaProcessing, setMediaProcessing] = useState("");
  const [mediaError, setMediaError] = useState("");
  const [presetModalOpen, setPresetModalOpen] = useState(false);
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
  const mediaRecorderRef = useRef(null);
  const voiceChunksRef = useRef([]);
  const voiceNoteTimeRef = useRef(0);
  const voiceNoteTimeoutRef = useRef(null);
  const voiceSilenceRafRef = useRef(null);
  const voiceAudioSourceRef = useRef(null);
  const voiceSilenceStartedRef = useRef(null);
  const audioContextRef = useRef(null);
  const heartbeatAudioContextRef = useRef(null);
  const heartbeatAudioEnabledRef = useRef(heartbeatAudioEnabled);
  const lastHeartbeatAtRef = useRef(0);
  const lastHeartbeatTelemetryKeyRef = useRef("");
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
  const directH10IntentionalDisconnectRef = useRef(false);
  const directH10ReconnectAttemptRef = useRef(0);
  const howlAutoLastActionRef = useRef({ at: 0, intensity: null, reason: "" });
  const bpSyncInFlightRef = useRef(false);
  const bpOmronSeenRef = useRef(new Set());
  const howlSettingsDirtyRef = useRef(false);
  const howlFocusedFieldRef = useRef("");
  const launchInFlightRef = useRef(null);
  const restoredLaunchProfileRef = useRef(false);
  const liveRecordEntity = liveSession?.entity || (captureKind === "body_exploration" ? "BodyExploration" : "Session");
  const liveRecordApi = base44.entities[liveRecordEntity] || base44.entities.Session;
  const captureIsBodyExploration = liveRecordEntity === "BodyExploration" || captureKind === "body_exploration";

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
    }
    if (heartbeatAudioContextRef.current.state === "suspended") {
      await heartbeatAudioContextRef.current.resume();
    }
    return heartbeatAudioContextRef.current;
  }, []);

  const playHeartbeatBeep = useCallback(async () => {
    if (!heartbeatAudioEnabledRef.current) return;
    try {
      const ctx = await getHeartbeatAudioContext();
      if (!ctx || ctx.state === "closed") return;
      const t = ctx.currentTime + 0.006;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = "sine";
      osc.frequency.setValueAtTime(880, t);
      gain.gain.setValueAtTime(0.0001, t);
      gain.gain.exponentialRampToValueAtTime(0.026, t + 0.008);
      gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.055);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.065);
    } catch {}
  }, [getHeartbeatAudioContext]);

  const triggerHeartbeatPulse = useCallback((telemetry = latestHrRef.current) => {
    const hr = readNumber(telemetry?.currentHr, telemetry?.hr, telemetry?.heartRate);
    if (hr == null) return;
    const now = Date.now();
    const minInterval = Math.max(240, Math.min(900, (60000 / Math.max(40, hr)) * 0.55));
    if (now - lastHeartbeatAtRef.current < minInterval) return;
    lastHeartbeatAtRef.current = now;
    setHeartbeatPulseId((value) => value + 1);
    playHeartbeatBeep();
  }, [playHeartbeatBeep]);

  const maybeTriggerHeartbeatFromTelemetry = useCallback((telemetry) => {
    const hr = readNumber(telemetry?.currentHr, telemetry?.hr, telemetry?.heartRate);
    if (hr == null) return;
    const key = [
      telemetry?.source || "",
      telemetry?.measuredAt || telemetry?.source_at || telemetry?.receivedAt || telemetry?.lastMessageAt || "",
      telemetry?.rrIntervalsMs?.join?.(":") || telemetry?.rr_intervals_ms?.join?.(":") || "",
      hr,
    ].join("|");
    if (key && key === lastHeartbeatTelemetryKeyRef.current) return;
    lastHeartbeatTelemetryKeyRef.current = key;
    triggerHeartbeatPulse(telemetry);
  }, [triggerHeartbeatPulse]);

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
      const [recentResponse, capabilitiesResponse, settingsResponse, commandsResponse] = await Promise.all([
        fetch(apiUrl("/howl/telemetry/recent?limit=1")),
        fetch(apiUrl("/howl/control-capabilities")),
        fetch(apiUrl("/howl/control/settings")),
        fetch(apiUrl("/howl/control/commands?limit=5")),
      ]);
      if (!recentResponse.ok) throw new Error("Howl telemetry route is not responding.");
      const recent = await recentResponse.json();
      const capabilities = capabilitiesResponse.ok ? await capabilitiesResponse.json() : null;
      const settingsPayload = settingsResponse.ok ? await settingsResponse.json() : null;
      const commandsPayload = commandsResponse.ok ? await commandsResponse.json() : null;
      setHowlTelemetry(recent?.samples?.[0] || null);
      setHowlCapabilities(capabilities);
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

  const publishDirectH10Measurement = useCallback((parsed, deviceName = "Polar H10") => {
    if (!parsed?.heartRate) return;
    const receivedAt = Date.now();
    directH10ReconnectAttemptRef.current = 0;
    setHrLossDialog(null);
    directH10RrRef.current = appendRollingRrIntervals(directH10RrRef.current, parsed.rrIntervalsMs);
    const hrv = computeHrvFromRr(directH10RrRef.current);
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
      quality: {
        stale: false,
        ageMs: 0,
        rrCount: directH10RrRef.current.length,
        hrvQuality: hrv?.quality || "unavailable",
      },
    };

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
      body: JSON.stringify(telemetry),
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
      const point = makeTelemetryPoint(nextHr, nextEmg);
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
      const pointPrediction = computeLiveClimaxPrediction(nextHr, nextEmg, [...prev, point]);
      point.nearClimax = pointPrediction.nearClimax;
      point.recovery = pointPrediction.recovery;
      point.hrvSignal = pointPrediction.hrvSignal;
      return [...prev, point].slice(-MAX_TELEMETRY_POINTS);
    });
  };

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
      return data;
    } catch (error) {
      setHowlError(error?.message || "Unable to send Howl command.");
      return null;
    } finally {
      setHowlControlBusy("");
    }
  }, [activeSessionDoc?.id, howlCommandForm, liveSession?.activeSessionId, refreshHowlTelemetry]);

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

  const disconnectDirectH10 = useCallback(async ({ updateStatus = true } = {}) => {
    directH10IntentionalDisconnectRef.current = true;
    const nativeDeviceId = directH10NativeDeviceIdRef.current;
    if (nativeDeviceId) {
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
    if (updateStatus) {
      setDirectH10Status((prev) => ({
        ...prev,
        connected: false,
        connecting: false,
        message: "Direct H10 disconnected",
        error: "",
        rrCount: 0,
      }));
    }
    window.setTimeout(() => {
      directH10IntentionalDisconnectRef.current = false;
    }, 1500);
  }, []);

  const connectDirectH10 = useCallback(async (options = {}) => {
    const autoReconnect = options?.autoReconnect === true;
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
      setDirectH10Status((prev) => ({
        ...prev,
        connecting: true,
        error: "",
        message: autoReconnect
          ? "Trying native Android H10 reconnect."
          : "Opening Android BLE picker for Polar H10.",
      }));

      try {
        await disconnectDirectH10({ updateStatus: false });
        const device = await getNativeDirectH10Device();
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
          if (!intentionalDisconnect) {
            setHrLossDialog({
              title: "H10 disconnected",
              message: "The native Android BLE connection dropped. Tap Reconnect H10 if it does not resume on its own.",
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

        setDirectH10Status((prev) => ({
          ...prev,
          connecting: true,
          deviceName,
          message: "Opening native H10 heart-rate service.",
          error: "",
        }));

        // Android can keep stale BLE state after prior attempts; disconnect first when possible.
        await BleClient.disconnect(device.deviceId).catch(() => {});
        await BleClient.connect(device.deviceId, handleNativeDisconnected, { timeout: 15000 });
        await BleClient.startNotifications(
          device.deviceId,
          HEART_RATE_SERVICE_UUID,
          HEART_RATE_MEASUREMENT_UUID,
          (value) => publishDirectH10Measurement(parseHeartRateMeasurement(value), deviceName),
          { timeout: 12000 },
        );

        setDirectH10Status((prev) => ({
          ...prev,
          connected: true,
          connecting: false,
          deviceName,
          message: "Native Direct H10 connected. Waiting for first HR packet.",
          error: "",
        }));
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
  }, [disconnectDirectH10, hrSourceSettings.source, publishDirectH10Measurement]);

  useEffect(() => {
    if (hrSourceSettings.source !== "direct_h10") return undefined;
    const timer = window.setInterval(() => {
      const serverDirect = status?.hr?.directH10 || {};
      const sourceStatus = status?.hr?.sourceStatus || {};
      const lastMessageAt = directH10Status.lastMessageAt || serverDirect.lastMessageAt || sourceStatus.lastMessageAt;
      const lastMs = Date.parse(lastMessageAt || "");
      const connectedFlag = Boolean(directH10Status.connected || serverDirect.connected || sourceStatus.connected);
      const signalLost = serverDirect.error && /signal lost|no hr packets/i.test(serverDirect.error);

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

      setHrLossDialog({
        title: "H10 signal lost",
        message: canUseNativeAndroidBle()
          ? `No heart-rate packet has arrived for ${Math.round(ageMs / 1000)} seconds. Tap Reconnect H10 to reopen the native Android BLE session.`
          : `No heart-rate packet has arrived for ${Math.round(ageMs / 1000)} seconds. Sarah will try the saved H10 once; tap reconnect if Chrome needs permission again.`,
        reconnecting: !canUseNativeAndroidBle() && directH10ReconnectAttemptRef.current < 2,
      });
      setDirectH10Status((prev) => ({
        ...prev,
        connected: false,
        error: "Direct H10 signal lost - no HR packets received recently.",
        message: canUseNativeAndroidBle() ? "Direct H10 signal lost." : "Trying to reconnect Direct H10.",
      }));

      if (!canUseNativeAndroidBle() && directH10ReconnectAttemptRef.current < 2) {
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
    hrSourceSettings.source,
    status?.hr?.directH10?.connected,
    status?.hr?.directH10?.error,
    status?.hr?.directH10?.lastMessageAt,
    status?.hr?.sourceStatus?.connected,
    status?.hr?.sourceStatus?.lastMessageAt,
  ]);

  const forgetDirectH10 = useCallback(async () => {
    if (canUseNativeAndroidBle()) {
      await disconnectDirectH10({ updateStatus: false });
      directH10RrRef.current = [];
      setDirectH10Status((prev) => ({
        ...prev,
        connected: false,
        connecting: false,
        deviceName: "",
        message: "Native H10 disconnected. Android manages BLE permission through the system picker/app settings.",
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
    if (settings.source === "heartrateonstream" || settings.source === "direct_h10" || (settings.source === "pulsoid" && settings.pulsoidToken)) {
      applyHrSourceSettings(settings);
    }

  }, []);

  useEffect(() => () => {
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
      appendTelemetryPoint(nextHr, nextEmg);
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
      appendTelemetryPoint(nextHr, nextEmg);
    });
    events.addEventListener("hr_telemetry", (event) => {
      const data = JSON.parse(event.data);
      latestHrRef.current = data;
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
      appendTelemetryPoint(nextHr, nextEmg);
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
  }, []);

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
  }, [getHeartbeatAudioContext, heartbeatAudioEnabled]);

  useEffect(() => () => {
    heartbeatAudioContextRef.current?.close?.().catch?.(() => {});
  }, []);

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
    liveRecordApi.filter({ id: sessionId }).then((rows) => {
      const session = rows[0] || null;
      setActiveSessionDoc(session);
      const events = session?.event_timeline || [];
      setLiveEvents([...events].sort((a, b) => Number(a.time_s || 0) - Number(b.time_s || 0)));
    }).catch(() => {});
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

  const prediction = useMemo(() => computeLiveClimaxPrediction(hrTelemetry, emgTelemetry, telemetryHistory), [hrTelemetry, emgTelemetry, telemetryHistory]);
  const recordingActive = Boolean(recording?.active);
  const hrConnected = Boolean(status?.hr?.sourceStatus?.connected ?? status?.hr?.connected);
  const emgSourceAt = emgTelemetry?.source_at || status?.emg?.lastSourceAt || status?.emg?.lastMessageAt;
  const emgLive = captureMode !== "hr" && recordingActive && isRecent(emgSourceAt);
  const mainTelemetryView = captureMode === "hr";
  const telemetryEmgLive = recordingActive && isRecent(emgSourceAt);
  const distanceTelemetryView = mainTelemetryView || focusView;
  const hasHrTrend = telemetryHistory.some((point) => point.hr != null || point.hrSmoothed != null);
  const hasEmgTrend = telemetryHistory.some((point) => point.left != null || point.right != null || point.diff != null);
  const currentHrLevel = hrLevelPercent(hrTelemetry?.currentHr, hrTelemetry?.baselineHr);
  const buildLevel = readNumber(hrTelemetry?.buildConfidence, hrTelemetry?.build_confidence);
  const hrv = hrTelemetry?.hrv || {};
  const rrCount = readNumber(hrTelemetry?.quality?.rrCount, hrv.sampleCount);
  const hrvRmssd = readNumber(hrv.rmssdMs, hrTelemetry?.hrv_rmssd_ms);
  const hrvQuality = hrv.quality || hrTelemetry?.hrv_quality || null;
  const latestBpReading = bpCapture.lastReading || activeSessionDoc?.latest_blood_pressure_reading || activeSessionDoc?.session_context?.blood_pressure || null;
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
  const recentLiveEvents = useMemo(() => [...liveEvents].sort((a, b) => Number(b.time_s || 0) - Number(a.time_s || 0)).slice(0, 8), [liveEvents]);
  const recentPhaseMarkers = useMemo(() => [...phaseMarkers].reverse().slice(0, 5), [phaseMarkers]);
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

  useEffect(() => {
    if (!howlManualControlsUnlocked || !howlSarahAutoEnabled) {
      setHowlAutoStatus(howlManualControlsUnlocked ? "Sarah auto-control is off." : "Manual Howl control must be enabled and tested first.");
      return;
    }
    if (!hrTelemetry || !hrConnected) {
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
    const buildStep = Math.max(0, readNumber(howlControlForm.buildStep) ?? 1);
    const reduceStep = Math.max(0, readNumber(howlControlForm.reduceStep) ?? 2);
    const nearThreshold = readNumber(howlControlForm.nearClimaxThreshold) ?? 72;
    const buildThreshold = readNumber(howlControlForm.buildThreshold) ?? 32;
    const recoveryThreshold = readNumber(howlControlForm.recoveryThreshold) ?? 55;

    let target = currentIntensity;
    let reason = "";
    if (howlControlForm.recoveryReductionEnabled !== false && prediction.recovery >= recoveryThreshold) {
      target = Math.max(floor, currentIntensity - reduceStep);
      reason = `sarah_auto_recovery_reduce recovery=${prediction.recovery} near=${prediction.nearClimax}`;
    } else if (howlControlForm.nearClimaxReductionEnabled !== false && prediction.nearClimax >= nearThreshold) {
      target = Math.max(floor, currentIntensity - reduceStep);
      reason = `sarah_auto_near_climax_reduce near=${prediction.nearClimax} recovery=${prediction.recovery}`;
    } else if (howlControlForm.buildRampEnabled !== false && prediction.nearClimax >= buildThreshold && prediction.nearClimax < Math.max(buildThreshold + 6, nearThreshold - 10)) {
      target = Math.min(ceiling, currentIntensity + buildStep);
      reason = `sarah_auto_gradual_build near=${prediction.nearClimax} recovery=${prediction.recovery}`;
    }

    target = Math.max(floor, Math.min(ceiling, Math.round(target)));
    if (target === Math.round(currentIntensity)) {
      setHowlAutoStatus(`Sarah holding intensity ${Math.round(currentIntensity)}. ${prediction.reason || prediction.label}`);
      return;
    }

    howlAutoLastActionRef.current = { at: now, intensity: target, reason };
    setHowlCommandForm((prev) => ({ ...prev, intensity: target }));
    setHowlAutoStatus(`Sarah ${target > currentIntensity ? "increased" : "reduced"} Howl intensity to ${target}.`);
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
    howlControlForm.nearClimaxReductionEnabled,
    howlControlForm.nearClimaxThreshold,
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

  const clearMediaVideo = useCallback(() => {
    if (mediaObjectUrlRef.current) {
      URL.revokeObjectURL(mediaObjectUrlRef.current);
      mediaObjectUrlRef.current = null;
    }
    setMediaVideo(null);
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

  useEffect(() => {
    voiceWakeEnabledRef.current = voiceWakeEnabled;
  }, [voiceWakeEnabled]);

  useEffect(() => {
    annotationRecordingRef.current = annotationRecording;
  }, [annotationRecording]);

  const speechRecognitionSupported = typeof window !== "undefined" && Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
  const voiceRecordingSupported = typeof navigator !== "undefined" && Boolean(navigator.mediaDevices?.getUserMedia) && typeof MediaRecorder !== "undefined";
  const voiceReady = speechRecognitionSupported && voiceRecordingSupported;
  const embeddedObsStatus = status?.hr?.relay?.obs || null;
  const obsReady = Boolean(recordingActive || embeddedObsStatus?.identified);
  const emgRecent = isRecent(emgSourceAt);

  const getCurrentSessionTime = useCallback(() => {
    const startMs = Number(recording?.startedAtMs) || (liveSession?.startedAt ? new Date(liveSession.startedAt).getTime() : 0);
    if (!startMs || Number.isNaN(startMs)) return 0;
    return Math.max(0, Math.round((Date.now() - startMs) / 1000));
  }, [liveSession?.startedAt, recording?.startedAtMs]);

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
    if (bpSyncInFlightRef.current) return;
    bpSyncInFlightRef.current = true;
    setBpCapture((prev) => ({
      ...prev,
      syncing: true,
      status: "syncing",
      error: "",
      message: manual ? "Refreshing BP readings..." : prev.message,
    }));
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
      const latestReading = stamped.latest || readings[0] || null;
      const needsPermission = nativeStatus?.native !== false && !nativePermissionGranted;
      setBpCapture((prev) => ({
        ...prev,
        native: nativeStatus?.native !== false,
        permissionGranted: nativePermissionGranted,
        syncing: false,
        status: stamped.stamped ? "captured" : needsPermission ? "permission_needed" : latestReading ? "ready" : "idle",
        lastReading: latestReading || prev.lastReading,
        lastCapturedAt: stamped.latest ? new Date().toISOString() : prev.lastCapturedAt,
        capturedCount: prev.capturedCount + stamped.stamped,
        message: stamped.stamped
          ? `Captured ${stamped.stamped} BP reading${stamped.stamped === 1 ? "" : "s"} into this session.`
          : latestReading
            ? nativeSyncAttempted
              ? "Latest BP synced from Health Connect. Watching for session readings."
              : "Latest BP loaded from the local PulsePoint database."
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
  }, [stampBloodPressureReadings]);

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
      lastReading: latestReading,
      message: `OMRON captured ${formatBloodPressure(latestReading)} and saved it to PulsePoint.`,
    }));

    stampBloodPressureReadings(savedReadings, { source: "omron_direct_ble_listener" })
      .then((stamped) => {
        if (!stamped?.stamped) return;
        setBpCapture((prev) => ({
          ...prev,
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
  }, [stampBloodPressureReadings]);

  const toggleOmronBloodPressureListener = useCallback(async () => {
    if (bpSyncInFlightRef.current) return;

    if (bpOmronListening) {
      bpSyncInFlightRef.current = true;
      setBpCapture((prev) => ({
        ...prev,
        syncing: true,
        error: "",
        message: "Stopping OMRON listener...",
      }));
      try {
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
        bpSyncInFlightRef.current = false;
      }
      return;
    }

    bpSyncInFlightRef.current = true;
    setBpCapture((prev) => ({
      ...prev,
      syncing: true,
      status: "syncing",
      error: "",
      message: "Starting OMRON listener...",
    }));
    try {
      await startOmronBloodPressureListener({
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
        onDisconnect: () => {
          setBpOmronListening(false);
          setBpCapture((prev) => ({
            ...prev,
            syncing: false,
            status: prev.lastReading ? "ready" : "idle",
            message: prev.lastReading ? "OMRON disconnected. Latest BP is saved." : "OMRON disconnected before a BP reading arrived.",
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
      setBpOmronListening(true);
      setBpCapture((prev) => ({
        ...prev,
        syncing: false,
        status: prev.lastReading ? "ready" : "syncing",
        message: "OMRON listener is active. Take a BP reading or press the cuff Bluetooth/Transfer button once until the O flashes.",
      }));
    } catch (error) {
      setBpOmronListening(false);
      setBpCapture((prev) => ({
        ...prev,
        syncing: false,
        status: "error",
        error: error?.message || "Could not start OMRON listener.",
        message: error?.message || "Could not start OMRON listener.",
      }));
    } finally {
      bpSyncInFlightRef.current = false;
    }
  }, [bpOmronListening, saveOmronBloodPressureForLiveSession]);

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
    if (!liveSession?.activeSessionId) return undefined;
    syncBloodPressureForLiveSession({ manual: false });
    const timer = window.setInterval(() => {
      syncBloodPressureForLiveSession({ manual: false });
    }, BLOOD_PRESSURE_SYNC_POLL_MS);
    return () => window.clearInterval(timer);
  }, [liveSession?.activeSessionId, syncBloodPressureForLiveSession]);

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

  const hasRecentHrPacket = useCallback(() => {
    const sample = latestHrRef.current || hrTelemetry;
    const hr = readNumber(sample?.currentHr, sample?.hr, sample?.heartRate);
    if (hr == null) return false;
    const stamp = sample?.measuredAt || sample?.receivedAt || sample?.source_at || sample?.lastMessageAt;
    const ageMs = stamp ? Date.now() - Date.parse(stamp) : 0;
    return !stamp || (Number.isFinite(ageMs) && ageMs >= 0 && ageMs < 10000);
  }, [hrTelemetry]);

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

        if (hrSourceSettings.source === "direct_h10" && !hasRecentHrPacket()) {
          setLaunchStep("Connecting H10");
          await connectDirectH10();
        }

        setLaunchStep("Waiting for heart rate");
        const receivedHr = await waitForRecentHrPacket();
        if (!receivedHr) {
          throw new Error("H10/source is connected or configured, but no recent heart-rate packet has arrived.");
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
    const strongLabel = prediction.nearClimax >= 75
      ? "Near-climax possibility"
      : prediction.recovery >= 70
        ? "Recovery watch"
        : Number(buildLevel) >= 55 && prediction.recentSlope > 0
          ? "Sustained build observed"
        : prediction.nearClimax >= 45
          ? "Build intensifying"
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
    if (telemetryNoticesEnabled) {
      toast({
        title: <span className="text-lg font-semibold tracking-tight">{strongLabel}</span>,
        description: <span className="text-base leading-relaxed">{prediction.reason || "Meaningful live telemetry pattern detected."}</span>,
        duration: 6500,
        className: "min-w-[22rem] border-primary/50 bg-card/95 p-5 shadow-2xl",
      });
    }
  }, [buildLevel, captureIsBodyExploration, getCurrentSessionTime, prediction, recordingActive, telemetryHistory, telemetryNoticesEnabled, toast]);

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
    if (command.type === "mark_phase") {
      if (captureIsBodyExploration) {
        setVoiceStatus("Body Exploration mode is active; climax phase marks are disabled.");
        return false;
      }
      const timeS = getCurrentSessionTime();
      const chartTime = telemetryHistory[telemetryHistory.length - 1]?.time;
      await updateActiveSession({ [command.key]: timeS });
      setPhaseMarkers((prev) => [...prev, { time_s: timeS, chartTime, label: command.label, kind: command.key, confidence: 100, reason: "Marked by voice command" }].slice(-20));
      setVoiceStatus(`${command.label} marked at ${fmtMmSs(timeS)}.`);
      return true;
    }
    return false;
  }, [captureIsBodyExploration, getCurrentSessionTime, telemetryHistory, undoLastVoiceAnnotation, updateActiveSession]);

  useEffect(() => {
    applyLiveCommandRef.current = applyLiveCommand;
  }, [applyLiveCommand]);

  const stopWakeListening = useCallback(() => {
    clearTimeout(wakeRestartTimerRef.current);
    wakeRestartTimerRef.current = null;
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
  }, []);

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

  const startWakeListening = useCallback(() => {
    if (!voiceWakeEnabledRef.current || annotationRecordingRef.current || !speechRecognitionSupported) return;
    stopWakeListening();
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
      const normalized = heard.toLowerCase().replace(/[^a-z]+/g, " ").trim();
      if (isEndListeningCommand(normalized)) {
        setVoiceWakeEnabled(false);
        setVoiceStatus("Wake listening stopped.");
        playVoiceFeedback("stop");
        try { recognition.stop(); } catch {}
        return;
      }
      const howlVoiceCommand = parseHowlVoiceCommand(heard, { ceiling: howlControlCeiling });
      if (howlVoiceCommand) {
        runHowlVoiceCommand(howlVoiceCommand).catch((error) => setVoiceError(error.message || String(error)));
        try { recognition.stop(); } catch {}
        return;
      }
      const command = parseLiveCommand(normalized);
      if (command) {
        applyLiveCommandRef.current?.(command).catch((error) => setVoiceError(error.message || String(error)));
        try { recognition.stop(); } catch {}
        return;
      }
      if (/\bsarah\b/.test(normalized)) {
        setVoiceStatus("Wake phrase heard. Recording annotation…");
        playVoiceFeedback("wake");
        try { recognition.stop(); } catch {}
        setTimeout(() => {
          if (voiceWakeEnabledRef.current && !annotationRecordingRef.current) {
            startVoiceAnnotation();
          }
        }, 120);
      }
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
  }, [howlControlCeiling, playVoiceFeedback, runHowlVoiceCommand, speechRecognitionSupported, stopWakeListening]);

  const startVoiceAnnotation = useCallback(async () => {
    if (!voiceRecordingSupported || annotationRecordingRef.current) return;
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
          {!speechRecognitionSupported && (
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
            disabled={!speechRecognitionSupported || !voiceRecordingSupported}
            className={`inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-xs font-semibold transition-colors disabled:opacity-50 ${
              voiceWakeEnabled ? "bg-primary text-primary-foreground hover:bg-primary/90" : "bg-muted text-foreground hover:bg-muted/80"
            }`}
          >
            <Mic className="h-3.5 w-3.5" />
            {voiceWakeEnabled ? "Wake Listening On" : "Enable Wake"}
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

  const mediaPanel = (captureMode === "media" || focusView) ? (
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
            <video
              ref={mediaVideoRef}
              src={mediaVideo.url}
              controls
              playsInline
              className={`${focusView ? "h-full min-h-0 max-h-full" : "max-h-[calc(100vh-17rem)] min-h-[22rem]"} w-full bg-black object-contain`}
            />
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
              <p className="truncate font-semibold">{mediaVideo.name}</p>
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
            <div className="grid grid-cols-2 gap-2">
              <CompactStat label="Current HR" value={fmtNumber(hrTelemetry?.currentHr, 0)} helper="bpm" level={currentHrLevel} emphasis beatPulse={heartbeatPulseId} />
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
                className="rounded-xl border p-4"
                style={{ borderColor: `${levelColor(prediction.nearClimax)}80`, background: `linear-gradient(135deg, ${levelColor(prediction.nearClimax)}28, hsl(var(--card)) 65%)` }}
              >
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <p className="text-sm font-semibold uppercase tracking-wider text-primary">Real-Time Phase Watch</p>
                    <p className="mt-1 text-base font-medium text-foreground">{prediction.label}</p>
                  </div>
                  <Brain className="h-5 w-5 text-primary" />
                </div>
                <div className="mt-3 h-3 overflow-hidden rounded-full bg-muted">
                  <div className="h-full rounded-full transition-all" style={{ width: `${prediction.nearClimax}%`, backgroundColor: levelColor(prediction.nearClimax) }} />
                </div>
                {prediction.reason && <p className="mt-3 line-clamp-3 text-sm leading-relaxed text-muted-foreground">{prediction.reason}</p>}
                <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
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
  const h10Recent = hasRecentHrPacket();
  const launchActive = recordingActive || Boolean(liveSession?.activeSessionId);
  const launchReadiness = {
    h10: {
      value: hrSourceSettings.source === "direct_h10"
        ? h10Recent
          ? "Connected"
          : directH10Status.connecting
            ? "Connecting"
            : directH10Status.connected
              ? "Waiting packet"
              : "Needs connection"
        : selectedHrSource.label,
      helper: hrSourceSettings.source === "direct_h10" ? directH10Status.message || "Direct H10 HR + RR source" : selectedHrSource.helper,
      tone: h10Recent || hrSourceSettings.source !== "direct_h10" ? "good" : directH10Status.connected || directH10Status.connecting ? "warn" : "bad",
    },
    hr: {
      value: h10Recent ? `${fmtNumber(hrTelemetry?.currentHr, 0)} BPM` : "Waiting",
      helper: h10Recent ? "Recent live packet received." : "Sarah will wait for an actual HR packet.",
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
  const launchCueSummary = liveCueEngine.latestCue
    ? `Latest Sarah cue · ${liveCueEngine.latestCue.phrase}`
    : `Sarah voice · ${LIVE_CUE_PRESETS[liveCueSettings.style]?.label || "Soft"} · ${Math.round((liveCueSettings.volume ?? 0.28) * 100)}% · ${liveCueAudio.ready ? "Preloaded" : liveCueSettings.enabled ? "Not preloaded yet" : "Disabled"}`;
  const showAdvancedSetupConsole = advancedSetupOpen || launchActive;

  return (
    <div className={`${focusView ? "h-screen overflow-y-auto p-4" : "p-4 md:p-6"} space-y-4`}>
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

      {!focusView && !mainTelemetryView && (
        <LiveCaptureLaunchpad
          captureKind={captureKind}
          onCaptureKindChange={setCaptureKind}
          setupSummary={launchSetupSummary}
          readiness={launchReadiness}
          primaryLabel={launchPrimaryLabel}
          primaryBusy={launchState.busy}
          primaryDisabled={launchActive}
          progress={launchState.steps}
          active={launchActive}
          cueSummary={launchCueSummary}
          advancedOpen={advancedSetupOpen}
          onChangeSetup={() => setAdvancedSetupOpen((open) => !open)}
          onStart={() => startFromLaunchpad().catch((error) => {
            toast({
              title: "Live Capture launch paused",
              description: error?.message || "Sarah could not complete the launch sequence.",
              variant: "destructive",
            });
          })}
        />
      )}

      {!focusView && !mainTelemetryView && (
        <div className="rounded-xl border border-border bg-card p-4">
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
        </div>
      )}

      {!focusView && !mainTelemetryView && (
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
          <AppVersionBadge />
          <div className="inline-flex shrink-0 rounded-lg border border-border bg-card p-1 shadow-sm">
            {CAPTURE_KINDS.map((kind) => {
              const active = captureKind === kind.value;
              return (
                <button
                  key={kind.value}
                  type="button"
                  disabled={recordingActive}
                  title={kind.helper}
                  onClick={() => setCaptureKind(kind.value)}
                  className={`inline-flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-sm font-semibold transition-colors ${
                    active
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-muted hover:text-foreground disabled:hover:bg-transparent disabled:hover:text-muted-foreground"
                  }`}
                >
                  {kind.value === "body_exploration" ? <ScanSearch className="h-3.5 w-3.5" /> : <Radio className="h-3.5 w-3.5" />}
                  {kind.label}
                </button>
              );
            })}
          </div>
          <label className="inline-flex shrink-0 items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm font-semibold text-foreground shadow-sm">
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
            onClick={() => setFocusView(true)}
            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2 text-sm font-semibold text-foreground shadow-sm hover:bg-primary/15"
          >
            <Maximize2 className="h-4 w-4 text-primary" />
            <span>Display View</span>
          </button>
          <button
            type="button"
            onClick={() => setPresetModalOpen(true)}
            className="inline-flex shrink-0 items-center justify-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm font-semibold text-foreground shadow-sm hover:bg-muted/50"
          >
            <SlidersHorizontal className="h-4 w-4 text-primary" />
            <span>{selectedCaptureMode.label}</span>
          </button>
        </div>
      </div>}

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
              value={recordingActive ? "Recording" : obsReady ? "Ready" : "Waiting"}
              helper={recordingActive
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
              helper={voiceReady ? "Timestamp notes during the session." : "Microphone capture unavailable in this browser context."}
              active={annotationRecording || voiceWakeEnabled}
            >
              <button
                type="button"
                onClick={toggleVoiceWake}
                disabled={!voiceReady}
                className="rounded-md border border-border bg-background px-2.5 py-1.5 text-xs font-semibold text-foreground hover:bg-muted disabled:opacity-50"
              >
                {voiceWakeEnabled ? "Wake Off" : "Wake On"}
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
            label="OBS Sync"
            value={recordingActive ? "Recording" : obsReady ? "Ready" : embeddedObsStatus ? "Waiting" : "Relay connected"}
            helper={
              recordingActive
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
            helper={voiceReady ? "Wake phrase and Record Now can timestamp annotations." : "This browser context cannot provide wake listening or microphone capture."}
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
            className="flex w-full items-start gap-3 p-4 text-left"
            aria-expanded={howlControlOpen}
          >
            <Zap className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wider text-primary">Howl Connection Setup</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Connect to Howl remote access, test /status, then unlock bounded manual controls.
              </p>
            </div>
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${
                howlControlEnabled ? "border-primary/35 bg-primary/10 text-primary" : "border-border bg-muted/30 text-muted-foreground"
              }`}>
                {howlControlModeLabel}
              </span>
              <ChevronDown className={`h-4 w-4 text-muted-foreground transition-transform ${howlControlOpen ? "rotate-180" : ""}`} />
            </div>
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
                      </label>
                      <label className="space-y-1">
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Default dispatch</span>
                        <div className="flex h-10 items-center rounded-lg border border-border bg-background px-3 text-sm font-semibold text-foreground">
                          Direct HTTP
                        </div>
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
                    <p className="text-sm font-semibold text-foreground">Sarah HR/HRV controller</p>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                      Closed-loop stays off by default. Manual Howl control must be tested and enabled before Sarah can be armed.
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
                  </label>
                  <label className="space-y-1">
                    <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Reduce near</span>
                    <input
                      className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm"
                      type="number"
                      min="0"
                      max="100"
                      value={howlControlForm.nearClimaxThreshold}
                      onChange={(event) => updateHowlControlForm({ nearClimaxThreshold: event.target.value }, { resetConnection: false })}
                    />
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
                  </label>
                  <label className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-xs font-semibold text-muted-foreground md:col-span-2">
                    <input
                      type="checkbox"
                      checked={howlControlForm.buildRampEnabled !== false}
                      onChange={(event) => updateHowlControlForm({ buildRampEnabled: event.target.checked }, { resetConnection: false })}
                    />
                    Gradually increase during build
                  </label>
                  <label className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-xs font-semibold text-muted-foreground md:col-span-2">
                    <input
                      type="checkbox"
                      checked={howlControlForm.nearClimaxReductionEnabled !== false}
                      onChange={(event) => updateHowlControlForm({ nearClimaxReductionEnabled: event.target.checked }, { resetConnection: false })}
                    />
                    Reduce during near-climax watch
                  </label>
                  <label className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-xs font-semibold text-muted-foreground">
                    <input
                      type="checkbox"
                      checked={howlControlForm.recoveryReductionEnabled !== false}
                      onChange={(event) => updateHowlControlForm({ recoveryReductionEnabled: event.target.checked }, { resetConnection: false })}
                    />
                    Recovery
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
          <MetricCard icon={<Video className="w-4 h-4" />} label="OBS Recording" value={recordingActive ? "Recording" : "Stopped"} helper={recording?.filename || "No active capture"} active={recordingActive} />
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
                    ? "Recording into a new Sarah session shell."
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
              <div className="mt-3 flex flex-wrap gap-1.5">
                {(captureDigest.findings || []).slice(0, 8).map((finding) => (
                  <span key={finding} className="rounded-full bg-primary/10 px-2 py-1 text-[10px] font-medium text-primary">
                    {finding}
                  </span>
                ))}
              </div>
            </div>
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
          </div>
        )}
      </div>}

      {!focusView && !mainTelemetryView && showAdvancedSetupConsole && (
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="mb-3 flex flex-col gap-1">
            <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-primary">
              <Footprints className="h-4 w-4" />
              Lower-Body Tracker
            </p>
            <p className="text-sm text-muted-foreground">
              Optional live foot/leg landmark capture. Keep it available, but out of the startup lane.
            </p>
          </div>
          <LiveFootLandmarkTracker
            sessionId={liveSession?.activeSessionId}
            recordingActive={recordingActive}
            getSessionTimeS={getCurrentSessionTime}
            onTrackingSnapshot={handleFootTrackingSnapshot}
            compact
          />
        </div>
      )}

      <div className={`rounded-xl border border-border bg-card ${distanceTelemetryView ? "p-5 md:p-6 space-y-6" : "p-4 space-y-4"} ${focusView ? "h-[calc(100vh-2rem)] overflow-y-auto" : ""}`}>
        <div className="flex items-center justify-between gap-3">
          <h3 className={`${distanceTelemetryView ? "text-lg" : "text-xs"} font-semibold uppercase tracking-wider text-primary flex items-center gap-2`}>
            <CircleDot className={distanceTelemetryView ? "w-6 h-6" : "w-4 h-4"} /> Live Telemetry
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
                  onClick={() => setFocusView(false)}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-muted px-3 py-2 text-sm font-semibold text-foreground hover:bg-muted/80"
                >
                  <X className="h-4 w-4" /> Exit Display View
                </button>
              </>
            )}
          </div>
        </div>

        <div className="grid gap-2 rounded-lg border border-border bg-muted/20 p-3 text-xs sm:grid-cols-2 lg:grid-cols-6">
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
        </div>

        <div className={`grid gap-3 sm:grid-cols-2 ${telemetryEmgLive || hrTelemetry?.source === "direct_h10" ? "lg:grid-cols-4 xl:grid-cols-5" : "lg:grid-cols-3"}`}>
          <MetricCard icon={<HeartPulse className="w-4 h-4" />} label="Current HR" value={fmtNumber(hrTelemetry?.currentHr, 0)} helper="beats per minute" active={hrTelemetry?.currentHr != null} level={currentHrLevel} large beatPulse={heartbeatPulseId} />
          <MetricCard icon={<Activity className="w-4 h-4" />} label="Blood Pressure" value={latestBpValue} helper={latestBpHelper} active={Boolean(latestBpReading)} large />
          {!captureIsBodyExploration && (
            <>
              <MetricCard icon={<Zap className="w-4 h-4" />} label="Build Confidence" value={`${fmtNumber(hrTelemetry?.buildConfidence, 0)}%`} helper={hrTelemetry?.phase || "No HR phase"} active={Number(hrTelemetry?.buildConfidence) > 40} level={buildLevel} large />
              <MetricCard
                icon={<Brain className="w-4 h-4" />}
                label="AI Magic"
                value={`${prediction.nearClimax}%`}
                helper={prediction.confidenceBand}
                active={prediction.nearClimax >= 42}
                level={prediction.nearClimax}
                large
              />
            </>
          )}
          {hrTelemetry?.source === "direct_h10" && (
            <>
              <MetricCard icon={<HeartPulse className="w-4 h-4" />} label="RR Samples" value={fmtNumber(rrCount, 0)} helper="rolling H10 interval window" active={Number(rrCount) > 0} level={Math.min(100, (Number(rrCount) || 0) * 1.25)} large />
              <MetricCard icon={<Activity className="w-4 h-4" />} label="RMSSD" value={fmtNumber(hrvRmssd, 1)} helper={hrvQuality ? `HRV quality: ${hrvQuality}` : "waiting for RR window"} active={hrvRmssd != null} level={hrvQuality === "high" ? 90 : hrvQuality === "moderate" ? 65 : hrvQuality === "low" ? 35 : 0} large />
            </>
          )}
          {telemetryEmgLive && (
            <>
              <MetricCard icon={<Activity className="w-4 h-4" />} label={selectedEmgConfig.leftLabel} value={`${fmtNumber(emgTelemetry?.left_pct ?? emgTelemetry?.level_pct)}%`} helper={selectedEmgConfig.leftHelper} active={(emgTelemetry?.left_pct ?? emgTelemetry?.level_pct) != null} level={leftEmgLevel} large />
              <MetricCard icon={<Activity className="w-4 h-4" />} label={selectedEmgConfig.rightLabel} value={`${fmtNumber(emgTelemetry?.right_pct)}%`} helper={emgTelemetry?.right_pct != null ? `diff ${fmtNumber(emgTelemetry?.diff_pct)}%` : selectedEmgConfig.rightHelper} active={emgTelemetry?.right_pct != null} level={rightEmgLevel} large />
            </>
          )}
        </div>

        {!captureIsBodyExploration && (
          <div className="rounded-xl border border-border bg-muted/20 p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-primary flex items-center gap-1.5">
                <Brain className="w-4 h-4" /> Real-Time Phase Watch
              </p>
              <p className="mt-1 text-lg font-medium text-foreground">{prediction.label}</p>
              <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
                {prediction.hrvExplanation}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-2 text-right">
              <div className="rounded-lg border px-4 py-3" style={{ borderColor: `${levelColor(prediction.nearClimax)}80`, backgroundColor: `${levelColor(prediction.nearClimax)}20` }}>
                <p className="text-xs uppercase tracking-wider text-primary font-semibold">Near-Climax</p>
                <p className="text-4xl font-bold text-foreground">{prediction.nearClimax}%</p>
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

        <div className={distanceTelemetryView && telemetryEmgLive ? "grid gap-4 xl:grid-cols-2" : "space-y-4"}>
        <TrendPanel title="Heart Rate Trend" subtitle="Current, smoothed, and baseline HR" empty={!hasHrTrend} heightClass={distanceTelemetryView ? "h-80 md:h-[26rem]" : "h-72 md:h-80"} distanceView={distanceTelemetryView}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={telemetryHistory} margin={{ top: 8, right: 12, bottom: 0, left: -18 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.45} />
              <XAxis dataKey="time" tick={{ fontSize: distanceTelemetryView ? 13 : 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} minTickGap={28} />
              <YAxis yAxisId="hr" tick={{ fontSize: distanceTelemetryView ? 13 : 10, fill: "hsl(var(--muted-foreground))" }} tickLine={false} axisLine={false} domain={["dataMin - 4", "dataMax + 4"]} width={distanceTelemetryView ? 44 : 34} />
              <YAxis yAxisId="watch" orientation="right" tick={{ fontSize: distanceTelemetryView ? 13 : 10, fill: "hsl(var(--destructive))" }} tickLine={false} axisLine={false} domain={[0, 100]} width={distanceTelemetryView ? 44 : 34} />
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
              {!captureIsBodyExploration && <Line yAxisId="watch" type="monotone" dataKey="nearClimax" name="Approach" stroke="hsl(var(--destructive))" strokeWidth={2} dot={false} connectNulls />}
            </LineChart>
          </ResponsiveContainer>
        </TrendPanel>

        {telemetryEmgLive && (
          <TrendPanel title={selectedEmgConfig.trendTitle} subtitle={selectedEmgConfig.trendSubtitle} empty={!hasEmgTrend} heightClass={distanceTelemetryView ? "h-80 md:h-[26rem]" : "h-64 md:h-72"} distanceView={distanceTelemetryView}>
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
          </TrendPanel>
        )}
        </div>
      </div>

      {!focusView && <CollapsibleControlSection
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
