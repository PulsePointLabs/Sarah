import { useEffect, useMemo, useRef, useState } from "react";
import { base44 } from "@/api/base44Client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Download, Play, Radio, Square, UploadCloud, Video } from "lucide-react";

const CHUNK_SIZE = 4 * 1024 * 1024;

function pickRecorderMimeType() {
  const candidates = [
    "video/webm;codecs=vp8,opus",
    "video/webm;codecs=vp9,opus",
    "video/webm",
    "video/mp4",
  ];
  return candidates.find((type) => window.MediaRecorder?.isTypeSupported?.(type)) || "";
}

function extensionForMime(type = "") {
  if (/mp4/i.test(type)) return "mp4";
  return "webm";
}

function makeHash(file) {
  if (!window.crypto?.subtle) return Promise.resolve(null);
  return file.arrayBuffer()
    .then((buffer) => window.crypto.subtle.digest("SHA-256", buffer))
    .then((digest) => Array.from(new Uint8Array(digest)).map((byte) => byte.toString(16).padStart(2, "0")).join(""));
}

function latestValue(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function normalizeHrSample(sample = {}, fallbackTimeS = 0) {
  const hr = latestValue(sample.hr, sample.currentHr, sample.heart_rate_bpm, sample.value);
  if (hr == null) return null;
  return {
    t: Number(sample.t ?? sample.time_s ?? fallbackTimeS) || 0,
    hr: Math.round(Number(hr)),
    hrv_rmssd_ms: latestValue(sample.hrv?.rmssdMs, sample.hrv_rmssd_ms, sample.rmssd_ms),
    source_at: sample.source_at || sample.measured_at || sample.timestamp || null,
  };
}

function normalizeEmgSample(sample = {}, fallbackTimeS = 0) {
  const left = latestValue(sample.left, sample.left_pct, sample.level_pct);
  const right = latestValue(sample.right, sample.right_pct);
  if (left == null && right == null) return null;
  return {
    t: Number(sample.t ?? sample.time_s ?? fallbackTimeS) || 0,
    left_pct: left == null ? null : Number(left),
    right_pct: right == null ? null : Number(right),
    source_at: sample.source_at || sample.measured_at || sample.timestamp || null,
  };
}

function buildTelemetryPackage({
  session,
  sessionState,
  startedAt,
  stoppedAt,
  startedPerfMs,
  durationSeconds,
  samples,
  latestBp,
  latestSpo2,
}) {
  const hrTimeline = samples.map((sample) => normalizeHrSample(sample.hr, sample.time_s)).filter(Boolean);
  const emgTimeline = samples.map((sample) => normalizeEmgSample(sample.emg, sample.time_s)).filter(Boolean);
  const bloodPressureSnapshots = [
    ...(Array.isArray(session?.blood_pressure_readings) ? session.blood_pressure_readings : []),
    ...(latestBp ? [latestBp] : []),
  ].filter(Boolean);
  const spo2Timeline = [
    ...(Array.isArray(session?.pulse_ox_readings) ? session.pulse_ox_readings : []),
    ...(latestSpo2 ? [latestSpo2] : []),
  ].filter(Boolean);

  return {
    schema_version: 1,
    session_id: sessionState?.activeSessionId || session?.id || null,
    recording_id: null,
    video_start_timestamp: startedAt,
    video_stop_timestamp: stoppedAt,
    monotonic_start_ms: startedPerfMs,
    duration_seconds: durationSeconds,
    channels: {
      hr: hrTimeline.length > 0,
      emg: emgTimeline.length > 0,
      blood_pressure: bloodPressureSnapshots.length > 0,
      spo2: spo2Timeline.length > 0,
    },
    samples,
    annotations: Array.isArray(session?.event_timeline) ? session.event_timeline : [],
    blood_pressure_snapshots: bloodPressureSnapshots,
    spo2_timeline: spo2Timeline,
    hr_timeline: hrTimeline,
    hrv_timeline: hrTimeline.filter((row) => row.hrv_rmssd_ms != null),
    emg_timeline: emgTimeline,
    connection_gaps: [],
  };
}

export default function LiveSessionMobileRecorder({
  activeSessionDoc,
  liveSession,
  ensureSession,
  telemetryHistory = [],
  hrTelemetry,
  emgTelemetry,
  latestBpReading,
  latestSpo2Reading,
}) {
  const [supported, setSupported] = useState(false);
  const [recording, setRecording] = useState(false);
  const [previewUrl, setPreviewUrl] = useState("");
  const [status, setStatus] = useState("Ready to record a clean source video on this phone.");
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [rendered, setRendered] = useState(null);
  const [job, setJob] = useState(null);
  const [startedAt, setStartedAt] = useState(null);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const recorderRef = useRef(null);
  const chunksRef = useRef([]);
  const sampleTimerRef = useRef(null);
  const sessionStateRef = useRef(null);
  const samplesRef = useRef([]);
  const latestTelemetryRef = useRef({ hrTelemetry, emgTelemetry, latestBpReading, latestSpo2Reading });
  const startRef = useRef({ iso: null, perfMs: 0 });
  const pollRef = useRef(null);

  useEffect(() => {
    setSupported(Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder));
  }, []);

  useEffect(() => {
    latestTelemetryRef.current = { hrTelemetry, emgTelemetry, latestBpReading, latestSpo2Reading };
  }, [emgTelemetry, hrTelemetry, latestBpReading, latestSpo2Reading]);

  useEffect(() => () => {
    if (pollRef.current) window.clearInterval(pollRef.current);
    if (sampleTimerRef.current) window.clearInterval(sampleTimerRef.current);
    streamRef.current?.getTracks?.().forEach((track) => track.stop());
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  const sessionId = liveSession?.activeSessionId || activeSessionDoc?.id || null;
  const elapsedText = useMemo(() => {
    if (!startedAt) return "";
    const elapsed = Math.max(0, Math.round((Date.now() - new Date(startedAt).getTime()) / 1000));
    const min = Math.floor(elapsed / 60);
    const sec = String(elapsed % 60).padStart(2, "0");
    return `${min}:${sec}`;
  }, [startedAt, recording]);

  const captureTelemetrySample = () => {
    const startedPerf = startRef.current.perfMs || performance.now();
    const timeS = Math.max(0, Number(((performance.now() - startedPerf) / 1000).toFixed(2)));
    const latest = latestTelemetryRef.current;
    samplesRef.current.push({
      time_s: timeS,
      captured_at: new Date().toISOString(),
      hr: latest.hrTelemetry || null,
      emg: latest.emgTelemetry || null,
      blood_pressure: latest.latestBpReading || null,
      spo2: latest.latestSpo2Reading || null,
    });
  };

  const uploadAndRender = async (blob, mimeType) => {
    const stoppedAt = new Date().toISOString();
    const durationSeconds = Math.max(1, Number(((performance.now() - startRef.current.perfMs) / 1000).toFixed(2)));
    const ext = extensionForMime(mimeType);
    const sessionState = sessionStateRef.current || liveSession || {};
    const file = new File([blob], `sarah-mobile-session-${sessionState.activeSessionId || Date.now()}.${ext}`, { type: mimeType || blob.type || "video/webm" });
    setBusy(true);
    setRendered(null);
    setProgress(2);
    setStatus("Hashing clean source recording...");
    const sha256 = await makeHash(file);
    const telemetryPackage = buildTelemetryPackage({
      session: activeSessionDoc,
      sessionState,
      startedAt: startRef.current.iso,
      stoppedAt,
      startedPerfMs: startRef.current.perfMs,
      durationSeconds,
      samples: samplesRef.current,
      latestBp: latestTelemetryRef.current.latestBpReading,
      latestSpo2: latestTelemetryRef.current.latestSpo2Reading,
    });
    const recordingRecord = await base44.integrations.Core.CreateSessionRecording({
      session_id: sessionState.activeSessionId || activeSessionDoc?.id,
      source_device_id: "sarah-android-apk-webview",
      source_filename: file.name,
      duration_seconds: durationSeconds,
      audio_included: true,
      camera_facing: "environment",
      app_build: "sarah-apk-web-recorder",
      telemetry_package: telemetryPackage,
    });
    const upload = await base44.integrations.Core.InitSessionVideoUpload({
      recording_id: recordingRecord.id,
      filename: file.name,
      total_bytes: file.size,
      chunk_size: CHUNK_SIZE,
      sha256,
    });
    const totalChunks = Math.ceil(file.size / CHUNK_SIZE);
    for (let index = 0; index < totalChunks; index += 1) {
      const start = index * CHUNK_SIZE;
      const end = Math.min(file.size, start + CHUNK_SIZE);
      setStatus(`Uploading source video ${index + 1}/${totalChunks}...`);
      await base44.integrations.Core.UploadSessionVideoChunk({
        uploadId: upload.id,
        chunkIndex: index,
        bytes: file.slice(start, end),
      });
      setProgress(Math.round(((index + 1) / totalChunks) * 44));
    }
    setStatus("Finalizing source upload...");
    const finalized = await base44.integrations.Core.FinalizeSessionVideoUpload(upload.id);
    setStatus("Desktop render queued...");
    const started = await base44.integrations.Core.StartSessionVideoRender({
      recording_id: finalized.recording.id,
      session_id: finalized.recording.session_id,
      preset_id: "telemetry_cockpit",
      settings: {
        title: "Sarah Session",
        includeHr: true,
        includeSpo2: true,
        includeBp: true,
        includeEmg: true,
      },
    });
    setJob(started);
    setProgress(50);
    if (pollRef.current) window.clearInterval(pollRef.current);
    pollRef.current = window.setInterval(async () => {
      const next = await base44.integrations.Core.GetSessionVideoRenderJob(started.id);
      setJob(next);
      setProgress(Math.max(50, Math.min(100, Number(next?.progress?.percent ?? next?.progress?.current ?? 50))));
      setStatus(next?.progress?.message || "Desktop render running...");
      if (next.status === "complete") {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
        const renderedId = next?.result?.id || next?.result?.rendered_video_id;
        if (renderedId) {
          const metadata = await base44.integrations.Core.GetRenderedSessionVideo(renderedId);
          setRendered(metadata);
        }
        setBusy(false);
        setProgress(100);
        setStatus("Finished video is ready on this phone.");
      } else if (next.status === "error" || next.status === "cancelled") {
        window.clearInterval(pollRef.current);
        pollRef.current = null;
        setBusy(false);
        setStatus(next.error || "Desktop render stopped.");
      }
    }, 1400);
  };

  const startRecording = async () => {
    if (!supported || recording || busy) return;
    setStatus("Creating/reusing Sarah session...");
    const sessionState = liveSession?.activeSessionId ? liveSession : await ensureSession?.();
    if (!sessionState?.activeSessionId) throw new Error("Sarah could not create an active session shell.");
    sessionStateRef.current = sessionState;
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: true,
      video: {
        facingMode: { ideal: "environment" },
        width: { ideal: 1280 },
        height: { ideal: 720 },
        frameRate: { ideal: 30, max: 30 },
      },
    });
    streamRef.current = stream;
    if (videoRef.current) {
      videoRef.current.srcObject = stream;
      await videoRef.current.play().catch(() => {});
    }
    chunksRef.current = [];
    samplesRef.current = telemetryHistory.slice(-240).map((point) => ({
      time_s: Number(point.t ?? point.time_s ?? 0) || 0,
      captured_at: point.captured_at || new Date().toISOString(),
      hr: point,
      emg: point,
    }));
    const mimeType = pickRecorderMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorderRef.current = recorder;
    startRef.current = { iso: new Date().toISOString(), perfMs: performance.now() };
    setStartedAt(startRef.current.iso);
    recorder.ondataavailable = (event) => {
      if (event.data?.size) chunksRef.current.push(event.data);
    };
    recorder.onstop = () => {
      const finalMime = recorder.mimeType || mimeType || "video/webm";
      const blob = new Blob(chunksRef.current, { type: finalMime });
      const localUrl = URL.createObjectURL(blob);
      setPreviewUrl((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return localUrl;
      });
      streamRef.current?.getTracks?.().forEach((track) => track.stop());
      streamRef.current = null;
      if (sampleTimerRef.current) window.clearInterval(sampleTimerRef.current);
      sampleTimerRef.current = null;
      setRecording(false);
      uploadAndRender(blob, finalMime).catch((error) => {
        setBusy(false);
        setStatus(error?.message || "Could not upload/render the phone recording.");
      });
    };
    recorder.start(1500);
    captureTelemetrySample();
    sampleTimerRef.current = window.setInterval(captureTelemetrySample, 1000);
    setRecording(true);
    setProgress(0);
    setStatus("Recording clean phone video. Telemetry is being timestamped separately.");
  };

  const stopRecording = () => {
    if (recorderRef.current?.state === "recording") {
      setStatus("Stopping phone recording...");
      recorderRef.current.stop();
    }
  };

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-primary">
            <Video className="h-4 w-4" /> Phone Session Recording
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            Record clean camera/mic video in the APK, upload it to the desktop server, and watch the render finish here.
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Badge variant={supported ? "default" : "secondary"}>{supported ? "Camera recorder ready" : "Recorder unavailable"}</Badge>
            {sessionId && <Badge variant="outline">Session {String(sessionId).slice(0, 8)}</Badge>}
            {recording && <Badge variant="destructive">Recording {elapsedText}</Badge>}
            {job?.status && <Badge variant="outline">Render {job.status}</Badge>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {!recording ? (
            <Button type="button" onClick={() => startRecording().catch((error) => setStatus(error?.message || "Could not start recording."))} disabled={!supported || busy}>
              <Radio className="mr-2 h-4 w-4" />
              Start Phone Recording
            </Button>
          ) : (
            <Button type="button" variant="destructive" onClick={stopRecording}>
              <Square className="mr-2 h-4 w-4" />
              Stop & Render
            </Button>
          )}
        </div>
      </div>

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.9fr)]">
        <div className="overflow-hidden rounded-lg border border-border bg-black">
          <video ref={videoRef} className="aspect-video w-full object-contain" muted playsInline autoPlay />
        </div>
        <div className="space-y-3">
          <div className="rounded-lg border border-border bg-muted/20 p-3">
            <p className="text-sm text-muted-foreground">{status}</p>
            <Progress value={progress} className="mt-3" />
            {busy && (
              <p className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                <UploadCloud className="h-3.5 w-3.5" />
                Keep the APK open until upload/render completes.
              </p>
            )}
          </div>
          {previewUrl && (
            <div className="rounded-lg border border-border bg-muted/20 p-3">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wider text-muted-foreground">Clean source preview</p>
              <video className="max-h-56 w-full rounded bg-black" controls src={previewUrl} />
            </div>
          )}
          {rendered && (
            <div className="rounded-lg border border-primary/25 bg-primary/10 p-3">
              <p className="text-sm font-semibold text-foreground">Finished telemetry video ready</p>
              <div className="mt-3 flex flex-wrap gap-2">
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
              <video className="mt-3 max-h-56 w-full rounded bg-black" controls src={base44.integrations.Core.renderedSessionVideoStreamUrl(rendered.id)} />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
