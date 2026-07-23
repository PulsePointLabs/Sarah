import { Activity } from "lucide-react";
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { pulseOxReadingsFromSession } from "@/lib/sessionContext";

function formatTimelineOffset(totalSeconds) {
  const value = Math.max(0, Math.round(Number(totalSeconds) || 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

function formatChartTime(value) {
  if (!value) return "";
  return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
}

function formatSampleTime(value) {
  if (!value) return "--";
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function downsampleRows(rows, maxRows = 900) {
  if (rows.length <= maxRows) return rows;
  const step = Math.ceil(rows.length / maxRows);
  return rows.filter((_row, index) => index % step === 0);
}

export default function PulseOxSessionChart({ session, sectionId = "session-pulse-ox" }) {
  const readings = pulseOxReadingsFromSession(session);
  if (!readings.length) return null;

  const chartRows = downsampleRows(readings).map((reading) => ({
    ...reading,
    label: reading.measured_at
      ? formatChartTime(reading.measured_at)
      : formatTimelineOffset(reading.time_offset_s),
    spo2: reading.spo2_percent,
    pulse: reading.pulse_bpm,
  }));
  const latest = readings[readings.length - 1];
  const spo2Values = readings.map((reading) => Number(reading.spo2_percent)).filter(Number.isFinite);
  const pulseValues = readings.map((reading) => Number(reading.pulse_bpm)).filter(Number.isFinite);
  const avgSpo2 = Math.round(spo2Values.reduce((sum, value) => sum + value, 0) / spo2Values.length);
  const minSpo2 = Math.min(...spo2Values);
  const avgPulse = pulseValues.length
    ? Math.round(pulseValues.reduce((sum, value) => sum + value, 0) / pulseValues.length)
    : null;

  return (
    <section id={sectionId} className="scroll-mt-24 rounded-xl border border-border bg-card p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-primary">
            <Activity className="h-3.5 w-3.5" /> Pulse Oximetry
          </h3>
          <p className="mt-1 text-sm text-muted-foreground">
            Imported EMAY SpO2 and pulse readings aligned to the record for oxygenation and autonomic context.
          </p>
        </div>
        <div className="grid grid-cols-3 gap-2 text-right">
          <div className="rounded-lg bg-muted/25 px-3 py-2">
            <p className="font-mono text-xl font-bold text-foreground">{latest.spo2_percent}%</p>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">latest SpO2</p>
          </div>
          <div className="rounded-lg bg-muted/25 px-3 py-2">
            <p className="font-mono text-xl font-bold text-foreground">{avgSpo2}%</p>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">avg SpO2</p>
          </div>
          <div className="rounded-lg bg-muted/25 px-3 py-2">
            <p className="font-mono text-xl font-bold text-foreground">{minSpo2}%</p>
            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">min SpO2</p>
          </div>
        </div>
      </div>

      <div className="mt-4 h-56">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartRows} margin={{ top: 8, right: 12, bottom: 0, left: -18 }}>
            <XAxis dataKey="label" tick={{ fontSize: 10 }} />
            <YAxis yAxisId="spo2" tick={{ fontSize: 10 }} domain={[80, 100]} />
            <YAxis yAxisId="pulse" orientation="right" tick={{ fontSize: 10 }} domain={["dataMin - 8", "dataMax + 8"]} />
            <Tooltip
              formatter={(value, name) => [
                `${Math.round(Number(value))}${name === "pulse" ? " bpm" : "%"}`,
                name === "spo2" ? "SpO2" : "Pulse",
              ]}
              labelFormatter={(_, rows = []) => (
                rows?.[0]?.payload?.measured_at ? formatSampleTime(rows[0].payload.measured_at) : ""
              )}
            />
            <Line yAxisId="spo2" type="monotone" dataKey="spo2" name="spo2" stroke="hsl(var(--primary))" strokeWidth={2.5} dot={false} />
            <Line yAxisId="pulse" type="monotone" dataKey="pulse" name="pulse" stroke="hsl(var(--chart-2))" strokeWidth={2} strokeDasharray="4 3" dot={false} connectNulls />
          </LineChart>
        </ResponsiveContainer>
      </div>

      <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <div className="rounded-lg border border-border bg-muted/15 px-3 py-2">
          <p className="text-xs text-muted-foreground">Samples</p>
          <p className="font-mono text-lg font-bold text-foreground">{readings.length}</p>
        </div>
        <div className="rounded-lg border border-border bg-muted/15 px-3 py-2">
          <p className="text-xs text-muted-foreground">Average pulse</p>
          <p className="font-mono text-lg font-bold text-foreground">{avgPulse ?? "--"} bpm</p>
        </div>
        <div className="rounded-lg border border-border bg-muted/15 px-3 py-2">
          <p className="text-xs text-muted-foreground">First sample</p>
          <p className="font-mono text-sm font-bold text-foreground">{formatSampleTime(readings[0]?.measured_at)}</p>
        </div>
        <div className="rounded-lg border border-border bg-muted/15 px-3 py-2">
          <p className="text-xs text-muted-foreground">Last sample</p>
          <p className="font-mono text-sm font-bold text-foreground">{formatSampleTime(latest.measured_at)}</p>
        </div>
      </div>
    </section>
  );
}
