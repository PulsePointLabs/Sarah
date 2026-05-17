import { useMemo, useState } from "react";
import {
  ScatterChart, Scatter, XAxis, YAxis, ZAxis, CartesianGrid, Tooltip,
  ResponsiveContainer, ReferenceLine, Cell,
} from "recharts";
import { Activity } from "lucide-react";
import { Link } from "react-router-dom";
import moment from "moment";

const VIEWS = [
  { key: "hr_sat", label: "Max HR vs Satisfaction", xKey: "max_hr", yKey: "satisfaction", xLabel: "Max HR (bpm)", yLabel: "Satisfaction" },
  { key: "hr_intensity", label: "Max HR vs Intensity", xKey: "max_hr", yKey: "intensity", xLabel: "Max HR (bpm)", yLabel: "Intensity" },
  { key: "hr_climax", label: "HR at Climax vs Satisfaction", xKey: "hr_at_climax", yKey: "satisfaction", xLabel: "HR at Climax (bpm)", yLabel: "Satisfaction" },
  { key: "build_sat", label: "Build Duration vs Satisfaction", xKey: "build_dur_s", yKey: "satisfaction", xLabel: "Build Duration (s)", yLabel: "Satisfaction" },
];

function satColor(sat) {
  if (!sat) return "hsl(var(--muted-foreground))";
  if (sat >= 8) return "hsl(var(--chart-1))";
  if (sat >= 6) return "hsl(var(--chart-4))";
  if (sat >= 4) return "hsl(var(--chart-2))";
  return "hsl(var(--destructive))";
}

function CustomTooltip({ active, payload }) {
  if (!active || !payload?.length) return null;
  const d = payload[0]?.payload;
  if (!d) return null;
  return (
    <div className="bg-popover border border-border rounded-lg px-3 py-2 text-xs shadow-lg space-y-1 max-w-[200px]">
      <p className="font-semibold text-foreground">{moment(d.date).format("MMM D, YYYY")}</p>
      {d.max_hr && <p className="text-muted-foreground">Max HR: <span className="font-mono text-foreground">{d.max_hr} bpm</span></p>}
      {d.hr_at_climax && <p className="text-muted-foreground">HR at Climax: <span className="font-mono text-foreground">{d.hr_at_climax} bpm</span></p>}
      {d.satisfaction && <p className="text-muted-foreground">Satisfaction: <span className="font-mono text-foreground">{d.satisfaction}/10</span></p>}
      {d.intensity && <p className="text-muted-foreground">Intensity: <span className="font-mono text-foreground">{d.intensity}/10</span></p>}
      {d.build_dur_s && <p className="text-muted-foreground">Build: <span className="font-mono text-foreground">{Math.floor(d.build_dur_s / 60)}m {d.build_dur_s % 60}s</span></p>}
      {d.methods?.length > 0 && <p className="text-muted-foreground truncate">{d.methods.join(", ")}</p>}
    </div>
  );
}

// Simple Pearson correlation
function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  const num = xs.reduce((s, x, i) => s + (x - mx) * (ys[i] - my), 0);
  const den = Math.sqrt(xs.reduce((s, x) => s + (x - mx) ** 2, 0) * ys.reduce((s, y) => s + (y - my) ** 2, 0));
  return den === 0 ? null : num / den;
}

