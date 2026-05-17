import { useMemo } from "react";
import {
  ResponsiveContainer, ComposedChart, Line, XAxis, YAxis,
  Tooltip, CartesianGrid, ReferenceLine, Area,
} from "recharts";
import { TrendingUp, TrendingDown, Minus } from "lucide-react";

function fmtDate(dateStr) {
  if (!dateStr) return "?";
  const d = new Date(dateStr);
  return d.toLocaleDateString("en-US", { month: "short", day: "numeric" });
}

function fmtDur(s) {
  const v = Math.round(Math.abs(s));
  return v >= 60 ? `${Math.floor(v / 60)}m${v % 60}s` : `${v}s`;
}

function TrendBadge({ values }) {
  if (values.length < 2) return null;
  const first = values.slice(0, Math.max(1, Math.floor(values.length / 3)));
  const last = values.slice(-Math.max(1, Math.floor(values.length / 3)));
  const avgFirst = first.reduce((a, b) => a + b, 0) / first.length;
  const avgLast = last.reduce((a, b) => a + b, 0) / last.length;
  const delta = avgLast - avgFirst;
  const pct = Math.abs(delta / avgFirst) * 100;
  if (pct < 3) return <span className="text-[9px] text-muted-foreground flex items-center gap-0.5"><Minus className="w-2.5 h-2.5" />Stable</span>;
  if (delta > 0) return <span className="text-[9px] text-chart-3 flex items-center gap-0.5"><TrendingUp className="w-2.5 h-2.5" />+{pct.toFixed(0)}%</span>;
  return <span className="text-[9px] text-chart-1 flex items-center gap-0.5"><TrendingDown className="w-2.5 h-2.5" />-{pct.toFixed(0)}%</span>;
}

const MINI_COLORS = {
  peakHr: "#ef4444",
  buildDur: "#a855f7",
  recoveryOnset: "#3b82f6",
  satisfaction: "#f59e0b",
  intensity: "#10b981",
};

function MiniSparkLine({ data, dataKey, color, label, unit = "" }) {
  const vals = data.map((d) => d[dataKey]).filter((v) => v != null);
  if (!vals.length) return null;

  return (
    <div className="bg-muted/30 rounded-lg p-2.5 space-y-1">
      <div className="flex items-center justify-between">
        <span className="text-[9px] uppercase tracking-wider text-muted-foreground font-medium">{label}</span>
        <TrendBadge values={vals} />
      </div>
      <div className="h-12">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={data} margin={{ top: 2, right: 2, bottom: 0, left: -30 }}>
            <defs>
              <linearGradient id={`grad-${dataKey}`} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor={color} stopOpacity={0.3} />
                <stop offset="100%" stopColor={color} stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <YAxis tick={false} domain={["auto", "auto"]} />
            <XAxis dataKey="label" tick={false} />
            <Area
              type="monotone"
              dataKey={dataKey}
              stroke={color}
              strokeWidth={1.5}
              fill={`url(#grad-${dataKey})`}
              dot={{ r: 2, fill: color, strokeWidth: 0 }}
              isAnimationActive={false}
              connectNulls
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <div className="flex justify-between text-[8px] font-mono text-muted-foreground">
        <span>{vals.length > 0 ? `min ${Math.round(Math.min(...vals))}${unit}` : ""}</span>
        <span style={{ color }}>{vals.length > 0 ? `avg ${Math.round(vals.reduce((a, b) => a + b, 0) / vals.length)}${unit}` : ""}</span>
        <span>{vals.length > 0 ? `max ${Math.round(Math.max(...vals))}${unit}` : ""}</span>
      </div>
    </div>
  );
}

