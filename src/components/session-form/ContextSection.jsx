import { useState } from "react";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Activity, Loader2 } from "lucide-react";
import {
  findBloodPressureNearSession,
  formatBloodPressure,
  formatBloodPressureTime,
} from "@/lib/bloodPressure";
import {
  CANNABIS_ROUTE_OPTIONS,
  FATIGUE_OPTIONS,
  FOOD_OPTIONS,
  HYDRATION_OPTIONS,
  LEVEL_OPTIONS,
  MENTAL_STATE_OPTIONS,
  PREPARATION_OPTIONS,
  PRIVACY_OPTIONS,
  TIMING_OPTIONS,
} from "@/lib/sessionContext";

function ContextSelect({ label, value, placeholder, options, onValueChange }) {
  return (
    <div>
      <Label className="text-xs text-muted-foreground">{label}</Label>
      <Select value={value || "unknown"} onValueChange={onValueChange}>
        <SelectTrigger className="mt-1 h-12"><SelectValue placeholder={placeholder} /></SelectTrigger>
        <SelectContent>
          {options.map((option) => (
            <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
          ))}
        </SelectContent>
      </Select>
    </div>
  );
}

function ChoiceChips({ options, selected, onToggle }) {
  return (
    <div className="mt-2 flex flex-wrap gap-2">
      {options.map((option) => {
        const active = selected.includes(option.value);
        return (
          <button
            key={option.value}
            type="button"
            onClick={() => onToggle(option.value)}
            className={`rounded-full border px-3 py-1.5 text-xs font-medium transition-colors ${active ? "border-primary bg-primary/15 text-primary" : "border-border text-muted-foreground hover:text-foreground"}`}
          >
            {option.label}
          </button>
        );
      })}
    </div>
  );
}

