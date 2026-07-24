import { useEffect, useState } from "react";
import { RefreshCw, Scale, Unlink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/components/ui/use-toast";
import {
  compositionSnapshot,
  formatCompositionTime,
  formatWeightKg,
  listBodyCompositionReadings,
  requestBodyCompositionPermission,
  saveManualBodyComposition,
  syncBodyCompositionFromHealthConnect,
} from "@/lib/bodyComposition";
import { isSarahNativeShell } from "@/lib/mobileApiBase";
import BodyCompositionSummaryCard from "@/components/BodyCompositionSummaryCard";

const OPTIONAL_FIELDS = [
  ["BMI", "bmi"],
  ["Body fat %", "body_fat_percent"],
  ["Subcutaneous fat %", "subcutaneous_fat_percent"],
  ["Visceral fat", "visceral_fat"],
  ["Lean mass kg", "lean_body_mass_kg"],
  ["Fat-free weight kg", "fat_free_body_weight_kg"],
  ["Muscle mass kg", "muscle_mass_kg"],
  ["Skeletal muscle %", "skeletal_muscle_percent"],
  ["Body water %", "body_water_percent"],
  ["Body water kg", "body_water_mass_kg"],
  ["Bone mass kg", "bone_mass_kg"],
  ["Protein %", "protein_percent"],
  ["BMR kcal/day", "basal_metabolic_rate_kcal_day"],
  ["Metabolic age", "metabolic_age"],
];

export default function BodyCompositionSection({ data, onChange }) {
  const { toast } = useToast();
  const [readings, setReadings] = useState([]);
  const [busy, setBusy] = useState(false);
  const [manual, setManual] = useState({
    measured_at: new Date().toISOString().slice(0, 16),
    weight_kg: "",
  });
  const attached = data?.body_composition || null;

  const reload = async () => {
    const rows = await listBodyCompositionReadings(50).catch(() => []);
    setReadings(rows);
    return rows;
  };

  useEffect(() => {
    reload();
  }, []);

  const attach = (reading, relation = "nearest weigh-in") => {
    onChange((current) => ({
      ...current,
      body_composition_reading_id: reading.id || reading.reading_id || null,
      body_composition: {
        ...compositionSnapshot(reading),
        measurement_relation: relation,
      },
    }));
  };

  const connectAndSync = async () => {
    setBusy(true);
    try {
      let result;
      try {
        result = await syncBodyCompositionFromHealthConnect({ days: 90, limit: 200 });
      } catch (error) {
        if (/permission/i.test(error.message || "")) {
          await requestBodyCompositionPermission();
          result = await syncBodyCompositionFromHealthConnect({ days: 90, limit: 200 });
        } else {
          throw error;
        }
      }
      const rows = await reload();
      if (rows[0]) attach(rows[0], "latest Health Connect weigh-in");
      toast({ title: result.inserted ? `Imported ${result.inserted} weigh-in${result.inserted === 1 ? "" : "s"}` : "No new Health Connect weigh-ins found" });
    } catch (error) {
      toast({ title: error.message || "Health Connect sync failed", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  const saveManual = async () => {
    setBusy(true);
    try {
      const saved = await saveManualBodyComposition({
        ...manual,
        measured_at: new Date(manual.measured_at).toISOString(),
        source_app: "Manual / VeSync",
      });
      attach(saved, "manually attached weigh-in");
      await reload();
      toast({ title: "Weigh-in saved and attached" });
    } catch (error) {
      toast({ title: error.message || "Could not save weigh-in", variant: "destructive" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {attached && <BodyCompositionSummaryCard reading={attached} compact title="Attached Weigh-In" />}
      <div className="flex flex-wrap gap-2">
        {isSarahNativeShell() && (
          <Button type="button" onClick={connectAndSync} disabled={busy} className="gap-2">
            <RefreshCw className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} />
            Sync Health Connect
          </Button>
        )}
        {readings[0] && (
          <Button type="button" variant="outline" onClick={() => attach(readings[0])}>
            Attach Latest · {formatWeightKg(readings[0].weight_kg)}
          </Button>
        )}
        {attached && (
          <Button type="button" variant="ghost" onClick={() => onChange((current) => ({ ...current, body_composition: null, body_composition_reading_id: null }))} className="gap-2">
            <Unlink className="h-4 w-4" /> Detach
          </Button>
        )}
      </div>
      {readings.length > 1 && (
        <div>
          <Label className="text-xs text-muted-foreground">Choose another saved weigh-in</Label>
          <select
            className="mt-1 h-11 w-full rounded-lg border border-border bg-background px-3 text-sm"
            value=""
            onChange={(event) => {
              const reading = readings.find((row) => row.id === event.target.value);
              if (reading) attach(reading, "selected weigh-in");
            }}
          >
            <option value="">Select by date…</option>
            {readings.map((reading) => (
              <option key={reading.id} value={reading.id}>
                {formatCompositionTime(reading.measured_at)} · {formatWeightKg(reading.weight_kg)}
              </option>
            ))}
          </select>
        </div>
      )}
      <details className="rounded-lg border border-border bg-muted/10 p-3">
        <summary className="cursor-pointer text-sm font-semibold text-primary">Add Manual / Full VeSync Weigh-In</summary>
        <div className="mt-3 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <div>
            <Label className="text-xs text-muted-foreground">Measured at</Label>
            <Input type="datetime-local" value={manual.measured_at} onChange={(event) => setManual((current) => ({ ...current, measured_at: event.target.value }))} className="mt-1" />
          </div>
          <div>
            <Label className="text-xs text-muted-foreground">Weight kg</Label>
            <Input type="number" step="0.1" value={manual.weight_kg} onChange={(event) => setManual((current) => ({ ...current, weight_kg: event.target.value }))} className="mt-1" />
          </div>
          {OPTIONAL_FIELDS.map(([label, field]) => (
            <div key={field}>
              <Label className="text-xs text-muted-foreground">{label}</Label>
              <Input type="number" step="0.1" value={manual[field] || ""} onChange={(event) => setManual((current) => ({ ...current, [field]: event.target.value }))} className="mt-1" />
            </div>
          ))}
        </div>
        <Button type="button" variant="outline" onClick={saveManual} disabled={busy} className="mt-3 gap-2">
          <Scale className="h-4 w-4" /> Save and Attach
        </Button>
      </details>
      {!isSarahNativeShell() && (
        <p className="text-xs text-muted-foreground">Health Connect import runs in the APK. Readings saved there are available here on desktop.</p>
      )}
    </div>
  );
}
