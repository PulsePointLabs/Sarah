import { useState, useEffect, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip,
  CartesianGrid, ReferenceLine, Legend,
} from "recharts";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Activity, CheckSquare, Square, Info } from "lucide-react";
import moment from "moment";

// ── Constants ──────────────────────────────────────────────────────────────────

const COLORS = [
  "#3b82f6", "#ef4444", "#f59e0b", "#a855f7", "#10b981",
  "#f43f5e", "#0ea5e9", "#8b5cf6", "#84cc16", "#fb923c",
];

const PHASE_COLORS = { pre_climax: "#a855f7", climax: "#ef4444", recovery: "#3b82f6" };
const BUCKET_S = 5; // 5-second buckets

// ── Helpers ────────────────────────────────────────────────────────────────────

function fmtAbs(v) {
  const total = Math.round(Number(v));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function fmtRel(v) {
  const val = Number(v);
  if (isNaN(val)) return "";
  const sign = val >= 0 ? "+" : "-";
  const abs = Math.abs(Math.round(val));
  const m = Math.floor(abs / 60);
  const s = abs % 60;
  return `${sign}${m > 0 ? `${m}m` : ""}${s}s`;
}

function bucketRows(rows, offset = 0) {
  const map = {};
  rows.forEach((r) => {
    const rel = Math.round((Number(r.time_offset_s) - offset) / BUCKET_S) * BUCKET_S;
    if (!map[rel]) map[rel] = [];
    map[rel].push(Number(r.hr));
  });
  const result = {};
  Object.entries(map).forEach(([k, vals]) => {
    result[Number(k)] = Math.round(vals.reduce((a, b) => a + b, 0) / vals.length);
  });
  return result;
}

// ── Session Selector ───────────────────────────────────────────────────────────

function SessionSelector({ sessions, selected, onToggle }) {
  return (
    <div className="space-y-1.5">
      {sessions.map((s, idx) => {
        const isSelected = selected.has(s.id);
        const color = COLORS[sessions.indexOf(s) % COLORS.length];
        return (
          <button
            key={s.id}
            onClick={() => onToggle(s.id)}
            className={`w-full flex items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors border ${
              isSelected ? "border-transparent bg-card" : "border-border bg-transparent hover:bg-muted/40"
            }`}
            style={isSelected ? { borderLeft: `3px solid ${color}` } : {}}
          >
            <span className="shrink-0 text-muted-foreground">
              {isSelected ? <CheckSquare className="w-4 h-4" style={{ color }} /> : <Square className="w-4 h-4" />}
            </span>
            <div className="flex-1 min-w-0">
              <p className="text-sm font-medium truncate">{moment(s.date).format("MMM D, YYYY")}</p>
              <p className="text-[10px] text-muted-foreground mt-0.5 flex gap-2 flex-wrap">
                {s.duration_minutes && <span>{s.duration_minutes}m</span>}
                {s.avg_hr && <span>avg {s.avg_hr} bpm</span>}
                {s.max_hr && <span>max {s.max_hr} bpm</span>}
                {s.climax_offset_s != null && <span className="text-destructive/80">climax @{fmtAbs(s.climax_offset_s)}</span>}
              </p>
            </div>
            {(s.methods || []).slice(0, 2).map((m) => (
              <Badge key={m} variant="secondary" className="text-[9px] shrink-0">{m}</Badge>
            ))}
          </button>
        );
      })}
    </div>
  );
}

// ── Stats Panel ────────────────────────────────────────────────────────────────

function StatsPanel({ sessions, selected }) {
  const selectedSessions = sessions.filter((s) => selected.has(s.id));
  if (selectedSessions.length < 2) return null;

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs border-collapse">
        <thead>
          <tr className="border-b border-border">
            <th className="text-left py-2 pr-3 text-muted-foreground font-medium">Session</th>
            <th className="text-right py-2 px-2 text-muted-foreground font-medium">Avg HR</th>
            <th className="text-right py-2 px-2 text-muted-foreground font-medium">Max HR</th>
            <th className="text-right py-2 px-2 text-muted-foreground font-medium">HR@Climax</th>
            <th className="text-right py-2 px-2 text-muted-foreground font-medium">Build→Peak</th>
            <th className="text-right py-2 px-2 text-muted-foreground font-medium">Peak→Recovery</th>
          </tr>
        </thead>
        <tbody>
          {selectedSessions.map((s, i) => {
            const color = COLORS[sessions.indexOf(s) % COLORS.length];
            const buildDur = s.pre_climax_offset_s != null && s.climax_offset_s != null
              ? Math.round(s.climax_offset_s - s.pre_climax_offset_s) : null;
            const recDur = s.climax_offset_s != null && s.recovery_offset_s != null
              ? Math.round(s.recovery_offset_s - s.climax_offset_s) : null;
            return (
              <tr key={s.id} className="border-b border-border/50">
                <td className="py-2 pr-3 font-medium" style={{ color }}>
                  {moment(s.date).format("MM/DD")}
                </td>
                <td className="text-right py-2 px-2 font-mono">{s.avg_hr || "—"}</td>
                <td className="text-right py-2 px-2 font-mono">{s.max_hr || "—"}</td>
                <td className="text-right py-2 px-2 font-mono">{s.hr_at_climax || "—"}</td>
                <td className="text-right py-2 px-2 font-mono">{buildDur != null ? fmtAbs(buildDur) : "—"}</td>
                <td className="text-right py-2 px-2 font-mono">{recDur != null ? fmtAbs(recDur) : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

// ── Custom Tooltip ─────────────────────────────────────────────────────────────

function CustomTooltip({ active, payload, label, mode, sessions }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-card border border-border rounded-lg p-2.5 shadow-lg text-xs max-w-xs">
      <p className="font-mono font-semibold text-muted-foreground mb-1.5">
        {mode === "aligned" ? `Climax ${fmtRel(label)}` : fmtAbs(label)}
      </p>
      {payload.filter(p => p.value != null).map((p) => (
        <p key={p.dataKey} className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full shrink-0" style={{ background: p.stroke }} />
          <span style={{ color: p.stroke }} className="font-medium">{p.name}:</span>
          <span className="font-mono font-bold text-foreground">{p.value} bpm</span>
        </p>
      ))}
    </div>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function HROverlay() {
  const [sessions, setSessions] = useState([]);
  const [timelines, setTimelines] = useState({});
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(new Set());
  const [mode, setMode] = useState("aligned"); // "aligned" | "absolute"

  useEffect(() => {
    (async () => {
      const all = await base44.entities.Session.list("-date", 200);
      // Only sessions with HR data
      const withHR = all.filter((s) => s.avg_hr || s.max_hr);
      setSessions(withHR);

      // Load timelines for all in background
      const pairs = await Promise.all(
        withHR.map((s) =>
          base44.entities.HeartRateTimeline.filter({ session: s.id }, "time_offset_s", 5000)
            .then((rows) => [s.id, rows])
        )
      );
      const map = {};
      pairs.forEach(([id, rows]) => { if (rows.length > 0) map[id] = rows; });
      setTimelines(map);

      // Auto-select the 3 most recent sessions that have HR timeline data
      const withTimeline = withHR.filter((s) => map[s.id]?.length > 0).slice(0, 3);
      setSelected(new Set(withTimeline.map((s) => s.id)));

      setLoading(false);
    })();
  }, []);

  const toggleSession = (id) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else if (next.size < 8) next.add(id); // cap at 8 for readability
      return next;
    });
  };

  const selectAll = () => setSelected(new Set(sessions.filter((s) => timelines[s.id]).map((s) => s.id).slice(0, 8)));
  const clearAll = () => setSelected(new Set());

  // Build unified chart data
  const { chartData, xDomain, sessionLabels } = useMemo(() => {
    const selectedList = sessions.filter((s) => selected.has(s.id) && timelines[s.id]);
    if (!selectedList.length) return { chartData: [], xDomain: [0, 0], sessionLabels: {} };

    const labels = {};
    selectedList.forEach((s) => {
      labels[s.id] = moment(s.date).format("MM/DD");
    });

    // Build bucketed series per session
    const seriesMap = {};
    const allTimes = new Set();

    selectedList.forEach((s) => {
      const rows = timelines[s.id];
      const offset = mode === "aligned" ? (s.climax_offset_s ?? 0) : 0;
      const bucketed = bucketRows(rows, offset);
      seriesMap[s.id] = bucketed;
      Object.keys(bucketed).forEach((t) => allTimes.add(Number(t)));
    });

    const times = Array.from(allTimes).sort((a, b) => a - b);
    const data = times.map((t) => {
      const point = { t };
      selectedList.forEach((s) => {
        point[s.id] = seriesMap[s.id][t] ?? null;
      });
      return point;
    });

    const xMin = Math.min(...times);
    const xMax = Math.max(...times);

    return { chartData: data, xDomain: [xMin, xMax], sessionLabels: labels };
  }, [sessions, selected, timelines, mode]);

  // Reference lines for phase markers (aligned mode)
  const phaseLines = useMemo(() => {
    if (mode !== "aligned") return [];
    const selectedList = sessions.filter((s) => selected.has(s.id));
    const lines = [{ x: 0, label: "Climax", color: PHASE_COLORS.climax }];
    // Average pre-climax and recovery offsets
    const preOffsets = selectedList.filter((s) => s.pre_climax_offset_s != null && s.climax_offset_s != null)
      .map((s) => s.pre_climax_offset_s - s.climax_offset_s);
    const recOffsets = selectedList.filter((s) => s.recovery_offset_s != null && s.climax_offset_s != null)
      .map((s) => s.recovery_offset_s - s.climax_offset_s);
    if (preOffsets.length) {
      const avg = Math.round(preOffsets.reduce((a, b) => a + b, 0) / preOffsets.length);
      lines.push({ x: avg, label: "~Pre-Climax", color: PHASE_COLORS.pre_climax });
    }
    if (recOffsets.length) {
      const avg = Math.round(recOffsets.reduce((a, b) => a + b, 0) / recOffsets.length);
      lines.push({ x: avg, label: "~Recovery", color: PHASE_COLORS.recovery });
    }
    return lines;
  }, [sessions, selected, mode]);

  const selectedWithTimeline = sessions.filter((s) => selected.has(s.id) && timelines[s.id]);
  const selectedNoTimeline = sessions.filter((s) => selected.has(s.id) && !timelines[s.id]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (sessions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-2 text-center px-6">
        <Activity className="w-10 h-10 text-muted-foreground" />
        <p className="text-muted-foreground text-sm">No sessions with heart rate data found.</p>
      </div>
    );
  }

  return (
    <div className="px-4 py-6 pb-24 space-y-5">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">HR Overlay</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Compare heart rate timelines across sessions on one chart
        </p>
      </div>

      {/* Mode toggle */}
      <div className="flex gap-2 items-center flex-wrap">
        <div className="flex rounded-lg border border-border overflow-hidden">
          {[["aligned", "Climax-Aligned"], ["absolute", "Absolute Time"]].map(([val, label]) => (
            <button
              key={val}
              onClick={() => setMode(val)}
              className={`px-3 py-1.5 text-xs font-medium transition-colors ${
                mode === val ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
        {mode === "aligned" && (
          <p className="text-[11px] text-muted-foreground flex items-center gap-1">
            <Info className="w-3 h-3" /> Sessions without a climax marker use t=0 as start
          </p>
        )}
      </div>

      {/* Chart */}
      {selectedWithTimeline.length > 0 ? (
        <div className="bg-card rounded-xl border border-border p-4 space-y-3">
          <div className="flex items-center justify-between flex-wrap gap-2">
            <h3 className="text-xs font-semibold uppercase tracking-wider text-primary">
              {selectedWithTimeline.length} session{selectedWithTimeline.length !== 1 ? "s" : ""} overlaid
            </h3>
          </div>
          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis
                  dataKey="t"
                  type="number"
                  domain={xDomain}
                  tick={{ fontSize: 9 }}
                  tickFormatter={mode === "aligned" ? fmtRel : fmtAbs}
                  tickCount={8}
                />
                <YAxis tick={{ fontSize: 9 }} domain={["auto", "auto"]} />
                <Tooltip content={<CustomTooltip mode={mode} sessions={sessions} />} />
                {phaseLines.map((pl, i) => (
                  <ReferenceLine
                    key={i}
                    x={pl.x}
                    stroke={pl.color}
                    strokeWidth={pl.x === 0 ? 2 : 1}
                    strokeDasharray={pl.x === 0 ? undefined : "4 2"}
                    label={{ value: pl.label, fontSize: 8, fill: pl.color, position: "top" }}
                  />
                ))}
                {selectedWithTimeline.map((s, i) => (
                  <Line
                    key={s.id}
                    type="monotone"
                    dataKey={s.id}
                    name={sessionLabels[s.id]}
                    stroke={COLORS[sessions.indexOf(s) % COLORS.length]}
                    strokeWidth={2}
                    dot={false}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>
          {/* Color legend */}
          <div className="flex flex-wrap gap-3">
            {selectedWithTimeline.map((s) => (
              <span key={s.id} className="flex items-center gap-1.5 text-xs text-foreground">
                <span className="w-3 h-0.5 rounded inline-block" style={{ background: COLORS[sessions.indexOf(s) % COLORS.length] }} />
                {moment(s.date).format("MMM D")}
                {s.methods?.[0] && <span className="text-muted-foreground">· {s.methods[0]}</span>}
              </span>
            ))}
          </div>
        </div>
      ) : (
        <div className="bg-card rounded-xl border border-border p-6 text-center text-sm text-muted-foreground">
          Select sessions with HR data below to begin overlaying timelines
        </div>
      )}

      {/* Stats comparison table */}
      {selectedWithTimeline.length >= 2 && (
        <div className="bg-card rounded-xl border border-border p-4 space-y-2">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-primary">Phase Timing Comparison</h3>
          <StatsPanel sessions={sessions} selected={selected} />
        </div>
      )}

      {selectedNoTimeline.length > 0 && (
        <p className="text-xs text-muted-foreground flex items-center gap-1.5">
          <Info className="w-3.5 h-3.5" />
          {selectedNoTimeline.length} selected session{selectedNoTimeline.length !== 1 ? "s have" : " has"} no imported HR timeline data and won't appear on the chart.
        </p>
      )}

      {/* Session picker */}
      <div className="bg-card rounded-xl border border-border p-4 space-y-3">
        <div className="flex items-center justify-between">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-primary">
            Select Sessions ({selected.size} selected, max 8)
          </h3>
          <div className="flex gap-2">
            <button onClick={selectAll} className="text-[10px] text-primary hover:underline">Select top 8</button>
            <button onClick={clearAll} className="text-[10px] text-muted-foreground hover:underline">Clear</button>
          </div>
        </div>
        <SessionSelector sessions={sessions} selected={selected} onToggle={toggleSession} />
      </div>
    </div>
  );
}