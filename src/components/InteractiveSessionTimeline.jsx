import { useState, useMemo } from "react";
import {
  ComposedChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, ReferenceLine, ReferenceArea, Scatter, ScatterChart,
} from "recharts";
import { Button } from "@/components/ui/button";

// ─── Helpers ───────────────────────────────────────────────────────────────────
function fmtSec(v) {
  const t = Math.round(Number(v));
  const m = Math.floor(t / 60);
  const s = t % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

const PHASE_COLORS = {
  pre_climax: "#a855f7",
  climax: "#ef4444",
  recovery: "#3b82f6",
};

const PHASE_LABELS = { pre_climax: "Pre-Climax", climax: "Climax", recovery: "Recovery" };

// Event category → color/icon
const CAT_COLOR = {
  stimulation_change: "#f59e0b",
  stimulation_paused: "#6b7280",
  stimulation_resumed: "#10b981",
  sensation: "#a855f7",
  edging: "#f43f5e",
  near_climax: "#ef4444",
  other: "#94a3b8",
};
const CAT_SYMBOL = {
  stimulation_change: "▲",
  stimulation_paused: "⏸",
  stimulation_resumed: "▶",
  sensation: "◆",
  edging: "★",
  near_climax: "●",
  other: "•",
};

function getEventColor(cats) {
  for (const c of cats) if (CAT_COLOR[c]) return CAT_COLOR[c];
  return CAT_COLOR.other;
}
function getEventSymbol(cats) {
  for (const c of cats) if (CAT_SYMBOL[c]) return CAT_SYMBOL[c];
  return CAT_SYMBOL.other;
}

// ─── Custom event dot rendered on the chart ────────────────────────────────────
function EventDot({ cx, cy, payload }) {
  if (!payload?.isEvent) return null;
  const color = payload.evColor || "#94a3b8";
  return (
    <g>
      <circle cx={cx} cy={cy} r={6} fill={color} stroke="white" strokeWidth={1.5} opacity={0.9} />
    </g>
  );
}

// ─── Custom tooltip ────────────────────────────────────────────────────────────
function CustomTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;

  const hrEntry = payload.find((p) => p.dataKey === "hr");
  const smoothEntry = payload.find((p) => p.dataKey === "hr_smoothed");
  const intensityEntry = payload.find((p) => p.dataKey === "arousal");

  // Check if this is an event point
  const evEntry = payload.find((p) => p.payload?.isEvent);

  return (
    <div className="bg-card border border-border rounded-lg p-2.5 text-xs shadow-lg max-w-[200px]">
      <p className="font-semibold text-muted-foreground mb-1.5">{fmtSec(label)}</p>
      {hrEntry && (
        <p className="font-mono font-bold" style={{ color: "hsl(var(--primary))" }}>
          HR: {Math.round(hrEntry.value)} bpm
        </p>
      )}
      {smoothEntry && (
        <p className="font-mono text-muted-foreground">
          Smooth: {Math.round(smoothEntry.value)} bpm
        </p>
      )}
      {intensityEntry && (
        <p className="font-mono font-bold" style={{ color: "hsl(var(--chart-4))" }}>
          Arousal: {intensityEntry.value}/10
        </p>
      )}
      {evEntry?.payload?.evNote && (
        <p className="mt-1.5 text-foreground border-t border-border pt-1.5 leading-snug">
          {evEntry.payload.evNote}
        </p>
      )}
    </div>
  );
}

