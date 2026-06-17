import { useMemo, useState } from "react";
import { CheckCircle2, ExternalLink, FileVideo, FolderOpen, RefreshCw, Trash2, Upload, XCircle } from "lucide-react";
import { Button } from "@/components/ui/button";
import { base44 } from "@/api/base44Client";

function makeId() {
  return `local-video-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value < 1024) return `${value} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let size = value / 1024;
  let unit = units.shift();
  while (size >= 1024 && units.length) {
    size /= 1024;
    unit = units.shift();
  }
  return `${size >= 10 ? size.toFixed(1) : size.toFixed(2)} ${unit}`;
}

function formatDate(value) {
  if (!value) return "not checked";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "not checked";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

function normalizeVideoRecord(video) {
  return {
    id: video.id || makeId(),
    label: video.label || video.filename || "Linked local video",
    path: video.path || "",
    filename: video.filename || "",
    sizeBytes: video.sizeBytes || 0,
    durationSeconds: Number(video.durationSeconds) || 0,
    modifiedAt: video.modifiedAt || null,
    fingerprint: video.fingerprint || "",
    mimeType: video.mimeType || "",
    exists: video.exists !== false,
    timelineOffsetSeconds: Number(video.timelineOffsetSeconds) || 0,
    linkedAt: video.linkedAt || new Date().toISOString(),
    lastCheckedAt: video.lastCheckedAt || video.checkedAt || null,
  };
}

function cleanDroppedPath(value) {
  const raw = String(value || "").trim().replace(/^"+|"+$/g, "");
  if (!raw) return "";
  const firstLine = raw.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] || "";
  if (firstLine.startsWith("file:///")) {
    try {
      const url = new URL(firstLine);
      return decodeURIComponent(url.pathname)
        .replace(/^\/([A-Za-z]:)/, "$1")
        .replace(/\//g, "\\");
    } catch {
      return firstLine.replace(/^file:\/\/\//, "").replace(/\//g, "\\");
    }
  }
  return firstLine;
}

function errorMessage(err, fallback) {
  const raw = err?.data?.error || err?.message || fallback;
  const text = String(raw || fallback);
  if (text.includes("<!DOCTYPE html>") || err?.status === 404) {
    return "The local video API is not available in the running server yet. Restart the local API server, then try again.";
  }
  return text;
}

export default function LinkedLocalVideoManager({
  videos = [],
  onChange,
  title = "Linked Local Videos",
  helper = "Save references to original recordings without uploading raw video. If the file moves or the drive disconnects, relink or update the path.",
}) {
  const normalizedVideos = useMemo(() => (videos || []).map(normalizeVideoRecord), [videos]);
  const [pathInput, setPathInput] = useState("");
  const [labelInput, setLabelInput] = useState("");
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [dragActive, setDragActive] = useState(false);

  const saveVideos = async (nextVideos) => {
    await onChange?.(nextVideos.map(normalizeVideoRecord));
  };

  const addVideo = async () => {
    const requestedPath = pathInput.trim();
    if (!requestedPath) {
      setError("Paste the full local video path first.");
      return;
    }
    setBusy("add");
    setError("");
    try {
      const meta = await base44.integrations.Core.GetLocalVideoMetadata({ path: requestedPath });
      const next = normalizeVideoRecord({
        id: makeId(),
        label: labelInput.trim() || meta.filename,
        path: meta.path,
        filename: meta.filename,
        sizeBytes: meta.sizeBytes,
        durationSeconds: meta.durationSeconds,
        modifiedAt: meta.modifiedAt,
        fingerprint: meta.fingerprint,
        mimeType: meta.mimeType,
        exists: true,
        linkedAt: new Date().toISOString(),
        lastCheckedAt: meta.checkedAt,
      });
      await saveVideos([next, ...normalizedVideos.filter((video) => video.path !== next.path)]);
      setPathInput("");
      setLabelInput("");
    } catch (err) {
      setError(errorMessage(err, "Could not link that local video."));
    } finally {
      setBusy("");
    }
  };

  const browseVideo = async () => {
    setBusy("browse");
    setError("");
    try {
      const meta = await base44.integrations.Core.BrowseLocalVideo();
      if (meta?.cancelled) return;
      setPathInput(meta.path || "");
      if (!labelInput.trim()) setLabelInput(meta.filename || "");
    } catch (err) {
      setError(errorMessage(err, "Could not open the local video picker."));
    } finally {
      setBusy("");
    }
  };

  const applyDroppedPath = (path, file, allowFileOnly = true) => {
    const cleaned = cleanDroppedPath(path);
    if (cleaned) {
      setPathInput(cleaned);
      if (!labelInput.trim()) setLabelInput(file?.name || cleaned.split(/[\\/]/).pop() || "");
      setError("");
      return true;
    }
    if (allowFileOnly && file?.name) {
      setLabelInput((current) => current || file.name);
      setError("The browser accepted the video but did not expose its full Windows path. Try dropping copied path text, or paste the path from File Explorer / OBS.");
      return true;
    }
    return false;
  };

  const applyResolvedVideo = (meta, file) => {
    if (!meta?.path) return false;
    setPathInput(meta.path);
    if (!labelInput.trim()) setLabelInput(meta.filename || file?.name || "");
    setError("");
    return true;
  };

  const resolveDroppedFile = async (file) => {
    if (!file?.name) return false;
    setBusy("resolve-drop");
    setError("");
    try {
      const meta = await base44.integrations.Core.ResolveDroppedLocalVideo({
        filename: file.name,
        sizeBytes: file.size || 0,
        modifiedAtMs: file.lastModified || 0,
      });
      return applyResolvedVideo(meta, file);
    } catch (err) {
      setLabelInput((current) => current || file.name);
      setError(errorMessage(err, "Chrome hid the full Windows path and Sarah could not resolve that dropped video automatically. Use Browse or paste the full path."));
      return true;
    } finally {
      setBusy("");
    }
  };

  const handleDrop = async (event) => {
    event.preventDefault();
    event.stopPropagation();
    setDragActive(false);
    const transfer = event.dataTransfer;
    const textPath = cleanDroppedPath(transfer.getData("text/uri-list") || transfer.getData("text/plain"));
    if (applyDroppedPath(textPath)) return;

    const item = [...(transfer.items || [])].find((entry) => entry.kind === "file");
    const file = item?.getAsFile?.() || transfer.files?.[0];
    const exposedPath = file?.path || file?.webkitRelativePath || "";
    if (applyDroppedPath(exposedPath, file, false)) return;
    if (await resolveDroppedFile(file)) return;
    setError("Drop a local video file here, or paste its full path from File Explorer / OBS.");
  };

  const refreshVideo = async (video) => {
    setBusy(video.id);
    setError("");
    try {
      const meta = await base44.integrations.Core.GetLocalVideoMetadata({ path: video.path });
      const next = normalizedVideos.map((item) => item.id === video.id
        ? normalizeVideoRecord({
            ...item,
            path: meta.path,
            filename: meta.filename,
            sizeBytes: meta.sizeBytes,
            durationSeconds: meta.durationSeconds,
            modifiedAt: meta.modifiedAt,
            fingerprint: meta.fingerprint,
            mimeType: meta.mimeType,
            exists: true,
            lastCheckedAt: meta.checkedAt,
          })
        : item);
      await saveVideos(next);
    } catch (err) {
      const next = normalizedVideos.map((item) => item.id === video.id
        ? normalizeVideoRecord({ ...item, exists: false, lastCheckedAt: new Date().toISOString() })
        : item);
      await saveVideos(next);
      setError(errorMessage(err, "That linked video is not reachable right now."));
    } finally {
      setBusy("");
    }
  };

  const removeVideo = async (videoId) => {
    await saveVideos(normalizedVideos.filter((video) => video.id !== videoId));
  };

  const updateTimelineOffset = async (videoId, value) => {
    const timelineOffsetSeconds = Number(value) || 0;
    setBusy(`offset:${videoId}`);
    setError("");
    try {
      await saveVideos(normalizedVideos.map((video) => (
        video.id === videoId ? { ...video, timelineOffsetSeconds } : video
      )));
    } catch (err) {
      setError(errorMessage(err, "Could not save that video timeline offset."));
    } finally {
      setBusy("");
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-primary">
            <FileVideo className="h-4 w-4" /> {title}
          </h3>
          <p className="mt-1 max-w-3xl text-xs leading-relaxed text-muted-foreground">{helper}</p>
        </div>
        <span className="rounded-full border border-border bg-muted/30 px-2 py-1 text-[10px] font-semibold text-muted-foreground">
          {normalizedVideos.length} linked
        </span>
      </div>

      <div
        className={`mt-3 rounded-xl border border-dashed p-2 transition-colors ${
          dragActive ? "border-primary bg-primary/10" : "border-border bg-muted/10"
        }`}
        onDragEnter={(event) => { event.preventDefault(); setDragActive(true); }}
        onDragOver={(event) => { event.preventDefault(); setDragActive(true); }}
        onDragLeave={(event) => { event.preventDefault(); setDragActive(false); }}
        onDrop={handleDrop}
      >
        <div className="grid gap-2 lg:grid-cols-[auto_1fr_14rem_auto]">
          <Button type="button" size="sm" variant="outline" onClick={browseVideo} disabled={busy === "browse"} className="h-9 gap-1.5">
            {busy === "browse" ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <FolderOpen className="h-3.5 w-3.5" />}
            Browse
          </Button>
          <input
            value={pathInput}
            onChange={(event) => setPathInput(event.target.value)}
            placeholder="Paste or drop full video path, e.g. D:\OBS\Sessions\2026-05-31.mkv"
            className="h-9 min-w-0 rounded-lg border border-border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <input
            value={labelInput}
            onChange={(event) => setLabelInput(event.target.value)}
            placeholder="Optional label"
            className="h-9 min-w-0 rounded-lg border border-border bg-background px-3 text-sm text-foreground focus:outline-none focus:ring-1 focus:ring-primary"
          />
          <Button type="button" size="sm" onClick={addVideo} disabled={busy === "add"} className="h-9 gap-1.5">
            {busy === "add" ? <RefreshCw className="h-3.5 w-3.5 animate-spin" /> : <FileVideo className="h-3.5 w-3.5" />}
            Link Video
          </Button>
        </div>
        <div className="mt-2 flex items-center gap-1.5 text-[10px] text-muted-foreground">
          <Upload className="h-3.5 w-3.5" />
          Drop a video file or copied path here. If the browser hides the path, paste it from File Explorer or OBS.
        </div>
      </div>
      <p className="mt-1 text-[10px] text-muted-foreground">
        Browse opens a local Windows picker from the app server. You can still paste a path from File Explorer or OBS recording settings.
      </p>

      {error && (
        <div className="mt-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {error}
        </div>
      )}

      {normalizedVideos.length > 0 && (
        <div className="mt-3 space-y-2">
          {normalizedVideos.map((video) => {
            const streamUrl = video.exists && video.path ? base44.integrations.Core.localVideoStreamUrl(video.path) : "";
            return (
              <div key={video.id} className="rounded-lg border border-border bg-muted/20 p-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <p className="truncate text-sm font-semibold text-foreground">{video.label || video.filename}</p>
                      {video.exists ? (
                        <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-0.5 text-[10px] text-emerald-300">
                          <CheckCircle2 className="h-3 w-3" /> Found
                        </span>
                      ) : (
                        <span className="inline-flex items-center gap-1 rounded-full border border-destructive/30 bg-destructive/10 px-2 py-0.5 text-[10px] text-destructive">
                          <XCircle className="h-3 w-3" /> Missing
                        </span>
                      )}
                    </div>
                    <p className="mt-1 truncate font-mono text-[10px] text-muted-foreground">{video.path}</p>
                    <p className="mt-1 text-[10px] text-muted-foreground">
                      {video.filename || "video"} · {formatBytes(video.sizeBytes)} · modified {formatDate(video.modifiedAt)} · checked {formatDate(video.lastCheckedAt)}
                    </p>
                    <label className="mt-2 flex max-w-md items-center gap-2 text-[10px] text-muted-foreground">
                      <span className="shrink-0">Video 0:00 = record timeline</span>
                      <input
                        key={`${video.id}:${video.timelineOffsetSeconds}`}
                        type="number"
                        defaultValue={video.timelineOffsetSeconds}
                        step="0.1"
                        onBlur={(event) => updateTimelineOffset(video.id, event.target.value)}
                        className="h-7 w-20 rounded border border-border bg-background px-2 text-center font-mono text-xs text-foreground"
                        aria-label={`Timeline offset for ${video.label || video.filename}`}
                      />
                      <span>s</span>
                      <span>Positive means the video starts after the record timeline.</span>
                    </label>
                  </div>
                  <div className="flex flex-wrap items-center gap-1.5">
                    {streamUrl && (
                      <a
                        href={streamUrl}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex h-8 items-center gap-1.5 rounded-md border border-primary/25 bg-primary/10 px-2 text-[11px] font-medium text-primary hover:bg-primary/15"
                      >
                        <ExternalLink className="h-3.5 w-3.5" /> Open
                      </a>
                    )}
                    <Button type="button" size="sm" variant="outline" onClick={() => refreshVideo(video)} disabled={busy === video.id} className="h-8 gap-1.5 px-2 text-[11px]">
                      <RefreshCw className={`h-3.5 w-3.5 ${busy === video.id ? "animate-spin" : ""}`} />
                      Check
                    </Button>
                    <Button type="button" size="sm" variant="ghost" onClick={() => removeVideo(video.id)} className="h-8 px-2 text-[11px] text-muted-foreground hover:text-destructive">
                      <Trash2 className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
