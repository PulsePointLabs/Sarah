import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { base44 } from "@/api/base44Client";
import { Upload, CheckCircle, AlertCircle, Camera, Trash2, X } from "lucide-react";
import { parseEmgCsv } from "@/utils/parseEmgCsv";
import EMGTimelineChart from "@/components/EMGTimelineChart";

const TARGET_AREAS = [
  "Tibialis anterior",
  "Dorsal foot / toe extensors",
  "Medial arch / abductor hallucis",
  "Ball of foot / toe flexors",
  "Perineal / pelvic floor",
  "Other",
];

const PHOTO_TAGS = ["single sensor", "left placement", "right placement", "reference electrode", "general setup"];

function PhotoEntry({ photo, onChange, onRemove }) {
  return (
    <div className="flex items-start gap-2 bg-muted/40 rounded-lg p-2">
      <img src={photo.url} alt="" className="w-16 h-16 object-cover rounded-lg shrink-0" />
      <div className="flex-1 space-y-1.5">
        <select
          value={photo.tag || "general setup"}
          onChange={(e) => onChange({ ...photo, tag: e.target.value })}
          className="w-full bg-background border border-border rounded px-2 py-1 text-xs"
        >
          {PHOTO_TAGS.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
        <input
          type="text"
          placeholder="Caption / notes"
          value={photo.caption || ""}
          onChange={(e) => onChange({ ...photo, caption: e.target.value })}
          className="w-full bg-background border border-border rounded px-2 py-1 text-xs"
        />
      </div>
      <button onClick={onRemove} className="shrink-0 p-1 text-destructive hover:opacity-70">
        <X className="w-3.5 h-3.5" />
      </button>
    </div>
  );
}

export default function EMGSection({ data, onChange }) {
  const [uploading, setUploading] = useState(false);
  const [importResult, setImportResult] = useState(null);
  const [uploadingPhoto, setUploadingPhoto] = useState(false);

  const update = (fields) => onChange({ ...data, ...fields });

  const emgRows = data._emg_rows || [];
  const channelMode = data._emg_channel_mode || (data.emg_channels || "single");
  const emgPhotos = data.emg_placement_photos || [];
  const hasStoredFile = !!data.emg_data_file;

  const handleCSVUpload = async (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setUploading(true);
    setImportResult(null);

    // Parse locally for preview + validation
    const text = await file.text();
    const result = parseEmgCsv(text);

    if (result.error) {
      setImportResult({ error: result.error });
      setUploading(false);
      return;
    }

    const { rows, channelMode, skipped, total } = result;

    // Zero the time axis using RECORD_START marker
    const startRow = rows.find((r) => r.marker === "RECORD_START");
    const timeZero = startRow ? startRow.time_s : rows[0].time_s;
    const normalizedRows = rows.map((r) => ({ ...r, time_s: parseFloat((r.time_s - timeZero).toFixed(6)) }));

    // Upload the raw CSV file for persistent storage (no database rows needed)
    const { file_url } = await base44.integrations.Core.UploadFile({ file });

    update({
      // Store the file URL on the session — this is all that gets saved to the DB
      emg_data_file: file_url,
      emg_enabled: true,
      emg_channels: channelMode,
      // Keep parsed rows in memory for the preview chart only (not saved to DB)
      _emg_rows: normalizedRows,
      _emg_channel_mode: channelMode,
    });

    setImportResult({ imported: rows.length, total, skipped });
    setUploading(false);
  };

  const handlePhotoUpload = async (e) => {
    const files = Array.from(e.target.files || []);
    if (!files.length) return;
    setUploadingPhoto(true);
    const uploaded = await Promise.all(
      files.map(async (file) => {
        const { file_url } = await base44.integrations.Core.UploadFile({ file });
        return { url: file_url, tag: "general setup", caption: "" };
      })
    );
    update({ emg_placement_photos: [...emgPhotos, ...uploaded] });
    setUploadingPhoto(false);
  };

  const updatePhoto = (i, updated) => {
    const arr = [...emgPhotos];
    arr[i] = updated;
    update({ emg_placement_photos: arr });
  };

  const removePhoto = (i) => {
    update({ emg_placement_photos: emgPhotos.filter((_, idx) => idx !== i) });
  };

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-primary">EMG (MyoWare)</h3>

      {/* Enable toggle */}
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => update({ emg_enabled: !data.emg_enabled })}
          className={`relative w-10 h-5 rounded-full transition-colors ${data.emg_enabled ? "bg-primary" : "bg-muted"}`}
        >
          <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${data.emg_enabled ? "translate-x-5" : ""}`} />
        </button>
        <Label className="text-sm">EMG Recording Enabled</Label>
      </div>

      {/* Sensor info */}
      <div className="grid grid-cols-2 gap-3">
        <div>
          <Label className="text-xs text-muted-foreground">Sensor Type</Label>
          <Input
            value={data.emg_sensor_type || "MyoWare 2.0"}
            onChange={(e) => update({ emg_sensor_type: e.target.value })}
            className="h-10 mt-1 text-sm"
            placeholder="MyoWare 2.0"
          />
        </div>
        <div>
          <Label className="text-xs text-muted-foreground">Channels</Label>
          <select
            value={data.emg_channels || "single"}
            onChange={(e) => update({ emg_channels: e.target.value })}
            className="mt-1 w-full h-10 bg-background border border-border rounded-md px-3 text-sm"
          >
            <option value="single">Single</option>
            <option value="dual">Dual (Left + Right)</option>
          </select>
        </div>
      </div>

      {/* Target area */}
      <div>
        <Label className="text-xs text-muted-foreground">Target Muscle Area</Label>
        <select
          value={data.emg_target_area || ""}
          onChange={(e) => update({ emg_target_area: e.target.value })}
          className="mt-1 w-full h-10 bg-background border border-border rounded-md px-3 text-sm"
        >
          <option value="">Select area…</option>
          {TARGET_AREAS.map((a) => <option key={a} value={a}>{a}</option>)}
        </select>
      </div>

      {/* L/R flip */}
      {data.emg_channels === "dual" && (
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={() => update({ emg_left_right_flipped: !data.emg_left_right_flipped })}
            className={`relative w-10 h-5 rounded-full transition-colors ${data.emg_left_right_flipped ? "bg-primary" : "bg-muted"}`}
          >
            <span className={`absolute top-0.5 left-0.5 w-4 h-4 rounded-full bg-white shadow transition-transform ${data.emg_left_right_flipped ? "translate-x-5" : ""}`} />
          </button>
          <Label className="text-xs text-muted-foreground">Left/Right channels flipped</Label>
        </div>
      )}

      {/* CSV Upload */}
      <div>
        <Label className="text-xs text-muted-foreground">EMG CSV File</Label>
        <label className="mt-1 flex items-center justify-center gap-2 border-2 border-dashed border-border rounded-lg p-3 cursor-pointer hover:border-primary/50 transition-colors">
          <Upload className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">
            {uploading
              ? "Uploading…"
              : emgRows.length > 0
                ? `${emgRows.length} rows ready (${channelMode}) ✓`
                : hasStoredFile
                  ? "CSV saved ✓ — upload new to replace"
                  : "Upload EMG CSV"}
          </span>
          <input type="file" accept=".csv" className="hidden" onChange={handleCSVUpload} disabled={uploading} />
        </label>

        {importResult && !importResult.error && (
          <div className="mt-2 p-2.5 rounded-lg bg-primary/10 text-primary text-xs flex items-center gap-1.5 font-medium">
            <CheckCircle className="w-3.5 h-3.5 shrink-0" />
            {importResult.imported} of {importResult.total} rows parsed
            {importResult.skipped > 0 && ` (${importResult.skipped} skipped)`}
            {" · "}{channelMode}-channel
          </div>
        )}
        {importResult?.error && (
          <div className="mt-2 p-2.5 rounded-lg bg-destructive/10 text-destructive text-xs flex items-start gap-1.5">
            <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />{importResult.error}
          </div>
        )}
      </div>

      {/* Chart preview */}
      {emgRows.length > 0 && (
        <div>
          <Label className="text-xs text-muted-foreground mb-2 block">EMG Preview</Label>
          <EMGTimelineChart rows={emgRows} channelMode={channelMode} />
        </div>
      )}

      {/* Placement notes */}
      <div className="space-y-3">
        <Label className="text-xs text-muted-foreground uppercase tracking-wide">Placement Notes</Label>
        {(data.emg_channels === "dual") ? (
          <>
            <div>
              <Label className="text-xs text-muted-foreground">Left Channel Placement</Label>
              <textarea
                value={data.emg_left_placement_notes || ""}
                onChange={(e) => update({ emg_left_placement_notes: e.target.value })}
                className="mt-1 w-full bg-background border border-border rounded-md px-3 py-2 text-sm resize-none h-20"
                placeholder="Describe left electrode placement…"
              />
            </div>
            <div>
              <Label className="text-xs text-muted-foreground">Right Channel Placement</Label>
              <textarea
                value={data.emg_right_placement_notes || ""}
                onChange={(e) => update({ emg_right_placement_notes: e.target.value })}
                className="mt-1 w-full bg-background border border-border rounded-md px-3 py-2 text-sm resize-none h-20"
                placeholder="Describe right electrode placement…"
              />
            </div>
          </>
        ) : (
          <div>
            <Label className="text-xs text-muted-foreground">Sensor Placement</Label>
            <textarea
              value={data.emg_left_placement_notes || ""}
              onChange={(e) => update({ emg_left_placement_notes: e.target.value })}
              className="mt-1 w-full bg-background border border-border rounded-md px-3 py-2 text-sm resize-none h-20"
              placeholder="Describe electrode placement…"
            />
          </div>
        )}
        <div>
          <Label className="text-xs text-muted-foreground">General EMG Notes</Label>
          <textarea
            value={data.emg_general_notes || ""}
            onChange={(e) => update({ emg_general_notes: e.target.value })}
            className="mt-1 w-full bg-background border border-border rounded-md px-3 py-2 text-sm resize-none h-16"
            placeholder="General observations about the EMG recording…"
          />
        </div>
      </div>

      {/* Placement photos */}
      <div className="space-y-2">
        <Label className="text-xs text-muted-foreground uppercase tracking-wide">Placement Photos</Label>
        {emgPhotos.length > 0 && (
          <div className="space-y-2">
            {emgPhotos.map((photo, i) => (
              <PhotoEntry key={i} photo={photo} onChange={(p) => updatePhoto(i, p)} onRemove={() => removePhoto(i)} />
            ))}
          </div>
        )}
        <label className="flex items-center gap-2 border border-dashed border-border rounded-lg p-3 cursor-pointer hover:border-primary/50 transition-colors">
          <Camera className="w-4 h-4 text-muted-foreground" />
          <span className="text-sm text-muted-foreground">
            {uploadingPhoto ? "Uploading…" : "Add placement photo(s)"}
          </span>
          <input type="file" accept="image/*" multiple className="hidden" onChange={handlePhotoUpload} disabled={uploadingPhoto} />
        </label>
      </div>
    </div>
  );
}