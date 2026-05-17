import { useState } from "react";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Button } from "@/components/ui/button";
import { Plus, Trash2 } from "lucide-react";

export default function PhysiologicalSection({ data, onChange }) {
  const noClimax = !!data.no_climax;
  const update = (field, value) => onChange({ ...data, [field]: value });
  const discomfortEntries = data.discomfort_entries || [];
  const [noteInput, setNoteInput] = useState("");
  const [severityInput, setSeverityInput] = useState("5");

  const addEntry = () => {
    if (!noteInput.trim()) return;
    const entry = { severity: parseInt(severityInput, 10), note: noteInput.trim() };
    onChange({ ...data, discomfort_entries: [...discomfortEntries, entry], discomfort: true });
    setNoteInput("");
    setSeverityInput("5");
  };

  const removeEntry = (idx) => {
    const next = discomfortEntries.filter((_, i) => i !== idx);
    onChange({ ...data, discomfort_entries: next, discomfort: next.length > 0 });
  };

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-primary">Physiological Notes</h3>

      <div>
        <Label className="text-xs text-muted-foreground">Unusual Sensations</Label>
        <Textarea
          value={data.unusual_sensations || ""}
          onChange={(e) => update("unusual_sensations", e.target.value)}
          placeholder="Describe any unusual sensations..."
          rows={2}
          className="mt-1"
        />
      </div>

      {!noClimax && (
        <div>
          <Label className="text-xs text-muted-foreground">Refractory Period Notes</Label>
          <Textarea
            value={data.refractory_notes || ""}
            onChange={(e) => update("refractory_notes", e.target.value)}
            placeholder="Recovery time, sensations after..."
            rows={2}
            className="mt-1"
          />
        </div>
      )}

      {!noClimax && (
        <div>
          <Label className="text-xs text-muted-foreground">Ejaculate Volume</Label>
          <Select value={data.ejaculate_volume || ""} onValueChange={(v) => update("ejaculate_volume", v)}>
            <SelectTrigger className="h-12 mt-1"><SelectValue placeholder="Select" /></SelectTrigger>
            <SelectContent>
              <SelectItem value="low">Low</SelectItem>
              <SelectItem value="normal">Normal</SelectItem>
              <SelectItem value="high">High</SelectItem>
            </SelectContent>
          </Select>
        </div>
      )}

      <div>
        <Label className="text-xs text-muted-foreground mb-2 block">Discomfort Log</Label>

        {discomfortEntries.length > 0 && (
          <div className="space-y-1.5 mb-3">
            {discomfortEntries.map((entry, i) => (
              <div key={i} className="flex items-start gap-2 bg-muted/50 rounded-lg px-3 py-2">
                <span className="text-xs font-bold text-destructive shrink-0 mt-0.5 w-16">Sev {entry.severity}/10</span>
                <span className="text-sm text-foreground flex-1 leading-snug whitespace-pre-wrap">{entry.note}</span>
                <button onClick={() => removeEntry(i)} className="text-muted-foreground hover:text-destructive transition-colors shrink-0 mt-0.5">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Label className="text-xs text-muted-foreground w-20 shrink-0">Severity</Label>
            <Select value={severityInput} onValueChange={setSeverityInput}>
              <SelectTrigger className="h-9 w-28"><SelectValue /></SelectTrigger>
              <SelectContent>
                {[1,2,3,4,5,6,7,8,9,10].map((n) => (
                  <SelectItem key={n} value={String(n)}>{n} / 10</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Textarea
            value={noteInput}
            onChange={(e) => setNoteInput(e.target.value)}
            placeholder="Describe the discomfort, location, timing..."
            rows={3}
          />
          <Button type="button" onClick={addEntry} size="sm" className="gap-1.5 w-full">
            <Plus className="w-3.5 h-3.5" /> Add Discomfort Entry
          </Button>
        </div>
      </div>
    </div>
  );
}