import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useNavigate } from "react-router-dom";
import { Bell, BellOff, CheckCircle2, ChevronDown, ChevronUp, ExternalLink, Loader2, Maximize2, Square, X, XCircle } from "lucide-react";
import { cancelBackgroundJob, listBackgroundJobs } from "@/lib/backgroundJobs";
import { stabilizeBackgroundJobEta } from "@/lib/backgroundJobEta";
import { backgroundJobLabel as jobLabel } from "@/lib/backgroundJobLabels";
import { backgroundJobRoute } from "@/lib/backgroundJobRoutes";
import { friendlyJobStatusMessage } from "@/lib/jobErrorMessages";
import { serverUrl } from "@/lib/mobileApiBase";
import {
  areBackgroundNotificationsEnabled,
  getNotificationPermission,
  isNotificationSupported,
  listenForBackgroundNotificationActions,
  notifyBackgroundJobFinished,
  requestBackgroundNotificationPermission,
  setBackgroundNotificationsEnabled,
} from "@/utils/backgroundJobNotifications";

const DISMISSED_RESULTS_KEY = "pulsepoint.backgroundJobs.dismissedTerminalIds";
const COLLAPSED_DOCK_BOTTOM_KEY = "pulsepoint.backgroundJobs.collapsedDockBottom";
const DEFAULT_COLLAPSED_DOCK_BOTTOM = 112;
const SIDE_DOCK_DRAG_THRESHOLD_PX = 6;

