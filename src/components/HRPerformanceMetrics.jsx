import { useMemo } from "react";
import { Activity, TrendingDown, Heart, Flame, Award } from "lucide-react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from "recharts";
import moment from "moment";

function MetricTile({ label, value, sub, color = "#3b82f6", icon: Icon }) {
  return (
    <div className="bg-muted/50 rounded-xl p-3 flex flex-col gap-1">
      <div className="flex items-center gap-1.5">
        {Icon && <Icon className="w-3.5 h-3.5" style={{ color }} />}
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">{label}</p>
      </div>
      <p className="text-2xl font-bold font-mono" style={{ color }}>{value ?? "—"}</p>
      {sub && <p className="text-[10px] text-muted-foreground">{sub}</p>}
    </div>
  );
}

function ScoreBadge({ score }) {
  const grade = score >= 90 ? { label: "Elite", color: "#10b981" }
    : score >= 75 ? { label: "Strong", color: "#3b82f6" }
    : score >= 60 ? { label: "Good", color: "#a855f7" }
    : score >= 40 ? { label: "Fair", color: "#f59e0b" }
    : { label: "Low", color: "#ef4444" };
  return (
    <span className="text-[10px] px-2 py-0.5 rounded-full font-semibold" style={{ background: grade.color + "22", color: grade.color, border: `1px solid ${grade.color}44` }}>
      {grade.label}
    </span>
  );
}

