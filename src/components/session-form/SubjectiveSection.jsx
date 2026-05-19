import SliderField from "../SliderField";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";

const BUILD_TYPES = ["Gradual", "Stepwise", "Spike", "Plateau-heavy", "Erratic", "Other"];
const LIMITING_FACTORS = [
  "None / clean session",
  "Erection variability",
  "Stimulation mismatch",
  "Loss of focus",
  "Physical discomfort",
  "Fatigue",
  "Technical interruption",
  "Time constraint",
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

export default function SubjectiveSection({ data, onChange }) {
  const update = (field, value) => onChange({ ...data, [field]: value });

  return (
    <div className="space-y-5">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-primary">Subjective Metrics</h3>

      <div className="space-y-4">
        <SectionLabel
          title="Outcome"
          subtitle="The legacy fields stay intact, but the labels now separate intensity from satisfaction."
        />
        <MetricSlider data={data} field="intensity" label="Peak Intensity" onUpdate={update} />
        <MetricSlider data={data} field="satisfaction" label="Overall Satisfaction" onUpdate={update} />
        <MetricSlider data={data} field="release_completeness" label="Release Completeness" onUpdate={update} />
        <ScaleHint ranges={[
          { range: "1–3", label: "Partial, muted, interrupted, or incomplete release" },
          { range: "4–6", label: "Clear release, but not fully satisfying or integrated" },
          { range: "7–10", label: "Full, clean, complete release with strong resolution" },
        ]} />
      </div>

      <div className="space-y-3">
        <SectionLabel
          title="Build Mechanics"
          subtitle="How the arousal arc behaved before the peak."
        />
        <SliderField
          label="Build Quality"
          value={data.build_quality ?? 5}
          onChange={(v) => update("build_quality", v)}
        />
        <p className="text-[11px] text-muted-foreground italic">
          How smooth, progressive, and sustained did the buildup feel before climax?
        </p>
        <ScaleHint ranges={[
          { range: "1–3", label: "Disjointed, choppy, rushed, or hard to sustain" },
          { range: "4–6", label: "Moderate flow, some interruptions or inconsistency" },
          { range: "7–10", label: "Smooth, continuous, progressive, and sustained buildup" },
        ]} />
      </div>

      <div className="space-y-2">
        <Label className="text-xs text-muted-foreground">Build Type</Label>
        <Select value={data.build_type || ""} onValueChange={(v) => update("build_type", v)}>
          <SelectTrigger className="h-12"><SelectValue placeholder="How did the buildup progress?" /></SelectTrigger>
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
        <SectionLabel
          title="Response Quality"
          subtitle="Optional fields that make the later AI analysis more specific."
        />
        <div className="grid gap-5 md:grid-cols-2">
          <MetricSlider data={data} field="arousal_depth" label="Arousal Depth" onUpdate={update} />
          <MetricSlider data={data} field="erection_stability" label="Erection / Response Stability" onUpdate={update} />
          <MetricSlider data={data} field="stimulation_fit" label="Stimulation Fit" onUpdate={update} />
          <MetricSlider data={data} field="control" label="Edge / Control Quality" onUpdate={update} />
          <MetricSlider data={data} field="sensory_immersion" label="Sensory Immersion" onUpdate={update} />
          <MetricSlider data={data} field="recovery_quality" label="Recovery / Afterglow Quality" onUpdate={update} />
        </div>
      </div>

      <div>
        <Label className="text-xs text-muted-foreground">Climax Duration</Label>
        <Select value={data.climax_duration || ""} onValueChange={(v) => update("climax_duration", v)}>
          <SelectTrigger className="h-12 mt-1"><SelectValue placeholder="Select duration" /></SelectTrigger>
          <SelectContent>
            <SelectItem value="short">Short</SelectItem>
            <SelectItem value="medium">Medium</SelectItem>
            <SelectItem value="long">Long</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <div className="space-y-3">
        <SectionLabel title="Friction Points" subtitle="Useful for separating high intensity from lower satisfaction." />
        <MetricSlider data={data} field="discomfort_interference" label="Discomfort / Interruption Impact" onUpdate={update} />
        <ScaleHint ranges={[
          { range: "1–3", label: "Little to no interference" },
          { range: "4–6", label: "Noticeable but manageable" },
          { range: "7–10", label: "Strongly shaped or limited the session" },
        ]} />
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">Primary Limiting Factor</Label>
          <Select value={data.primary_limiting_factor || ""} onValueChange={(v) => update("primary_limiting_factor", v)}>
            <SelectTrigger className="h-12"><SelectValue placeholder="What most affected the outcome?" /></SelectTrigger>
            <SelectContent>
              {LIMITING_FACTORS.map((factor) => <SelectItem key={factor} value={factor}>{factor}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label className="text-xs text-muted-foreground">Subjective Notes</Label>
          <Textarea
            value={data.subjective_notes || ""}
            onChange={(e) => update("subjective_notes", e.target.value)}
            placeholder="Anything the numbers do not capture..."
            className="min-h-24 resize-none"
          />
        </div>
      </div>
    </div>
  );
}