export default function CascadeTrendPanel({ sessions, hrData }) {
  const trendData = useMemo(() => {
    return [...sessions]
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .map((s, i) => {
        const rows = (hrData[s.id] || []).sort((a, b) => Number(a.time_offset_s) - Number(b.time_offset_s));

        // Peak HR near climax window (±30s)
        const climaxHr = s.hr_at_climax || (() => {
          if (s.climax_offset_s == null || !rows.length) return null;
          const window = rows.filter((r) => Math.abs(Number(r.time_offset_s) - s.climax_offset_s) <= 30);
          if (!window.length) return null;
          return Math.max(...window.map((r) => Number(r.hr)));
        })();

        const buildDur = s.pre_climax_offset_s != null && s.climax_offset_s != null
          ? Math.round(s.climax_offset_s - s.pre_climax_offset_s)
          : null;

        const recoveryOnset = s.recovery_offset_s != null && s.climax_offset_s != null
          ? Math.round(s.recovery_offset_s - s.climax_offset_s)
          : null;

        // HR descent rate: bpm/min from climax to recovery onset
        let hrDescentRate = null;
        if (climaxHr && recoveryOnset && recoveryOnset > 0 && rows.length) {
          const recRows = rows.filter((r) => Math.abs(Number(r.time_offset_s) - s.recovery_offset_s) <= 15);
          if (recRows.length) {
            const hrAtRec = Math.round(recRows.reduce((a, r) => a + Number(r.hr), 0) / recRows.length);
            hrDescentRate = Math.round(((climaxHr - hrAtRec) / recoveryOnset) * 60); // bpm per minute
          }
        }

        return {
          idx: i,
          label: fmtDate(s.date),
          date: s.date,
          peakHr: climaxHr,
          buildDur,
          recoveryOnset,
          satisfaction: s.satisfaction || null,
          intensity: s.intensity || null,
          hrDescentRate: hrDescentRate && hrDescentRate > 0 ? hrDescentRate : null,
        };
      });
  }, [sessions, hrData]);

  if (trendData.length < 2) return null;

  // Compute overall trajectory insight
  const peakHrVals = trendData.map((d) => d.peakHr).filter(Boolean);
  const satisfactionVals = trendData.map((d) => d.satisfaction).filter(Boolean);
  const buildDurVals = trendData.map((d) => d.buildDur).filter(Boolean);

  return (
    <div className="bg-card rounded-xl border border-border p-4 space-y-4">
      <div>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-primary">Cascade Evolution Over Time</h3>
        <p className="text-[10px] text-muted-foreground mt-0.5">How key cascade metrics have shifted across your {trendData.length} sessions</p>
      </div>

      {/* Overlay sparklines */}
      <div className="grid grid-cols-2 gap-2">
        <MiniSparkLine data={trendData} dataKey="peakHr" color={MINI_COLORS.peakHr} label="Peak HR at Climax" unit=" bpm" />
        <MiniSparkLine data={trendData} dataKey="buildDur" color={MINI_COLORS.buildDur} label="Build Duration" unit="s" />
        <MiniSparkLine data={trendData} dataKey="recoveryOnset" color={MINI_COLORS.recoveryOnset} label="Recovery Onset" unit="s" />
        <MiniSparkLine data={trendData} dataKey="hrDescentRate" color="#06b6d4" label="HR Descent Rate" unit=" bpm/m" />
        {satisfactionVals.length >= 2 && (
          <MiniSparkLine data={trendData} dataKey="satisfaction" color={MINI_COLORS.satisfaction} label="Satisfaction" unit="/10" />
        )}
        {trendData.filter((d) => d.intensity).length >= 2 && (
          <MiniSparkLine data={trendData} dataKey="intensity" color={MINI_COLORS.intensity} label="Intensity" unit="/10" />
        )}
      </div>

      {/* Combined overlay chart */}
      <div>
        <p className="text-[9px] uppercase tracking-wider text-muted-foreground mb-1.5">Peak HR × Satisfaction Over Time</p>
        <div className="h-32">
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={trendData} margin={{ top: 4, right: 8, bottom: 0, left: -20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="label" tick={{ fontSize: 8 }} />
              <YAxis yAxisId="hr" domain={["auto", "auto"]} tick={{ fontSize: 8 }} />
              <YAxis yAxisId="sat" orientation="right" domain={[0, 10]} tick={{ fontSize: 8 }} />
              <Tooltip
                contentStyle={{ fontSize: 9, background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }}
                formatter={(val, name) => [val ?? "—", name]}
              />
              <Line yAxisId="hr" type="monotone" dataKey="peakHr" stroke="#ef4444" strokeWidth={2} dot={{ r: 2.5, fill: "#ef4444", strokeWidth: 0 }} name="Peak HR (bpm)" connectNulls isAnimationActive={false} />
              {satisfactionVals.length >= 2 && (
                <Line yAxisId="sat" type="monotone" dataKey="satisfaction" stroke="#f59e0b" strokeWidth={1.5} strokeDasharray="4 2" dot={{ r: 2.5, fill: "#f59e0b", strokeWidth: 0 }} name="Satisfaction" connectNulls isAnimationActive={false} />
              )}
            </ComposedChart>
          </ResponsiveContainer>
        </div>
        <p className="text-[9px] text-muted-foreground mt-1">Red = peak HR at climax · Amber dashed = satisfaction score</p>
      </div>
    </div>
  );
}