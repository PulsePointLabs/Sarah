import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from "recharts";

function fmtSec(v) {
  const total = Math.round(Number(v));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function MetricCard({ label, value, unit, color = "primary" }) {
  return (
    <div className="bg-muted/40 rounded-lg p-3 text-center">
      <p className="text-[9px] text-muted-foreground uppercase tracking-wide font-semibold">{label}</p>
      <p className={`text-3xl font-bold font-mono text-${color}`}>{value}</p>
      {unit && <p className="text-[10px] text-muted-foreground mt-0.5">{unit}</p>}
    </div>
  );
}

export default function HRPhysiologicalAnalysis({ timelineRows, session }) {
  const [collapsed, setCollapsed] = useState(true);

  const metrics = useMemo(() => {
    if (!timelineRows || timelineRows.length === 0) return null;

    const hrs = timelineRows.map((r) => Number(r.hr));
    const times = timelineRows.map((r) => Number(r.time_offset_s));

    // Peak HR
    const peakHR = Math.max(...hrs);
    const peakIdx = hrs.indexOf(peakHR);
    const peakTime = times[peakIdx];

    // Baseline HR (lowest 10% average during non-climax period)
    let baselineHrs = hrs;
    if (session?.climax_offset_s != null) {
      const climaxStart = Math.max(0, session.climax_offset_s - 60);
      baselineHrs = hrs.filter((_, i) => times[i] < climaxStart);
    }
    const baselineHR = baselineHrs.length > 0 
      ? Math.round(baselineHrs.sort((a, b) => a - b).slice(0, Math.ceil(baselineHrs.length * 0.1)).reduce((a, b) => a + b) / Math.ceil(baselineHrs.length * 0.1))
      : Math.round(Math.min(...hrs));

    // HRV (standard deviation of HR)
    const avgHR = hrs.reduce((a, b) => a + b, 0) / hrs.length;
    const variance = hrs.reduce((sum, hr) => sum + Math.pow(hr - avgHR, 2), 0) / hrs.length;
    const hrv = Math.round(Math.sqrt(variance));

    // HR Recovery (30s post-climax)
    let recovery = null;
    if (session?.climax_offset_s != null && session?.recovery_offset_s != null) {
      const climaxHR = hrs[peakIdx];
      const recoveryIdx = times.findIndex((t) => t >= session.recovery_offset_s);
      if (recoveryIdx !== -1) {
        const recoveryHR = hrs[recoveryIdx];
        recovery = Math.round(climaxHR - recoveryHR);
      }
    }

    // HRV by phase (pre-climax vs post-climax)
    let preClimaxHRV = null;
    let postClimaxHRV = null;
    if (session?.climax_offset_s != null) {
      const preClimaxHrs = hrs.filter((_, i) => times[i] < session.climax_offset_s);
      const postClimaxHrs = hrs.filter((_, i) => times[i] > session.climax_offset_s);

      if (preClimaxHrs.length > 0) {
        const preAvg = preClimaxHrs.reduce((a, b) => a + b, 0) / preClimaxHrs.length;
        const preVar = preClimaxHrs.reduce((sum, hr) => sum + Math.pow(hr - preAvg, 2), 0) / preClimaxHrs.length;
        preClimaxHRV = Math.round(Math.sqrt(preVar));
      }

      if (postClimaxHrs.length > 0) {
        const postAvg = postClimaxHrs.reduce((a, b) => a + b, 0) / postClimaxHrs.length;
        const postVar = postClimaxHrs.reduce((sum, hr) => sum + Math.pow(hr - postAvg, 2), 0) / postClimaxHrs.length;
        postClimaxHRV = Math.round(Math.sqrt(postVar));
      }
    }

    return {
      baselineHR,
      peakHR,
      peakTime,
      hrv,
      avgHR: Math.round(avgHR),
      recovery,
      preClimaxHRV,
      postClimaxHRV,
    };
  }, [timelineRows, session]);

  const hrvTrendData = useMemo(() => {
    if (!timelineRows || timelineRows.length === 0) return [];
    
    // Calculate rolling HRV (30s window)
    const windowSize = 30;
    const data = [];
    const hrs = timelineRows.map((r) => Number(r.hr));
    const times = timelineRows.map((r) => Number(r.time_offset_s));

    for (let i = 0; i < hrs.length; i++) {
      const windowStart = times[i] - windowSize / 2;
      const windowEnd = times[i] + windowSize / 2;
      const windowHrs = hrs.filter((_, j) => times[j] >= windowStart && times[j] <= windowEnd);

      if (windowHrs.length > 2) {
        const avg = windowHrs.reduce((a, b) => a + b, 0) / windowHrs.length;
        const variance = windowHrs.reduce((sum, hr) => sum + Math.pow(hr - avg, 2), 0) / windowHrs.length;
        const hrv = Math.sqrt(variance);
        data.push({ time_s: times[i], hrv: Math.round(hrv) });
      }
    }

    // Thin out data for chart performance
    const step = Math.max(1, Math.floor(data.length / 100));
    return data.filter((_, i) => i % step === 0);
  }, [timelineRows]);

  if (!metrics) return null;

  return (
    <div className="bg-card rounded-xl border border-border p-4 space-y-3">
      <button
        className="w-full flex items-center justify-between"
        onClick={() => setCollapsed((v) => !v)}
      >
        <h3 className="text-xs font-semibold uppercase tracking-wider text-primary">Physiological Metrics</h3>
        {collapsed ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronUp className="w-4 h-4 text-muted-foreground" />}
      </button>

      {!collapsed && (
        <>
          {/* Key metrics grid */}
          <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
            <MetricCard label="Baseline HR" value={metrics.baselineHR} unit="bpm" color="chart-2" />
            <MetricCard label="Peak HR" value={metrics.peakHR} unit="bpm" color="chart-3" />
            <MetricCard label="Avg HR" value={metrics.avgHR} unit="bpm" color="primary" />
            <MetricCard label="HRV (σ)" value={metrics.hrv} unit="bpm" color="chart-4" />
          </div>

          {/* Phase comparison (if climax session) */}
          {metrics.preClimaxHRV != null && metrics.postClimaxHRV != null && (
            <div className="grid grid-cols-2 gap-3 pt-2 border-t border-border">
              <MetricCard label="Pre-Climax HRV" value={metrics.preClimaxHRV} unit="bpm" />
              <MetricCard label="Post-Climax HRV" value={metrics.postClimaxHRV} unit="bpm" />
            </div>
          )}

          {/* Recovery metric */}
          {metrics.recovery != null && (
            <div className="bg-muted/30 rounded-lg p-3 border border-border/50">
              <p className="text-[9px] text-muted-foreground uppercase tracking-wide font-semibold">HR Recovery (Climax → Recovery)</p>
              <p className="text-2xl font-bold font-mono text-primary mt-1">{metrics.recovery} bpm</p>
              <p className="text-[10px] text-muted-foreground mt-1">Estimated drop in heart rate</p>
            </div>
          )}

          {/* HRV Trend Chart */}
          {hrvTrendData.length > 0 && (
            <div className="space-y-1.5 pt-2 border-t border-border">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground font-semibold">HRV Trend (30s rolling window)</p>
              <div className="h-40">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={hrvTrendData} margin={{ top: 8, right: 4, bottom: 0, left: -20 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" opacity={0.3} />
                    <XAxis
                      dataKey="time_s"
                      type="number"
                      tick={{ fontSize: 9 }}
                      tickFormatter={fmtSec}
                      tickCount={7}
                      allowDataOverflow
                    />
                    <YAxis tick={{ fontSize: 9 }} domain={["auto", "auto"]} />
                    <Tooltip
                      formatter={(val) => [`${val} bpm`, "HRV"]}
                      labelFormatter={(v) => `Time: ${fmtSec(Math.round(Number(v)))}`}
                      contentStyle={{ fontSize: 11 }}
                    />

                    {/* Phase markers */}
                    {session?.pre_climax_offset_s != null && (
                      <ReferenceLine
                        x={session.pre_climax_offset_s}
                        stroke="#a855f7"
                        strokeWidth={1}
                        strokeDasharray="4 2"
                        label={{ value: "Pre", fontSize: 8, fill: "#a855f7", position: "top" }}
                      />
                    )}
                    {session?.climax_offset_s != null && (
                      <ReferenceLine
                        x={session.climax_offset_s}
                        stroke="#ef4444"
                        strokeWidth={1}
                        strokeDasharray="4 2"
                        label={{ value: "Climax", fontSize: 8, fill: "#ef4444", position: "top" }}
                      />
                    )}
                    {session?.recovery_offset_s != null && (
                      <ReferenceLine
                        x={session.recovery_offset_s}
                        stroke="#3b82f6"
                        strokeWidth={1}
                        strokeDasharray="4 2"
                        label={{ value: "Recovery", fontSize: 8, fill: "#3b82f6", position: "top" }}
                      />
                    )}

                    <Line
                      type="monotone"
                      dataKey="hrv"
                      stroke="hsl(var(--chart-4))"
                      strokeWidth={2}
                      dot={false}
                      isAnimationActive={false}
                    />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Info footer */}
          <p className="text-[9px] text-muted-foreground leading-relaxed">
            <strong>Baseline:</strong> Lowest 10% of HR readings (before climax). 
            <strong className="ml-2">HRV:</strong> Heart rate variability (standard deviation). 
            <strong className="ml-2">Recovery:</strong> HR drop from climax to recovery marker.
          </p>
        </>
      )}
    </div>
  );
}