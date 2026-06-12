import { useMemo, useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, ReferenceLine,
} from "recharts";
import moment from "moment";
import { serverUrl } from "@/lib/mobileApiBase";
import { normalizeSessionKeyVideoClips } from "@/lib/visualEvidence";

const COLORS = [
  "hsl(var(--chart-1))",
  "hsl(var(--chart-2))",
  "hsl(var(--chart-3))",
  "hsl(var(--chart-4))",
  "hsl(var(--chart-5))",
];

function fmtSec(v) {
  const total = Math.round(Number(v));
  const sign = total < 0 ? "-" : "";
  const abs = Math.abs(total);
  const m = Math.floor(abs / 60);
  const s = abs % 60;
  return `${sign}${m}:${s.toString().padStart(2, "0")}`;
}

// Normalize a session's HR rows to 0–100% arousal (relative to its own min/max)
function normalizeRows(rows) {
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
function downsample(rows, target = 300) {
  if (rows.length <= target) return rows;
  const step = Math.ceil(rows.length / target);
  return rows.filter((_, i) => i % step === 0);
}

function KeyVideoClipStrip({ sessions = [] }) {
  const clips = sessions.flatMap((session) => (
    normalizeSessionKeyVideoClips(session).map((clip) => ({
      ...clip,
      sessionLabel: session.date ? moment(session.date).format("M/D/YY") : "Session",
    }))
  ));
  if (!clips.length) return null;
  return (
    <div className="mt-3 rounded-lg border border-primary/20 bg-primary/[0.04] p-2">
      <p className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-primary">Key Video Moments</p>
      <div className="grid gap-2 sm:grid-cols-2">
        {clips.slice(0, 6).map((clip) => {
          const src = serverUrl(clip.url || clip.clip_url || clip.file_url);
          if (!src) return null;
          return (
            <article key={`${clip.id}-${clip.url}`} className="overflow-hidden rounded-lg border border-border bg-card">
              <div className="px-2 py-1 text-[10px]">
                <p className="truncate font-semibold text-primary">{clip.label || "Saved key moment"}</p>
                <p className="truncate text-muted-foreground">
                  {clip.sessionLabel}
                  {clip.session_time_s != null ? ` · ${fmtSec(clip.session_time_s)}` : ""}
                  {clip.camera_angle ? ` · ${clip.camera_angle}` : ""}
                </p>
              </div>
              <video src={src} controls preload="metadata" className="block max-h-56 w-full bg-black object-contain" />
            </article>
          );
        })}
      </div>
    </div>
  );
}

const ALIGN_OPTIONS = [
  { value: "absolute", label: "Absolute Time" },
  { value: "climax",   label: "Aligned to Climax" },
  { value: "start",    label: "Aligned to Session Start" },
];

export default function ComparativeArousalTimeline({ timelines, sessions = [] }) {
  const [collapsed, setCollapsed] = useState(false);
  const [alignMode, setAlignMode] = useState("absolute");

  const labels = useMemo(
    () => timelines.map((t, i) => t.label || moment(sessions[i]?.date).format("M/D/YY")),
    [timelines, sessions]
  );

  const { merged, hasData } = useMemo(() => {
    if (!timelines || timelines.length === 0) return { merged: [], hasData: false };

    const processedSessions = timelines.map((t, idx) => {
      const session = sessions[idx];
      const normalized = normalizeRows(downsample(t.rows));

      let offset = 0;
      if (alignMode === "climax" && session?.climax_offset_s != null) {
        offset = Math.round(Number(session.climax_offset_s));
      }

      return normalized.map((r) => ({ t: r.t - offset, pct: r.pct }));
    });

    const map = {};
    processedSessions.forEach((rows, idx) => {
      rows.forEach((r) => {
        if (!map[r.t]) map[r.t] = { t: r.t };
        map[r.t][`s${idx}`] = r.pct;
      });
    });

    const merged = Object.values(map).sort((a, b) => a.t - b.t);
    return { merged, hasData: merged.length > 0 };
  }, [timelines, sessions, alignMode]);

  // Phase reference lines (climax marker per session)
  const climaxLines = useMemo(() => {
    if (alignMode === "climax") return [{ x: 0, label: "Climax" }];
    return sessions
      .map((s, idx) => s.climax_offset_s != null
        ? { x: Math.round(Number(s.climax_offset_s)), label: `Clx${sessions.length > 1 ? idx + 1 : ""}`, color: COLORS[idx % COLORS.length] }
        : null
      )
      .filter(Boolean);
  }, [sessions, alignMode]);

  if (!hasData) return null;

  return (
    <div className="bg-card rounded-xl border border-border p-4">
      <button
        className="w-full flex items-center justify-between mb-1"
        onClick={() => setCollapsed((v) => !v)}
      >
        <p className="text-xs font-semibold uppercase tracking-wider text-primary">
          Comparative Arousal Timeline
        </p>
        <span className="text-[10px] text-muted-foreground">{collapsed ? "Show ▾" : "Hide ▴"}</span>
      </button>
      <p className="text-[10px] text-muted-foreground mb-3">
        Normalized arousal (0–100%) relative to each session's HR range
      </p>

      {!collapsed && (
        <>
          {/* Alignment toggle */}
          <div className="flex gap-1 mb-3 flex-wrap">
            {ALIGN_OPTIONS.map((opt) => (
              <button
                key={opt.value}
                onClick={() => setAlignMode(opt.value)}
                className={`text-[10px] px-2.5 py-1 rounded-full font-medium transition-colors border ${
                  alignMode === opt.value
                    ? "bg-primary text-primary-foreground border-primary"
                    : "bg-muted text-muted-foreground border-transparent hover:border-border"
                }`}
              >
                {opt.label}
              </button>
            ))}
          </div>

          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={merged} margin={{ top: 4, right: 4, bottom: 0, left: -16 }}>
                <XAxis
                  dataKey="t"
                  type="number"
                  domain={["dataMin", "dataMax"]}
                  tick={{ fontSize: 9 }}
                  tickFormatter={fmtSec}
                />
                <YAxis
                  tick={{ fontSize: 9 }}
                  domain={[0, 100]}
                  tickFormatter={(v) => `${v}%`}
                />
                <Tooltip
                  labelFormatter={(v) => fmtSec(Number(v))}
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
                {/* Climax markers */}
                {climaxLines.map((cl, i) => (
                  <ReferenceLine
                    key={`clx-${i}`}
                    x={cl.x}
                    stroke={cl.color || "#ef4444"}
                    strokeWidth={1.5}
                    strokeDasharray="4 2"
                    label={{
                      value: cl.label,
                      fontSize: 8,
                      fill: cl.color || "#ef4444",
                      position: "insideTopRight",
                    }}
                  />
                ))}
                {alignMode === "climax" && (
                  <ReferenceLine x={0} stroke="#ef4444" strokeWidth={2} label={{ value: "Climax", fontSize: 8, fill: "#ef4444", position: "insideTopLeft" }} />
                )}
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
          <KeyVideoClipStrip sessions={sessions} />
        </>
      )}
    </div>
  );
}
