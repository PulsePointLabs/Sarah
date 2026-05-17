import { useMemo, useState, useCallback } from "react";
import { ChevronDown, ChevronUp, ChevronLeft, ChevronRight } from "lucide-react";
import {
  ComposedChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
  ReferenceLine, Scatter, CartesianGrid,
} from "recharts";
import { EVENT_CATEGORIES, normalizeCategoryArray } from "./session-form/EventTimelineSection";

function getCategoryMeta(value) {
  return EVENT_CATEGORIES.find((c) => c.value === value) || EVENT_CATEGORIES[EVENT_CATEGORIES.length - 1];
}

function fmtMmSs(totalSeconds) {
  const v = Math.round(Number(totalSeconds));
  const m = Math.floor(v / 60);
  const s = v % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// Green (1) → Yellow (5) → Red (10)
function arousalColor(arousal) {
  const t = Math.max(0, Math.min(1, (arousal - 1) / 9));
  if (t <= 0.5) {
    const r = Math.round(255 * (t * 2));
    return `rgb(${r}, 200, 60)`;
  } else {
    const g = Math.round(200 * (1 - (t - 0.5) * 2));
    return `rgb(255, ${g}, 40)`;
  }
}

function buildArousalCurve(timelineRows, session) {
  if (!timelineRows.length) return [];
  const maxHR = Math.max(...timelineRows.map((r) => Number(r.hr)));
  const minHR = Math.min(...timelineRows.map((r) => Number(r.hr)));
  const hrRange = maxHR - minHR || 1;
  const step = Math.max(1, Math.floor(timelineRows.length / 120));
  const sampled = timelineRows.filter((_, i) => i % step === 0);
  const climaxT = session.climax_offset_s ?? null;

  return sampled.map((r) => {
    const t = Number(r.time_offset_s);
    const hrNorm = (Number(r.hr) - minHR) / hrRange;
    let phaseMult = 1;
    if (climaxT != null) {
      if (t <= climaxT) {
        phaseMult = 0.6 + 0.4 * (t / climaxT);
      } else {
        const recT = session.recovery_offset_s ?? climaxT + 120;
        const decay = Math.max(0, 1 - (t - climaxT) / Math.max(1, recT - climaxT));
        phaseMult = 0.5 + 0.5 * decay;
      }
    }
    const arousal = Math.round(1 + hrNorm * phaseMult * 9);
    return { time_s: t, arousal: Math.min(10, Math.max(1, arousal)) };
  });
}

// Event scatter dot — highlighted if active
function EventDot(props) {
  const { cx, cy, payload, activeIdx } = props;
  if (!payload) return null;
  const isActive = activeIdx === payload._idx;
  const isDimmed = activeIdx != null && !isActive;
  const color = arousalColor(payload.arousal ?? 5);
  return (
    <circle
      cx={cx}
      cy={cy}
      r={isActive ? 7 : 5}
      fill={color}
      stroke="#fff"
      strokeWidth={isActive ? 2.5 : 1.5}
      opacity={isDimmed ? 0.25 : 1}
      style={{ cursor: "pointer" }}
    />
  );
}

function CustomTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  if (!d) return null;

  if (d.category !== undefined) {
    const cats = normalizeCategoryArray(d.category);
    const color = arousalColor(d.arousal ?? 5);
    return (
      <div className="bg-popover border border-border rounded-lg shadow-lg px-3 py-2 text-xs max-w-[220px] space-y-1">
        <p className="font-mono font-bold text-primary">{fmtMmSs(d.time_s)}</p>
        <div className="flex flex-wrap gap-1">
          {cats.map((c) => {
            const m = getCategoryMeta(c);
            return <span key={c} className="text-[9px] px-1.5 rounded-full font-semibold" style={{ background: m.color + "22", color: m.color }}>{m.label}</span>;
          })}
        </div>
        <p className="text-foreground leading-snug">{d.note}</p>
        {d.arousal != null && <p className="font-semibold" style={{ color }}>Arousal {d.arousal}/10</p>}
      </div>
    );
  }

  return (
    <div className="bg-popover border border-border rounded-lg shadow-lg px-3 py-2 text-xs">
      <p className="font-mono text-muted-foreground">{fmtMmSs(d.time_s)}</p>
      <p className="font-bold">Arousal: <span className="text-primary">{d.arousal}/10</span></p>
    </div>
  );
}

const PHASE_LINES = [
  { key: "pre_climax_offset_s", label: "Pre-Climax", color: "#a855f7" },
  { key: "climax_offset_s",     label: "Climax",     color: "#ef4444" },
  { key: "recovery_offset_s",   label: "Recovery",   color: "#3b82f6" },
];

