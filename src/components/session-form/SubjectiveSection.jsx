import SliderField from "../SliderField";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

const BUILD_TYPES = ["Gradual", "Stepwise", "Spike", "Plateau-heavy", "Erratic", "Other"];

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

export default function SubjectiveSection({ data, onChange }) {
  const update = (field, value) => onChange({ ...data, [field]: value });

  return (
    <div className="space-y-5">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-primary">Subjective Metrics</h3>

      <SliderField
        label="Intensity of Climax"
        value={data.intensity}
        onChange={(v) => update("intensity", v)}
      />

      {/* Build Quality */}
      <div className="space-y-3">
        <SliderField
          label="Build Quality"
          value={data.build_quality}
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

      {/* Build Type */}
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

      <SliderField
        label="Satisfaction"
        value={data.satisfaction}
        onChange={(v) => update("satisfaction", v)}
      />
    </div>
  );
}