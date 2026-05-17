import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { base44 } from "@/api/base44Client";
import { useState } from "react";
import { Upload } from "lucide-react";
import MultiSelect from "../MultiSelect";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

export default function MethodsSection({ data, onChange }) {
  const [uploading, setUploading] = useState(false);
  const update = (field, value) => onChange({ ...data, [field]: value });
  const methods = data.methods || [];
  const estimScreenshots = data.estim_screenshots || (data.estim_screenshot ? [data.estim_screenshot] : []);

  const handleScreenshots = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setUploading(true);
    const urls = await Promise.all(files.map(async (file) => {
      const { file_url } = await base44.integrations.Core.UploadFile({ file });
      return file_url;
    }));
    update("estim_screenshots", [...estimScreenshots, ...urls]);
    setUploading(false);
  };

  const removeScreenshot = (idx) => {
    update("estim_screenshots", estimScreenshots.filter((_, i) => i !== idx));
  };

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-primary">Methods & Devices</h3>

      <div>
        <Label className="text-xs text-muted-foreground mb-2 block">Methods Used</Label>
        <MultiSelect
          selected={methods}
          onChange={(v) => update("methods", v)}
        />
      </div>

      {methods.includes("Foley Catheter") && (
        <div className="bg-muted/50 rounded-lg p-3 space-y-3">
          <p className="text-xs font-semibold text-muted-foreground">Foley Details</p>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <Label className="text-xs">Size (Fr)</Label>
              <Input
                value={data.foley_size || ""}
                onChange={(e) => update("foley_size", e.target.value)}
                placeholder="e.g. 16"
                className="h-10 mt-1"
              />
            </div>
            <div>
              <Label className="text-xs">Type</Label>
              <Select value={data.foley_type || ""} onValueChange={(v) => update("foley_type", v)}>
                <SelectTrigger className="h-10 mt-1"><SelectValue placeholder="Select" /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="silicone">Silicone</SelectItem>
                  <SelectItem value="latex">Latex</SelectItem>
                  <SelectItem value="coated">Coated</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
        </div>
      )}

      {methods.includes("Coyote E-Stim") && (
        <div className="bg-muted/50 rounded-lg p-3 space-y-3">
          <p className="text-xs font-semibold text-muted-foreground">E-Stim Details</p>
          {estimScreenshots.length > 0 && (
            <div className="flex flex-wrap gap-2">
              {estimScreenshots.map((url, idx) => (
                <div key={idx} className="relative">
                  <img src={url} alt={`E-Stim screenshot ${idx + 1}`} className="w-20 h-20 object-cover rounded-lg border border-border" />
                  <button
                    onClick={() => removeScreenshot(idx)}
                    className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-destructive text-destructive-foreground text-xs flex items-center justify-center font-bold"
                  >×</button>
                </div>
              ))}
            </div>
          )}
          <label className="flex items-center justify-center gap-2 border-2 border-dashed border-border rounded-lg p-3 cursor-pointer hover:border-primary/50 transition-colors">
            <Upload className="w-4 h-4 text-muted-foreground" />
            <span className="text-sm text-muted-foreground">
              {uploading ? "Uploading..." : estimScreenshots.length > 0 ? `${estimScreenshots.length} screenshot(s) — add more` : "Upload settings screenshots (multi-select ok)"}
            </span>
            <input type="file" accept="image/*" multiple className="hidden" onChange={handleScreenshots} />
          </label>
          <Textarea
            value={data.estim_notes || ""}
            onChange={(e) => update("estim_notes", e.target.value)}
            placeholder="Waveform / intensity notes..."
            rows={2}
          />
        </div>
      )}

      {methods.includes("Silicone Sleeve") && (
        <div className="bg-muted/50 rounded-lg p-3 space-y-3">
          <p className="text-xs font-semibold text-muted-foreground">Sleeve Details</p>
          <Input
            value={data.sleeve_type || ""}
            onChange={(e) => update("sleeve_type", e.target.value)}
            placeholder="Type / brand"
            className="h-10"
          />
        </div>
      )}

      {methods.includes("TENS") && (
        <div className="bg-muted/50 rounded-lg p-3 space-y-3">
          <p className="text-xs font-semibold text-muted-foreground">TENS Details</p>
          <Input
            value={data.tens_placement || ""}
            onChange={(e) => update("tens_placement", e.target.value)}
            placeholder="Pad placement description"
            className="h-10"
          />
        </div>
      )}
    </div>
  );
}