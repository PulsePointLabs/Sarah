import { useMemo, useState, useCallback } from "react";
import {
  ComposedChart, Line, XAxis, YAxis, Tooltip, CartesianGrid,
  ReferenceLine, ReferenceArea, ResponsiveContainer,
} from "recharts";
import { ZoomOut, ChevronDown, ChevronUp, ChevronLeft, ChevronRight } from "lucide-react";
import { EVENT_CATEGORIES, normalizeCategoryArray } from "./session-form/EventTimelineSection";
import { useChartZoom } from "@/hooks/useChartZoom";

// ── helpers ────────────────────────────────────────────────────────────────────

function getCategoryMeta(v) {
  return EVENT_CATEGORIES.find((c) => c.value === v) || EVENT_CATEGORIES[EVENT_CATEGORIES.length - 1];
}

function fmtMmSs(totalSeconds) {
  const v = Math.round(Number(totalSeconds));
  const m = Math.floor(v / 60);
  const s = v % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function getCategories(ev) {
  const arr = normalizeCategoryArray(ev.category);
  return arr.length ? arr : ["other"];
}

// Green (1) → Yellow (5) → Red (10) gradient for intensity
function intensityColor(intensity) {
  const t = Math.max(0, Math.min(1, (intensity - 1) / 9));
  if (t <= 0.5) {
    // green → yellow
    const r = Math.round(255 * (t * 2));
    return `rgb(${r}, 200, 60)`;
  } else {
    // yellow → red
    const g = Math.round(200 * (1 - (t - 0.5) * 2));
    return `rgb(255, ${g}, 40)`;
  }
}

// Build smoothed HR chart data (downsample to ~300 pts for perf)
function buildChartData(timelineRows) {
  if (!timelineRows.length) return [];
  const step = Math.max(1, Math.floor(timelineRows.length / 300));
  return timelineRows
    .filter((_, i) => i % step === 0)
    .map((r) => ({
      t: Number(r.time_offset_s),
      hr: Math.round(Number(r.hr_smoothed || r.hr)),
    }));
}

// Derive estimated intensity (1–10) from HR, shaped by session phase markers
function buildIntensityCurve(chartData, session) {
  if (!chartData.length) return [];
  const hrs = chartData.map((d) => d.hr);
  const minHR = Math.min(...hrs);
  const maxHR = Math.max(...hrs);
  const hrRange = maxHR - minHR || 1;
  const climaxT = session.climax_offset_s ?? null;
  const recoveryT = session.recovery_offset_s ?? null;

  return chartData.map(({ t, hr }) => {
    const hrNorm = (hr - minHR) / hrRange;
    let phase = 1;
    if (climaxT != null) {
      if (t <= climaxT) {
        phase = 0.55 + 0.45 * (t / climaxT);
      } else {
        const recT = recoveryT ?? climaxT + 120;
        const decay = Math.max(0, 1 - (t - climaxT) / Math.max(1, recT - climaxT));
        phase = 0.4 + 0.6 * decay;
      }
    }
    const intensity = Math.min(10, Math.max(1, Math.round(1 + hrNorm * phase * 9)));
    return { t, intensity };
  });
}

// ── Custom Tooltip — HR + intensity only ──────────────────────────────────────

function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  const hrEntry = payload.find((p) => p.dataKey === "hr");
  const intEntry = payload.find((p) => p.dataKey === "intensity");
  const intVal = intEntry?.value;

  return (
    <div className="bg-popover border border-border rounded-lg shadow-lg px-2.5 py-2 text-xs space-y-1">
      <p className="font-mono font-bold text-primary text-[11px]">{fmtMmSs(Number(label))}</p>
      <div className="flex items-center gap-3">
        {hrEntry && (
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full" style={{ background: "hsl(var(--primary))" }} />
            <span className="font-mono font-bold text-foreground">{hrEntry.value} bpm</span>
          </span>
        )}
        {intVal != null && (
          <span className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full" style={{ background: intensityColor(intVal) }} />
            <span className="font-medium" style={{ color: intensityColor(intVal) }}>{intVal}/10</span>
          </span>
        )}
      </div>
    </div>
  );
}

// ── Phase marker config ────────────────────────────────────────────────────────

const PHASE_MARKERS = [
  { key: "pre_climax_offset_s", label: "Pre-Climax", color: "#a855f7" },
  { key: "climax_offset_s",     label: "Climax",     color: "#ef4444" },
  { key: "recovery_offset_s",   label: "Recovery",   color: "#3b82f6" },
];

// ── Main component ─────────────────────────────────────────────────────────────

