import { Activity, Droplets, HeartPulse } from "lucide-react";
import {
  CartesianGrid,
  Line,
  LineChart,
  Legend,
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

function TimelinePanel({ title, subtitle, icon: Icon, rows, lines, cursor, durationS, onSeek, empty, accent = "#2dd4bf", compact = false }) {
  const chartRows = downsample(rows.filter((row) => Number.isFinite(Number(row.time_offset_s))));
  const active = chartRows.reduce((best, row) => {
    if (!best) return row;
    return Math.abs(Number(row.time_offset_s) - cursor) < Math.abs(Number(best.time_offset_s) - cursor) ? row : best;
  }, null);
  return (
    <section className={`group flex min-h-0 flex-col rounded-xl border border-white/10 bg-white/[0.035] shadow-[0_12px_30px_rgba(0,0,0,0.22)] backdrop-blur ${compact ? "p-1.5" : "p-2.5"}`}>
      <div className={`${compact ? "mb-0.5" : "mb-1"} flex shrink-0 items-start justify-between gap-2`}>
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <Icon className="h-3.5 w-3.5" style={{ color: accent }} />
            <h3 className="truncate text-[10px] font-bold uppercase tracking-[0.16em] text-zinc-200">{title}</h3>
          </div>
          {subtitle && <p className="mt-0.5 truncate text-[9px] text-zinc-500">{subtitle}</p>}
        </div>
        <span className="font-mono text-[10px] text-rose-300">{formatTime(cursor)}</span>
      </div>
      {chartRows.length ? (
        <div className={compact ? "min-h-0 flex-1 w-full" : "h-[112px] w-full"}>
          <ResponsiveContainer width="100%" height="100%">
            <LineChart
              data={chartRows}
              margin={{ top: 7, right: 7, bottom: 0, left: -25 }}
              onClick={(event) => {
                if (Number.isFinite(Number(event?.activeLabel))) onSeek?.(Number(event.activeLabel));
              }}
            >
              <CartesianGrid strokeDasharray="3 3" stroke="#ffffff" strokeOpacity={0.08} />
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
              <Legend wrapperStyle={{ fontSize: 9, color: "#a1a1aa" }} iconSize={8} />
            </LineChart>
          </ResponsiveContainer>
        </div>
      ) : <div className={`flex items-center justify-center text-center text-[11px] text-zinc-500 ${compact ? "min-h-0 flex-1" : "h-[112px]"}`}>{empty}</div>}
    </section>
  );
}

export default function TelemetryTheaterCharts({ timelineRows = [], pulseOxRows = [], bloodPressureRows = [], motionSummary, cursor = 0, durationS = 0, onSeek, compact = false }) {
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
  const oxygenPressureRows = [...pulseOxRows, ...bloodPressureRows]
    .filter((row) => Number.isFinite(Number(row.time_offset_s)))
    .sort((a, b) => Number(a.time_offset_s) - Number(b.time_offset_s));
  return (
    <div className={compact ? "grid h-full min-h-0 grid-rows-3 gap-1.5" : "space-y-2.5"}>
      <TimelinePanel compact={compact} title="Cardiac & Autonomic Trend" subtitle="Heart rate, RMSSD, and respiration" icon={HeartPulse} rows={physiologyRows} cursor={cursor} durationS={durationS} onSeek={onSeek} empty="No cardiac or autonomic samples" accent="#fb7185" lines={[{ key: "hr", label: "HR", color: "#fb7185", width: 2.4 }, { key: "hrv_rmssd_ms", label: "RMSSD", color: "#2dd4bf" }, { key: "respiration_bpm", label: "Resp", color: "#60a5fa" }]} />
      <TimelinePanel compact={compact} title="Oxygen & Pressure Trend" subtitle="SpO₂, cuff pulse, and blood pressure" icon={Droplets} rows={oxygenPressureRows} cursor={cursor} durationS={durationS} onSeek={onSeek} empty="No timed pulse-ox or blood-pressure readings" accent="#38bdf8" lines={[{ key: "spo2_percent", label: "SpO₂", color: "#38bdf8", dots: true }, { key: "systolic_mm_hg", label: "SYS", color: "#fbbf24", dots: true }, { key: "diastolic_mm_hg", label: "DIA", color: "#fb923c", dots: true }, { key: "pulse_bpm", label: "Pulse", color: "#c084fc", dots: true }]} />
      <TimelinePanel compact={compact} title="Respiratory & Somatic Response" subtitle="Lower-body balance and hand activity" icon={Activity} rows={motionRows} cursor={cursor} durationS={durationS} onSeek={onSeek} empty="No saved motion trace" accent="#a78bfa" lines={[{ key: "left", label: "Left", color: "#2dd4bf" }, { key: "right", label: "Right", color: "#f59e0b" }, { key: "hand", label: "Hand", color: "#a78bfa" }]} />
    </div>
  );
}
