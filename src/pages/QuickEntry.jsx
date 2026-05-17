import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/use-toast";
import PageHeader from "../components/PageHeader";
import SliderField from "../components/SliderField";
import MultiSelect from "../components/MultiSelect";
import { Save, Zap } from "lucide-react";

export default function QuickEntry() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [data, setData] = useState({
    date: new Date().toISOString(),
    start_time: new Date().toTimeString().slice(0, 5),
    methods: [],
    intensity: 5,
    max_hr: null,
    is_quick_entry: true,
  });

  const update = (field, value) => setData((d) => ({ ...d, [field]: value }));

  const handleSave = async () => {
    if (!data.methods?.length) {
      toast({ title: "Select at least one method", variant: "destructive" });
      return;
    }
    setSaving(true);
    await base44.entities.Session.create(data);
    toast({ title: "Quick entry saved!", duration: 2000 });
    navigate("/sessions");
  };

  return (
    <div>
      <PageHeader title="Quick Entry" subtitle="Minimal fields for fast logging" />

      <div className="px-4 space-y-6 pb-6">
        <div className="bg-card rounded-xl border border-border p-4 space-y-5">
          <div className="flex items-center gap-2 mb-2">
            <Zap className="w-5 h-5 text-primary" />
            <span className="text-sm font-semibold">Quick Capture</span>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs text-muted-foreground">Time</Label>
              <Input
                type="time"
                value={data.start_time || ""}
                onChange={(e) => update("start_time", e.target.value)}
                className="h-12 mt-1"
              />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Max HR</Label>
              <Input
                type="number"
                placeholder="140"
                value={data.max_hr || ""}
                onChange={(e) => update("max_hr", Number(e.target.value))}
                className="h-12 mt-1 font-mono text-center"
              />
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs text-muted-foreground">Duration (min)</Label>
              <Input
                type="number"
                placeholder="30"
                min="1"
                value={data.duration_minutes || ""}
                onChange={(e) => update("duration_minutes", Number(e.target.value))}
                className="h-12 mt-1 font-mono text-center"
              />
            </div>
            <div />
          </div>

          <SliderField
            label="Intensity"
            value={data.intensity}
            onChange={(v) => update("intensity", v)}
          />

          <div>
            <Label className="text-xs text-muted-foreground mb-2 block">Method</Label>
            <MultiSelect
              selected={data.methods}
              onChange={(v) => update("methods", v)}
            />
          </div>
        </div>

        <Button
          onClick={handleSave}
          disabled={saving}
          className="w-full h-14 text-base font-semibold gap-2"
        >
          <Save className="w-5 h-5" />
          {saving ? "Saving..." : "Save Quick Entry"}
        </Button>
      </div>
    </div>
  );
}