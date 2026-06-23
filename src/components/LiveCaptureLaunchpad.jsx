import { Activity, CheckCircle2, ChevronDown, HeartPulse, Mic2, Radio, Settings2, Video, Zap } from "lucide-react";

function Pill({ icon, label, value, helper, tone = "neutral", optional = false }) {
  const toneClass = tone === "good"
    ? "border-emerald-400/30 bg-emerald-500/10 text-emerald-900 dark:text-emerald-100"
    : tone === "warn"
      ? "border-amber-400/35 bg-amber-400/10 text-amber-900 dark:text-amber-100"
      : tone === "bad"
        ? "border-destructive/35 bg-destructive/10 text-destructive"
        : "border-border bg-card text-foreground";
  return (
    <div className={`rounded-xl border px-3 py-2 ${toneClass}`}>
      <div className="flex items-center gap-2">
        {icon}
        <span className="text-[10px] font-semibold uppercase tracking-wider opacity-80">{label}</span>
        {optional && <span className="ml-auto rounded-full bg-background/70 px-1.5 py-0.5 text-[9px] font-semibold opacity-70">Optional</span>}
      </div>
      <p className="mt-1 text-sm font-bold">{value}</p>
      {helper && <p className="mt-0.5 line-clamp-2 text-[11px] opacity-75">{helper}</p>}
    </div>
  );
}

export default function LiveCaptureLaunchpad({
  captureKind,
  onCaptureKindChange,
  setupSummary = [],
  readiness = {},
  primaryLabel = "Start Session",
  primaryDisabled = false,
  primaryBusy = false,
  progress = [],
  onStart,
  onChangeSetup,
  advancedOpen = false,
  cueSummary = "",
  active = false,
}) {
  const isBody = captureKind === "body_exploration";
  return (
    <section className="rounded-2xl border border-primary/25 bg-card p-4 shadow-sm md:p-5">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-primary">
            <Radio className="h-4 w-4" />
            Session Launchpad
          </p>
          <h2 className="mt-2 text-2xl font-bold tracking-tight text-foreground">
            {active ? "Session Live" : "Ready when the signal is real"}
          </h2>
          <p className="mt-1 max-w-2xl text-sm leading-relaxed text-muted-foreground">
            Using last successful setup. Optional systems stay out of the way unless this capture requires them.
          </p>
        </div>
        <div className="inline-flex rounded-xl border border-border bg-muted/35 p-1">
          {[
            ["session", "Session"],
            ["body_exploration", "Body Exploration"],
          ].map(([value, label]) => (
            <button
              key={value}
              type="button"
              disabled={active}
              onClick={() => onCaptureKindChange?.(value)}
              className={`rounded-lg px-3 py-2 text-sm font-semibold transition-colors ${
                captureKind === value
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-background hover:text-foreground"
              } disabled:cursor-not-allowed disabled:opacity-60`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="mt-4 rounded-xl border border-border bg-muted/20 p-3">
        <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
          <div>
            <p className="text-sm font-semibold text-foreground">Using last successful setup</p>
            <p className="mt-1 text-sm text-muted-foreground">{setupSummary.join(" · ")}</p>
          </div>
          <button
            type="button"
            onClick={onChangeSetup}
            className="inline-flex items-center justify-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-sm font-semibold text-foreground hover:bg-muted"
          >
            <Settings2 className="h-4 w-4" />
            Change setup
            <ChevronDown className={`h-4 w-4 transition-transform ${advancedOpen ? "rotate-180" : ""}`} />
          </button>
        </div>
      </div>

      <div className="mt-4 grid gap-2 sm:grid-cols-2 xl:grid-cols-4 2xl:grid-cols-7">
        <Pill icon={<HeartPulse className="h-4 w-4" />} label={readiness.h10?.label || "H10"} {...readiness.h10} />
        <Pill icon={<Activity className="h-4 w-4" />} label={readiness.hr?.label || "Live HR"} {...readiness.hr} />
        <Pill icon={<Video className="h-4 w-4" />} label="OBS" optional {...readiness.obs} />
        <Pill icon={<Activity className="h-4 w-4" />} label="EMG" optional {...readiness.emg} />
        <Pill icon={<Mic2 className="h-4 w-4" />} label="Sarah voice" optional={!readiness.voice?.required} {...readiness.voice} />
        <Pill icon={<Video className="h-4 w-4" />} label="Media" optional {...readiness.media} />
        <Pill icon={<Zap className="h-4 w-4" />} label="Howl" optional {...readiness.howl} />
      </div>

      {cueSummary && (
        <div className="mt-3 rounded-xl border border-primary/20 bg-primary/[0.06] px-3 py-2 text-sm text-foreground">
          {cueSummary}
        </div>
      )}

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

      <div className="sticky bottom-[env(safe-area-inset-bottom)] z-20 mt-5 md:static">
        <button
          type="button"
          onClick={onStart}
          disabled={primaryDisabled || primaryBusy}
          className={`flex min-h-16 w-full items-center justify-center rounded-2xl px-5 py-4 text-lg font-bold shadow-lg transition-colors ${
            active
              ? "bg-emerald-500 text-white"
              : primaryDisabled
                ? "bg-muted text-muted-foreground"
                : "bg-primary text-primary-foreground hover:bg-primary/90"
          }`}
        >
          {primaryBusy ? "Starting..." : isBody && !active ? primaryLabel.replace("Session", "Body Exploration") : primaryLabel}
        </button>
      </div>
    </section>
  );
}
