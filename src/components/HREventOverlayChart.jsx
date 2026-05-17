import { useMemo, useState } from "react";
import {
  ResponsiveContainer, ComposedChart, Line, XAxis, YAxis,
  Tooltip, CartesianGrid, ReferenceLine, ReferenceArea,
} from "recharts";

import { ZoomOut, ChevronLeft, ChevronRight, ChevronDown, ChevronUp, Zap } from "lucide-react";
import { useChartZoom } from "@/hooks/useChartZoom";
import { EVENT_CATEGORIES } from "@/components/session-form/EventTimelineSection";

function getCategoryMeta(value) {
  return EVENT_CATEGORIES.find((c) => c.value === value) || EVENT_CATEGORIES[EVENT_CATEGORIES.length - 1];
}

// Normalize: category may be string or array, strip legacy values
const LEGACY_CATS = ["pause", "resume", "paused", "resumed"];
function getCategories(ev) {
  if (!ev.category) return [];
  const arr = Array.isArray(ev.category) ? ev.category : [ev.category];
  const filtered = arr.filter((v) => typeof v === "string" && v && !LEGACY_CATS.includes(v.toLowerCase()));
  return filtered.length ? filtered : ["other"];
}

function CategoryPill({ value }) {
  const meta = getCategoryMeta(value);
  return (
    <span className="inline-flex items-center rounded-full text-[9px] px-1.5 py-0 font-medium"
      style={{ background: meta.color + "22", color: meta.color, border: `1px solid ${meta.color}44` }}>
      {meta.label}
    </span>
  );
}

function EventCategoryPills({ ev }) {
  const cats = getCategories(ev);
  return <>{cats.map((c) => <CategoryPill key={c} value={c} />)}</>;
}

