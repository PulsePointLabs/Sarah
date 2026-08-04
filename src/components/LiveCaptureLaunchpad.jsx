import { AlertTriangle, CheckCircle2, ChevronRight, HeartPulse, Settings2, Video } from "lucide-react";

function toneClasses(tone) {
  if (tone === "good") return "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300";
  if (tone === "bad") return "border-destructive/35 bg-destructive/10 text-destructive";
  if (tone === "warn") return "border-amber-500/35 bg-amber-500/10 text-amber-700 dark:text-amber-300";
  return "border-border bg-muted/25 text-muted-foreground";
}

function ReadinessCard({ label, item = {}, required = false }) {
  const ready = item.tone === "good";
  const blocked = required && item.tone === "bad";
  return (
    <div className={`rounded-xl border p-3 ${toneClasses(blocked ? "bad" : item.tone)}`}>
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[10px] font-bold uppercase tracking-[0.14em]">{label}</p>
          <p className="mt-1 text-base font-bold text-foreground">{item.value || "Waiting"}</p>
        </div>
        {ready ? <CheckCircle2 className="h-5 w-5 shrink-0" /> : <AlertTriangle className="h-5 w-5 shrink-0" />}
      </div>
      <p className="mt-2 text-xs leading-relaxed opacity-90">{item.helper || "No status received yet."}</p>
      <p className="mt-2 text-[10px] font-bold uppercase tracking-wider opacity-75">{required ? "Required" : "Optional"}</p>
    </div>
  );
}

export default function LiveCaptureLaunchpad({
  setupSummary = [],
  readiness = {},
  primaryLabel = "Start Session",
  primaryDisabled = false,
  primaryBusy = false,
  progress = [],
  captureLabel = "Session",
  captureKind = "session",
  captureKinds = [],
  obsRequired = true,
  onStart,
  onOpenSetup,
  onCaptureKindChange,
}) {
  const hrReady = readiness.hr?.tone === "good" || readiness.h10?.tone === "good";
  const obsReady = readiness.obs?.tone === "good";
  const hardBlocked = !hrReady || (obsRequired && !obsReady);
  const blockers = [
    !hrReady ? "a current heart-rate packet" : null,
    obsRequired && !obsReady ? "the OBS connection" : null,
  ].filter(Boolean);

  return (
    <section className="rounded-2xl border-2 border-primary/35 bg-card p-4 shadow-lg md:p-5" aria-labelledby="live-capture-preflight-title">
      <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-xs font-bold uppercase tracking-[0.16em] text-primary">
            <HeartPulse className="h-4 w-4" /> Step 1 · Preflight
          </p>
          <h2 id="live-capture-preflight-title" className="mt-1 text-2xl font-bold text-foreground">
            {hardBlocked ? "Finish setup before recording" : "Ready to start the session"}
          </h2>
          <p className="mt-1 max-w-3xl text-sm leading-relaxed text-muted-foreground">
            {hardBlocked
              ? `Sarah still needs ${blockers.join(" and ")}. Optional devices will not block launch.`
              : `Starting ${captureLabel.toLowerCase()} will start OBS first, wait for confirmation, and use that recording boundary as 0:00.`}
          </p>
          {setupSummary.length > 0 && (
            <p className="mt-2 text-xs font-medium text-muted-foreground">Last working setup: {setupSummary.join(" · ")}</p>
          )}
        </div>
        <div className="flex shrink-0 flex-col gap-2 sm:flex-row xl:flex-col">
          <button
            type="button"
            onClick={onStart}
            disabled={primaryDisabled || primaryBusy}
            className="inline-flex min-h-14 min-w-56 items-center justify-center gap-2 rounded-xl bg-primary px-6 py-3 text-base font-black text-primary-foreground shadow-md hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-55"
          >
            {primaryBusy ? "Starting safely…" : primaryLabel}
            {!primaryBusy && <ChevronRight className="h-5 w-5" />}
          </button>
          <button
            type="button"
            onClick={onOpenSetup}
            className="inline-flex min-h-11 items-center justify-center gap-2 rounded-xl border border-border bg-muted/40 px-4 py-2 text-sm font-bold text-foreground hover:bg-muted"
          >
            <Settings2 className="h-4 w-4" /> Review setup
          </button>
        </div>
      </div>

      <div className="mt-5 grid gap-3 md:grid-cols-2 xl:grid-cols-4">
        <ReadinessCard label="Heart rate" item={readiness.hr?.tone === "good" ? readiness.hr : readiness.h10} required />
        <ReadinessCard label="OBS recording" item={readiness.obs} required={obsRequired} />
        <ReadinessCard label="Voice and coaching" item={readiness.voice} />
        <ReadinessCard label="Howl" item={readiness.howl} />
      </div>

      {captureKinds.length > 0 && (
        <div className="mt-4 rounded-xl border border-border bg-muted/20 p-3">
          <p className="text-[10px] font-bold uppercase tracking-[0.14em] text-muted-foreground">Record this as</p>
          <div className="mt-2 grid gap-2 sm:grid-cols-2">
            {captureKinds.map((kind) => (
              <button
                key={kind.value}
                type="button"
                onClick={() => onCaptureKindChange?.(kind.value)}
                disabled={primaryBusy}
                className={`rounded-xl border px-4 py-3 text-left transition disabled:opacity-50 ${captureKind === kind.value ? "border-primary bg-primary/10 text-foreground" : "border-border bg-card text-muted-foreground hover:bg-muted/50 hover:text-foreground"}`}
              >
                <span className="block text-sm font-black">{kind.label}</span>
                <span className="mt-1 block text-xs leading-relaxed">{kind.helper}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      <div className="mt-4 flex items-start gap-2 rounded-xl border border-primary/20 bg-primary/[0.05] px-3 py-2 text-xs leading-relaxed text-muted-foreground">
        <Video className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <span><strong className="text-foreground">Launch order:</strong> validate telemetry → confirm optional features → start OBS → confirm recording → create the {captureLabel.toLowerCase()} record.</span>
      </div>

      {progress.length > 0 && (
        <div className="mt-4 grid gap-2 sm:grid-cols-3 lg:grid-cols-6" aria-live="polite">
          {progress.map((item) => (
            <div key={item.label} className={`rounded-lg border px-3 py-2 text-xs ${item.done ? "border-emerald-400/25 bg-emerald-500/10" : item.active ? "border-primary/30 bg-primary/10" : "border-border bg-muted/20"}`}>
              <div className="flex items-center gap-2">
                {item.done ? <CheckCircle2 className="h-3.5 w-3.5 text-emerald-500" /> : <span className={`h-2 w-2 rounded-full ${item.active ? "bg-primary" : "bg-muted-foreground/35"}`} />}
                <span className="font-semibold text-foreground">{item.label}</span>
              </div>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