// ─── Main Component ─────────────────────────────────────────────────────────────
export default function InteractiveSessionTimeline({ session, timelineRows }) {
  const [zoomDomain, setZoomDomain] = useState(null);
  const [selectStart, setSelectStart] = useState(null);
  const [selectEnd, setSelectEnd] = useState(null);
  const [isSelecting, setIsSelecting] = useState(false);
  const [showSmoothed, setShowSmoothed] = useState(false);
  const [hoveredEvent, setHoveredEvent] = useState(null);

  const maxT = useMemo(
    () => (timelineRows.length ? Math.max(...timelineRows.map((r) => Number(r.time_offset_s))) : 0),
    [timelineRows]
  );

  // Downsample for performance — target ~500 pts
  const sampledHR = useMemo(() => {
    if (!timelineRows.length) return [];
    const step = Math.max(1, Math.floor(timelineRows.length / 500));
    return timelineRows.filter((_, i) => i % step === 0).map((r) => ({
      t: Number(r.time_offset_s),
      hr: Number(r.hr) || null,
      hr_smoothed: r.hr_smoothed != null ? Number(r.hr_smoothed) : undefined,
    }));
  }, [timelineRows]);

  // Build a map of every 30s bucket → list of events at that time (for overlaying on HR chart)
  const events = session?.event_timeline || [];

  // Build combined data merging HR + event markers
  const chartData = useMemo(() => {
    // Merge events onto the nearest HR sample
    const rows = sampledHR.map((r) => ({ ...r }));
    const evMap = {};
    events.forEach((ev) => {
      const nearest = sampledHR.reduce((best, r) =>
        Math.abs(r.t - ev.time_s) < Math.abs(best.t - ev.time_s) ? r : best,
        sampledHR[0]
      );
      if (nearest) {
        const key = nearest.t;
        if (!evMap[key]) evMap[key] = [];
        evMap[key].push(ev);
      }
    });
    return rows.map((r) => {
      const evs = evMap[r.t];
      if (evs?.length) {
        const cats = evs.flatMap((e) => Array.isArray(e.category) ? e.category : [e.category].filter(Boolean));
        return {
          ...r,
          isEvent: true,
          evColor: getEventColor(cats),
          evSymbol: getEventSymbol(cats),
          evNote: evs.map((e) => e.note).join(" · "),
          evCount: evs.length,
        };
      }
      return r;
    });
  }, [sampledHR, events]);

  // Arousal line — placed at event timestamps with subjective intensity if available
  // Interpolate arousal as a step function from logged events that carry a sensation/near_climax category
  const arousalData = useMemo(() => {
    const pts = events
      .filter((e) => {
        const cats = Array.isArray(e.category) ? e.category : [e.category].filter(Boolean);
        return cats.some((c) => ["near_climax", "edging", "sensation"].includes(c));
      })
      .map((e) => ({ t: e.time_s, arousal: null })); // no value — just markers

    // If session has intensity field, place it at climax marker
    const intensityPts = [];
    if (session?.intensity && session?.climax_offset_s != null) {
      // Simple arc: ramp from 1 at start → intensity at climax → drops after
      const dur = maxT;
      const climax = session.climax_offset_s;
      const pre = session.pre_climax_offset_s ?? climax * 0.7;
      const step = Math.max(1, Math.floor(sampledHR.length / 60));
      sampledHR.filter((_, i) => i % step === 0).forEach((r) => {
        const t = r.t;
        let val;
        if (t <= pre) {
          val = 1 + (session.intensity * 0.4) * (t / pre);
        } else if (t <= climax) {
          val = 1 + (session.intensity * 0.4) + (session.intensity * 0.6 - 1) * ((t - pre) / (climax - pre));
        } else {
          const drop = Math.min(1, (t - climax) / 60);
          val = session.intensity * (1 - drop * 0.6);
        }
        intensityPts.push({ t, arousal: parseFloat(Math.min(10, Math.max(1, val)).toFixed(1)) });
      });
    }
    return intensityPts;
  }, [events, session, sampledHR, maxT]);

  // Merge arousal into chart data
  const arousalMap = useMemo(() => {
    const m = {};
    arousalData.forEach((p) => { m[p.t] = p.arousal; });
    return m;
  }, [arousalData]);

  const mergedData = useMemo(() =>
    chartData.map((r) => ({ ...r, arousal: arousalMap[r.t] ?? undefined })),
    [chartData, arousalMap]
  );

  const displayData = useMemo(() => {
    if (!zoomDomain) return mergedData;
    return mergedData.filter((r) => r.t >= zoomDomain[0] && r.t <= zoomDomain[1]);
  }, [mergedData, zoomDomain]);

  const xDomain = zoomDomain ?? ["dataMin", "dataMax"];

  const hasSmoothed = timelineRows.some((r) => r.hr_smoothed != null);
  const hasArousal = arousalData.length > 0;

  // Phase markers
  const phases = [
    { key: "pre_climax", offset: session?.pre_climax_offset_s },
    { key: "climax", offset: session?.climax_offset_s },
    { key: "recovery", offset: session?.recovery_offset_s },
  ].filter((p) => p.offset != null);

  // Event list for the legend strip below chart
  const eventList = useMemo(() =>
    [...events].sort((a, b) => a.time_s - b.time_s),
    [events]
  );

  // HR Y-axis domain
  const hrVals = timelineRows.map((r) => Number(r.hr)).filter((v) => !isNaN(v));
  const hrMin = hrVals.length ? Math.floor(Math.min(...hrVals) * 0.97) : 40;
  const hrMax = hrVals.length ? Math.ceil(Math.max(...hrVals) * 1.02) : 200;

  const handleMouseDown = (e) => {
    if (!e?.activeLabel) return;
    setIsSelecting(true);
    setSelectStart(Number(e.activeLabel));
    setSelectEnd(null);
  };
  const handleMouseMove = (e) => {
    if (!isSelecting || !e?.activeLabel) return;
    setSelectEnd(Number(e.activeLabel));
  };
  const handleMouseUp = () => {
    if (isSelecting && selectStart != null && selectEnd != null) {
      const lo = Math.min(selectStart, selectEnd);
      const hi = Math.max(selectStart, selectEnd);
      if (hi - lo > 5) setZoomDomain([lo, hi]);
    }
    setIsSelecting(false);
    setSelectStart(null);
    setSelectEnd(null);
  };

  if (!timelineRows.length && !events.length) return null;

  return (
    <div className="bg-card rounded-xl border border-border p-4 space-y-3">
      {/* Header */}
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-primary">
          Session Timeline
        </h3>
        <div className="flex items-center gap-1.5 flex-wrap">
          {hasSmoothed && (
            <Button
              size="sm"
              variant={showSmoothed ? "default" : "outline"}
              className="h-6 text-[10px] px-2"
              onClick={() => setShowSmoothed((v) => !v)}
            >
              Smoothed
            </Button>
          )}
          {zoomDomain ? (
            <Button
              size="sm"
              variant="outline"
              className="h-6 text-[10px] px-2 text-primary border-primary"
              onClick={() => setZoomDomain(null)}
            >
              Reset Zoom
            </Button>
          ) : (
            <span className="text-[10px] text-muted-foreground">Drag to zoom</span>
          )}
        </div>
      </div>

      {/* Main Chart */}
      <div className="h-64 cursor-crosshair select-none">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart
            data={displayData}
            margin={{ top: 8, right: 4, bottom: 0, left: -16 }}
            onMouseDown={handleMouseDown}
            onMouseMove={handleMouseMove}
            onMouseUp={handleMouseUp}
          >
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis
              dataKey="t"
              type="number"
              domain={xDomain}
              tick={{ fontSize: 9 }}
              tickFormatter={fmtSec}
              allowDataOverflow
            />
            {/* Left Y axis — HR */}
            <YAxis
              yAxisId="hr"
              domain={[hrMin, hrMax]}
              tick={{ fontSize: 9 }}
              width={28}
              tickFormatter={(v) => v}
            />
            {/* Right Y axis — Arousal (1-10) */}
            {hasArousal && (
              <YAxis
                yAxisId="arousal"
                orientation="right"
                domain={[0, 10]}
                tick={{ fontSize: 9 }}
                width={22}
                tickFormatter={(v) => v}
              />
            )}

            <Tooltip
              content={<CustomTooltip />}
              labelFormatter={fmtSec}
            />

            {/* Zoom selection */}
            {isSelecting && selectStart != null && selectEnd != null && (
              <ReferenceArea
                yAxisId="hr"
                x1={Math.min(selectStart, selectEnd)}
                x2={Math.max(selectStart, selectEnd)}
                fill="hsl(var(--primary))"
                fillOpacity={0.12}
                stroke="hsl(var(--primary))"
                strokeOpacity={0.4}
              />
            )}

            {/* Phase bands */}
            {phases.length >= 2 && (() => {
              const pre = phases.find((p) => p.key === "pre_climax");
              const climax = phases.find((p) => p.key === "climax");
              const rec = phases.find((p) => p.key === "recovery");
              return (
                <>
                  {pre && climax && (
                    <ReferenceArea
                      yAxisId="hr"
                      x1={pre.offset} x2={climax.offset}
                      fill="#a855f7" fillOpacity={0.06}
                    />
                  )}
                  {climax && rec && (
                    <ReferenceArea
                      yAxisId="hr"
                      x1={climax.offset} x2={rec.offset}
                      fill="#3b82f6" fillOpacity={0.06}
                    />
                  )}
                </>
              );
            })()}

            {/* Phase marker lines */}
            {!session?.no_climax && phases.map((p) => (
              <ReferenceLine
                key={p.key}
                yAxisId="hr"
                x={p.offset}
                stroke={PHASE_COLORS[p.key]}
                strokeWidth={2}
                label={{ value: PHASE_LABELS[p.key], fontSize: 8, fill: PHASE_COLORS[p.key], position: "insideTopLeft" }}
              />
            ))}

            {/* Smoothed HR */}
            {showSmoothed && hasSmoothed && (
              <Line
                yAxisId="hr"
                type="monotone"
                dataKey="hr_smoothed"
                stroke="hsl(var(--chart-2))"
                strokeWidth={1.5}
                dot={false}
                strokeDasharray="4 2"
                connectNulls
                isAnimationActive={false}
              />
            )}

            {/* Raw HR */}
            <Line
              yAxisId="hr"
              type="monotone"
              dataKey="hr"
              stroke="hsl(var(--primary))"
              strokeWidth={2}
              dot={(props) => <EventDot {...props} />}
              activeDot={{ r: 4, yAxisId: "hr" }}
              connectNulls
              isAnimationActive={false}
            />

            {/* Arousal arc */}
            {hasArousal && (
              <Line
                yAxisId="arousal"
                type="monotone"
                dataKey="arousal"
                stroke="hsl(var(--chart-4))"
                strokeWidth={2}
                strokeDasharray="6 3"
                dot={false}
                connectNulls
                isAnimationActive={false}
                opacity={0.85}
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      {/* Legend */}
      <div className="flex flex-wrap gap-3 text-[10px] text-muted-foreground">
        <span className="flex items-center gap-1">
          <span className="w-4 h-0.5 bg-primary inline-block" /> Heart Rate
        </span>
        {showSmoothed && hasSmoothed && (
          <span className="flex items-center gap-1">
            <span className="w-4 h-0.5 inline-block" style={{ borderTop: "2px dashed hsl(var(--chart-2))" }} /> Smoothed HR
          </span>
        )}
        {hasArousal && (
          <span className="flex items-center gap-1">
            <span className="w-4 h-0.5 inline-block" style={{ borderTop: "2px dashed hsl(var(--chart-4))" }} /> Arousal Arc
          </span>
        )}
        {phases.map((p) => (
          <span key={p.key} className="flex items-center gap-1">
            <span className="w-2 h-2 rounded-full inline-block" style={{ background: PHASE_COLORS[p.key] }} />
            {PHASE_LABELS[p.key]}
          </span>
        ))}
        {eventList.length > 0 && (
          <span className="flex items-center gap-1">
            <span className="w-3 h-3 rounded-full inline-block border-2 border-white" style={{ background: "#f59e0b" }} /> Events
          </span>
        )}
      </div>

      {/* Event strip — scrollable list of all events */}
      {eventList.length > 0 && (
        <div className="space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Key Moments</p>
          <div className="space-y-1 max-h-40 overflow-y-auto pr-1">
            {eventList.map((ev, i) => {
              const cats = Array.isArray(ev.category) ? ev.category : [ev.category].filter(Boolean);
              const color = getEventColor(cats);
              const sym = getEventSymbol(cats);
              return (
                <div
                  key={i}
                  className="flex items-start gap-2 rounded-lg px-2 py-1.5 bg-muted/40 hover:bg-muted/70 transition-colors cursor-default"
                  onMouseEnter={() => setHoveredEvent(i)}
                  onMouseLeave={() => setHoveredEvent(null)}
                  style={{ borderLeft: `3px solid ${color}` }}
                >
                  <span className="font-mono text-[10px] text-muted-foreground shrink-0 pt-0.5 w-10">
                    {fmtSec(ev.time_s)}
                  </span>
                  <span className="text-[10px] shrink-0 pt-0.5" style={{ color }}>{sym}</span>
                  <span className="text-xs leading-snug text-foreground">{ev.note}</span>
                  {cats.length > 0 && (
                    <span className="ml-auto text-[9px] text-muted-foreground shrink-0 pt-0.5 capitalize">
                      {cats[0].replace(/_/g, " ")}
                    </span>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}