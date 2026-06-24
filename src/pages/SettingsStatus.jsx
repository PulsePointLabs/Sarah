import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Activity,
  BellRing,
  Brain,
  CircleDollarSign,
  FolderOpen,
  HardDrive,
  Image,
  Palette,
  Sparkles,
  Type,
  ExternalLink,
  KeyRound,
  Loader2,
  RefreshCw,
  Settings2,
  Square,
  Trash2,
  TriangleAlert,
} from "lucide-react";
import TTSSettingsPanel from "@/components/TTSSettingsPanel";
import AppVersionBadge from "@/components/AppVersionBadge";
import { Textarea } from "@/components/ui/textarea";
import { SarahLogoMark } from "@/components/SarahBrand";
import { cancelBackgroundJob, clearBackgroundJobs, listBackgroundJobs, retryBackgroundJob } from "@/lib/backgroundJobs";
import { backgroundJobRoute } from "@/lib/backgroundJobRoutes";
import { apiUrl, discoverSarahApiBase, isSarahNativeShell, serverUrl } from "@/lib/mobileApiBase";
import { friendlyJobStatusMessage } from "@/lib/jobErrorMessages";
import { getProviderStatus } from "@/lib/providerStatus";
import {
  getSarahImageOption,
  getSarahImageOptions,
  addSarahImageOption,
  cacheSarahImageDataUrl,
  getCachedSarahImageSrc,
  resolveSarahImageSrc,
  removeSarahImageOption,
  readSarahBrandSettings,
  saveSarahBrandSettings,
} from "@/lib/sarahBrand";
import {
  DEFAULT_WATERMARK_SETTINGS,
  readWatermarkSettings,
  saveWatermarkSettings,
  WATERMARK_PRESETS,
} from "@/lib/watermarkSettings";
import {
  DEFAULT_SARAH_PERSONALITY,
  readSarahPersonalitySettings,
  SARAH_DETAIL_OPTIONS,
  SARAH_TONE_PRESETS,
  saveSarahPersonalitySettings,
} from "@/utils/sarahPersonality";
import {
  areBackgroundNotificationsEnabled,
  getNotificationPermission,
  isNotificationSupported,
  requestBackgroundNotificationPermission,
  sendBackgroundTestNotification,
  setBackgroundNotificationsEnabled,
} from "@/utils/backgroundJobNotifications";
import {
  clearPwaLifecycleDiagnostics,
  readPwaLifecycleDiagnostics,
  recordPwaLifecycleEvent,
} from "@/lib/pwaLifecycleDiagnostics";
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

function fmtMoney(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return "Unavailable";
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", maximumFractionDigits: 2 }).format(n);
}

