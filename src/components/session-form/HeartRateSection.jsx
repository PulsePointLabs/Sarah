import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { base44 } from "@/api/base44Client";
import { useState } from "react";
import { Upload, Plus, Trash2, CheckCircle, AlertCircle, Info } from "lucide-react";
import HRTimelineChart from "@/components/HRTimelineChart";

function calcDerivedMetrics(rows) {
  const buildRows = rows.filter((r) => r.marker === "build");
  const recoveryRows = rows.filter((r) => r.marker === "recovery");
  const climaxRows = rows.filter((r) => r.marker === "climax");

  // Build duration: time span of build-marked rows
  const buildOffsets = buildRows.map((r) => Number(r.time_offset_s));
  const buildDuration = buildOffsets.length > 1 ? Math.round(Math.max(...buildOffsets) - Math.min(...buildOffsets)) : 0;

  // Recovery duration
  const recoveryOffsets = recoveryRows.map((r) => Number(r.time_offset_s));
  const recoveryDuration = recoveryOffsets.length > 1 ? Math.round(Math.max(...recoveryOffsets) - Math.min(...recoveryOffsets)) : 0;

  // Peak HR during build
  const peakHrBuild = buildRows.length > 0 ? Math.max(...buildRows.map((r) => Number(r.hr))) : null;

  // Build intensity score: avg elevated_delta during build
  const buildDeltas = buildRows.map((r) => Number(r.elevated_delta)).filter((v) => !isNaN(v));
  const buildIntensity = buildDeltas.length > 0 ? Math.round((buildDeltas.reduce((a, b) => a + b, 0) / buildDeltas.length) * 10) / 10 : null;

  // Climax suggestion: top HR peak
  const allHrs = rows.map((r) => Number(r.hr));
  const peakHr = allHrs.length > 0 ? Math.max(...allHrs) : null;

  return { buildDuration, recoveryDuration, peakHrBuild, buildIntensity, peakHr };
}

