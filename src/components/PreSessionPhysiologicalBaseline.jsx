import { useEffect, useMemo, useState } from "react";
import { Activity, Droplets, Gauge, HeartPulse, Scale, ShieldCheck, Wind } from "lucide-react";
import { base44 } from "@/api/base44Client";
import BodyCompositionSummaryCard from "@/components/BodyCompositionSummaryCard";
import { buildPreSessionBaseline } from "@/lib/preSessionBaseline";

function formatMeasuredAt(value) {
  if (!value) return "time unavailable";
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function Metric({ icon: Icon, label, value, detail, available = true }) {
  return (
    <div className="rounded-xl border border-border bg-muted/20 p-3">
      <div className="flex items-center gap-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        <Icon className="h-3.5 w-3.5 text-primary" /> {label}
      </div>
      <p className={`mt-2 font-mono text-xl font-bold ${available ? "text-foreground" : "text-muted-foreground"}`}>
        {available ? value : "Not recorded"}
      </p>
      <p className="mt-1 text-[11px] leading-4 text-muted-foreground">{detail}</p>
    </div>
  );
}

export default function PreSessionPhysiologicalBaseline({
  record,
  timelineRows = [],
  sectionId = "pre-session-physiological-baseline",
}) {
  const [globalReadings, setGlobalReadings] = useState({
    bodyComposition: [],
    glucose: [],
    bloodPressure: [],
  });

  useEffect(() => {
    let cancelled = false;
    Promise.all([
      base44.entities.BodyCompositionReading.list("-measured_at", 500).catch(() => []),
      base44.entities.BloodGlucoseReading.list("-measured_at", 1000).catch(() => []),
      base44.entities.BloodPressureReading.list("-measured_at", 500).catch(() => []),
    ]).then(([bodyComposition, glucose, bloodPressure]) => {
      if (!cancelled) setGlobalReadings({ bodyComposition, glucose, bloodPressure });
    });
    return () => {
      cancelled = true;
    };
  }, [record?.id]);

  const baseline = useMemo(() => buildPreSessionBaseline({
    record,
    timelineRows,
    bodyCompositionReadings: globalReadings.bodyComposition,
    bloodGlucoseReadings: globalReadings.glucose,
    bloodPressureReadings: globalReadings.bloodPressure,
  }), [globalReadings, record, timelineRows]);

  const glucose = baseline.glucose;
  const bp = baseline.bloodPressure;
  const pulseOx = baseline.pulseOx;
  const telemetry = baseline.telemetry;
  const context = record?.session_context || {};
  const contextBits = [
    context.fatigue && context.fatigue !== "unknown" ? `fatigue ${String(context.fatigue).replaceAll("_", " ")}` : null,
    context.hydration_state && context.hydration_state !== "unknown" ? `hydration ${String(context.hydration_state).replaceAll("_", " ")}` : null,
    context.food_state && context.food_state !== "unknown" ? `food ${String(context.food_state).replaceAll("_", " ")}` : null,
  ].filter(Boolean);

  return (
    <details id={sectionId} className="scroll-mt-24 rounded-xl border border-primary/20 bg-card">
      <summary className="cursor-pointer list-none p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-primary">
              <ShieldCheck className="h-4 w-4" /> Pre-Session Physiological Baseline
            </h3>
            <p className="mt-1 text-sm text-muted-foreground">
              Body composition and the closest measured context available before the session, with opening-window telemetry clearly labeled.
            </p>
          </div>
          <span className="rounded-full border border-primary/20 bg-primary/10 px-3 py-1 text-xs font-semibold text-primary">
            {baseline.sourceCount} measured source{baseline.sourceCount === 1 ? "" : "s"}
          </span>
        </div>
      </summary>

      <div className="space-y-4 border-t border-border p-4">
        <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
          <Metric
            icon={Droplets}
            label="Blood Glucose"
            value={glucose ? `${Math.round(Number(glucose.glucose_mg_dl))} mg/dL` : ""}
            detail={glucose ? `${baseline.glucoseRelation} · ${formatMeasuredAt(glucose.measured_at)} · ${glucose.source_app || "saved reading"}` : "No reading within 24 hours before the session or its opening window."}
            available={Boolean(glucose)}
          />
          <Metric
            icon={Gauge}
            label="Blood Pressure"
            value={bp ? `${Math.round(Number(bp.systolic_mm_hg))}/${Math.round(Number(bp.diastolic_mm_hg))}` : ""}
            detail={bp ? `${baseline.bloodPressureRelation} · ${formatMeasuredAt(bp.measured_at)}${bp.pulse_bpm ? ` · pulse ${Math.round(Number(bp.pulse_bpm))} bpm` : ""}` : "No reading within eight hours before the session or its opening window."}
            available={Boolean(bp)}
          />
          <Metric
            icon={HeartPulse}
            label="Opening HR"
            value={telemetry.openingHrBpm != null ? `${telemetry.openingHrBpm} bpm` : ""}
            detail={telemetry.openingHrBpm != null ? `Average of the first minute · saved baseline ${telemetry.baselineHrBpm ?? "unavailable"} bpm` : "No valid first-minute heart-rate samples."}
            available={telemetry.openingHrBpm != null}
          />
          <Metric
            icon={Activity}
            label="Opening HRV"
            value={telemetry.openingRmssdMs != null ? `${telemetry.openingRmssdMs} ms` : ""}
            detail={telemetry.openingRmssdMs != null ? `RMSSD median · SDNN ${telemetry.openingSdnnMs ?? "unavailable"} ms · first minute` : "No moderate/high-quality first-minute HRV evidence."}
            available={telemetry.openingRmssdMs != null}
          />
          <Metric
            icon={Wind}
            label="Opening SpO2"
            value={pulseOx ? `${Math.round(Number(pulseOx.spo2_percent))}%` : ""}
            detail={pulseOx ? `${baseline.pulseOxRelation} · ${formatMeasuredAt(pulseOx.measured_at)}${pulseOx.pulse_bpm ? ` · pulse ${Math.round(Number(pulseOx.pulse_bpm))} bpm` : ""}` : "No pulse-ox sample in the opening five-minute window."}
            available={Boolean(pulseOx)}
          />
          <Metric
            icon={Scale}
            label="Body Composition"
            value={baseline.composition?.weight_kg != null ? `${Number(baseline.composition.weight_kg).toFixed(1)} kg` : ""}
            detail={baseline.composition ? `${baseline.compositionRelation} · ${formatMeasuredAt(baseline.composition.measured_at)} · ${baseline.composition.source_app || "saved weigh-in"}` : "No attached or prior weigh-in from the preceding 45 days."}
            available={Boolean(baseline.composition)}
          />
        </div>

        {contextBits.length > 0 && (
          <div className="rounded-lg border border-border bg-muted/15 px-3 py-2 text-xs text-muted-foreground">
            <span className="font-semibold text-foreground">Logged starting context:</span> {contextBits.join(" · ")}
          </div>
        )}

        {baseline.composition && (
          <BodyCompositionSummaryCard
            reading={baseline.composition}
            title={`Body Composition (${baseline.compositionRelation})`}
            compact
          />
        )}

        <p className="text-[11px] leading-5 text-muted-foreground">
          This is a provenance-preserving baseline snapshot, not a claim that any one measurement caused the session response. Smart-scale composition remains a trend estimate.
        </p>
      </div>
    </details>
  );
}
