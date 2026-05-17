import { useState, useEffect, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import PageHeader from "../components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Info } from "lucide-react";

// ─── Metrics definition ────────────────────────────────────────────────────
const METRICS = [
  { key: "intensity",            label: "Intensity",          group: "subjective" },
  { key: "satisfaction",         label: "Satisfaction",       group: "subjective" },
  { key: "build_quality",        label: "Build Quality",      group: "subjective" },
  { key: "max_hr",               label: "Max HR",             group: "physiological" },
  { key: "avg_hr",               label: "Avg HR",             group: "physiological" },
  { key: "hr_at_climax",         label: "HR at Climax",       group: "physiological" },
  { key: "hr_avg_pre_to_climax", label: "HR Pre→Clx Avg",    group: "physiological" },
  { key: "duration_minutes",     label: "Duration (min)",     group: "session" },
  { key: "build_duration_s",     label: "Build Duration (s)", group: "cascade" },
  { key: "recovery_onset_s",     label: "Recovery Onset (s)", group: "cascade" },
  { key: "pause_time_s",         label: "Pause Time (s)",     group: "session" },
  { key: "event_count",          label: "Event Count",        group: "session" },
];

const GROUP_COLORS = {
  subjective:    "text-chart-2",
  physiological: "text-chart-1",
  cascade:       "text-accent",
  session:       "text-chart-4",
};

const GROUP_DOT = {
  subjective:    "bg-chart-2",
  physiological: "bg-chart-1",
  cascade:       "bg-accent",
  session:       "bg-chart-4",
};

// ─── Pearson correlation ────────────────────────────────────────────────────
function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return null;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx2 = 0, dy2 = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i] - mx, dy = ys[i] - my;
    num += dx * dy; dx2 += dx * dx; dy2 += dy * dy;
  }
  if (dx2 === 0 || dy2 === 0) return null;
  return num / Math.sqrt(dx2 * dy2);
}

// ─── Color scale ────────────────────────────────────────────────────────────
function corrColor(r) {
  if (r === null) return { bg: "hsl(var(--muted))", text: "hsl(var(--muted-foreground))" };
  // -1 → red, 0 → neutral, +1 → green
  const abs = Math.abs(r);
  if (r > 0) {
    const g = Math.round(50 + abs * 60);   // 50→110
    const alpha = 0.15 + abs * 0.75;
    return { bg: `hsla(174, 62%, ${g}%, ${alpha})`, text: abs > 0.4 ? "#fff" : "hsl(var(--foreground))" };
  } else {
    const alpha = 0.15 + abs * 0.75;
    return { bg: `hsla(0, 72%, 55%, ${alpha})`, text: abs > 0.4 ? "#fff" : "hsl(var(--foreground))" };
  }
}

function calcPauseS(s) {
  const events = s.event_timeline || [];
  const cats = (ev) => Array.isArray(ev.category) ? ev.category : [ev.category].filter(Boolean);
  const sorted = [...events].sort((a, b) => a.time_s - b.time_s);
  let total = 0, start = null;
  for (const ev of sorted) {
    const c = cats(ev);
    if (c.includes("stimulation_paused") && start == null) start = ev.time_s;
    if (c.includes("stimulation_resumed") && start != null) { total += ev.time_s - start; start = null; }
  }
  return total || null;
}

function extractValue(session, key) {
  if (key === "build_duration_s") {
    if (session.pre_climax_offset_s != null && session.climax_offset_s != null)
      return Math.abs(session.climax_offset_s - session.pre_climax_offset_s);
    return null;
  }
  if (key === "recovery_onset_s") {
    if (session.climax_offset_s != null && session.recovery_offset_s != null)
      return Math.abs(session.recovery_offset_s - session.climax_offset_s);
    return null;
  }
  if (key === "pause_time_s") return calcPauseS(session);
  if (key === "event_count") return (session.event_timeline || []).length || null;
  const v = session[key];
  return (v != null && !isNaN(v)) ? Number(v) : null;
}

