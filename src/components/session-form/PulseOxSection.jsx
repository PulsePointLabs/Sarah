import { useMemo, useState } from "react";
import { Activity, AlertCircle, CheckCircle, Upload } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { Label } from "@/components/ui/label";
import { decodePulseOxCsvBytes, parsePulseOxCsv } from "@/utils/parsePulseOxCsv";

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

function datePartsFromSessionDate(value) {
  if (!value) return null;
  const raw = String(value);
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (match) {
    return { year: Number(match[1]), month: Number(match[2]) - 1, day: Number(match[3]) };
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return { year: date.getFullYear(), month: date.getMonth(), day: date.getDate() };
}

function parseClock(value) {
  if (!value) return null;
  const match = String(value).trim().match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (!match) return null;
  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const second = Number(match[3] || 0);
  const ampm = match[4];
  if (/pm/i.test(ampm || "") && hour < 12) hour += 12;
  if (/am/i.test(ampm || "") && hour === 12) hour = 0;
  if (hour > 23 || minute > 59 || second > 59) return null;
  return { hour, minute, second };
}

function buildSessionWindow(data) {
  const parts = datePartsFromSessionDate(data.date);
  const startClock = parseClock(data.start_time);
  if (!parts || !startClock) return { error: "Set the session date and start time before importing pulse-ox CSV so Sarah can align samples to the session timeline." };

  const start = new Date(parts.year, parts.month, parts.day, startClock.hour, startClock.minute, startClock.second || 0);
  let end = null;
  const endClock = parseClock(data.end_time);
  if (endClock) {
    end = new Date(parts.year, parts.month, parts.day, endClock.hour, endClock.minute, endClock.second || 0);
    if (end < start) end.setDate(end.getDate() + 1);
  } else if (Number(data.duration_minutes) > 0) {
    end = new Date(start.getTime() + Number(data.duration_minutes) * 60_000);
  }

  return {
    startAt: start.toISOString(),
    endAt: end?.toISOString() || null,
  };
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
      const sessionWindow = buildSessionWindow(data);
      if (sessionWindow.error) {
        setImportResult({ error: sessionWindow.error });
        return;
      }
      const text = decodePulseOxCsvBytes(await file.arrayBuffer());
      const parsed = parsePulseOxCsv(text, {
        sessionStartAt: sessionWindow.startAt,
        sessionEndAt: sessionWindow.endAt,
      });
      if (parsed.error) {
        setImportResult({ error: parsed.error, skipReasons: parsed.skipReasons || [] });
        return;
      }

      const { file_url } = await base44.integrations.Core.UploadFile({ file });
      const nextSummary = summarizeRows(parsed.rows);

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
            {importResult.alignedToSession ? "Aligned to session " : ""}
            {formatTime(importResult.firstTimestamp)} to {formatTime(importResult.lastTimestamp)}
          </p>
          {(importResult.filteredBefore > 0 || importResult.filteredAfter > 0) && (
            <p className="pl-5 text-muted-foreground">
              Ignored {importResult.filteredBefore || 0} pre-session row{importResult.filteredBefore === 1 ? "" : "s"}
              {importResult.sessionEndAt ? ` and ${importResult.filteredAfter || 0} post-session row${importResult.filteredAfter === 1 ? "" : "s"}` : ""}.
            </p>
          )}
          {importResult.skipReasons?.slice(0, 3).map((reason, index) => (
            <p key={index} className="pl-5 text-muted-foreground">{reason}</p>
          ))}
        </div>
      )}

      {importResult?.error && (
        <div className="flex items-start gap-1.5 rounded-lg bg-destructive/10 p-2.5 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>
            {importResult.error}
            {importResult.skipReasons?.slice(0, 2).map((reason) => <span key={reason} className="mt-1 block opacity-80">{reason}</span>)}
          </span>
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
