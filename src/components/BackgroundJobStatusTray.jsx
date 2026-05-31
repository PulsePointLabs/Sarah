import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Bell, BellOff, CheckCircle2, ChevronDown, ChevronUp, ExternalLink, Loader2, Square, X, XCircle } from "lucide-react";
import { cancelBackgroundJob, listBackgroundJobs } from "@/lib/backgroundJobs";
import { backgroundJobRoute } from "@/lib/backgroundJobRoutes";
import {
  areBackgroundNotificationsEnabled,
  getNotificationPermission,
  isNotificationSupported,
  notifyBackgroundJobFinished,
  requestBackgroundNotificationPermission,
  setBackgroundNotificationsEnabled,
} from "@/utils/backgroundJobNotifications";

const DISMISSED_RESULTS_KEY = "pulsepoint.backgroundJobs.dismissedTerminalIds";

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

function jobLabel(job) {
  if (job?.meta?.title) return job.meta.title;
  if (job?.meta?.label) return job.meta.label;
  if (job?.type === "tts_export") return "Audio render";
  if (job?.type === "ai_invoke") return "AI analysis";
  return job?.type || "Background job";
}

function statusTone(status) {
  if (status === "complete") return "text-emerald-400 bg-emerald-500/10 border-emerald-500/25";
  if (status === "error" || status === "cancelled") return "text-destructive bg-destructive/10 border-destructive/25";
  return "text-primary bg-primary/10 border-primary/25";
}

function progressMessage(job) {
  const message = job?.progress?.message || job?.error || job?.status;
  if (
    job?.status === "complete" &&
    job?.progress?.phase === "complete" &&
    !/(complete|completed|ready|finished)/i.test(String(message || ""))
  ) {
    return "Complete";
  }
  return message;
}

function jobTarget(job) {
  return backgroundJobRoute(job) || null;
}

export default function BackgroundJobStatusTray() {
  const navigate = useNavigate();
  const [jobs, setJobs] = useState([]);
  const [expanded, setExpanded] = useState(false);
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
  const jobsInitializedRef = useRef(false);
  const dismissedTerminalIdsRef = useRef(dismissedTerminalIds);

  useEffect(() => {
    dismissedTerminalIdsRef.current = dismissedTerminalIds;
    window.localStorage.setItem(DISMISSED_RESULTS_KEY, JSON.stringify([...dismissedTerminalIds].slice(-100)));
  }, [dismissedTerminalIds]);

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
          listBackgroundJobs({ status: "complete,error,cancelled", limit: 4 }),
        ]);
        if (cancelled) return;
        const merged = new Map();
        [...(active.jobs || []), ...(recent.jobs || [])].forEach((job) => {
          if (job?.id) merged.set(job.id, job);
        });
        const loadedJobs = [...merged.values()].sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0));
        if (jobsInitializedRef.current) {
          loadedJobs.forEach((job) => {
            const previousStatus = previousJobStatusesRef.current.get(job.id);
            if (["queued", "running"].includes(previousStatus) && ["complete", "error"].includes(job.status)) {
              notifyBackgroundJobFinished(job, {
                route: jobTarget(job),
                onOpen: (target) => navigate(target),
              });
            }
          });
        }
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

  const dismissFinished = (jobIds) => {
    setDismissedTerminalIds((previous) => new Set([...previous, ...jobIds]));
  };

  if (closed || (!visibleJobs.length && !offline)) return null;

  return (
    <div className={`fixed bottom-3 left-3 right-3 sm:left-auto sm:w-[24rem] ${expanded ? "z-50" : "z-20"}`}>
      <div className="rounded-xl border border-border bg-card/95 shadow-2xl backdrop-blur">
        <div className="flex items-center gap-1 px-1 py-1">
          <button
            type="button"
            onClick={() => setExpanded((value) => !value)}
            className="flex min-w-0 flex-1 items-center gap-2 px-2 py-1 text-left"
          >
            {activeCount > 0 ? <Loader2 className="h-4 w-4 animate-spin text-primary" /> : offline ? <XCircle className="h-4 w-4 text-muted-foreground" /> : <CheckCircle2 className="h-4 w-4 text-emerald-400" />}
            <div className="min-w-0 flex-1">
              <p className="text-sm font-semibold text-foreground">
                {activeCount > 0 ? `${activeCount} background task${activeCount === 1 ? "" : "s"} running` : offline ? "Background status unavailable" : "Background tasks updated"}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {progressMessage(visibleJobs[0]) || (offline ? "Local API may need a restart." : "Recent AI/TTS work is visible here.")}
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
          <div className="max-h-72 space-y-2 overflow-y-auto border-t border-border p-2">
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
                Notifications work while PulsePoint is open or running in the background. Fully closed-app delivery may require future service worker support.
              </p>
            )}
            {visibleJobs.map((job) => {
              const progress = job.progress || {};
              const total = Number(progress.total || 0);
              const current = Number(progress.current || 0);
              const active = ["queued", "running"].includes(job.status);
              const pct = !active ? 100 : total > 0 ? Math.max(8, Math.min(100, Math.round((current / total) * 100))) : 20;
              const target = jobTarget(job);
              const cancelling = cancellingIds.has(job.id);
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
                  <div className="mt-1.5 flex items-center justify-between gap-2 text-[10px] opacity-75">
                    <span>{progress.phase || job.type}</span>
                    <span>{fmtTime(job.updatedAt || job.finishedAt || job.createdAt)}</span>
                  </div>
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
  );
}
