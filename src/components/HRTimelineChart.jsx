import { useEffect, useState, useMemo } from "react";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, ReferenceLine,
} from "recharts";
import { Button } from "@/components/ui/button";
import { ChevronDown, Layers, SlidersHorizontal, ZoomIn, ZoomOut } from "lucide-react";
import { useChartZoom } from "@/hooks/useChartZoom";
import { buildCleanChartRows, numberOrNull } from "@/lib/hrTimelineChartData";

const MARKER_COLORS = {
  build: "#f59e0b",
  climax: "#ef4444",
  recovery: "#3b82f6",
};

const PHASE_COLORS = {
  build: "#f59e0b",
  pre_climax: "#f59e0b",
  climax: "#f43f5e",
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

function ManualTimeInput({ color, label, currentOffset, maxOffset, onSet }) {
  const [min, setMin] = useState("");
  const [sec, setSec] = useState("");

  const handleSet = () => {
    const totalS = (parseInt(min) || 0) * 60 + (parseInt(sec) || 0);
    if (totalS >= 0 && totalS <= maxOffset) onSet(totalS);
  };

  return (
    <div className="rounded-lg bg-muted px-3 py-2 sm:flex sm:min-w-0 sm:flex-1 sm:items-center sm:gap-2">
      <div className="flex items-center justify-between gap-2 sm:w-36 sm:justify-start">
        <span className="text-xs font-semibold sm:w-20 sm:shrink-0" style={{ color }}>{label}</span>
        <span className="text-xs font-mono text-foreground font-semibold sm:w-12 sm:shrink-0">
          {currentOffset != null
            ? `${Math.floor(Math.round(currentOffset) / 60)}:${String(Math.round(currentOffset) % 60).padStart(2, "0")}`
            : "--:--"}
        </span>
      </div>
      <div className="mt-2 flex items-center gap-1.5 sm:mt-0 sm:flex-1">
        <input
          type="number" min={0}
          placeholder="min"
          aria-label={`${label} minutes`}
          value={min}
          onChange={(e) => setMin(e.target.value)}
          className="min-w-0 flex-1 text-xs bg-background border border-border rounded px-2 py-1 font-mono text-center sm:w-14 sm:flex-none"
        />
        <span className="text-xs text-muted-foreground">:</span>
        <input
          type="number" min={0} max={59}
          placeholder="sec"
          aria-label={`${label} seconds`}
          value={sec}
          onChange={(e) => setSec(e.target.value)}
          className="min-w-0 flex-1 text-xs bg-background border border-border rounded px-2 py-1 font-mono text-center sm:w-14 sm:flex-none"
        />
        <button
          type="button"
          onClick={handleSet}
          className="ml-auto text-xs px-3 py-1 rounded font-semibold text-white shrink-0"
          style={{ background: color }}
        >Set</button>
      </div>
    </div>
  );
}

const WINDOWS = [
  { label: "Full", value: "full" },
  { label: "Climax", value: "climax" },
  { label: "Recovery", value: "recovery" },
  { label: "Last 5m", value: 5 },
  { label: "Last 3m", value: 3 },
  { label: "Last 2m", value: 2 },
];

const MARKING_PHASES = ["pre_climax", "climax", "recovery"];
const PHASE_LABELS = { pre_climax: "Pre-Climax", climax: "Climax", recovery: "Recovery" };

export default function HRTimelineChart({
  rows,
  savedMarkers = {},
  onMarkersChange,
  highlightRange = null,
  noClimax = false,
  nearClimaxEvents = [],
  initialWindow,
  compact = false,
  playbackTime,
  inspectionTime,
  onInspectionTimeChange,
}) {
  const maxOffsetS = useMemo(() => Math.max(...rows.map((r) => Number(r.time_offset_s) || 0)), [rows]);
  const durationMins = maxOffsetS / 60;

  const requestedDefaultWindow = initialWindow ?? (durationMins > 10 ? 5 : "full");
  const defaultWindow = noClimax && (requestedDefaultWindow === "climax" || requestedDefaultWindow === "recovery")
    ? "full"
    : requestedDefaultWindow;
  const chartRows = useMemo(() => buildCleanChartRows(rows), [rows]);
  const [window, setWindow] = useState(defaultWindow);
  const [showBuild, setShowBuild] = useState(false);
  const [showRecovery, setShowRecovery] = useState(false);
  const [showPhases, setShowPhases] = useState(false);
  const [showNearClimax, setShowNearClimax] = useState(false);
  const [showHrvOverlay, setShowHrvOverlay] = useState(false);
  const [visibleLines, setVisibleLines] = useState({ hr: true, smoothed: true, baseline: true });
  const [showHrvGraph, setShowHrvGraph] = useState(true);
  const [visibleHrvLines, setVisibleHrvLines] = useState({ rmssd: true, sdnn: true, pnn50: false });
  const toggleLine = (key) => setVisibleLines((v) => ({ ...v, [key]: !v[key] }));
  const toggleHrvLine = (key) => setVisibleHrvLines((v) => ({ ...v, [key]: !v[key] }));
  const [markingPhase, setMarkingPhase] = useState(null); // null | 'pre_climax' | 'climax' | 'recovery'
  const [showPhaseMarkerTools, setShowPhaseMarkerTools] = useState(false);
  const [hoveredEventIdx, setHoveredEventIdx] = useState(null);
  const [localMarkers, setLocalMarkers] = useState({
    pre_climax: savedMarkers.pre_climax_offset_s ?? null,
    climax: savedMarkers.climax_offset_s ?? null,
    recovery: savedMarkers.recovery_offset_s ?? null,
  });
  const windowOptions = useMemo(
    () => noClimax ? WINDOWS.filter(({ value }) => value !== "climax" && value !== "recovery") : WINDOWS,
    [noClimax]
  );

  useEffect(() => {
    setLocalMarkers({
      pre_climax: savedMarkers.pre_climax_offset_s ?? null,
      climax: savedMarkers.climax_offset_s ?? null,
      recovery: savedMarkers.recovery_offset_s ?? null,
    });
  }, [savedMarkers.pre_climax_offset_s, savedMarkers.climax_offset_s, savedMarkers.recovery_offset_s]);

  const visibleRows = useMemo(() => {
    let nextRows = chartRows;
    if (window === "full") return chartRows;
    if (window === "climax" && localMarkers.climax != null) {
      const start = Math.max(0, Number(localMarkers.climax) - 180);
      const end = Math.min(maxOffsetS, Number(localMarkers.climax) + 180);
      nextRows = chartRows.filter((r) => Number(r.time_offset_s) >= start && Number(r.time_offset_s) <= end);
      return nextRows.length ? nextRows : chartRows;
    }
    if (window === "recovery" && localMarkers.climax != null) {
      const start = Math.max(0, Number(localMarkers.climax) - 30);
      const end = Math.min(maxOffsetS, Number(localMarkers.recovery ?? localMarkers.climax + 300) + 180);
      nextRows = chartRows.filter((r) => Number(r.time_offset_s) >= start && Number(r.time_offset_s) <= end);
      return nextRows.length ? nextRows : chartRows;
    }
    const cutoff = maxOffsetS - window * 60;
    nextRows = chartRows.filter((r) => Number(r.time_offset_s) >= cutoff);
    return nextRows.length ? nextRows : chartRows;
  }, [chartRows, window, maxOffsetS, localMarkers.climax, localMarkers.recovery]);

  const visibleMin = useMemo(() => Math.min(...visibleRows.map(r => Number(r.time_offset_s))), [visibleRows]);
  const visibleMax = useMemo(() => Math.max(...visibleRows.map(r => Number(r.time_offset_s))), [visibleRows]);

  const { zoomDomain, resetZoom, isSelecting, selectRange, chartProps, wrapperProps } = useChartZoom(visibleMin, visibleMax);

  useEffect(() => {
    if (noClimax && (window === "climax" || window === "recovery")) {
      setWindow(defaultWindow === "climax" || defaultWindow === "recovery" ? "full" : defaultWindow);
      resetZoom();
    }
  }, [defaultWindow, noClimax, resetZoom, window]);

  const displayRows = useMemo(() => {
    if (!zoomDomain) return visibleRows;
    return visibleRows.filter(r => {
      const t = Number(r.time_offset_s);
      return t >= zoomDomain.x1 && t <= zoomDomain.x2;
    });
  }, [visibleRows, zoomDomain]);

  const xDomain = zoomDomain ? [zoomDomain.x1, zoomDomain.x2] : ["dataMin", "dataMax"];

  const hasSmoothed = chartRows.some((r) => r.hr_smoothed != null && r.hr_smoothed !== "");
  const hasBaseline = chartRows.some((r) => r.baseline_hr != null && r.baseline_hr !== "");
  const hasHrv = chartRows.some((r) => numberOrNull(r.hrv_rmssd_ms) != null || numberOrNull(r.hrv_sdnn_ms) != null || numberOrNull(r.hrv_pnn50) != null);
  const hasRmssd = chartRows.some((r) => numberOrNull(r.hrv_rmssd_ms) != null);
  const hasSdnn = chartRows.some((r) => numberOrNull(r.hrv_sdnn_ms) != null);
  const hasPnn50 = chartRows.some((r) => numberOrNull(r.hrv_pnn50) != null);

  const hrvDisplayRows = useMemo(() => (
    displayRows
      .map((row) => ({
        time_offset_s: numberOrNull(row.time_offset_s),
        hrv_rmssd_ms: numberOrNull(row.hrv_rmssd_ms),
        hrv_sdnn_ms: numberOrNull(row.hrv_sdnn_ms),
        hrv_pnn50: numberOrNull(row.hrv_pnn50),
        hrv_quality: row.hrv_quality,
      }))
      .filter((row) => (
        row.time_offset_s != null
        && (row.hrv_rmssd_ms != null || row.hrv_sdnn_ms != null || row.hrv_pnn50 != null)
      ))
  ), [displayRows]);

  // Build ref lines from data markers — only known types
  const KNOWN_DATA_MARKERS = new Set(["build", "climax", "recovery"]);
  const markerLines = [];
  const seen = new Set();
  visibleRows.forEach((r) => {
    if (noClimax) return;
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

  const phaseBands = useMemo(() => {
    if (noClimax) return [];
    const pre = localMarkers.pre_climax;
    const climax = localMarkers.climax;
    const recovery = localMarkers.recovery;
    return [
      pre != null && { key: "build", label: "Build", x1: 0, x2: pre, color: PHASE_COLORS.build, opacity: 0.05 },
      pre != null && climax != null && { key: "pre_climax", label: "Pre-Climax", x1: pre, x2: climax, color: PHASE_COLORS.pre_climax, opacity: 0.08 },
      climax != null && { key: "climax", label: "Climax", x1: Math.max(0, climax - 20), x2: climax + 40, color: PHASE_COLORS.climax, opacity: 0.1 },
      climax != null && recovery != null && { key: "recovery", label: "Recovery", x1: climax, x2: recovery, color: PHASE_COLORS.recovery, opacity: 0.06 },
    ].filter(Boolean).filter((band) => band.x2 > band.x1);
  }, [localMarkers, noClimax]);

  const nearClimaxEventsInView = useMemo(() => {
    if (!showNearClimax || noClimax) return [];
    const [min, max] = zoomDomain ? [zoomDomain.x1, zoomDomain.x2] : [visibleMin, visibleMax];
    return nearClimaxEvents
      .filter((event) => {
        const start = Number(event?.start_offset_s);
        const end = Number(event?.end_offset_s);
        if (!Number.isFinite(start) && !Number.isFinite(end)) return false;
        const safeStart = Number.isFinite(start) ? start : end;
        const safeEnd = Number.isFinite(end) ? end : start;
        return safeEnd >= min && safeStart <= max;
      })
      .slice(0, 24);
  }, [nearClimaxEvents, noClimax, showNearClimax, visibleMax, visibleMin, zoomDomain]);

  const hrChangeBands = useMemo(() => {
    if (!noClimax || !rows || rows.length < 8) return [];
    const points = rows
      .map((row) => ({
        t: Number(row.time_offset_s),
        hr: Number(row.hr_smoothed ?? row.hr),
      }))
      .filter((point) => Number.isFinite(point.t) && Number.isFinite(point.hr))
      .sort((a, b) => a.t - b.t);

    if (points.length < 8) return [];

    const lookbackS = 45;
    const thresholdBpm = 5;
    const rawBands = [];
    let anchor = 0;

    for (let i = 1; i < points.length; i += 1) {
      while (anchor < i - 1 && points[i].t - points[anchor + 1].t >= lookbackS) {
        anchor += 1;
      }
      if (points[i].t - points[anchor].t < Math.min(20, lookbackS)) continue;

      const delta = points[i].hr - points[anchor].hr;
      if (Math.abs(delta) < thresholdBpm) continue;

      rawBands.push({
        type: delta > 0 ? "rise" : "drop",
        x1: points[anchor].t,
        x2: points[i].t,
        delta,
      });
    }

    return rawBands.reduce((bands, band) => {
      const previous = bands[bands.length - 1];
      if (previous && previous.type === band.type && band.x1 - previous.x2 <= 20) {
        previous.x2 = Math.max(previous.x2, band.x2);
        previous.delta = Math.abs(band.delta) > Math.abs(previous.delta) ? band.delta : previous.delta;
        return bands;
      }
      bands.push({ ...band });
      return bands;
    }, []);
  }, [noClimax, rows]);

  const handleInspectMove = (data) => {
    chartProps.onMouseMove?.(data);
    if (!isSelecting && Number.isFinite(Number(data?.activeLabel))) {
      onInspectionTimeChange?.(Number(data.activeLabel));
    }
  };

  const handleChartInteraction = (data) => {
    handleChartClick(data);
    if (!markingPhase && Number.isFinite(Number(data?.activeLabel))) {
      onInspectionTimeChange?.(Number(data.activeLabel));
    }
  };

  if (!chartRows.length) return null;

  return (
    <div>
      {/* Controls row */}
      <div className="flex gap-1 mb-2 flex-wrap items-center">
        {windowOptions.map(({ label, value }) => (
          <Button
            key={label}
            size="sm"
            variant={window === value && !zoomDomain ? "default" : "outline"}
            className="h-6 text-[10px] px-2"
            disabled={(value === "climax" || value === "recovery") && localMarkers.climax == null}
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
        <span className="text-[10px] text-muted-foreground flex items-center gap-1"><Layers className="w-3 h-3" /> Layers</span>
        {(noClimax
          ? [
            ["HR shifts", showNearClimax, setShowNearClimax],
          ]
          : [
            ["Phases", showPhases, setShowPhases],
            ["Surges", showNearClimax, setShowNearClimax],
            ["Build", showBuild, setShowBuild],
            ["Recovery", showRecovery, setShowRecovery],
          ]
        ).concat(hasHrv ? [["HRV", showHrvOverlay, setShowHrvOverlay]] : []).map(([label, active, setter]) => (
          <Button
            key={label}
            size="sm"
            variant={active ? "default" : "outline"}
            className="h-6 text-[10px] px-2"
            onClick={() => setter((value) => !value)}
          >
            {label}
          </Button>
        ))}
      </div>



      <div className={`${compact ? "h-40" : "h-64"} cursor-crosshair`} {...wrapperProps}>
        <ResponsiveContainer width="100%" height="100%">
          <LineChart
            data={displayRows}
            margin={{ top: 8, right: showHrvOverlay ? 0 : 4, bottom: 0, left: -20 }}
            {...chartProps}
            onMouseMove={handleInspectMove}
            onClick={handleChartInteraction}
          >
            <XAxis
              dataKey="time_offset_s"
              type="number"
              domain={xDomain}
              tick={{ fontSize: 9 }}
              tickFormatter={fmtSec}
            />
            <YAxis yAxisId={0} tick={{ fontSize: 9 }} domain={["auto", "auto"]} />
            {showHrvOverlay && hasHrv && (
              <YAxis
                yAxisId="hrv"
                orientation="right"
                tick={{ fontSize: 8, fill: "#0f766e" }}
                tickFormatter={(value) => `${Math.round(value)}`}
                domain={["auto", "auto"]}
                width={28}
              />
            )}
            <Tooltip
              formatter={(val, name) => {
                if (name === "hr") return [`${Math.round(val)} bpm`, "HR"];
                if (name === "hr_smoothed") return [`${Math.round(val)} bpm`, "Smoothed"];
                if (name === "baseline_hr") return [`${Math.round(val)} bpm`, "Baseline"];
                if (name === "hrv_rmssd_ms") return [`${Math.round(val)} ms`, "RMSSD"];
                if (name === "hrv_sdnn_ms") return [`${Math.round(val)} ms`, "SDNN"];
                if (name === "hrv_pnn50") return [`${Math.round(val)}%`, "pNN50"];
                return [val, name];
              }}
              labelFormatter={(v) => `Time: ${fmtSec(Math.round(Number(v)))}`}
              contentStyle={{ fontSize: 11 }}
              labelStyle={{ color: '#111827', fontWeight: 600 }}
            />

            {/* Drag-to-zoom selection area */}
            {isSelecting && selectRange && (
              <>
                <ReferenceLine
                  x={selectRange.x1}
                  stroke="hsl(var(--primary))"
                  strokeOpacity={0.45}
                  strokeDasharray="3 3"
                  strokeWidth={1}
                />
                <ReferenceLine
                  x={selectRange.x2}
                  stroke="hsl(var(--primary))"
                  strokeOpacity={0.6}
                  strokeDasharray="3 3"
                  strokeWidth={1.25}
                />
              </>
            )}

            {/* Exploration HR shifts as boundary lines only */}
            {noClimax && showNearClimax && hrChangeBands.flatMap((band, index) => {
              const color = band.type === "rise" ? "#f59e0b" : "#14b8a6";
              return ([
                <ReferenceLine
                  key={`hr-shift-start-${index}`}
                  x={band.x1}
                  stroke={color}
                  strokeOpacity={0.28}
                  strokeDasharray="2 4"
                  strokeWidth={1}
                />,
                <ReferenceLine
                  key={`hr-shift-end-${index}`}
                  x={band.x2}
                  stroke={color}
                  strokeOpacity={0.5}
                  strokeDasharray="2 4"
                  strokeWidth={1.25}
                />,
              ]);
            })}

            {/* Near-climax event boundaries only */}
            {nearClimaxEventsInView.flatMap((ev, i) => {
              const active = hoveredEventIdx === i;
              const color = "hsl(var(--chart-3))";
              return ([
                <ReferenceLine
                  key={`nce-start-${i}`}
                  x={ev.start_offset_s}
                  stroke={color}
                  strokeOpacity={active ? 0.85 : 0.3}
                  strokeDasharray="3 3"
                  strokeWidth={active ? 1.8 : 1}
                  onMouseEnter={() => setHoveredEventIdx(i)}
                  onMouseLeave={() => setHoveredEventIdx(null)}
                />,
                <ReferenceLine
                  key={`nce-end-${i}`}
                  x={ev.end_offset_s}
                  stroke={color}
                  strokeOpacity={active ? 0.85 : 0.3}
                  strokeDasharray="3 3"
                  strokeWidth={active ? 1.8 : 1}
                  onMouseEnter={() => setHoveredEventIdx(i)}
                  onMouseLeave={() => setHoveredEventIdx(null)}
                />,
              ]);
            })}

            {/* Legacy highlight range */}
            {highlightRange && (
              <>
                <ReferenceLine
                  x={highlightRange.start}
                  stroke="hsl(var(--chart-3))"
                  strokeOpacity={0.75}
                  strokeDasharray="4 2"
                  strokeWidth={1.25}
                />
                <ReferenceLine
                  x={highlightRange.end}
                  stroke="hsl(var(--chart-3))"
                  strokeOpacity={0.75}
                  strokeDasharray="4 2"
                  strokeWidth={1.25}
                />
              </>
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

            {Number.isFinite(Number(playbackTime))
              && Number(playbackTime) >= visibleMin
              && Number(playbackTime) <= visibleMax && (
              <ReferenceLine
                x={Number(playbackTime)}
                stroke="#f43f5e"
                strokeWidth={2}
                strokeOpacity={0.9}
              />
            )}

            {Number.isFinite(Number(inspectionTime))
              && Number(inspectionTime) >= visibleMin
              && Number(inspectionTime) <= visibleMax
              && Number(inspectionTime) !== Number(playbackTime) && (
              <ReferenceLine
                x={Number(inspectionTime)}
                stroke="#f43f5e"
                strokeWidth={1.5}
                strokeDasharray="3 2"
                strokeOpacity={0.9}
              />
            )}

            {hasBaseline && visibleLines.baseline && (
              <Line yAxisId={0} type="monotone" dataKey="baseline_hr" stroke="#6b7280" strokeWidth={1} strokeDasharray="6 3" dot={false} />
            )}
            {hasSmoothed && visibleLines.smoothed && (
              <Line yAxisId={0} type="monotone" dataKey="hr_smoothed" stroke="hsl(var(--chart-2))" strokeWidth={1.5} dot={false} strokeDasharray="4 2" />
            )}
            {visibleLines.hr && (
              <Line yAxisId={0} type="monotone" dataKey="hr" stroke="hsl(var(--primary))" strokeWidth={2} dot={<MarkerDot />} activeDot={{ r: 4 }} isAnimationActive={false} />
            )}
            {showHrvOverlay && hasRmssd && visibleHrvLines.rmssd && (
              <Line yAxisId="hrv" type="monotone" dataKey="hrv_rmssd_ms" stroke="#14b8a6" strokeWidth={1.8} dot={false} activeDot={{ r: 3 }} connectNulls isAnimationActive={false} />
            )}
            {showHrvOverlay && hasSdnn && visibleHrvLines.sdnn && (
              <Line yAxisId="hrv" type="monotone" dataKey="hrv_sdnn_ms" stroke="#a855f7" strokeWidth={1.6} dot={false} activeDot={{ r: 3 }} connectNulls isAnimationActive={false} />
            )}
            {showHrvOverlay && hasPnn50 && visibleHrvLines.pnn50 && (
              <Line yAxisId="hrv" type="monotone" dataKey="hrv_pnn50" stroke="#f59e0b" strokeWidth={1.4} dot={false} activeDot={{ r: 3 }} strokeDasharray="4 2" connectNulls isAnimationActive={false} />
            )}
          </LineChart>
        </ResponsiveContainer>
      </div>

      {hasHrv && (
        <div className="mt-3 rounded-lg border border-border bg-muted/15 p-3">
          <div className="mb-2 flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-primary">RR-Derived HRV</p>
              <p className="mt-0.5 text-[10px] leading-relaxed text-muted-foreground">
                RMSSD shows fast beat-to-beat flexibility; SDNN shows broader rolling variability. Spikes often mark breath-release, settling, artifact, or a real autonomic shift worth checking against the video.
              </p>
            </div>
            <Button
              type="button"
              size="sm"
              variant={showHrvGraph ? "default" : "outline"}
              className="h-6 text-[10px] px-2"
              onClick={() => setShowHrvGraph((value) => !value)}
            >
              HRV
            </Button>
          </div>

          {showHrvGraph && (
            <>
              <div className={`${compact ? "h-32" : "h-44"}`}>
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart
                    data={hrvDisplayRows}
                    margin={{ top: 8, right: 4, bottom: 0, left: -20 }}
                    onMouseMove={handleInspectMove}
                    onClick={(data) => {
                      if (Number.isFinite(Number(data?.activeLabel))) {
                        onInspectionTimeChange?.(Number(data.activeLabel));
                      }
                    }}
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
                        if (name === "hrv_rmssd_ms") return [`${Math.round(val)} ms`, "RMSSD"];
                        if (name === "hrv_sdnn_ms") return [`${Math.round(val)} ms`, "SDNN"];
                        if (name === "hrv_pnn50") return [`${Math.round(val)}%`, "pNN50"];
                        return [val, name];
                      }}
                      labelFormatter={(v) => `Time: ${fmtSec(Math.round(Number(v)))}`}
                      contentStyle={{ fontSize: 11 }}
                      labelStyle={{ color: '#111827', fontWeight: 600 }}
                    />

                    {isSelecting && selectRange && (
                      <>
                        <ReferenceLine
                          x={selectRange.x1}
                          stroke="hsl(var(--primary))"
                          strokeOpacity={0.45}
                          strokeDasharray="3 3"
                          strokeWidth={1}
                        />
                        <ReferenceLine
                          x={selectRange.x2}
                          stroke="hsl(var(--primary))"
                          strokeOpacity={0.6}
                          strokeDasharray="3 3"
                          strokeWidth={1.25}
                        />
                      </>
                    )}

                    {!noClimax && MARKING_PHASES.map((phase) =>
                      localMarkers[phase] != null ? (
                        <ReferenceLine
                          key={`hrv-phase-${phase}`}
                          x={localMarkers[phase]}
                          stroke={PHASE_COLORS[phase]}
                          strokeWidth={1.5}
                          strokeDasharray="4 2"
                          label={{ value: PHASE_LABELS[phase], fontSize: 8, fill: PHASE_COLORS[phase], position: "insideTopLeft" }}
                        />
                      ) : null
                    )}

                    {Number.isFinite(Number(playbackTime))
                      && Number(playbackTime) >= visibleMin
                      && Number(playbackTime) <= visibleMax && (
                      <ReferenceLine
                        x={Number(playbackTime)}
                        stroke="#f43f5e"
                        strokeWidth={2}
                        strokeOpacity={0.9}
                      />
                    )}

                    {Number.isFinite(Number(inspectionTime))
                      && Number(inspectionTime) >= visibleMin
                      && Number(inspectionTime) <= visibleMax
                      && Number(inspectionTime) !== Number(playbackTime) && (
                      <ReferenceLine
                        x={Number(inspectionTime)}
                        stroke="#f43f5e"
                        strokeWidth={1.5}
                        strokeDasharray="3 2"
                        strokeOpacity={0.9}
                      />
                    )}

                    {hasRmssd && visibleHrvLines.rmssd && (
                      <Line type="monotone" dataKey="hrv_rmssd_ms" stroke="#14b8a6" strokeWidth={2} dot={false} activeDot={{ r: 3 }} connectNulls isAnimationActive={false} />
                    )}
                    {hasSdnn && visibleHrvLines.sdnn && (
                      <Line type="monotone" dataKey="hrv_sdnn_ms" stroke="#a855f7" strokeWidth={1.8} dot={false} activeDot={{ r: 3 }} connectNulls isAnimationActive={false} />
                    )}
                    {hasPnn50 && visibleHrvLines.pnn50 && (
                      <Line type="monotone" dataKey="hrv_pnn50" stroke="#f59e0b" strokeWidth={1.4} dot={false} activeDot={{ r: 3 }} strokeDasharray="4 2" connectNulls isAnimationActive={false} />
                    )}
                  </LineChart>
                </ResponsiveContainer>
              </div>

              <div className="mt-2 flex flex-wrap gap-3 px-1">
                {hasRmssd && (
                  <button
                    type="button"
                    onClick={() => toggleHrvLine("rmssd")}
                    className={`text-[10px] flex items-center gap-1 transition-opacity ${visibleHrvLines.rmssd ? "" : "opacity-40"}`}
                  >
                    <span className="w-4 h-0.5 inline-block" style={{ borderTop: "2px solid #14b8a6" }} /> RMSSD
                  </button>
                )}
                {hasSdnn && (
                  <button
                    type="button"
                    onClick={() => toggleHrvLine("sdnn")}
                    className={`text-[10px] flex items-center gap-1 transition-opacity ${visibleHrvLines.sdnn ? "" : "opacity-40"}`}
                  >
                    <span className="w-4 h-0.5 inline-block" style={{ borderTop: "2px solid #a855f7" }} /> SDNN
                  </button>
                )}
                {hasPnn50 && (
                  <button
                    type="button"
                    onClick={() => toggleHrvLine("pnn50")}
                    className={`text-[10px] flex items-center gap-1 transition-opacity ${visibleHrvLines.pnn50 ? "" : "opacity-40"}`}
                  >
                    <span className="w-4 h-0.5 inline-block" style={{ borderTop: "2px dashed #f59e0b" }} /> pNN50
                  </button>
                )}
                <span className="text-[10px] text-muted-foreground">
                  {hrvDisplayRows.length} HRV points in view
                </span>
              </div>
            </>
          )}
        </div>
      )}

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
        <div className="mt-3 rounded-lg border border-border bg-muted/10">
          <button
            type="button"
            onClick={() => setShowPhaseMarkerTools((open) => !open)}
            className="flex w-full items-center gap-2 px-3 py-2 text-left"
            aria-expanded={showPhaseMarkerTools}
          >
            <SlidersHorizontal className="h-3.5 w-3.5 text-muted-foreground" />
            <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Phase marker tools</span>
            <span className="ml-auto hidden text-[10px] text-muted-foreground sm:inline">
              {localMarkers.climax != null ? `Climax ${fmtSec(localMarkers.climax)}` : "Set or auto-detect markers"}
            </span>
            <ChevronDown className={`h-3.5 w-3.5 text-muted-foreground transition-transform ${showPhaseMarkerTools ? "rotate-180" : ""}`} />
          </button>
          {showPhaseMarkerTools && (
            <div className="space-y-2 border-t border-border px-3 pb-3 pt-2">
              <div className="grid grid-cols-2 gap-1.5 sm:flex sm:flex-wrap sm:items-center">
                {MARKING_PHASES.map((phase) => (
                  <button
                    type="button"
                    key={phase}
                    onClick={() => setMarkingPhase(markingPhase === phase ? null : phase)}
                    className="min-h-8 rounded-lg border px-2 py-1 text-[10px] font-semibold transition-colors"
                    style={{
                      background: markingPhase === phase ? PHASE_COLORS[phase] : "transparent",
                      borderColor: PHASE_COLORS[phase],
                      color: markingPhase === phase ? "#fff" : PHASE_COLORS[phase],
                    }}
                  >
                    {markingPhase === phase ? `Click chart - ${PHASE_LABELS[phase]}` : `Set ${PHASE_LABELS[phase]}`}
                  </button>
                ))}
                <button
                  type="button"
                  onClick={autoDetectMarkers}
                  className="min-h-8 rounded-lg border border-border px-2 py-1 text-[10px] font-semibold text-muted-foreground transition-colors hover:border-foreground hover:text-foreground"
                >
                  Auto-Detect
                </button>
                {(localMarkers.pre_climax != null || localMarkers.climax != null || localMarkers.recovery != null) && (
                  <button
                    type="button"
                    onClick={clearMarkers}
                    className="col-span-2 min-h-8 rounded-lg border border-destructive/50 px-2 py-1 text-[10px] font-semibold text-destructive transition-colors hover:bg-destructive/10 sm:col-span-1"
                  >
                    Clear Markers
                  </button>
                )}
              </div>
              <div className="flex flex-col gap-1.5">
                {MARKING_PHASES.map((phase) => (
                  <ManualTimeInput
                    key={phase}
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
        {showHrvOverlay && hasRmssd && (
          <button
            onClick={() => toggleHrvLine("rmssd")}
            className={`text-[10px] flex items-center gap-1 transition-opacity ${visibleHrvLines.rmssd ? "" : "opacity-40"}`}
          >
            <span className="w-4 h-0.5 inline-block" style={{ borderTop: "2px solid #14b8a6" }} /> RMSSD
          </button>
        )}
        {showHrvOverlay && hasSdnn && (
          <button
            onClick={() => toggleHrvLine("sdnn")}
            className={`text-[10px] flex items-center gap-1 transition-opacity ${visibleHrvLines.sdnn ? "" : "opacity-40"}`}
          >
            <span className="w-4 h-0.5 inline-block" style={{ borderTop: "2px solid #a855f7" }} /> SDNN
          </button>
        )}
        {showHrvOverlay && hasPnn50 && (
          <button
            onClick={() => toggleHrvLine("pnn50")}
            className={`text-[10px] flex items-center gap-1 transition-opacity ${visibleHrvLines.pnn50 ? "" : "opacity-40"}`}
          >
            <span className="w-4 h-0.5 inline-block" style={{ borderTop: "2px dashed #f59e0b" }} /> pNN50
          </button>
        )}
        {noClimax && showNearClimax && hrChangeBands.length > 0 && (
          <span className="text-[10px] text-muted-foreground flex items-center gap-1">
            <span className="w-2 h-2 rounded-full inline-block bg-amber-400" />{hrChangeBands.length} HR shift bands
          </span>
        )}
        {showPhases && phaseBands.map((band) => (
          <span key={band.key} className="text-[10px] text-muted-foreground flex items-center gap-1">
            <span className="w-2 h-2 rounded-full inline-block" style={{ background: band.color }} />{band.label}
          </span>
        ))}
        {showBuild && <span className="text-[10px] text-muted-foreground flex items-center gap-1"><span className="w-2 h-2 rounded-full inline-block" style={{ background: MARKER_COLORS.build }} />build</span>}
        {!noClimax && MARKING_PHASES.map((k) => (
          <span key={k} className="text-[10px] text-muted-foreground flex items-center gap-1">
            <span className="w-2 h-2 rounded-full inline-block" style={{ background: PHASE_COLORS[k] }} />{PHASE_LABELS[k]}
          </span>
        ))}
      </div>
    </div>
  );
}
