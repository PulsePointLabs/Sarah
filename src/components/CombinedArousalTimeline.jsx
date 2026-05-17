import { useMemo, useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, ReferenceLine,
} from "recharts";

const COLORS = [
  "hsl(var(--chart-1))",
  "hsl(var(--chart-2))",
  "hsl(var(--chart-3))",
  "hsl(var(--chart-4))",
  "hsl(var(--chart-5))",
];

const PHASE_COLORS = { pre_climax: "#a855f7", climax: "#ef4444", recovery: "#3b82f6" };
const PHASE_LABELS = { pre_climax: "PreClx", climax: "Clx", recovery: "Rec" };

function fmtSec(v) {
  const total = Math.round(Number(v));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// Normalize HR values 0–100% relative to each session's own min/max
function normalizeTimeline(rows) {
  const hrs = rows.map((r) => Number(r.hr_smoothed || r.hr));
  const min = Math.min(...hrs);
  const max = Math.max(...hrs);
  const range = max - min || 1;
  return rows.map((r) => ({
    t: Math.round(Number(r.time_offset_s)),
    pct: Math.round(((Number(r.hr_smoothed || r.hr) - min) / range) * 100),
  }));
}

// Downsample to ~300 points for performance
function downsample(rows, targetPoints = 300) {
  if (rows.length <= targetPoints) return rows;
  const step = Math.ceil(rows.length / targetPoints);
  return rows.filter((_, i) => i % step === 0);
}

export default function CombinedArousalTimeline({ timelines, sessions = [] }) {
  const [collapsed, setCollapsed] = useState(false);

  const { merged, labels } = useMemo(() => {
    if (!timelines || timelines.length === 0) return { merged: [], labels: [] };

    const labels = timelines.map((t) => t.label);
    const normalized = timelines.map((t) => normalizeTimeline(downsample(t.rows)));

    const map = {};
    normalized.forEach((rows, idx) => {
      rows.forEach((r) => {
        if (!map[r.t]) map[r.t] = { t: r.t };
        map[r.t][`s${idx}`] = r.pct;
      });
    });

    const merged = Object.values(map).sort((a, b) => a.t - b.t);
    return { merged, labels };
  }, [timelines]);

  const phaseLines = useMemo(() => {
    const lines = [];
    sessions.forEach((s, idx) => {
      if (s.pre_climax_offset_s != null)
        lines.push({ x: Math.round(Number(s.pre_climax_offset_s)), phase: "pre_climax", idx });
      if (s.climax_offset_s != null)
        lines.push({ x: Math.round(Number(s.climax_offset_s)), phase: "climax", idx });
      if (s.recovery_offset_s != null)
        lines.push({ x: Math.round(Number(s.recovery_offset_s)), phase: "recovery", idx });
    });
    return lines;
  }, [sessions]);

  if (!merged.length) return null;

  return (
    <div className="bg-card rounded-xl border border-border p-4">
      <button
        className="w-full flex items-center justify-between mb-1"
        onClick={() => setCollapsed((v) => !v)}
      >
        <p className="text-xs font-semibold uppercase tracking-wider text-primary">
          Combined Arousal Timeline
        </p>
        <span className="text-[10px] text-muted-foreground">{collapsed ? "Show ▾" : "Hide ▴"}</span>
      </button>
      <p className="text-[10px] text-muted-foreground mb-3">
        Each session's HR normalized to 0–100% arousal (relative to its own range)
      </p>

      {!collapsed && (
        <>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={merged} margin={{ top: 4, right: 4, bottom: 0, left: -16 }}>
                <XAxis dataKey="t" tick={{ fontSize: 9 }} tickFormatter={fmtSec} />
                <YAxis
                  tick={{ fontSize: 9 }}
                  domain={[0, 100]}
                  tickFormatter={(v) => `${v}%`}
                />
                <Tooltip
                  labelFormatter={(v) => fmtSec(v)}
                  formatter={(val, name) => {
                    const idx = parseInt(name.replace("s", ""));
                    return [`${val}%`, labels[idx]];
                  }}
                  contentStyle={{
                    fontSize: 11,
                    color: "hsl(var(--foreground))",
                    background: "hsl(var(--card))",
                    border: "1px solid hsl(var(--border))",
                  }}
                />
                {phaseLines.map((pl, i) => (
                  <ReferenceLine
                    key={`phase-${i}`}
                    x={pl.x}
                    stroke={PHASE_COLORS[pl.phase]}
                    strokeWidth={1.5}
                    strokeDasharray="4 2"
                    isFront
                    label={{
                      value: `${PHASE_LABELS[pl.phase]}${sessions.length > 1 ? pl.idx + 1 : ""}`,
                      fontSize: 8,
                      fill: PHASE_COLORS[pl.phase],
                      position: "insideTopRight",
                    }}
                  />
                ))}
                <Legend
                  formatter={(value) => {
                    const idx = parseInt(value.replace("s", ""));
                    return <span style={{ fontSize: 10 }}>{labels[idx]}</span>;
                  }}
                />
                {labels.map((_, idx) => (
                  <Line
                    key={idx}
                    type="monotone"
                    dataKey={`s${idx}`}
                    stroke={COLORS[idx % COLORS.length]}
                    strokeWidth={2}
                    dot={false}
                    connectNulls={false}
                    isAnimationActive={false}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </div>

          {/* Phase legend */}
          <div className="flex gap-4 mt-2 flex-wrap">
            {Object.entries(PHASE_LABELS).map(([key, label]) => (
              <span key={key} className="flex items-center gap-1 text-[10px] text-muted-foreground">
                <span
                  className="w-3 h-0.5 inline-block rounded"
                  style={{ background: PHASE_COLORS[key] }}
                />
                {label}
              </span>
            ))}
          </div>
        </>
      )}
    </div>
  );
}