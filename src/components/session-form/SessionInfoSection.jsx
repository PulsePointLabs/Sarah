import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { CalendarDays, Clock3, Timer, FileCheck2 } from "lucide-react";

// Get current time HH:MM in America/New_York
function nowTimeET() {
  return new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date());
}

export default function SessionInfoSection({ data, onChange }) {
  const update = (field, value) => onChange({ ...data, [field]: value });
  const hasHrTiming = (data._csv_rows || []).length > 0;
  const dateValue = data.date?.split("T")[0] || "";
  const durationMinutes = Number(data.duration_minutes || 0);
  const durationLabel = durationMinutes > 0
    ? durationMinutes >= 60
      ? `${Math.floor(durationMinutes / 60)}h ${durationMinutes % 60}m`
      : `${durationMinutes}m`
    : "Not set";

  const handleDurationChange = (field, value) => {
    const hours = field === "dur_hours" ? Number(value) : (data.dur_hours || 0);
    const minutes = field === "dur_minutes" ? Number(value) : (data.dur_minutes || 0);
    const totalMinutes = (field === "dur_hours" ? Number(value) : hours) * 60 + (field === "dur_minutes" ? Number(value) : minutes);
    onChange({ ...data, [field]: Number(value), duration_minutes: totalMinutes });
  };

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-primary">Session Info</h3>

      {hasHrTiming && (
        <div className="rounded-lg border border-primary/30 bg-primary/10 p-3 space-y-3">
          <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wide text-primary">
            <FileCheck2 className="w-4 h-4" />
            Detected from HR CSV
          </div>
          <div className="grid gap-2 text-xs sm:grid-cols-3">
            <div className="rounded-md bg-background/60 p-2">
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <CalendarDays className="w-3.5 h-3.5" />
                Date
              </div>
              <p className="mt-1 font-mono font-semibold text-foreground">{dateValue || "Not set"}</p>
            </div>
            <div className="rounded-md bg-background/60 p-2">
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Clock3 className="w-3.5 h-3.5" />
                Start
              </div>
              <p className="mt-1 font-mono font-semibold text-foreground">{data.start_time || "Not set"}</p>
            </div>
            <div className="rounded-md bg-background/60 p-2">
              <div className="flex items-center gap-1.5 text-muted-foreground">
                <Timer className="w-3.5 h-3.5" />
                Duration
              </div>
              <p className="mt-1 font-mono font-semibold text-foreground">{durationLabel}</p>
            </div>
          </div>
          <p className="text-[11px] text-muted-foreground">
            These stay editable below for corrections, but the HR file is now filling them in first.
          </p>
        </div>
      )}

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
          <div className="flex items-center justify-between">
            <Label className="text-xs text-muted-foreground">Start Time (ET)</Label>
            <Button type="button" variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => update("start_time", nowTimeET())}>
              Now
            </Button>
          </div>
          <Input type="time" value={data.start_time || ""} onChange={(e) => update("start_time", e.target.value)} className="h-12 mt-1 font-mono" />
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
