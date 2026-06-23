import { useEffect, useMemo, useRef, useState } from "react";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Progress } from "@/components/ui/progress";
import { Clapperboard, Download, Play, UploadCloud, Video } from "lucide-react";
import { bloodPressureReadingsFromSession, pulseOxReadingsFromSession } from "@/lib/sessionContext";

const CHUNK_SIZE = 4 * 1024 * 1024;

function fileSha256(file) {
  if (!window.crypto?.subtle) return Promise.resolve(null);
  return file.arrayBuffer()
    .then((buffer) => window.crypto.subtle.digest("SHA-256", buffer))
    .then((digest) => Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join(""));
}

function latestOrNull(rows = []) {
  return Array.isArray(rows) && rows.length ? rows[rows.length - 1] : null;
}

function buildTelemetryPackage(session = {}) {
  const bpRows = bloodPressureReadingsFromSession(session);
  const spo2Rows = pulseOxReadingsFromSession(session);
  const hrRows = Array.isArray(session.hr_data) ? session.hr_data : [];
  return {
    schema_version: 1,
    session_id: session.id,
    video_start_timestamp: session.start_datetime || session.started_at || session.date || null,
    video_stop_timestamp: session.end_datetime || session.ended_at || null,
    duration_seconds: session.duration_seconds || session.duration || null,
    blood_pressure_snapshots: bpRows,
    spo2_timeline: spo2Rows,
    hr_timeline: hrRows,
    annotations: Array.isArray(session.event_timeline) ? session.event_timeline : [],
  };
}

