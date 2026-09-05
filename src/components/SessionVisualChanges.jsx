import { useEffect, useMemo, useState } from "react";
import { ChevronDown, ChevronLeft, ChevronRight, Eye, Focus, Maximize2, X, ZoomIn, ZoomOut } from "lucide-react";
import { CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { Button } from "@/components/ui/button";
import { serverUrl } from "@/lib/mobileApiBase";
import { buildHighConfidenceVisualChanges } from "@/utils/sessionVisualChanges";

function formatTime(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function numberOrNull(value) {
  const number = Number(value);
  return value !== null && value !== "" && Number.isFinite(number) ? number : null;
}

function MetricPill({ label, value }) {
  if (value == null || value === "") return null;
  return (
    <span className="rounded-full border border-border bg-background/75 px-2.5 py-1 text-[10px] text-muted-foreground">
      <strong className="text-primary">{label}</strong> {value}
    </span>
  );
}

function MomentTelemetry({ telemetry = {}, large = false }) {
  const delta = telemetry.hr != null && telemetry.baseline != null ? telemetry.hr - telemetry.baseline : null;
  return (
    <div className={`flex flex-wrap gap-1.5 ${large ? "[&_span]:px-3 [&_span]:py-1.5 [&_span]:text-xs" : ""}`}>
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

function telemetryWindow(rows = [], centerTimeS = 0) {
  const start = centerTimeS - 45;
  const end = centerTimeS + 45;
  const points = rows
    .map((row) => {
      const timeS = numberOrNull(row.time_offset_s ?? row.time_s ?? row.elapsed_seconds);
      if (timeS == null || timeS < start || timeS > end) return null;
      const positive = (value) => {
        const number = numberOrNull(value);
        return number != null && number > 0 ? number : null;
      };
      return {
        timeS,
        hr: positive(row.hr ?? row.heart_rate ?? row.bpm),
        baseline: positive(row.baseline_hr ?? row.baseline_bpm),
        rmssd: positive(row.hrv_rmssd_ms ?? row.rmssd_ms ?? row.rmssd),
        sdnn: positive(row.hrv_sdnn_ms ?? row.sdnn_ms ?? row.sdnn),
      };
    })
    .filter(Boolean)
    .sort((a, b) => a.timeS - b.timeS);
  if (points.length <= 180) return points;
  const stride = Math.ceil(points.length / 180);
  return points.filter((_point, index) => index % stride === 0 || index === points.length - 1);
}

const TOOLTIP_STYLE = {
  background: "rgba(8, 12, 16, 0.96)",
  border: "1px solid rgba(255,255,255,0.16)",
  borderRadius: 8,
  color: "white",
  fontSize: 12,
};

function MomentTelemetryGraphs({ timelineRows, momentTimeS }) {
  const data = useMemo(() => telemetryWindow(timelineRows, momentTimeS), [timelineRows, momentTimeS]);
  const hasHr = data.some((point) => point.hr != null || point.baseline != null);
  const hasHrv = data.some((point) => point.rmssd != null || point.sdnn != null);
  if (!hasHr && !hasHrv) {
    return <p className="rounded-xl border border-white/10 bg-white/5 p-4 text-sm text-white/55">No continuous telemetry was saved around this moment.</p>;
  }

  const chart = (kind) => (
    <div className="h-44 min-w-0 rounded-xl border border-white/10 bg-white/[0.035] p-2">
      <p className="px-1 pb-1 text-xs font-semibold uppercase tracking-wider text-white/65">
        {kind === "hr" ? "Heart rate around this moment" : "HRV around this moment"}
      </p>
      <ResponsiveContainer width="100%" height="88%" minWidth={1} initialDimension={{ width: 360, height: 150 }} debounce={40}>
        <LineChart data={data} margin={{ top: 6, right: 8, bottom: 0, left: -16 }}>
          <CartesianGrid stroke="rgba(255,255,255,0.08)" strokeDasharray="3 3" />
          <XAxis type="number" dataKey="timeS" domain={["dataMin", "dataMax"]} tickFormatter={formatTime} tick={{ fill: "rgba(255,255,255,0.5)", fontSize: 10 }} axisLine={{ stroke: "rgba(255,255,255,0.16)" }} tickLine={false} />
          <YAxis domain={["auto", "auto"]} tick={{ fill: "rgba(255,255,255,0.5)", fontSize: 10 }} axisLine={false} tickLine={false} />
          <Tooltip
            labelFormatter={(value) => formatTime(value)}
            formatter={(value, name) => [`${Number(value).toFixed(name === "HR" || name === "Baseline" ? 0 : 1)} ${kind === "hr" ? "bpm" : "ms"}`, name]}
            contentStyle={TOOLTIP_STYLE}
          />
          <ReferenceLine x={momentTimeS} stroke="#2dd4bf" strokeWidth={2} strokeDasharray="4 3" label={{ value: "Moment", fill: "#5eead4", fontSize: 10, position: "insideTopRight" }} />
          {kind === "hr" ? (
            <>
              <Line type="monotone" dataKey="hr" name="HR" stroke="#fb7185" strokeWidth={2.5} dot={false} connectNulls />
              <Line type="monotone" dataKey="baseline" name="Baseline" stroke="#94a3b8" strokeWidth={1.5} strokeDasharray="5 4" dot={false} connectNulls />
            </>
          ) : (
            <>
              <Line type="monotone" dataKey="rmssd" name="RMSSD" stroke="#2dd4bf" strokeWidth={2.25} dot={false} connectNulls />
              <Line type="monotone" dataKey="sdnn" name="SDNN" stroke="#a78bfa" strokeWidth={2.25} dot={false} connectNulls />
            </>
          )}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );

  return <div className="grid min-w-0 gap-3">{hasHr && chart("hr")}{hasHrv && chart("hrv")}</div>;
}

function visualTrackFor(change = {}) {
  const text = `${change.title || ""} ${change.overview || ""}`.toLowerCase();
  if (/\bscrot|testic/.test(text)) return "scrotal";
  if (/\b(?:penis|shaft|glans|foreskin|erection|genital)\b/.test(text)) return "genital";
  if (/\b(?:foot|feet|toe|heel|sole|ankle|knee|leg|thigh|plantar|brace|oscillat)\b/.test(text)) return "lowerBody";
  if (/\b(?:breath|respirat|tension|arch|pelvis|trunk|abdomen|chest)\b/.test(text)) return "bodyState";
  if (/\b(?:sleeve|hand|grip|stroke|cadence|contact|device)\b/.test(text)) return "technique";
  return "bodyState";
}

function visualDirectionFor(change = {}) {
  const text = `${change.title || ""} ${change.overview || ""}`.toLowerCase();
  if (/\b(?:decreas|reduc|release|relax|drop|descen|loosen|fade|soften|stop|pause)\w*/.test(text)) return -1;
  if (/\b(?:increas|new|lift|tight|taut|engorg|firm|curl|plant|brace|accelerat|begin|start|resum|motion)\w*/.test(text)) return 1;
  return 0;
}

function VisualChangeTracks({ changes = [], onOpen }) {
  const data = useMemo(() => {
    const rows = new Map();
    changes.forEach((change) => {
      const timeS = Math.round(Number(change.timeS) || 0);
      const current = rows.get(timeS) || { timeS, changes: [] };
      const key = visualTrackFor(change);
      const direction = visualDirectionFor(change);
      if (direction !== 0) current[key] = direction;
      current.changes.push(change);
      rows.set(timeS, current);
    });
    return [...rows.values()].sort((a, b) => a.timeS - b.timeS);
  }, [changes]);
  if (!data.length) return null;
  const tracks = [
    ["genital", "Genital", "#fb7185"],
    ["scrotal", "Scrotal", "#f59e0b"],
    ["technique", "Technique", "#60a5fa"],
    ["lowerBody", "Feet / legs", "#34d399"],
    ["bodyState", "Body / breath", "#a78bfa"],
  ];
  return (
    <div className="rounded-xl border border-primary/20 bg-primary/[0.035] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-primary">Directional visual evidence</p>
          <p className="mt-0.5 text-xs text-muted-foreground">+1 means an observed increase/onset; −1 means observed decrease/release. This is a change map, not a fake numeric body score.</p>
        </div>
        <span className="text-[10px] text-muted-foreground">Click a plotted point to open its evidence.</span>
      </div>
      <div className="mt-3 h-56 min-w-0">
        <ResponsiveContainer width="100%" height="100%" minWidth={1} initialDimension={{ width: 600, height: 224 }} debounce={40}>
          <LineChart data={data} margin={{ top: 12, right: 16, bottom: 4, left: -20 }} onClick={(state) => {
            const change = state?.activePayload?.[0]?.payload?.changes?.[0];
            if (change) onOpen(change);
          }}>
            <CartesianGrid stroke="hsl(var(--border))" strokeDasharray="3 3" opacity={0.55} />
            <XAxis type="number" dataKey="timeS" domain={["dataMin", "dataMax"]} tickFormatter={formatTime} tick={{ fontSize: 10 }} tickLine={false} />
            <YAxis domain={[-1.2, 1.2]} ticks={[-1, 0, 1]} tickFormatter={(value) => value === 1 ? "↑" : value === -1 ? "↓" : "—"} tick={{ fontSize: 11 }} tickLine={false} axisLine={false} />
            <Tooltip labelFormatter={formatTime} formatter={(value, name) => [Number(value) > 0 ? "Increase / onset" : "Decrease / release", name]} contentStyle={{ background: "hsl(var(--card))", border: "1px solid hsl(var(--border))", borderRadius: 8 }} />
            {tracks.map(([key, label, color]) => <Line key={key} type="stepAfter" dataKey={key} name={label} stroke={color} strokeWidth={2} dot={{ r: 3 }} activeDot={{ r: 5 }} connectNulls={false} />)}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function keyEvidenceScore(change = {}) {
  const text = `${change.title || ""} ${change.overview || ""}`.toLowerCase();
  let score = change.category === "visual_audit" ? 3 : 1;
  if (change.telemetry?.hr != null && change.telemetry?.baseline != null && Math.abs(change.telemetry.hr - change.telemetry.baseline) >= 10) score += 1;
  if (/near.climax|climax|orgasm|ejacul|approach/.test(text)) score += 5;
  if (/erection|engorg|scrot|stroke|cadence|sleeve|plantar|toe curl|heel|knee|brac|tension|breath|respirat/.test(text)) score += 2;
  if (/increase|decrease|new|release|lift|drop|resum|stop|pause|motion/.test(text)) score += 1;
  return score;
}

function KeyEvidenceMoments({ changes = [], onOpen }) {
  const moments = useMemo(() => {
    const ranked = [...changes]
      .sort((left, right) => keyEvidenceScore(right) - keyEvidenceScore(left) || left.timeS - right.timeS);
    const selected = [];
    for (const change of ranked) {
      if (selected.some((item) => Math.abs(item.timeS - change.timeS) < 18)) continue;
      selected.push(change);
      if (selected.length >= 12) break;
    }
    return selected.sort((left, right) => left.timeS - right.timeS);
  }, [changes]);
  if (!moments.length) return null;
  return (
    <div className="rounded-xl border border-primary/20 bg-primary/[0.035] p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <p className="text-xs font-semibold uppercase tracking-wider text-primary">Key evidence moments</p>
          <p className="mt-0.5 text-xs text-muted-foreground">A chronological shortlist of the most specific saved visual changes. It is not a score and does not replace the full record below.</p>
        </div>
        <span className="text-[10px] text-muted-foreground">Open a moment for source image + telemetry</span>
      </div>
      <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
        {moments.map((moment) => (
          <button key={moment.id} type="button" onClick={() => onOpen(moment)} className="min-w-[180px] max-w-[240px] rounded-lg border border-border bg-background/75 p-2.5 text-left transition-colors hover:border-primary/45 hover:bg-primary/[0.05]">
            <p className="font-mono text-[11px] font-bold text-primary">{formatTime(moment.timeS)}</p>
            <p className="mt-1 line-clamp-2 text-xs font-semibold leading-snug text-foreground">{moment.title}</p>
            <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">{moment.overview}</p>
          </button>
        ))}
      </div>
    </div>
  );
}

export default function SessionVisualChanges({ session, timelineRows = [] }) {
  const changes = useMemo(() => buildHighConfidenceVisualChanges(session, timelineRows), [session, timelineRows]);
  const progression = useMemo(() => {
    const preClimax = numberOrNull(session?.pre_climax_offset_s);
    const climax = numberOrNull(session?.climax_offset_s);
    const recovery = numberOrNull(session?.recovery_offset_s);
    const phaseFor = (timeS) => {
      if (recovery != null && timeS >= recovery) return "Recovery";
      if (climax != null && timeS >= climax) return "Climax";
      if (preClimax != null && timeS >= preClimax) return "Approach";
      return "Build";
    };
    const buckets = new Map(["Build", "Approach", "Climax", "Recovery"].map((label) => [label, []]));
    changes.forEach((change) => buckets.get(phaseFor(change.timeS))?.push(change));
    return [...buckets.entries()]
      .map(([label, moments]) => ({ label, moments, representative: moments.at(-1) || null }))
      .filter((entry) => entry.moments.length > 0);
  }, [changes, session?.climax_offset_s, session?.pre_climax_offset_s, session?.recovery_offset_s]);
  const [expanded, setExpanded] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(-1);
  const [focusMode, setFocusMode] = useState(false);
  const [zoom, setZoom] = useState(1);
  const [highResolutionFailed, setHighResolutionFailed] = useState(false);
  const selected = selectedIndex >= 0 ? changes[selectedIndex] : null;

  const navigateMoment = (direction) => {
    setSelectedIndex((current) => {
      if (!changes.length) return -1;
      return (current + direction + changes.length) % changes.length;
    });
    setZoom(1);
    setHighResolutionFailed(false);
  };

  useEffect(() => {
    if (!selected) return undefined;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKeyDown = (event) => {
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        navigateMoment(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        navigateMoment(1);
      } else if (event.key === "Escape") {
        event.preventDefault();
        setSelectedIndex(-1);
      } else if (event.key === "+" || event.key === "=") {
        event.preventDefault();
        setZoom((value) => Math.min(4, value + 0.35));
      } else if (event.key === "-") {
        event.preventDefault();
        setZoom((value) => Math.max(1, value - 0.35));
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [selected, changes.length]);

  useEffect(() => setHighResolutionFailed(false), [selectedIndex]);

  const selectedFallbackSrc = selected?.imageUrl ? serverUrl(selected.imageUrl) : "";
  const selectedHighResolutionSrc = selected?.highResolutionImageUrl ? serverUrl(selected.highResolutionImageUrl) : "";
  const selectedSrc = selectedHighResolutionSrc && !highResolutionFailed ? selectedHighResolutionSrc : selectedFallbackSrc;
  const effectiveScale = selected ? (focusMode ? selected.focus.scale * zoom : zoom) : zoom;

  const openMoment = (moment, focus = false) => {
    setSelectedIndex(changes.findIndex((candidate) => candidate.id === moment.id));
    setFocusMode(focus);
    setZoom(1);
    setHighResolutionFailed(false);
  };

  return (
    <>
      <section id="session-visual-changes" className="scroll-mt-24 min-w-0 overflow-hidden rounded-2xl border border-primary/20 bg-card">
        <button
          type="button"
          className="flex w-full cursor-pointer items-start justify-between gap-3 p-4 text-left transition-colors hover:bg-primary/[0.045] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-inset"
          aria-expanded={expanded}
          onClick={() => setExpanded((value) => !value)}
        >
          <div className="min-w-0">
            <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-primary"><Eye className="h-4 w-4" /> High-Confidence Visual Changes</h3>
            <p className="mt-1 text-sm text-muted-foreground">{changes.length} saved visual change{changes.length === 1 ? "" : "s"}, ordered from start to finish with moment telemetry and image focus.</p>
            <p className="mt-1 text-xs font-medium text-primary/80">Click anywhere in this heading to {expanded ? "collapse" : "open"} findings.</p>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            <span className="rounded-full border border-primary/20 bg-primary/10 px-2.5 py-1 text-xs font-semibold text-primary">{changes.length}</span>
            <ChevronDown className={`h-5 w-5 text-primary transition-transform ${expanded ? "rotate-180" : ""}`} />
          </div>
        </button>

        {expanded && (
          <div className="space-y-3 border-t border-border p-4">
            {!changes.length && (
              <div className="rounded-xl border border-dashed border-border bg-muted/10 p-4 text-sm text-muted-foreground">
                No saved high-confidence visual changes are available for this session yet. This section fills from accepted AI Annotation video-pass findings; ordinary event notes and telemetry alone are not treated as visual proof.
              </div>
            )}
            {progression.length > 0 && (
              <div className="rounded-xl border border-primary/20 bg-primary/[0.035] p-3">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-primary">Visual progression</p>
                    <p className="mt-0.5 text-xs text-muted-foreground">Promoted directional changes only. Click a phase to open its most recent evidence moment.</p>
                  </div>
                  <span className="text-[10px] font-medium text-muted-foreground">Evidence, not inferred scoring</span>
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                  {progression.map((phase) => (
                    <button key={phase.label} type="button" onClick={() => phase.representative && openMoment(phase.representative, false)} className="rounded-lg border border-border bg-background/70 p-2.5 text-left transition-colors hover:border-primary/40 hover:bg-primary/[0.05]">
                      <div className="flex items-center justify-between gap-2"><span className="text-xs font-semibold text-foreground">{phase.label}</span><span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-bold text-primary">{phase.moments.length}</span></div>
                      <p className="mt-1 line-clamp-2 text-[11px] leading-relaxed text-muted-foreground">{phase.representative?.title}</p>
                      <p className="mt-1 font-mono text-[10px] text-primary">{phase.representative && formatTime(phase.representative.timeS)}</p>
                    </button>
                  ))}
                </div>
              </div>
            )}
            <KeyEvidenceMoments changes={changes} onOpen={(moment) => openMoment(moment, false)} />
            <VisualChangeTracks changes={changes} onOpen={(moment) => openMoment(moment, false)} />
            {changes.map((change) => {
              const src = change.imageUrl ? serverUrl(change.imageUrl) : "";
              return (
                <article key={change.id} className="grid min-w-0 gap-3 rounded-xl border border-border bg-muted/10 p-3 sm:grid-cols-[minmax(0,240px)_minmax(0,1fr)]">
                  {src ? (
                    <button type="button" onClick={() => openMoment(change, false)} className="group relative min-w-0 overflow-hidden rounded-lg border border-border bg-black text-left" title="Open native-resolution moment image">
                      <img src={src} alt={change.title} className="aspect-video w-full object-cover transition-transform group-hover:scale-[1.03]" loading="lazy" />
                      <span className="absolute bottom-2 right-2 rounded-md bg-black/75 px-2 py-1 text-[10px] font-semibold text-white"><Maximize2 className="mr-1 inline h-3 w-3" /> {formatTime(change.frameTimeS)}</span>
                    </button>
                  ) : (
                    <div className="flex aspect-video items-center justify-center rounded-lg border border-dashed border-border bg-background text-xs text-muted-foreground">No saved still</div>
                  )}
                  <div className="min-w-0 space-y-2">
                    <div className="flex flex-wrap items-start justify-between gap-2">
                      <div className="min-w-0">
                        <p className="font-mono text-xs font-semibold text-primary">{formatTime(change.timeS)}</p>
                        <h4 className="mt-0.5 text-base font-semibold capitalize text-foreground">{change.title}</h4>
                      </div>
                      <span className="rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-400">High confidence</span>
                      {change.category === "visual_audit" && <span className="rounded-full border border-cyan-500/25 bg-cyan-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-cyan-300">Paired audit</span>}
                    </div>
                    <p className="text-base leading-relaxed text-foreground/90">{change.overview}</p>
                    <MomentTelemetry telemetry={change.telemetry} />
                    {src && (
                      <div className="flex flex-wrap gap-2 pt-1">
                        <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={() => openMoment(change, false)}><Maximize2 className="h-3.5 w-3.5" /> Full page</Button>
                        <Button type="button" variant="outline" size="sm" className="h-8 gap-1.5 text-xs" onClick={() => openMoment(change, true)}><Focus className="h-3.5 w-3.5" /> Focus: {change.focus.label}</Button>
                      </div>
                    )}
                  </div>
                </article>
              );
            })}
          </div>
        )}
      </section>

      {selected && selectedSrc && (
        <div className="fixed inset-0 z-[100] bg-black text-white" role="dialog" aria-modal="true" aria-label={`Visual finding ${selectedIndex + 1} of ${changes.length}`}>
          <div className="flex h-full min-h-0 flex-col">
            <header className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-b border-white/10 bg-black/95 px-3 py-2 sm:px-5">
              <div className="min-w-0">
                <p className="truncate text-base font-semibold sm:text-lg">{selected.title} · {formatTime(selected.frameTimeS)}</p>
                <p className="truncate text-xs text-white/60">{selectedIndex + 1} of {changes.length} · {selected.camera || "Saved video evidence"} · {focusMode ? `Focused on ${selected.focus.label}` : "Full frame"}</p>
              </div>
              <div className="flex items-center gap-1.5">
                <Button type="button" variant="outline" size="icon" className="h-9 w-9 border-white/20 bg-black/30 text-white" onClick={() => navigateMoment(-1)} title="Previous finding (Left arrow)"><ChevronLeft className="h-5 w-5" /></Button>
                <Button type="button" variant="outline" size="icon" className="h-9 w-9 border-white/20 bg-black/30 text-white" onClick={() => navigateMoment(1)} title="Next finding (Right arrow)"><ChevronRight className="h-5 w-5" /></Button>
                <Button type="button" variant="outline" size="sm" className="h-9 border-white/20 bg-black/30 text-white" onClick={() => { setFocusMode(false); setZoom(1); }}>Full</Button>
                <Button type="button" variant="outline" size="sm" className="h-9 border-white/20 bg-black/30 text-white" onClick={() => { setFocusMode(true); setZoom(1); }}>Focus</Button>
                <Button type="button" variant="outline" size="icon" className="h-9 w-9 border-white/20 bg-black/30 text-white" onClick={() => setZoom((value) => Math.max(1, value - 0.35))} title="Zoom out (-)"><ZoomOut className="h-4 w-4" /></Button>
                <Button type="button" variant="outline" size="icon" className="h-9 w-9 border-white/20 bg-black/30 text-white" onClick={() => setZoom((value) => Math.min(4, value + 0.35))} title="Zoom in (+)"><ZoomIn className="h-4 w-4" /></Button>
                <Button type="button" variant="outline" size="icon" className="h-9 w-9 border-white/20 bg-black/30 text-white" onClick={() => setSelectedIndex(-1)} title="Close (Escape)"><X className="h-5 w-5" /></Button>
              </div>
            </header>

            <div className="grid min-h-0 flex-1 overflow-y-auto lg:grid-cols-[minmax(0,1fr)_minmax(360px,29vw)] lg:overflow-hidden">
              <div className="flex min-h-[52vh] items-center justify-center overflow-hidden bg-black p-2 sm:p-4 lg:min-h-0">
                <img
                  src={selectedSrc}
                  alt={selected.title}
                  className="max-h-full max-w-full select-none object-contain transition-transform duration-200"
                  style={{ transform: `scale(${effectiveScale})`, transformOrigin: focusMode ? selected.focus.origin : "50% 50%" }}
                  onError={() => { if (selectedHighResolutionSrc && !highResolutionFailed) setHighResolutionFailed(true); }}
                />
              </div>

              <aside className="min-w-0 overflow-y-auto border-l border-white/10 bg-[#090c10] p-4 sm:p-5">
                <div className="mb-4 flex flex-wrap items-center gap-2">
                  <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-emerald-300">High confidence</span>
                  {selectedHighResolutionSrc && !highResolutionFailed && <span className="rounded-full border border-cyan-400/30 bg-cyan-400/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-cyan-300">Native-resolution source</span>}
                  {selected.category === "visual_audit" && <span className="rounded-full border border-cyan-400/30 bg-cyan-400/10 px-2.5 py-1 text-[11px] font-semibold uppercase tracking-wider text-cyan-300">Paired audit evidence</span>}
                </div>
                <h2 className="text-xl font-semibold leading-snug text-white sm:text-2xl">{selected.title}</h2>
                <p className="mt-3 text-base leading-relaxed text-white/85 sm:text-lg">{selected.overview}</p>
                <div className="my-4"><MomentTelemetry telemetry={selected.telemetry} large /></div>
                {selected.comparisonImageUrl && (
                  <div className="mb-4 rounded-xl border border-white/10 bg-white/[0.035] p-2">
                    <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-white/60">Comparison frame · {formatTime(selected.comparisonTimeS ?? Math.max(0, selected.timeS - 1.2))}</p>
                    <img src={serverUrl(selected.comparisonImageUrl)} alt={`Comparison before ${selected.title}`} className="max-h-48 w-full rounded-lg object-contain" />
                  </div>
                )}
                <MomentTelemetryGraphs timelineRows={timelineRows} momentTimeS={selected.timeS} />
                <p className="mt-4 text-xs leading-relaxed text-white/45">←/→ previous or next · +/- zoom · Esc close. The graph marker is the saved visual-event time; the still is the nearest sampled source frame.</p>
              </aside>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
