import { useEffect, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Download, Radio, Square, Video } from "lucide-react";
import { Capacitor } from "@capacitor/core";
import { Link } from "react-router-dom";
import { apiUrl, discoverSarahApiBase } from "@/lib/mobileApiBase";
import { bloodPressureFallsInSession, bloodPressureKey } from "@/lib/liveSessionBloodPressure";
import { listRecentBloodPressure } from "@/lib/bloodPressure";
import { saveBlobToAndroidDownloads } from "@/lib/nativeFileSaver";

const pendingSessionKey = "pulsepoint.localCapture.pendingSession";

function readPendingSessions() {
  try {
    const saved = JSON.parse(localStorage.getItem(pendingSessionKey) || "[]");
    return Array.isArray(saved) ? saved.filter(record => record?.session_id) : [];
  } catch { return []; }
}

function updateStoredSession(id, session) {
  try {
    const queue = readPendingSessions().filter(record => record.session_id !== id);
    if (session) queue.push(session);
    if (queue.length) localStorage.setItem(pendingSessionKey, JSON.stringify(queue));
    else localStorage.removeItem(pendingSessionKey);
  } catch {
    // The local telemetry file still holds the capture when storage is full.
  }
}

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

function latestValue(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== "");
}

function normalizeHrSample(sample = {}, fallbackTimeS = 0) {
  if (!sample) return null;
  const hr = latestValue(sample.hr, sample.currentHr, sample.heart_rate_bpm, sample.value);
  if (hr == null) return null;
  return {
    t: fallbackTimeS,
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
    t: fallbackTimeS,
    left_pct: left == null ? null : Number(left),
    right_pct: right == null ? null : Number(right),
    source_at: sample.source_at || sample.measured_at || sample.timestamp || null,
  };
}


function buildTelemetryPackage({ session, stoppedAt, stoppedPerfMs, samples, videoFilename }) {
  const hrTimeline = samples.map(sample => normalizeHrSample(sample.hr, sample.time_s)).filter(Boolean);
  const emgTimeline = samples.map(sample => normalizeEmgSample(sample.emg, sample.time_s)).filter(Boolean);
  const readings = [...session.bloodPressure.values()];
  const window = { startMs: Date.parse(session.startedAt), endMs: Date.parse(stoppedAt), sessionId: session.id };
  const bloodPressure = readings.filter(reading => bloodPressureFallsInSession(reading, window));
  const unassigned = readings.filter(reading => !reading.measured_at || (reading.timestamp_source || reading.raw?.timestamp_source) === "received_at");
  const spo2 = [...new Map(samples.filter(sample => sample.spo2?.measured_at)
    .map(sample => [sample.spo2.measured_at, sample.spo2])).values()]
    .filter(reading => {
      const measured = Date.parse(reading.measured_at);
      return measured >= window.startMs && measured <= window.endMs;
    });
  return {
    schema_version: 1,
    session_id: session.id,
    capture_kind: session.kind,
    video_filename: videoFilename,
    video_start_timestamp: session.startedAt,
    video_stop_timestamp: stoppedAt,
    monotonic_start_ms: session.startedPerfMs,
    duration_seconds: (stoppedPerfMs - session.startedPerfMs) / 1000,
    channels: { hr: hrTimeline.length > 0, emg: emgTimeline.length > 0, blood_pressure: bloodPressure.length > 0, spo2: spo2.length > 0 },
    samples,
    annotations: session.event_timeline,
    blood_pressure_snapshots: bloodPressure,
    blood_pressure_unassigned: unassigned,
    spo2_timeline: spo2,
    hr_timeline: hrTimeline,
    hrv_timeline: hrTimeline.filter(row => row.hrv_rmssd_ms != null),
    emg_timeline: emgTimeline,
    connection_gaps: [],
  };
}

