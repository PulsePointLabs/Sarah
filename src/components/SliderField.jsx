import { Slider } from "@/components/ui/slider";
import { Label } from "@/components/ui/label";

export default function SliderField({ label, value, onChange, min = 1, max = 10 }) {
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <Label className="text-sm font-medium">{label}</Label>
        <span className="text-lg font-bold font-mono text-primary">{value || min}</span>
      </div>
      <Slider
        min={min}
        max={max}
        step={1}
        value={[value || min]}
        onValueChange={([v]) => onChange(v)}
        className="touch-none"
      />
      <div className="flex justify-between text-[10px] text-muted-foreground">
        <span>{min}</span>
        <span>{max}</span>
      </div>
    </div>
  );
}