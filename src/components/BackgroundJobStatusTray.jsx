import { useEffect, useMemo, useState } from "react";
import { CheckCircle2, ChevronDown, ChevronUp, Loader2, XCircle } from "lucide-react";
import { listBackgroundJobs } from "@/lib/backgroundJobs";

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

export default function BackgroundJobStatusTray() {
  const [jobs, setJobs] = useState([]);
  const [expanded, setExpanded] = useState(false);
  const [hiddenCompleteIds, setHiddenCompleteIds] = useState(() => new Set());
  const [offline, setOffline] = useState(false);

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
        setJobs([...merged.values()].sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0)));
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
  }, []);

  const visibleJobs = useMemo(() => {
    const cutoff = Date.now() - 1000 * 60 * 20;
    return jobs.filter((job) => {
      if (hiddenCompleteIds.has(job.id)) return false;
      if (["queued", "running"].includes(job.status)) return true;
      return new Date(job.updatedAt || job.finishedAt || job.createdAt || 0).getTime() >= cutoff;
    });
  }, [hiddenCompleteIds, jobs]);

  const activeCount = visibleJobs.filter((job) => ["queued", "running"].includes(job.status)).length;
  if (!visibleJobs.length && !offline) return null;

  return (
    <div className="fixed bottom-3 left-3 right-3 z-40 sm:left-auto sm:w-[24rem]">
      <div className="rounded-xl border border-border bg-card/95 shadow-2xl backdrop-blur">
        <button
          type="button"
          onClick={() => setExpanded((value) => !value)}
          className="flex w-full items-center gap-2 px-3 py-2 text-left"
        >
          {activeCount > 0 ? <Loader2 className="h-4 w-4 animate-spin text-primary" /> : offline ? <XCircle className="h-4 w-4 text-muted-foreground" /> : <CheckCircle2 className="h-4 w-4 text-emerald-400" />}
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-foreground">
              {activeCount > 0 ? `${activeCount} background task${activeCount === 1 ? "" : "s"} running` : offline ? "Background status unavailable" : "Background tasks updated"}
            </p>
            <p className="truncate text-xs text-muted-foreground">
              {visibleJobs[0]?.progress?.message || (offline ? "Local API may need a restart." : "Recent AI/TTS work is visible here.")}
            </p>
          </div>
          {expanded ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronUp className="h-4 w-4 text-muted-foreground" />}
        </button>

        {expanded && (
          <div className="max-h-72 space-y-2 overflow-y-auto border-t border-border p-2">
            {visibleJobs.map((job) => {
              const progress = job.progress || {};
              const total = Number(progress.total || 0);
              const current = Number(progress.current || 0);
              const pct = total > 0 ? Math.max(8, Math.min(100, Math.round((current / total) * 100))) : ["queued", "running"].includes(job.status) ? 20 : 100;
              return (
                <div key={job.id} className={`rounded-lg border px-3 py-2 ${statusTone(job.status)}`}>
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-sm font-semibold">{jobLabel(job)}</p>
                      <p className="mt-0.5 text-xs opacity-85">{progress.message || job.error || job.status}</p>
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
                  {!["queued", "running"].includes(job.status) && (
                    <button
                      type="button"
                      onClick={() => setHiddenCompleteIds((prev) => new Set([...prev, job.id]))}
                      className="mt-1 text-[10px] font-medium opacity-75 hover:opacity-100"
                    >
                      Hide
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}