export default function LiveSessionMobileRecorder({
  phoneCaptureRef,
  stopCaptureRef,
  onCameraAudioChange,
  onCaptureStatus,
  captureKind,
  showSessionLink,
  wakeEnabled,
  hrTelemetry,
  emgTelemetry,
  latestSpo2Reading,
}) {
  const android = Capacitor.getPlatform() === "android";
  const [useCamera, setUseCamera] = useState(true);
  const [includeAudio, setIncludeAudio] = useState(false);
  const [phase, setPhase] = useState("idle");
  const [status, setStatus] = useState("Ready to record.");
  const [elapsed, setElapsed] = useState(0);
  const [files, setFiles] = useState([]);
  const [retryFiles, setRetryFiles] = useState(false);
  const [queuedSessions, setQueuedSessions] = useState(readPendingSessions);
  const [serverState, setServerState] = useState(null);
  const videoRef = useRef(null);
  const streamRef = useRef(null);
  const recorderRef = useRef(null);
  const sampleTimerRef = useRef(null);
  const samplesRef = useRef([]);
  const phaseRef = useRef("idle");
  const stopTimeRef = useRef(null);
  const pendingFilesRef = useRef([]);
  const pendingServerRef = useRef(queuedSessions);
  const latestSessionIdRef = useRef(null);
  const serverSaveInFlight = useRef(false);
  const mountedRef = useRef(false);
  const latestRef = useRef({});
  latestRef.current = { hrTelemetry, emgTelemetry, latestSpo2Reading };

  function setCapturePhase(next) {
    phaseRef.current = next;
    setPhase(next);
    onCaptureStatus({ phase: next, startedAt: phoneCaptureRef.current?.startedAt || null });
  }

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      clearInterval(sampleTimerRef.current);
      if (recorderRef.current?.state === "recording") recorderRef.current.stop();
      streamRef.current?.getTracks().forEach(track => track.stop());
      stopCaptureRef.current = null;
    };
  }, [stopCaptureRef]);

  useEffect(() => () => files.forEach(file => URL.revokeObjectURL(file.url)), [files]);

  useEffect(() => {
    if (!["starting", "recording", "saving"].includes(phase) && !retryFiles && !files.some(file => !file.downloaded)) return;
    const warn = (event) => { event.preventDefault(); event.returnValue = ""; };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [files, phase, retryFiles]);

  const cameraSupported = Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
  const recording = phase === "recording";
  const busy = phase === "starting" || phase === "saving";

  function sampleTelemetry() {
    const session = phoneCaptureRef.current;
    if (!session) return;
    const seconds = Math.max(0, (performance.now() - session.startedPerfMs) / 1000);
    setElapsed(Math.floor(seconds));
    const latest = latestRef.current;
    samplesRef.current.push({
      time_s: Number(seconds.toFixed(2)),
      captured_at: new Date().toISOString(),
      hr: latest.hrTelemetry || null,
      emg: latest.emgTelemetry || null,
      spo2: latest.latestSpo2Reading || null,
    });
  }

  async function saveFiles() {
    try {
      while (pendingFilesRef.current.length) {
        const { blob, filename } = pendingFilesRef.current[0];
        await saveBlobToAndroidDownloads(blob, filename);
        pendingFilesRef.current.shift();
      }
      setRetryFiles(false);
      setStatus("Files saved to Downloads/Sarah.");
    } catch (error) {
      setRetryFiles(true);
      setStatus(error.message || "File save failed. Retry while Live Capture is open.");
    }
  }

  async function saveServer() {
    if (!pendingServerRef.current.length || serverSaveInFlight.current) return;
    serverSaveInFlight.current = true;
    setServerState({ state: "saving" });
    const post = async (record) => {
      const response = await fetch(apiUrl("/live-capture/camera-session"), {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify(record), signal: AbortSignal.timeout(5000),
      });
      const saved = await response.json().catch(() => ({}));
      if (!response.ok || !saved.ok || saved.id !== record.session_id) {
        throw new Error(saved.error || "Sarah did not confirm the session save.");
      }
      return saved;
    };
    try {
      let latestSaved;
      for (const record of [...pendingServerRef.current]) {
        let saved;
        try {
          saved = await post(record);
        } catch (error) {
          if (!android) throw error;
          await discoverSarahApiBase({ timeoutMs: 1200 });
          saved = await post(record);
        }
        pendingServerRef.current = pendingServerRef.current.filter(item => item.session_id !== record.session_id);
        updateStoredSession(record.session_id, null);
        setQueuedSessions(pendingServerRef.current);
        if (!latestSessionIdRef.current || latestSessionIdRef.current === record.session_id) latestSaved = saved;
      }
      setServerState(latestSaved ? { state: "saved", ...latestSaved } : null);
    } catch {
      setServerState({ state: "pending" });
    } finally { serverSaveInFlight.current = false; }
  }

  useEffect(() => {
    if (!queuedSessions.length) return undefined;
    const retry = () => { void saveServer(); };
    window.addEventListener("online", retry);
    const timer = setInterval(retry, 30000);
    return () => { clearInterval(timer); window.removeEventListener("online", retry); };
  }, [queuedSessions.length]);

  async function finishCapture(blob) {
    if (phaseRef.current === "recording") setCapturePhase("saving");
    clearInterval(sampleTimerRef.current);
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
    recorderRef.current = null;
    if (videoRef.current) videoRef.current.srcObject = null;
    onCameraAudioChange(false);
    const session = phoneCaptureRef.current;
    phoneCaptureRef.current = null;
    if (!session) return;
    const stopped = stopTimeRef.current || { iso: new Date().toISOString(), perf: performance.now() };
    // A cuff may be connected to another device and save just before Stop.
    const recent = await listRecentBloodPressure(100, { signal: AbortSignal.timeout(1800) }).catch(() => null);
    for (const reading of recent?.readings || []) {
      session.bloodPressure.set(bloodPressureKey(reading), reading);
    }
    const stem = `sarah-capture-${session.startedAt.replace(/[:.]/g, "-")}`;
    const videoFilename = blob?.size ? `${stem}.${extensionForMime(blob.type)}` : null;
    const telemetry = buildTelemetryPackage({
      session, stoppedAt: stopped.iso, stoppedPerfMs: stopped.perf, samples: samplesRef.current, videoFilename,
    });
    const artifacts = [
      ...(videoFilename ? [{ blob, filename: videoFilename }] : []),
      { blob: new Blob([JSON.stringify(telemetry)], { type: "application/json" }), filename: `${stem}.json` },
    ];
    const { samples: _samples, blood_pressure_unassigned: _unassigned, ...record } = telemetry;
    latestSessionIdRef.current = record.session_id;
    pendingServerRef.current = [...pendingServerRef.current, record];
    setQueuedSessions(pendingServerRef.current);
    updateStoredSession(record.session_id, record);
    void saveServer();
    if (android) {
      pendingFilesRef.current = artifacts;
      await saveFiles();
      if (blob && !videoFilename) setStatus(previous => `Camera returned no video. ${previous}`);
    } else {
      setFiles(artifacts.map(file => ({ ...file, url: URL.createObjectURL(file.blob), downloaded: false })));
      setStatus(blob && !videoFilename
        ? "Camera returned no video. Telemetry is ready to download."
        : "Recording ended. Download your files below.");
    }
    setCapturePhase("saved");
  }

  async function startRecording() {
    if (["starting", "recording", "saving"].includes(phaseRef.current)) return;
    if (retryFiles || (useCamera && (!cameraSupported || includeAudio && wakeEnabled))) return;
    if (files.some(file => !file.downloaded)
      && !window.confirm("The previous capture still has files to download. Start a new capture anyway?")) return;
    setCapturePhase("starting");
    setStatus(useCamera ? "Opening camera…" : "Starting telemetry…");
    stopTimeRef.current = null;
    try {
      let recorder;
      if (useCamera) {
        onCameraAudioChange(includeAudio);
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: includeAudio,
          video: { facingMode: { ideal: "environment" }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30, max: 30 } },
        });
        if (!mountedRef.current) {
          stream.getTracks().forEach(track => track.stop());
          return;
        }
        streamRef.current = stream;
        const mimeType = pickRecorderMimeType();
        recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
        recorderRef.current = recorder;
        const chunks = [];
        recorder.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data); };
        recorder.onstop = () => {
          const finalMime = recorder.mimeType || mimeType || "video/webm";
          void finishCapture(new Blob(chunks, { type: finalMime }));
        };
        recorder.onerror = () => {
          setStatus("Camera stream interrupted. Saving what was recorded…");
          stopRecording();
        };
        recorder.start(1000);
        if (videoRef.current) {
          videoRef.current.srcObject = stream;
          videoRef.current.play().catch(() => {});
        }
      }
      setServerState(null);
      setFiles([]);
      samplesRef.current = [];
      phoneCaptureRef.current = {
        id: crypto.randomUUID?.() || Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, "0")).join(""),
        kind: captureKind, startedAt: new Date().toISOString(),
        startedPerfMs: performance.now(), event_timeline: [], bloodPressure: new Map(),
      };
      sampleTelemetry();
      sampleTimerRef.current = window.setInterval(sampleTelemetry, 1000);
      setCapturePhase("recording");
      setStatus(useCamera ? "Recording camera and telemetry." : "Recording telemetry.");
    } catch (error) {
      streamRef.current?.getTracks().forEach(track => track.stop());
      streamRef.current = null;
      recorderRef.current = null;
      onCameraAudioChange(false);
      setCapturePhase("idle");
      setStatus(error.message || "Could not start capture. Check camera and microphone permissions.");
    }
  }

  function stopRecording() {
    if (phaseRef.current !== "recording") return;
    stopTimeRef.current = { iso: new Date().toISOString(), perf: performance.now() };
    clearInterval(sampleTimerRef.current);
    setCapturePhase("saving");
    setStatus("Recording stopped. Preparing files…");
    if (recorderRef.current?.state === "recording") recorderRef.current.stop();
    else if (!recorderRef.current) void finishCapture(null);
  }

  stopCaptureRef.current = stopRecording;

  return (
    <section className="space-y-4 rounded-xl border border-border bg-card p-4" aria-label="Local capture">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-base font-semibold"><Video className="h-4 w-4 text-primary" /> Camera &amp; Telemetry Capture</h2>
          <p className="mt-1 text-sm text-muted-foreground">Capture on this device. Sarah saves the session record to your server when reachable.</p>
        </div>
        {recording && <Badge variant="destructive">Recording {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, "0")}</Badge>}
      </div>
      <div className="flex flex-wrap items-center gap-4">
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={useCamera} disabled={busy || recording} onChange={event => setUseCamera(event.target.checked)} />
          Record camera
        </label>
        {useCamera && <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={includeAudio} disabled={busy || recording || (wakeEnabled && !includeAudio)} onChange={event => setIncludeAudio(event.target.checked)} />
          Camera audio
        </label>}
        {recording
          ? <Button type="button" variant="destructive" onClick={stopRecording}><Square className="mr-2 h-4 w-4" /> Stop &amp; Save</Button>
          : <Button type="button" onClick={startRecording} disabled={busy || retryFiles || (useCamera && (!cameraSupported || includeAudio && wakeEnabled))}>
              <Radio className="mr-2 h-4 w-4" /> {useCamera ? "Start Camera Recording" : "Start Telemetry Recording"}
            </Button>}
      </div>
      {useCamera && !cameraSupported && <p className="text-sm text-destructive">Camera access requires a secure browser page and camera permissions. Telemetry capture is available.</p>}
      {useCamera && <p className="text-xs text-muted-foreground">Leave camera audio off to use Wake during capture.</p>}
      <div hidden={!recording || !useCamera} className="overflow-hidden rounded-lg bg-black">
        <video ref={videoRef} className="aspect-video max-h-[55vh] w-full object-contain" muted playsInline autoPlay />
      </div>
      <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-3 text-sm">
        <p role="status">{status}</p>
        {retryFiles && <Button type="button" size="sm" variant="outline" onClick={async () => {
          setCapturePhase("saving"); await saveFiles(); setCapturePhase("saved");
        }}>Retry file save</Button>}
        {serverState?.state === "saving" && <p>Saving session record to Sarah…</p>}
        {queuedSessions.length > 0 && serverState?.state !== "saving" && <div className="flex flex-wrap items-center gap-2">
          <p className="text-amber-500">{queuedSessions.length} pending server {queuedSessions.length === 1 ? "save" : "saves"}. Keep your telemetry files.</p>
          <Button type="button" size="sm" variant="outline" onClick={saveServer}>Retry server save</Button>
        </div>}
        {serverState?.state === "saved" && <p>
          Session saved to Sarah · {serverState.bloodPressureCount} BP {serverState.bloodPressureCount === 1 ? "reading" : "readings"} attached.{" "}
          {showSessionLink && <Link className="font-semibold text-primary underline" to={`/${serverState.entity === "BodyExploration" ? "exploration" : "sessions"}/${serverState.id}`}>Open session</Link>}
        </p>}
        {!!files.length && <div className="flex flex-wrap gap-2">
          {files.map(file => <Button key={file.filename} asChild size="sm" variant="outline">
            <a href={file.url} download={file.filename} onClick={() => { file.downloaded = true; }}>
              <Download className="mr-2 h-4 w-4" /> {file.blob.type === "application/json" ? "Download telemetry" : "Download video"}
            </a>
          </Button>)}
        </div>}
      </div>
    </section>
  );
}
