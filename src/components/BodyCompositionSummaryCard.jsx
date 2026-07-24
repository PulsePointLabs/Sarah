import { Activity, Scale } from "lucide-react";
import { formatCompositionTime, formatWeightKg } from "@/lib/bodyComposition";

const METRICS = [
  ["Body fat", "body_fat_percent", "%", 1],
  ["BMI", "bmi", "", 1],
  ["Lean mass", "lean_body_mass_kg", " kg", 1],
  ["Fat-free weight", "fat_free_body_weight_kg", " kg", 1],
  ["Muscle mass", "muscle_mass_kg", " kg", 1],
  ["Body water", "body_water_percent", "%", 1],
  ["Body water", "body_water_mass_kg", " kg", 1],
  ["Bone mass", "bone_mass_kg", " kg", 1],
  ["Skeletal muscle", "skeletal_muscle_percent", "%", 1],
  ["Visceral fat", "visceral_fat", "", 1],
  ["Subcutaneous fat", "subcutaneous_fat_percent", "%", 1],
  ["Protein", "protein_percent", "%", 1],
  ["BMR", "basal_metabolic_rate_kcal_day", " kcal/day", 0],
  ["Metabolic age", "metabolic_age", "", 0],
];

export default function BodyCompositionSummaryCard({ reading, title = "Body Composition", compact = false }) {
  if (!reading) return null;
  const available = METRICS.filter(([, field]) => (
    reading[field] != null
    && reading[field] !== ""
    && Number.isFinite(Number(reading[field]))
  ));
  return (
    <section className="rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-primary">
            <Scale className="h-4 w-4" /> {title}
          </h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {formatCompositionTime(reading.measured_at)}
            {reading.source_app ? ` · ${reading.source_app}` : ""}
          </p>
        </div>
        <div className="text-right">
          <p className="font-mono text-2xl font-bold text-foreground">{formatWeightKg(reading.weight_kg)}</p>
          {reading.measurement_relation && <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{reading.measurement_relation}</p>}
        </div>
      </div>
      {available.length > 0 && (
        <div className={`mt-4 grid gap-2 ${compact ? "grid-cols-2 sm:grid-cols-3" : "grid-cols-2 sm:grid-cols-3 lg:grid-cols-4"}`}>
          {available.map(([label, field, suffix, precision]) => (
            <div key={field} className="rounded-lg border border-border bg-muted/20 px-3 py-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
              <p className="mt-1 font-mono text-base font-semibold text-foreground">
                {Number(reading[field]).toFixed(precision)}{suffix}
              </p>
            </div>
          ))}
        </div>
      )}
      <p className="mt-3 flex items-start gap-1.5 text-[10px] leading-4 text-muted-foreground">
        <Activity className="mt-0.5 h-3 w-3 shrink-0" />
        Scale composition values are trend estimates. Sarah preserves the source and measurement time rather than treating them as direct session effects.
      </p>
    </section>
  );
}
