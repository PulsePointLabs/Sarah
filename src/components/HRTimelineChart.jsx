import { useState, useMemo } from "react";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine, ReferenceArea,
} from "recharts";
import { Button } from "@/components/ui/button";
import { ZoomIn, ZoomOut } from "lucide-react";
import { useChartZoom } from "@/hooks/useChartZoom";

const MARKER_COLORS = {
  build: "#f59e0b",
  climax: "#ef4444",
  recovery: "#3b82f6",
};

const PHASE_COLORS = {
  pre_climax: "#a855f7",
  climax: "#ef4444",
  recovery: "#3b82f6",
};

function fmtSec(v) {
  const total = Math.round(Number(v));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function deltaSec(a, b) {
  if (a == null || b == null) return null;
  return Math.round(Math.abs(b - a));
}

function MarkerDot(props) {
  const { cx, cy, payload } = props;
  if (!payload?.marker || payload.marker === "build" || payload.marker === "recovery") return <g />;
  const color = MARKER_COLORS[payload.marker];
  if (!color) return <g />;
  return <circle cx={cx} cy={cy} r={5} fill={color} stroke="white" strokeWidth={1.5} />;
}

function ManualTimeInput({ phase, color, label, currentOffset, maxOffset, onSet }) {
  const [min, setMin] = useState("");
  const [sec, setSec] = useState("");

  const handleSet = () => {
    const totalS = (parseInt(min) || 0) * 60 + (parseInt(sec) || 0);
    if (totalS >= 0 && totalS <= maxOffset) onSet(totalS);
  };

  return (
    <div className="flex items-center gap-2 bg-muted rounded-lg px-3 py-2 flex-1 min-w-0">
      <span className="text-xs font-semibold w-20 shrink-0" style={{ color }}>{label}</span>
      {currentOffset != null && (
        <span className="text-xs font-mono text-foreground font-semibold w-12 shrink-0">
          {Math.floor(Math.round(currentOffset)/60)}:{String(Math.round(currentOffset)%60).padStart(2,"0")}
        </span>
      )}
      {currentOffset == null && <span className="w-12 shrink-0" />}
      <input
        type="number" min={0}
        placeholder="m"
        value={min}
        onChange={(e) => setMin(e.target.value)}
        className="w-14 text-xs bg-background border border-border rounded px-2 py-1 font-mono text-center"
      />
      <span className="text-xs text-muted-foreground">:</span>
      <input
        type="number" min={0} max={59}
        placeholder="s"
        value={sec}
        onChange={(e) => setSec(e.target.value)}
        className="w-14 text-xs bg-background border border-border rounded px-2 py-1 font-mono text-center"
      />
      <button
        onClick={handleSet}
        className="text-xs px-3 py-1 rounded font-semibold text-white shrink-0"
        style={{ background: color }}
      >Set</button>
    </div>
  );
}

const WINDOWS = [
  { label: "Full", value: "full" },
  { label: "Last 5m", value: 5 },
  { label: "Last 3m", value: 3 },
  { label: "Last 2m", value: 2 },
];

const MARKING_PHASES = ["pre_climax", "climax", "recovery"];
const PHASE_LABELS = { pre_climax: "Pre-Climax", climax: "Climax", recovery: "Recovery" };

export default function HRTimelineChart({ rows, savedMarkers = {}, onMarkersChange, highlightRange = null, noClimax = false, nearClimaxEvents = [] }) {
  const maxOffsetS = useMemo(() => Math.max(...rows.map((r) => Number(r.time_offset_s) || 0)), [rows]);
  const durationMins = maxOffsetS / 60;

  const defaultWindow = durationMins > 10 ? 5 : "full";
  const [window, setWindow] = useState(defaultWindow);
  const [showBuild, setShowBuild] = useState(false);
  const [showRecovery, setShowRecovery] = useState(false);
  const [visibleLines, setVisibleLines] = useState({ hr: true, smoothed: true, baseline: true });
  const toggleLine = (key) => setVisibleLines((v) => ({ ...v, [key]: !v[key] }));
  const [markingPhase, setMarkingPhase] = useState(null); // null | 'pre_climax' | 'climax' | 'recovery'
  const [hoveredEventIdx, setHoveredEventIdx] = useState(null);
  const [localMarkers, setLocalMarkers] = useState({
    pre_climax: savedMarkers.pre_climax_offset_s ?? null,
    climax: savedMarkers.climax_offset_s ?? null,
    recovery: savedMarkers.recovery_offset_s ?? null,
  });

  const visibleRows = useMemo(() => {
    if (window === "full") return rows;
    const cutoff = maxOffsetS - window * 60;
    return rows.filter((r) => Number(r.time_offset_s) >= cutoff);
  }, [rows, window, maxOffsetS]);

  const visibleMin = useMemo(() => Math.min(...visibleRows.map(r => Number(r.time_offset_s))), [visibleRows]);
  const visibleMax = useMemo(() => Math.max(...visibleRows.map(r => Number(r.time_offset_s))), [visibleRows]);

  const { zoomDomain, resetZoom, isSelecting, selectRange, chartProps, wrapperProps } = useChartZoom(visibleMin, visibleMax);

  const displayRows = useMemo(() => {
    if (!zoomDomain) return visibleRows;
    return visibleRows.filter(r => {
      const t = Number(r.time_offset_s);
      return t >= zoomDomain.x1 && t <= zoomDomain.x2;
    });
  }, [visibleRows, zoomDomain]);

  const xDomain = zoomDomain ? [zoomDomain.x1, zoomDomain.x2] : ["dataMin", "dataMax"];

  if (!rows || rows.length === 0) return null;

  const hasSmoothed = rows.some((r) => r.hr_smoothed != null && r.hr_smoothed !== "");
  const hasBaseline = rows.some((r) => r.baseline_hr != null && r.baseline_hr !== "");

  // Build ref lines from data markers — only known types
  const KNOWN_DATA_MARKERS = new Set(["build", "climax", "recovery"]);
  const markerLines = [];
  const seen = new Set();
  visibleRows.forEach((r) => {
    if (!r.marker) return;
    if (!KNOWN_DATA_MARKERS.has(r.marker)) return; // skip unknown/gray markers
    if (r.marker === "build" && !showBuild) return;
    if (r.marker === "recovery" && !showRecovery) return;
    const key = `${r.marker}-${r.time_offset_s}`;
    if (!seen.has(key)) {
      seen.add(key);
      markerLines.push({ offset: r.time_offset_s, marker: r.marker });
    }
  });

  const calcHRMetrics = (markers) => {
    const extra = {};
    if (markers.pre_climax != null && markers.climax != null) {
      const lo = Math.min(markers.pre_climax, markers.climax);
      const hi = Math.max(markers.pre_climax, markers.climax);
      const segment = rows.filter((r) => Number(r.time_offset_s) >= lo && Number(r.time_offset_s) <= hi);
      if (segment.length > 0) {
        extra.hr_avg_pre_to_climax = Math.round(segment.reduce((a, r) => a + Number(r.hr), 0) / segment.length);
      }
    }
    if (markers.climax != null) {
      const window = rows.filter((r) => Math.abs(Number(r.time_offset_s) - markers.climax) <= 30);
      if (window.length > 0) {
        extra.hr_avg_at_climax_window = Math.round(window.reduce((a, r) => a + Number(r.hr), 0) / window.length);
      }
    }
    return extra;
  };

  const handleChartClick = (data) => {
    if (!markingPhase || !data?.activeLabel) return;
    const offset = Math.round(Number(data.activeLabel));
    const updated = { ...localMarkers, [markingPhase]: offset };
    setLocalMarkers(updated);

    // advance to next phase or end
    const idx = MARKING_PHASES.indexOf(markingPhase);
    setMarkingPhase(idx < MARKING_PHASES.length - 1 ? MARKING_PHASES[idx + 1] : null);

    if (onMarkersChange) {
      const extra = calcHRMetrics(updated);
      onMarkersChange({
        pre_climax_offset_s: updated.pre_climax,
        climax_offset_s: updated.climax,
        recovery_offset_s: updated.recovery,
        ...extra,
      });
    }
  };

  const autoDetectMarkers = () => {
    if (!rows || rows.length < 10) return;
    // Climax: peak HR in last 60% of session
    const startIdx = Math.floor(rows.length * 0.25);
    let peakIdx = startIdx;
    for (let i = startIdx; i < rows.length; i++) {
      if (Number(rows[i].hr) > Number(rows[peakIdx].hr)) peakIdx = i;
    }
    const climaxOffset = Number(rows[peakIdx].time_offset_s);
    // Pre-climax: lowest HR point within 5 min before climax (start of final ascent)
    const windowStart = climaxOffset - 300;
    const windowEnd = climaxOffset - 15;
    let valleyIdx = peakIdx;
    let foundInWindow = false;
    for (let i = 0; i < rows.length; i++) {
      const t = Number(rows[i].time_offset_s);
      if (t < windowStart) continue;
      if (t > windowEnd) break;
      if (!foundInWindow || Number(rows[i].hr) < Number(rows[valleyIdx].hr)) {
        valleyIdx = i;
        foundInWindow = true;
      }
    }
    const preClimaxOffset = Number(rows[valleyIdx].time_offset_s);
    // Recovery: skip ~15s after peak (avoids immediate noise), then find first point
    // where HR is falling for 4 consecutive samples and has dropped at least 2% from peak
    const peakHr = Number(rows[peakIdx].hr);
    const peakTime = Number(rows[peakIdx].time_offset_s);
    // Find the index just after the 15s skip window
    let searchStart = peakIdx + 1;
    for (let i = peakIdx + 1; i < rows.length; i++) {
      if (Number(rows[i].time_offset_s) >= peakTime + 15) { searchStart = i; break; }
    }
    let recoveryIdx = Math.min(searchStart, rows.length - 1);
    for (let i = searchStart; i <= rows.length - 4; i++) {
      const hr = Number(rows[i].hr);
      if (
        hr < Number(rows[i - 1].hr) &&
        Number(rows[i + 1].hr) < hr &&
        Number(rows[i + 2].hr) < Number(rows[i + 1].hr) &&
        Number(rows[i + 3].hr) < Number(rows[i + 2].hr) &&
        hr <= peakHr * 0.98
      ) {
        recoveryIdx = i;
        break;
      }
    }
    const recoveryOffset = Number(rows[recoveryIdx].time_offset_s);
    const updated = { pre_climax: preClimaxOffset, climax: climaxOffset, recovery: recoveryOffset };
    setLocalMarkers(updated);
    if (onMarkersChange) {
      const extra = calcHRMetrics(updated);
      onMarkersChange({
        pre_climax_offset_s: updated.pre_climax,
        climax_offset_s: updated.climax,
        recovery_offset_s: updated.recovery,
        ...extra,
      });
    }
  };

  const clearMarkers = () => {
    setLocalMarkers({ pre_climax: null, climax: null, recovery: null });
    setMarkingPhase(null);
    if (onMarkersChange) onMarkersChange({ pre_climax_offset_s: null, climax_offset_s: null, recovery_offset_s: null });
  };

  const preToClimax = deltaSec(localMarkers.pre_climax, localMarkers.climax);
  const climaxToRecovery = deltaSec(localMarkers.climax, localMarkers.recovery);

  return (
    <div>
      {/* Controls row */}
      <div className="flex gap-1 mb-2 flex-wrap items-center">
        {WINDOWS.map(({ label, value }) => (
          <Button
            key={label}
            size="sm"
            variant={window === value && !zoomDomain ? "default" : "outline"}
            className="h-6 text-[10px] px-2"
            onClick={() => { setWindow(value); resetZoom(); }}

          >
            {label}
          </Button>
        ))}
        <div className="w-px h-4 bg-border mx-1" />
        {zoomDomain ? (
          <Button
            size="sm"
            variant="outline"
            className="h-6 text-[10px] px-2 text-primary border-primary gap-1"
            onClick={resetZoom}
          >
            <ZoomOut className="w-3 h-3" /> Reset Zoom
          </Button>
        ) : (
          <span className="text-[10px] text-muted-foreground flex items-center gap-1">
            <ZoomIn className="w-3 h-3" /> Drag to zoom
          </span>
        )}
        <div className="w-px h-4 bg-border mx-1" />
        <Button
          size="sm"
          variant={showBuild ? "default" : "outline"}
          className="h-6 text-[10px] px-2"
          onClick={() => setShowBuild((b) => !b)}
        >
          Build {showBuild ? "ON" : "OFF"}
        </Button>
        <Button
          size="sm"
          variant={showRecovery ? "default" : "outline"}
          className="h-6 text-[10px] px-2"
          onClick={() => setShowRecovery((b) => !b)}
        >
          Recovery {showRecovery ? "ON" : "OFF"}
        </Button>
      </div>



      <div className={`h-64 cursor-crosshair`} {...wrapperProps}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={displayRows}
            margin={{ top: 8, right: 4, bottom: 0, left: -20 }}
            onClick={handleChartClick}
            {...chartProps}
          >
            <XAxis
              dataKey="time_offset_s"
              type="number"
              domain={xDomain}
              tick={{ fontSize: 9 }}
              tickFormatter={fmtSec}
            />
            <YAxis tick={{ fontSize: 9 }} domain={["auto", "auto"]} />
            <Tooltip
              formatter={(val, name) => {
                if (name === "hr") return [`${Math.round(val)} bpm`, "HR"];
                if (name === "hr_smoothed") return [`${Math.round(val)} bpm`, "Smoothed"];
                if (name === "baseline_hr") return [`${Math.round(val)} bpm`, "Baseline"];
                return [val, name];
              }}
              labelFormatter={(v) => `Time: ${fmtSec(Math.round(Number(v)))}`}
              contentStyle={{ fontSize: 11 }}
              labelStyle={{ color: '#111827', fontWeight: 600 }}
            />

            {/* Drag-to-zoom selection area */}
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

            {/* Near-climax event highlights */}
            {nearClimaxEvents.map((ev, i) => (
              <ReferenceArea
                key={`nce-${i}`}
                x1={ev.start_offset_s}
                x2={ev.end_offset_s}
                fill={hoveredEventIdx === i ? "hsl(var(--chart-3))" : "hsl(var(--chart-3))"}
                fillOpacity={hoveredEventIdx === i ? 0.25 : 0.08}
                stroke={hoveredEventIdx === i ? "hsl(var(--chart-3))" : "hsl(var(--chart-3))"}
                strokeOpacity={hoveredEventIdx === i ? 0.8 : 0.3}
                strokeWidth={hoveredEventIdx === i ? 2 : 1}
                onMouseEnter={() => setHoveredEventIdx(i)}
                onMouseLeave={() => setHoveredEventIdx(null)}
              />
            ))}

            {/* Legacy highlight range */}
            {highlightRange && (
              <ReferenceArea
                x1={highlightRange.start}
                x2={highlightRange.end}
                fill="hsl(var(--chart-3))"
                fillOpacity={0.15}
                stroke="hsl(var(--chart-3))"
                strokeOpacity={0.6}
                strokeWidth={1}
              />
            )}

            {/* Data-driven marker lines */}
            {markerLines.map((m, i) => (
              <ReferenceLine
                key={`data-${i}`}
                x={m.offset}
                stroke={MARKER_COLORS[m.marker] || "#9ca3af"}
                strokeDasharray="4 2"
                strokeWidth={1.5}
                label={{ value: m.marker, fontSize: 8, fill: MARKER_COLORS[m.marker] || "#9ca3af", position: "top" }}
              />
            ))}

            {/* Manual phase markers — only for climax sessions */}
            {!noClimax && MARKING_PHASES.map((phase) =>
              localMarkers[phase] != null ? (
                <ReferenceLine
                  key={`phase-${phase}`}
                  x={localMarkers[phase]}
                  stroke={PHASE_COLORS[phase]}
                  strokeWidth={2}
                  label={{ value: PHASE_LABELS[phase], fontSize: 8, fill: PHASE_COLORS[phase], position: "insideTopLeft" }}
                />
              ) : null
            )}

            {hasBaseline && visibleLines.baseline && (
              <Line type="monotone" dataKey="baseline_hr" stroke="#6b7280" strokeWidth={1} strokeDasharray="6 3" dot={false} />
            )}
            {hasSmoothed && visibleLines.smoothed && (
              <Line type="monotone" dataKey="hr_smoothed" stroke="hsl(var(--chart-2))" strokeWidth={1.5} dot={false} strokeDasharray="4 2" />
            )}
            {visibleLines.hr && (
              <Line type="monotone" dataKey="hr" stroke="hsl(var(--primary))" strokeWidth={2} dot={<MarkerDot />} activeDot={{ r: 4 }} isAnimationActive={false} />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>

      {/* Near-climax event tooltip */}
      {hoveredEventIdx != null && nearClimaxEvents[hoveredEventIdx] && (() => {
        const ev = nearClimaxEvents[hoveredEventIdx];
        return (
          <div className="mt-3 rounded-lg border border-border bg-muted/60 p-3 space-y-1.5">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-bold font-mono" style={{ color: "hsl(var(--chart-3))" }}>
                {ev.ai_label || `Event ${hoveredEventIdx + 1}`}
              </span>
              <span className="text-[9px] text-muted-foreground">{fmtSec(ev.start_offset_s)} – {fmtSec(ev.end_offset_s)}</span>
            </div>
            <div className="flex flex-wrap gap-3 text-sm">
              <div className="flex flex-col">
                <span className="text-[9px] text-muted-foreground">Base HR</span>
                <span className="font-mono font-bold">{ev.base_hr} bpm</span>
              </div>
              <div className="flex flex-col">
                <span className="text-[9px] text-muted-foreground">Peak HR</span>
                <span className="font-mono font-bold">{ev.peak_hr} bpm</span>
              </div>
              <div className="flex flex-col">
                <span className="text-[9px] text-muted-foreground">Rise</span>
                <span className="font-mono font-bold" style={{ color: "hsl(var(--chart-3))" }}>+{ev.rise_bpm} bpm</span>
              </div>
              <div className="flex flex-col">
                <span className="text-[9px] text-muted-foreground">Duration</span>
                <span className="font-mono font-bold">{fmtSec(ev.duration_s)}</span>
              </div>
            </div>
          </div>
        );
      })()}

      {/* Phase timing summary — only for climax sessions */}
      {!noClimax && (preToClimax != null || climaxToRecovery != null) && (
        <div className="flex gap-3 mt-2 flex-wrap">
          {preToClimax != null && (
            <div className="bg-muted rounded-lg px-3 py-1.5 text-center">
              <p className="text-[9px] text-muted-foreground uppercase">Pre-Climax → Climax</p>
              <p className="text-sm font-mono font-bold" style={{ color: PHASE_COLORS.climax }}>{fmtSec(preToClimax)}</p>
            </div>
          )}
          {climaxToRecovery != null && (
            <div className="bg-muted rounded-lg px-3 py-1.5 text-center">
              <p className="text-[9px] text-muted-foreground uppercase">Climax → Recovery</p>
              <p className="text-sm font-mono font-bold" style={{ color: PHASE_COLORS.recovery }}>{fmtSec(climaxToRecovery)}</p>
            </div>
          )}
        </div>
      )}

      {/* Phase marker controls — only shown when onMarkersChange is provided (form context) */}
      {onMarkersChange && !noClimax && (
        <div className="mt-3 space-y-2">
          <div className="flex flex-wrap gap-1.5 items-center">
            {MARKING_PHASES.map((phase) => (
              <button
                key={phase}
                onClick={() => setMarkingPhase(markingPhase === phase ? null : phase)}
                className="text-[10px] px-2.5 py-1 rounded-lg font-semibold border transition-colors"
                style={{
                  background: markingPhase === phase ? PHASE_COLORS[phase] : "transparent",
                  borderColor: PHASE_COLORS[phase],
                  color: markingPhase === phase ? "#fff" : PHASE_COLORS[phase],
                }}
              >
                {markingPhase === phase ? `Click chart → ${PHASE_LABELS[phase]}` : `Set ${PHASE_LABELS[phase]}`}
              </button>
            ))}
            <button
              onClick={autoDetectMarkers}
              className="text-[10px] px-2.5 py-1 rounded-lg font-semibold border border-border text-muted-foreground hover:text-foreground hover:border-foreground transition-colors"
            >
              Auto-Detect
            </button>
            {(localMarkers.pre_climax != null || localMarkers.climax != null || localMarkers.recovery != null) && (
              <button
                onClick={clearMarkers}
                className="text-[10px] px-2.5 py-1 rounded-lg font-semibold border border-destructive/50 text-destructive hover:bg-destructive/10 transition-colors"
              >
                Clear
              </button>
            )}
          </div>
          <div className="flex flex-col gap-1.5">
            {MARKING_PHASES.map((phase) => (
              <ManualTimeInput
                key={phase}
                phase={phase}
                color={PHASE_COLORS[phase]}
                label={PHASE_LABELS[phase]}
                currentOffset={localMarkers[phase]}
                maxOffset={maxOffsetS}
                onSet={(totalS) => {
                  const updated = { ...localMarkers, [phase]: totalS };
                  setLocalMarkers(updated);
                  const extra = calcHRMetrics(updated);
                  onMarkersChange({
                    pre_climax_offset_s: updated.pre_climax,
                    climax_offset_s: updated.climax,
                    recovery_offset_s: updated.recovery,
                    ...extra,
                  });
                }}
              />
            ))}
          </div>
        </div>
      )}

      {/* Legend */}
      <div className="flex flex-wrap gap-3 mt-1 px-1">
        <button
          onClick={() => toggleLine("hr")}
          className={`text-[10px] flex items-center gap-1 transition-opacity ${visibleLines.hr ? "" : "opacity-40"}`}
        >
          <span className="w-4 h-0.5 bg-primary inline-block" /> HR
        </button>
        {hasSmoothed && (
          <button
            onClick={() => toggleLine("smoothed")}
            className={`text-[10px] flex items-center gap-1 transition-opacity ${visibleLines.smoothed ? "" : "opacity-40"}`}
          >
            <span className="w-4 h-0.5 inline-block" style={{ borderTop: "2px dashed hsl(var(--chart-2))" }} /> Smoothed
          </button>
        )}
        {hasBaseline && (
          <button
            onClick={() => toggleLine("baseline")}
            className={`text-[10px] flex items-center gap-1 transition-opacity ${visibleLines.baseline ? "" : "opacity-40"}`}
          >
            <span className="w-4 h-0.5 inline-block" style={{ borderTop: "2px dashed #6b7280" }} /> Baseline
          </button>
        )}
        {showBuild && <span className="text-[10px] text-muted-foreground flex items-center gap-1"><span className="w-2 h-2 rounded-full inline-block" style={{ background: MARKER_COLORS.build }} />build</span>}
        {!noClimax && Object.entries(PHASE_COLORS).map(([k, v]) => (
          <span key={k} className="text-[10px] text-muted-foreground flex items-center gap-1">
            <span className="w-2 h-2 rounded-full inline-block" style={{ background: v }} />{PHASE_LABELS[k]}
          </span>
        ))}
      </div>
    </div>
  );
}