export default function HRSatisfactionCorrelationChart({ sessions }) {
  const [view, setView] = useState("hr_sat");
  const currentView = VIEWS.find((v) => v.key === view);

  const points = useMemo(() => {
    return sessions
      .filter((s) => !s.no_climax)
      .map((s) => ({
        id: s.id,
        date: s.date,
        max_hr: s.max_hr || null,
        hr_at_climax: s.hr_at_climax || null,
        satisfaction: s.satisfaction || null,
        intensity: s.intensity || null,
        methods: s.methods || [],
        build_dur_s: s.pre_climax_offset_s != null && s.climax_offset_s != null
          ? Math.round(Math.abs(s.climax_offset_s - s.pre_climax_offset_s))
          : null,
      }))
      .filter((p) => p[currentView.xKey] != null && p[currentView.yKey] != null);
  }, [sessions, view]);

  const { r, avgX, avgY } = useMemo(() => {
    const xs = points.map((p) => p[currentView.xKey]);
    const ys = points.map((p) => p[currentView.yKey]);
    const r = pearson(xs, ys);
    const avgX = xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null;
    const avgY = ys.length ? ys.reduce((a, b) => a + b, 0) / ys.length : null;
    return { r, avgX, avgY };
  }, [points, view]);

  const corrLabel = r == null ? null
    : Math.abs(r) >= 0.6 ? (r > 0 ? "Strong positive" : "Strong negative")
    : Math.abs(r) >= 0.3 ? (r > 0 ? "Moderate positive" : "Moderate negative")
    : "Weak";

  const corrColor = r == null ? "text-muted-foreground"
    : Math.abs(r) >= 0.6 ? "text-chart-1"
    : Math.abs(r) >= 0.3 ? "text-chart-4"
    : "text-muted-foreground";

  if (sessions.filter((s) => !s.no_climax && s.max_hr && s.satisfaction).length < 3) return null;

  return (
    <div className="bg-card rounded-xl border border-border p-4 space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-primary flex items-center gap-1.5">
          <Activity className="w-4 h-4" /> HR vs Quality Correlation
        </h3>
        {r != null && (
          <span className={`text-[11px] font-semibold ${corrColor}`}>
            r = {r.toFixed(2)} — {corrLabel}
          </span>
        )}
      </div>

      {/* View selector */}
      <div className="flex flex-wrap gap-1.5">
        {VIEWS.map((v) => (
          <button
            key={v.key}
            onClick={() => setView(v.key)}
            className="text-[10px] px-2.5 py-1 rounded-full border font-medium transition-all"
            style={view === v.key
              ? { background: "hsl(var(--primary))", color: "hsl(var(--primary-foreground))", borderColor: "hsl(var(--primary))" }
              : { borderColor: "hsl(var(--border))", color: "hsl(var(--muted-foreground))" }}
          >
            {v.label}
          </button>
        ))}
      </div>

      {points.length < 3 ? (
        <p className="text-xs text-muted-foreground">Not enough data for this view ({points.length} sessions).</p>
      ) : (
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart margin={{ top: 8, right: 8, bottom: 0, left: -20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis
                type="number"
                dataKey={currentView.xKey}
                name={currentView.xLabel}
                tick={{ fontSize: 9 }}
                label={{ value: currentView.xLabel, fontSize: 9, position: "insideBottom", offset: -2, fill: "hsl(var(--muted-foreground))" }}
                domain={["auto", "auto"]}
              />
              <YAxis
                type="number"
                dataKey={currentView.yKey}
                name={currentView.yLabel}
                tick={{ fontSize: 9 }}
                domain={[0, 10]}
                tickCount={6}
              />
              <ZAxis range={[40, 40]} />
              <Tooltip content={<CustomTooltip />} />
              {avgX && <ReferenceLine x={avgX} stroke="hsl(var(--muted-foreground))" strokeDasharray="4 2" strokeOpacity={0.5} />}
              {avgY && <ReferenceLine y={avgY} stroke="hsl(var(--muted-foreground))" strokeDasharray="4 2" strokeOpacity={0.5} />}
              <Scatter data={points} fillOpacity={0.85}>
                {points.map((p, i) => (
                  <Cell key={i} fill={satColor(p.satisfaction)} />
                ))}
              </Scatter>
            </ScatterChart>
          </ResponsiveContainer>
        </div>
      )}

      {/* Legend */}
      <div className="flex flex-wrap gap-3 text-[10px] text-muted-foreground">
        {[["≥8 — High sat.", "hsl(var(--chart-1))"], ["6–7 — Good", "hsl(var(--chart-4))"], ["4–5 — Moderate", "hsl(var(--chart-2))"], ["<4 — Low", "hsl(var(--destructive))"]].map(([label, color]) => (
          <span key={label} className="flex items-center gap-1">
            <span className="w-2.5 h-2.5 rounded-full inline-block" style={{ background: color }} />
            {label}
          </span>
        ))}
        <span className="ml-auto opacity-60">Dashed lines = averages · {points.length} sessions plotted</span>
      </div>
    </div>
  );
}