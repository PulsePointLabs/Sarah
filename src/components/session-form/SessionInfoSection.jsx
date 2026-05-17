import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

// Get today's date in America/New_York
function todayET() {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date());
}

// Get current time HH:MM in America/New_York
function nowTimeET() {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
}

export default function SessionInfoSection({ data, onChange }) {
  const update = (field, value) => onChange({ ...data, [field]: value });

  const handleDurationChange = (field, value) => {
    const hours = field === "dur_hours" ? Number(value) : (data.dur_hours || 0);
    const minutes = field === "dur_minutes" ? Number(value) : (data.dur_minutes || 0);
    const totalMinutes = (field === "dur_hours" ? Number(value) : hours) * 60 + (field === "dur_minutes" ? Number(value) : minutes);
    onChange({ ...data, [field]: Number(value), duration_minutes: totalMinutes });
  };

  // Auto-fill start time with current ET time if not set
  const handleStartTimeFocus = () => {
    if (!data.start_time) update("start_time", nowTimeET());
  };

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-primary">Session Info</h3>

      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="text-xs text-muted-foreground">Date (ET)</Label>
          <Input
            type="date"
            value={data.date?.split("T")[0] || ""}
            onChange={(e) => update("date", e.target.value + "T00:00:00")}
            className="h-12 mt-1"
          />
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">Start Time (ET)</Label>
          <Input
            type="time"
            value={data.start_time || ""}
            onFocus={handleStartTimeFocus}
            onChange={(e) => update("start_time", e.target.value)}
            className="h-12 mt-1 font-mono"
          />
        </div>
      </div>

      <div className="space-y-2">
        <Label className="text-xs text-muted-foreground">Duration</Label>
        <div className="flex items-center gap-3">
          <div className="flex items-center gap-2 flex-1">
            <Input
              type="number"
              min="0"
              max="23"
              placeholder="0"
              value={data.dur_hours ?? ""}
              onChange={(e) => handleDurationChange("dur_hours", e.target.value)}
              className="h-12 font-mono text-center"
            />
            <span className="text-sm text-muted-foreground font-medium">hr</span>
          </div>
          <div className="flex items-center gap-2 flex-1">
            <Input
              type="number"
              min="0"
              max="59"
              placeholder="0"
              value={data.dur_minutes ?? ""}
              onChange={(e) => handleDurationChange("dur_minutes", e.target.value)}
              className="h-12 font-mono text-center"
            />
            <span className="text-sm text-muted-foreground font-medium">min</span>
          </div>
        </div>
        {data.duration_minutes > 0 && (
          <div className="bg-muted rounded-lg px-3 py-2 text-sm font-mono">
            Duration: <span className="text-primary font-bold">{data.duration_minutes} min</span>
          </div>
        )}
      </div>
    </div>
  );
}