import { useCallback, useEffect, useMemo, useState } from "react";
import { Activity, CheckCircle2, Droplets, FileUp, RefreshCw, Scale, TriangleAlert } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { useToast } from "@/components/ui/use-toast";
import { syncBodyCompositionFromHealthConnect } from "@/lib/bodyComposition";
import { subscribePendingSharedVitalImport, takePendingSharedVitalImport } from "@/lib/sharedVitalImport";
import { decodePulseOxCsvBytes, parsePulseOxCsv } from "@/utils/parsePulseOxCsv";
import { classifyVitalCsv, decodeVitalCsvBytes, parseBloodGlucoseCsv, parseBodyCompositionCsv } from "@/utils/parseVitalCsv";

const TYPE_OPTIONS = [
  { value: "auto", label: "Detect automatically" },
  { value: "pulse_ox", label: "SpO2 / pulse oximetry" },
  { value: "blood_glucose", label: "Blood glucose" },
  { value: "body_composition", label: "Body composition / weight" },
];

function fmtTime(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "time unknown" : date.toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

function RecentList({ title, icon, rows, render }) {
  return (
    <div className="rounded-lg border border-border bg-muted/15 p-3">
      <h3 className="flex items-center gap-2 text-sm font-bold text-foreground">{icon}{title}</h3>
      {rows.length ? rows.slice(0, 5).map((row, index) => (
        <div key={row.id || index} className="mt-2 border-l-2 border-primary/25 pl-2 text-xs">
          <p className="font-semibold text-foreground">{render(row)}</p>
          <p className="text-muted-foreground">{fmtTime(row.measured_at)} · {row.source_app || "imported"}</p>
        </div>
      )) : <p className="mt-2 text-xs text-muted-foreground">No imported readings yet.</p>}
    </div>
  );
}

export default function VitalDataImportPanel({ onDataChanged }) {
  const { toast } = useToast();
  const [importType, setImportType] = useState("auto");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState(null);
  const [recent, setRecent] = useState({ pulseOx: [], glucose: [], composition: [] });

  const loadRecent = useCallback(async () => {
    const [pulseOx, glucose, composition] = await Promise.all([
      base44.entities.PulseOxReading.list("-measured_at", 12).catch(() => []),
      base44.entities.BloodGlucoseReading.list("-measured_at", 12).catch(() => []),
      base44.entities.BodyCompositionReading.list("-measured_at", 12).catch(() => []),
    ]);
    setRecent({ pulseOx, glucose, composition });
  }, []);

  const importBytes = useCallback(async (bytes, fileName = "vitals.csv", forcedType = "auto") => {
    setBusy(true);
    setResult(null);
    try {
      const genericText = decodeVitalCsvBytes(bytes);
      const detected = classifyVitalCsv(genericText);
      const filenameType = /(?:emay|spo2|sp02|pulse.?ox|oximeter|oxygen)/i.test(fileName)
        ? "pulse_ox"
        : /(?:onetouch|glucose|blood.?sugar)/i.test(fileName)
          ? "blood_glucose"
          : /(?:weight|scale|body.?composition)/i.test(fileName) ? "body_composition" : null;
      const type = forcedType === "auto" ? (detected.type || filenameType) : forcedType;
      if (!type) throw new Error(detected.error || "Choose whether this file contains SpO2, blood glucose, or body composition.");

      let parsed;
      let entity;
      if (type === "pulse_ox") {
        parsed = parsePulseOxCsv(decodePulseOxCsvBytes(bytes), { sourceApp: `EMAY/shared CSV · ${fileName}` });
        entity = base44.entities.PulseOxReading;
      } else if (type === "blood_glucose") {
        parsed = parseBloodGlucoseCsv(genericText, { sourceApp: `Shared CSV · ${fileName}` });
        entity = base44.entities.BloodGlucoseReading;
      } else {
        parsed = parseBodyCompositionCsv(genericText, { sourceApp: `Shared CSV · ${fileName}` });
        entity = base44.entities.BodyCompositionReading;
      }
      if (parsed.error) {
        const details = parsed.skipReasons?.slice(0, 3).join(" · ");
        throw new Error(`${parsed.error}${details ? ` ${details}` : ""}`);
      }
      const importedAt = new Date().toISOString();
      const rows = parsed.rows.map((row) => ({ ...row, imported_at: importedAt, source_file: fileName }));
      await entity.bulkCreate(rows);
      const persisted = await entity.filter({ id: { $in: rows.map((row) => row.id) } }, "-updated_date", rows.length);
      if (persisted.length !== rows.length) throw new Error(`Sarah parsed ${rows.length} reading${rows.length === 1 ? "" : "s"}, but only ${persisted.length} persisted. Nothing is being reported as imported until storage agrees.`);
      const next = { type, count: persisted.length, fileName, first: parsed.rows[0]?.measured_at, last: parsed.rows.at(-1)?.measured_at, headerRow: parsed.headerRow };
      setResult(next);
      await loadRecent();
      onDataChanged?.();
      toast({ title: `Imported ${next.count} ${TYPE_OPTIONS.find((item) => item.value === type)?.label || "vital-sign"} reading${next.count === 1 ? "" : "s"}` });
    } catch (error) {
      setResult({ error: error.message || String(error), fileName });
    } finally {
      setBusy(false);
    }
  }, [loadRecent, onDataChanged, toast]);

  useEffect(() => { loadRecent(); }, [loadRecent]);

  useEffect(() => {
    const consumeShared = () => {
      const shared = takePendingSharedVitalImport();
      if (shared?.bytes) importBytes(shared.bytes, shared.name, "auto");
    };
    consumeShared();
    return subscribePendingSharedVitalImport(consumeShared);
  }, [importBytes]);

  const total = useMemo(() => recent.pulseOx.length + recent.glucose.length + recent.composition.length, [recent]);

  const handleFile = async (event) => {
    const file = event.target.files?.[0];
    if (file) await importBytes(new Uint8Array(await file.arrayBuffer()), file.name, importType);
    event.target.value = "";
  };

  const syncComposition = async () => {
    setBusy(true);
    setResult(null);
    try {
      const synced = await syncBodyCompositionFromHealthConnect({ days: 365, limit: 300 });
      setResult({ type: "body_composition", count: synced.inserted, fileName: "Health Connect" });
      await loadRecent();
      onDataChanged?.();
    } catch (error) {
      setResult({ error: error.message || String(error), fileName: "Health Connect" });
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="mt-6 rounded-xl border border-primary/25 bg-card p-4 shadow-sm sm:p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-lg font-bold text-foreground"><FileUp className="h-5 w-5 text-primary" />Import nearby measurements</h2>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">Share an EMAY CSV directly to Sarah, open a CSV with Sarah, or choose one here. Imports are saved globally for charts and AI analysis—not trapped inside one session.</p>
        </div>
        <span className="text-xs font-semibold text-muted-foreground">{total} recent readings loaded</span>
      </div>

      <div className="mt-4 grid gap-3 sm:grid-cols-[minmax(0,1fr)_auto_auto]">
        <select value={importType} onChange={(event) => setImportType(event.target.value)} className="min-h-11 rounded-md border border-input bg-background px-3 text-sm text-foreground">
          {TYPE_OPTIONS.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
        </select>
        <label className="inline-flex min-h-11 cursor-pointer items-center justify-center gap-2 rounded-md bg-primary px-4 text-sm font-semibold text-primary-foreground">
          <FileUp className="h-4 w-4" />{busy ? "Importing…" : "Choose CSV"}
          <input type="file" accept=".csv,text/csv,text/plain,application/csv,application/vnd.ms-excel" className="hidden" disabled={busy} onChange={handleFile} />
        </label>
        <button type="button" onClick={syncComposition} disabled={busy} className="inline-flex min-h-11 items-center justify-center gap-2 rounded-md border border-border bg-muted px-4 text-sm font-semibold text-foreground disabled:opacity-60">
          <RefreshCw className={`h-4 w-4 ${busy ? "animate-spin" : ""}`} />Sync scale
        </button>
      </div>

      {result?.error && <div className="mt-4 flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm text-destructive"><TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" /><span><strong>{result.fileName}:</strong> {result.error}</span></div>}
      {result && !result.error && <div className="mt-4 flex items-start gap-2 rounded-md border border-primary/25 bg-primary/10 p-3 text-sm text-primary"><CheckCircle2 className="mt-0.5 h-4 w-4 shrink-0" /><span>Saved and verified {result.count} reading{result.count === 1 ? "" : "s"} from {result.fileName}{result.first ? ` · ${fmtTime(result.first)} through ${fmtTime(result.last)}` : ""}{result.headerRow > 1 ? ` · CSV header found on row ${result.headerRow}` : ""}.</span></div>}

      <div className="mt-4 grid gap-3 lg:grid-cols-3">
        <RecentList title="SpO2 / pulse" icon={<Activity className="h-4 w-4 text-primary" />} rows={recent.pulseOx} render={(row) => `${row.spo2_percent ?? row.spo2}%${row.pulse_bpm ? ` · ${row.pulse_bpm} bpm` : ""}`} />
        <RecentList title="Blood glucose" icon={<Droplets className="h-4 w-4 text-primary" />} rows={recent.glucose} render={(row) => `${row.glucose_mg_dl ?? row.glucose ?? row.value} mg/dL`} />
        <RecentList title="Body composition / weight" icon={<Scale className="h-4 w-4 text-primary" />} rows={recent.composition} render={(row) => `${(Number(row.weight_kg) * 2.2046226218).toFixed(1)} lb${row.body_fat_percent != null ? ` · ${Number(row.body_fat_percent).toFixed(1)}% fat` : ""}`} />
      </div>
    </section>
  );
}
