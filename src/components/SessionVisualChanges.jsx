import { useMemo, useState } from "react";
import { Eye, Focus, Maximize2, X, ZoomIn, ZoomOut } from "lucide-react";
import { Button } from "@/components/ui/button";
import { serverUrl } from "@/lib/mobileApiBase";
import { buildHighConfidenceVisualChanges } from "@/utils/sessionVisualChanges";

function formatTime(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function MetricPill({ label, value }) {
  if (value == null || value === "") return null;
  return (
    <span className="rounded-full border border-border bg-background/75 px-2.5 py-1 text-[10px] text-muted-foreground">
      <strong className="text-primary">{label}</strong> {value}
    </span>
  );
}

function MomentTelemetry({ telemetry = {} }) {
  const delta = telemetry.hr != null && telemetry.baseline != null ? telemetry.hr - telemetry.baseline : null;
  return (
    <div className="flex flex-wrap gap-1.5">
      <MetricPill label="HR" value={telemetry.hr != null ? `${Math.round(telemetry.hr)} bpm` : ""} />
      <MetricPill label="Δ base" value={delta != null ? `${delta >= 0 ? "+" : ""}${Math.round(delta)} bpm` : ""} />
      <MetricPill label="RMSSD" value={telemetry.rmssd != null ? `${Number(telemetry.rmssd).toFixed(1)} ms` : ""} />
      <MetricPill label="SDNN" value={telemetry.sdnn != null ? `${Number(telemetry.sdnn).toFixed(1)} ms` : ""} />
      <MetricPill label="HRV" value={telemetry.hrvQuality} />
      <MetricPill label="Resp" value={telemetry.respiration > 0 ? `${Number(telemetry.respiration).toFixed(1)}/min` : ""} />
      <MetricPill label="Motion" value={telemetry.motion && telemetry.motion !== "unavailable" ? telemetry.motion.replace(/_/g, " ") : ""} />
    </div>
  );
}

export default function SessionVisualChanges({ session, timelineRows = [] }) {
  const changes = useMemo(() => buildHighConfidenceVisualChanges(session, timelineRows), [session, timelineRows]);
  const [selected, setSelected] = useState(null);
  const [focusMode, setFocusMode] = useState(false);
  const [zoom, setZoom] = useState(1);

  if (!changes.length) return null;
  const selectedSrc = selected?.imageUrl ? serverUrl(selected.imageUrl) : "";
  const effectiveScale = focusMode ? selected?.focus?.scale * zoom : zoom;

  const openMoment = (moment, focus = false) => {
    setSelected(moment);
    setFocusMode(focus);
    setZoom(1);
  };

  return (
    <>
      <details id="session-visual-changes" className="scroll-mt-24 min-w-0 rounded-2xl border border-primary/20 bg-card p-4">
        <summary className="cursor-pointer list-none [&::-webkit-details-marker]:hidden">
          <div className="flex min-w-0 items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-primary">
                <Eye className="h-4 w-4" /> High-Confidence Visual Changes
              </h3>
              <p className="mt-1 text-sm text-muted-foreground">
                {changes.length} saved visual change{changes.length === 1 ? "" : "s"}, ordered from start to finish with moment telemetry and image focus.
              </p>
            </div>
            <span className="shrink-0 rounded-full border border-primary/20 bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary">{changes.length}</span>
          </div>
        </summary>

        <div className="mt-4 space-y-3 border-t border-border pt-4">
          {changes.map((change) => {
            const src = change.imageUrl ? serverUrl(change.imageUrl) : "";
            return (
              <article key={change.id} className="grid min-w-0 gap-3 rounded-xl border border-border bg-muted/10 p-3 sm:grid-cols-[minmax(0,180px)_minmax(0,1fr)]">
                {src ? (
                  <button
                    type="button"
                    onClick={() => openMoment(change, false)}
                    className="group relative min-w-0 overflow-hidden rounded-lg border border-border bg-black text-left"
                    title="Open moment image"
                  >
                    <img src={src} alt={change.title} className="aspect-video w-full object-cover transition-transform group-hover:scale-[1.03]" loading="lazy" />
                    <span className="absolute bottom-2 right-2 rounded-md bg-black/75 px-2 py-1 text-[10px] font-semibold text-white">
                      <Maximize2 className="mr-1 inline h-3 w-3" /> {formatTime(change.frameTimeS)}
                    </span>
                  </button>
                ) : (
                  <div className="flex aspect-video items-center justify-center rounded-lg border border-dashed border-border bg-background text-xs text-muted-foreground">No saved still</div>
                )}
                <div className="min-w-0 space-y-2">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="font-mono text-xs font-semibold text-primary">{formatTime(change.timeS)}</p>
                      <h4 className="mt-0.5 text-sm font-semibold capitalize text-foreground">{change.title}</h4>
                    </div>
                    <span className="rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-400">High confidence</span>
                  </div>
                  <p className="text-sm leading-relaxed text-foreground/90">{change.overview}</p>
                  <MomentTelemetry telemetry={change.telemetry} />
                  {src && (
                    <div className="flex flex-wrap gap-2 pt-1">
                      <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={() => openMoment(change, false)}>
                        <Maximize2 className="h-3.5 w-3.5" /> Full frame
                      </Button>
                      <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={() => openMoment(change, true)}>
                        <Focus className="h-3.5 w-3.5" /> Focus: {change.focus.label}
                      </Button>
                    </div>
                  )}
                </div>
              </article>
            );
          })}
        </div>
      </details>

      {selected && selectedSrc && (
        <div className="fixed inset-0 z-50 flex flex-col bg-black/95" onClick={() => setSelected(null)}>
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/10 px-3 py-2 text-white sm:px-5">
            <div className="min-w-0">
              <p className="truncate text-sm font-semibold">{selected.title} · {formatTime(selected.frameTimeS)}</p>
              <p className="truncate text-xs text-white/60">{focusMode ? `Focused on ${selected.focus.label}` : "Full saved frame"}</p>
            </div>
            <div className="flex items-center gap-1.5" onClick={(event) => event.stopPropagation()}>
              <Button type="button" variant="outline" size="sm" className="h-8 border-white/20 bg-black/30 text-white" onClick={() => { setFocusMode(false); setZoom(1); }}>Full</Button>
              <Button type="button" variant="outline" size="sm" className="h-8 border-white/20 bg-black/30 text-white" onClick={() => { setFocusMode(true); setZoom(1); }}>Focus</Button>
              <Button type="button" variant="outline" size="icon" className="h-8 w-8 border-white/20 bg-black/30 text-white" onClick={() => setZoom((value) => Math.max(1, value - 0.35))}><ZoomOut className="h-4 w-4" /></Button>
              <Button type="button" variant="outline" size="icon" className="h-8 w-8 border-white/20 bg-black/30 text-white" onClick={() => setZoom((value) => Math.min(4, value + 0.35))}><ZoomIn className="h-4 w-4" /></Button>
              <Button type="button" variant="outline" size="icon" className="h-8 w-8 border-white/20 bg-black/30 text-white" onClick={() => setSelected(null)}><X className="h-4 w-4" /></Button>
            </div>
          </div>
          <div className="min-h-0 flex-1 overflow-hidden p-3 sm:p-5" onClick={(event) => event.stopPropagation()}>
            <div className="flex h-full w-full items-center justify-center overflow-hidden rounded-xl bg-black">
              <img
                src={selectedSrc}
                alt={selected.title}
                className="max-h-full max-w-full select-none object-contain transition-transform duration-200"
                style={{ transform: `scale(${effectiveScale})`, transformOrigin: focusMode ? selected.focus.origin : "50% 50%" }}
              />
            </div>
          </div>
          <div className="border-t border-white/10 bg-black/80 px-3 py-3 text-white sm:px-5" onClick={(event) => event.stopPropagation()}>
            <p className="mb-2 text-xs leading-relaxed text-white/75">{selected.overview}</p>
            <MomentTelemetry telemetry={selected.telemetry} />
          </div>
        </div>
      )}
    </>
  );
}