export default function HRPerformanceMetrics({ sessions }) {
  const metrics = useMemo(() => {
    // Only sessions with phase markers + HR data
    const phased = sessions.filter(
      (s) => s.climax_offset_s != null && s.recovery_offset_s != null && (s.hr_at_climax || s.max_hr)
    );

    // --- Max HR across all sessions ---
    const allMaxHRs = sessions.map((s) => s.max_hr).filter(Boolean);
    const overallMaxHR = allMaxHRs.length ? Math.max(...allMaxHRs) : null;
    const avgMaxHR = allMaxHRs.length
      ? Math.round(allMaxHRs.reduce((a, b) => a + b, 0) / allMaxHRs.length)
      : null;

    // --- Avg HR at climax (across sessions that have it) ---
    const climaxHRs = sessions.map((s) => s.hr_at_climax || s.hr_avg_at_climax_window).filter(Boolean);
    const avgClimaxHR = climaxHRs.length
      ? Math.round(climaxHRs.reduce((a, b) => a + b, 0) / climaxHRs.length)
      : null;
    const peakClimaxHR = climaxHRs.length ? Math.max(...climaxHRs) : null;

    // --- Avg HR pre→climax buildup window ---
    const preClimaxHRs = sessions.map((s) => s.hr_avg_pre_to_climax).filter(Boolean);
    const avgPreClimaxHR = preClimaxHRs.length
      ? Math.round(preClimaxHRs.reduce((a, b) => a + b, 0) / preClimaxHRs.length)
      : null;

    // --- Recovery Efficiency Score (0–100) ---
    // For each phased session: score = (HR drop / climax HR) / (recovery time / 60) * 100
    // Normalized: faster drop relative to peak HR = better score
    const recoveryScores = phased.map((s) => {
      const climaxHR = s.hr_avg_at_climax_window || s.hr_at_climax || s.max_hr;
      const baseHR = s.avg_hr || 60;
      const hrDrop = climaxHR - baseHR;
      const recoveryTimeMins = Math.max(0.5, (s.recovery_offset_s - s.climax_offset_s) / 60);
      // bpm per minute drop, normalized to a 0–100 scale (10 bpm/min = 100)
      const bpmPerMin = hrDrop / recoveryTimeMins;
      return Math.min(100, Math.round((bpmPerMin / 10) * 100));
    }).filter((s) => s > 0);

    const avgRecoveryScore = recoveryScores.length
      ? Math.round(recoveryScores.reduce((a, b) => a + b, 0) / recoveryScores.length)
      : null;
    const bestRecoveryScore = recoveryScores.length ? Math.max(...recoveryScores) : null;

    // --- HR arousal rise: avg HR during build (pre_climax to climax window) vs session avg ---
    const arousalRises = sessions
      .filter((s) => s.hr_avg_pre_to_climax && s.avg_hr)
      .map((s) => s.hr_avg_pre_to_climax - s.avg_hr);
    const avgArousalRise = arousalRises.length
      ? Math.round(arousalRises.reduce((a, b) => a + b, 0) / arousalRises.length)
      : null;

    // --- Per-session trend data for the chart (last 15 phased sessions) ---
    const trendSessions = [...phased]
      .sort((a, b) => new Date(a.date) - new Date(b.date))
      .slice(-15)
      .map((s) => {
        const climaxHR = s.hr_avg_at_climax_window || s.hr_at_climax || s.max_hr;
        const baseHR = s.avg_hr || 60;
        const hrDrop = climaxHR - baseHR;
        const recoveryTimeMins = Math.max(0.5, (s.recovery_offset_s - s.climax_offset_s) / 60);
        const bpmPerMin = hrDrop / recoveryTimeMins;
        const recovScore = Math.min(100, Math.round((bpmPerMin / 10) * 100));
        return {
          date: moment(s.date).format("M/D"),
          "Climax HR": climaxHR || null,
          "Max HR": s.max_hr || null,
          "Recovery Score": recovScore > 0 ? recovScore : null,
        };
      });

    return {
      overallMaxHR, avgMaxHR, avgClimaxHR, peakClimaxHR, avgPreClimaxHR,
      avgRecoveryScore, bestRecoveryScore, avgArousalRise,
      trendSessions, phasedCount: phased.length, totalWithClimaxHR: climaxHRs.length,
    };
  }, [sessions]);

  if (!metrics.totalWithClimaxHR && !metrics.overallMaxHR) return null;

  return (
    <div className="bg-card rounded-xl border border-border p-4 space-y-4">
      <div className="flex items-center gap-2">
        <Activity className="w-4 h-4 text-primary" />
        <h2 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">HR Performance Metrics</h2>
        {metrics.avgRecoveryScore != null && (
          <div className="ml-auto">
            <ScoreBadge score={metrics.avgRecoveryScore} />
          </div>
        )}
      </div>

      {/* Key metrics grid */}
      <div className="grid grid-cols-2 gap-2">
        {metrics.overallMaxHR && (
          <MetricTile label="All-Time Peak HR" value={`${metrics.overallMaxHR} bpm`} sub={`avg max: ${metrics.avgMaxHR} bpm`} color="#ef4444" icon={Flame} />
        )}
        {metrics.avgClimaxHR && (
          <MetricTile label="Avg HR at Climax" value={`${metrics.avgClimaxHR} bpm`} sub={`peak: ${metrics.peakClimaxHR} bpm`} color="#f43f5e" icon={Heart} />
        )}
        {metrics.avgPreClimaxHR && (
          <MetricTile label="Avg Pre→Climax HR" value={`${metrics.avgPreClimaxHR} bpm`} sub="buildup window avg" color="#a855f7" icon={TrendingDown} />
        )}
        {metrics.avgRecoveryScore != null && (
          <MetricTile label="Avg Recovery Score" value={`${metrics.avgRecoveryScore}/100`} sub={`best: ${metrics.bestRecoveryScore}/100`} color="#3b82f6" icon={Activity} />
        )}
        {metrics.avgArousalRise != null && (
          <MetricTile label="Avg Arousal Rise" value={`+${metrics.avgArousalRise} bpm`} sub="above session avg" color="#f59e0b" icon={Award} />
        )}
      </div>

      {/* Recovery score explanation */}
      {metrics.avgRecoveryScore != null && (
        <div className="flex items-start gap-2 bg-muted/30 rounded-lg px-3 py-2">
          <Activity className="w-3.5 h-3.5 text-muted-foreground mt-0.5 shrink-0" />
          <p className="text-[10px] text-muted-foreground leading-relaxed">
            Recovery score measures HR drop rate from climax peak back to baseline (bpm/min), normalized 0–100. A score of 100 = 10+ bpm/min drop. Based on {metrics.phasedCount} sessions with phase markers.
          </p>
        </div>
      )}

      {/* Trend chart */}
      {metrics.trendSessions.length > 1 && (
        <div>
          <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold mb-1.5">
            Climax HR &amp; Recovery Score — Last {metrics.trendSessions.length} Phased Sessions
          </p>
          <div className="h-44">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={metrics.trendSessions} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.5} />
                <XAxis dataKey="date" tick={{ fontSize: 9 }} />
                <YAxis yAxisId="hr" domain={["auto", "auto"]} tick={{ fontSize: 9 }} />
                <YAxis yAxisId="score" orientation="right" domain={[0, 100]} tick={{ fontSize: 9 }} />
                <Tooltip
                  contentStyle={{ fontSize: 11 }}
                  formatter={(val, name) => [
                    name === "Recovery Score" ? `${val}/100` : `${val} bpm`,
                    name,
                  ]}
                />
                <Line yAxisId="hr" type="monotone" dataKey="Climax HR" stroke="#f43f5e" strokeWidth={2} dot={{ r: 2 }} connectNulls />
                <Line yAxisId="hr" type="monotone" dataKey="Max HR" stroke="#ef4444" strokeWidth={1.5} strokeDasharray="4 2" dot={{ r: 2 }} connectNulls />
                <Line yAxisId="score" type="monotone" dataKey="Recovery Score" stroke="#3b82f6" strokeWidth={2} dot={{ r: 2 }} connectNulls />
                {metrics.avgClimaxHR && (
                  <ReferenceLine yAxisId="hr" y={metrics.avgClimaxHR} stroke="#f43f5e" strokeDasharray="3 3" strokeOpacity={0.4} />
                )}
              </LineChart>
            </ResponsiveContainer>
          </div>
          <div className="flex gap-4 mt-1 px-1">
            <span className="text-[10px] text-muted-foreground flex items-center gap-1"><span className="w-3 h-0.5 bg-[#f43f5e] inline-block rounded" /> Climax HR</span>
            <span className="text-[10px] text-muted-foreground flex items-center gap-1"><span className="w-3 h-0.5 bg-[#ef4444] inline-block rounded border-dashed" /> Max HR</span>
            <span className="text-[10px] text-muted-foreground flex items-center gap-1"><span className="w-3 h-0.5 bg-[#3b82f6] inline-block rounded" /> Recovery (0–100)</span>
          </div>
        </div>
      )}
    </div>
  );
}