import { useMemo } from "react";
import moment from "moment";

function fmtValue(v, isDuration) {
  if (!isDuration) return Number.isInteger(v) ? v : v.toFixed(1);
  const m = Math.floor(v / 60);
  const s = Math.round(v % 60);
  if (m === 0) return `${s}s`;
  if (s === 0) return `${m}m`;
  return `${m}m ${s}s`;
}

function spreadLabel(vari) {
  if (vari === 0) return { text: "Consistent", color: "text-green-500" };
  if (vari <= 0.5) return { text: "Very consistent", color: "text-green-400" };
  if (vari <= 4) return { text: "Slight variation", color: "text-yellow-400" };
  if (vari <= 25) return { text: "Moderate variation", color: "text-orange-400" };
  return { text: "High variation", color: "text-red-400" };
}

function StatBlock({ label, values, sessions, isDuration = false, unit = "" }) {
  if (!values.length) return null;
  const avg = values.reduce((a, b) => a + b, 0) / values.length;
  const min = Math.min(...values);
  const max = Math.max(...values);

  // Variance for spread label
  const mean = avg;
  const vari = values.length > 1
    ? values.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / values.length
    : 0;
  const spread = spreadLabel(vari);

  const range = max - min || 1;
  const SESSION_COLORS = ["hsl(var(--chart-1))", "hsl(var(--chart-2))", "hsl(var(--chart-3))", "hsl(var(--chart-4))", "hsl(var(--chart-5))"];

  return (
    <div className="bg-muted/40 rounded-xl p-3 space-y-2.5 border border-border/40">
      {/* Label */}
      <p className="text-[10px] uppercase font-semibold text-muted-foreground tracking-wider leading-tight">{label}</p>

      {/* Average — the hero number */}
      <div>
        <p className="text-[10px] text-muted-foreground mb-0.5">Average</p>
        <p className="text-xl font-bold font-mono leading-none">
          {fmtValue(avg, isDuration)}{unit && <span className="text-sm font-normal text-muted-foreground ml-1">{unit}</span>}
        </p>
      </div>

      {/* Per-session values */}
      {values.length > 1 && (
        <div className="space-y-1">
          {values.map((v, i) => {
            const label = sessions?.[i]?.date ? moment(sessions[i].date).format("MMM D") : `Session ${i + 1}`;
            const pct = ((v - min) / range) * 100;
            return (
              <div key={i} className="flex items-center gap-2">
                <span className="text-[10px] text-muted-foreground w-10 shrink-0">{label}</span>
                <div className="flex-1 h-1.5 bg-muted rounded-full overflow-hidden relative">
                  <div
                    className="absolute top-0 left-0 h-full rounded-full"
                    style={{ width: `${Math.max(pct, 4)}%`, background: SESSION_COLORS[i % 5] }}
                  />
                </div>
                <span className="text-[11px] font-mono font-semibold w-12 text-right shrink-0" style={{ color: SESSION_COLORS[i % 5] }}>
                  {fmtValue(v, isDuration)}{unit}
                </span>
              </div>
            );
          })}
        </div>
      )}

      {/* Spread indicator */}
      {values.length > 1 && (
        <p className={`text-[10px] font-medium ${spread.color}`}>{spread.text}</p>
      )}
    </div>
  );
}

export default function CompareStats({ sessions }) {
  const stats = useMemo(() => {
    const intensities = sessions.map((s) => s.intensity).filter(Boolean);
    const bqs = sessions.map((s) => s.build_quality).filter(Boolean);
    const satisfactions = sessions.map((s) => s.satisfaction).filter(Boolean);
    const avgHRs = sessions.map((s) => s.avg_hr).filter(Boolean);
    const maxHRs = sessions.map((s) => s.max_hr).filter(Boolean);
    const hrPreToClimax = sessions.map((s) => s.hr_avg_pre_to_climax).filter(Boolean);
    const hrAtClimaxWindow = sessions.map((s) => s.hr_avg_at_climax_window).filter(Boolean);
    const buildDurs = sessions
      .filter((s) => s.pre_climax_offset_s != null && s.climax_offset_s != null)
      .map((s) => Math.round(Math.abs(s.climax_offset_s - s.pre_climax_offset_s)));

    // Keep session references aligned to filtered values
    const sessionsForBuild = sessions.filter((s) => s.pre_climax_offset_s != null && s.climax_offset_s != null);

    return { intensities, bqs, satisfactions, avgHRs, maxHRs, hrPreToClimax, hrAtClimaxWindow, buildDurs, sessionsForBuild };
  }, [sessions]);

  return (
    <div className="bg-card rounded-xl border border-border p-4 space-y-3">
      <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
        Session Statistics · {sessions.length} sessions
      </p>
      <div className="grid grid-cols-2 gap-3">
        <StatBlock label="Intensity" values={stats.intensities} sessions={sessions} unit="/10" />
        <StatBlock label="Build Quality" values={stats.bqs} sessions={sessions} unit="/10" />
        <StatBlock label="Satisfaction" values={stats.satisfactions} sessions={sessions} unit="/10" />
        <StatBlock label="Avg Heart Rate" values={stats.avgHRs} sessions={sessions} unit=" bpm" />
        <StatBlock label="Max Heart Rate" values={stats.maxHRs} sessions={sessions} unit=" bpm" />
        {stats.hrPreToClimax.length > 0 && (
          <StatBlock label="HR Pre → Climax" values={stats.hrPreToClimax} sessions={sessions} unit=" bpm" />
        )}
        {stats.hrAtClimaxWindow.length > 0 && (
          <StatBlock label="HR at Climax ±30s" values={stats.hrAtClimaxWindow} sessions={sessions} unit=" bpm" />
        )}
        {stats.buildDurs.length > 0 && (
          <StatBlock label="Build → Climax" values={stats.buildDurs} sessions={stats.sessionsForBuild} isDuration />
        )}
      </div>
    </div>
  );
}