import { useMemo, useState } from "react";
import { ChevronDown, ChevronUp } from "lucide-react";
import {
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell,
  PieChart, Pie, Legend,
} from "recharts";

const ZONES = [
  { id: 0, label: "Resting",    color: "#6b7280", desc: "Baseline" },
  { id: 1, label: "Zone 1",     color: "#3b82f6", desc: "Very Light (50–60%)" },
  { id: 2, label: "Zone 2",     color: "#22c55e", desc: "Light (60–70%)" },
  { id: 3, label: "Zone 3",     color: "#eab308", desc: "Moderate (70–80%)" },
  { id: 4, label: "Zone 4",     color: "#f97316", desc: "Hard (80–90%)" },
  { id: 5, label: "Zone 5",     color: "#ef4444", desc: "Maximum (90–100%)" },
];

function fmt(s) {
  const total = Math.round(s);
  const m = Math.floor(total / 60);
  const sec = total % 60;
  if (m === 0) return `${sec}s`;
  return `${m}m ${sec}s`;
}

function getZoneIndex(hr, restingHR, mhr) {
  if (hr <= restingHR * 1.05) return 0; // within 5% of resting = resting zone
  const pct = hr / mhr;
  if (pct < 0.50) return 0;
  if (pct < 0.60) return 1;
  if (pct < 0.70) return 2;
  if (pct < 0.80) return 3;
  if (pct < 0.90) return 4;
  return 5;
}