export default function ContextSection({ data, onChange }) {
  const context = data.session_context || {};
  const [bpStatus, setBpStatus] = useState("");
  const [bpLoading, setBpLoading] = useState(false);
  const updateLegacy = (field, value) => onChange({ ...data, [field]: value });
  const updateContext = (patch) => onChange({ ...data, session_context: { ...context, ...patch } });
  const updateNested = (field, patch) => updateContext({ [field]: { ...(context[field] || {}), ...patch } });

  const setSubstanceStatus = (field, value) => {
    if (value === "unrecorded") {
      const nextContext = { ...context };
      delete nextContext[field];
      onChange({ ...data, session_context: nextContext });
    } else if (value === "no") {
      updateContext({ [field]: { used: false } });
    } else {
      updateContext({ [field]: { ...(context[field] || {}), used: true } });
    }
  };
  const substanceStatus = (field) => (
    context[field]?.used === true ? "yes" : context[field]?.used === false ? "no" : "unrecorded"
  );
  const toggleArray = (field, value) => {
    const current = Array.isArray(context[field]) ? context[field] : [];
    updateContext({ [field]: current.includes(value) ? current.filter((item) => item !== value) : [...current, value] });
  };

  const attachNearestBloodPressure = async () => {
    if (!data?.id) {
      setBpStatus("Save the session once before attaching nearby BP from the local vitals history.");
      return;
    }
    setBpLoading(true);
    setBpStatus("");
    try {
      const result = await findBloodPressureNearSession(data.id);
      if (!result.nearest) {
        setBpStatus("No BP readings found within the session window.");
        return;
      }
      updateContext({
        blood_pressure: {
          reading_id: result.nearest.id,
          measured_at: result.nearest.measured_at,
          systolic_mm_hg: result.nearest.systolic_mm_hg,
          diastolic_mm_hg: result.nearest.diastolic_mm_hg,
          pulse_bpm: result.nearest.pulse_bpm ?? null,
          source_app: result.nearest.source_app || "Health Connect",
          source_device: result.nearest.source_device || "",
          relationship: "nearest_session_reading",
        },
      });
      setBpStatus(`Attached ${formatBloodPressure(result.nearest)} from ${formatBloodPressureTime(result.nearest.measured_at)}.`);
    } catch (error) {
      setBpStatus(error?.message || "Could not attach nearby BP.");
    } finally {
      setBpLoading(false);
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h3 className="text-sm font-semibold uppercase tracking-wider text-primary">Session Context</h3>
        <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
          Optional explicit context helps the AI interpret this session without guessing. Anything not entered remains unknown.
        </p>
      </div>

      <div className="space-y-3">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-foreground">Physiological State</h4>
        <div className="grid gap-3 md:grid-cols-3">
          <ContextSelect label="Fatigue" value={context.fatigue} options={FATIGUE_OPTIONS} onValueChange={(value) => updateContext({ fatigue: value })} />
          <ContextSelect label="Hydration" value={context.hydration_state} options={HYDRATION_OPTIONS} onValueChange={(value) => updateContext({ hydration_state: value })} />
          <ContextSelect label="Food State" value={context.food_state} options={FOOD_OPTIONS} onValueChange={(value) => updateContext({ food_state: value })} />
        </div>
        {!context.hydration_state && data.hydration && (
          <p className="text-[11px] text-muted-foreground">Existing saved hydration entry: {data.hydration}. It remains available as legacy context until a structured hydration value is selected.</p>
        )}
        <div className="rounded-lg border border-border bg-muted/10 p-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <Label className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Blood Pressure</Label>
              <p className="mt-1 text-sm text-muted-foreground">
                {context.blood_pressure
                  ? `${formatBloodPressure(context.blood_pressure)} · ${formatBloodPressureTime(context.blood_pressure.measured_at)}`
                  : "Optional nearby BP context from the local Health Connect/Samsung Health vitals history."}
              </p>
            </div>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={attachNearestBloodPressure}
              disabled={bpLoading}
              className="gap-1.5"
            >
              {bpLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Activity className="h-3.5 w-3.5" />}
              Attach nearest
            </Button>
          </div>
          {bpStatus && <p className="mt-2 text-xs text-muted-foreground">{bpStatus}</p>}
        </div>
      </div>

      <div className="space-y-4 rounded-lg border border-border bg-muted/10 p-3">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-foreground">Substances</h4>
        <div className="space-y-3">
          <div className="grid gap-3 md:grid-cols-3">
            <ContextSelect
              label="Alcohol"
              value={substanceStatus("alcohol")}
              options={[{ value: "unrecorded", label: "Not recorded" }, { value: "no", label: "No" }, { value: "yes", label: "Yes" }]}
              onValueChange={(value) => setSubstanceStatus("alcohol", value)}
            />
            {context.alcohol?.used && (
              <>
                <ContextSelect label="Alcohol Timing" value={context.alcohol.timing_relative_to_session} options={TIMING_OPTIONS} onValueChange={(value) => updateNested("alcohol", { timing_relative_to_session: value })} />
                <ContextSelect label="Alcohol Level" value={context.alcohol.qualitative_level} options={LEVEL_OPTIONS} onValueChange={(value) => updateNested("alcohol", { qualitative_level: value })} />
              </>
            )}
          </div>
          <div className="grid gap-3 md:grid-cols-4">
            <ContextSelect
              label="Cannabis / THC"
              value={substanceStatus("cannabis")}
              options={[{ value: "unrecorded", label: "Not recorded" }, { value: "no", label: "No" }, { value: "yes", label: "Yes" }]}
              onValueChange={(value) => setSubstanceStatus("cannabis", value)}
            />
            {context.cannabis?.used && (
              <>
                <ContextSelect label="Route" value={context.cannabis.route} options={CANNABIS_ROUTE_OPTIONS} onValueChange={(value) => updateNested("cannabis", { route: value })} />
                <ContextSelect label="Timing" value={context.cannabis.timing_relative_to_session} options={TIMING_OPTIONS} onValueChange={(value) => updateNested("cannabis", { timing_relative_to_session: value })} />
                <ContextSelect label="Level" value={context.cannabis.qualitative_level} options={LEVEL_OPTIONS} onValueChange={(value) => updateNested("cannabis", { qualitative_level: value })} />
              </>
            )}
          </div>
        </div>
      </div>

      <div className="space-y-4">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-foreground">Mental / Environmental Context</h4>
        <div>
          <Label className="text-xs text-muted-foreground">Mental State</Label>
          <ChoiceChips options={MENTAL_STATE_OPTIONS} selected={context.mental_state || []} onToggle={(value) => toggleArray("mental_state", value)} />
        </div>
        <ContextSelect label="Privacy / Interruption Risk" value={context.privacy_interruptibility} options={PRIVACY_OPTIONS} onValueChange={(value) => updateContext({ privacy_interruptibility: value })} />
        <div>
          <Label className="text-xs text-muted-foreground">Environmental Preparation</Label>
          <ChoiceChips options={PREPARATION_OPTIONS} selected={context.environmental_preparation || []} onToggle={(value) => toggleArray("environmental_preparation", value)} />
        </div>
      </div>

      <div className="space-y-3 rounded-lg border border-border bg-muted/10 p-3">
        <h4 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Existing General Context</h4>
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <Label className="text-xs text-muted-foreground">Mood Before</Label>
            <Select value={data.mood || ""} onValueChange={(value) => updateLegacy("mood", value)}>
              <SelectTrigger className="mt-1 h-12"><SelectValue placeholder="Select mood" /></SelectTrigger>
              <SelectContent>
                {["relaxed", "stressed", "neutral", "excited", "tired", "anxious"].map((value) => (
                  <SelectItem key={value} value={value} className="capitalize">{value}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Environment</Label>
            <Select value={data.environment || ""} onValueChange={(value) => updateLegacy("environment", value)}>
              <SelectTrigger className="mt-1 h-12"><SelectValue placeholder="Select" /></SelectTrigger>
              <SelectContent>
                {["private", "clinical", "experimental", "other"].map((value) => (
                  <SelectItem key={value} value={value} className="capitalize">{value}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
      </div>
    </div>
  );
}
