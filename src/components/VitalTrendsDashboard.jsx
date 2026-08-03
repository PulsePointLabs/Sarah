import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, Droplets, Gauge, HeartPulse, RefreshCw, Scale, TriangleAlert } from "lucide-react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ReferenceArea,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { base44 } from "@/api/base44Client";
import { kilogramsToPounds } from "@/lib/bodyComposition";

const RANGE_OPTIONS = [7, 30, 90, 365];

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function timestamp(reading = {}) {
  const value = reading.measured_at || reading.timestampUtc || reading.timestamp || reading.created_date;
  const time = new Date(value || "").getTime();
  return Number.isFinite(time) ? time : null;
}

function shortDate(value) {
  const date = new Date(Number(value));
  return Number.isNaN(date.getTime()) ? "" : date.toLocaleDateString([], { month: "short", day: "numeric" });
}

function fullDate(value) {
  const date = new Date(Number(value));
  return Number.isNaN(date.getTime()) ? "Unknown time" : date.toLocaleString([], {
    month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
  });
}

function sourceLabel(reading = {}) {
  return [reading.source_app, reading.source_device].filter(Boolean).join(" · ") || "Source not recorded";
}

function sortByTime(rows = []) {
  return rows
    .map((reading) => ({ ...reading, time: timestamp(reading) }))
    .filter((reading) => reading.time != null)
    .sort((a, b) => a.time - b.time);
}

function latestValid(rows, accessor) {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const value = accessor(rows[index]);
    if (value != null) return { reading: rows[index], value };
  }
  return null;
}

function previousValid(rows, accessor, latestTime) {
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    if (rows[index].time >= latestTime) continue;
    const value = accessor(rows[index]);
    if (value != null) return value;
  }
  return null;
}

function SummaryCard({ icon: Icon, label, value, detail, delta, colorClass = "text-primary" }) {
  return (
    <article className="rounded-xl border border-border bg-card p-4 shadow-sm">
      <div className="flex items-center justify-between gap-3">
        <p className="text-[11px] font-bold uppercase tracking-wider text-muted-foreground">{label}</p>
        <Icon className={`h-5 w-5 ${colorClass}`} />
      </div>
      <div className="mt-3 flex flex-wrap items-end gap-x-3 gap-y-1">
        <p className="font-mono text-2xl font-bold text-foreground">{value || "--"}</p>
        {delta && <p className="pb-0.5 text-xs font-semibold text-muted-foreground">{delta}</p>}
      </div>
      <p className="mt-2 truncate text-xs text-muted-foreground" title={detail}>{detail || "No readings in this range"}</p>
    </article>
  );
}

function ChartCard({ title, subtitle, icon: Icon, count, children }) {
  return (
    <section className="min-w-0 rounded-xl border border-border bg-card p-4 shadow-sm sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-2 text-base font-bold text-foreground"><Icon className="h-5 w-5 text-primary" />{title}</h3>
          <p className="mt-1 text-xs text-muted-foreground">{subtitle}</p>
        </div>
        <span className="rounded-full border border-primary/20 bg-primary/10 px-2.5 py-1 text-xs font-bold text-primary">{count.toLocaleString()} points</span>
      </div>
      <div className="mt-4 h-64 min-w-0">{children}</div>
    </section>
  );
}

function EmptyChart() {
  return <div className="flex h-full items-center justify-center rounded-lg border border-dashed border-border bg-muted/10 px-4 text-center text-sm text-muted-foreground">No measurements in this range.</div>;
}

const tooltipStyle = {
  background: "hsl(var(--card))",
  border: "1px solid hsl(var(--border))",
  borderRadius: "0.65rem",
  color: "hsl(var(--foreground))",
};

