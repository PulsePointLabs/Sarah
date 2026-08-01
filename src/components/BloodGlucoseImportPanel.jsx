import { useEffect, useState } from "react";
import { CheckCircle, Droplets, TriangleAlert, Upload } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { bloodGlucoseFields } from "@/lib/bloodGlucose";
import { bloodGlucoseReadingKey, importBloodGlucoseCsvBytes } from "@/lib/bloodGlucoseImport";

function formatDate(value) {
  return new Date(value).toLocaleString([], {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export default function BloodGlucoseImportPanel({ record = null, onChange = null }) {
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [savedRows, setSavedRows] = useState([]);
  const currentRows = record?.blood_glucose_readings || savedRows;

  useEffect(() => {
    if (record) return;
    const loadSavedRows = () => {
      base44.entities.BloodGlucoseReading.list("-measured_at", 20)
        .then((readings) => setSavedRows(Array.isArray(readings) ? readings : []))
        .catch(() => setSavedRows([]));
    };
    loadSavedRows();
    window.addEventListener("sarah:blood-glucose-imported", loadSavedRows);
    return () => window.removeEventListener("sarah:blood-glucose-imported", loadSavedRows);
  }, [record]);

  const importFile = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setBusy(true);
    setResult(null);
    try {
      const imported = await importBloodGlucoseCsvBytes(await file.arrayBuffer(), { record });
      if (imported.error) {
        setResult(imported);
        return;
      }
      if (!record) setSavedRows(imported.allRows.slice(-20).reverse());
      if (record && onChange) {
        onChange({
          ...record,
          ...bloodGlucoseFields(imported.aligned, record),
          _blood_glucose_rows: imported.aligned,
        });
      }
      setResult(imported);
    } catch (error) {
      setResult({ error: error?.message || String(error) });
    } finally {
      setBusy(false);
      event.target.value = "";
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h3 className="flex items-center gap-2 text-sm font-semibold uppercase tracking-wider text-primary">
          <Droplets className="h-4 w-4" /> Blood Glucose
        </h3>
        <p className="mt-1 text-sm text-muted-foreground">
          Import a OneTouch Reveal CSV. Device timestamps are interpreted as local time and readings are attached to every session or body exploration whose recorded window contains them.
        </p>
      </div>
      <label className="flex min-h-14 cursor-pointer items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border px-4 py-3 hover:border-primary/50">
        <Upload className="h-4 w-4" />
        <span className="text-sm font-medium">{busy ? "Importing and matching..." : "Import OneTouch Reveal CSV"}</span>
        <input type="file" accept=".csv,text/csv" className="hidden" disabled={busy} onChange={importFile} />
      </label>

      {result?.error && (
        <div className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive">
          <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <p>{result.error}</p>
            {result.skipReasons?.slice(0, 3).map((reason) => <p key={reason} className="mt-1 text-xs opacity-80">{reason}</p>)}
          </div>
        </div>
      )}

      {result && !result.error && (
        <div className="rounded-lg border border-primary/25 bg-primary/10 p-3 text-sm">
          <p className="flex items-center gap-2 font-semibold text-primary">
            <CheckCircle className="h-4 w-4" />
            {result.imported} valid readings; {result.newlySaved} newly saved
          </p>
          <p className="mt-1 text-xs text-muted-foreground">
            {formatDate(result.firstTimestamp)} to {formatDate(result.lastTimestamp)}. Matched {result.matchedRecords} saved record{result.matchedRecords === 1 ? "" : "s"}.
            {record ? ` ${result.alignedCount} reading${result.alignedCount === 1 ? "" : "s"} fall inside this record.` : ""}
          </p>
        </div>
      )}

      {currentRows.length > 0 && (
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {(record ? currentRows.slice(-4).reverse() : currentRows.slice(0, 4)).map((reading) => (
            <div key={bloodGlucoseReadingKey(reading)} className="rounded-lg border border-border bg-muted/20 p-3">
              <p className="font-mono text-xl font-bold">{reading.glucose_mg_dl}</p>
              <p className="text-xs text-muted-foreground">mg/dL · {formatDate(reading.measured_at)}</p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