export default function UnifiedSessionTimeline({ timelineRows, session }) {
  const [collapsed, setCollapsed] = useState(true);
  const [showIntensity, setShowIntensity] = useState(true);
  const [showEvents, setShowEvents] = useState(true);
  const [eventsListCollapsed, setEventsListCollapsed] = useState(false);

  // Active event navigator state
  const [activeEventIdx, setActiveEventIdx] = useState(null); // index into sessionEvents

  const sessionEvents = session?.event_timeline || [];

  const chartData = useMemo(() => buildChartData(timelineRows), [timelineRows]);
  const intensityCurve = useMemo(() => buildIntensityCurve(chartData, session), [chartData, session]);

  // Merge HR + intensity into single array
  const mergedData = useMemo(() => {
    const intMap = new Map(intensityCurve.map((p) => [p.t, p.intensity]));
    return chartData.map((p) => ({ ...p, intensity: intMap.get(p.t) ?? null }));
  }, [chartData, intensityCurve]);

  // Per-event intensity: find the intensity value at each event's time
  const eventIntensities = useMemo(() => {
    if (!intensityCurve.length) return sessionEvents.map(() => null);
    return sessionEvents.map((ev) => {
      let best = intensityCurve[0];
      let bestDist = Math.abs(intensityCurve[0].t - ev.time_s);
      for (const pt of intensityCurve) {
        const d = Math.abs(pt.t - ev.time_s);
        if (d < bestDist) { bestDist = d; best = pt; }
      }
      return best.intensity;
    });
  }, [sessionEvents, intensityCurve]);

  const dataMin = mergedData.length ? mergedData[0].t : 0;
  const dataMax = mergedData.length ? mergedData[mergedData.length - 1].t : 1;

  const { zoomDomain, resetZoom, isSelecting, selectRange, chartProps, wrapperProps } = useChartZoom(dataMin, dataMax);

  const displayData = useMemo(() => {
    if (!zoomDomain) return mergedData;
    return mergedData.filter((d) => d.t >= zoomDomain.x1 && d.t <= zoomDomain.x2);
  }, [mergedData, zoomDomain]);

  const xDomain = zoomDomain ? [zoomDomain.x1, zoomDomain.x2] : ["dataMin", "dataMax"];
  const isZoomed = zoomDomain != null;

  // Handle chart click — jump to nearest event
  const handleChartClick = useCallback((chartState) => {
    if (!chartState?.activePayload?.length) return;
    const t = Number(chartState.activeLabel);
    if (!sessionEvents.length) return;
    // Find the nearest event to the clicked time
    let nearestIdx = 0;
    let nearestDist = Math.abs(sessionEvents[0].time_s - t);
    sessionEvents.forEach((ev, i) => {
      const d = Math.abs(ev.time_s - t);
      if (d < nearestDist) { nearestDist = d; nearestIdx = i; }
    });
    setActiveEventIdx((prev) => prev === nearestIdx ? null : nearestIdx);
  }, [sessionEvents]);

  const navigateTo = useCallback((i) => {
    const bounded = ((i % sessionEvents.length) + sessionEvents.length) % sessionEvents.length;
    setActiveEventIdx(bounded);
  }, [sessionEvents]);

  const handleEventClick = useCallback((i) => {
    setActiveEventIdx((prev) => prev === i ? null : i);
  }, []);

  if (!timelineRows.length) return null;

  const hrs = chartData.map((d) => d.hr);
  const hrMin = Math.max(0, Math.min(...hrs) - 5);
  const hrMax = Math.max(...hrs) + 5;

  return (
    <div className="bg-card rounded-xl border border-border p-4 space-y-3">
      {/* Header */}
      <button className="w-full flex items-center justify-between" onClick={() => setCollapsed((v) => !v)}>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-primary">
          Unified Session Timeline
        </h3>
        {collapsed ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronUp className="w-4 h-4 text-muted-foreground" />}
      </button>

      {!collapsed && (
        <>
          {/* Toolbar */}
          <div className="flex items-center gap-2 flex-wrap">
            {isZoomed ? (
              <button onClick={resetZoom} className="flex items-center gap-1 text-[10px] text-primary border border-primary/40 rounded px-2 py-0.5">
                <ZoomOut className="w-3 h-3" /> Reset Zoom
              </button>
            ) : (
              <span className="text-[10px] text-muted-foreground">Drag to zoom · Click for event details</span>
            )}
            <div className="ml-auto flex items-center gap-2">
              <button
                onClick={() => setShowIntensity((v) => !v)}
                className="text-[10px] px-2 py-0.5 rounded-full border font-medium transition-all"
                style={showIntensity
                  ? { background: "rgba(16,185,129,0.15)", color: "#10b981", borderColor: "rgba(16,185,129,0.4)" }
                  : { background: "transparent", color: "hsl(var(--muted-foreground))", borderColor: "hsl(var(--border))" }}
              >
                Intensity
              </button>
              {sessionEvents.length > 0 && (
                <button
                  onClick={() => setShowEvents((v) => !v)}
                  className="text-[10px] px-2 py-0.5 rounded-full border font-medium transition-all"
                  style={showEvents
                    ? { background: "hsl(var(--accent) / 0.15)", color: "hsl(var(--accent))", borderColor: "hsl(var(--accent) / 0.4)" }
                    : { background: "transparent", color: "hsl(var(--muted-foreground))", borderColor: "hsl(var(--border))" }}
                >
                  Events
                </button>
              )}
            </div>
          </div>

          {/* Chart */}
          <div className="h-64 cursor-crosshair" {...wrapperProps}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                data={displayData}
                margin={{ top: 8, right: 8, left: -16, bottom: 0 }}
                onClick={handleChartClick}
                {...chartProps}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.4} />
                <XAxis
                  dataKey="t"
                  type="number"
                  domain={xDomain}
                  tickFormatter={fmtMmSs}
                  tickCount={8}
                  tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
                  allowDataOverflow
                />
                <YAxis
                  yAxisId="hr"
                  orientation="left"
                  domain={[hrMin, hrMax]}
                  tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
                  label={{ value: "HR", angle: -90, position: "insideLeft", offset: 14, fontSize: 9, fill: "hsl(var(--primary))" }}
                />
                {showIntensity && (
                  <YAxis
                    yAxisId="intensity"
                    orientation="right"
                    domain={[0, 10]}
                    ticks={[1, 3, 5, 7, 10]}
                    tick={{ fontSize: 9, fill: "rgba(16,185,129,0.7)" }}
                    width={28}
                  />
                )}
                <Tooltip
                  content={<CustomTooltip />}
                  cursor={{ stroke: "hsl(var(--muted-foreground))", strokeWidth: 1, strokeDasharray: "3 3" }}
                />

                {/* Phase reference lines */}
                {PHASE_MARKERS.map(({ key, label, color }) =>
                  session?.[key] != null ? (
                    <ReferenceLine
                      key={key}
                      yAxisId="hr"
                      x={session[key]}
                      stroke={color}
                      strokeWidth={1.5}
                      strokeDasharray="5 3"
                      label={{ value: label, fontSize: 7, fill: color, position: "insideTopLeft", offset: 4 }}
                    />
                  ) : null
                )}

                {/* Active event marker */}
                {activeEventIdx != null && sessionEvents[activeEventIdx] && (
                  <ReferenceLine
                    yAxisId="hr"
                    x={sessionEvents[activeEventIdx].time_s}
                    stroke={intensityColor(eventIntensities[activeEventIdx] ?? 5)}
                    strokeWidth={2}
                    strokeDasharray="3 2"
                    strokeOpacity={0.9}
                  />
                )}

                {/* Event marker lines */}
                {showEvents && sessionEvents.map((ev, i) => {
                  const intensity = eventIntensities[i];
                  const color = intensity != null ? intensityColor(intensity) : "#888";
                  const isActive = activeEventIdx === i;
                  const isDimmed = activeEventIdx != null && !isActive;
                  return (
                    <ReferenceLine
                      key={i}
                      yAxisId="hr"
                      x={ev.time_s}
                      stroke={color}
                      strokeWidth={isActive ? 2.5 : 1.2}
                      strokeDasharray="2 3"
                      strokeOpacity={isDimmed ? 0.2 : 0.85}
                      label={{ value: `E${i + 1}`, fontSize: 7, fill: color, position: "insideTopRight", offset: 2 }}
                    />
                  );
                })}

                {/* Drag-to-zoom area */}
                {isSelecting && selectRange && (
                  <ReferenceArea
                    yAxisId="hr"
                    x1={selectRange.x1}
                    x2={selectRange.x2}
                    fill="hsl(var(--primary))"
                    fillOpacity={0.12}
                    stroke="hsl(var(--primary))"
                    strokeOpacity={0.4}
                    strokeWidth={1}
                  />
                )}

                {/* HR line */}
                <Line
                  yAxisId="hr"
                  type="monotone"
                  dataKey="hr"
                  stroke="hsl(var(--primary))"
                  strokeWidth={2}
                  dot={false}
                  isAnimationActive={false}
                />

                {/* Intensity overlay */}
                {showIntensity && (
                  <Line
                    yAxisId="intensity"
                    type="monotone"
                    dataKey="intensity"
                    stroke="#10b981"
                    strokeWidth={1.5}
                    strokeOpacity={0.6}
                    strokeDasharray="4 2"
                    dot={false}
                    isAnimationActive={false}
                  />
                )}
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {/* Legend */}
          <div className="flex items-center gap-4 text-[10px] text-muted-foreground flex-wrap">
            <span className="flex items-center gap-1.5">
              <span className="w-4 h-0.5 rounded" style={{ background: "hsl(var(--primary))" }} />
              Heart Rate (bpm)
            </span>
            {showIntensity && (
              <span className="flex items-center gap-1.5">
                <span className="w-4 rounded border-t-2 border-dashed border-emerald-500/70" />
                Est. Intensity (1–10)
              </span>
            )}
            {showEvents && sessionEvents.length > 0 && (
              <span className="flex items-center gap-1.5">
                {/* mini green→red swatch */}
                <span className="w-8 h-1.5 rounded-full" style={{ background: "linear-gradient(to right, rgb(0,200,60), rgb(255,200,40), rgb(255,40,40))" }} />
                Events (intensity)
              </span>
            )}
          </div>

          {/* Navigator card — shown when an event is active */}
          {activeEventIdx != null && sessionEvents[activeEventIdx] && (() => {
            const ev = sessionEvents[activeEventIdx];
            const intensity = eventIntensities[activeEventIdx];
            const color = intensity != null ? intensityColor(intensity) : "#888";
            const cats = getCategories(ev);
            return (
              <div className="rounded-lg px-3 py-3 space-y-1.5" style={{ background: color + "18", borderLeft: `3px solid ${color}` }}>
                <div className="flex items-center gap-2">
                  <button onClick={() => navigateTo(activeEventIdx - 1)} className="p-0.5 rounded hover:bg-black/10 shrink-0">
                    <ChevronLeft className="w-4 h-4" style={{ color }} />
                  </button>
                  <div className="flex-1 flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-[11px] font-bold" style={{ color }}>
                      E{activeEventIdx + 1} / {sessionEvents.length}
                    </span>
                    <span className="font-mono text-[11px] text-muted-foreground">{fmtMmSs(ev.time_s)}</span>
                    {cats.map((c) => {
                      const m = getCategoryMeta(c);
                      return <span key={c} className="text-[9px] px-1.5 rounded-full font-semibold" style={{ background: m.color + "22", color: m.color }}>{m.label}</span>;
                    })}
                    {intensity != null && (
                      <span className="font-mono text-[11px] font-bold" style={{ color }}>{intensity}/10</span>
                    )}
                  </div>
                  <button onClick={() => navigateTo(activeEventIdx + 1)} className="p-0.5 rounded hover:bg-black/10 shrink-0">
                    <ChevronRight className="w-4 h-4" style={{ color }} />
                  </button>
                </div>
                <p className="text-sm text-foreground/90 leading-relaxed whitespace-pre-wrap">{ev.note}</p>
              </div>
            );
          })()}

          {/* Collapsible event list */}
          {showEvents && sessionEvents.length > 0 && (
            <div className="border-t border-border pt-2">
              <button
                className="w-full flex items-center justify-between mb-1.5"
                onClick={() => setEventsListCollapsed((v) => !v)}
              >
                <p className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
                  All Events ({sessionEvents.length}) — tap to highlight
                </p>
                {eventsListCollapsed
                  ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
                  : <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" />}
              </button>

              {!eventsListCollapsed && (
                <div className="space-y-1">
                  {sessionEvents.map((ev, i) => {
                    const cats = getCategories(ev);
                    const intensity = eventIntensities[i];
                    const color = intensity != null ? intensityColor(intensity) : "#888";
                    const isActive = activeEventIdx === i;
                    const isDimmed = activeEventIdx != null && !isActive;
                    return (
                      <button
                        key={i}
                        onClick={() => handleEventClick(i)}
                        className="w-full flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-left transition-all"
                        style={{
                          background: isActive ? color + "28" : color + "0f",
                          borderLeft: `3px solid ${isActive ? color : color + "55"}`,
                          outline: isActive ? `1px solid ${color}44` : "none",
                          opacity: isDimmed ? 0.35 : 1,
                        }}
                      >
                        <span className="font-mono text-[10px] font-bold shrink-0 mt-0.5" style={{ color }}>
                          E{i + 1} {fmtMmSs(ev.time_s)}
                        </span>
                        <div className="flex-1 flex flex-col gap-0.5 min-w-0">
                          <div className="flex flex-wrap gap-1">
                            {cats.map((c) => {
                              const m = getCategoryMeta(c);
                              return (
                                <span key={c} className="text-[9px] px-1.5 py-0 rounded-full font-semibold"
                                  style={{ background: m.color + "22", color: m.color }}>
                                  {m.label}
                                </span>
                              );
                            })}
                          </div>
                          <span className="text-xs text-foreground/90 leading-snug">{ev.note}</span>
                        </div>
                        {intensity != null && (
                          <span className="font-mono text-[10px] font-bold shrink-0 mt-0.5 px-1.5 py-0.5 rounded-md"
                            style={{ background: color + "22", color }}>
                            {intensity}/10
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}