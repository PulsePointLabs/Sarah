import { Activity, Droplets, Gauge, Scale } from "lucide-react";
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";

function timeLabel(value) {
  const minutes = Number(value) || 0;
  if (Math.abs(minutes) < 1) return "start";
  const absolute = Math.abs(minutes);
  const amount = absolute >= 60 ? `${(absolute / 60).toFixed(1)}h` : `${Math.round(absolute)}m`;
  return `${minutes < 0 ? "−" : "+"}${amount}`;
}

function measuredLabel(reading) {
  if (!reading?.measured_at) return "Time unavailable";
  const when = new Date(reading.measured_at).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  return `${when} · ${timeLabel(reading.delta_minutes)}`;
}

function sourceLabel(reading) {
  return [reading?.source_app, reading?.source_device].filter(Boolean).join(" · ") || "Source not recorded";
}

function MetricChart({ title, icon, rows, lines, domain = ["auto", "auto"] }) {
  if (!rows.length) return null;
  const chartRows = rows.map((reading) => ({ ...reading, x: Number(reading.delta_minutes) || 0 }));
  return (
    <div className="rounded-xl border border-border bg-muted/10 p-3">
      <div className="mb-2 flex items-center justify-between gap-2">
        <p className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-primary">{icon}{title}</p>
        <span className="text-[10px] text-muted-foreground">{rows.length} reading{rows.length === 1 ? "" : "s"}</span>
      </div>
      <div className="h-44">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={chartRows} margin={{ top: 8, right: 12, bottom: 0, left: -18 }}>
            <XAxis type="number" dataKey="x" tickFormatter={timeLabel} tick={{ fontSize: 9 }} domain={["dataMin", "dataMax"]} />
            <YAxis tick={{ fontSize: 9 }} domain={domain} />
            <Tooltip
              labelFormatter={(value, payload = []) => `${timeLabel(value)} · ${payload[0]?.payload?.measured_at ? new Date(payload[0].payload.measured_at).toLocaleString() : "time unavailable"}`}
              formatter={(value, name) => {
                const line = lines.find((item) => item.key === name);
                return [`${Number(value).toFixed(line?.precision ?? 0)}${line?.unit || ""}`, line?.label || name];
              }}
            />
            {lines.map((line) => (
              <Line
                key={line.key}
                type="monotone"
                dataKey={line.key}
                name={line.key}
                stroke={line.color}
                strokeWidth={2}
                dot={{ r: 3 }}
                connectNulls
              />
            ))}
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function ReadingList({ title, readings, renderValue }) {
  if (!readings.length) return null;
  return (
    <div className="space-y-2">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{title}</p>
      {readings.map((reading, index) => (
        <div key={reading.id || `${reading.measured_at}-${index}`} className="rounded-lg border border-border bg-muted/15 px-3 py-2">
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="font-mono text-base font-bold text-foreground">{renderValue(reading)}</p>
            <span className="text-[10px] font-semibold uppercase tracking-wider text-primary">{reading.relationship}</span>
          </div>
          <p className="mt-1 text-[10px] text-muted-foreground">{measuredLabel(reading)} · {sourceLabel(reading)}</p>
        </div>
      ))}
    </div>
  );
}

export default function BodyExplorationNearbyVitalsPanel({ nearbyVitals }) {
  const bloodPressure = nearbyVitals?.bloodPressure || [];
  const bloodGlucose = nearbyVitals?.bloodGlucose || [];
  const bodyComposition = nearbyVitals?.bodyComposition || [];
  const pulseOx = nearbyVitals?.pulseOx || [];
  const total = bloodPressure.length + bloodGlucose.length + bodyComposition.length + pulseOx.length;
  if (!total) return null;

  const bpChart = bloodPressure.map((reading) => ({
    ...reading,
    systolic: Number(reading.systolic_mm_hg ?? reading.systolic),
    diastolic: Number(reading.diastolic_mm_hg ?? reading.diastolic),
    pulse: Number(reading.pulse_bpm ?? reading.pulse),
  }));
  const glucoseChart = bloodGlucose.map((reading) => ({ ...reading, glucose: Number(reading.glucose_mg_dl ?? reading.glucose ?? reading.value) }));
  const weightChart = bodyComposition.map((reading) => ({ ...reading, weight_lb: Number(reading.weight_kg) * 2.2046226218 }));
  const pulseOxChart = pulseOx.map((reading) => ({
    ...reading,
    spo2: Number(reading.spo2_percent ?? reading.spo2 ?? reading.oxygen_saturation),
    pulse: Number(reading.pulse_bpm ?? reading.pulse),
  }));

  return (
    <section id="body-exploration-nearby-vitals" className="scroll-mt-24 rounded-xl border border-primary/20 bg-card p-4">
      <div>
        <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-primary">
          <Gauge className="h-4 w-4" /> Nearby Imported Vitals
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Measured readings within twenty-four hours of this exploration, shown with exact timing and source. Nearby does not mean caused by the exploration.
        </p>
      </div>

      <div className="mt-4 grid gap-3 xl:grid-cols-2">
        <MetricChart
          title="Blood pressure"
          icon={<Activity className="h-3.5 w-3.5" />}
          rows={bpChart}
          lines={[
            { key: "systolic", label: "Systolic", unit: " mmHg", color: "hsl(var(--chart-1))" },
            { key: "diastolic", label: "Diastolic", unit: " mmHg", color: "hsl(var(--chart-2))" },
            { key: "pulse", label: "Pulse", unit: " bpm", color: "hsl(var(--chart-4))" },
          ]}
        />
        <MetricChart
          title="Blood glucose"
          icon={<Droplets className="h-3.5 w-3.5" />}
          rows={glucoseChart}
          lines={[{ key: "glucose", label: "Glucose", unit: " mg/dL", color: "hsl(var(--chart-3))" }]}
        />
        <MetricChart
          title="Weight"
          icon={<Scale className="h-3.5 w-3.5" />}
          rows={weightChart}
          lines={[{ key: "weight_lb", label: "Weight", unit: " lb", precision: 1, color: "hsl(var(--chart-4))" }]}
        />
        <MetricChart
          title="Pulse oximetry"
          icon={<Activity className="h-3.5 w-3.5" />}
          rows={pulseOxChart}
          domain={[80, 110]}
          lines={[
            { key: "spo2", label: "SpO2", unit: "%", color: "hsl(var(--primary))" },
            { key: "pulse", label: "Pulse", unit: " bpm", color: "hsl(var(--chart-2))" },
          ]}
        />
      </div>

      <details className="mt-4 rounded-lg border border-border bg-muted/10 p-3">
        <summary className="cursor-pointer text-[10px] font-semibold uppercase tracking-wider text-primary">Exact imported readings and provenance</summary>
        <div className="mt-3 grid gap-4 lg:grid-cols-2">
          <ReadingList title="Blood pressure" readings={bloodPressure} renderValue={(reading) => `${reading.systolic_mm_hg ?? reading.systolic}/${reading.diastolic_mm_hg ?? reading.diastolic} mmHg${reading.pulse_bpm || reading.pulse ? ` · ${reading.pulse_bpm || reading.pulse} bpm` : ""}`} />
          <ReadingList title="Blood glucose" readings={bloodGlucose} renderValue={(reading) => `${reading.glucose_mg_dl ?? reading.glucose ?? reading.value} mg/dL`} />
          <ReadingList title="Body composition / weight" readings={bodyComposition} renderValue={(reading) => `${Number(reading.weight_kg).toFixed(1)} kg / ${(Number(reading.weight_kg) * 2.2046226218).toFixed(1)} lb${reading.body_fat_percent != null ? ` · ${Number(reading.body_fat_percent).toFixed(1)}% fat` : ""}`} />
          <ReadingList title="Pulse oximetry" readings={pulseOx.slice(0, 24)} renderValue={(reading) => `${reading.spo2_percent ?? reading.spo2 ?? reading.oxygen_saturation}%${reading.pulse_bpm || reading.pulse ? ` · ${reading.pulse_bpm || reading.pulse} bpm` : ""}`} />
        </div>
        {pulseOx.length > 24 && <p className="mt-3 text-xs text-muted-foreground">Showing a twenty-four-reading preview; the chart and AI evidence use all {pulseOx.length.toLocaleString()} nearby pulse-ox samples.</p>}
      </details>
    </section>
  );
}