export default function HeartRateSection({ data, onChange }) {
  const [uploading, setUploading] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [derived, setDerived] = useState(null);

  const update = (fields) => onChange({ ...data, ...fields });

  const handleCSVUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setImportResult(null);
    setDerived(null);

    // Parse CSV directly in browser
    const text = await file.text();
    const lines = text.trim().split(/\r?\n/);
    if (lines.length < 2) {
      setImportResult({ error: "CSV appears empty or has no data rows." });
      setUploading(false);
      return;
    }

    const headers = lines[0].split(",").map((h) => h.trim());
    const hrIdx = headers.indexOf("hr");
    const offsetIdx = headers.indexOf("time_offset_s");
    const timestampIdx = headers.indexOf("timestamp");
    const offsetMsIdx = headers.indexOf("time_offset_ms");
    const smoothedIdx = headers.indexOf("hr_smoothed");
    const baselineIdx = headers.indexOf("baseline_hr");
    const deltaIdx = headers.indexOf("elevated_delta");
    const markerIdx = headers.indexOf("marker");
    const noteIdx = headers.indexOf("note");

    if (hrIdx === -1) {
      setImportResult({ error: "Could not find 'hr' column. Ensure the CSV header row is present." });
      setUploading(false);
      return;
    }

    const skipReasons = [];
    let lastOffset = -Infinity;
    const allRows = lines.slice(1);

    const validRows = allRows
      .map((line, i) => {
        const cols = line.split(",");
        return { cols, rowNum: i + 2 };
      })
      .filter(({ cols, rowNum }) => {
        const hrVal = cols[hrIdx]?.trim();
        if (!hrVal || isNaN(Number(hrVal))) {
          skipReasons.push(`Row ${rowNum}: missing or non-numeric hr`);
          return false;
        }
        const offset = offsetIdx !== -1 ? Number(cols[offsetIdx]?.trim()) : NaN;
        if (!isNaN(offset) && offset < lastOffset) {
          skipReasons.push(`Row ${rowNum}: time_offset_s not increasing`);
          return false;
        }
        if (!isNaN(offset)) lastOffset = offset;
        return true;
      })
      .map(({ cols }) => ({
        timestamp: timestampIdx !== -1 ? cols[timestampIdx]?.trim() || null : null,
        time_offset_ms: offsetMsIdx !== -1 && cols[offsetMsIdx]?.trim() !== "" ? Number(cols[offsetMsIdx].trim()) : null,
        time_offset_s: offsetIdx !== -1 && cols[offsetIdx]?.trim() !== "" ? Number(cols[offsetIdx].trim()) : null,
        hr: Number(cols[hrIdx].trim()),
        hr_smoothed: smoothedIdx !== -1 && cols[smoothedIdx]?.trim() !== "" ? Number(cols[smoothedIdx].trim()) : null,
        baseline_hr: baselineIdx !== -1 && cols[baselineIdx]?.trim() !== "" ? Number(cols[baselineIdx].trim()) : null,
        elevated_delta: deltaIdx !== -1 && cols[deltaIdx]?.trim() !== "" ? Number(cols[deltaIdx].trim()) : null,
        marker: markerIdx !== -1 && cols[markerIdx]?.trim() !== "" ? cols[markerIdx].trim() : null,
        note: noteIdx !== -1 && cols[noteIdx]?.trim() !== "" ? cols[noteIdx].trim() : null,
      }));

    const skipped = allRows.length - validRows.length;

    if (validRows.length === 0) {
      setImportResult({ error: "No valid rows found. Ensure 'hr' column is present and numeric." });
      setUploading(false);
      return;
    }

    // Upload file for storage reference
    const { file_url } = await base44.integrations.Core.UploadFile({ file });

    // Auto-populate summary fields
    const hrs = validRows.map((r) => r.hr);
    const avgHr = Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length);
    const maxHr = Math.max(...hrs);
    const maxOffsetS = Math.max(...validRows.map((r) => r.time_offset_s || 0));
    const durationMins = Math.round(maxOffsetS / 60);
    const timestamps = validRows.map((r) => r.timestamp).filter(Boolean).sort();
    const firstTs = timestamps[0] ? new Date(timestamps[0]) : null;
    const firstTimestamp = firstTs ? firstTs.toISOString() : data.date;

    // Extract HH:MM start time in America/New_York from the first timestamp
    let startTime = data.start_time;
    if (firstTs) {
      const etTime = firstTs.toLocaleTimeString("en-US", {
        timeZone: "America/New_York",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
      });
      // toLocaleTimeString may return "24:xx" for midnight — normalize
      startTime = etTime === "24:00" ? "00:00" : etTime;
    }

    // Derived metrics
    const metrics = calcDerivedMetrics(validRows);
    setDerived(metrics);

    update({
      hr_data_file: file_url,
      avg_hr: avgHr,
      max_hr: maxHr,
      date: firstTimestamp || data.date,
      duration_minutes: durationMins,
      start_time: startTime,
      _csv_rows: validRows,
    });

    setImportResult({ total: allRows.length, imported: validRows.length, skipped, skipReasons });
    setUploading(false);
  };

  const addTimelineEntry = () => {
    const timeline = data.hr_timeline || [];
    update({ hr_timeline: [...timeline, { minute: "", hr: "" }] });
  };

  const updateTimeline = (index, field, value) => {
    const timeline = [...(data.hr_timeline || [])];
    timeline[index] = { ...timeline[index], [field]: Number(value) };
    update({ hr_timeline: timeline });
  };

  const removeTimeline = (index) => {
    update({ hr_timeline: (data.hr_timeline || []).filter((_, i) => i !== index) });
  };

  const csvRows = data._csv_rows || [];

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-primary">Heart Rate</h3>

      <div className={`grid gap-3 ${data.no_climax ? "grid-cols-2" : "grid-cols-3"}`}>
        <div>
          <Label className="text-xs text-muted-foreground">Avg HR</Label>
          <Input type="number" placeholder="72" value={data.avg_hr || ""} onChange={(e) => update({ avg_hr: Number(e.target.value) })} className="h-12 mt-1 font-mono text-center" />
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">Max HR</Label>
          <Input type="number" placeholder="140" value={data.max_hr || ""} onChange={(e) => update({ max_hr: Number(e.target.value) })} className="h-12 mt-1 font-mono text-center" />
        </div>
        {!data.no_climax && (
          <div>
            <Label className="text-xs text-muted-foreground">At Climax</Label>
            <Input type="number" placeholder="135" value={data.hr_at_climax || ""} onChange={(e) => update({ hr_at_climax: Number(e.target.value) })} className="h-12 mt-1 font-mono text-center" />
          </div>
        )}
      </div>

      {/* Climax suggestion */}
      {derived?.peakHr && !data.hr_at_climax && (
        <div className="flex items-center gap-2 text-xs bg-chart-4/10 text-chart-4 rounded-lg p-2.5">
          <Info className="w-3.5 h-3.5 shrink-0" />
          <span>Peak HR detected: <strong>{derived.peakHr} bpm</strong> — suggested value for "At Climax" (not auto-filled).</span>
        </div>
      )}

      <div>
        <Label className="text-xs text-muted-foreground">HR Data File (CSV)</Label>
        <label className="mt-1 flex items-center justify-center gap-2 border-2 border-dashed border-border rounded-lg p-3 cursor-pointer hover:border-primary/50 transition-colors">
          <Upload className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">
            {uploading ? "Importing..." : csvRows.length > 0 ? `${csvRows.length} rows imported ✓` : "Upload & Import CSV"}
          </span>
          <input type="file" accept=".csv" className="hidden" onChange={handleCSVUpload} disabled={uploading} />
        </label>

        {importResult && !importResult.error && (
          <div className="mt-2 p-2.5 rounded-lg bg-primary/10 text-primary text-xs space-y-1">
            <div className="flex items-center gap-1.5 font-medium">
              <CheckCircle className="w-3.5 h-3.5 shrink-0" />
              {importResult.imported} of {importResult.total} rows imported
              {importResult.skipped > 0 && ` (${importResult.skipped} skipped)`}
            </div>
            {importResult.skipReasons.slice(0, 3).map((r, i) => (
              <div key={i} className="text-muted-foreground pl-5">{r}</div>
            ))}
          </div>
        )}
        {importResult?.error && (
          <div className="mt-2 p-2.5 rounded-lg bg-destructive/10 text-destructive text-xs flex items-start gap-1.5">
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />{importResult.error}
          </div>
        )}
      </div>

      {csvRows.length > 0 && (
        <>
          <div>
            <Label className="text-xs text-muted-foreground mb-2 block">HR Timeline Preview</Label>
            <HRTimelineChart
              rows={csvRows}
              savedMarkers={{
                pre_climax_offset_s: data.pre_climax_offset_s ?? null,
                climax_offset_s: data.climax_offset_s ?? null,
                recovery_offset_s: data.recovery_offset_s ?? null,
              }}
              onMarkersChange={(markers) => update(markers)}
              noClimax={!!data.no_climax}
            />
          </div>

          {/* Derived metrics */}
          {derived && (
            <div className="bg-muted/40 rounded-lg p-3 space-y-1.5">
              <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wide mb-2">Derived Analytics</p>
              <div className="grid grid-cols-2 gap-2 text-xs">
                {derived.buildDuration > 0 && <div className="flex justify-between"><span className="text-muted-foreground">Build Duration</span><span className="font-mono font-bold">{derived.buildDuration}s</span></div>}
                {derived.recoveryDuration > 0 && <div className="flex justify-between"><span className="text-muted-foreground">Recovery Duration</span><span className="font-mono font-bold">{derived.recoveryDuration}s</span></div>}
                {derived.peakHrBuild && <div className="flex justify-between"><span className="text-muted-foreground">Peak HR (Build)</span><span className="font-mono font-bold">{derived.peakHrBuild} bpm</span></div>}
                {derived.buildIntensity != null && <div className="flex justify-between"><span className="text-muted-foreground">Build Intensity Δ</span><span className="font-mono font-bold">{derived.buildIntensity}</span></div>}
              </div>
            </div>
          )}
        </>
      )}

      <div>
        <div className="flex items-center justify-between mb-2">
          <Label className="text-xs text-muted-foreground">Manual HR Timeline</Label>
          <Button type="button" variant="ghost" size="sm" onClick={addTimelineEntry}>
            <Plus className="w-3.5 h-3.5 mr-1" /> Add
          </Button>
        </div>
        {(data.hr_timeline || []).map((entry, i) => (
          <div key={i} className="flex gap-2 mb-2 items-center">
            <Input type="number" placeholder="Min" value={entry.minute} onChange={(e) => updateTimeline(i, "minute", e.target.value)} className="h-10 w-20 font-mono text-center" />
            <span className="text-muted-foreground text-xs">min</span>
            <Input type="number" placeholder="HR" value={entry.hr} onChange={(e) => updateTimeline(i, "hr", e.target.value)} className="h-10 w-20 font-mono text-center" />
            <span className="text-muted-foreground text-xs">bpm</span>
            <Button type="button" variant="ghost" size="icon" className="h-8 w-8" onClick={() => removeTimeline(i)}>
              <Trash2 className="w-3.5 h-3.5 text-destructive" />
            </Button>
          </div>
        ))}
      </div>
    </div>
  );
}