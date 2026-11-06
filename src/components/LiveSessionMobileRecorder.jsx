import { useEffect, useMemo, useRef, useState } from "react";
import { base44 } from "@/api/base44Client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Progress } from "@/components/ui/progress";
import { Download, Play, Radio, Square, UploadCloud, Video } from "lucide-react";
import { Capacitor } from "@capacitor/core";
import { saveBlobToAndroidDownloads } from "@/lib/nativeFileSaver";

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
  if (!sample) return null;
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
  if (!sample) return null;
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
  phoneCaptureRef,
  onCameraAudioChange,
  onCaptureBusyChange,
  wakeEnabled,
  telemetryHistory = [],
  hrTelemetry,
  emgTelemetry,
  latestBpReading,
  latestSpo2Reading,
}) {
  const local = Capacitor.getPlatform() === "android";
  const [includeAudio, setIncludeAudio] = useState(false);
  const [supported, setSupported] = useState(false);
  const [capabilities, setCapabilities] = useState(null);
  const [capabilityChecked, setCapabilityChecked] = useState(false);
  const [recording, setRecording] = useState(false);
  const [previewUrl, setPreviewUrl] = useState("");
  const [status, setStatus] = useState("Ready to record a clean source video on this phone.");
  const [progress, setProgress] = useState(0);
  const [busy, setBusy] = useState(false);
  const [rendered, setRendered] = useState(null);
  const [job, setJob] = useState(null);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
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
  const startingRef = useRef(false);
  const localFilesRef = useRef([]);
  const [retrySave, setRetrySave] = useState(false);

  useEffect(() => {
    onCaptureBusyChange(recording || busy || retrySave);
  }, [busy, onCaptureBusyChange, recording, retrySave]);

  useEffect(() => {
    setSupported(Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder));
  }, []);

  useEffect(() => {
    if (local) return undefined;
    let cancelled = false;
    setCapabilityChecked(false);
    base44.integrations.Core.GetSessionVideoCapabilities()
      .then((data) => {
        if (cancelled) return;
        setCapabilities(data || {});
        setCapabilityChecked(true);
        if (data?.ffmpeg_available) {
          setStatus("Ready to record. Desktop video renderer is reachable.");
        } else {
          setStatus("Desktop video renderer is reachable, but FFmpeg is not available.");
        }
      })
      .catch((error) => {
        if (cancelled) return;
        setCapabilities(null);
        setCapabilityChecked(true);
        setStatus(
          error?.status === 404
            ? "Phone recording is disabled because the desktop Sarah server is older than v0.1.7. Start the rebuilt desktop EXE first."
            : error?.message || "Phone recording is disabled until the desktop render server is reachable."
        );
      });
    return () => {
      cancelled = true;
    };
  }, [local]);

  useEffect(() => {
    latestTelemetryRef.current = { hrTelemetry, emgTelemetry, latestBpReading, latestSpo2Reading };
  }, [emgTelemetry, hrTelemetry, latestBpReading, latestSpo2Reading]);

  useEffect(() => () => {
    if (pollRef.current) window.clearInterval(pollRef.current);
    if (sampleTimerRef.current) window.clearInterval(sampleTimerRef.current);
    streamRef.current?.getTracks?.().forEach((track) => track.stop());
  }, []);

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  const sessionId = liveSession?.activeSessionId || activeSessionDoc?.id || null;
  const elapsedText = useMemo(() => {
    const min = Math.floor(elapsedSeconds / 60);
    const sec = String(elapsedSeconds % 60).padStart(2, "0");
    return `${min}:${sec}`;
  }, [elapsedSeconds]);

  const captureTelemetrySample = () => {
    const startedPerf = startRef.current.perfMs || performance.now();
    const timeS = Math.max(0, Number(((performance.now() - startedPerf) / 1000).toFixed(2)));
    setElapsedSeconds(Math.floor(timeS));
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

  const saveLocalFiles = async () => {
    setBusy(true);
    setStatus("Saving to Downloads/Sarah…");
    try {
      while (localFilesRef.current.length) {
        const { blob, filename } = localFilesRef.current[0];
        await saveBlobToAndroidDownloads(blob, filename);
        localFilesRef.current.shift();
      }
      setRetrySave(false);
      setStatus("Video and telemetry saved to Downloads/Sarah.");
    } catch (error) {
      setRetrySave(true);
      setStatus(error.message || "Save failed. Retry while Live Capture is open.");
    } finally {
      setBusy(false);
    }
  };

  const startRecording = async () => {
    if (!readyToRecord || recording || busy || retrySave || startingRef.current) return;
    startingRef.current = true;
    setBusy(true);
    try {
      await openRecording();
    } catch (error) {
      streamRef.current?.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
      phoneCaptureRef.current = null;
      onCameraAudioChange(false);
      setStatus(error.message || "Could not start the camera. Check camera and microphone permissions.");
    } finally {
      startingRef.current = false;
      setBusy(false);
    }
  };

  const openRecording = async () => {
    if (!local) {
      setStatus("Connecting to the active Sarah session…");
      const sessionState = liveSession?.active ? liveSession : await ensureSession?.();
      if (!sessionState?.activeSessionId) throw new Error("Start OBS before using the desktop render workflow.");
      sessionStateRef.current = sessionState;
    }
    const audio = !local || includeAudio;
    onCameraAudioChange(audio);
    const stream = await navigator.mediaDevices.getUserMedia({
      audio,
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
      videoRef.current.play().catch(() => {});
    }
    chunksRef.current = [];
    samplesRef.current = (local ? [] : telemetryHistory.slice(-240)).map((point) => ({
      time_s: Number(point.t ?? point.time_s ?? 0) || 0,
      captured_at: point.captured_at || new Date().toISOString(),
      hr: point,
      emg: point,
    }));
    const mimeType = pickRecorderMimeType();
    const recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
    recorderRef.current = recorder;
    startRef.current = { iso: new Date().toISOString(), perfMs: performance.now() };
    if (local) {
      phoneCaptureRef.current = {
        startedAt: startRef.current.iso,
        id: crypto.randomUUID(),
        event_timeline: [],
      };
    }
    recorder.ondataavailable = (event) => {
      if (event.data?.size) chunksRef.current.push(event.data);
    };
    recorder.onstop = () => {
      const finalMime = recorder.mimeType || mimeType || "video/webm";
      const blob = new Blob(chunksRef.current, { type: finalMime });
      const localUrl = URL.createObjectURL(blob);
      setPreviewUrl(localUrl);
      streamRef.current?.getTracks?.().forEach((track) => track.stop());
      streamRef.current = null;
      if (videoRef.current) videoRef.current.srcObject = null;
      if (sampleTimerRef.current) window.clearInterval(sampleTimerRef.current);
      sampleTimerRef.current = null;
      setRecording(false);
      onCameraAudioChange(false);
      if (local) {
        const session = phoneCaptureRef.current;
        phoneCaptureRef.current = null;
        if (!blob.size) {
          setStatus("The camera returned an empty recording.");
          return;
        }
        const startedAt = startRef.current.iso;
        const durationSeconds = (performance.now() - startRef.current.perfMs) / 1000;
        const telemetry = buildTelemetryPackage({
          session,
          startedAt,
          stoppedAt: new Date().toISOString(),
          startedPerfMs: startRef.current.perfMs,
          durationSeconds,
          samples: samplesRef.current,
          latestBp: latestTelemetryRef.current.latestBpReading,
          latestSpo2: latestTelemetryRef.current.latestSpo2Reading,
        });
        const stem = `sarah-phone-${startedAt.replace(/[:.]/g, "-")}`;
        localFilesRef.current = [
          { blob, filename: `${stem}.${extensionForMime(finalMime)}` },
          { blob: new Blob([JSON.stringify(telemetry)], { type: "application/json" }), filename: `${stem}.json` },
        ];
        void saveLocalFiles();
        return;
      }
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

  const readyToRecord = supported && (local || Boolean(capabilities?.ffmpeg_available));

  return (
    <div className="rounded-xl border border-border bg-card p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-primary">
            <Video className="h-4 w-4" /> Phone Session Recording
          </p>
          <p className="mt-1 text-sm text-muted-foreground">
            {local ? "Record on this phone. Video and timestamped telemetry go to Downloads/Sarah." : "Record camera video into the active OBS session and render it on the Sarah server."}
          </p>
          <div className="mt-2 flex flex-wrap gap-2">
            <Badge variant={supported ? "default" : "secondary"}>{supported ? "Camera available" : "Camera unavailable"}</Badge>
            {!local && <Badge variant={capabilities?.ffmpeg_available ? "default" : "secondary"}>
              {!capabilityChecked ? "Checking desktop" : capabilities?.ffmpeg_available ? "Desktop renderer ready" : "Desktop renderer unavailable"}
            </Badge>}
            {sessionId && <Badge variant="outline">Session {String(sessionId).slice(0, 8)}</Badge>}
            {recording && <Badge variant="destructive">Recording {elapsedText}</Badge>}
            {job?.status && <Badge variant="outline">Render {job.status}</Badge>}
          </div>
        </div>
        <div className="flex flex-wrap gap-2">
          {local && !recording && <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={includeAudio} disabled={busy || (wakeEnabled && !includeAudio)} onChange={(event) => setIncludeAudio(event.target.checked)} />
            Camera audio
          </label>}
          {retrySave && <Button type="button" variant="secondary" onClick={saveLocalFiles} disabled={busy}>Retry save</Button>}
          {!recording ? (
            <Button type="button" onClick={startRecording} disabled={!readyToRecord || busy || retrySave || (local && includeAudio && wakeEnabled)}>
              <Radio className="mr-2 h-4 w-4" />
              Start Phone Recording
            </Button>
          ) : (
            <Button type="button" variant="destructive" onClick={stopRecording}>
              <Square className="mr-2 h-4 w-4" />
              {local ? "Stop & Save" : "Stop & Render"}
            </Button>
          )}
        </div>
      </div>
      {local && <p className="mt-2 text-xs text-muted-foreground">Leave camera audio off to use Sarah’s wake microphone during recording.</p>}

      <div className={`mt-4 grid gap-4 ${recording ? "lg:grid-cols-[minmax(0,1fr)_minmax(18rem,0.9fr)]" : ""}`}>
        <div hidden={!recording} className="overflow-hidden rounded-lg border border-border bg-black">
          <video ref={videoRef} className="aspect-video w-full object-contain" muted playsInline autoPlay />
        </div>
        <div className="space-y-3">
          <div className="rounded-lg border border-border bg-muted/20 p-3">
            <p role="status" className="text-sm text-muted-foreground">{status}</p>
            {!local && <Progress value={progress} className="mt-3" />}
            {busy && (
              <p className="mt-2 flex items-center gap-2 text-xs text-muted-foreground">
                <UploadCloud className="h-3.5 w-3.5" />
                {local ? "Keep Live Capture open until saving completes." : "Keep this page open until upload/render completes."}
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