export default function MobileSessionVideoRenderPanel({ session }) {
  const [capabilities, setCapabilities] = useState(null);
  const [file, setFile] = useState(null);
  const [status, setStatus] = useState("Ready.");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState(0);
  const [job, setJob] = useState(null);
  const [rendered, setRendered] = useState(null);
  const [recordings, setRecordings] = useState([]);
  const pollRef = useRef(null);

  const latestBp = useMemo(() => latestOrNull(bloodPressureReadingsFromSession(session)), [session]);
  const latestSpo2 = useMemo(() => latestOrNull(pulseOxReadingsFromSession(session)), [session]);

  useEffect(() => {
    let cancelled = false;
    base44.integrations.Core.GetSessionVideoCapabilities()
      .then((data) => {
        if (!cancelled) setCapabilities(data);
      })
      .catch((error) => {
        if (!cancelled) setStatus(error.message || "Video render service is unavailable.");
      });
    base44.integrations.Core.ListSessionRecordings({ sessionId: session?.id })
      .then((rows) => {
        if (!cancelled) setRecordings(Array.isArray(rows) ? rows : []);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [session?.id]);

  const uploadAndRender = async () => {
    if (!file || !session?.id) return;
    setBusy(true);
    setRendered(null);
    setJob(null);
    setProgress(1);
    try {
      setStatus("Hashing video file...");
      const sha256 = await fileSha256(file);
      const recording = await base44.integrations.Core.CreateSessionRecording({
        session_id: session.id,
        source_filename: file.name,
        source_device_id: "manual-session-details-upload",
        duration_seconds: session.duration_seconds || session.duration || null,
        telemetry_package: buildTelemetryPackage(session),
      });
      const upload = await base44.integrations.Core.InitSessionVideoUpload({
        recording_id: recording.id,
        filename: file.name,
        total_bytes: file.size,
        chunk_size: CHUNK_SIZE,
        sha256,
      });
      const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
      for (let index = 0; index < totalChunks; index += 1) {
        const start = index * CHUNK_SIZE;
        const end = Math.min(file.size, start + CHUNK_SIZE);
        setStatus(`Uploading chunk ${index + 1} of ${totalChunks}...`);
        await base44.integrations.Core.UploadSessionVideoChunk({
          uploadId: upload.id,
          chunkIndex: index,
          bytes: file.slice(start, end),
        });
        setProgress(Math.round(((index + 1) / totalChunks) * 45));
      }
      setStatus("Finalizing upload...");
      const finalized = await base44.integrations.Core.FinalizeSessionVideoUpload(upload.id);
      setRecordings((prev) => [finalized.recording, ...prev.filter((row) => row.id !== finalized.recording.id)]);
      setStatus("Starting desktop render...");
      const started = await base44.integrations.Core.StartSessionVideoRender({
        recording_id: finalized.recording.id,
        session_id: session.id,
        preset_id: "clean_clinical",
      });
      setJob(started);
      setProgress(50);
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = window.setInterval(async () => {
        const next = await base44.integrations.Core.GetSessionVideoRenderJob(started.id);
        setJob(next);
        const pct = Number(next?.progress?.percent ?? next?.progress?.current ?? 50);
        setProgress(Math.max(50, Math.min(100, pct)));
        setStatus(next?.progress?.message || "Rendering...");
        if (next.status === "complete") {
          window.clearInterval(pollRef.current);
          pollRef.current = null;
          const renderedId = next?.result?.id || next?.result?.rendered_video_id;
          if (renderedId) {
            const metadata = await base44.integrations.Core.GetRenderedSessionVideo(renderedId);
            setRendered(metadata);
          }
          setProgress(100);
          setBusy(false);
          setStatus("Rendered video complete.");
        } else if (next.status === "error" || next.status === "cancelled") {
          window.clearInterval(pollRef.current);
          pollRef.current = null;
          setBusy(false);
          setStatus(next.error || "Render stopped.");
        }
      }, 1200);
    } catch (error) {
      if (pollRef.current) window.clearInterval(pollRef.current);
      pollRef.current = null;
      setBusy(false);
      setStatus(error.message || "Video upload/render failed.");
    }
  };

  return (
    <Card id="session-mobile-video-render" className="scroll-mt-24">
      <CardHeader>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2 text-base">
              <Clapperboard className="h-4 w-4 text-primary" />
              Mobile Session Video Render
            </CardTitle>
            <CardDescription>
              Upload an APK-recorded session video here, then let the desktop renderer produce the finished MP4 with session telemetry.
            </CardDescription>
          </div>
          <div className="flex flex-wrap gap-2">
            <Badge variant={capabilities?.ffmpeg_available ? "default" : "secondary"}>
              {capabilities?.ffmpeg_available ? "FFmpeg ready" : "Checking renderer"}
            </Badge>
            {latestBp && <Badge variant="outline">BP {latestBp.systolic_mm_hg}/{latestBp.diastolic_mm_hg}</Badge>}
            {latestSpo2 && <Badge variant="outline">SpO2 {latestSpo2.spo2_percent || latestSpo2.spo2 || latestSpo2.value}%</Badge>}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid gap-3 md:grid-cols-[1fr_auto]">
          <Input
            type="file"
            accept="video/*,.mp4,.mov,.webm,.mkv"
            disabled={busy}
            onChange={(event) => setFile(event.target.files?.[0] || null)}
          />
          <Button type="button" disabled={!file || busy || capabilities?.ffmpeg_available === false} onClick={uploadAndRender}>
            <UploadCloud className="mr-2 h-4 w-4" />
            Upload & Render
          </Button>
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between gap-3 text-sm">
            <span className="text-muted-foreground">{status}</span>
            {file && <span className="font-mono text-xs text-muted-foreground">{(file.size / 1024 / 1024).toFixed(1)} MB</span>}
          </div>
          <Progress value={progress} />
        </div>

        {rendered && (
          <div className="space-y-3 rounded-lg border border-border bg-muted/20 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <div>
                <p className="text-sm font-semibold">Rendered MP4 ready</p>
                <p className="text-xs text-muted-foreground">{rendered.filename}</p>
              </div>
              <div className="flex gap-2">
                <Button asChild size="sm" variant="secondary">
                  <a href={base44.integrations.Core.renderedSessionVideoStreamUrl(rendered.id)} target="_blank" rel="noreferrer">
                    <Play className="mr-2 h-4 w-4" />
                    Preview
                  </a>
                </Button>
                <Button asChild size="sm">
                  <a href={base44.integrations.Core.renderedSessionVideoDownloadUrl(rendered.id)}>
                    <Download className="mr-2 h-4 w-4" />
                    Download
                  </a>
                </Button>
              </div>
            </div>
            <video className="max-h-80 w-full rounded-md bg-black" controls src={base44.integrations.Core.renderedSessionVideoStreamUrl(rendered.id)} />
          </div>
        )}

        {recordings.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Recent mobile recordings for this session</p>
            <div className="grid gap-2">
              {recordings.slice(0, 3).map((recording) => (
                <div key={recording.id} className="flex items-center justify-between rounded-md border border-border px-3 py-2 text-sm">
                  <span className="flex min-w-0 items-center gap-2">
                    <Video className="h-4 w-4 text-muted-foreground" />
                    <span className="truncate">{recording.source_filename || recording.id}</span>
                  </span>
                  <Badge variant={recording.upload_status === "complete" ? "default" : "secondary"}>
                    {recording.upload_status || "metadata"}
                  </Badge>
                </div>
              ))}
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
