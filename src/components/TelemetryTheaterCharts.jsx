import { Activity, Droplets, Gauge, HeartPulse, Wind } from "lucide-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  ReferenceDot,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";

function formatTime(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function downsample(rows, limit = 700) {
  if (rows.length <= limit) return rows;
  const stride = Math.ceil(rows.length / limit);
  return rows.filter((_row, index) => index % stride === 0 || index === rows.length - 1);
}

function TimelinePanel({ title, icon: Icon, rows, lines, cursor, durationS, onSeek, empty, accent = "#2dd4bf" }) {
  const chartRows = downsample(rows.filter((row) => Number.isFinite(Number(row.time_offset_s))));
  const active = chartRows.reduce((best, row) => {
    if (!best) return row;
    return Math.abs(Number(row.time_offset_s) - cursor) < Math.abs(Number(best.time_offset_s) - cursor) ? row : best;
  }, null);
  return (
    <section className="group rounded-xl border border-white/10 bg-white/[0.035] p-2.5 shadow-[0_12px_30px_rgba(0,0,0,0.22)] backdrop-blur">
      <div className="mb-1 flex items-center justify-between gap-2">
        <div className="flex items-center gap-1.5">
          <Icon className="h-3.5 w-3.5" style={{ color: accent }} />
          <h3 className="text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-300">{title}</h3>
        </div>
        <span className="font-mono text-[10px] text-rose-300">{formatTime(cursor)}</span>
      </div>
      {chartRows.length ? (
        <div className="h-[112px] w-full">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={chartRows}
              margin={{ top: 7, right: 7, bottom: 0, left: -25 }}
              onClick={(event) => {
                if (Number.isFinite(Number(event?.activeLabel))) onSeek?.(Number(event.activeLabel));
              }}
            >
              <CartesianGrid stroke="#ffffff" strokeOpacity={0.07} vertical={false} />
              <XAxis dataKey="time_offset_s" type="number" domain={[0, Math.max(1, durationS)]} tickFormatter={formatTime} tick={{ fill: "#71717a", fontSize: 8 }} axisLine={false} tickLine={false} />
              <YAxis tick={{ fill: "#71717a", fontSize: 8 }} axisLine={false} tickLine={false} domain={["auto", "auto"]} />
              <Tooltip
                labelFormatter={(value) => formatTime(value)}
                formatter={(value, key) => [Number(value).toFixed(Number(value) % 1 ? 1 : 0), lines.find((line) => line.key === key)?.label || key]}
                contentStyle={{ background: "#09090b", border: "1px solid #3f3f46", borderRadius: 8, fontSize: 10 }}
              />
              <ReferenceLine x={cursor} stroke="#fb7185" strokeWidth={2} strokeDasharray="4 3" ifOverflow="extendDomain" />
              {active && lines.map((line) => Number.isFinite(Number(active[line.key])) && (
                <ReferenceDot key={`dot-${line.key}`} x={active.time_offset_s} y={active[line.key]} r={3} fill={line.color} stroke="#09090b" />
              ))}
              {lines.map((line) => (
                <Line key={line.key} type="monotone" dataKey={line.key} stroke={line.color} strokeWidth={line.width || 2} dot={line.dots ? { r: 3 } : false} connectNulls isAnimationActive={false} />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : <div className="flex h-[112px] items-center justify-center text-center text-[11px] text-zinc-500">{empty}</div>}
    </section>
  );
}

export default function TelemetryTheaterCharts({ timelineRows = [], pulseOxRows = [], bloodPressureRows = [], motionSummary, cursor = 0, durationS = 0, onSeek }) {
  const physiologyRows = timelineRows.map((row) => ({
    ...row,
    hr: Number(row.hr) >= 30 ? Number(row.hr) : null,
    hrv_rmssd_ms: ["moderate", "high"].includes(String(row.hrv_quality || "").toLowerCase()) ? Number(row.hrv_rmssd_ms) || null : null,
    respiration_bpm: !row.respiration_unavailable_reason && Number(row.respiration_bpm) > 0 ? Number(row.respiration_bpm) : null,
  }));
  const motionRows = (motionSummary?.derived_timeline || []).map((row) => ({
    ...row,
    time_offset_s: Number(row.time_s),
    left: Number(row.left_lower_body_activity) || null,
    right: Number(row.right_lower_body_activity) || null,
    hand: Number(row.hand_activity) || null,
  }));
  return (
    <div className="space-y-2.5">
      <TimelinePanel title="Heart Rate" icon={HeartPulse} rows={physiologyRows} cursor={cursor} durationS={durationS} onSeek={onSeek} empty="No heart-rate samples" accent="#fb7185" lines={[{ key: "hr", label: "Heart rate", color: "#fb7185", width: 2.4 }]} />
      <TimelinePanel title="SpO₂ / Pulse Ox" icon={Droplets} rows={pulseOxRows} cursor={cursor} durationS={durationS} onSeek={onSeek} empty="No timed pulse-ox readings" accent="#38bdf8" lines={[{ key: "spo2_percent", label: "SpO₂", color: "#38bdf8", dots: true }, { key: "pulse_bpm", label: "Pulse", color: "#a78bfa" }]} />
      <TimelinePanel title="Blood Pressure" icon={Gauge} rows={bloodPressureRows} cursor={cursor} durationS={durationS} onSeek={onSeek} empty="No timed BP readings" accent="#fbbf24" lines={[{ key: "systolic_mm_hg", label: "Systolic", color: "#fbbf24", dots: true }, { key: "diastolic_mm_hg", label: "Diastolic", color: "#fb923c", dots: true }, { key: "pulse_bpm", label: "Cuff pulse", color: "#c084fc", dots: true }]} />
      <TimelinePanel title="HRV / Respiration" icon={Wind} rows={physiologyRows} cursor={cursor} durationS={durationS} onSeek={onSeek} empty="No usable HRV or respiration samples" accent="#2dd4bf" lines={[{ key: "hrv_rmssd_ms", label: "RMSSD", color: "#2dd4bf" }, { key: "respiration_bpm", label: "Respiration", color: "#60a5fa" }]} />
      <TimelinePanel title="Body Motion" icon={Activity} rows={motionRows} cursor={cursor} durationS={durationS} onSeek={onSeek} empty="No saved motion trace" accent="#a78bfa" lines={[{ key: "left", label: "Left lower body", color: "#2dd4bf" }, { key: "right", label: "Right lower body", color: "#f59e0b" }, { key: "hand", label: "Hand activity", color: "#a78bfa" }]} />
    </div>
  );
}
