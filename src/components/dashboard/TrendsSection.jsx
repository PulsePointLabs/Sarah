import { useMemo } from "react";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
  CartesianGrid, Legend, ReferenceLine,
} from "recharts";
import moment from "moment";
import { TrendingUp, ChevronDown, ChevronUp } from "lucide-react";
import { useState } from "react";

const CLIMAX_DUR_MAP = { short: 15, medium: 45, long: 90 };

const CustomTooltip = ({ active, payload, label }) => {
  if (!active || !payload?.length) return null;
  return (
    <div className="bg-card border border-border rounded-lg p-2 text-xs shadow-md">
      <p className="text-muted-foreground mb-1">{label}</p>
      {payload.map((p) => (
        <p key={p.name} style={{ color: p.color }} className="font-mono font-semibold">
          {p.name}: {typeof p.value === "number" ? p.value.toFixed(1) : p.value}
        </p>
      ))}
    </div>
  );
};

function TrendChart({ title, data, lines, domain, note }) {
  if (data.length < 3) return null;
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground mb-1">{title}</p>
      {note && <p className="text-[10px] text-muted-foreground mb-1.5">{note}</p>}
      <div className="h-44">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={data} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
            <XAxis dataKey="date" tick={{ fontSize: 9 }} />
            <YAxis domain={domain || ["auto", "auto"]} tick={{ fontSize: 9 }} />
            <Tooltip content={<CustomTooltip />} />
            <Legend wrapperStyle={{ fontSize: 10 }} />
            {lines.map((l) => (
              <Line
                key={l.key}
                type="monotone"
                dataKey={l.key}
                stroke={l.color}
                strokeWidth={2}
                dot={{ r: 2 }}
                connectNulls
                strokeDasharray={l.dashed ? "4 2" : undefined}
              />
            ))}
            {/* Rolling average reference line for satisfaction */}
            {lines.length === 1 && data.length >= 5 && (() => {
              const vals = data.map(d => d[lines[0].key]).filter(v => v != null);
              const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
              return <ReferenceLine y={avg} stroke={lines[0].color} strokeDasharray="6 3" opacity={0.4} />;
            })()}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

export default function TrendsSection({ sessions }) {
  const [collapsed, setCollapsed] = useState(false);

  const sorted = useMemo(
    () => [...sessions].sort((a, b) => new Date(a.date) - new Date(b.date)),
    [sessions]
  );

  const peakHRData = useMemo(() =>
    sorted.filter(s => s.max_hr || s.hr_at_climax).slice(-30).map(s => ({
      date: moment(s.date).format("M/D"),
      "Peak HR": s.max_hr || null,
      "HR @ Climax": s.hr_at_climax || null,
    })), [sorted]);

  const climaxDurData = useMemo(() =>
    sorted.filter(s => s.climax_duration || (s.climax_offset_s != null && s.recovery_offset_s != null)).slice(-30).map(s => {
      const measured = s.climax_offset_s != null && s.recovery_offset_s != null
        ? Math.round(s.recovery_offset_s - s.climax_offset_s)
        : null;
      const approx = s.climax_duration ? CLIMAX_DUR_MAP[s.climax_duration] : null;
      return {
        date: moment(s.date).format("M/D"),
        "Climax Duration (s)": measured ?? approx ?? null,
      };
    }), [sorted]);

  const satisfactionData = useMemo(() =>
    sorted.filter(s => s.satisfaction).slice(-30).map(s => ({
      date: moment(s.date).format("M/D"),
      "Satisfaction": s.satisfaction,
      "Intensity": s.intensity || null,
    })), [sorted]);

  const buildQualityData = useMemo(() =>
    sorted.filter(s => s.build_quality || s.buildup_quality).slice(-30).map(s => ({
      date: moment(s.date).format("M/D"),
      "Build Quality": s.build_quality ?? s.buildup_quality ?? null,
    })), [sorted]);

  const hasData = peakHRData.length >= 3 || climaxDurData.length >= 3 || satisfactionData.length >= 3;
  if (!hasData) return null;

  return (
    <div className="bg-card rounded-xl border border-border p-4 space-y-4">
      <button
        className="w-full flex items-center justify-between"
        onClick={() => setCollapsed(v => !v)}
      >
        <div className="flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-primary" />
          <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
            Long-Term Trends
          </span>
        </div>
        {collapsed ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronUp className="w-4 h-4 text-muted-foreground" />}
      </button>

      {!collapsed && (
        <div className="space-y-6">
          <TrendChart
            title="Peak Heart Rate Over Time"
            data={peakHRData}
            lines={[
              { key: "Peak HR", color: "hsl(var(--destructive))" },
              { key: "HR @ Climax", color: "hsl(var(--chart-3))", dashed: true },
            ]}
            note="Tracks cardiovascular peak load per session — rising trend may indicate increasing arousal capacity."
          />
          <TrendChart
            title="Session Satisfaction Over Time"
            data={satisfactionData}
            domain={[1, 10]}
            lines={[
              { key: "Satisfaction", color: "hsl(var(--accent))" },
              { key: "Intensity", color: "hsl(var(--primary))", dashed: true },
            ]}
            note="Dashed line is a session-average reference. Divergence between intensity and satisfaction may signal overstimulation or tolerance shifts."
          />
          <TrendChart
            title="Climax Duration Over Time (seconds)"
            data={climaxDurData}
            lines={[{ key: "Climax Duration (s)", color: "hsl(var(--chart-2))" }]}
            note="Measured from markers where available, otherwise estimated from short/medium/long rating."
          />
          {buildQualityData.length >= 3 && (
            <TrendChart
              title="Build Quality Over Time"
              data={buildQualityData}
              domain={[1, 10]}
              lines={[{ key: "Build Quality", color: "hsl(var(--chart-4))" }]}
              note="Tracks arousal build arc quality — sustained improvement may reflect technique refinement."
            />
          )}
        </div>
      )}
    </div>
  );
}