// ─── Top correlations list ──────────────────────────────────────────────────
function TopCorrelations({ matrix, n = 8 }) {
  const pairs = [];
  for (let i = 0; i < METRICS.length; i++) {
    for (let j = i + 1; j < METRICS.length; j++) {
      const r = matrix[i][j];
      if (r !== null) pairs.push({ i, j, r });
    }
  }
  pairs.sort((a, b) => Math.abs(b.r) - Math.abs(a.r));
  const top = pairs.slice(0, n);

  return (
    <div className="bg-card rounded-xl border border-border p-4 space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-primary">Strongest Correlations</h3>
      <div className="space-y-2">
        {top.map(({ i, j, r }, idx) => {
          const { bg, text } = corrColor(r);
          return (
            <div key={idx} className="flex items-center gap-2">
              <span className="text-xs font-mono w-5 text-muted-foreground">{idx + 1}</span>
              <div className="flex-1">
                <div className="flex justify-between text-xs mb-1">
                  <span className="font-medium">{METRICS[i].label} × {METRICS[j].label}</span>
                  <span className="font-mono font-bold" style={{ color: r > 0 ? "hsl(var(--chart-1))" : "hsl(var(--destructive))" }}>
                    {r > 0 ? "+" : ""}{r.toFixed(2)}
                  </span>
                </div>
                <div className="h-1.5 bg-muted rounded-full overflow-hidden">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${Math.abs(r) * 100}%`, background: r > 0 ? "hsl(var(--chart-1))" : "hsl(var(--destructive))" }}
                  />
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ─── Main page ───────────────────────────────────────────────────────────────
export default function CorrelationMatrix() {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(null); // {i, j, r, pairs}

  useEffect(() => {
    base44.entities.Session.list("-date", 500).then((data) => {
      setSessions(data);
      setLoading(false);
    });
  }, []);

  // Build value vectors for each metric
  const vectors = useMemo(() => {
    return METRICS.map((m) => sessions.map((s) => extractValue(s, m.key)));
  }, [sessions]);

  // Compute n×n correlation matrix (using pairwise complete observations)
  const matrix = useMemo(() => {
    return METRICS.map((_, i) =>
      METRICS.map((_, j) => {
        if (i === j) return 1;
        const pairs = [];
        for (let k = 0; k < sessions.length; k++) {
          const x = vectors[i][k], y = vectors[j][k];
          if (x !== null && y !== null) pairs.push([x, y]);
        }
        if (pairs.length < 3) return null;
        return pearson(pairs.map((p) => p[0]), pairs.map((p) => p[1]));
      })
    );
  }, [vectors, sessions]);

  // Data counts per metric
  const counts = useMemo(() => {
    return METRICS.map((_, i) => vectors[i].filter((v) => v !== null).length);
  }, [vectors]);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (sessions.length < 3) {
    return (
      <div>
        <PageHeader title="Correlation Matrix" subtitle="Discover hidden performance drivers" />
        <div className="px-4 text-center py-12 text-muted-foreground text-sm">
          Need at least 3 sessions to compute correlations.
        </div>
      </div>
    );
  }

  const cellSize = "min-w-[40px] min-h-[40px]";

  // Selected cell scatter data
  const scatterData = selected
    ? (() => {
        const pts = [];
        for (let k = 0; k < sessions.length; k++) {
          const x = vectors[selected.i][k], y = vectors[selected.j][k];
          if (x !== null && y !== null) pts.push({ x, y, date: sessions[k].date?.slice(0, 10) });
        }
        return pts;
      })()
    : [];

  return (
    <div>
      <PageHeader
        title="Correlation Matrix"
        subtitle={`${sessions.length} sessions · Pearson r`}
      />

      <div className="px-4 pb-6 space-y-4">
        {/* Legend */}
        <div className="flex flex-wrap gap-3 items-center">
          {Object.entries(GROUP_COLORS).map(([g, cls]) => (
            <span key={g} className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span className={`w-2.5 h-2.5 rounded-full ${GROUP_DOT[g]}`} />
              {g.charAt(0).toUpperCase() + g.slice(1)}
            </span>
          ))}
          <span className="flex items-center gap-1.5 text-[11px] text-muted-foreground ml-auto">
            <span className="w-3 h-3 rounded bg-chart-1/60 inline-block" /> Positive
            <span className="w-3 h-3 rounded bg-destructive/60 inline-block ml-1" /> Negative
          </span>
        </div>

        {/* Heatmap */}
        <div className="bg-card rounded-xl border border-border p-3 overflow-auto">
          <table className="border-collapse text-[10px]" style={{ tableLayout: "fixed" }}>
            <thead>
              <tr>
                <th className="w-24 min-w-24" />
                {METRICS.map((m, j) => (
                  <th key={j} className="p-0.5" style={{ width: 42 }}>
                    <div
                      className="flex flex-col items-center justify-end gap-0.5"
                      style={{ height: 80, writingMode: "vertical-lr", transform: "rotate(180deg)" }}
                    >
                      <span className={`font-semibold text-[9px] leading-tight ${GROUP_COLORS[m.group]}`}>
                        {m.label}
                      </span>
                      <span className="text-muted-foreground text-[8px]">n={counts[j]}</span>
                    </div>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {METRICS.map((mRow, i) => (
                <tr key={i}>
                  <td className="pr-2 text-right py-0.5">
                    <span className={`font-semibold text-[9px] leading-tight ${GROUP_COLORS[mRow.group]}`}>
                      {mRow.label}
                    </span>
                  </td>
                  {METRICS.map((mCol, j) => {
                    const r = matrix[i][j];
                    const { bg, text } = corrColor(r);
                    const isSelected = selected?.i === i && selected?.j === j;
                    return (
                      <td key={j} className="p-0.5">
                        <button
                          onClick={() => {
                            if (i === j) return;
                            if (isSelected) { setSelected(null); return; }
                            setSelected({ i, j, r });
                          }}
                          disabled={i === j}
                          className="w-10 h-10 rounded-md flex items-center justify-center font-mono font-bold text-[9px] transition-all"
                          style={{
                            background: bg,
                            color: text,
                            outline: isSelected ? "2px solid hsl(var(--primary))" : "none",
                            outlineOffset: 1,
                            cursor: i === j ? "default" : "pointer",
                          }}
                          title={r !== null ? `${mRow.label} × ${mCol.label}: r=${r.toFixed(3)}` : "Insufficient data"}
                        >
                          {i === j ? "—" : r !== null ? r.toFixed(2) : "·"}
                        </button>
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>

        {/* Selected cell detail */}
        {selected && selected.r !== null && (
          <div className="bg-card rounded-xl border border-border p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-bold">
                {METRICS[selected.i].label}
                <span className="text-muted-foreground font-normal mx-1">×</span>
                {METRICS[selected.j].label}
              </h3>
              <span
                className="text-sm font-bold font-mono"
                style={{ color: selected.r > 0 ? "hsl(var(--chart-1))" : "hsl(var(--destructive))" }}
              >
                r = {selected.r > 0 ? "+" : ""}{selected.r.toFixed(3)}
              </span>
            </div>
            <p className="text-xs text-muted-foreground">
              {Math.abs(selected.r) >= 0.7
                ? "Strong"
                : Math.abs(selected.r) >= 0.4
                ? "Moderate"
                : "Weak"}{" "}
              {selected.r > 0 ? "positive" : "negative"} correlation across {scatterData.length} paired sessions.
              {Math.abs(selected.r) >= 0.5
                ? selected.r > 0
                  ? ` Higher ${METRICS[selected.i].label} tends to coincide with higher ${METRICS[selected.j].label}.`
                  : ` Higher ${METRICS[selected.i].label} tends to coincide with lower ${METRICS[selected.j].label}.`
                : " The relationship is weak — other factors likely dominate."}
            </p>

            {/* Mini scatter */}
            <div className="relative h-48 bg-muted/30 rounded-lg overflow-hidden">
              {(() => {
                const xs = scatterData.map((p) => p.x);
                const ys = scatterData.map((p) => p.y);
                const xMin = Math.min(...xs), xMax = Math.max(...xs);
                const yMin = Math.min(...ys), yMax = Math.max(...ys);
                const xRange = xMax - xMin || 1, yRange = yMax - yMin || 1;
                return (
                  <>
                    {/* Axis labels */}
                    <span className="absolute bottom-1 left-1/2 -translate-x-1/2 text-[9px] text-muted-foreground">
                      {METRICS[selected.i].label}
                    </span>
                    <span
                      className="absolute top-1/2 left-1 text-[9px] text-muted-foreground"
                      style={{ writingMode: "vertical-lr", transform: "rotate(180deg) translateY(50%)" }}
                    >
                      {METRICS[selected.j].label}
                    </span>
                    {/* Points */}
                    {scatterData.map((p, k) => {
                      const cx = 24 + ((p.x - xMin) / xRange) * (100 - 32); // pct
                      const cy = 90 - ((p.y - yMin) / yRange) * 80;          // inverted pct
                      return (
                        <div
                          key={k}
                          className="absolute w-2.5 h-2.5 rounded-full bg-primary/70 border border-primary"
                          style={{ left: `${cx}%`, top: `${cy}%`, transform: "translate(-50%,-50%)" }}
                          title={`${p.date}: x=${p.x.toFixed(1)}, y=${p.y.toFixed(1)}`}
                        />
                      );
                    })}
                    {/* Trend line (simple) */}
                    <svg className="absolute inset-0 w-full h-full pointer-events-none">
                      {(() => {
                        const r = selected.r;
                        if (!r) return null;
                        // Two endpoints of regression line mapped to plot area
                        const x1pct = 24, x2pct = 24 + (100 - 32);
                        const xv1 = xMin, xv2 = xMax;
                        const sy = ys.reduce((a, b) => a + b, 0) / ys.length;
                        const sx = xs.reduce((a, b) => a + b, 0) / xs.length;
                        const sdx = Math.sqrt(xs.reduce((a, b) => a + (b - sx) ** 2, 0) / xs.length) || 1;
                        const sdy = Math.sqrt(ys.reduce((a, b) => a + (b - sy) ** 2, 0) / ys.length) || 1;
                        const slope = r * (sdy / sdx);
                        const intercept = sy - slope * sx;
                        const yv1 = slope * xv1 + intercept;
                        const yv2 = slope * xv2 + intercept;
                        const toY = (v) => 90 - ((v - yMin) / yRange) * 80;
                        return (
                          <line
                            x1={`${x1pct}%`} y1={`${toY(yv1)}%`}
                            x2={`${x2pct}%`} y2={`${toY(yv2)}%`}
                            stroke={r > 0 ? "hsl(var(--chart-1))" : "hsl(var(--destructive))"}
                            strokeWidth="1.5"
                            strokeDasharray="4 3"
                            opacity="0.7"
                          />
                        );
                      })()}
                    </svg>
                  </>
                );
              })()}
            </div>
          </div>
        )}

        {/* Top correlations */}
        <TopCorrelations matrix={matrix} />

        {/* Interpretation guide */}
        <div className="bg-muted/30 rounded-xl p-4 space-y-1.5">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider flex items-center gap-1.5">
            <Info className="w-3.5 h-3.5" /> How to read this
          </p>
          <p className="text-xs text-muted-foreground leading-relaxed">
            Each cell shows the Pearson correlation (r) between two metrics across all your sessions where both values exist.
            Values near <span className="text-chart-1 font-semibold">+1</span> indicate a strong positive link;
            near <span className="text-destructive font-semibold">−1</span> a strong inverse link.
            Tap any cell for a scatter plot and interpretation. Correlations with n &lt; 3 are hidden (·).
          </p>
        </div>
      </div>
    </div>
  );
}