function ProductionPreviewModal({ job, onClose }) {
  const progress = job?.progress || {};
  const frames = Array.isArray(progress.preview_frames) ? progress.preview_frames : [];
  const [selectedUrl, setSelectedUrl] = useState(progress.preview_frame?.url || "");
  const selectedFrame = frames.find((frame) => frame.url === selectedUrl) || progress.preview_frame;

  useEffect(() => {
    setSelectedUrl(progress.preview_frame?.url || "");
  }, [progress.preview_frame?.url]);

  useEffect(() => {
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const closeOnEscape = (event) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [onClose]);

  if (!selectedFrame?.url) return null;
  return createPortal(
    <div className="fixed inset-0 z-[1000] flex bg-slate-950/95 text-white backdrop-blur-md" role="dialog" aria-modal="true" aria-label="Live production preview">
      <div className="flex h-full w-full flex-col overflow-hidden landscape:flex-row">
        <div className="relative flex min-h-0 flex-1 items-center justify-center bg-black p-2 sm:p-4">
          <img
            src={serverUrl(selectedFrame.url)}
            alt={`Produced review-video frame ${selectedFrame.segmentIndex || ""}`}
            className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
          />
          <button type="button" onClick={onClose} className="absolute right-3 top-3 rounded-full border border-white/25 bg-black/75 p-2.5 text-white shadow-lg" aria-label="Close production preview">
            <X className="h-5 w-5" />
          </button>
          <div className="absolute bottom-3 left-3 rounded-full border border-white/20 bg-black/75 px-3 py-1.5 text-xs font-semibold backdrop-blur">
            Segment {selectedFrame.segmentIndex || progress.preview_segment_current || 0} / {progress.preview_segment_total || "?"}
          </div>
        </div>
        <aside className="max-h-[46vh] shrink-0 overflow-y-auto border-t border-white/15 bg-slate-900/95 p-4 landscape:max-h-none landscape:w-[22rem] landscape:border-l landscape:border-t-0 lg:w-[28rem]">
          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-fuchsia-300">Live Production Preview</p>
          <h2 className="mt-2 text-lg font-semibold leading-snug">{selectedFrame.label || "Production segment"}</h2>
          <div className="mt-3 flex flex-wrap gap-2 text-xs text-slate-300">
            {Number.isFinite(Number(selectedFrame.sourceSessionSeconds)) && <span className="rounded-full border border-white/15 px-2.5 py-1">{formatDuration(selectedFrame.sourceSessionSeconds)}</span>}
            {selectedFrame.focus?.target && <span className="rounded-full border border-white/15 px-2.5 py-1">Focus: {String(selectedFrame.focus.target).replace(/_/g, " ")}</span>}
            {selectedFrame.motionFrames != null && <span className="rounded-full border border-white/15 px-2.5 py-1">Motion: {selectedFrame.motionFrames}</span>}
            {selectedFrame.sourceLabel && <span className="max-w-full truncate rounded-full border border-white/15 px-2.5 py-1">Camera: {selectedFrame.sourceLabel}</span>}
          </div>
          {selectedFrame.replacedStaticWindow && <p className="mt-3 rounded-lg border border-amber-300/35 bg-amber-300/10 p-3 text-sm font-semibold text-amber-100">Static timestamp rejected; showing a verified active window instead.</p>}
          {selectedFrame.narration && <p className="mt-4 text-sm leading-relaxed text-slate-200">{selectedFrame.narration}</p>}
          {frames.length > 1 && (
            <div className="mt-5">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-slate-400">Recent Produced Frames</p>
              <div className="grid grid-cols-4 gap-2 landscape:grid-cols-2 lg:grid-cols-2">
                {frames.map((frame) => (
                  <button key={`${frame.segmentIndex}-${frame.url}`} type="button" onClick={() => setSelectedUrl(frame.url)} className={`overflow-hidden rounded-md border-2 ${frame.url === selectedFrame.url ? "border-fuchsia-400" : "border-transparent opacity-70"}`}>
                    <img src={serverUrl(frame.url)} alt={`Produced segment ${frame.segmentIndex}`} className="aspect-video w-full bg-black object-cover" />
                    <span className="block bg-black/70 px-1 py-0.5 text-[10px]">#{frame.segmentIndex}</span>
                  </button>
                ))}
              </div>
            </div>
          )}
        </aside>
      </div>
    </div>,
    document.body,
  );
}

function clampDockBottom(value, dockHeight = 74) {
  if (typeof window === "undefined") return DEFAULT_COLLAPSED_DOCK_BOTTOM;
  const viewportHeight = window.innerHeight || 720;
  const min = 14;
  const max = Math.max(min, viewportHeight - dockHeight - 72);
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return Math.min(DEFAULT_COLLAPSED_DOCK_BOTTOM, max);
  return Math.max(min, Math.min(max, numeric));
}

function loadCollapsedDockBottom() {
  try {
    return clampDockBottom(window.localStorage.getItem(COLLAPSED_DOCK_BOTTOM_KEY));
  } catch {
    return DEFAULT_COLLAPSED_DOCK_BOTTOM;
  }
}

function loadDismissedResults() {
  try {
    const stored = JSON.parse(window.localStorage.getItem(DISMISSED_RESULTS_KEY) || "[]");
    return new Set(Array.isArray(stored) ? stored : []);
  } catch {
    return new Set();
  }
}

function fmtTime(value) {
  if (!value) return "";
  try {
    return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

function fmtDateTime(value) {
  if (!value) return "";
  try {
    return new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  } catch {
    return "";
  }
}

function formatBytes(value) {
  const bytes = Number(value || 0);
  if (!Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes >= 1024 * 1024) return `${Math.round(bytes / 1024 / 1024)} MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${bytes} B`;
}

function formatDuration(value) {
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
    mimeType: summary.mime_type || result.mime_type || "",
  };
}

function openResultFile(result) {
  if (!result?.fileUrl) return;
  window.open(serverUrl(result.fileUrl), "_blank", "noopener,noreferrer");
}

function statusTone(status) {
  if (status === "complete") return "text-emerald-800 bg-emerald-50 border-emerald-300";
  if (status === "error" || status === "cancelled") return "text-destructive bg-destructive/10 border-destructive/25";
  return "text-foreground bg-primary/10 border-primary/30";
}

function progressMessage(job) {
  return friendlyJobStatusMessage(job);
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
    progress.framesScanned ?? progress.frames_scanned ?? progress.scanned_frames,
    progress.candidatesFound ?? progress.candidates_found ?? progress.candidate_events,
    progress.candidatesSelectedForQwen ?? progress.candidates_selected_for_qwen,
    progress.qwenCallsTotal != null ? `${progress.qwenCallsCompleted || 0}/${progress.qwenCallsTotal}` : null,
    progress.confirmedFindingsCount ?? progress.confirmed_findings_count,
    progress.strongCandidatesCount ?? progress.strong_candidates_count,
    progress.notConfirmedCount ?? progress.not_confirmed_count,
    progress.blocked_claims,
  ].some((value) => value != null)
    ? [
      { label: "scanned", value: progress.framesScanned ?? progress.frames_scanned ?? progress.scanned_frames },
      { label: "candidates", value: progress.candidatesFound ?? progress.candidates_found ?? progress.candidate_events },
      { label: "Qwen selected", value: progress.candidatesSelectedForQwen ?? progress.candidates_selected_for_qwen },
      { label: "Qwen", value: progress.qwenCallsTotal != null ? `${progress.qwenCallsCompleted || 0}/${progress.qwenCallsTotal}` : null },
      { label: "confirmed", value: progress.confirmedFindingsCount ?? progress.confirmed_findings_count },
      { label: "strong", value: progress.strongCandidatesCount ?? progress.strong_candidates_count },
      { label: "not confirmed", value: progress.notConfirmedCount ?? progress.not_confirmed_count },
      { label: "blocked", value: progress.blocked_claims },
    ].filter((item) => item.value != null)
    : [];
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

function activePhaseFallback(job) {
  if (!["queued", "running"].includes(job?.status)) return "";
  const progress = job?.progress || {};
  const current = Number(progress.current || 0);
  const total = Number(progress.total || 0);
  if (!Number.isFinite(current) || !Number.isFinite(total) || total <= 0 || current < total) return "";
  const phase = String(progress.phase || "current phase").replace(/_/g, " ");
  return `Finishing ${phase}`;
}

function jobTarget(job) {
  return backgroundJobRoute(job) || null;
}

function isQuietTrayJob(job) {
  return Boolean(
    job?.meta?.quietInTray ||
    job?.meta?.foreground ||
    (job?.type === "ai_invoke" && /^ai_chat_/i.test(String(job?.meta?.source || "")))
  );
}

export default function BackgroundJobStatusTray() {
  const navigate = useNavigate();
  const [jobs, setJobs] = useState([]);
  const [expanded, setExpanded] = useState(false);
  const [previewJobId, setPreviewJobId] = useState(null);
  const [cycleIndex, setCycleIndex] = useState(0);
  const [collapsedDockBottom, setCollapsedDockBottom] = useState(loadCollapsedDockBottom);
  const [dismissedTerminalIds, setDismissedTerminalIds] = useState(loadDismissedResults);
  const [cancellingIds, setCancellingIds] = useState(() => new Set());
  const [offline, setOffline] = useState(false);
  const [closed, setClosed] = useState(false);
  const [notificationPermission, setNotificationPermission] = useState(getNotificationPermission);
  const [notificationsEnabled, setNotificationsEnabled] = useState(areBackgroundNotificationsEnabled);
  const [notificationMessage, setNotificationMessage] = useState("");
  const previousActiveIdsRef = useRef(new Set());
  const previousJobIdsRef = useRef(new Set());
  const previousJobStatusesRef = useRef(new Map());
  const etaCacheRef = useRef(new Map());
  const collapsedDockDragRef = useRef(null);
  const suppressCollapsedDockClickRef = useRef(false);
  const jobsInitializedRef = useRef(false);
  const dismissedTerminalIdsRef = useRef(dismissedTerminalIds);
  const wasHiddenSinceLastPollRef = useRef(
    typeof document !== "undefined" && (document.hidden || document.visibilityState !== "visible" || !document.hasFocus())
  );

  useEffect(() => {
    return listenForBackgroundNotificationActions((target) => {
      if (target) navigate(target);
    });
  }, [navigate]);

  useEffect(() => {
    dismissedTerminalIdsRef.current = dismissedTerminalIds;
    window.localStorage.setItem(DISMISSED_RESULTS_KEY, JSON.stringify([...dismissedTerminalIds].slice(-100)));
  }, [dismissedTerminalIds]);

  useEffect(() => {
    const markHidden = () => {
      if (document.hidden || document.visibilityState !== "visible" || !document.hasFocus()) {
        wasHiddenSinceLastPollRef.current = true;
      }
    };
    document.addEventListener("visibilitychange", markHidden);
    window.addEventListener("blur", markHidden);
    return () => {
      document.removeEventListener("visibilitychange", markHidden);
      window.removeEventListener("blur", markHidden);
    };
  }, []);

  const goToJob = (job) => {
    const target = jobTarget(job);
    if (!target) return;
    navigate(target);
    setExpanded(false);
  };

  const handleCancel = async (job, event) => {
    event?.stopPropagation();
    if (!job?.id || cancellingIds.has(job.id)) return;

    setCancellingIds((prev) => new Set([...prev, job.id]));
    try {
      const cancelledJob = await cancelBackgroundJob(job.id);
      setJobs((prev) => prev.map((item) => (item.id === job.id ? cancelledJob : item)));
    } catch (err) {
      setJobs((prev) =>
        prev.map((item) =>
          item.id === job.id
            ? {
                ...item,
                status: "error",
                error: err?.message || "Could not stop this job.",
                updatedAt: new Date().toISOString(),
              }
            : item
        )
      );
    } finally {
      setCancellingIds((prev) => {
        const next = new Set(prev);
        next.delete(job.id);
        return next;
      });
    }
  };

  const toggleNotifications = async () => {
    setNotificationMessage("");
    if (!isNotificationSupported()) {
      setNotificationMessage("Notifications are not supported in this browser or app mode.");
      return;
    }
    if (notificationPermission === "denied") {
      setNotificationMessage("Notifications are blocked by browser or app settings.");
      return;
    }
    if (notificationPermission !== "granted") {
      const permission = await requestBackgroundNotificationPermission();
      setNotificationPermission(permission);
      setNotificationsEnabled(permission === "granted");
      setNotificationMessage(permission === "granted"
        ? "Completion notifications enabled."
        : permission === "denied"
          ? "Notifications are blocked by browser or app settings."
          : "Notifications were not enabled.");
      return;
    }
    const nextEnabled = !notificationsEnabled;
    setBackgroundNotificationsEnabled(nextEnabled);
    setNotificationsEnabled(nextEnabled);
    setNotificationMessage(nextEnabled ? "Completion notifications enabled." : "Completion notifications disabled.");
  };

  useEffect(() => {
    let cancelled = false;
    let timer = null;

    const load = async () => {
      try {
        const [active, recent] = await Promise.all([
          listBackgroundJobs({ status: "queued,running", limit: 8 }),
          listBackgroundJobs({ status: "complete,error,cancelled", limit: 12 }),
        ]);
        if (cancelled) return;
        const merged = new Map();
        [...(active.jobs || []), ...(recent.jobs || [])].forEach((job) => {
          if (job?.id) merged.set(job.id, job);
        });
        const loadedJobs = [...merged.values()]
          .filter((job) => !isQuietTrayJob(job))
          .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
        const shouldForceResumeNotification = wasHiddenSinceLastPollRef.current;
        if (jobsInitializedRef.current) {
          loadedJobs.forEach((job) => {
            const previousStatus = previousJobStatusesRef.current.get(job.id);
            if (["queued", "running"].includes(previousStatus) && ["complete", "error"].includes(job.status)) {
              notifyBackgroundJobFinished(job, {
                route: jobTarget(job),
                onOpen: (target) => navigate(target),
                force: shouldForceResumeNotification,
              });
            }
          });
        }
        wasHiddenSinceLastPollRef.current = document.hidden || document.visibilityState !== "visible" || !document.hasFocus();
        const activeIds = new Set(loadedJobs.filter((job) => ["queued", "running"].includes(job.status)).map((job) => job.id));
        const newActiveJob = [...activeIds].some((id) => !previousActiveIdsRef.current.has(id));
        const newVisibleResult = loadedJobs.some((job) => (
          !previousJobIdsRef.current.has(job.id)
          && !["queued", "running"].includes(job.status)
          && !dismissedTerminalIdsRef.current.has(job.id)
        ));
        if (newActiveJob || newVisibleResult) setClosed(false);
        previousActiveIdsRef.current = activeIds;
        previousJobIdsRef.current = new Set(loadedJobs.map((job) => job.id));
        previousJobStatusesRef.current = new Map(loadedJobs.map((job) => [job.id, job.status]));
        const liveJobIds = new Set(loadedJobs.map((job) => job.id));
        for (const jobId of etaCacheRef.current.keys()) {
          if (!liveJobIds.has(jobId)) etaCacheRef.current.delete(jobId);
        }
        jobsInitializedRef.current = true;
        setJobs(loadedJobs);
        setOffline(false);
      } catch {
        if (!cancelled) setOffline(true);
      } finally {
        if (!cancelled) timer = window.setTimeout(load, 3500);
      }
    };

    load();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [navigate]);

  const visibleJobs = useMemo(() => {
    return jobs.filter((job) => {
      if (!["queued", "running"].includes(job.status) && dismissedTerminalIds.has(job.id)) return false;
      return true;
    });
  }, [dismissedTerminalIds, jobs]);

  const activeCount = visibleJobs.filter((job) => ["queued", "running"].includes(job.status)).length;
  const completedJobs = visibleJobs.filter((job) => job.status === "complete");
  const jobsToRender = activeCount > 0
    ? [
      ...visibleJobs.filter((job) => ["queued", "running", "error", "cancelled"].includes(job.status)).slice(0, 4),
      ...completedJobs.filter((job) => jobResultSummary(job)).slice(0, 3),
    ].filter((job, index, list) => list.findIndex((item) => item.id === job.id) === index)
    : visibleJobs.slice(0, 6);
  const primaryActiveJob = visibleJobs.find((job) => ["queued", "running"].includes(job.status));
  const primaryEta = stabilizeBackgroundJobEta(primaryActiveJob, etaCacheRef.current);
  const primaryPhaseFallback = activePhaseFallback(primaryActiveJob);
  const cycleJobs = visibleJobs.filter((job) => ["queued", "running"].includes(job.status)).length
    ? visibleJobs.filter((job) => ["queued", "running"].includes(job.status))
    : visibleJobs;
  const cycleJob = cycleJobs.length ? cycleJobs[cycleIndex % cycleJobs.length] : null;
  const cycleEta = stabilizeBackgroundJobEta(cycleJob, etaCacheRef.current);
  const cycleText = cycleJob
    ? [
      jobLabel(cycleJob),
      cycleEta?.label || activePhaseFallback(cycleJob),
    ].filter(Boolean).join(" · ")
    : offline
      ? "Desktop API unreachable. Check Wi-Fi/Tailscale."
      : "Recent work is visible here.";

  useEffect(() => {
    if (cycleJobs.length <= 1 || expanded) return undefined;
    const timer = window.setInterval(() => {
      setCycleIndex((value) => value + 1);
    }, 3600);
    return () => window.clearInterval(timer);
  }, [cycleJobs.length, expanded]);

  useEffect(() => {
    if (expanded) return undefined;
    const clampCurrentPosition = () => {
      setCollapsedDockBottom((value) => {
        const next = clampDockBottom(value);
        try {
          window.localStorage.setItem(COLLAPSED_DOCK_BOTTOM_KEY, String(next));
        } catch {
          // Position persistence is optional.
        }
        return next;
      });
    };
    window.addEventListener("resize", clampCurrentPosition);
    return () => window.removeEventListener("resize", clampCurrentPosition);
  }, [expanded]);

  const beginCollapsedDockDrag = (event) => {
    if (event.button != null && event.button !== 0) return;
    collapsedDockDragRef.current = {
      startY: event.clientY,
      startBottom: collapsedDockBottom,
      moved: false,
    };
    suppressCollapsedDockClickRef.current = false;
    event.currentTarget.setPointerCapture?.(event.pointerId);
  };

  const moveCollapsedDock = (event) => {
    const drag = collapsedDockDragRef.current;
    if (!drag) return;
    const delta = drag.startY - event.clientY;
    if (Math.abs(delta) > SIDE_DOCK_DRAG_THRESHOLD_PX) drag.moved = true;
    if (!drag.moved) return;
    event.preventDefault();
    setCollapsedDockBottom(clampDockBottom(drag.startBottom + delta));
  };

  const endCollapsedDockDrag = () => {
    const drag = collapsedDockDragRef.current;
    collapsedDockDragRef.current = null;
    if (!drag?.moved) return;
    suppressCollapsedDockClickRef.current = true;
    setCollapsedDockBottom((value) => {
      const next = clampDockBottom(value);
      try {
        window.localStorage.setItem(COLLAPSED_DOCK_BOTTOM_KEY, String(next));
      } catch {
        // Position persistence is optional.
      }
      return next;
    });
    window.setTimeout(() => {
      suppressCollapsedDockClickRef.current = false;
    }, 0);
  };

  const dismissFinished = (jobIds) => {
    setDismissedTerminalIds((previous) => new Set([...previous, ...jobIds]));
  };

  if (closed || (!visibleJobs.length && !offline)) return null;

  if (!expanded) {
    return (
      <div
        className="fixed right-0 z-30 max-w-[11rem] sm:right-4 sm:max-w-[16rem]"
        style={{ bottom: `${collapsedDockBottom}px` }}
      >
        <button
          type="button"
          onClick={(event) => {
            if (suppressCollapsedDockClickRef.current) {
              event.preventDefault();
              return;
            }
            setExpanded(true);
          }}
          onPointerDown={beginCollapsedDockDrag}
          onPointerMove={moveCollapsedDock}
          onPointerUp={endCollapsedDockDrag}
          onPointerCancel={endCollapsedDockDrag}
          className="group flex min-h-16 w-full touch-none items-center gap-2 rounded-l-2xl border border-r-0 border-border bg-card/95 px-3 py-2 text-left shadow-2xl backdrop-blur transition-colors hover:bg-card sm:rounded-2xl sm:border"
          title="Show background tasks"
        >
          <span className="relative flex h-9 w-9 shrink-0 items-center justify-center rounded-full bg-primary/10 text-primary">
            {activeCount > 0 ? <Loader2 className="h-4 w-4 animate-spin" /> : offline ? <XCircle className="h-4 w-4 text-muted-foreground" /> : <CheckCircle2 className="h-4 w-4 text-emerald-400" />}
            <span className="absolute -right-1 -top-1 min-w-5 rounded-full bg-card px-1 text-center text-[10px] font-bold text-foreground shadow">
              {activeCount || visibleJobs.length}
            </span>
          </span>
          <span className="min-w-0 flex-1">
            <span className="block text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
              {activeCount > 0 ? "Running" : offline ? "Offline" : "Updated"}
            </span>
            <span key={`${cycleJob?.id || "offline"}-${cycleIndex}`} className="block truncate text-xs font-semibold text-foreground animate-pulse">
              {cycleText}
            </span>
          </span>
          <ChevronUp className="h-4 w-4 shrink-0 text-muted-foreground transition-transform group-hover:-translate-y-0.5" />
        </button>
      </div>
    );
  }

  return (
    <>
    <div className="fixed bottom-2 left-2 right-2 z-50 sm:bottom-3 sm:left-auto sm:right-3 sm:w-[24rem]">
      <div className="rounded-xl border border-border bg-card/95 shadow-2xl backdrop-blur">
        <div className="flex items-center gap-1 px-1 py-1">
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1 text-left"
          >
            {activeCount > 0 ? <Loader2 className="h-4 w-4 animate-spin text-primary" /> : offline ? <XCircle className="h-4 w-4 text-muted-foreground" /> : <CheckCircle2 className="h-4 w-4 text-emerald-400" />}
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold leading-tight text-foreground">
                {activeCount > 0 ? `${activeCount} background task${activeCount === 1 ? "" : "s"} running` : offline ? "Background status unavailable" : "Background tasks updated"}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {primaryActiveJob
                  ? [progressMessage(primaryActiveJob), primaryEta?.label].filter(Boolean).join(" · ")
                  || [progressMessage(primaryActiveJob), primaryPhaseFallback].filter(Boolean).join(" · ")
                  : progressMessage(visibleJobs[0]) || (offline ? "Desktop API unreachable. Check Wi-Fi/Tailscale." : "Recent AI/TTS work is visible here.")}
              </p>
            </div>
            {expanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronUp className="h-4 w-4 text-muted-foreground" />}
          </button>
          <button
            type="button"
            onClick={() => {
              setClosed(true);
              setExpanded(false);
            }}
            aria-label="Close background tasks bar"
            title="Close background tasks bar"
            className="rounded-md p-2 text-muted-foreground hover:bg-muted hover:text-foreground"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        {expanded && (
          <div className="max-h-[45vh] space-y-2 overflow-y-auto border-t border-border p-2 sm:max-h-72">
            {completedJobs.length > 0 && (
              <div className="flex flex-wrap items-center justify-between gap-2">
                <button
                  type="button"
                  onClick={toggleNotifications}
                  className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-semibold ${
                    notificationsEnabled ? "border-primary/35 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground"
                  }`}
                >
                  {notificationsEnabled ? <Bell className="h-3 w-3" /> : <BellOff className="h-3 w-3" />}
                  {notificationsEnabled ? "Completion notifications enabled" : notificationPermission === "denied" ? "Notifications blocked" : "Enable completion notifications"}
                </button>
                <button
                  type="button"
                  onClick={() => dismissFinished(completedJobs.map((job) => job.id))}
                  className="rounded-full border border-border px-2.5 py-1 text-[10px] font-semibold text-muted-foreground hover:border-primary/40 hover:text-foreground"
                >
                  Dismiss completed
                </button>
              </div>
            )}
            {!completedJobs.length && (
              <button
                type="button"
                onClick={toggleNotifications}
                className={`inline-flex items-center gap-1.5 rounded-full border px-2.5 py-1 text-[10px] font-semibold ${
                  notificationsEnabled ? "border-primary/35 bg-primary/10 text-primary" : "border-border text-muted-foreground hover:border-primary/40 hover:text-foreground"
                }`}
              >
                {notificationsEnabled ? <Bell className="h-3 w-3" /> : <BellOff className="h-3 w-3" />}
                {notificationsEnabled ? "Completion notifications enabled" : notificationPermission === "denied" ? "Notifications blocked" : "Enable completion notifications"}
              </button>
            )}
            {notificationMessage && (
              <p className="rounded-lg border border-border bg-muted/20 px-2.5 py-2 text-[10px] text-muted-foreground">
                {notificationMessage}
              </p>
            )}
            {notificationsEnabled && (
              <p className="px-1 text-[10px] leading-relaxed text-muted-foreground">
                Notifications work while Sarah is open or backgrounded. The APK uses Android local notifications; Chrome uses browser notifications.
              </p>
            )}
            {activeCount > 0 && completedJobs.length > 0 && (
              <p className="rounded-lg border border-border bg-muted/20 px-2.5 py-2 text-[10px] leading-relaxed text-muted-foreground">
                {completedJobs.length} completed result{completedJobs.length === 1 ? "" : "s"} available. Outputs stay visible below active work.
              </p>
            )}
            {jobsToRender.map((job) => {
              const progress = job.progress || {};
              const total = Number(progress.total || 0);
              const current = Number(progress.current || 0);
              const active = ["queued", "running"].includes(job.status);
              const pct = !active ? 100 : total > 0 ? Math.max(8, Math.min(100, Math.round((current / total) * 100))) : 20;
              const target = jobTarget(job);
              const cancelling = cancellingIds.has(job.id);
              const eta = stabilizeBackgroundJobEta(job, etaCacheRef.current);
              const phaseFallback = activePhaseFallback(job);
              const counts = progressCounts(job);
              const result = jobResultSummary(job);
              const resultDetails = [
                result?.duration ? formatDuration(result.duration) : "",
                result?.size ? formatBytes(result.size) : "",
                result?.createdAt ? `Created ${fmtDateTime(result.createdAt)}` : "",
              ].filter(Boolean).join(" · ");
              return (
                <div
                  key={job.id}
                  role={target ? "button" : undefined}
                  tabIndex={target ? 0 : undefined}
                  onClick={() => goToJob(job)}
                  onKeyDown={(event) => {
                    if (!target) return;
                    if (event.target?.closest?.("button")) return;
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      goToJob(job);
                    }
                  }}
                  className={`rounded-lg border px-3 py-2 transition-colors ${statusTone(job.status)} ${target ? "cursor-pointer hover:border-current/70 hover:bg-current/15" : ""}`}
                >
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{jobLabel(job)}</p>
                      <p className="mt-0.5 text-xs opacity-85">{progressMessage(job)}</p>
                    </div>
                    <span className="shrink-0 text-[10px] font-semibold uppercase opacity-80">{job.status}</span>
                  </div>
                  <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-black/20">
                    <div className="h-full rounded-full bg-current transition-all" style={{ width: `${pct}%` }} />
                  </div>
                  {job.type === "session_review_video" && progress.preview_frame?.url && (
                    <button
                      type="button"
                      onClick={(event) => {
                        event.stopPropagation();
                        setPreviewJobId(job.id);
                      }}
                      className="mt-2 flex w-full items-center justify-between gap-3 rounded-lg border border-current/25 bg-black/10 px-3 py-2 text-left hover:bg-black/15"
                    >
                      <span className="min-w-0">
                        <span className="block text-xs font-semibold">Open live production preview</span>
                        <span className="block truncate text-[10px] opacity-75">Frame {progress.preview_segment_current || progress.preview_frame.segmentIndex || 0} of {progress.preview_segment_total || "?"}</span>
                      </span>
                      <Maximize2 className="h-4 w-4 shrink-0" />
                    </button>
                  )}
                  {job.progress?.latest_summary && (
                    <p className="mt-2 rounded-md border border-current/20 bg-black/10 px-2 py-1.5 text-[10px] leading-relaxed opacity-90">
                      <span className="font-semibold">Latest evidence:</span> {job.progress.latest_summary}
                    </p>
                  )}
                  {currentCandidateText(job.progress) && (
                    <p className="mt-2 rounded-md border border-current/20 bg-black/10 px-2 py-1.5 text-[10px] leading-relaxed opacity-90">
                      <span className="font-semibold">Current checkpoint:</span> {currentCandidateText(job.progress)}
                    </p>
                  )}
                  {adaptiveProgressChips(job.progress).length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] opacity-80">
                      {adaptiveProgressChips(job.progress).map((chip) => (
                        <span key={chip.label} className="rounded-full border border-current/20 px-2 py-0.5">
                          {chip.value} {chip.label}
                        </span>
                      ))}
                    </div>
                  )}
                  <div className="mt-1.5 flex items-center justify-between gap-2 text-[10px] opacity-75">
                    <span className="min-w-0 truncate">{progress.phase || job.type}</span>
                    {counts && <span className="shrink-0 font-mono">{counts}</span>}
                    <span>{fmtTime(job.updatedAt || job.finishedAt || job.createdAt)}</span>
                  </div>
                  {result && (
                    <div className="mt-2 rounded-md border border-current/20 bg-black/10 px-2 py-1.5 text-[10px] leading-relaxed opacity-95">
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-semibold">Output ready</span>
                        <button
                          type="button"
                          onClick={(event) => {
                            event.stopPropagation();
                            openResultFile(result);
                          }}
                          className="inline-flex items-center gap-1 rounded-full border border-current/25 px-2 py-0.5 font-semibold hover:opacity-100"
                        >
                          <ExternalLink className="h-3 w-3" />
                          Open output
                        </button>
                      </div>
                      {result.filename && <p className="mt-1 truncate font-mono opacity-80">{result.filename}</p>}
                      {resultDetails && <p className="mt-0.5 opacity-80">{resultDetails}</p>}
                    </div>
                  )}
                  {active && (eta || phaseFallback) && (
                    <div className="mt-1.5 flex flex-wrap items-center gap-2 text-[10px] font-semibold opacity-85">
                      <span className="rounded-full border border-current/20 px-2 py-0.5">{eta?.label || phaseFallback}</span>
                      {eta?.elapsedLabel && <span className="rounded-full border border-current/20 px-2 py-0.5">{eta.elapsedLabel}</span>}
                    </div>
                  )}
                  <div className="mt-2 flex flex-wrap items-center gap-2">
                    {target && (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          goToJob(job);
                        }}
                        aria-label={`Open ${jobLabel(job)}`}
                        className="inline-flex items-center gap-1 rounded-full border border-current/25 px-2 py-1 text-[10px] font-semibold opacity-85 hover:opacity-100"
                      >
                        <ExternalLink className="h-3 w-3" />
                        Open
                      </button>
                    )}
                    {active && (
                      <button
                        type="button"
                        disabled={cancelling}
                        onClick={(event) => handleCancel(job, event)}
                        aria-label={`Stop ${jobLabel(job)}`}
                        className="inline-flex items-center gap-1 rounded-full border border-current/25 px-2 py-1 text-[10px] font-semibold opacity-85 hover:opacity-100 disabled:cursor-not-allowed disabled:opacity-50"
                      >
                        {cancelling ? <Loader2 className="h-3 w-3 animate-spin" /> : <Square className="h-3 w-3" />}
                        {cancelling ? "Stopping" : "Stop"}
                      </button>
                    )}
                    {!active && (
                      <button
                        type="button"
                        onClick={(event) => {
                          event.stopPropagation();
                          dismissFinished([job.id]);
                        }}
                        aria-label={`Dismiss ${jobLabel(job)}`}
                        className="rounded-full px-2 py-1 text-[10px] font-medium opacity-75 hover:opacity-100"
                      >
                        Dismiss
                      </button>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
    {previewJobId && (
      <ProductionPreviewModal
        job={visibleJobs.find((job) => job.id === previewJobId)}
        onClose={() => setPreviewJobId(null)}
      />
    )}
    </>
  );
}
