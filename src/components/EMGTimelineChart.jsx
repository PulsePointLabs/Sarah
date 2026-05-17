import { useState, useMemo } from "react";
import {
  ResponsiveContainer, ComposedChart, Line, XAxis, YAxis,
  Tooltip, CartesianGrid, ReferenceLine,
} from "recharts";

function fmtMmSs(s) {
  const totalS = Math.round(Number(s));
  const m = Math.floor(totalS / 60);
  const sec = totalS % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

const EMG_COLORS = {
  left: "#3b82f6",
  right: "#f97316",
  diff: "#a855f7",
  single: "#10b981",
};

const MARKER_COLORS = {
  pre_climax: "#a855f7",
  climax: "#ef4444",
  recovery: "#3b82f6",
};

export default function EMGTimelineChart({
  rows = [],
  channelMode = "single",
  events = [],
  savedMarkers = {},
  onMarkersChange,
  timelineRows = [], // HR data
}) {
  const [showLeft, setShowLeft] = useState(true);
  const [showRight, setShowRight] = useState(true);
  const [showDiff, setShowDiff] = useState(false);
  const [showEvents, setShowEvents] = useState(true);
  const [showHR, setShowHR] = useState(true);
  const [viewMode, setViewMode] = useState("pct"); // "pct" | "raw"

  // Build a sorted HR lookup for interpolation
  const hrSorted = useMemo(() =>
    [...timelineRows]
      .map((r) => ({ t: Number(r.time_offset_s), hr: Number(r.hr) }))
      .filter((r) => !isNaN(r.t) && !isNaN(r.hr))
      .sort((a, b) => a.t - b.t),
    [timelineRows]
  );

  // Linear interpolate HR at a given time_s
  const interpolateHR = (t) => {
    if (!hrSorted.length) return null;
    if (t <= hrSorted[0].t) return hrSorted[0].hr;
    if (t >= hrSorted[hrSorted.length - 1].t) return hrSorted[hrSorted.length - 1].hr;
    let lo = 0, hi = hrSorted.length - 1;
    while (lo + 1 < hi) {
      const mid = (lo + hi) >> 1;
      if (hrSorted[mid].t <= t) lo = mid; else hi = mid;
    }
    const a = hrSorted[lo], b = hrSorted[hi];
    const frac = (t - a.t) / (b.t - a.t);
    return Math.round(a.hr + frac * (b.hr - a.hr));
  };

  // Downsample to at most 2000 points for performance
  const chartData = useMemo(() => {
    if (!rows.length) return [];
    const step = Math.max(1, Math.floor(rows.length / 2000));
    return rows
      .filter((_, i) => i % step === 0)
      .map((r) => {
        const t = Number(r.time_s);
        return {
          t,
          left: channelMode === "dual"
            ? (viewMode === "pct" ? r.left_pct : r.left_env) ?? null
            : null,
          right: channelMode === "dual"
            ? (viewMode === "pct" ? r.right_pct : r.right_env) ?? null
            : null,
          diff: channelMode === "dual" ? r.diff_pct ?? null : null,
          single: channelMode === "single"
            ? (viewMode === "pct" ? r.level_pct : (r.env_smooth ?? r.raw_env)) ?? null
            : null,
          hr: hrSorted.length ? interpolateHR(t) : null,
        };
      });
  }, [rows, channelMode, viewMode, hrSorted]);

  const phaseMarkers = [
    savedMarkers.pre_climax_offset_s != null && { key: "pre_climax", t: savedMarkers.pre_climax_offset_s, label: "Pre-C", color: MARKER_COLORS.pre_climax },
    savedMarkers.climax_offset_s != null && { key: "climax", t: savedMarkers.climax_offset_s, label: "Climax", color: MARKER_COLORS.climax },
    savedMarkers.recovery_offset_s != null && { key: "recovery", t: savedMarkers.recovery_offset_s, label: "Rec", color: MARKER_COLORS.recovery },
  ].filter(Boolean);

  const yLabel = viewMode === "pct" ? "%" : "Raw";
  const yDomain = viewMode === "pct" ? [0, 100] : ["auto", "auto"];

  const CustomTooltip = ({ active, payload, label }) => {
    if (!active || !payload?.length) return null;
    return (
      <div className="bg-card border border-border rounded-lg p-2 text-xs shadow-md space-y-0.5">
        <p className="text-muted-foreground font-mono">{fmtMmSs(label)}</p>
        {payload.map((p) => p.value != null && (
          <p key={p.name} style={{ color: p.color }} className="font-mono font-semibold">
            {p.name}: {typeof p.value === "number" ? p.value.toFixed(p.name === "HR" ? 0 : 1) : p.value}
            {p.name === "HR" ? " bpm" : viewMode === "pct" ? "%" : ""}
          </p>
        ))}
        {/* Show any event at this approximate time */}
        {showEvents && (() => {
          const t = Number(label);
          const ev = events.find((e) => Math.abs(e.time_s - t) < 3);
          return ev ? <p className="text-chart-4 mt-1 max-w-[200px] whitespace-normal">{ev.note}</p> : null;
        })()}
      </div>
    );
  };

  if (!rows.length) return null;

  return (
    <div className="space-y-2">
      {/* Toggle controls */}
      <div className="flex flex-wrap gap-1.5 items-center">
        <span className="text-[10px] text-muted-foreground uppercase tracking-wide mr-1">EMG</span>

        {/* View mode */}
        <button
          onClick={() => setViewMode(v => v === "pct" ? "raw" : "pct")}
          className={`px-2 py-0.5 rounded text-[10px] font-medium border transition-colors ${
            viewMode === "pct" ? "bg-primary/10 border-primary text-primary" : "border-border text-muted-foreground"
          }`}
        >
          {viewMode === "pct" ? "% Normalized" : "Raw/Envelope"}
        </button>

        {channelMode === "dual" && (
          <>
            <button
              onClick={() => setShowLeft(v => !v)}
              className={`px-2 py-0.5 rounded text-[10px] font-medium border transition-colors`}
              style={showLeft ? { background: EMG_COLORS.left + "22", borderColor: EMG_COLORS.left, color: EMG_COLORS.left } : { borderColor: "hsl(var(--border))", color: "hsl(var(--muted-foreground))" }}
            >
              Left
            </button>
            <button
              onClick={() => setShowRight(v => !v)}
              className={`px-2 py-0.5 rounded text-[10px] font-medium border transition-colors`}
              style={showRight ? { background: EMG_COLORS.right + "22", borderColor: EMG_COLORS.right, color: EMG_COLORS.right } : { borderColor: "hsl(var(--border))", color: "hsl(var(--muted-foreground))" }}
            >
              Right
            </button>
            <button
              onClick={() => setShowDiff(v => !v)}
              className={`px-2 py-0.5 rounded text-[10px] font-medium border transition-colors`}
              style={showDiff ? { background: EMG_COLORS.diff + "22", borderColor: EMG_COLORS.diff, color: EMG_COLORS.diff } : { borderColor: "hsl(var(--border))", color: "hsl(var(--muted-foreground))" }}
            >
              Diff
            </button>
          </>
        )}

        {events.length > 0 && (
          <button
            onClick={() => setShowEvents(v => !v)}
            className={`px-2 py-0.5 rounded text-[10px] font-medium border transition-colors ${
              showEvents ? "bg-chart-4/10 border-chart-4/50 text-chart-4" : "border-border text-muted-foreground"
            }`}
          >
            Events
          </button>
        )}

        {hrSorted.length > 0 && (
          <button
            onClick={() => setShowHR(v => !v)}
            className={`px-2 py-0.5 rounded text-[10px] font-medium border transition-colors`}
            style={showHR
              ? { background: "#ef444422", borderColor: "#ef4444", color: "#ef4444" }
              : { borderColor: "hsl(var(--border))", color: "hsl(var(--muted-foreground))" }}
          >
            HR
          </button>
        )}
      </div>

      {/* Chart */}
      <div className="h-44">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: -24 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis
              dataKey="t"
              type="number"
              domain={["dataMin", "dataMax"]}
              tick={{ fontSize: 9 }}
              tickFormatter={fmtMmSs}
              tickCount={8}
            />
            <YAxis yAxisId="emg" tick={{ fontSize: 9 }} domain={yDomain} unit={viewMode === "pct" ? "%" : ""} />
            {hrSorted.length > 0 && showHR && (
              <YAxis yAxisId="hr" orientation="right" tick={{ fontSize: 9 }} domain={["auto", "auto"]} unit=" bpm" width={42} />
            )}
            <Tooltip content={<CustomTooltip />} />

            {/* Phase markers */}
            {phaseMarkers.map((pm) => (
              <ReferenceLine
                key={pm.key}
                yAxisId="emg"
                x={pm.t}
                stroke={pm.color}
                strokeWidth={1.5}
                strokeDasharray="4 2"
                label={{ value: pm.label, fontSize: 7, fill: pm.color, position: "top" }}
              />
            ))}

            {/* Event markers */}
            {showEvents && events.map((ev, i) => (
              <ReferenceLine
                key={i}
                yAxisId="emg"
                x={ev.time_s}
                stroke="hsl(var(--chart-4))"
                strokeWidth={1}
                strokeOpacity={0.6}
                strokeDasharray="2 3"
              />
            ))}

            {channelMode === "single" && (
              <Line
                yAxisId="emg"
                type="monotone"
                dataKey="single"
                stroke={EMG_COLORS.single}
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
                name={viewMode === "pct" ? "EMG %" : "EMG Envelope"}
                connectNulls
              />
            )}
            {channelMode === "dual" && showLeft && (
              <Line
                yAxisId="emg"
                type="monotone"
                dataKey="left"
                stroke={EMG_COLORS.left}
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
                name={viewMode === "pct" ? "Left %" : "Left Env"}
                connectNulls
              />
            )}
            {channelMode === "dual" && showRight && (
              <Line
                yAxisId="emg"
                type="monotone"
                dataKey="right"
                stroke={EMG_COLORS.right}
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
                name={viewMode === "pct" ? "Right %" : "Right Env"}
                connectNulls
              />
            )}
            {channelMode === "dual" && showDiff && (
              <Line
                yAxisId="emg"
                type="monotone"
                dataKey="diff"
                stroke={EMG_COLORS.diff}
                strokeWidth={1}
                strokeDasharray="3 2"
                dot={false}
                isAnimationActive={false}
                name="Diff %"
                connectNulls
              />
            )}

            {/* HR overlay */}
            {hrSorted.length > 0 && showHR && (
              <Line
                yAxisId="hr"
                type="monotone"
                dataKey="hr"
                stroke="#ef4444"
                strokeWidth={1.5}
                dot={false}
                isAnimationActive={false}
                name="HR"
                connectNulls
                strokeOpacity={0.8}
              />
            )}
          </ComposedChart>
        </ResponsiveContainer>
      </div>

      <p className="text-[10px] text-muted-foreground">
        EMG {channelMode === "dual" ? "dual-channel" : "single-channel"} · {rows.length.toLocaleString()} samples
        {rows.length > 0 ? ` · ${fmtMmSs(Math.max(...rows.map(r => Number(r.time_s))))} duration` : ""}
        {viewMode === "pct" ? " · normalized 0–100%" : " · raw envelope"}
      </p>
    </div>
  );
}