export default function ArousalEventChart({ session, timelineRows }) {
  const [hiddenCats, setHiddenCats] = useState(new Set());
  const [collapsed, setCollapsed] = useState(true);
  const [listCollapsed, setListCollapsed] = useState(false);
  const [activeIdx, setActiveIdx] = useState(null); // original event index
  const [focusedFilteredIdx, setFocusedFilteredIdx] = useState(0);

  const arousalCurve = useMemo(() => buildArousalCurve(timelineRows, session), [timelineRows, session]);

  // Map each event (with original index) to nearest arousal value
  const eventPoints = useMemo(() => {
    if (!arousalCurve.length) return [];
    return (session.event_timeline || [])
      .map((ev, _idx) => {
        const cats = normalizeCategoryArray(ev.category);
        if (cats.some((c) => hiddenCats.has(c))) return null;
        let best = arousalCurve[0];
        let bestDist = Math.abs(arousalCurve[0].time_s - ev.time_s);
        for (const pt of arousalCurve) {
          const d = Math.abs(pt.time_s - ev.time_s);
          if (d < bestDist) { bestDist = d; best = pt; }
        }
        return { ...ev, arousal: best.arousal, _idx };
      })
      .filter(Boolean);
  }, [session.event_timeline, arousalCurve, hiddenCats]);

  const toggleCat = (val) => {
    setHiddenCats((prev) => {
      const next = new Set(prev);
      if (next.has(val)) next.delete(val); else next.add(val);
      return next;
    });
    setActiveIdx(null);
  };

  const handleEventClick = useCallback((origIdx) => {
    setActiveIdx((prev) => prev === origIdx ? null : origIdx);
    const fi = eventPoints.findIndex((e) => e._idx === origIdx);
    if (fi !== -1) setFocusedFilteredIdx(fi);
  }, [eventPoints]);

  const navigateTo = useCallback((fi) => {
    const bounded = ((fi % eventPoints.length) + eventPoints.length) % eventPoints.length;
    setFocusedFilteredIdx(bounded);
    setActiveIdx(eventPoints[bounded]?._idx ?? null);
  }, [eventPoints]);

  const presentCats = useMemo(() => {
    const seen = new Set();
    for (const ev of session.event_timeline || []) {
      for (const c of normalizeCategoryArray(ev.category)) seen.add(c);
    }
    return EVENT_CATEGORIES.filter((c) => seen.has(c.value));
  }, [session.event_timeline]);

  const hasCurve = arousalCurve.length > 0;
  const hasEvents = (session.event_timeline || []).length > 0;

  if (!hasCurve && !hasEvents) return null;

  const maxT = arousalCurve.length
    ? arousalCurve[arousalCurve.length - 1].time_s
    : Math.max(...(session.event_timeline || []).map((e) => e.time_s), 0);

  const activeEvent = activeIdx != null ? eventPoints.find((e) => e._idx === activeIdx) : null;

  return (
    <div className="bg-card rounded-xl border border-border p-4 space-y-3">
      <button className="w-full flex items-center justify-between" onClick={() => setCollapsed((v) => !v)}>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-primary flex items-center gap-1.5">
          Arousal Arc &amp; Event Correlation
        </h3>
        {collapsed ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronUp className="w-4 h-4 text-muted-foreground" />}
      </button>

      {!collapsed && (
        <>
          {/* Category filter pills */}
          {presentCats.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {presentCats.map((c) => {
                const hidden = hiddenCats.has(c.value);
                return (
                  <button key={c.value} onClick={() => toggleCat(c.value)}
                    className="text-[10px] px-2 py-0.5 rounded-full border font-medium transition-all"
                    style={hidden
                      ? { background: "transparent", color: c.color + "88", borderColor: c.color + "33" }
                      : { background: c.color + "22", color: c.color, borderColor: c.color + "66" }}
                  >
                    {c.label}
                  </button>
                );
              })}
            </div>
          )}

          <div className="w-full" style={{ height: 200 }}>
            <ResponsiveContainer width="100%" height="100%">
              <ComposedChart
                margin={{ top: 8, right: 8, left: -20, bottom: 0 }}
                onClick={(chartData) => {
                  if (!chartData?.activePayload?.length) return;
                  const clicked = chartData.activePayload.find((p) => p.payload?.category !== undefined);
                  if (clicked) {
                    handleEventClick(clicked.payload._idx);
                  }
                }}
              >
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.4} />
                <XAxis
                  dataKey="time_s"
                  type="number"
                  domain={[0, maxT]}
                  tickFormatter={fmtMmSs}
                  tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
                  tickCount={7}
                  allowDataOverflow
                />
                <YAxis
                  domain={[0, 10]}
                  ticks={[1, 3, 5, 7, 10]}
                  tick={{ fontSize: 9, fill: "hsl(var(--muted-foreground))" }}
                  width={28}
                />
                <Tooltip content={<CustomTooltip />} />

                {/* Phase reference lines */}
                {PHASE_LINES.map(({ key, label, color }) =>
                  session[key] != null ? (
                    <ReferenceLine key={key} x={session[key]} stroke={color} strokeWidth={1.5}
                      strokeDasharray="4 3"
                      label={{ value: label, position: "top", fontSize: 8, fill: color, offset: 4 }} />
                  ) : null
                )}

                {/* Active event highlight line */}
                {activeEvent && (
                  <ReferenceLine
                    x={activeEvent.time_s}
                    stroke={arousalColor(activeEvent.arousal ?? 5)}
                    strokeWidth={2}
                    strokeDasharray="3 2"
                  />
                )}

                {/* Arousal curve */}
                {hasCurve && (
                  <Line data={arousalCurve} dataKey="arousal" type="monotone"
                    stroke="hsl(var(--primary))" strokeWidth={2} dot={false} isAnimationActive={false} />
                )}

                {/* Event scatter — pass activeIdx to each dot */}
                {eventPoints.length > 0 && (
                  <Scatter
                    data={eventPoints}
                    dataKey="arousal"
                    shape={(props) => <EventDot {...props} activeIdx={activeIdx} />}
                    isAnimationActive={false}
                  />
                )}
              </ComposedChart>
            </ResponsiveContainer>
          </div>

          {!hasCurve && hasEvents && (
            <p className="text-xs text-muted-foreground text-center">
              Upload a HR file to see the full arousal arc. Events shown at estimated positions.
            </p>
          )}

          {/* Navigator card — shown when an event is active */}
          {activeEvent && (() => {
            const color = arousalColor(activeEvent.arousal ?? 5);
            const cats = normalizeCategoryArray(activeEvent.category);
            const fi = eventPoints.findIndex((e) => e._idx === activeEvent._idx);
            return (
              <div className="rounded-lg px-3 py-3 space-y-1.5" style={{ background: color + "18", borderLeft: `3px solid ${color}` }}>
                <div className="flex items-center gap-2">
                  <button onClick={() => navigateTo(fi - 1)} className="p-0.5 rounded hover:bg-black/10 shrink-0">
                    <ChevronLeft className="w-4 h-4" style={{ color }} />
                  </button>
                  <div className="flex-1 flex items-center gap-2 flex-wrap">
                    <span className="font-mono text-[11px] font-bold" style={{ color }}>
                      E{fi + 1} / {eventPoints.length}
                    </span>
                    <span className="font-mono text-[11px] text-muted-foreground">{fmtMmSs(activeEvent.time_s)}</span>
                    {cats.map((c) => {
                      const m = getCategoryMeta(c);
                      return <span key={c} className="text-[9px] px-1.5 rounded-full font-semibold" style={{ background: m.color + "22", color: m.color }}>{m.label}</span>;
                    })}
                    {activeEvent.arousal != null && (
                      <span className="font-mono text-[11px] font-bold" style={{ color }}>
                        {activeEvent.arousal}/10
                      </span>
                    )}
                  </div>
                  <button onClick={() => navigateTo(fi + 1)} className="p-0.5 rounded hover:bg-black/10 shrink-0">
                    <ChevronRight className="w-4 h-4" style={{ color }} />
                  </button>
                </div>
                <p className="text-sm text-foreground/90 leading-relaxed whitespace-pre-wrap">{activeEvent.note}</p>
              </div>
            );
          })()}

          {/* Collapsible event list */}
          {eventPoints.length > 0 && (
            <div className="border-t border-border pt-2">
              <button
                className="w-full flex items-center justify-between mb-1.5"
                onClick={() => setListCollapsed((v) => !v)}
              >
                <p className="text-[10px] uppercase tracking-wider font-semibold text-muted-foreground">
                  All Events ({eventPoints.length}) — tap to highlight
                </p>
                {listCollapsed
                  ? <ChevronDown className="w-3.5 h-3.5 text-muted-foreground" />
                  : <ChevronUp className="w-3.5 h-3.5 text-muted-foreground" />}
              </button>

              {!listCollapsed && (
                <div className="space-y-1">
                  {eventPoints.map((ev) => {
                    const cats = normalizeCategoryArray(ev.category);
                    const color = arousalColor(ev.arousal ?? 5);
                    const isActive = activeIdx === ev._idx;
                    const isDimmed = activeIdx != null && !isActive;
                    return (
                      <button
                        key={ev._idx}
                        onClick={() => handleEventClick(ev._idx)}
                        className="w-full flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-left transition-all"
                        style={{
                          background: isActive ? color + "28" : color + "0f",
                          borderLeft: `3px solid ${isActive ? color : color + "55"}`,
                          outline: isActive ? `1px solid ${color}44` : "none",
                          opacity: isDimmed ? 0.35 : 1,
                        }}
                      >
                        <span className="font-mono text-[10px] font-bold shrink-0 mt-0.5" style={{ color }}>
                          {fmtMmSs(ev.time_s)}
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
                        {ev.arousal != null && (
                          <span className="font-mono text-[10px] font-bold shrink-0 mt-0.5 px-1.5 py-0.5 rounded-md"
                            style={{ background: color + "22", color }}>
                            {ev.arousal}/10
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