function fmtMmSs(s) {
  const totalS = Math.round(Number(s));
  const m = Math.floor(totalS / 60);
  const sec = totalS % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

const EVENT_COLORS = [
  "#f59e0b", "#a855f7", "#10b981", "#f43f5e", "#0ea5e9",
  "#fb923c", "#84cc16", "#e879f9", "#34d399", "#f87171",
];

// Find nearest HR value to a given time_s from chartData
function nearestHR(chartData, time_s) {
  if (!chartData.length) return null;
  let best = chartData[0];
  let bestDist = Math.abs(chartData[0].t - time_s);
  for (const pt of chartData) {
    const d = Math.abs(pt.t - time_s);
    if (d < bestDist) { bestDist = d; best = pt; }
  }
  return Math.round(best.hr);
}

// Get all unique categories present across all events
function getAllUsedCategories(events) {
  const seen = new Set();
  for (const ev of events) {
    for (const c of getCategories(ev)) seen.add(c);
  }
  // Return in EVENT_CATEGORIES order
  return EVENT_CATEGORIES.filter((ec) => seen.has(ec.value));
}

const NC_COLOR = "hsl(var(--chart-3))";
const NC_COLOR_HEX = "#f97316"; // chart-3 approximate for ReferenceArea fill

function fmtSec(s) {
  if (!s) return "—";
  const v = Math.round(s);
  return v >= 60 ? `${Math.floor(v / 60)}m ${v % 60}s` : `${v}s`;
}

export default function HREventOverlayChart({ timelineRows, events = [], session, nearClimaxEvents = [] }) {
  const [collapsed, setCollapsed] = useState(true);
  const [isolatedEvent, setIsolatedEvent] = useState(null);
  const [focusedFilteredIdx, setFocusedFilteredIdx] = useState(0);
  const [eventsCollapsed, setEventsCollapsed] = useState(false);
  const [ncIdx, setNcIdx] = useState(0); // near-climax navigator index

  // Active category filters — null means "all"
  const usedCategories = useMemo(() => getAllUsedCategories(events), [events]);
  const [activeFilters, setActiveFilters] = useState(null); // null = all active

  const toggleFilter = (catValue) => {
    setIsolatedEvent(null);
    setFocusedFilteredIdx(0);
    if (activeFilters === null) {
      // Switch from "all" to just this one deselected (all except this)
      const allVals = usedCategories.map((c) => c.value);
      setActiveFilters(allVals.filter((v) => v !== catValue));
    } else {
      const next = activeFilters.includes(catValue)
        ? activeFilters.filter((v) => v !== catValue)
        : [...activeFilters, catValue];
      // If all are selected, revert to null (all)
      if (next.length === usedCategories.length) setActiveFilters(null);
      else setActiveFilters(next.length ? next : null);
    }
  };

  const selectAllFilters = () => {
    setActiveFilters(null);
    setIsolatedEvent(null);
    setFocusedFilteredIdx(0);
  };

  const isCatActive = (catValue) => activeFilters === null || activeFilters.includes(catValue);

  // Filtered events (indices relative to original events array preserved)
  const filteredEventIndices = useMemo(() => {
    return events.reduce((acc, ev, i) => {
      const cats = getCategories(ev);
      const passes = activeFilters === null || cats.some((c) => activeFilters.includes(c));
      if (passes) acc.push(i);
      return acc;
    }, []);
  }, [events, activeFilters]);

  const chartData = useMemo(() => {
    return timelineRows.map((r) => ({
      t: Number(r.time_offset_s),
      hr: Math.round(Number(r.hr_smoothed || r.hr)),
    }));
  }, [timelineRows]);

  const dataMin = chartData.length ? chartData[0].t : 0;
  const dataMax = chartData.length ? chartData[chartData.length - 1].t : 1;

  const { zoomDomain, resetZoom, isSelecting, selectRange, chartProps, wrapperProps } = useChartZoom(dataMin, dataMax);

  const displayData = useMemo(() => {
    if (!zoomDomain) return chartData;
    return chartData.filter(d => d.t >= zoomDomain.x1 && d.t <= zoomDomain.x2);
  }, [chartData, zoomDomain]);

  const phaseMarkers = [
    session?.pre_climax_offset_s != null && { time_s: session.pre_climax_offset_s, label: "Pre-Climax", color: "#a855f7" },
    session?.climax_offset_s != null && { time_s: session.climax_offset_s, label: "Climax", color: "#ef4444" },
    session?.recovery_offset_s != null && { time_s: session.recovery_offset_s, label: "Recovery", color: "#3b82f6" },
  ].filter(Boolean);

  // Navigation operates on filtered events
  const safeFilteredIdx = Math.min(focusedFilteredIdx, Math.max(0, filteredEventIndices.length - 1));
  const currentOriginalIdx = filteredEventIndices[safeFilteredIdx] ?? null;

  // When an event is isolated on chart, sync it to the navigator
  const activeIsolatedIdx = isolatedEvent; // original index

  const navigateToFiltered = (filteredIdx) => {
    const newIdx = ((filteredIdx % filteredEventIndices.length) + filteredEventIndices.length) % filteredEventIndices.length;
    setFocusedFilteredIdx(newIdx);
    setIsolatedEvent(filteredEventIndices[newIdx]);
    resetZoom();
  };

  const handlePrev = () => navigateToFiltered(safeFilteredIdx - 1);
  const handleNext = () => navigateToFiltered(safeFilteredIdx + 1);

  const toggleIsolateOriginal = (origIdx) => {
    if (isolatedEvent === origIdx) {
      setIsolatedEvent(null);
    } else {
      setIsolatedEvent(origIdx);
      const fi = filteredEventIndices.indexOf(origIdx);
      if (fi !== -1) setFocusedFilteredIdx(fi);
      resetZoom();
    }
  };

  // Isolated event zoom overrides drag zoom
  const xDomain = useMemo(() => {
    if (isolatedEvent !== null && events[isolatedEvent]) {
      const t = events[isolatedEvent].time_s;
      return [Math.max(0, t - 60), t + 60];
    }
    if (zoomDomain) return [zoomDomain.x1, zoomDomain.x2];
    return ["dataMin", "dataMax"];
  }, [isolatedEvent, events, zoomDomain]);

  if (!timelineRows.length) return null;

  const isZoomed = zoomDomain != null || isolatedEvent !== null;

  // Navigator current event
  const navOrigIdx = currentOriginalIdx;
  const navEv = navOrigIdx != null ? events[navOrigIdx] : null;
  const navColor = navOrigIdx != null ? EVENT_COLORS[navOrigIdx % EVENT_COLORS.length] : "#888";

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <button className="flex items-center gap-1.5 flex-1 text-left" onClick={() => setCollapsed((v) => !v)}>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-primary">HR + Event Overlay</h3>
          {collapsed ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronUp className="w-4 h-4 text-muted-foreground" />}
        </button>
        {!collapsed && isZoomed && (
          <button
            onClick={() => { resetZoom(); setIsolatedEvent(null); }}
            className="flex items-center gap-1 text-[10px] text-primary border border-primary rounded px-2 py-0.5"
          >
            <ZoomOut className="w-3 h-3" /> Reset Zoom
          </button>
        )}
        {!collapsed && !isZoomed && (
          <span className="text-[10px] text-muted-foreground">Drag to zoom</span>
        )}
      </div>

      {collapsed && null}

      {!collapsed && <div className="h-64 cursor-crosshair" {...wrapperProps}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={displayData} margin={{ top: 8, right: 4, bottom: 0, left: -20 }} {...chartProps}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis dataKey="t" tick={{ fontSize: 9 }} tickFormatter={fmtMmSs} tickCount={8} type="number" domain={xDomain} />
            <YAxis tick={{ fontSize: 9 }} domain={["auto", "auto"]} />
            <Tooltip
              formatter={(val) => [`${Math.round(val)} bpm`, "HR"]}
              labelFormatter={(v) => fmtMmSs(Math.round(Number(v)))}
              contentStyle={{ fontSize: 11 }}
            />

            {/* Near-climax event highlight bands */}
            {nearClimaxEvents.map((nce, i) => {
              const isActive = i === ncIdx;
              return (
                <ReferenceArea
                  key={`nc-${i}`}
                  x1={nce.start_offset_s}
                  x2={nce.end_offset_s}
                  fill={NC_COLOR_HEX}
                  fillOpacity={isActive ? 0.22 : 0.09}
                  stroke={NC_COLOR_HEX}
                  strokeOpacity={isActive ? 0.7 : 0.25}
                  strokeWidth={isActive ? 1.5 : 1}
                />
              );
            })}

            {/* Phase markers */}
            {phaseMarkers.map((pm) => (
              <ReferenceLine
                key={pm.label}
                x={pm.time_s}
                stroke={pm.color}
                strokeWidth={1.5}
                strokeDasharray="4 2"
                label={{ value: pm.label, fontSize: 7, fill: pm.color, position: "top" }}
              />
            ))}

            {/* Event markers — show all, dim non-filtered */}
            {events.map((ev, i) => {
              const isFiltered = filteredEventIndices.includes(i);
              const isIsolated = isolatedEvent === i;
              if (!isFiltered && !isIsolated) return null;
              const color = EVENT_COLORS[i % EVENT_COLORS.length];
              return (
                <ReferenceLine
                  key={i}
                  x={ev.time_s}
                  stroke={color}
                  strokeWidth={isIsolated ? 2.5 : 1.5}
                  strokeDasharray="2 3"
                  strokeOpacity={isolatedEvent !== null && !isIsolated ? 0.3 : 1}
                  label={{ value: `E${i + 1}`, fontSize: 7, fill: color, position: "insideTopLeft" }}
                />
              );
            })}

            {/* Drag-to-zoom selection */}
            {isSelecting && selectRange && (
              <ReferenceArea
                x1={selectRange.x1}
                x2={selectRange.x2}
                fill="hsl(var(--primary))"
                fillOpacity={0.15}
                stroke="hsl(var(--primary))"
                strokeOpacity={0.5}
                strokeWidth={1}
              />
            )}

            <Line
              type="monotone"
              dataKey="hr"
              stroke="hsl(var(--primary))"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>}

      {/* Event navigator bar */}
      {!collapsed && navEv && (
        <div className="rounded-lg px-3 py-3" style={{ background: navColor + "18", borderLeft: `3px solid ${navColor}` }}>
          <div className="flex items-center gap-2 mb-2">
            <button onClick={handlePrev} className="p-0.5 rounded hover:bg-black/10 shrink-0">
              <ChevronLeft className="w-4 h-4" style={{ color: navColor }} />
            </button>
            <div className="flex-1 flex items-center gap-2 flex-wrap">
              <span className="font-mono text-[11px] font-bold" style={{ color: navColor }}>
                E{navOrigIdx + 1} / {filteredEventIndices.length}
                {activeFilters !== null && <span className="text-muted-foreground font-normal"> (filtered)</span>}
              </span>
              <span className="font-mono text-[11px] text-muted-foreground">{fmtMmSs(navEv.time_s)}</span>
              <EventCategoryPills ev={navEv} />
              {(() => { const hr = nearestHR(chartData, navEv.time_s); return hr != null && <span className="font-mono text-[11px] font-bold text-primary">{hr} bpm</span>; })()}
            </div>
            <button onClick={handleNext} className="p-0.5 rounded hover:bg-black/10 shrink-0">
              <ChevronRight className="w-4 h-4" style={{ color: navColor }} />
            </button>
          </div>
          <p className="text-sm text-foreground/90 leading-relaxed whitespace-pre-wrap">{navEv.note}</p>
        </div>
      )}

      {/* Near-climax event navigator */}
      {!collapsed && nearClimaxEvents.length > 0 && (() => {
        const nce = nearClimaxEvents[ncIdx];
        if (!nce) return null;
        const peakHR = nce.peak_hr ?? nearestHR(chartData, nce.peak_offset_s ?? nce.start_offset_s);
        return (
          <div className="rounded-lg px-3 py-2.5" style={{ background: NC_COLOR_HEX + "18", borderLeft: `3px solid ${NC_COLOR_HEX}` }}>
            <div className="flex items-center gap-2 mb-1.5">
              <button onClick={() => setNcIdx((p) => (p - 1 + nearClimaxEvents.length) % nearClimaxEvents.length)} className="p-0.5 rounded hover:bg-black/10 shrink-0">
                <ChevronLeft className="w-4 h-4" style={{ color: NC_COLOR_HEX }} />
              </button>
              <div className="flex-1 flex items-center gap-2 flex-wrap">
                <span className="font-mono text-[11px] font-bold flex items-center gap-1" style={{ color: NC_COLOR_HEX }}>
                  <Zap className="w-3 h-3" /> NC {ncIdx + 1} / {nearClimaxEvents.length}
                </span>
                <span className="text-[11px] text-muted-foreground">
                  {fmtMmSs(nce.start_offset_s)} → {fmtMmSs(nce.end_offset_s)}
                </span>
                {nce.rise_bpm != null && <span className="text-[11px] font-semibold" style={{ color: NC_COLOR_HEX }}>↑ +{nce.rise_bpm} bpm</span>}
                {peakHR != null && <span className="font-mono text-[11px] font-bold text-primary">peak {peakHR} bpm</span>}
                {nce.duration_s != null && <span className="text-[10px] text-muted-foreground">{fmtSec(nce.duration_s)}</span>}
              </div>
              <button onClick={() => setNcIdx((p) => (p + 1) % nearClimaxEvents.length)} className="p-0.5 rounded hover:bg-black/10 shrink-0">
                <ChevronRight className="w-4 h-4" style={{ color: NC_COLOR_HEX }} />
              </button>
            </div>
            {nce.ai_label && <p className="text-[10px] font-semibold mb-0.5" style={{ color: NC_COLOR_HEX }}>{nce.ai_label}</p>}
            {nce.ai_interpretation && (
              <p className="text-sm text-foreground/90 leading-relaxed italic">
                {nce.ai_interpretation.replace(/\b(\d+)\s*(?:seconds?|s\b)/gi, (_, n) => {
                  const v = parseInt(n, 10);
                  if (v >= 60) { const m = Math.floor(v / 60); const s = v % 60; return s > 0 ? `${m}m ${s}s` : `${m} min`; }
                  return `${v}s`;
                })}
              </p>
            )}
          </div>
        );
      })()}

      {/* Category filter chips + legend */}
      {!collapsed && events.length > 0 && (
        <div className="space-y-2 pt-1">
          {/* Filter chips */}
          {usedCategories.length > 1 && (
            <div className="flex flex-wrap gap-1.5 items-center">
              <span className="text-[9px] uppercase tracking-wider text-muted-foreground font-semibold mr-1">Filter:</span>
              <button
                onClick={selectAllFilters}
                className="text-[10px] px-2 py-0.5 rounded-full border font-medium transition-all"
                style={activeFilters === null
                  ? { background: "hsl(var(--primary))", color: "#fff", borderColor: "hsl(var(--primary))" }
                  : { background: "transparent", color: "hsl(var(--muted-foreground))", borderColor: "hsl(var(--border))" }}
              >
                All
              </button>
              {usedCategories.map((cat) => {
                const active = isCatActive(cat.value);
                return (
                  <button
                    key={cat.value}
                    onClick={() => toggleFilter(cat.value)}
                    className="text-[10px] px-2 py-0.5 rounded-full border font-medium transition-all"
                    style={active
                      ? { background: cat.color, color: "#fff", borderColor: cat.color }
                      : { background: cat.color + "18", color: cat.color, borderColor: cat.color + "44", opacity: 0.5 }}
                  >
                    {cat.label}
                  </button>
                );
              })}
            </div>
          )}

          <button
            className="w-full flex items-center justify-between"
            onClick={() => setEventsCollapsed((v) => !v)}
          >
            <p className="text-[10px] text-muted-foreground uppercase font-semibold tracking-wider">
              Events {isolatedEvent !== null ? "— tap again to reset · drag chart to zoom" : "— tap to isolate · drag chart to zoom"}
            </p>
            {eventsCollapsed ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" /> : <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" />}
          </button>

          {!eventsCollapsed && events.map((ev, i) => {
            const color = EVENT_COLORS[i % EVENT_COLORS.length];
            const isIsolated = isolatedEvent === i;
            const isFiltered = filteredEventIndices.includes(i);
            const dimmed = !isFiltered || (isolatedEvent !== null && !isIsolated);
            const hr = nearestHR(chartData, ev.time_s);
            return (
              <button
                key={i}
                onClick={() => toggleIsolateOriginal(i)}
                className={`w-full flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-left transition-opacity ${dimmed ? "opacity-30" : ""}`}
                style={{
                  background: isIsolated ? color + "30" : color + "15",
                  borderLeft: `3px solid ${color}`,
                  outline: isIsolated ? `1px solid ${color}55` : "none",
                }}
              >
                <span className="font-mono text-[10px] shrink-0 mt-0.5 font-bold" style={{ color }}>
                  E{i + 1} {fmtMmSs(ev.time_s)}
                </span>
                <div className="flex-1 flex flex-col gap-0.5">
                  <div className="flex flex-wrap gap-1"><EventCategoryPills ev={ev} /></div>
                  <span className="text-xs text-foreground/90 leading-snug">{ev.note}</span>
                </div>
                {hr != null && (
                  <span className="font-mono text-[10px] shrink-0 font-bold text-primary/80 mt-0.5">{hr} bpm</span>
                )}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}