export default function HRZoneAnalysis({ rows, sessionMaxHR, userProfile }) {
  const [collapsed, setCollapsed] = useState(true);
  const analysis = useMemo(() => {
    if (!rows || rows.length < 2) return null;

    const sorted = [...rows].sort((a, b) => Number(a.time_offset_s) - Number(b.time_offset_s));

    // Resting HR: prefer profile value, then session start average, then first point
    const restingRows = sorted.filter((r) => Number(r.time_offset_s) <= 5);
    const sessionRestingHR = restingRows.length > 0
      ? Math.round(restingRows.reduce((a, r) => a + Number(r.hr), 0) / restingRows.length)
      : sorted[0] ? Number(sorted[0].hr) : 60;
    const restingHR = userProfile?.resting_hr || sessionRestingHR;

    // MHR: prefer profile true max, then age-estimated, then session max, then timeline max
    const ageEstimatedMax = userProfile?.age ? 220 - userProfile.age : null;
    const mhr = userProfile?.max_hr || sessionMaxHR || ageEstimatedMax || Math.max(...sorted.map((r) => Number(r.hr)));

    // Time in each zone
    const zoneTimes = [0, 0, 0, 0, 0, 0]; // seconds per zone
    for (let i = 1; i < sorted.length; i++) {
      const dt = Number(sorted[i].time_offset_s) - Number(sorted[i - 1].time_offset_s);
      if (dt <= 0 || dt > 30) continue; // skip gaps
      const avgHR = (Number(sorted[i].hr) + Number(sorted[i - 1].hr)) / 2;
      const zone = getZoneIndex(avgHR, restingHR, mhr);
      zoneTimes[zone] += dt;
    }

    const totalTime = zoneTimes.reduce((a, b) => a + b, 0);

    const zoneData = ZONES.map((z, i) => ({
      ...z,
      seconds: zoneTimes[i],
      pct: totalTime > 0 ? Math.round((zoneTimes[i] / totalTime) * 100) : 0,
    })).filter((z) => z.seconds > 0);

    // HR Recovery: drop in HR over 60s after peak
    const peakIdx = sorted.reduce((best, r, i) => Number(r.hr) > Number(sorted[best].hr) ? i : best, 0);
    const peakOffset = Number(sorted[peakIdx].time_offset_s);
    const recovery60 = sorted.find((r) => Number(r.time_offset_s) >= peakOffset + 60);
    const recoveryDrop = recovery60 ? Math.round(Number(sorted[peakIdx].hr) - Number(recovery60.hr)) : null;
    const peakHR = Number(sorted[peakIdx].hr);
    const profileRecoveryNorm = userProfile?.recovery_hr_60s || null; // personal baseline for recovery interpretation

    // Zone HR boundaries for display
    const zoneBoundaries = [
      { range: `≤ ${restingHR} bpm`, label: "Resting" },
      { range: `${Math.round(mhr * 0.50)}–${Math.round(mhr * 0.60)} bpm`, label: "Zone 1" },
      { range: `${Math.round(mhr * 0.60)}–${Math.round(mhr * 0.70)} bpm`, label: "Zone 2" },
      { range: `${Math.round(mhr * 0.70)}–${Math.round(mhr * 0.80)} bpm`, label: "Zone 3" },
      { range: `${Math.round(mhr * 0.80)}–${Math.round(mhr * 0.90)} bpm`, label: "Zone 4" },
      { range: `${Math.round(mhr * 0.90)}+ bpm`, label: "Zone 5" },
    ];

    return { restingHR, mhr, zoneData, recoveryDrop, peakHR, zoneBoundaries, totalTime, profileRecoveryNorm };
  }, [rows, sessionMaxHR]);

  if (!analysis) return null;
  const { restingHR, mhr, zoneData, recoveryDrop, peakHR, zoneBoundaries, profileRecoveryNorm } = analysis;

  return (
    <div className="bg-card rounded-xl border border-border p-4 space-y-4">
      <button className="w-full flex items-center justify-between" onClick={() => setCollapsed((v) => !v)}>
        <h3 className="text-xs font-semibold uppercase tracking-wider text-primary">HR Zone Analysis</h3>
        {collapsed ? <ChevronDown className="w-4 h-4 text-muted-foreground" /> : <ChevronUp className="w-4 h-4 text-muted-foreground" />}
      </button>

      {!collapsed && <>
      {/* Key stats row */}
      <div className="grid grid-cols-3 gap-2">
        <div className="text-center bg-muted rounded-lg py-2">
          <p className="text-lg font-bold font-mono">{restingHR}</p>
          <p className="text-[10px] text-muted-foreground">Resting HR</p>
        </div>
        <div className="text-center bg-muted rounded-lg py-2">
          <p className="text-lg font-bold font-mono">{mhr}</p>
          <p className="text-[10px] text-muted-foreground">MHR (session)</p>
        </div>
        <div className="text-center bg-muted rounded-lg py-2">
          <p className="text-lg font-bold font-mono" style={{ color: recoveryDrop >= 12 ? "#22c55e" : "#f97316" }}>
            {recoveryDrop != null ? `-${recoveryDrop}` : "—"}
          </p>
          <p className="text-[10px] text-muted-foreground">Recovery/60s</p>
        </div>
      </div>

      {/* Zone time bars */}
      <div>
        <p className="text-[10px] text-muted-foreground mb-2">Time in Zone</p>
        <div className="space-y-2">
          {zoneData.map((z) => (
            <div key={z.id} className="flex items-center gap-2">
              <div className="w-14 text-[10px] font-semibold shrink-0" style={{ color: z.color }}>{z.label}</div>
              <div className="flex-1 h-5 bg-muted rounded-full overflow-hidden">
                <div
                  className="h-full rounded-full flex items-center justify-end pr-1 transition-all"
                  style={{ width: `${Math.max(z.pct, 2)}%`, background: z.color }}
                >
                  {z.pct >= 10 && <span className="text-[9px] text-white font-bold">{z.pct}%</span>}
                </div>
              </div>
              <div className="text-[10px] font-mono text-muted-foreground w-12 text-right shrink-0">{fmt(z.seconds)}</div>
            </div>
          ))}
        </div>
      </div>

      {/* Zone distribution pie */}
      {zoneData.length > 1 && (
        <div>
          <div className="h-44">
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie
                  data={zoneData}
                  dataKey="seconds"
                  nameKey="label"
                  cx="50%"
                  cy="50%"
                  innerRadius={48}
                  outerRadius={76}
                  paddingAngle={2}
                >
                  {zoneData.map((z) => (
                    <Cell key={z.id} fill={z.color} />
                  ))}
                </Pie>
                <Tooltip
                  formatter={(val, name) => [fmt(val), name]}
                  contentStyle={{ fontSize: 11 }}
                />
              </PieChart>
            </ResponsiveContainer>
          </div>
          {/* Custom legend — no recharts Legend to avoid overlaps */}
          <div className="flex flex-wrap gap-x-4 gap-y-1.5 justify-center mt-1">
            {zoneData.map((z) => (
              <div key={z.id} className="flex items-center gap-1.5">
                <span className="w-2.5 h-2.5 rounded-full shrink-0" style={{ background: z.color }} />
                <span className="text-[10px] text-muted-foreground">{z.label} <span className="font-mono font-semibold text-foreground">{z.pct}%</span></span>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Zone reference table */}
      <div>
        <p className="text-[10px] text-muted-foreground mb-1">Zone Boundaries (MHR = {mhr} bpm)</p>
        <div className="space-y-1">
          {zoneBoundaries.map((z, i) => (
            <div key={i} className="flex justify-between text-[10px]">
              <span className="font-semibold" style={{ color: ZONES[i].color }}>{z.label}</span>
              <span className="text-muted-foreground">{ZONES[i].desc}</span>
              <span className="font-mono">{z.range}</span>
            </div>
          ))}
        </div>
      </div>

      {/* Recovery insight */}
      {recoveryDrop != null && (() => {
        const norm = profileRecoveryNorm || 12;
        const good = recoveryDrop >= norm;
        const vsNorm = profileRecoveryNorm
          ? ` (your baseline: ${profileRecoveryNorm} bpm)`
          : "";
        return (
          <div className={`rounded-lg px-3 py-2 text-xs ${good ? "bg-green-500/10 text-green-600" : "bg-orange-500/10 text-orange-600"}`}>
            {good
              ? `Good recovery: HR dropped ${recoveryDrop} bpm in 60s after peak (${peakHR} bpm)${vsNorm}.`
              : `Slow recovery: HR dropped only ${recoveryDrop} bpm in 60s after peak (${peakHR} bpm)${vsNorm}.`}
          </div>
        );
      })()}
      </>}
    </div>
  );
}