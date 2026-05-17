import { useMemo } from "react";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend,
} from "recharts";

const COLORS = [
  "hsl(var(--chart-1))",
  "hsl(var(--chart-2))",
  "hsl(var(--chart-3))",
  "hsl(var(--chart-4))",
  "hsl(var(--chart-5))",
];

function fmtSec(v) {
  const total = Math.round(Number(v));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

// emgMap: { sessionId: { label, rows, channelMode } }
export default function EMGOverlayChart({ emgMap = {}, sessions = [] }) {
  const { merged, series } = useMemo(() => {
    const entries = sessions
      .map((s) => ({ s, data: emgMap[s.id] }))
      .filter((e) => e.data?.rows?.length > 0);

    if (!entries.length) return { merged: [], series: [] };

    const series = entries.map((e, i) => ({
      key: `emg_${i}`,
      label: e.data.label,
      color: COLORS[i % COLORS.length],
    }));

    const map = {};
    entries.forEach((e, i) => {
      // Downsample to 1000 pts per session
      const rows = e.data.rows;
      const step = Math.max(1, Math.floor(rows.length / 1000));
      rows.filter((_, idx) => idx % step === 0).forEach((r) => {
        const key = Math.round(Number(r.time_s));
        if (!map[key]) map[key] = { t: key };
        // Use level_pct (single) or average left+right (dual)
        const val = r.level_pct != null
          ? r.level_pct
          : r.left_pct != null && r.right_pct != null
            ? (r.left_pct + r.right_pct) / 2
            : r.left_pct ?? r.right_pct ?? null;
        map[key][`emg_${i}`] = val;
      });
    });

    const merged = Object.values(map).sort((a, b) => a.t - b.t);
    return { merged, series };
  }, [emgMap, sessions]);

  if (!merged.length) return (
    <div className="text-center text-xs text-muted-foreground py-8">No EMG data available for selected sessions</div>
  );

  return (
    <div className="bg-card rounded-xl border border-border p-4">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
        EMG Activity Overlay (% normalized)
      </p>
      <div className="h-52">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={merged} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
            <XAxis dataKey="t" tick={{ fontSize: 9 }} tickFormatter={fmtSec} />
            <YAxis tick={{ fontSize: 9 }} domain={[0, 100]} unit="%" />
            <Tooltip
              labelFormatter={fmtSec}
              formatter={(val, name) => {
                const s = series.find((s) => s.key === name);
                return [`${typeof val === "number" ? val.toFixed(1) : val}%`, s?.label ?? name];
              }}
              contentStyle={{ fontSize: 11, color: "hsl(var(--foreground))", background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }}
            />
            <Legend
              formatter={(value) => {
                const s = series.find((s) => s.key === value);
                return <span style={{ fontSize: 10 }}>{s?.label ?? value}</span>;
              }}
            />
            {series.map((s) => (
              <Line
                key={s.key}
                type="monotone"
                dataKey={s.key}
                stroke={s.color}
                strokeWidth={1.5}
                dot={false}
                connectNulls={false}
                isAnimationActive={false}
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}