import { Droplets } from "lucide-react";
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { summarizeBloodGlucose } from "@/lib/bloodGlucose";

export default function BloodGlucoseSessionCard({ record, sectionId = "session-blood-glucose" }) {
  const readings = Array.isArray(record?.blood_glucose_readings) ? record.blood_glucose_readings : [];
  const summary = summarizeBloodGlucose(readings);
  if (!summary) return null;
  const chart = readings.map((reading) => ({
    ...reading,
    label: new Date(reading.measured_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }),
    value: Number(reading.glucose_mg_dl),
  }));
  return (
    <section id={sectionId} className="scroll-mt-24 rounded-xl border border-border bg-card p-4">
      <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-primary">
        <Droplets className="h-4 w-4" /> Blood Glucose
      </h3>
      <p className="mt-1 text-sm text-muted-foreground">OneTouch readings captured inside this session’s local start/end window.</p>
      <div className="mt-4 grid grid-cols-2 gap-2 sm:grid-cols-4">
        {[
          ["Latest", summary.latest.glucose_mg_dl],
          ["Average", summary.averageMgDl],
          ["Minimum", summary.minMgDl],
          ["Maximum", summary.maxMgDl],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg bg-muted/25 p-3">
            <p className="font-mono text-2xl font-bold">{value}</p>
            <p className="text-xs text-muted-foreground">{label} mg/dL</p>
          </div>
        ))}
      </div>
      {readings.length > 1 && (
        <div className="mt-4 h-44">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chart} margin={{ top: 8, right: 12, bottom: 0, left: -18 }}>
              <XAxis dataKey="label" tick={{ fontSize: 10 }} />
              <YAxis domain={["dataMin - 10", "dataMax + 10"]} tick={{ fontSize: 10 }} />
              <Tooltip formatter={(value) => [`${value} mg/dL`, "Glucose"]} />
              <Line type="monotone" dataKey="value" stroke="hsl(var(--primary))" strokeWidth={2.5} dot />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </section>
  );
}