export default function VitalTrendsDashboard({ refreshToken = 0 }) {
  const [rangeDays, setRangeDays] = useState(30);
  const [rows, setRows] = useState({ bloodPressure: [], pulseOx: [], glucose: [], composition: [] });
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const [bloodPressure, pulseOx, glucose, composition] = await Promise.all([
        base44.entities.BloodPressureReading.list("-measured_at", 500),
        base44.entities.PulseOxReading.list("-measured_at", 1000),
        base44.entities.BloodGlucoseReading.list("-measured_at", 500),
        base44.entities.BodyCompositionReading.list("-measured_at", 500),
      ]);
      setRows({
        bloodPressure: sortByTime(bloodPressure),
        pulseOx: sortByTime(pulseOx),
        glucose: sortByTime(glucose),
        composition: sortByTime(composition),
      });
    } catch (loadError) {
      setError(loadError?.message || "Could not load longitudinal vital-sign trends.");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load, refreshToken]);

  const filtered = useMemo(() => {
    const allTimes = Object.values(rows).flat().map((reading) => reading.time).filter(Number.isFinite);
    const newest = allTimes.length ? Math.max(...allTimes) : Date.now();
    const cutoff = newest - rangeDays * 24 * 60 * 60 * 1000;
    return Object.fromEntries(Object.entries(rows).map(([key, values]) => [key, values.filter((reading) => reading.time >= cutoff)]));
  }, [rangeDays, rows]);

  const bloodPressure = useMemo(() => filtered.bloodPressure.map((reading) => ({
    ...reading,
    systolic: finite(reading.systolic_mm_hg ?? reading.systolic),
    diastolic: finite(reading.diastolic_mm_hg ?? reading.diastolic),
    pulse: finite(reading.pulse_bpm ?? reading.pulse),
  })).filter((reading) => reading.systolic != null && reading.diastolic != null), [filtered.bloodPressure]);
  const pulseOx = useMemo(() => filtered.pulseOx.map((reading) => ({
    ...reading,
    spo2: finite(reading.spo2_percent ?? reading.spo2 ?? reading.oxygen_saturation),
    pulse: finite(reading.pulse_bpm ?? reading.pulse),
  })).filter((reading) => reading.spo2 != null), [filtered.pulseOx]);
  const glucose = useMemo(() => filtered.glucose.map((reading) => ({
    ...reading,
    glucose: finite(reading.glucose_mg_dl ?? reading.glucose ?? reading.value),
  })).filter((reading) => reading.glucose != null), [filtered.glucose]);
  const composition = useMemo(() => filtered.composition.map((reading) => ({
    ...reading,
    weightLb: kilogramsToPounds(reading.weight_kg),
    bodyFat: finite(reading.body_fat_percent),
  })).filter((reading) => reading.weightLb != null), [filtered.composition]);

  const latestBp = latestValid(bloodPressure, (reading) => reading.systolic);
  const latestSpo2 = latestValid(pulseOx, (reading) => reading.spo2);
  const latestGlucose = latestValid(glucose, (reading) => reading.glucose);
  const latestWeight = latestValid(composition, (reading) => reading.weightLb);
  const deltaText = (collection, accessor, latest, suffix, digits = 0) => {
    if (!latest) return "";
    const previous = previousValid(collection, accessor, latest.reading.time);
    if (previous == null) return "";
    const delta = latest.value - previous;
    if (Math.abs(delta) < 10 ** -digits / 2) return "no change";
    return `${delta > 0 ? "+" : ""}${delta.toFixed(digits)} ${suffix}`;
  };

  return (
    <section className="mt-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-bold uppercase tracking-wider text-primary">Longitudinal dashboard</p>
          <h2 className="mt-1 text-2xl font-bold text-foreground">Your physiology at a glance</h2>
          <p className="mt-1 text-sm text-muted-foreground">Imported measurements remain source-stamped. Weight and body mass are shown in pounds first.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <div className="inline-flex rounded-lg border border-border bg-muted/35 p-1">
            {RANGE_OPTIONS.map((days) => (
              <button key={days} type="button" onClick={() => setRangeDays(days)} className={`min-h-9 rounded-md px-3 text-xs font-bold transition-colors ${rangeDays === days ? "bg-primary text-primary-foreground shadow-sm" : "text-muted-foreground hover:text-foreground"}`}>
                {days === 365 ? "1Y" : `${days}D`}
              </button>
            ))}
          </div>
          <button type="button" onClick={load} disabled={loading} className="inline-flex min-h-11 items-center gap-2 rounded-lg border border-border bg-card px-3 text-sm font-semibold text-foreground disabled:opacity-60">
            <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />Refresh
          </button>
        </div>
      </div>
      {error && <div className="mt-4 flex items-start gap-2 rounded-lg border border-destructive/35 bg-destructive/10 p-3 text-sm text-destructive"><TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />{error}</div>}
      <div className="mt-4 grid grid-cols-2 gap-3 lg:grid-cols-4">
        <SummaryCard icon={HeartPulse} label="Latest blood pressure" value={latestBp ? `${latestBp.reading.systolic}/${latestBp.reading.diastolic}` : ""} detail={latestBp ? `${fullDate(latestBp.reading.time)} · ${sourceLabel(latestBp.reading)}` : ""} colorClass="text-rose-500" />
        <SummaryCard icon={Activity} label="Latest SpO₂" value={latestSpo2 ? `${latestSpo2.value.toFixed(0)}%` : ""} delta={deltaText(pulseOx, (reading) => reading.spo2, latestSpo2, "points")} detail={latestSpo2 ? `${fullDate(latestSpo2.reading.time)} · pulse ${latestSpo2.reading.pulse ?? "--"} bpm` : ""} colorClass="text-cyan-500" />
        <SummaryCard icon={Droplets} label="Latest glucose" value={latestGlucose ? `${latestGlucose.value.toFixed(0)} mg/dL` : ""} delta={deltaText(glucose, (reading) => reading.glucose, latestGlucose, "mg/dL")} detail={latestGlucose ? `${fullDate(latestGlucose.reading.time)} · ${sourceLabel(latestGlucose.reading)}` : ""} colorClass="text-violet-500" />
        <SummaryCard icon={Scale} label="Latest weight" value={latestWeight ? `${latestWeight.value.toFixed(1)} lb` : ""} delta={deltaText(composition, (reading) => reading.weightLb, latestWeight, "lb", 1)} detail={latestWeight ? `${fullDate(latestWeight.reading.time)} · ${sourceLabel(latestWeight.reading)}` : ""} colorClass="text-amber-500" />
      </div>
      <div className="mt-4 grid gap-4 xl:grid-cols-2">
        <ChartCard title="Blood pressure" subtitle="Systolic, diastolic, and cuff pulse across imported readings" icon={HeartPulse} count={bloodPressure.length}>
          {bloodPressure.length ? <ResponsiveContainer width="100%" height="100%"><LineChart data={bloodPressure} margin={{ top: 6, right: 8, bottom: 4, left: -10 }}>
            <CartesianGrid strokeDasharray="3 4" stroke="hsl(var(--border))" opacity={0.45} /><XAxis dataKey="time" type="number" domain={["dataMin", "dataMax"]} tickFormatter={shortDate} tick={{ fontSize: 10 }} minTickGap={34} /><YAxis domain={["dataMin - 8", "dataMax + 8"]} tick={{ fontSize: 10 }} width={42} />
            <Tooltip contentStyle={tooltipStyle} labelFormatter={fullDate} formatter={(value, name) => [`${Math.round(Number(value))}${name === "pulse" ? " bpm" : " mmHg"}`, name]} /><Legend />
            <Line type="monotone" dataKey="systolic" stroke="hsl(var(--chart-1))" strokeWidth={2.5} dot={{ r: 2 }} isAnimationActive={false} /><Line type="monotone" dataKey="diastolic" stroke="hsl(var(--chart-2))" strokeWidth={2.5} dot={{ r: 2 }} isAnimationActive={false} /><Line type="monotone" dataKey="pulse" stroke="hsl(var(--chart-4))" strokeWidth={1.5} dot={false} connectNulls isAnimationActive={false} />
          </LineChart></ResponsiveContainer> : <EmptyChart />}
        </ChartCard>
        <ChartCard title="SpO₂ and pulse" subtitle="Oxygen saturation with pulse on a separate axis" icon={Activity} count={pulseOx.length}>
          {pulseOx.length ? <ResponsiveContainer width="100%" height="100%"><LineChart data={pulseOx} margin={{ top: 6, right: -4, bottom: 4, left: -10 }}>
            <CartesianGrid strokeDasharray="3 4" stroke="hsl(var(--border))" opacity={0.45} /><XAxis dataKey="time" type="number" domain={["dataMin", "dataMax"]} tickFormatter={shortDate} tick={{ fontSize: 10 }} minTickGap={34} /><YAxis yAxisId="spo2" domain={["dataMin - 2", 100]} tick={{ fontSize: 10 }} width={42} unit="%" /><YAxis yAxisId="pulse" orientation="right" domain={["dataMin - 8", "dataMax + 8"]} tick={{ fontSize: 10 }} width={42} />
            <ReferenceLine yAxisId="spo2" y={95} stroke="hsl(var(--muted-foreground))" strokeDasharray="4 4" opacity={0.55} /><Tooltip contentStyle={tooltipStyle} labelFormatter={fullDate} formatter={(value, name) => [`${Math.round(Number(value))}${name === "spo2" ? "%" : " bpm"}`, name === "spo2" ? "SpO₂" : "Pulse"]} /><Legend formatter={(value) => value === "spo2" ? "SpO₂" : "Pulse"} />
            <Line yAxisId="spo2" type="monotone" dataKey="spo2" stroke="hsl(var(--chart-2))" strokeWidth={2.5} dot={false} connectNulls isAnimationActive={false} /><Line yAxisId="pulse" type="monotone" dataKey="pulse" stroke="hsl(var(--chart-4))" strokeWidth={1.8} dot={false} connectNulls isAnimationActive={false} />
          </LineChart></ResponsiveContainer> : <EmptyChart />}
        </ChartCard>
        <ChartCard title="Blood glucose" subtitle="mg/dL trend; shaded 70–180 reference band is visual context, not a diagnosis" icon={Droplets} count={glucose.length}>
          {glucose.length ? <ResponsiveContainer width="100%" height="100%"><AreaChart data={glucose} margin={{ top: 6, right: 8, bottom: 4, left: -10 }}>
            <defs><linearGradient id="glucoseFill" x1="0" y1="0" x2="0" y2="1"><stop offset="5%" stopColor="hsl(var(--primary))" stopOpacity={0.42} /><stop offset="95%" stopColor="hsl(var(--primary))" stopOpacity={0.03} /></linearGradient></defs><CartesianGrid strokeDasharray="3 4" stroke="hsl(var(--border))" opacity={0.45} /><XAxis dataKey="time" type="number" domain={["dataMin", "dataMax"]} tickFormatter={shortDate} tick={{ fontSize: 10 }} minTickGap={34} /><YAxis domain={["dataMin - 15", "dataMax + 15"]} tick={{ fontSize: 10 }} width={42} />
            <ReferenceArea y1={70} y2={180} fill="hsl(var(--chart-2))" fillOpacity={0.08} /><ReferenceLine y={70} stroke="hsl(var(--chart-2))" strokeDasharray="4 4" opacity={0.55} /><ReferenceLine y={180} stroke="hsl(var(--chart-2))" strokeDasharray="4 4" opacity={0.55} /><Tooltip contentStyle={tooltipStyle} labelFormatter={fullDate} formatter={(value) => [`${Math.round(Number(value))} mg/dL`, "Glucose"]} /><Area type="monotone" dataKey="glucose" stroke="hsl(var(--primary))" strokeWidth={2.5} fill="url(#glucoseFill)" dot={{ r: 2.5 }} isAnimationActive={false} />
          </AreaChart></ResponsiveContainer> : <EmptyChart />}
        </ChartCard>
        <ChartCard title="Weight and body composition" subtitle="Pounds are primary; body-fat estimates remain source-stamped" icon={Gauge} count={composition.length}>
          {composition.length ? <ResponsiveContainer width="100%" height="100%"><ComposedChart data={composition} margin={{ top: 6, right: -4, bottom: 4, left: -8 }}>
            <CartesianGrid strokeDasharray="3 4" stroke="hsl(var(--border))" opacity={0.45} /><XAxis dataKey="time" type="number" domain={["dataMin", "dataMax"]} tickFormatter={shortDate} tick={{ fontSize: 10 }} minTickGap={34} /><YAxis yAxisId="weight" domain={["dataMin - 3", "dataMax + 3"]} tick={{ fontSize: 10 }} width={45} unit=" lb" /><YAxis yAxisId="fat" orientation="right" domain={["dataMin - 2", "dataMax + 2"]} tick={{ fontSize: 10 }} width={40} unit="%" />
            <Tooltip contentStyle={tooltipStyle} labelFormatter={fullDate} formatter={(value, name) => [name === "weightLb" ? `${Number(value).toFixed(1)} lb` : `${Number(value).toFixed(1)}%`, name === "weightLb" ? "Weight" : "Body fat"]} /><Legend formatter={(value) => value === "weightLb" ? "Weight (lb)" : "Body fat (%)"} /><Line yAxisId="weight" type="monotone" dataKey="weightLb" stroke="hsl(var(--chart-4))" strokeWidth={2.5} dot={{ r: 2.5 }} connectNulls isAnimationActive={false} /><Line yAxisId="fat" type="monotone" dataKey="bodyFat" stroke="hsl(var(--chart-1))" strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
          </ComposedChart></ResponsiveContainer> : <EmptyChart />}
        </ChartCard>
      </div>
    </section>
  );
}