function fmtDateTime(value) {
  if (!value) return "";
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function formatResultBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function formatResultDuration(value) {
  const seconds = Math.round(Number(value || 0));
  if (!Number.isFinite(seconds) || seconds <= 0) return "";
  const minutes = Math.floor(seconds / 60);
  const rest = seconds % 60;
  return minutes ? `${minutes}:${String(rest).padStart(2, "0")}` : `0:${String(rest).padStart(2, "0")}`;
}

function jobResultSummary(job) {
  const summary = job?.result_summary || {};
  const progress = job?.progress || {};
  const result = job?.result || {};
  const fileUrl = summary.file_url || summary.download_url || summary.stream_url || progress.result_file_url || result.file_url || "";
  if (!fileUrl) return null;
  return {
    fileUrl,
    filename: summary.filename || progress.result_filename || result.filename || "",
    size: summary.size || progress.result_size || result.size || "",
    duration: summary.duration_seconds || progress.result_duration_seconds || result.duration_seconds || "",
    createdAt: summary.created_at || progress.result_created_at || result.created_at || job?.finishedAt || job?.updatedAt || job?.createdAt || "",
  };
}

async function getStorageStatus() {
  let response;
  try {
    response = await fetch(apiUrl("/status/storage"), { cache: "no-store" });
  } catch (error) {
    if (isSarahNativeShell()) {
      await discoverSarahApiBase({ timeoutMs: 2200 });
      response = await fetch(apiUrl("/status/storage"), { cache: "no-store" });
    } else {
      throw error;
    }
  }
  if (!response.ok) throw new Error(`Storage status failed: ${response.status}`);
  return response.json();
}

async function imageBlobToSarahCacheDataUrl(blob) {
  if (typeof window === "undefined" || !blob) return "";
  const objectUrl = URL.createObjectURL(blob);
  try {
    const image = new window.Image();
    image.decoding = "async";
    await new Promise((resolve, reject) => {
      image.onload = resolve;
      image.onerror = reject;
      image.src = objectUrl;
    });
    const sourceWidth = image.naturalWidth || image.width || 1;
    const sourceHeight = image.naturalHeight || image.height || 1;
    const maxSide = 720;
    const scale = Math.min(1, maxSide / Math.max(sourceWidth, sourceHeight));
    const width = Math.max(1, Math.round(sourceWidth * scale));
    const height = Math.max(1, Math.round(sourceHeight * scale));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext("2d");
    if (!ctx) return "";
    ctx.drawImage(image, 0, 0, width, height);
    return canvas.toDataURL("image/jpeg", 0.86);
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

async function cacheSarahImageBlob(imageId, blob) {
  try {
    const dataUrl = await imageBlobToSarahCacheDataUrl(blob);
    return cacheSarahImageDataUrl(imageId, dataUrl);
  } catch {
    return false;
  }
}

async function cacheSarahImageFromUrl(imageId, src) {
  try {
    const resolved = resolveSarahImageSrc(src, imageId);
    if (!resolved || resolved.startsWith("data:image/")) return false;
    const response = await fetch(resolved, { cache: "no-store" });
    if (!response.ok) return false;
    return cacheSarahImageBlob(imageId, await response.blob());
  } catch {
    return false;
  }
}

const WATERMARK_POSITION_OPTIONS = [
  { value: "top_right", label: "Top right" },
  { value: "top_left", label: "Top left" },
  { value: "bottom_right", label: "Bottom right" },
  { value: "bottom_left", label: "Bottom left" },
];

function watermarkPreviewPositionStyle(positionMode = "top_right") {
  const position = String(positionMode || "top_right");
  const style = {};
  if (position.includes("top")) style.top = "4%";
  else style.bottom = "4%";
  if (position.includes("left")) style.left = "4%";
  else style.right = "4%";
  return style;
}

function elapsedLabel(value) {
  const ms = Date.now() - new Date(value || Date.now()).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "";
  const minutes = Math.floor(ms / 60000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m ago`;
}

function fmtDuration(ms) {
  const seconds = Math.max(0, Math.round(Number(ms || 0) / 1000));
  if (!seconds) return "";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return remainingSeconds ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function jobLabel(job) {
  if (job?.meta?.title) return job.meta.title;
  if (job?.meta?.label) return job.meta.label;
  if (job?.type === "local_vision_analyze_continuous") return "Local vision annotation";
  if (job?.type === "local_vision_analyze_window") return "Diagnostic local vision";
  if (job?.type === "local_vision_ask_video") return "Local video question";
  if (job?.type === "ai_invoke" && job?.meta?.source === "ai_video_pass") return "Cloud Sarah annotation";
  if (job?.type === "tts_export") return "Audio render";
  if (job?.type === "ai_invoke") return "AI analysis";
  return job?.type || "Background task";
}

function jobRoute(job) {
  return backgroundJobRoute(job);
}

function progressPercent(job) {
  const progress = job?.progress || {};
  const active = ["queued", "running"].includes(job?.status);
  const total = Number(progress.total || 0);
  const current = Number(progress.current || 0);
  if (!active) return 100;
  return total > 0 ? Math.max(8, Math.min(100, Math.round((current / total) * 100))) : 18;
}

function progressCounts(job) {
  const progress = job?.progress || {};
  const current = Number(progress.current || 0);
  const total = Number(progress.total || 0);
  if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0) return "";
  return `${Math.max(0, Math.round(current))}/${Math.max(0, Math.round(total))}`;
}

function adaptiveProgressChips(progress = {}) {
  return [
    { label: "scanned", value: progress.framesScanned ?? progress.frames_scanned ?? progress.scanned_frames },
    { label: "candidates", value: progress.candidatesFound ?? progress.candidates_found ?? progress.candidate_events },
    { label: "Qwen selected", value: progress.candidatesSelectedForQwen ?? progress.candidates_selected_for_qwen },
    { label: "Qwen", value: progress.qwenCallsTotal != null ? `${progress.qwenCallsCompleted || 0}/${progress.qwenCallsTotal}` : null },
    { label: "confirmed", value: progress.confirmedFindingsCount ?? progress.confirmed_findings_count },
    { label: "strong", value: progress.strongCandidatesCount ?? progress.strong_candidates_count },
    { label: "not confirmed", value: progress.notConfirmedCount ?? progress.not_confirmed_count },
    { label: "blocked", value: progress.blocked_claims },
  ].filter((item) => item.value != null);
}

function currentCandidateText(progress = {}) {
  const candidate = progress.latest_candidate_window;
  const type = candidate?.type || progress.latest_candidate_type;
  if (!type) return "";
  const score = candidate?.score ?? progress.latest_candidate_score;
  const scoreText = score != null ? ` · score ${Math.round(Number(score || 0) * 100)}%` : "";
  const reasons = Array.isArray(candidate?.reasons || progress.latest_candidate_reasons)
    ? (candidate?.reasons || progress.latest_candidate_reasons).slice(0, 2).join("; ")
    : "";
  return `${String(type).replace(/_/g, " ")}${scoreText}${reasons ? ` · ${reasons}` : ""}`;
}

function estimateJobEta(job) {
  if (!["queued", "running"].includes(job?.status)) return null;
  const progress = job?.progress || {};
  const current = Number(progress.eta_current ?? progress.current ?? 0);
  const total = Number(progress.eta_total ?? progress.total ?? 0);
  if (!Number.isFinite(current) || !Number.isFinite(total) || current <= 0 || total <= current) return null;
  const startedAt = new Date(job.startedAt || job.createdAt || 0).getTime();
  if (!Number.isFinite(startedAt) || startedAt <= 0) return null;
  const elapsedMs = Date.now() - startedAt;
  if (elapsedMs < 15000) return null;
  const etaMs = (total - current) * (elapsedMs / current);
  if (!Number.isFinite(etaMs) || etaMs < 1000) return null;
  return {
    label: `ETA ~ ${fmtDuration(etaMs)} left`,
    elapsedLabel: `elapsed ${fmtDuration(elapsedMs)}`,
  };
}

function activePhaseFallback(job) {
  if (!["queued", "running"].includes(job?.status)) return "";
  const progress = job?.progress || {};
  const current = Number(progress.current || 0);
  const total = Number(progress.total || 0);
  if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0 || current < total) return "";
  const phase = String(progress.phase || "current phase").replace(/_/g, " ");
  return `Finishing ${phase}`;
}

function isPossiblyStale(job) {
  if (!["queued", "running"].includes(job?.status)) return false;
  const updated = new Date(job?.progress?.updatedAt || job?.updatedAt || 0).getTime();
  return Number.isFinite(updated) && Date.now() - updated > 10 * 60 * 1000;
}

// PWA_LOCAL_NOTIFICATIONS_V1
function getNotificationSupport() {
  if (typeof window === "undefined") return { supported: false, reason: "Unavailable during server render." };
  if (!isNotificationSupported()) return { supported: false, reason: "This install does not expose local notifications." };
  return {
    supported: true,
    reason: window.location?.protocol === "capacitor:"
      ? "Android local notifications are available in the APK."
      : "Local browser notifications are available for this Chrome/PWA install.",
  };
}

// UI_OLD_MAN_ACCESSIBILITY_V1
const UI_PREFS_STORAGE_KEY = "pulsepoint-ui-preferences-v1";
const DEFAULT_UI_PREFS = { theme: "sarah-lavender", fontScale: "comfortable" };
const PWA_CACHE_PREFIXES = ["pulsepoint-shell-", "workbox-", "vite-"];

const THEME_OPTIONS = [
  { value: "sarah-lavender", label: "Sarah Lavender", helper: "Light, soft lavender with warm readable contrast." },
  { value: "teal", label: "Classic Teal", helper: "Original dark physiology-dashboard look." },
  { value: "blue", label: "Clinical Blue", helper: "Cooler blue accents with softer contrast." },
  { value: "warm", label: "Warm Amber", helper: "Warmer highlights for late-night reading." },
  { value: "high-contrast", label: "High Contrast", helper: "Bigger contrast, brighter borders, old-man approved." },
];

const FONT_SCALE_OPTIONS = [
  { value: "comfortable", label: "Comfortable", helper: "Current default sizing." },
  { value: "large", label: "Large", helper: "A little bigger everywhere." },
  { value: "xl", label: "Extra Large", helper: "Less squinting, more dignity." },
  { value: "old-man", label: "Old Man", helper: "Maximum readability. Buttons and tiny labels get boosted too." },
];

const SARAH_PERSONALITY_TOGGLES = [
  {
    key: "feminineWarmth",
    label: "Feminine warmth",
    helper: "More attentive, warm, and personally aware while staying grounded.",
  },
  {
    key: "sexualSpecificity",
    label: "Use specific anatomy",
    helper: "Say penis, glans, scrotum, perineum, arousal, climax, etc. when evidence supports it.",
  },
  {
    key: "arousalTimelineStory",
    label: "Story-driven arousal timeline",
    helper: "Explain what the body appears to be doing through each phase instead of listing events.",
  },
  {
    key: "ttsFriendly",
    label: "TTS-friendly writing",
    helper: "Avoid block quotes, tables, dense formatting, and awkward spoken symbols.",
  },
];

function readUiPreferences() {
  if (typeof window === "undefined") return DEFAULT_UI_PREFS;
  try {
    return { ...DEFAULT_UI_PREFS, ...(JSON.parse(window.localStorage.getItem(UI_PREFS_STORAGE_KEY) || "{}")) };
  } catch {
    return DEFAULT_UI_PREFS;
  }
}

function saveUiPreferences(nextPrefs) {
  window.localStorage.setItem(UI_PREFS_STORAGE_KEY, JSON.stringify(nextPrefs));
  window.dispatchEvent(new CustomEvent("pulsepoint:ui-preferences-changed", { detail: nextPrefs }));
}

function ToggleControl({ checked, disabled, onChange, label }) {
  return (
    <label className={`relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors ${checked ? "border-primary bg-primary" : "border-border bg-input"} ${disabled ? "cursor-not-allowed opacity-50" : "cursor-pointer"}`}>
      <input
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(event) => onChange(event.target.checked)}
        aria-label={label}
        className="sr-only"
      />
      <span className={`h-5 w-5 rounded-full bg-background shadow-sm transition-transform ${checked ? "translate-x-5" : "translate-x-0"}`} />
    </label>
  );
}

function ProviderCard({ status }) {
  const report = status?.costReport;
  return (
    <article className="rounded-xl border border-border bg-card p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h3 className="text-base font-bold text-foreground">{status?.provider || "Provider"}</h3>
          <p className="mt-1 text-sm text-muted-foreground">
            API key {status?.apiConfigured ? "configured" : "not configured"}.
          </p>
        </div>
        <span className={`rounded-full px-2 py-1 text-xs font-semibold ${status?.reportingConfigured ? "bg-emerald-500/10 text-emerald-300" : "bg-muted text-muted-foreground"}`}>
          {status?.reportingConfigured ? "Cost reports on" : "Cost reports off"}
        </span>
      </div>

      {report ? (
        <div className="mt-4 grid grid-cols-2 gap-2">
          <div className="rounded-lg bg-muted/35 p-3">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">Last 7 days</p>
            <p className="mt-1 text-xl font-bold text-foreground">{fmtMoney(report.last7Days)}</p>
          </div>
          <div className="rounded-lg bg-muted/35 p-3">
            <p className="text-xs uppercase tracking-wider text-muted-foreground">Last 30 days</p>
            <p className="mt-1 text-xl font-bold text-foreground">{fmtMoney(report.last30Days)}</p>
          </div>
        </div>
      ) : (
        <p className="mt-4 rounded-lg bg-muted/30 px-3 py-2 text-sm text-muted-foreground">
          {status?.reportingHint || "Official cost report is unavailable for this provider configuration."}
        </p>
      )}

      {status?.error && (
        <p className="mt-3 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">
          Reporting error: {status.error}
        </p>
      )}
    </article>
  );
}

export default function SettingsStatus() {
  const navigate = useNavigate();
  const [providerStatus, setProviderStatus] = useState(null);
  const [providerError, setProviderError] = useState("");
  const [providerLoading, setProviderLoading] = useState(true);
  const [jobs, setJobs] = useState([]);
  const [jobsError, setJobsError] = useState("");
  const [clearing, setClearing] = useState(false);
  const [stoppingIds, setStoppingIds] = useState(() => new Set());
  const [retryingIds, setRetryingIds] = useState(() => new Set());
  const notificationSupport = useMemo(() => getNotificationSupport(), []);
  const [notificationPermission, setNotificationPermission] = useState(getNotificationPermission);
  const [completionNotificationsEnabled, setCompletionNotificationsEnabled] = useState(areBackgroundNotificationsEnabled);
  const [notificationMessage, setNotificationMessage] = useState("");
  const [notificationBusy, setNotificationBusy] = useState(false);
  const [pwaCleanupBusy, setPwaCleanupBusy] = useState(false);
  const [pwaCleanupMessage, setPwaCleanupMessage] = useState("");
  const [pwaLifecycleEvents, setPwaLifecycleEvents] = useState(() => readPwaLifecycleDiagnostics().slice(-20).reverse());
  const [overlayDiagnostics, setOverlayDiagnostics] = useState(null);
  const [overlayMessage, setOverlayMessage] = useState("");
  const [uiPrefs, setUiPrefs] = useState(readUiPreferences);
  const [sarahBrand, setSarahBrand] = useState(readSarahBrandSettings);
  const [sarahImageOptions, setSarahImageOptions] = useState(getSarahImageOptions);
  const [sarahUploadStatus, setSarahUploadStatus] = useState("");
  const [sarahGeneratePrompt, setSarahGeneratePrompt] = useState("");
  const [sarahGenerateStatus, setSarahGenerateStatus] = useState({ type: "", message: "" });
  const [sarahGenerating, setSarahGenerating] = useState(false);
  const [watermark, setWatermark] = useState(readWatermarkSettings);
  const [sarahPersonality, setSarahPersonality] = useState(readSarahPersonalitySettings);
  const [sarahPersonalityDirty, setSarahPersonalityDirty] = useState(false);
  const [sarahPersonalityMessage, setSarahPersonalityMessage] = useState("");
  const [bpStatus, setBpStatus] = useState(null);
  const [bpReadings, setBpReadings] = useState([]);
  const [bpMessage, setBpMessage] = useState("");
  const [bpBusy, setBpBusy] = useState(false);
  const [bpOmronListening, setBpOmronListening] = useState(false);
  const [storageStatus, setStorageStatus] = useState(null);
  const [desktopStorageSettings, setDesktopStorageSettings] = useState(null);
  const [storageMessage, setStorageMessage] = useState("");
  const [storageBusy, setStorageBusy] = useState(false);

  const updateUiPrefs = (patch) => {
    setUiPrefs((previous) => {
      const next = { ...previous, ...patch };
      saveUiPreferences(next);
      return next;
    });
  };

  const loadProviders = async () => {
    setProviderLoading(true);
    setProviderError("");
    try {
      setProviderStatus(await getProviderStatus());
    } catch (error) {
      setProviderError(error?.message || "Could not load provider status.");
    } finally {
      setProviderLoading(false);
    }
  };

  useEffect(() => {
    loadProviders();
  }, []);

  const loadBloodPressure = async () => {
    setBpMessage("");
    try {
      const [nativeStatus, recent] = await Promise.all([
        getBloodPressureStatus().catch((error) => ({ available: false, error: error?.message || String(error) })),
        listRecentBloodPressure(5).catch(() => ({ readings: [] })),
      ]);
      setBpStatus(nativeStatus);
      setBpReadings(recent.readings || []);
    } catch (error) {
      setBpMessage(error?.message || "Could not load blood pressure status.");
    }
  };

  useEffect(() => {
    loadBloodPressure();
  }, []);

  const loadStorage = async () => {
    setStorageMessage("");
    try {
      const desktopSettingsPromise = window.sarahDesktop?.getStorageSettings
        ? window.sarahDesktop.getStorageSettings().catch(() => null)
        : Promise.resolve(null);
      const [status, desktopSettings] = await Promise.all([
        getStorageStatus(),
        desktopSettingsPromise,
      ]);
      setStorageStatus(status?.storage || null);
      setDesktopStorageSettings(desktopSettings || null);
    } catch (error) {
      setStorageMessage(error?.message || "Could not load storage status.");
    }
  };

  useEffect(() => {
    loadStorage();
  }, []);

  const chooseMediaRoot = async () => {
    if (!window.sarahDesktop?.chooseMediaRoot) {
      setStorageMessage("Folder picking is available in the Windows EXE. In the APK/browser, set SARAH_MEDIA_ROOT before launching the backend.");
      return;
    }
    setStorageBusy(true);
    setStorageMessage("Choosing media output folder...");
    try {
      const result = await window.sarahDesktop.chooseMediaRoot();
      if (result?.canceled) {
        setStorageMessage("Media folder selection cancelled.");
      } else {
        setDesktopStorageSettings(result?.settings || null);
        setStorageMessage("Media folder saved. Restart Sarah so the backend writes new media there.");
      }
      await loadStorage();
    } catch (error) {
      setStorageMessage(error?.message || "Could not choose media output folder.");
    } finally {
      setStorageBusy(false);
    }
  };

  const clearMediaRoot = async () => {
    if (!window.sarahDesktop?.clearMediaRoot) {
      setStorageMessage("Resetting the desktop media folder is available in the Windows EXE.");
      return;
    }
    setStorageBusy(true);
    setStorageMessage("Resetting media output folder...");
    try {
      const result = await window.sarahDesktop.clearMediaRoot();
      setDesktopStorageSettings(result?.settings || null);
      setStorageMessage("Media folder reset to the built-in data folder. Restart Sarah to apply.");
      await loadStorage();
    } catch (error) {
      setStorageMessage(error?.message || "Could not reset media output folder.");
    } finally {
      setStorageBusy(false);
    }
  };

  const requestBpAccess = async () => {
    setBpBusy(true);
    setBpMessage("Requesting Health Connect blood pressure access...");
    try {
      const status = await requestBloodPressurePermission();
      setBpStatus(status);
      setBpMessage(status.permissionGranted ? "Blood pressure permission granted." : "Permission was not granted yet. Open Health Connect and grant Sarah blood pressure access manually.");
    } catch (error) {
      setBpMessage(error?.message || "Could not request Health Connect BP access.");
    } finally {
      setBpBusy(false);
    }
  };

  const openBpSettings = async () => {
    setBpBusy(true);
    setBpMessage("Opening Health Connect settings...");
    try {
      await openHealthConnectSettings();
      setBpMessage("Health Connect opened. Grant Sarah blood pressure access, then return here and tap Refresh.");
    } catch (error) {
      setBpMessage(error?.message || "Could not open Health Connect settings.");
    } finally {
      setBpBusy(false);
    }
  };

  const syncBloodPressure = async () => {
    setBpBusy(true);
    setBpMessage("Reading Health Connect blood pressure records...");
    try {
      const result = await syncBloodPressureFromHealthConnect({ days: 60, limit: 200 });
      const nativeCount = Number(result?.native?.count ?? result?.native?.readings?.length ?? result?.readings?.length ?? 0);
      const inserted = Number(result.inserted || 0);
      setBpMessage(inserted > 0
        ? `Synced ${inserted} BP reading${inserted === 1 ? "" : "s"} from Health Connect.`
        : nativeCount > 0
          ? `Health Connect returned ${nativeCount} BP reading${nativeCount === 1 ? "" : "s"}, but none were new to save.`
          : "Health Connect permission is on, but it returned 0 blood pressure records. Check that Samsung Health/OMRON is writing BP data into Health Connect.");
      await loadBloodPressure();
    } catch (error) {
      setBpMessage(error?.message || "Could not sync blood pressure.");
    } finally {
      setBpBusy(false);
    }
  };

  const toggleOmronBloodPressureListener = async () => {
    if (bpOmronListening) {
      setBpBusy(true);
      setBpMessage("Stopping OMRON listener...");
      try {
        await stopOmronBloodPressureListener();
        setBpOmronListening(false);
        setBpMessage("OMRON listener stopped.");
      } catch (error) {
        setBpMessage(error?.message || "Could not stop OMRON listener.");
      } finally {
        setBpBusy(false);
      }
      return;
    }

    setBpBusy(true);
    setBpMessage("Starting OMRON listener...");
    try {
      await startOmronBloodPressureListener({
        onStatus: (message) => setBpMessage(message),
        onReading: async (reading) => {
          try {
            if (!reading) throw new Error("OMRON did not return a blood pressure reading.");
            const saved = await ingestBloodPressureReadings([reading]);
            const latest = Array.isArray(saved?.readings) && saved.readings.length ? saved.readings[0] : reading;
            await loadBloodPressure();
            setBpMessage(`Received OMRON reading: ${formatBloodPressure(latest)}.`);
          } catch (error) {
            setBpMessage(error?.message || "Could not save OMRON blood pressure.");
          }
        },
        onDisconnect: () => {
          setBpOmronListening(false);
          setBpMessage("OMRON disconnected.");
        },
        onError: (error) => {
          setBpMessage(error?.message || "Could not parse OMRON blood pressure.");
        },
      });
      setBpOmronListening(true);
      setBpMessage("OMRON listener is active. Take a BP reading or press the cuff Bluetooth/Transfer button once until the O flashes.");
    } catch (error) {
      setBpOmronListening(false);
      setBpMessage(error?.message || "Could not start OMRON listener.");
    } finally {
      setBpBusy(false);
    }
  };

  useEffect(() => () => {
    stopOmronBloodPressureListener().catch(() => {});
  }, []);

  useEffect(() => {
    const refresh = () => setPwaLifecycleEvents(readPwaLifecycleDiagnostics().slice(-20).reverse());
    refresh();
    window.addEventListener("sarah:pwa-lifecycle", refresh);
    const timer = window.setInterval(refresh, 5000);
    return () => {
      window.removeEventListener("sarah:pwa-lifecycle", refresh);
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!notificationSupport.supported) return;
    setNotificationPermission(getNotificationPermission());
    setCompletionNotificationsEnabled(areBackgroundNotificationsEnabled());
  }, [notificationSupport.supported]);

  const refreshOverlayDiagnostics = async () => {
    try {
      const response = await fetch(apiUrl("/live-capture/overlay-heart-rate"), { cache: "no-store" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      setOverlayDiagnostics(data.overlay || null);
    } catch (error) {
      setOverlayDiagnostics({ error: error?.message || "Overlay diagnostics unavailable" });
    }
  };

  useEffect(() => {
    refreshOverlayDiagnostics();
    const timer = window.setInterval(refreshOverlayDiagnostics, 4000);
    return () => window.clearInterval(timer);
  }, []);

  const obsOverlayUrl = serverUrl("/tools/capture/heart-rate/overlay.html");

  const sendOverlayTestPulse = async () => {
    setOverlayMessage("Sending test pulse...");
    try {
      const response = await fetch(apiUrl("/live-capture/overlay-heart-rate/test-pulse"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ heartRate: 101 }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      setOverlayDiagnostics(data.overlay || null);
      setOverlayMessage("Sent 101 BPM test pulse to the OBS overlay stream.");
    } catch (error) {
      setOverlayMessage(error?.message || "Could not send test pulse.");
    }
  };

  const clearOverlayTestPulse = async () => {
    try {
      const response = await fetch(apiUrl("/live-capture/overlay-heart-rate/clear-test-pulse"), { method: "POST" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const data = await response.json();
      setOverlayDiagnostics(data.overlay || null);
      setOverlayMessage("Cleared test pulse.");
    } catch (error) {
      setOverlayMessage(error?.message || "Could not clear test pulse.");
    }
  };

  const copyOverlayUrl = async () => {
    try {
      await navigator.clipboard.writeText(obsOverlayUrl);
      setOverlayMessage("OBS overlay URL copied.");
    } catch {
      setOverlayMessage(obsOverlayUrl);
    }
  };

  const requestNotifications = async () => {
    if (!notificationSupport.supported) {
      setNotificationMessage(notificationSupport.reason);
      return;
    }
    setNotificationBusy(true);
    setNotificationMessage("");
    try {
      const permission = getNotificationPermission() === "granted"
        ? "granted"
        : await requestBackgroundNotificationPermission();
      if (permission === "granted") {
        setBackgroundNotificationsEnabled(true);
        setCompletionNotificationsEnabled(true);
      } else {
        setBackgroundNotificationsEnabled(false);
        setCompletionNotificationsEnabled(false);
      }
      setNotificationPermission(permission);
      setNotificationMessage(
        permission === "granted"
          ? "Notifications are enabled for this install, including background task completion alerts."
          : permission === "denied"
            ? "Notifications are blocked. Re-enable them from Chrome or Android app settings."
            : "Notification permission was left undecided."
      );
    } catch (error) {
      setNotificationMessage(error?.message || "Could not request notification permission.");
    } finally {
      setNotificationBusy(false);
    }
  };

  const sendTestNotification = async () => {
    if (!notificationSupport.supported) {
      setNotificationMessage(notificationSupport.reason);
      return;
    }
    if (getNotificationPermission() !== "granted") {
      setNotificationMessage("Enable notifications first, then send a test.");
      setNotificationPermission(getNotificationPermission());
      return;
    }
    setNotificationBusy(true);
    setNotificationMessage("");
    try {
      setBackgroundNotificationsEnabled(true);
      setCompletionNotificationsEnabled(true);
      await sendBackgroundTestNotification({
        route: "/settings",
        onOpen: (target) => navigate(target),
      }).then((sent) => {
        if (!sent) {
          throw new Error("Chrome/PWA requires a ready service worker for notifications here. Try reopening the installed app after the service worker finishes registering.");
        }
      });
      setNotificationMessage("Test notification sent.");
    } catch (error) {
      setNotificationMessage(error?.message || "Could not send the test notification.");
    } finally {
      setNotificationBusy(false);
    }
  };

  const refreshSarahBrandOptions = () => {
    setSarahImageOptions(getSarahImageOptions());
    setSarahBrand(readSarahBrandSettings());
  };

  const updateSarahBrand = (imageId) => {
    setSarahBrand(saveSarahBrandSettings({ imageId }));
    const option = getSarahImageOption(imageId);
    if (option?.custom && !getCachedSarahImageSrc(option.id)) {
      cacheSarahImageFromUrl(option.id, option.src).finally(refreshSarahBrandOptions);
    }
  };

  const uploadSarahPortrait = async (event) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!/^image\//i.test(file.type || "")) {
      setSarahUploadStatus("Choose an image file for Sarah.");
      return;
    }
    setSarahUploadStatus("Uploading Sarah portrait...");
    try {
      const imageId = `uploaded-${Date.now()}`;
      await cacheSarahImageBlob(imageId, file);
      const body = new FormData();
      body.append("file", file);
      const response = await fetch(apiUrl("/files/upload"), { method: "POST", body });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Portrait upload failed.");
      const option = addSarahImageOption({
        id: imageId,
        label: file.name ? `Uploaded: ${file.name.replace(/\.[^.]+$/, "")}` : "Uploaded Sarah",
        helper: "Uploaded local portrait.",
        src: payload.file_url || payload.url,
        source: "upload",
      });
      if (option) updateSarahBrand(option.id);
      refreshSarahBrandOptions();
      setSarahUploadStatus("Uploaded and selected.");
    } catch (error) {
      setSarahUploadStatus(error?.message || "Portrait upload failed.");
    }
  };

  const generateSarahPortrait = async () => {
    setSarahGenerating(true);
    setSarahGenerateStatus({ type: "working", message: "Generating Sarah portrait with OpenAI..." });
    try {
      const response = await fetch(apiUrl("/sarah-brand/generate-portrait"), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt: sarahGeneratePrompt }),
      });
      const payload = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(payload.error || "Sarah portrait generation failed.");
      const imageId = payload.id || `generated-${Date.now()}`;
      const option = addSarahImageOption({
        id: imageId,
        label: payload.label || "Generated Sarah",
        helper: payload.helper || "Generated with OpenAI.",
        src: payload.url,
        source: "openai",
      });
      if (option) await cacheSarahImageFromUrl(option.id, option.src);
      if (option) updateSarahBrand(option.id);
      refreshSarahBrandOptions();
      setSarahGenerateStatus({ type: "ok", message: "Generated and selected." });
    } catch (error) {
      setSarahGenerateStatus({ type: "error", message: error?.message || "Sarah portrait generation failed." });
    } finally {
      setSarahGenerating(false);
    }
  };

  const removeSarahPortrait = (imageId) => {
    const next = removeSarahImageOption(imageId);
    setSarahBrand(next);
    refreshSarahBrandOptions();
  };

  const applyPwaUpdateNow = async () => {
    recordPwaLifecycleEvent("manual_update_apply_requested");
    const registration = await navigator.serviceWorker?.getRegistration?.();
    if (!registration?.waiting) {
      setPwaCleanupMessage("No waiting Sarah update is available right now.");
      return;
    }
    registration.waiting.postMessage({ type: "SARAH_SKIP_WAITING" });
    setPwaCleanupMessage("Sarah update applied. If the app reloads, reading state was checkpointed first.");
  };

  const clearLifecycleLog = () => {
    clearPwaLifecycleDiagnostics();
    setPwaLifecycleEvents([]);
  };

  const updateWatermark = (patch) => {
    setWatermark((previous) => saveWatermarkSettings({ ...previous, ...patch }));
  };

  const applyWatermarkPreset = (preset) => {
    const presetPatch = preset === "private_archive"
      ? { preset, enabled: false, metadataScrubEnabled: false }
      : preset === "preview"
        ? { preset, enabled: true, metadataScrubEnabled: true, opacity: 0.7, positionMode: "top_right", portraitEnabled: true, logoEnabled: true }
        : { preset, enabled: true, metadataScrubEnabled: true, primaryText: "Clinical Climax", secondaryText: "Powered by Sarah", positionMode: "top_right", portraitEnabled: true, logoEnabled: true };
    updateWatermark(presetPatch);
  };

  const resetWatermark = () => {
    setWatermark(saveWatermarkSettings(DEFAULT_WATERMARK_SETTINGS));
  };

  const updateSarahPersonality = (patch) => {
    setSarahPersonality((previous) => ({ ...previous, ...patch }));
    setSarahPersonalityDirty(true);
    setSarahPersonalityMessage("");
  };

  const saveSarahPersonality = () => {
    const saved = saveSarahPersonalitySettings(sarahPersonality);
    setSarahPersonality(saved);
    setSarahPersonalityDirty(false);
    setSarahPersonalityMessage("Sarah settings saved. New analyses will use this style.");
  };

  const resetSarahPersonality = () => {
    setSarahPersonality(DEFAULT_SARAH_PERSONALITY);
    setSarahPersonalityDirty(true);
    setSarahPersonalityMessage("Starter instructions restored. Press Save Sarah Settings to keep them.");
  };

  const resetPwaShell = async () => {
    setPwaCleanupBusy(true);
    setPwaCleanupMessage("");
    try {
      if (window.sarahCleanupPwaShell || window.pulsepointCleanupPwaShell) {
        await (window.sarahCleanupPwaShell || window.pulsepointCleanupPwaShell)();
      } else {
        const tasks = [];
        if ("serviceWorker" in navigator) {
          tasks.push(
            navigator.serviceWorker.getRegistrations?.()
              .then((registrations = []) => Promise.all(registrations.map((registration) => registration.unregister())))
          );
        }
        if (window.caches?.keys) {
          tasks.push(
            window.caches.keys()
              .then((keys = []) => Promise.all(keys
                .filter((key) => PWA_CACHE_PREFIXES.some((prefix) => key.startsWith(prefix)))
                .map((key) => window.caches.delete(key))))
          );
        }
        await Promise.all(tasks);
      }
      setPwaCleanupMessage("PWA shell cache cleared and service workers unregistered. Reopen the app once, then the focus-refresh loop should stop.");
    } catch (error) {
      setPwaCleanupMessage(error?.message || "Could not reset the PWA shell.");
    } finally {
      setPwaCleanupBusy(false);
    }
  };

  useEffect(() => {
    let timer = null;
    let stopped = false;
    const loadJobs = async () => {
      try {
        const result = await listBackgroundJobs({ limit: 60 });
        if (stopped) return;
        setJobs(result.jobs || []);
        setJobsError("");
      } catch (error) {
        if (!stopped) setJobsError(error?.message || "Could not load background tasks.");
      } finally {
        if (!stopped) timer = window.setTimeout(loadJobs, 3000);
      }
    };
    loadJobs();
    return () => {
      stopped = true;
      if (timer) window.clearTimeout(timer);
    };
  }, []);

  const activeJobs = useMemo(() => jobs.filter((job) => ["queued", "running"].includes(job.status)), [jobs]);
  const recentJobs = useMemo(() => jobs.filter((job) => !["queued", "running"].includes(job.status)).slice(0, 12), [jobs]);

  const stopJob = async (job) => {
    if (!job?.id || stoppingIds.has(job.id)) return;
    setStoppingIds((previous) => new Set([...previous, job.id]));
    try {
      const next = await cancelBackgroundJob(job.id);
      setJobs((previous) => previous.map((item) => (item.id === job.id ? next : item)));
    } finally {
      setStoppingIds((previous) => {
        const next = new Set(previous);
        next.delete(job.id);
        return next;
      });
    }
  };

  const retryJob = async (job) => {
    if (!job?.id || retryingIds.has(job.id)) return;
    setRetryingIds((previous) => new Set([...previous, job.id]));
    try {
      const next = await retryBackgroundJob(job.id);
      setJobs((previous) => previous.map((item) => (item.id === job.id ? next : item)));
    } catch (error) {
      setJobsError(error?.message || "Could not retry background task.");
    } finally {
      setRetryingIds((previous) => {
        const next = new Set(previous);
        next.delete(job.id);
        return next;
      });
    }
  };

  const clearTasks = async () => {
    setClearing(true);
    try {
      await clearBackgroundJobs();
      setJobs([]);
    } catch (error) {
      setJobsError(error?.message || "Could not clear background tasks.");
    } finally {
      setClearing(false);
    }
  };

  const renderJob = (job) => {
    const route = jobRoute(job);
    const active = ["queued", "running"].includes(job.status);
    const stale = isPossiblyStale(job);
    const eta = estimateJobEta(job);
    const phaseFallback = activePhaseFallback(job);
    const counts = progressCounts(job);
    const result = jobResultSummary(job);
    const resultDetails = [
      result?.duration ? formatResultDuration(result.duration) : "",
      result?.size ? formatResultBytes(result.size) : "",
      result?.createdAt ? `Created ${fmtDateTime(result.createdAt)}` : "",
    ].filter(Boolean).join(" · ");
    return (
      <article key={job.id} className="overflow-hidden rounded-xl border border-border bg-card p-3 shadow-sm shadow-primary/5 sm:p-3.5">
        <div className="grid min-w-0 gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-start">
          <div className="min-w-0 max-w-full">
            <div className="flex flex-wrap items-center gap-2">
              <p className="min-w-0 overflow-hidden text-ellipsis text-sm font-bold leading-snug text-foreground sm:truncate">{jobLabel(job)}</p>
              {stale && <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold text-amber-200">May be hung</span>}
            </div>
            <p className="mt-1 break-words text-sm leading-snug text-muted-foreground">{friendlyJobStatusMessage(job)}</p>
          </div>
          <span className={`w-fit rounded-full px-2 py-1 text-xs font-semibold uppercase ${active ? "bg-primary/10 text-primary" : job.status === "complete" ? "bg-emerald-500/10 text-emerald-300" : "bg-destructive/10 text-destructive"}`}>
            {job.status}
          </span>
        </div>
        <div className="mt-3 h-2 overflow-hidden rounded-full bg-muted">
          <div className={`h-full rounded-full ${stale ? "bg-amber-300" : "bg-primary"}`} style={{ width: `${progressPercent(job)}%` }} />
        </div>
        {job?.progress?.latest_summary && (
          <p className="mt-2 rounded-lg border border-primary/20 bg-primary/5 px-2.5 py-2 text-xs leading-relaxed text-muted-foreground">
            <span className="font-semibold text-primary">Latest evidence:</span> {job.progress.latest_summary}
          </p>
        )}
        {currentCandidateText(job.progress) && (
          <p className="mt-2 rounded-lg border border-primary/20 bg-primary/5 px-2.5 py-2 text-xs leading-relaxed text-muted-foreground">
            <span className="font-semibold text-primary">Current checkpoint:</span> {currentCandidateText(job.progress)}
          </p>
        )}
        {adaptiveProgressChips(job.progress).length > 0 && (
          <div className="mt-2 flex flex-wrap gap-1.5 text-[11px] text-muted-foreground">
            {adaptiveProgressChips(job.progress).map((chip) => (
              <span key={chip.label} className="rounded-full border border-border bg-muted/20 px-2 py-0.5">
                {chip.value} {chip.label}
              </span>
            ))}
          </div>
        )}
        <div className="mt-2 grid min-w-0 gap-1 text-xs text-muted-foreground sm:grid-cols-[minmax(0,1fr)_auto] sm:gap-2">
          <span className="min-w-0 break-words">
            {job?.progress?.phase || job.type}
            {counts ? ` · ${counts}` : ""}
            {job?.progress?.model ? ` / ${job.progress.model}` : ""}
          </span>
          <span className="min-w-0 break-words sm:text-right">Updated {elapsedLabel(job?.progress?.updatedAt || job.updatedAt)}{job.updatedAt ? ` / ${fmtDateTime(job.updatedAt)}` : ""}</span>
        </div>
        {active && (eta || phaseFallback) && (
          <div className="mt-2 flex flex-wrap gap-2 text-xs font-semibold text-primary">
            <span className="rounded-full border border-primary/25 bg-primary/10 px-2 py-1">{eta?.label || phaseFallback}</span>
            {eta?.elapsedLabel && <span className="rounded-full border border-border bg-muted/20 px-2 py-1 text-muted-foreground">{eta.elapsedLabel}</span>}
          </div>
        )}
        {result && (
          <div className="mt-3 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="font-semibold text-foreground">Output ready</span>
              <button
                type="button"
                onClick={() => window.open(serverUrl(result.fileUrl), "_blank", "noopener,noreferrer")}
                className="inline-flex items-center justify-center gap-1.5 rounded-full border border-primary/25 bg-background px-2.5 py-1 text-[11px] font-semibold text-primary hover:bg-primary/10"
              >
                <ExternalLink className="h-3 w-3" />
                Open output
              </button>
            </div>
            {result.filename && <p className="mt-1 truncate font-mono text-[11px]">{result.filename}</p>}
            {resultDetails && <p className="mt-0.5">{resultDetails}</p>}
          </div>
        )}
        <div className="mt-3 grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
          {route && (
            <button type="button" onClick={() => navigate(route)} className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-muted px-2.5 py-2 text-xs font-semibold text-foreground hover:bg-muted/80 sm:py-1.5">
              <ExternalLink className="h-3.5 w-3.5" />
              Open
            </button>
          )}
          {active && (
            <button type="button" disabled={stoppingIds.has(job.id)} onClick={() => stopJob(job)} className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-destructive/10 px-2.5 py-2 text-xs font-semibold text-destructive hover:bg-destructive/20 disabled:opacity-60 sm:py-1.5">
              {stoppingIds.has(job.id) ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
              {stoppingIds.has(job.id) ? "Stopping" : "Stop"}
            </button>
          )}
          {!active && job.retryable && (
            <button type="button" disabled={retryingIds.has(job.id)} onClick={() => retryJob(job)} className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary/10 px-2.5 py-2 text-xs font-semibold text-primary hover:bg-primary/15 disabled:opacity-60 sm:py-1.5">
              {retryingIds.has(job.id) ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <RefreshCw className="h-3.5 w-3.5" />}
              {retryingIds.has(job.id) ? "Retrying" : "Retry"}
            </button>
          )}
        </div>
      </article>
    );
  };

  return (
    <div className="mx-auto w-full max-w-7xl space-y-4 overflow-x-hidden px-3 py-4 sm:space-y-5 sm:px-6 sm:py-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <div className="flex items-center gap-2 text-primary">
            <Settings2 className="h-5 w-5" />
            <p className="text-sm font-bold uppercase tracking-wider">Settings & Status</p>
          </div>
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-foreground">Sarah control room</h1>
          <p className="mt-2 max-w-3xl text-sm text-muted-foreground">
            Tune narration once, check API cost visibility, and manage background AI or audio work without hunting through individual cards.
          </p>
        </div>
        <AppVersionBadge />
      </header>

      <section className="rounded-xl border border-border bg-card p-3 sm:p-5">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-primary">
              <CircleDollarSign className="h-4 w-4" />
              <h2 className="text-sm font-bold uppercase tracking-wider">API Status</h2>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Official provider cost reports appear here when reporting keys are configured. Remaining prepaid balance is not assumed.
            </p>
          </div>
          <button type="button" onClick={loadProviders} disabled={providerLoading} className="inline-flex items-center gap-1.5 rounded-lg bg-muted px-3 py-2 text-sm font-semibold text-foreground hover:bg-muted/80 disabled:opacity-60">
            <RefreshCw className={`h-4 w-4 ${providerLoading ? "animate-spin" : ""}`} />
            Refresh
          </button>
        </div>

        {providerError && <p className="mt-4 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{providerError}</p>}
        {providerLoading && !providerStatus ? (
          <div className="mt-4 flex items-center gap-2 rounded-lg bg-muted/25 px-3 py-4 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Checking configured provider reporting access.
          </div>
        ) : providerStatus ? (
          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            <ProviderCard status={providerStatus?.providers?.anthropic} />
            <ProviderCard status={providerStatus?.providers?.openai} />
          </div>
        ) : (
          <p className="mt-4 rounded-lg bg-muted/25 px-3 py-4 text-sm text-muted-foreground">
            Provider status will appear once the local API reports cost visibility.
          </p>
        )}

        <div className="mt-3 flex items-start gap-2 rounded-lg bg-muted/20 px-3 py-2 text-sm text-muted-foreground">
          <KeyRound className="mt-0.5 h-4 w-4 shrink-0" />
          <span>Standard Claude and OpenAI API keys still power analysis and TTS. Optional admin reporting keys only add cost visibility here.</span>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-primary">
              <HardDrive className="h-4 w-4" />
              <h2 className="text-sm font-bold uppercase tracking-wider">Media Storage</h2>
            </div>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              Choose where Sarah saves new uploads, generated videos, exported narration, and mobile session render files. Existing C: drive media remains readable.
            </p>
          </div>
          <span className={`rounded-full px-2 py-1 text-xs font-semibold uppercase ${storageStatus?.uploadDirExternal ? "bg-emerald-500/10 text-emerald-400" : "bg-muted text-muted-foreground"}`}>
            {storageStatus?.uploadDirExternal ? "external media" : "C: media"}
          </span>
        </div>

        <div className="mt-4 grid gap-3">
          {[
            ["New saved/generated media", storageStatus?.uploadDir || "--"],
            ["Render scratch", storageStatus?.ttsRenderDir || "--"],
            ["Legacy fallback media", storageStatus?.defaultUploadDir || "--"],
            ["Desktop selected root", desktopStorageSettings?.mediaRoot || "Built-in C: data folder"],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg border border-border bg-muted/15 p-3">
              <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</p>
              <p className="mt-1 break-all font-mono text-xs font-semibold text-foreground">{value}</p>
            </div>
          ))}
        </div>

        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={chooseMediaRoot}
            disabled={storageBusy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            {storageBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <FolderOpen className="h-4 w-4" />}
            Choose Folder
          </button>
          <button
            type="button"
            onClick={clearMediaRoot}
            disabled={storageBusy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-muted px-3 py-2 text-sm font-semibold text-foreground hover:bg-muted/80 disabled:opacity-50"
          >
            Reset to C:
          </button>
          <button
            type="button"
            onClick={loadStorage}
            disabled={storageBusy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-muted px-3 py-2 text-sm font-semibold text-foreground hover:bg-muted/80 disabled:opacity-50"
          >
            <RefreshCw className="h-4 w-4" />
            Refresh
          </button>
        </div>

        <p className="mt-3 rounded-lg bg-muted/25 px-3 py-2 text-xs text-muted-foreground">
          Changes apply after restarting Sarah. The database stays on C: for now; this setting moves heavy media output.
        </p>
        {storageMessage && <p className="mt-2 text-xs font-semibold text-foreground">{storageMessage}</p>}
      </section>

      <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-primary">
              <Activity className="h-4 w-4" />
              <h2 className="text-sm font-bold uppercase tracking-wider">Blood Pressure Sync</h2>
            </div>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              Sync the OMRON BP7000 directly over Bluetooth in the Android APK. Health Connect is still available as a fallback when Samsung/OMRON exposes BP there.
            </p>
          </div>
          <span className={`rounded-full px-2 py-1 text-xs font-semibold uppercase ${bpStatus?.permissionGranted ? "bg-emerald-500/10 text-emerald-400" : "bg-muted text-muted-foreground"}`}>
            {bpStatus?.native === false ? "web only" : bpStatus?.permissionGranted ? "permission on" : "permission needed"}
          </span>
        </div>

        <div className="mt-4 grid gap-3 lg:grid-cols-[1fr_auto] lg:items-start">
          <div className="rounded-lg bg-muted/25 px-3 py-3 text-sm text-muted-foreground">
            <p>
              {bpStatus?.message || (bpStatus?.available ? "Health Connect is available." : "Health Connect status has not been checked yet.")}
            </p>
            {bpStatus?.error && <p className="mt-1 text-destructive">{bpStatus.error}</p>}
            {bpMessage && <p className="mt-2 font-semibold text-foreground">{bpMessage}</p>}
          </div>
          <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:justify-end">
            <button
              type="button"
              onClick={requestBpAccess}
              disabled={bpBusy || bpStatus?.native === false}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {bpBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <KeyRound className="h-4 w-4" />}
              Allow BP
            </button>
            <button
              type="button"
              onClick={openBpSettings}
              disabled={bpBusy || bpStatus?.native === false}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-muted px-3 py-2 text-sm font-semibold text-foreground hover:bg-muted/80 disabled:opacity-50"
            >
              <ExternalLink className="h-4 w-4" />
              Health Connect
            </button>
            <button
              type="button"
              onClick={syncBloodPressure}
              disabled={bpBusy || bpStatus?.native === false || !bpStatus?.permissionGranted}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-muted px-3 py-2 text-sm font-semibold text-foreground hover:bg-muted/80 disabled:opacity-50"
            >
              {bpBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
              Sync
            </button>
            <button
              type="button"
              onClick={toggleOmronBloodPressureListener}
              disabled={bpBusy}
              className={`inline-flex items-center justify-center gap-1.5 rounded-lg px-3 py-2 text-sm font-semibold disabled:opacity-50 ${
                bpOmronListening
                  ? "bg-emerald-500/15 text-emerald-200 hover:bg-emerald-500/25"
                  : "bg-primary text-primary-foreground hover:bg-primary/90"
              }`}
            >
              {bpBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Activity className="h-4 w-4" />}
              {bpOmronListening ? "Stop OMRON" : "Listen OMRON"}
            </button>
            <button
              type="button"
              onClick={loadBloodPressure}
              disabled={bpBusy}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-muted px-3 py-2 text-sm font-semibold text-foreground hover:bg-muted/80 disabled:opacity-50"
            >
              <RefreshCw className="h-4 w-4" />
              Refresh
            </button>
          </div>
        </div>

        <div className="mt-4 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
          {bpReadings.length ? bpReadings.map((reading) => (
            <div key={reading.id} className="rounded-lg border border-border bg-muted/15 px-3 py-2">
              <p className="font-mono text-lg font-bold text-foreground">{formatBloodPressure(reading)}</p>
              <p className="mt-1 text-xs text-muted-foreground">
                {formatBloodPressureTime(reading.measured_at)} · {reading.source_app || "Health Connect"}
              </p>
            </div>
          )) : (
            <p className="rounded-lg bg-muted/25 px-3 py-4 text-sm text-muted-foreground md:col-span-2 xl:col-span-3">
              No local BP readings saved yet.
            </p>
          )}
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-primary">
              <Activity className="h-4 w-4" />
              <h2 className="text-sm font-bold uppercase tracking-wider">OBS HR Overlay</h2>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Server-owned heart-rate stream for OBS. The Browser Source does not need your Pulsoid token or Sarah browser storage.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={refreshOverlayDiagnostics}
              className="inline-flex items-center gap-1.5 rounded-lg bg-muted px-3 py-2 text-sm font-semibold text-foreground hover:bg-muted/80"
            >
              <RefreshCw className="h-4 w-4" /> Refresh
            </button>
            <button
              type="button"
              onClick={copyOverlayUrl}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary/10 px-3 py-2 text-sm font-semibold text-primary hover:bg-primary/15"
            >
              Copy OBS URL
            </button>
            <a
              href={obsOverlayUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1.5 rounded-lg bg-muted px-3 py-2 text-sm font-semibold text-foreground hover:bg-muted/80"
            >
              <ExternalLink className="h-4 w-4" /> Open overlay
            </a>
          </div>
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          {[
            ["Selected source", overlayDiagnostics?.sourceLabel || overlayDiagnostics?.source || "Unavailable"],
            ["Latest BPM", overlayDiagnostics?.heartRate ?? "--"],
            ["Data age", overlayDiagnostics?.ageMs != null ? `${Math.round(overlayDiagnostics.ageMs)} ms` : "--"],
            ["Subscribers", overlayDiagnostics?.subscribers ?? 0],
            ["Connected", overlayDiagnostics?.connected ? "Yes" : "No"],
            ["Stale", overlayDiagnostics?.stale ? "Yes" : "No"],
            ["Sequence", overlayDiagnostics?.sequence ?? 0],
            ["Last delivery", fmtDateTime(overlayDiagnostics?.lastDeliveryAt) || "--"],
          ].map(([label, value]) => (
            <div key={label} className="rounded-lg border border-border bg-muted/15 p-3">
              <p className="text-[10px] font-bold uppercase tracking-wider text-muted-foreground">{label}</p>
              <p className="mt-1 break-words text-sm font-semibold text-foreground">{String(value)}</p>
            </div>
          ))}
        </div>
        <div className="mt-4 flex flex-wrap gap-2">
          <button
            type="button"
            onClick={sendOverlayTestPulse}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
          >
            Send 101 BPM test pulse
          </button>
          <button
            type="button"
            onClick={clearOverlayTestPulse}
            className="inline-flex items-center gap-1.5 rounded-lg bg-muted px-3 py-2 text-sm font-semibold text-foreground hover:bg-muted/80"
          >
            Clear test pulse
          </button>
        </div>
        <p className="mt-3 rounded-lg bg-muted/25 px-3 py-2 text-xs text-muted-foreground">
          OBS URL: <span className="font-mono text-foreground">{obsOverlayUrl}</span>
        </p>
        {overlayMessage && <p className="mt-2 text-xs font-semibold text-foreground">{overlayMessage}</p>}
        {overlayDiagnostics?.error && <p className="mt-2 text-xs font-semibold text-destructive">{overlayDiagnostics.error}</p>}
      </section>

      <TTSSettingsPanel />

      <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-primary">
              <Image className="h-4 w-4" />
              <h2 className="text-sm font-bold uppercase tracking-wider">Sarah Identity</h2>
            </div>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              Choose the portrait Sarah uses on the splash screen, app shell, and AI chat surfaces.
            </p>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-border bg-muted/20 px-3 py-1.5 text-xs font-semibold text-muted-foreground">
            <SarahLogoMark className="h-6 w-6" />
            New Sarah mark
          </div>
        </div>

        <div className="mt-4 grid gap-3 md:grid-cols-2 xl:grid-cols-3">
          {sarahImageOptions.map((option) => {
            const active = getSarahImageOption(sarahBrand.imageId).id === option.id;
            return (
              <div
                key={option.id}
                onClick={() => updateSarahBrand(option.id)}
                onKeyDown={(event) => {
                  if (event.key === "Enter" || event.key === " ") {
                    event.preventDefault();
                    updateSarahBrand(option.id);
                  }
                }}
                role="button"
                tabIndex={0}
                className={`overflow-hidden rounded-xl border text-left transition-all focus:outline-none focus:ring-2 focus:ring-primary/40 ${active ? "border-primary bg-primary/10 shadow-sm shadow-primary/10" : "border-border bg-muted/15 hover:border-primary/50"}`}
              >
                <div className="aspect-[16/9] overflow-hidden bg-muted">
                  <img
                    src={resolveSarahImageSrc(option.src, option.id)}
                    alt={option.label}
                    className="h-full w-full object-cover"
                    style={{ objectPosition: option.position }}
                    onError={(event) => {
                      event.currentTarget.onerror = null;
                      event.currentTarget.src = "/brand/sarah-lab.jpg";
                    }}
                    draggable="false"
                  />
                </div>
                <div className="flex items-start justify-between gap-3 p-3">
                  <div>
                    <p className="text-sm font-bold text-foreground">{option.label}</p>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{option.helper}</p>
                    {option.custom && (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          removeSarahPortrait(option.id);
                        }}
                        className="mt-2 text-xs font-semibold text-destructive hover:underline"
                      >
                        Remove custom image
                      </button>
                    )}
                  </div>
                  <span className={`rounded-full px-2 py-1 text-[11px] font-semibold uppercase ${active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                    {active ? "Selected" : "Choose"}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        <div className="mt-5 grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-border bg-muted/15 p-4">
            <div className="flex items-center justify-between gap-3">
              <div>
                <p className="text-sm font-bold text-foreground">Upload Sarah portrait</p>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                  Use any local image. Sarah stores the uploaded copy locally under uploads and uses it across splash, chat, and app chrome.
                </p>
              </div>
              <label className="inline-flex cursor-pointer items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90">
                <Image className="h-4 w-4" />
                Upload
                <input type="file" accept="image/*" className="hidden" onChange={uploadSarahPortrait} />
              </label>
            </div>
            {sarahUploadStatus && <p className="mt-3 text-xs font-semibold text-muted-foreground">{sarahUploadStatus}</p>}
          </div>

          <div className="rounded-xl border border-border bg-muted/15 p-4">
            <div className="flex items-center gap-2 text-primary">
              <Sparkles className="h-4 w-4" />
              <p className="text-sm font-bold text-foreground">Generate Sarah with OpenAI</p>
            </div>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
              Describe the look you want. The prompt is sent to OpenAI image generation; the finished portrait is saved locally and selected.
            </p>
            <Textarea
              value={sarahGeneratePrompt}
              onChange={(event) => setSarahGeneratePrompt(event.target.value)}
              placeholder="Example: warm clinician, lavender lab lighting, kind expression, realistic portrait, shoulder-length dark hair..."
              className="mt-3 min-h-24"
            />
            <div className="mt-3 flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={generateSarahPortrait}
                disabled={sarahGenerating}
                className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
              >
                {sarahGenerating ? <Loader2 className="h-4 w-4 animate-spin" /> : <Sparkles className="h-4 w-4" />}
                Generate portrait
              </button>
              <button
                type="button"
                onClick={() => setSarahGeneratePrompt("")}
                className="rounded-lg bg-muted px-3 py-2 text-sm font-semibold text-foreground hover:bg-muted/80"
              >
                Clear prompt
              </button>
            </div>
            {sarahGenerateStatus.message && (
              <p className={`mt-3 text-xs font-semibold ${sarahGenerateStatus.type === "error" ? "text-destructive" : "text-muted-foreground"}`}>
                {sarahGenerateStatus.message}
              </p>
            )}
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-primary">
              <Image className="h-4 w-4" />
              <h2 className="text-sm font-bold uppercase tracking-wider">Watermark & Public Export</h2>
            </div>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              Sarah-produced MP4 exports use these settings. Public Export bakes the watermark into the final pixels and scrubs metadata.
            </p>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-border bg-muted/20 px-3 py-1.5">
            <span className="text-xs font-semibold text-muted-foreground">Enable watermark</span>
            <ToggleControl
              checked={watermark.enabled}
              onChange={(enabled) => updateWatermark({ enabled })}
              label="Enable watermark"
            />
          </div>
        </div>

        <div className="mt-4 grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
          <div className="space-y-4">
            <div className="grid gap-2 sm:grid-cols-3">
              {WATERMARK_PRESETS.map((preset) => (
                <button
                  key={preset.value}
                  type="button"
                  onClick={() => applyWatermarkPreset(preset.value)}
                  className={`rounded-lg border px-3 py-2 text-left transition-colors ${watermark.preset === preset.value ? "border-primary bg-primary/10 text-foreground" : "border-border bg-muted/15 text-muted-foreground hover:border-primary/40 hover:text-foreground"}`}
                >
                  <span className="block text-sm font-semibold">{preset.label}</span>
                  <span className="mt-0.5 block text-xs leading-relaxed opacity-85">{preset.helper}</span>
                </button>
              ))}
            </div>

            <div className="space-y-2">
              <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Corner placement</span>
              <div className="grid gap-2 sm:grid-cols-4">
                {WATERMARK_POSITION_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    onClick={() => updateWatermark({ positionMode: option.value })}
                    className={`rounded-lg border px-3 py-2 text-left text-xs font-semibold transition-colors ${watermark.positionMode === option.value ? "border-primary bg-primary/10 text-foreground" : "border-border bg-muted/15 text-muted-foreground hover:border-primary/40 hover:text-foreground"}`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            <div className="grid gap-3 md:grid-cols-3">
              <label className="space-y-1">
                <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Primary text</span>
                <input
                  value={watermark.primaryText}
                  onChange={(event) => updateWatermark({ primaryText: event.target.value })}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
                />
              </label>
              <label className="space-y-1">
                <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Secondary text</span>
                <input
                  value={watermark.secondaryText}
                  onChange={(event) => updateWatermark({ secondaryText: event.target.value })}
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
                />
              </label>
              <label className="space-y-1">
                <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Handle or URL</span>
                <input
                  value={watermark.handleText}
                  onChange={(event) => updateWatermark({ handleText: event.target.value })}
                  placeholder="@handle or short URL"
                  className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
                />
              </label>
            </div>

            <div className="grid gap-3 md:grid-cols-4">
              {[
                ["opacity", "Opacity", 0.05, 1, 0.01],
                ["textSize", "Text size", 18, 96, 1],
                ["logoSize", "Sarah image size", 32, 220, 1],
                ["paddingPercent", "Edge padding %", 1, 12, 0.5],
              ].map(([key, label, min, max, step]) => (
                <label key={key} className="space-y-1">
                  <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">{label}</span>
                  <input
                    type="number"
                    min={min}
                    max={max}
                    step={step}
                    value={watermark[key]}
                    onChange={(event) => updateWatermark({ [key]: Number(event.target.value) })}
                    className="w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground"
                  />
                </label>
              ))}
            </div>

            <div className="flex flex-wrap gap-3">
              {[
                ["shadowEnabled", "Shadow / outline"],
                ["backgroundPlateEnabled", "Background plate"],
                ["portraitEnabled", "Sarah portrait"],
                ["logoEnabled", "Sarah icon"],
                ["subtleCenterEnabled", "Subtle center duplicate"],
                ["metadataScrubEnabled", "Metadata scrub"],
              ].map(([key, label]) => (
                <label key={key} className="inline-flex items-center gap-2 rounded-full border border-border bg-muted/20 px-3 py-1.5 text-xs font-semibold text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={Boolean(watermark[key])}
                    onChange={(event) => updateWatermark({ [key]: event.target.checked })}
                    className="h-4 w-4 accent-primary"
                  />
                  {label}
                </label>
              ))}
              <button type="button" onClick={resetWatermark} className="rounded-full border border-border bg-muted/20 px-3 py-1.5 text-xs font-semibold text-muted-foreground hover:bg-muted">
                Reset defaults
              </button>
            </div>
          </div>

          <div className="rounded-xl border border-border bg-muted/20 p-3">
            <div className="flex items-center justify-between gap-2">
              <h3 className="text-sm font-bold text-foreground">Preview watermark</h3>
              <span className="rounded-full bg-primary/10 px-2 py-1 text-[11px] font-semibold uppercase text-primary">
                {watermark.positionMode.replace(/_/g, " ")}
              </span>
            </div>
            <div className="relative mt-3 aspect-video overflow-hidden rounded-lg border border-border bg-gradient-to-br from-slate-900 via-slate-700 to-slate-950">
              <div className="absolute right-[4%] top-[4%] h-[16%] w-[34%] rounded-lg border border-white/15 bg-black/35" />
              <div className="absolute bottom-[4%] right-[4%] h-[18%] w-[24%] rounded-lg border border-white/15 bg-black/35" />
              <div className="absolute bottom-[4%] left-[4%] rounded bg-black/60 px-2 py-1 text-[10px] text-white/85">timeline 0:42</div>
              {watermark.subtleCenterEnabled && watermark.enabled && (
                <div className="absolute inset-0 grid place-items-center text-center text-white/15" style={{ fontSize: Math.max(14, watermark.textSize * 0.58) }}>
                  <div>
                    <p className="font-bold">{watermark.primaryText}</p>
                    <p>{watermark.secondaryText}</p>
                  </div>
                </div>
              )}
              {watermark.enabled && (
                <div
                  className={`absolute flex max-w-[76%] items-end gap-2 rounded px-2 py-1 text-white ${watermark.backgroundPlateEnabled ? "bg-black/40" : ""}`}
                  style={{
                    ...watermarkPreviewPositionStyle(watermark.positionMode),
                    opacity: watermark.opacity,
                    fontSize: Math.max(10, watermark.textSize * 0.34),
                    textShadow: watermark.shadowEnabled ? "0 2px 4px rgba(0,0,0,.9)" : "none",
                  }}
                >
                  {watermark.portraitEnabled && (
                    <img
                      src={`/${watermark.portraitPath || "brand/sarah-lab.jpg"}`}
                      alt=""
                      className="aspect-square rounded-full border border-white/35 object-cover shadow"
                      style={{ width: Math.max(24, watermark.logoSize * 0.34) }}
                    />
                  )}
                  <div className="flex items-start gap-1.5">
                    {watermark.logoEnabled && (
                      <img
                        src={`/${watermark.logoPath || "icons/sarah-192.png"}`}
                        alt=""
                        className="mt-0.5 aspect-square rounded object-contain"
                        style={{ width: Math.max(14, watermark.logoSize * 0.16) }}
                      />
                    )}
                    <div>
                      <p className="font-bold leading-tight">{watermark.primaryText}</p>
                      <p className="leading-tight">{watermark.secondaryText}</p>
                      {watermark.handleText && <p className="leading-tight">{watermark.handleText}</p>}
                    </div>
                  </div>
                </div>
              )}
            </div>
            <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
              The final video renderer bakes this Sarah portrait, icon, and text into the bottom-right corner. Source recordings are not modified.
            </p>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-primary">
              <Brain className="h-4 w-4" />
              <h2 className="text-sm font-bold uppercase tracking-wider">Sarah Personality</h2>
            </div>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              Tune how Sarah writes and speaks session analysis: warmer, more feminine, more clinical, more plain-English, or your own short instruction.
            </p>
          </div>
          <div className="flex items-center gap-2 rounded-full border border-border bg-muted/20 px-3 py-1.5">
            <span className="text-xs font-semibold text-muted-foreground">Use style settings</span>
            <ToggleControl
              checked={sarahPersonality.enabled}
              onChange={(enabled) => updateSarahPersonality({ enabled })}
              label="Enable Sarah personality settings"
            />
          </div>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={saveSarahPersonality}
            disabled={!sarahPersonalityDirty}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
          >
            Save Sarah Settings
          </button>
          <span className={`text-xs ${sarahPersonalityDirty ? "text-amber-700" : sarahPersonalityMessage ? "text-emerald-700" : "text-muted-foreground"}`}>
            {sarahPersonalityDirty ? "Unsaved changes" : sarahPersonalityMessage || "Saved settings are used the next time you generate Sarah analysis or expressive narration."}
          </span>
        </div>

        <div className="mt-4 grid gap-4 xl:grid-cols-[1.1fr_0.9fr]">
          <div className="space-y-4">
            <div className="rounded-xl border border-border bg-muted/20 p-3">
              <div className="flex items-center gap-2 text-foreground">
                <Sparkles className="h-4 w-4 text-primary" />
                <h3 className="text-sm font-bold">Base style and tone</h3>
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-2">
                {SARAH_TONE_PRESETS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    disabled={!sarahPersonality.enabled}
                    onClick={() => updateSarahPersonality({ tonePreset: option.value })}
                    className={`rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-50 ${sarahPersonality.tonePreset === option.value ? "border-primary bg-primary/10 text-foreground" : "border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground"}`}
                  >
                    <span className="block text-sm font-semibold">{option.label}</span>
                    <span className="mt-0.5 block text-xs opacity-85">{option.helper}</span>
                  </button>
                ))}
              </div>
            </div>

            <div className="rounded-xl border border-border bg-muted/20 p-3">
              <div className="flex items-center gap-2 text-foreground">
                <Type className="h-4 w-4 text-primary" />
                <h3 className="text-sm font-bold">Clinical detail</h3>
              </div>
              <div className="mt-3 grid gap-2 sm:grid-cols-3">
                {SARAH_DETAIL_OPTIONS.map((option) => (
                  <button
                    key={option.value}
                    type="button"
                    disabled={!sarahPersonality.enabled}
                    onClick={() => updateSarahPersonality({ detailLevel: option.value })}
                    className={`rounded-lg border px-3 py-2 text-left transition-colors disabled:opacity-50 ${sarahPersonality.detailLevel === option.value ? "border-primary bg-primary/10 text-foreground" : "border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground"}`}
                  >
                    <span className="block text-sm font-semibold">{option.label}</span>
                    <span className="mt-0.5 block text-xs opacity-85">{option.helper}</span>
                  </button>
                ))}
              </div>
            </div>
          </div>

          <div className="space-y-4">
            <div className="rounded-xl border border-border bg-muted/20 p-3">
              <h3 className="text-sm font-bold text-foreground">Characteristics</h3>
              <div className="mt-3 space-y-2">
                {SARAH_PERSONALITY_TOGGLES.map((item) => (
                  <div key={item.key} className="flex items-start justify-between gap-3 rounded-lg border border-border bg-card px-3 py-2.5">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-foreground">{item.label}</p>
                      <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{item.helper}</p>
                    </div>
                    <ToggleControl
                      checked={Boolean(sarahPersonality[item.key])}
                      disabled={!sarahPersonality.enabled}
                      onChange={(checked) => updateSarahPersonality({ [item.key]: checked })}
                      label={item.label}
                    />
                  </div>
                ))}
              </div>
            </div>

            <div className="rounded-xl border border-border bg-muted/20 p-3">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-bold text-foreground">Custom instructions</h3>
                <button
                  type="button"
                  disabled={!sarahPersonality.enabled}
                  onClick={resetSarahPersonality}
                  className="rounded-md px-2 py-1 text-xs font-semibold text-muted-foreground hover:bg-muted disabled:opacity-50"
                >
                  Reset
                </button>
              </div>
              <Textarea
                disabled={!sarahPersonality.enabled}
                value={sarahPersonality.customInstructions}
                onChange={(event) => updateSarahPersonality({ customInstructions: event.target.value })}
                placeholder="Example: Read the arousal timeline with more feminine warmth and plain English, but keep the clinical claims tight."
                className="mt-3 min-h-28 resize-y bg-card text-sm"
              />
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">
                Press Save Sarah Settings after editing. These instructions affect Sarah analysis style and expressive TTS delivery. Evidence rules, privacy rules, and no-invention safeguards stay on.
              </p>
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-primary">
              <Palette className="h-4 w-4" />
              <h2 className="text-sm font-bold uppercase tracking-wider">Display & Readability</h2>
            </div>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              Pick a color theme and bump the app-wide font size without touching browser zoom.
            </p>
          </div>
          <span className="rounded-full bg-primary/10 px-2 py-1 text-xs font-semibold uppercase text-primary">
            Local only
          </span>
        </div>

        <div className="mt-4 grid gap-4 lg:grid-cols-2">
          <div className="rounded-xl border border-border bg-muted/20 p-3">
            <div className="flex items-center gap-2 text-foreground">
              <Palette className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-bold">Color theme</h3>
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {THEME_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => updateUiPrefs({ theme: option.value })}
                  className={`rounded-lg border px-3 py-2 text-left transition-colors ${uiPrefs.theme === option.value ? "border-primary bg-primary/10 text-foreground" : "border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground"}`}
                >
                  <span className="block text-sm font-semibold">{option.label}</span>
                  <span className="mt-0.5 block text-xs opacity-85">{option.helper}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="rounded-xl border border-border bg-muted/20 p-3">
            <div className="flex items-center gap-2 text-foreground">
              <Type className="h-4 w-4 text-primary" />
              <h3 className="text-sm font-bold">Font size</h3>
            </div>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              {FONT_SCALE_OPTIONS.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  onClick={() => updateUiPrefs({ fontScale: option.value })}
                  className={`rounded-lg border px-3 py-2 text-left transition-colors ${uiPrefs.fontScale === option.value ? "border-primary bg-primary/10 text-foreground" : "border-border bg-card text-muted-foreground hover:border-primary/40 hover:text-foreground"}`}
                >
                  <span className="block text-sm font-semibold">{option.label}</span>
                  <span className="mt-0.5 block text-xs opacity-85">{option.helper}</span>
                </button>
              ))}
            </div>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-primary">
              <Settings2 className="h-4 w-4" />
              <h2 className="text-sm font-bold uppercase tracking-wider">App Shell</h2>
            </div>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              If the installed app refreshes shortly after returning to it, clear the local PWA shell. This leaves sessions, analyses, videos, and settings data alone.
            </p>
          </div>
          <button
            type="button"
            onClick={resetPwaShell}
            disabled={pwaCleanupBusy}
            className="inline-flex items-center gap-1.5 rounded-lg bg-muted px-3 py-2 text-sm font-semibold text-foreground hover:bg-muted/80 disabled:opacity-50"
          >
            {pwaCleanupBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCw className="h-4 w-4" />}
            Reset Shell
          </button>
          <button
            type="button"
            onClick={applyPwaUpdateNow}
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary/10 px-3 py-2 text-sm font-semibold text-primary hover:bg-primary/15"
          >
            Apply update now
          </button>
        </div>
        <div className="mt-4 rounded-lg bg-muted/25 px-3 py-3 text-sm text-muted-foreground">
          <p>
            Sarah now lets service-worker updates wait instead of taking over while you are reading or listening. Use Apply update now only when you are ready to checkpoint and reload.
          </p>
          {pwaCleanupMessage && <p className="mt-2 text-xs font-semibold text-foreground">{pwaCleanupMessage}</p>}
        </div>
        <div className="mt-4 rounded-lg border border-border bg-muted/10 p-3">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <p className="text-xs font-bold uppercase tracking-wider text-primary">Android/PWA lifecycle diagnostics</p>
              <p className="mt-1 text-xs text-muted-foreground">Local-only resume/reload events. No report text or media is stored here.</p>
            </div>
            <button
              type="button"
              onClick={clearLifecycleLog}
              className="rounded-lg bg-muted px-2 py-1 text-xs font-semibold text-foreground hover:bg-muted/80"
            >
              Clear log
            </button>
          </div>
          <div className="mt-3 max-h-52 overflow-auto rounded-md bg-background/70 p-2 font-mono text-[11px] leading-relaxed text-muted-foreground">
            {pwaLifecycleEvents.length ? pwaLifecycleEvents.map((event, index) => (
              <div key={`${event.at}-${index}`} className="border-b border-border/60 py-1 last:border-0">
                <span className="text-foreground">{event.type}</span>
                <span> · {fmtDateTime(event.at)}</span>
                <span> · boot {String(event.bootId || "").slice(0, 10)}</span>
                {event.documentId ? <span> · doc {String(event.documentId).replace(/^sarah-doc-/, "").slice(0, 10)}</span> : null}
                <span> · {event.visibilityState}</span>
                {event.mountCount != null ? <span> · mount {event.mountCount}</span> : null}
                {event.mountCounts?.react_root ? <span> · root {event.mountCounts.react_root}</span> : null}
                {event.mountCounts?.router_tree ? <span> · router {event.mountCounts.router_tree}</span> : null}
                {event.mountCounts?.auth_provider ? <span> · auth {event.mountCounts.auth_provider}</span> : null}
                {event.wasDiscarded ? <span className="text-destructive"> · discarded</span> : null}
                {event.persisted != null ? <span> · persisted {String(event.persisted)}</span> : null}
                {event.route ? <span> · {event.route}</span> : null}
              </div>
            )) : <p>No lifecycle events recorded yet.</p>}
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-primary">
              <BellRing className="h-4 w-4" />
              <h2 className="text-sm font-bold uppercase tracking-wider">Notifications</h2>
            </div>
            <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
              Enable Sarah completion alerts. The APK uses Android local notifications; Chrome/PWA installs use browser notifications.
            </p>
          </div>
          <span className={`rounded-full px-2 py-1 text-xs font-semibold uppercase ${notificationPermission === "granted" ? "bg-emerald-500/10 text-emerald-300" : notificationPermission === "denied" ? "bg-destructive/10 text-destructive" : "bg-muted text-muted-foreground"}`}>
            {notificationSupport.supported ? notificationPermission : "unsupported"}
          </span>
        </div>

        <div className="mt-4 grid min-w-0 gap-3 md:grid-cols-[1fr_auto] md:items-center">
          <div className="min-w-0 rounded-lg bg-muted/25 px-3 py-3 text-sm leading-relaxed text-muted-foreground">
            <p>{notificationSupport.reason}</p>
            <p className="mt-1 break-words text-xs">
              These are local completion/test alerts for work the app is already tracking. Fully closed remote push can come later if we add subscription storage and backend push routes.
            </p>
            {notificationMessage && <p className="mt-2 break-words text-xs font-semibold text-foreground">{notificationMessage}</p>}
          </div>
          <div className="grid grid-cols-2 gap-2 md:flex md:flex-wrap md:justify-end">
            <button
              type="button"
              onClick={requestNotifications}
              disabled={notificationBusy || !notificationSupport.supported || (notificationPermission === "granted" && completionNotificationsEnabled)}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {notificationBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <BellRing className="h-4 w-4" />}
              {notificationPermission === "granted" && !completionNotificationsEnabled ? "Enable Alerts" : "Enable"}
            </button>
            <button
              type="button"
              onClick={sendTestNotification}
              disabled={notificationBusy || !notificationSupport.supported || notificationPermission !== "granted"}
              className="inline-flex items-center justify-center gap-1.5 rounded-lg bg-muted px-3 py-2 text-sm font-semibold text-foreground hover:bg-muted/80 disabled:opacity-50"
            >
              {notificationBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Activity className="h-4 w-4" />}
              Send Test
            </button>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-3 sm:p-5">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 text-primary">
              <Activity className="h-4 w-4" />
              <h2 className="text-sm font-bold uppercase tracking-wider">Background Tasks</h2>
            </div>
            <p className="mt-1 text-sm text-muted-foreground">
              Active jobs stay visible here across the app. Tasks without progress updates for ten minutes are flagged so they are easier to spot.
            </p>
          </div>
          <button type="button" onClick={clearTasks} disabled={clearing || !jobs.length} className="inline-flex w-full items-center justify-center gap-1.5 rounded-lg bg-destructive/10 px-3 py-2 text-sm font-semibold text-destructive hover:bg-destructive/20 disabled:opacity-50 sm:w-auto">
            {clearing ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
            Clear All Tasks
          </button>
        </div>

        {jobsError && <p className="mt-4 rounded-lg bg-destructive/10 px-3 py-2 text-sm text-destructive">{jobsError}</p>}

        <div className="mt-4 grid gap-4 xl:grid-cols-2">
          <div>
            <h3 className="flex items-center gap-2 text-sm font-bold text-foreground">
              Active or Hung
              <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs text-primary">{activeJobs.length}</span>
            </h3>
            <div className="mt-3 space-y-2">
              {activeJobs.length ? activeJobs.map(renderJob) : <p className="rounded-xl bg-muted/25 px-3 py-4 text-sm text-muted-foreground">No active background tasks right now.</p>}
            </div>
          </div>

          <div>
            <h3 className="flex items-center gap-2 text-sm font-bold text-foreground">
              Recent Results
              <span className="rounded-full bg-muted px-2 py-0.5 text-xs text-muted-foreground">{recentJobs.length}</span>
            </h3>
            <div className="mt-3 space-y-2">
              {recentJobs.length ? recentJobs.map(renderJob) : <p className="rounded-xl bg-muted/25 px-3 py-4 text-sm text-muted-foreground">Recent task history is clear.</p>}
            </div>
          </div>
        </div>

        <div className="mt-4 flex items-start gap-2 rounded-lg border border-amber-300/70 bg-amber-100 px-3 py-2 text-sm text-amber-900">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-amber-700" />
          <span>Clear All stops active jobs and removes tasks from the status surfaces. Use it when a render or analysis should not keep spending API time.</span>
        </div>
      </section>
    </div>
  );
}
