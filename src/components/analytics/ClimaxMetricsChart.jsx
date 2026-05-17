import { useMemo } from "react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Cell, Legend,
} from "recharts";
import moment from "moment";

const COLORS = [
  "hsl(var(--chart-1))",
  "hsl(var(--chart-2))",
  "hsl(var(--chart-3))",
  "hsl(var(--chart-4))",
  "hsl(var(--chart-5))",
];

function fmtDur(s) {
  if (s == null) return "—";
  const total = Math.round(Number(s));
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return m > 0 ? `${m}m ${sec}s` : `${sec}s`;
}

export default function ClimaxMetricsChart({ sessions = [] }) {
  const withClimax = sessions.filter((s) => s.climax_offset_s != null || s.hr_at_climax != null);

  const buildData = useMemo(() => {
    return sessions.map((s, i) => ({
      name: moment(s.date).format("M/D"),
      intensity: s.intensity ?? 0,
      satisfaction: s.satisfaction ?? 0,
      build_quality: s.build_quality ?? 0,
      color: COLORS[i % COLORS.length],
    }));
  }, [sessions]);

  const hrData = useMemo(() => {
    return sessions
      .filter((s) => s.avg_hr || s.max_hr || s.hr_at_climax)
      .map((s, i) => ({
        name: moment(s.date).format("M/D"),
        avg_hr: s.avg_hr ?? null,
        max_hr: s.max_hr ?? null,
        hr_at_climax: s.hr_at_climax ?? null,
        color: COLORS[i % COLORS.length],
      }));
  }, [sessions]);

  const phaseData = useMemo(() => {
    return sessions
      .filter((s) => s.pre_climax_offset_s != null && s.climax_offset_s != null)
      .map((s, i) => ({
        name: moment(s.date).format("M/D"),
        build_to_climax: Math.abs(s.climax_offset_s - s.pre_climax_offset_s),
        climax_to_recovery: s.recovery_offset_s != null
          ? Math.abs(s.recovery_offset_s - s.climax_offset_s)
          : null,
        color: COLORS[i % COLORS.length],
      }));
  }, [sessions]);

  return (
    <div className="space-y-4">
      {/* Subjective metrics */}
      <div className="bg-card rounded-xl border border-border p-4">
        <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
          Subjective Scores Comparison
        </p>
        <div className="h-44">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={buildData} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
              <XAxis dataKey="name" tick={{ fontSize: 9 }} />
              <YAxis tick={{ fontSize: 9 }} domain={[0, 10]} />
              <Tooltip
                contentStyle={{ fontSize: 11, color: "hsl(var(--foreground))", background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }}
              />
              <Legend wrapperStyle={{ fontSize: 10 }} />
              <Bar dataKey="intensity" name="Intensity" fill="hsl(var(--chart-1))" radius={[2, 2, 0, 0]} />
              <Bar dataKey="build_quality" name="Build Quality" fill="hsl(var(--chart-2))" radius={[2, 2, 0, 0]} />
              <Bar dataKey="satisfaction" name="Satisfaction" fill="hsl(var(--chart-3))" radius={[2, 2, 0, 0]} />
            </BarChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* HR metrics */}
      {hrData.length > 0 && (
        <div className="bg-card rounded-xl border border-border p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            Heart Rate Metrics Comparison
          </p>
          <div className="h-44">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={hrData} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="name" tick={{ fontSize: 9 }} />
                <YAxis tick={{ fontSize: 9 }} domain={["auto", "auto"]} unit=" bpm" />
                <Tooltip
                  formatter={(v) => v != null ? `${v} bpm` : "—"}
                  contentStyle={{ fontSize: 11, color: "hsl(var(--foreground))", background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }}
                />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                <Bar dataKey="avg_hr" name="Avg HR" fill="hsl(var(--chart-1))" radius={[2, 2, 0, 0]} />
                <Bar dataKey="max_hr" name="Max HR" fill="hsl(var(--chart-2))" radius={[2, 2, 0, 0]} />
                <Bar dataKey="hr_at_climax" name="HR @ Climax" fill="hsl(var(--destructive))" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Phase timing */}
      {phaseData.length > 0 && (
        <div className="bg-card rounded-xl border border-border p-4">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground mb-3">
            Phase Timing (seconds)
          </p>
          <div className="h-44">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={phaseData} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="name" tick={{ fontSize: 9 }} />
                <YAxis tick={{ fontSize: 9 }} tickFormatter={(v) => `${Math.floor(v / 60)}m`} />
                <Tooltip
                  formatter={(v, name) => [fmtDur(v), name]}
                  contentStyle={{ fontSize: 11, color: "hsl(var(--foreground))", background: "hsl(var(--card))", border: "1px solid hsl(var(--border))" }}
                />
                <Legend wrapperStyle={{ fontSize: 10 }} />
                <Bar dataKey="build_to_climax" name="Pre → Climax" fill="hsl(var(--chart-4))" radius={[2, 2, 0, 0]} />
                <Bar dataKey="climax_to_recovery" name="Climax → Recovery" fill="hsl(var(--chart-5))" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}