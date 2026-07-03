import { CheckCircle2, HeartPulse } from "lucide-react";

export default function LiveCaptureLaunchpad({
  setupSummary = [],
  readiness = {},
  primaryDisabled = false,
  primaryBusy = false,
  progress = [],
  onStart,
}) {
  const hrReady = readiness.hr?.tone === "good" || readiness.h10?.tone === "good";
  return (
    <section className="rounded-2xl border border-primary/30 bg-card p-4 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-primary">
            <HeartPulse className="h-4 w-4" />
            {hrReady ? "Telemetry connected" : "Quick Connect"}
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {hrReady ? "Your signal is live. Start the session when ready." : setupSummary.join(" · ") || "Reconnect the last successful telemetry setup."}
          </p>
        </div>
        <button
          type="button"
          onClick={onStart}
          disabled={primaryDisabled || primaryBusy}
          className="inline-flex min-h-12 shrink-0 items-center justify-center rounded-xl bg-primary px-5 py-3 text-base font-bold text-primary-foreground shadow-md hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {primaryBusy ? "Connecting..." : hrReady ? "Start Session" : "Quick Connect"}
        </button>
      </div>

      {progress.length > 0 && (
        <div className="mt-4 grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
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
