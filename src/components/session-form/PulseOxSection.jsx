import { useMemo, useState } from "react";
import { Activity, AlertCircle, CheckCircle, Upload } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { Label } from "@/components/ui/label";
import { parsePulseOxCsv } from "@/utils/parsePulseOxCsv";

function summarizeRows(rows) {
  if (!rows.length) return null;
  const spo2Values = rows.map((row) => Number(row.spo2_percent)).filter(Number.isFinite);
  const pulseValues = rows.map((row) => Number(row.pulse_bpm)).filter(Number.isFinite);
  return {
    minSpo2: Math.min(...spo2Values),
    avgSpo2: Math.round(spo2Values.reduce((sum, value) => sum + value, 0) / spo2Values.length),
    avgPulse: pulseValues.length ? Math.round(pulseValues.reduce((sum, value) => sum + value, 0) / pulseValues.length) : null,
    maxPulse: pulseValues.length ? Math.max(...pulseValues) : null,
  };
}

function formatTime(value) {
  if (!value) return "";
  return new Date(value).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
}

export default function PulseOxSection({ data, onChange }) {
  const [uploading, setUploading] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const rows = data._pulse_ox_rows || data.pulse_ox_readings || [];
  const summary = useMemo(() => summarizeRows(rows), [rows]);

  const update = (fields) => onChange({ ...data, ...fields });

  const handleCSVUpload = async (event) => {
    const file = event.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setImportResult(null);

    try {
      const text = await file.text();
      const parsed = parsePulseOxCsv(text);
      if (parsed.error) {
        setImportResult({ error: parsed.error, skipReasons: parsed.skipReasons || [] });
        return;
      }

      const { file_url } = await base44.integrations.Core.UploadFile({ file });
      const nextSummary = summarizeRows(parsed.rows);
      const firstTs = parsed.firstTimestamp ? new Date(parsed.firstTimestamp) : null;
      const firstDateET = firstTs
        ? new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(firstTs)
        : null;
      let startTime = data.start_time;
      if (firstTs && !startTime) {
        const etTime = firstTs.toLocaleTimeString("en-US", {
          timeZone: "America/New_York",
          hour: "2-digit",
          minute: "2-digit",
          hour12: false,
        });
        startTime = etTime === "24:00" ? "00:00" : etTime;
      }
      const durationMinutes = parsed.rows.length
        ? Math.max(data.duration_minutes || 0, Math.ceil((parsed.rows[parsed.rows.length - 1].time_offset_s || 0) / 60))
        : data.duration_minutes;

      update({
        pulse_ox_enabled: true,
        pulse_ox_data_file: file_url,
        pulse_ox_source: "EMAY app CSV",
        pulse_ox_readings: parsed.rows,
        latest_pulse_ox_reading: parsed.rows[parsed.rows.length - 1],
        min_spo2_percent: nextSummary?.minSpo2 ?? null,
        avg_spo2_percent: nextSummary?.avgSpo2 ?? null,
        avg_pulse_ox_pulse_bpm: nextSummary?.avgPulse ?? null,
        max_pulse_ox_pulse_bpm: nextSummary?.maxPulse ?? null,
        date: data.date || (firstDateET ? `${firstDateET}T00:00:00` : data.date),
        start_time: startTime,
        duration_minutes: durationMinutes || data.duration_minutes,
        dur_hours: durationMinutes ? Math.floor(durationMinutes / 60) : data.dur_hours,
        dur_minutes: durationMinutes ? durationMinutes % 60 : data.dur_minutes,
        _pulse_ox_rows: parsed.rows,
      });
      setImportResult(parsed);
    } catch (error) {
      setImportResult({ error: error.message || String(error) });
    } finally {
      setUploading(false);
      event.target.value = "";
    }
  };

  return (
    <div className="space-y-4">
      <h3 className="flex items-center gap-1.5 text-sm font-semibold uppercase tracking-wider text-primary">
        <Activity className="h-4 w-4" />
        Pulse Oximetry
      </h3>

      <div className="rounded-lg border border-border bg-muted/20 p-3 text-xs leading-5 text-muted-foreground">
        Import EMAY app CSV exports with timestamp, SpO2, and pulse/PR columns. The parser is tolerant of common EMAY-style headers, but a real sample export will let us tighten it further.
      </div>

      <div>
        <Label className="text-xs text-muted-foreground">EMAY Pulse-Ox CSV</Label>
        <label className="mt-1 flex cursor-pointer items-center justify-center gap-2 rounded-lg border-2 border-dashed border-border p-3 transition-colors hover:border-primary/50">
          <Upload className="h-4 w-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">
            {uploading
              ? "Importing..."
              : rows.length > 0
                ? `${rows.length} pulse-ox rows imported ✓`
                : "Upload EMAY CSV"}
          </span>
          <input type="file" accept=".csv,text/csv" className="hidden" onChange={handleCSVUpload} disabled={uploading} />
        </label>
      </div>

      {importResult && !importResult.error && (
        <div className="rounded-lg bg-primary/10 p-2.5 text-xs text-primary">
          <div className="flex items-center gap-1.5 font-medium">
            <CheckCircle className="h-3.5 w-3.5 shrink-0" />
            {importResult.imported} of {importResult.total} rows imported
            {importResult.skipped > 0 && ` (${importResult.skipped} skipped)`}
          </div>
          <p className="pl-5 text-muted-foreground">
            {formatTime(importResult.firstTimestamp)} to {formatTime(importResult.lastTimestamp)}
          </p>
          {importResult.skipReasons?.slice(0, 3).map((reason, index) => (
            <p key={index} className="pl-5 text-muted-foreground">{reason}</p>
          ))}
        </div>
      )}

      {importResult?.error && (
        <div className="flex items-start gap-1.5 rounded-lg bg-destructive/10 p-2.5 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{importResult.error}</span>
        </div>
      )}

      {summary && (
        <div className="grid grid-cols-2 gap-2 rounded-lg bg-muted/30 p-3 text-xs sm:grid-cols-4">
          <div>
            <p className="text-muted-foreground">Avg SpO2</p>
            <p className="font-mono text-lg font-bold">{summary.avgSpo2}%</p>
          </div>
          <div>
            <p className="text-muted-foreground">Min SpO2</p>
            <p className="font-mono text-lg font-bold">{summary.minSpo2}%</p>
          </div>
          <div>
            <p className="text-muted-foreground">Avg Pulse</p>
            <p className="font-mono text-lg font-bold">{summary.avgPulse ?? "--"} bpm</p>
          </div>
          <div>
            <p className="text-muted-foreground">Max Pulse</p>
            <p className="font-mono text-lg font-bold">{summary.maxPulse ?? "--"} bpm</p>
          </div>
        </div>
      )}
    </div>
  );
}
