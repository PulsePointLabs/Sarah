import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Activity,
  BellRing,
  Brain,
  CircleDollarSign,
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
import { Textarea } from "@/components/ui/textarea";
import { SarahLogoMark } from "@/components/SarahBrand";
import { cancelBackgroundJob, clearBackgroundJobs, listBackgroundJobs } from "@/lib/backgroundJobs";
import { backgroundJobRoute } from "@/lib/backgroundJobRoutes";
import { getProviderStatus } from "@/lib/providerStatus";
import {
  getSarahImageOption,
  readSarahBrandSettings,
  SARAH_IMAGE_OPTIONS,
  saveSarahBrandSettings,
} from "@/lib/sarahBrand";
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
  const notificationSupport = useMemo(() => getNotificationSupport(), []);
  const [notificationPermission, setNotificationPermission] = useState(getNotificationPermission);
  const [completionNotificationsEnabled, setCompletionNotificationsEnabled] = useState(areBackgroundNotificationsEnabled);
  const [notificationMessage, setNotificationMessage] = useState("");
  const [notificationBusy, setNotificationBusy] = useState(false);
  const [pwaCleanupBusy, setPwaCleanupBusy] = useState(false);
  const [pwaCleanupMessage, setPwaCleanupMessage] = useState("");
  const [uiPrefs, setUiPrefs] = useState(readUiPreferences);
  const [sarahBrand, setSarahBrand] = useState(readSarahBrandSettings);
  const [sarahPersonality, setSarahPersonality] = useState(readSarahPersonalitySettings);
  const [sarahPersonalityDirty, setSarahPersonalityDirty] = useState(false);
  const [sarahPersonalityMessage, setSarahPersonalityMessage] = useState("");

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

  useEffect(() => {
    if (!notificationSupport.supported) return;
    setNotificationPermission(getNotificationPermission());
    setCompletionNotificationsEnabled(areBackgroundNotificationsEnabled());
  }, [notificationSupport.supported]);

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
      });
      setNotificationMessage("Test notification sent.");
    } catch (error) {
      setNotificationMessage(error?.message || "Could not send the test notification.");
    } finally {
      setNotificationBusy(false);
    }
  };

  const updateSarahBrand = (imageId) => {
    setSarahBrand(saveSarahBrandSettings({ imageId }));
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
    return (
      <article key={job.id} className="rounded-xl border border-border bg-card p-3">
        <div className="flex flex-wrap items-start justify-between gap-2">
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <p className="truncate text-sm font-bold text-foreground">{jobLabel(job)}</p>
              {stale && <span className="rounded-full bg-amber-500/10 px-2 py-0.5 text-[11px] font-semibold text-amber-200">May be hung</span>}
            </div>
            <p className="mt-1 text-sm text-muted-foreground">{job?.progress?.message || job?.error || job.status}</p>
          </div>
          <span className={`rounded-full px-2 py-1 text-xs font-semibold uppercase ${active ? "bg-primary/10 text-primary" : job.status === "complete" ? "bg-emerald-500/10 text-emerald-300" : "bg-destructive/10 text-destructive"}`}>
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
        <div className="mt-2 flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
          <span>
            {job?.progress?.phase || job.type}
            {counts ? ` · ${counts}` : ""}
            {job?.progress?.model ? ` / ${job.progress.model}` : ""}
          </span>
          <span>Updated {elapsedLabel(job?.progress?.updatedAt || job.updatedAt)}{job.updatedAt ? ` / ${fmtDateTime(job.updatedAt)}` : ""}</span>
        </div>
        {active && (eta || phaseFallback) && (
          <div className="mt-2 flex flex-wrap gap-2 text-xs font-semibold text-primary">
            <span className="rounded-full border border-primary/25 bg-primary/10 px-2 py-1">{eta?.label || phaseFallback}</span>
            {eta?.elapsedLabel && <span className="rounded-full border border-border bg-muted/20 px-2 py-1 text-muted-foreground">{eta.elapsedLabel}</span>}
          </div>
        )}
        <div className="mt-3 flex flex-wrap gap-2">
          {route && (
            <button type="button" onClick={() => navigate(route)} className="inline-flex items-center gap-1.5 rounded-lg bg-muted px-2.5 py-1.5 text-xs font-semibold text-foreground hover:bg-muted/80">
              <ExternalLink className="h-3.5 w-3.5" />
              Open
            </button>
          )}
          {active && (
            <button type="button" disabled={stoppingIds.has(job.id)} onClick={() => stopJob(job)} className="inline-flex items-center gap-1.5 rounded-lg bg-destructive/10 px-2.5 py-1.5 text-xs font-semibold text-destructive hover:bg-destructive/20 disabled:opacity-60">
              {stoppingIds.has(job.id) ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Square className="h-3.5 w-3.5" />}
              {stoppingIds.has(job.id) ? "Stopping" : "Stop"}
            </button>
          )}
        </div>
      </article>
    );
  };

  return (
    <div className="mx-auto w-full max-w-7xl space-y-5 px-4 py-6 sm:px-6">
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
      </header>

      <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
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

        <div className="mt-4 grid gap-3 md:grid-cols-2">
          {SARAH_IMAGE_OPTIONS.map((option) => {
            const active = getSarahImageOption(sarahBrand.imageId).id === option.id;
            return (
              <button
                key={option.id}
                type="button"
                onClick={() => updateSarahBrand(option.id)}
                className={`overflow-hidden rounded-xl border text-left transition-all ${active ? "border-primary bg-primary/10 shadow-sm shadow-primary/10" : "border-border bg-muted/15 hover:border-primary/50"}`}
              >
                <div className="aspect-[16/9] overflow-hidden bg-muted">
                  <img
                    src={option.src}
                    alt={option.label}
                    className="h-full w-full object-cover"
                    style={{ objectPosition: option.position }}
                    draggable="false"
                  />
                </div>
                <div className="flex items-start justify-between gap-3 p-3">
                  <div>
                    <p className="text-sm font-bold text-foreground">{option.label}</p>
                    <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{option.helper}</p>
                  </div>
                  <span className={`rounded-full px-2 py-1 text-[11px] font-semibold uppercase ${active ? "bg-primary text-primary-foreground" : "bg-muted text-muted-foreground"}`}>
                    {active ? "Selected" : "Choose"}
                  </span>
                </div>
              </button>
            );
          })}
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
        </div>
        <div className="mt-4 rounded-lg bg-muted/25 px-3 py-3 text-sm text-muted-foreground">
          <p>
            Dev/mobile builds now unregister service workers automatically so Chrome cannot swap an old shell back in while Sarah is running.
          </p>
          {pwaCleanupMessage && <p className="mt-2 text-xs font-semibold text-foreground">{pwaCleanupMessage}</p>}
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

        <div className="mt-4 grid gap-3 md:grid-cols-[1fr_auto] md:items-center">
          <div className="rounded-lg bg-muted/25 px-3 py-3 text-sm text-muted-foreground">
            <p>{notificationSupport.reason}</p>
            <p className="mt-1 text-xs">
              These are local completion/test alerts for work the app is already tracking. Fully closed remote push can come later if we add subscription storage and backend push routes.
            </p>
            {notificationMessage && <p className="mt-2 text-xs font-semibold text-foreground">{notificationMessage}</p>}
          </div>
          <div className="flex flex-wrap gap-2 md:justify-end">
            <button
              type="button"
              onClick={requestNotifications}
              disabled={notificationBusy || !notificationSupport.supported || (notificationPermission === "granted" && completionNotificationsEnabled)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground hover:bg-primary/90 disabled:opacity-50"
            >
              {notificationBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <BellRing className="h-4 w-4" />}
              {notificationPermission === "granted" && !completionNotificationsEnabled ? "Enable Alerts" : "Enable"}
            </button>
            <button
              type="button"
              onClick={sendTestNotification}
              disabled={notificationBusy || !notificationSupport.supported || notificationPermission !== "granted"}
              className="inline-flex items-center gap-1.5 rounded-lg bg-muted px-3 py-2 text-sm font-semibold text-foreground hover:bg-muted/80 disabled:opacity-50"
            >
              {notificationBusy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Activity className="h-4 w-4" />}
              Send Test
            </button>
          </div>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-4 sm:p-5">
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
          <button type="button" onClick={clearTasks} disabled={clearing || !jobs.length} className="inline-flex items-center gap-1.5 rounded-lg bg-destructive/10 px-3 py-2 text-sm font-semibold text-destructive hover:bg-destructive/20 disabled:opacity-50">
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
