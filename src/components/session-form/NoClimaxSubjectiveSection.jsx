import SliderField from "../SliderField";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

const BUILD_TYPES = ["Gradual", "Stepwise", "Spike", "Plateau-heavy", "Erratic", "Other"];
const STOP_REASONS = [
  "Deliberate stop",
  "Time constraint",
  "Fatigue",
  "Loss of arousal",
  "Stimulation mismatch",
  "Technical interruption",
  "Physical discomfort",
  "Partner/context interruption",
  "Other",
];

function ScaleHint({ ranges }) {
  return (
    <div className="rounded-lg bg-muted px-3 py-2 space-y-0.5">
      {ranges.map(({ range, label }) => (
        <p key={range} className="text-[11px] text-muted-foreground">
          <span className="font-mono font-semibold text-foreground">{range}:</span> {label}
        </p>
      ))}
    </div>
  );
}

function SectionLabel({ title, subtitle }) {
  return (
    <div className="space-y-1">
      <h4 className="text-xs font-semibold uppercase tracking-wider text-foreground">{title}</h4>
      {subtitle && <p className="text-[11px] text-muted-foreground">{subtitle}</p>}
    </div>
  );
}

function MetricSlider({ data, field, label, onUpdate }) {
  return (
    <SliderField
      label={label}
      value={data[field] ?? 5}
      onChange={(v) => onUpdate(field, v)}
    />
  );
}

export default function NoClimaxSubjectiveSection({ data, onChange }) {
  const update = (field, value) => onChange({ ...data, [field]: value });

  return (
    <div className="space-y-5">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-primary">Subjective Metrics</h3>
      <p className="text-xs text-muted-foreground -mt-2">Rating arousal and experience quality (no climax reached)</p>

      <div className="space-y-4">
        <SectionLabel title="Peak State" subtitle="Captures how close the session came, even without climax." />
        <MetricSlider data={data} field="intensity" label="Peak Arousal Level" onUpdate={update} />
        <MetricSlider data={data} field="arousal_depth" label="Arousal Depth" onUpdate={update} />
        <MetricSlider data={data} field="sustainability" label="Arousal Sustainability" onUpdate={update} />
        <ScaleHint ranges={[
          { range: "1–3", label: "Low arousal, minimal response, or difficult to sustain" },
          { range: "4–6", label: "Moderate arousal, partial buildup, some instability" },
          { range: "7–10", label: "High arousal, strong buildup, close or highly sustained" },
        ]} />
      </div>

      <div className="space-y-3">
        <SectionLabel title="Build Mechanics" subtitle="How the arousal arc behaved before stopping." />
        <SliderField
          label="Build Quality"
          value={data.build_quality ?? 5}
          onChange={(v) => update("build_quality", v)}
        />
        <p className="text-[11px] text-muted-foreground italic">
          How smooth and progressive did the buildup feel?
        </p>
        <ScaleHint ranges={[
          { range: "1–3", label: "Disjointed, choppy, or hard to sustain" },
          { range: "4–6", label: "Moderate flow, some interruptions" },
          { range: "7–10", label: "Smooth, continuous, and progressive" },
        ]} />
      </div>

      <div className="space-y-2">
        <Label className="text-xs text-muted-foreground">Build Type</Label>
        <Select value={data.build_type || ""} onValueChange={(v) => update("build_type", v)}>
          <SelectTrigger className="h-12"><SelectValue placeholder="How did arousal progress?" /></SelectTrigger>
          <SelectContent>
            {BUILD_TYPES.map((t) => <SelectItem key={t} value={t}>{t}</SelectItem>)}
          </SelectContent>
        </Select>
        {data.build_type === "Other" && (
          <Input
            value={data.custom_build_type || ""}
            onChange={(e) => update("custom_build_type", e.target.value)}
            placeholder="Describe your build type..."
            className="h-10"
          />
        )}
      </div>

      <div className="space-y-4">
        <SectionLabel title="Response Quality" subtitle="Optional fields that make no-climax sessions more analytically useful." />
        <div className="grid gap-5 md:grid-cols-2">
          <MetricSlider data={data} field="stimulation_fit" label="Stimulation Fit" onUpdate={update} />
          <MetricSlider data={data} field="erection_stability" label="Erection / Response Stability" onUpdate={update} />
          <MetricSlider data={data} field="control" label="Edge / Control Quality" onUpdate={update} />
          <MetricSlider data={data} field="sensory_immersion" label="Sensory Immersion" onUpdate={update} />
        </div>
      </div>

      <div className="space-y-4">
        <SectionLabel title="Outcome Without Climax" subtitle="Separates a useful no-climax session from a frustrating one." />
        <MetricSlider data={data} field="satisfaction" label="Satisfaction Without Climax" onUpdate={update} />
        <MetricSlider data={data} field="discomfort_interference" label="Discomfort / Interruption Impact" onUpdate={update} />
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">Why It Stopped</Label>
          <Select value={data.no_climax_stop_reason || ""} onValueChange={(v) => update("no_climax_stop_reason", v)}>
            <SelectTrigger className="h-12"><SelectValue placeholder="Primary reason" /></SelectTrigger>
            <SelectContent>
              {STOP_REASONS.map((reason) => <SelectItem key={reason} value={reason}>{reason}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">Barrier to Completion</Label>
          <Textarea
            value={data.barrier_to_completion || ""}
            onChange={(e) => update("barrier_to_completion", e.target.value)}
            placeholder="What seemed to prevent completion?"
            className="min-h-24 resize-none"
          />
        </div>
      </div>
    </div>
  );
}
