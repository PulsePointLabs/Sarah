import { useCallback, useEffect, useState } from "react";
import { Activity, AlertCircle, CheckCircle, Upload } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { importPulseOxCsvBytes } from "@/lib/pulseOxImport";

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? ""
    : date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export default function PulseOxImportPanel() {
  const [readings, setReadings] = useState([]);
  const [uploading, setUploading] = useState(false);
  const [result, setResult] = useState(null);

  const load = useCallback(async () => {
    const rows = await base44.entities.PulseOxReading.list("-measured_at", 12);
    setReadings(Array.isArray(rows) ? rows : []);
  }, []);

  useEffect(() => {
    load().catch(() => {});
    const refresh = () => load().catch(() => {});
    window.addEventListener("sarah:pulse-ox-imported", refresh);
    return () => window.removeEventListener("sarah:pulse-ox-imported", refresh);
  }, [load]);

  const importFile = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setResult(null);
    try {
      const imported = await importPulseOxCsvBytes(
        new Uint8Array(await file.arrayBuffer()),
        { filename: file.name },
      );
      if (imported.error) throw new Error(imported.error);
      setResult(imported);
      await load();
    } catch (error) {
      setResult({ error: error?.message || String(error) });
    } finally {
      setUploading(false);
      event.target.value = "";
    }
  };

  return (
    <div>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-bold uppercase tracking-wider text-primary">
            <Activity className="h-5 w-5" />
            Pulse Oximetry
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Share an EMAY CSV directly to Sarah on Android, or import it here. Device timestamps are interpreted in local time and matched to session windows.
          </p>
        </div>
        <label className="inline-flex cursor-pointer items-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground">
          <Upload className="h-4 w-4" />
          {uploading ? "Importing..." : "Import EMAY CSV"}
          <input
            type="file"
            accept=".csv,text/csv"
            className="hidden"
            disabled={uploading}
            onChange={importFile}
          />
        </label>
      </div>

      {result?.error && (
        <div className="mt-3 flex items-start gap-2 rounded-md bg-destructive/10 p-3 text-sm text-destructive">
          <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" />
          {result.error}
        </div>
      )}
      {result && !result.error && (
        <div className="mt-3 flex items-start gap-2 rounded-md bg-emerald-500/10 p-3 text-sm text-emerald-700">
          <CheckCircle className="mt-0.5 h-4 w-4 shrink-0" />
          Imported {result.imported} readings, saved {result.newlySaved} new, and matched {result.matchedRecords} session records.
        </div>
      )}

      {readings.length > 0 && (
        <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
          {readings.slice(0, 6).map((reading) => (
            <div key={reading.id || `${reading.measured_at}-${reading.spo2_percent}`} className="rounded-md border border-border p-3">
              <p className="font-mono text-xl font-bold text-foreground">
                {reading.spo2_percent}% <span className="text-sm font-normal text-muted-foreground">SpO2</span>
              </p>
              <p className="text-sm text-muted-foreground">
                {reading.pulse_bpm != null ? `${reading.pulse_bpm} bpm · ` : ""}{formatDate(reading.measured_at)}
              </p>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
