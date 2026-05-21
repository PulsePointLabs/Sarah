import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import {
  Activity,
  CircleDollarSign,
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
import { cancelBackgroundJob, clearBackgroundJobs, listBackgroundJobs } from "@/lib/backgroundJobs";
import { getProviderStatus } from "@/lib/providerStatus";

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

function jobLabel(job) {
  return job?.meta?.title || job?.meta?.label || (job?.type === "tts_export" ? "Audio render" : job?.type === "ai_invoke" ? "AI analysis" : job?.type || "Background task");
}

function jobRoute(job) {
  if (job?.meta?.route) return job.meta.route;
  if (job?.meta?.sessionId) return `/sessions/${job.meta.sessionId}`;
  if (job?.type === "tts_export") return "/library";
  if (job?.type === "ai_invoke") return "/sessions";
  return "";
}

function progressPercent(job) {
  const progress = job?.progress || {};
  const active = ["queued", "running"].includes(job?.status);
  const total = Number(progress.total || 0);
  const current = Number(progress.current || 0);
  if (!active) return 100;
  return total > 0 ? Math.max(8, Math.min(100, Math.round((current / total) * 100))) : 18;
}

function isPossiblyStale(job) {
  if (!["queued", "running"].includes(job?.status)) return false;
  const updated = new Date(job?.progress?.updatedAt || job?.updatedAt || 0).getTime();
  return Number.isFinite(updated) && Date.now() - updated > 10 * 60 * 1000;
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
        <div className="mt-2 flex flex-wrap justify-between gap-2 text-xs text-muted-foreground">
          <span>{job?.progress?.phase || job.type}{job?.progress?.model ? ` / ${job.progress.model}` : ""}</span>
          <span>Updated {elapsedLabel(job?.progress?.updatedAt || job.updatedAt)}{job.updatedAt ? ` / ${fmtDateTime(job.updatedAt)}` : ""}</span>
        </div>
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
          <h1 className="mt-2 text-3xl font-bold tracking-tight text-foreground">PulsePoint control room</h1>
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
        ) : (
          <div className="mt-4 grid gap-3 lg:grid-cols-2">
            <ProviderCard status={providerStatus?.providers?.anthropic} />
            <ProviderCard status={providerStatus?.providers?.openai} />
          </div>
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

        <div className="mt-4 flex items-start gap-2 rounded-lg bg-amber-500/10 px-3 py-2 text-sm text-amber-100">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <span>Clear All stops active jobs and removes tasks from the status surfaces. Use it when a render or analysis should not keep spending API time.</span>
        </div>
      </section>
    </div>
  );
}
