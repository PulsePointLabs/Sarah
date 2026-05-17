import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import { Play, Pause, Square, Upload, Volume2, VolumeX, ChevronDown, ChevronLeft, ChevronRight, ZoomOut, Mic, MicOff, Plus, ArrowUp } from "lucide-react";
import { EVENT_CATEGORIES } from "@/components/session-form/EventTimelineSection";
import {
  ResponsiveContainer, ComposedChart, Line, XAxis, YAxis,
  Tooltip, CartesianGrid, ReferenceLine,
} from "recharts";
import moment from "moment";

// ── helpers ───────────────────────────────────────────────────────────────────

function fmtMmSs(s) {
  const totalS = Math.round(Number(s));
  const m = Math.floor(totalS / 60);
  const sec = totalS % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function getCategoryMeta(value) {
  return EVENT_CATEGORIES.find((c) => c.value === value) || EVENT_CATEGORIES[EVENT_CATEGORIES.length - 1];
}

function getCategories(ev) {
  if (!ev.category) return ["other"];
  const arr = Array.isArray(ev.category) ? ev.category : [ev.category];
  const filtered = arr.filter((v) => typeof v === "string" && v && !["pause","resume","paused","resumed"].includes(v.toLowerCase()));
  return filtered.length ? filtered : ["other"];
}

function CategoryPill({ value }) {
  const meta = getCategoryMeta(value);
  return (
    <span className="inline-flex items-center rounded-full text-[9px] px-1.5 py-0 font-medium"
      style={{ background: meta.color + "22", color: meta.color, border: `1px solid ${meta.color}44` }}>
      {meta.label}
    </span>
  );
}

function nearestHR(chartData, time_s) {
  if (!chartData.length) return null;
  let best = chartData[0];
  let bestDist = Math.abs(chartData[0].t - time_s);
  for (const pt of chartData) {
    const d = Math.abs(pt.t - time_s);
    if (d < bestDist) { bestDist = d; best = pt; }
  }
  return Math.round(best.hr);
}

const OAI_VOICES = ["alloy", "echo", "fable", "onyx", "nova", "shimmer"];
const EVENT_COLORS = ["#f59e0b","#a855f7","#10b981","#f43f5e","#0ea5e9","#fb923c","#84cc16","#e879f9","#34d399","#f87171"];

// ── TTS helpers ───────────────────────────────────────────────────────────────

async function fetchTTSBase64(text, voice, speed) {
  const cacheKey = `tts_cache:${voice}:${speed}:${text}`;
  try { const c = sessionStorage.getItem(cacheKey); if (c) return c; } catch (_) {}
  const res = await base44.functions.invoke("openaiTTS", { text, voice, speed });
  const b64 = res.data.audio;
  try { sessionStorage.setItem(cacheKey, b64); } catch (_) {}
  return b64;
}

async function decodeToBuffer(ctx, b64) {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return ctx.decodeAudioData(bytes.buffer.slice(0));
}

// ── AI Text paragraph renderer (synced) ───────────────────────────────────────

function AIParagraph({ text, isActive, isBuffering, onClick }) {
  return (
    <p
      onClick={onClick}
      className={[
        "text-sm leading-relaxed pl-3 border-l-2 py-1 transition-all duration-200 rounded-r-md cursor-pointer flex items-center gap-2 flex-wrap",
        isActive ? "border-primary bg-primary/10 text-foreground font-medium" :
        isBuffering ? "border-primary/60 bg-primary/5 text-foreground" :
        "border-primary/30 text-foreground/70",
      ].join(" ")}
    >
      {isBuffering && <span className="shrink-0 w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />}
      {text}
    </p>
  );
}

// ── Main Page ─────────────────────────────────────────────────────────────────

export default function EventSyncPlayer() {
  const [sessions, setSessions] = useState([]);
  const [selectedSession, setSelectedSession] = useState(null);
  const [hrRows, setHrRows] = useState([]);
  const [loadingSession, setLoadingSession] = useState(false);

  // Playback
  const [playbackTime, setPlaybackTime] = useState(0);
  const [isPlaying, setIsPlaying] = useState(false);
  const [activeEventIdx, setActiveEventIdx] = useState(-1);

  // Video
  const [videoSrc, setVideoSrc] = useState(null);
  const [videoMode, setVideoMode] = useState(false);
  const videoRef = useRef(null);
  const videoUrlRef = useRef(null);

  // TTS
  const [voice, setVoice] = useState(() => localStorage.getItem("tts_oai_voice") || "alloy");
  const [speed] = useState(() => parseFloat(localStorage.getItem("tts_speed") || "1.0"));
  const [ttsEnabled, setTtsEnabled] = useState(true);
  const [showVoicePicker, setShowVoicePicker] = useState(false);
  const [ttsMode, setTtsMode] = useState("events"); // "events" | "cascade" | "analysis"
  // TTS paragraph reading state
  const [activePara, setActivePara] = useState(-1);
  const [bufferingPara, setBufferingPara] = useState(-1);

  // TTS internals
  const audioCtxRef = useRef(null);
  const ttsSourceRef = useRef(null);
  const firedEventsRef = useRef(new Set());
  const voiceRef = useRef(voice);
  const ttsEnabledRef = useRef(ttsEnabled);
  const ttsModeRef = useRef(ttsMode);
  // AI reading chain refs
  const aiReadingRef = useRef(false);
  const aiGenRef = useRef(0);
  const aiParasRef = useRef([]);

  // Timer
  const timerRef = useRef(null);
  const timerStartRef = useRef(null);
  const timerOffsetRef = useRef(0);

  // Log event (with STT via Whisper)
  const [newEventNote, setNewEventNote] = useState("");
  const [newEventCats, setNewEventCats] = useState(["stimulation"]);
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const mediaRecorderRef = useRef(null);
  const audioChunksRef = useRef([]);
  const [savingEvent, setSavingEvent] = useState(false);

  // Video resize
  const [videoHeight, setVideoHeight] = useState(320);
  const resizeDragRef = useRef(null);
  const resizeStartYRef = useRef(null);
  const resizeStartHRef = useRef(null);

  const handleResizeMouseDown = useCallback((e) => {
    e.preventDefault();
    resizeStartYRef.current = e.clientY;
    resizeStartHRef.current = videoHeight;
    const onMove = (ev) => {
      const delta = ev.clientY - resizeStartYRef.current;
      setVideoHeight(Math.max(120, Math.min(800, resizeStartHRef.current + delta)));
    };
    const onUp = () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, [videoHeight]);

  // HR chart zoom
  const [zoomDomain, setZoomDomain] = useState(null);
  const dragStartRef = useRef(null);
  const [dragRange, setDragRange] = useState(null);

  const events = useMemo(() =>
    (selectedSession?.event_timeline || []).slice().sort((a, b) => a.time_s - b.time_s),
    [selectedSession]
  );

  const chartData = useMemo(() =>
    hrRows.map((r) => ({ t: Number(r.time_offset_s), hr: Math.round(Number(r.hr_smoothed || r.hr)) })),
    [hrRows]
  );

  // AI paragraph lists
  const cascadeParas = useMemo(() => {
    const c = selectedSession?.ai_cascade;
    if (!c) return [];
    const parts = [];
    if (c.summary) parts.push(c.summary);
    for (const k of ["build_phase","pre_climax_phase","climax_phase","recovery_phase"]) {
      if (c[k]) { if (Array.isArray(c[k])) parts.push(...c[k]); else parts.push(c[k]); }
    }
    if (c.cascade_quality) parts.push(c.cascade_quality);
    return parts.filter(Boolean);
  }, [selectedSession]);

  const analysisParas = useMemo(() => {
    const a = selectedSession?.ai_analysis;
    if (!a) return [];
    const parts = [];
    if (a.summary) parts.push(a.summary);
    for (const k of ["arousal_arc","event_analysis","phase_analysis","notable_findings","recommendations"]) {
      if (a[k]?.length) parts.push(...a[k]);
    }
    return parts.filter(Boolean);
  }, [selectedSession]);

  const activeTTSParas = ttsMode === "cascade" ? cascadeParas : ttsMode === "analysis" ? analysisParas : [];

  // ── effects ───────────────────────────────────────────────────────────────

  useEffect(() => { base44.entities.Session.list("-date", 100).then(setSessions); }, []);
  useEffect(() => { voiceRef.current = voice; }, [voice]);
  useEffect(() => { ttsEnabledRef.current = ttsEnabled; }, [ttsEnabled]);
  useEffect(() => { ttsModeRef.current = ttsMode; }, [ttsMode]);

  // ── Audio ctx ─────────────────────────────────────────────────────────────

  const getCtx = () => {
    if (!audioCtxRef.current || audioCtxRef.current.state === "closed") {
      audioCtxRef.current = new (window.AudioContext || window.webkitAudioContext)();
    }
    return audioCtxRef.current;
  };

  const stopTTS = useCallback(() => {
    aiGenRef.current++;
    aiReadingRef.current = false;
    if (ttsSourceRef.current) { try { ttsSourceRef.current.stop(); } catch (_) {} ttsSourceRef.current = null; }
    setActivePara(-1);
    setBufferingPara(-1);
  }, []);

  // Speak a single text (event note)
  const speakText = useCallback(async (text) => {
    if (!ttsEnabledRef.current) { stopTTS(); return; }
    stopTTS();
    const ctx = getCtx();
    if (ctx.state === "suspended") await ctx.resume();
    const b64 = await fetchTTSBase64(text, voiceRef.current, speed);
    const buffer = await decodeToBuffer(ctx, b64);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(ctx.destination);
    src.start(0);
    ttsSourceRef.current = src;
  }, [speed, stopTTS]);

  // Read AI paragraphs sequentially
  const startAIReading = useCallback(async (paras, fromIdx = 0) => {
    if (!ttsEnabledRef.current || !paras.length) return;
    aiGenRef.current++;
    const gen = aiGenRef.current;
    aiReadingRef.current = true;
    aiParasRef.current = paras;

    for (let i = fromIdx; i < paras.length; i++) {
      if (gen !== aiGenRef.current) return;
      setBufferingPara(i);
      const ctx = getCtx();
      if (ctx.state === "suspended") await ctx.resume();
      const b64 = await fetchTTSBase64(paras[i], voiceRef.current, speed);
      if (gen !== aiGenRef.current) return;
      const buffer = await decodeToBuffer(ctx, b64);
      if (gen !== aiGenRef.current) return;
      setBufferingPara(-1);
      setActivePara(i);
      await new Promise((resolve) => {
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        src.connect(ctx.destination);
        src.onended = resolve;
        src.start(0);
        ttsSourceRef.current = src;
      });
      if (gen !== aiGenRef.current) return;
    }
    aiReadingRef.current = false;
    setActivePara(-1);
  }, [speed]);

  // ── Event sync ────────────────────────────────────────────────────────────

  const updateActiveEvent = useCallback((time) => {
    if (!events.length) return;
    let activeIdx = -1;
    for (let i = events.length - 1; i >= 0; i--) {
      if (time >= events[i].time_s) { activeIdx = i; break; }
    }
    setActiveEventIdx(activeIdx);

    if (ttsModeRef.current === "events") {
      for (let i = 0; i < events.length; i++) {
        if (time >= events[i].time_s && !firedEventsRef.current.has(i)) {
          firedEventsRef.current.add(i);
          if (ttsEnabledRef.current) speakText(events[i].note);
        }
      }
    }
  }, [events, speakText]);

  // ── Timer ─────────────────────────────────────────────────────────────────

  const startTimer = useCallback((fromTime) => {
    clearInterval(timerRef.current);
    timerStartRef.current = Date.now();
    timerOffsetRef.current = fromTime;
    timerRef.current = setInterval(() => {
      const elapsed = (Date.now() - timerStartRef.current) / 1000;
      const t = timerOffsetRef.current + elapsed;
      setPlaybackTime(t);
      updateActiveEvent(t);
    }, 100);
  }, [updateActiveEvent]);

  const stopTimer = useCallback(() => { clearInterval(timerRef.current); timerRef.current = null; }, []);

  // ── Video sync ────────────────────────────────────────────────────────────

  useEffect(() => {
    const vid = videoRef.current;
    if (!vid) return;
    const onTimeUpdate = () => { const t = vid.currentTime; setPlaybackTime(t); updateActiveEvent(t); };
    vid.addEventListener("timeupdate", onTimeUpdate);
    return () => vid.removeEventListener("timeupdate", onTimeUpdate);
  }, [videoMode, updateActiveEvent]);

  // ── Controls ──────────────────────────────────────────────────────────────

  const handlePlayPause = async () => {
    if (videoMode && videoRef.current) {
      if (isPlaying) { videoRef.current.pause(); stopTTS(); setIsPlaying(false); }
      else { await videoRef.current.play(); setIsPlaying(true); }
      return;
    }
    if (isPlaying) {
      stopTimer(); stopTTS(); setIsPlaying(false); timerOffsetRef.current = playbackTime;
    } else {
      // If AI mode, start reading from beginning (or resume)
      if (ttsMode !== "events" && activeTTSParas.length) {
        startAIReading(activeTTSParas, Math.max(0, activePara >= 0 ? activePara : 0));
      }
      startTimer(playbackTime);
      setIsPlaying(true);
    }
  };

  const handleStop = useCallback(() => {
    stopTimer(); stopTTS();
    if (videoRef.current) { videoRef.current.pause(); videoRef.current.currentTime = 0; }
    setIsPlaying(false); setPlaybackTime(0); setActiveEventIdx(-1);
    firedEventsRef.current = new Set();
  }, [stopTimer, stopTTS]);

  const handleJump = useCallback((time_s) => {
    firedEventsRef.current = new Set(
      events.map((_, i) => i).filter((i) => events[i].time_s < time_s)
    );
    if (videoMode && videoRef.current) { videoRef.current.currentTime = time_s; }
    else { setPlaybackTime(time_s); if (isPlaying) startTimer(time_s); }
    updateActiveEvent(time_s);
  }, [events, videoMode, isPlaying, startTimer, updateActiveEvent]);

  // ── Session select ────────────────────────────────────────────────────────

  const selectSession = async (id) => {
    handleStop();
    if (!id) { setSelectedSession(null); setHrRows([]); return; }
    setLoadingSession(true);
    const sess = sessions.find((s) => s.id === id);
    setSelectedSession(sess || null);
    if (sess) {
      const rows = await base44.entities.HeartRateTimeline.filter({ session: sess.id }, "time_offset_s", 10000);
      setHrRows(rows);
    }
    setLoadingSession(false);
  };

  // ── Video ─────────────────────────────────────────────────────────────────

  const handleVideoFile = (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current);
    const url = URL.createObjectURL(file);
    videoUrlRef.current = url;
    setVideoSrc(url); setVideoMode(true); handleStop();
  };

  const clearVideo = () => {
    if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current);
    videoUrlRef.current = null; setVideoSrc(null); setVideoMode(false); handleStop();
  };

  // ── STT via Whisper (push-to-talk) ───────────────────────────────────────

  const startRecording = useCallback(async () => {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    audioChunksRef.current = [];
    const mr = new MediaRecorder(stream, { mimeType: "audio/webm" });
    mediaRecorderRef.current = mr;
    mr.ondataavailable = (e) => { if (e.data.size > 0) audioChunksRef.current.push(e.data); };
    mr.onstop = async () => {
      stream.getTracks().forEach((t) => t.stop());
      setIsTranscribing(true);
      const blob = new Blob(audioChunksRef.current, { type: "audio/webm" });
      const reader = new FileReader();
      reader.onloadend = async () => {
        const base64 = reader.result.split(",")[1];
        const res = await base44.functions.invoke("whisperSTT", {
          audio_base64: base64,
          mime_type: "audio/webm",
          prompt: "Sexual health session log. Terms may include: glans, glans penis, perineum, frenulum, prostate, scrotum, foreskin, erection, ejaculation, edging, e-stim, TENS, foley, catheter, urethral, lubrication, climax, arousal, pelvic floor.",
        });
        const text = res.data?.text || "";
        if (text) setNewEventNote((prev) => (prev ? prev + " " + text : text));
        setIsTranscribing(false);
      };
      reader.readAsDataURL(blob);
    };
    mr.start();
    setIsRecording(true);
  }, []);

  const stopRecording = useCallback(() => {
    mediaRecorderRef.current?.stop();
    setIsRecording(false);
  }, []);

  const toggleRecording = useCallback(() => {
    if (isRecording) stopRecording();
    else startRecording();
  }, [isRecording, startRecording, stopRecording]);

  // Global "S" key shortcut to pause video + save event when note is present (when NOT focused on textarea)
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== "s" && e.key !== "S") return;
      // Don't fire if user is typing in an input/textarea
      const tag = document.activeElement?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      // Pause playback
      if (isPlaying) {
        if (videoMode && videoRef.current) { videoRef.current.pause(); stopTTS(); }
        else { stopTimer(); stopTTS(); timerOffsetRef.current = playbackTime; }
        setIsPlaying(false);
      }
      if (!newEventNote.trim() || !selectedSession || savingEvent) return;
      handleSaveEvent();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [newEventNote, selectedSession, savingEvent, isPlaying, videoMode, playbackTime]);

  const handleSaveEvent = async () => {
    const note = newEventNote.replace(/\u200b.*$/, "").trim();
    if (!note || !selectedSession) return;
    setSavingEvent(true);
    const existing = selectedSession.event_timeline || [];
    const newEv = { time_s: Math.round(playbackTime), note, category: newEventCats };
    const sorted = [...existing, newEv].sort((a, b) => a.time_s - b.time_s);
    await base44.entities.Session.update(selectedSession.id, { event_timeline: sorted });
    setSelectedSession((prev) => ({ ...prev, event_timeline: sorted }));
    setNewEventNote("");
    setSavingEvent(false);
  };

  // ── Scrubber ──────────────────────────────────────────────────────────────

  const maxTime = selectedSession?.duration_minutes
    ? selectedSession.duration_minutes * 60
    : (events.length ? events[events.length - 1].time_s + 30 : 600);

  const handleScrub = (e) => {
    const t = Number(e.target.value);
    firedEventsRef.current = new Set(events.map((_, i) => i).filter((i) => events[i].time_s < t));
    if (videoMode && videoRef.current) videoRef.current.currentTime = t;
    else { setPlaybackTime(t); if (isPlaying) startTimer(t); }
    updateActiveEvent(t);
  };

  // ── HR chart drag-to-zoom ─────────────────────────────────────────────────

  const chartRef = useRef(null);
  const handleChartMouseDown = (e) => {
    if (!e?.activeLabel) return;
    dragStartRef.current = Number(e.activeLabel);
  };
  const handleChartMouseMove = (e) => {
    if (dragStartRef.current == null || !e?.activeLabel) return;
    const x2 = Number(e.activeLabel);
    setDragRange({ x1: Math.min(dragStartRef.current, x2), x2: Math.max(dragStartRef.current, x2) });
  };
  const handleChartMouseUp = () => {
    if (dragRange && Math.abs(dragRange.x2 - dragRange.x1) > 5) setZoomDomain(dragRange);
    dragStartRef.current = null; setDragRange(null);
  };

  const xDomain = zoomDomain ? [zoomDomain.x1, zoomDomain.x2] : ["dataMin", "dataMax"];

  const displayData = useMemo(() => {
    if (!zoomDomain) return chartData;
    return chartData.filter((d) => d.t >= zoomDomain.x1 && d.t <= zoomDomain.x2);
  }, [chartData, zoomDomain]);

  // Phase markers
  const phaseMarkers = [
    selectedSession?.pre_climax_offset_s != null && { time_s: selectedSession.pre_climax_offset_s, label: "Pre-Climax", color: "#a855f7" },
    selectedSession?.climax_offset_s != null && { time_s: selectedSession.climax_offset_s, label: "Climax", color: "#ef4444" },
    selectedSession?.recovery_offset_s != null && { time_s: selectedSession.recovery_offset_s, label: "Recovery", color: "#3b82f6" },
  ].filter(Boolean);

  // cleanup
  useEffect(() => () => { stopTimer(); stopTTS(); if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current); }, []);

  // current nearest HR to playback
  const currentHR = useMemo(() => nearestHR(chartData, playbackTime), [chartData, playbackTime]);

  // Active event for navigator
  const navEv = activeEventIdx >= 0 ? events[activeEventIdx] : null;
  const navColor = navEv ? EVENT_COLORS[activeEventIdx % EVENT_COLORS.length] : "#888";

  const hasCascade = cascadeParas.length > 0;
  const hasAnalysis = analysisParas.length > 0;

  const [showScrollTop, setShowScrollTop] = useState(false);
  useEffect(() => {
    const onScroll = () => setShowScrollTop(window.scrollY > 300);
    window.addEventListener("scroll", onScroll);
    return () => window.removeEventListener("scroll", onScroll);
  }, []);

  return (
    <div className="px-3 py-5 pb-28 space-y-4">
      {showScrollTop && (
        <button
          onClick={() => window.scrollTo({ top: 0, behavior: "smooth" })}
          className="fixed bottom-6 right-4 z-50 w-10 h-10 rounded-full bg-primary text-primary-foreground shadow-lg flex items-center justify-center hover:bg-primary/90 transition-all"
          title="Scroll to top"
        >
          <ArrowUp className="w-4 h-4" />
        </button>
      )}
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Session Playback</h1>
        <p className="text-sm text-muted-foreground mt-0.5">HR timeline + event overlay + AI narration, synced to real-time playback.</p>
      </div>

      {/* Session selector */}
      <div className="bg-card rounded-xl border border-border p-4 space-y-3">
        <h2 className="text-xs font-semibold uppercase tracking-wider text-primary">Session</h2>
        <div className="relative">
          <select
            className="w-full bg-background border border-border rounded-lg px-3 py-2 text-sm focus:outline-none focus:ring-1 focus:ring-primary appearance-none pr-8"
            value={selectedSession?.id || ""}
            onChange={(e) => selectSession(e.target.value)}
          >
            <option value="">— choose a session —</option>
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {moment(s.date).format("MMM D, YYYY")}
                {s.duration_minutes ? ` · ${s.duration_minutes}min` : ""}
                {s.event_timeline?.length ? ` · ${s.event_timeline.length} events` : ""}
              </option>
            ))}
          </select>
          <ChevronDown className="absolute right-2.5 top-2.5 w-4 h-4 text-muted-foreground pointer-events-none" />
        </div>
        {loadingSession && (
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <span className="w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />
            Loading HR data…
          </div>
        )}
      </div>

      {selectedSession && (
        <div className="flex gap-4 items-start">
          {/* ── Left column: video + chart + controls + log ── */}
          <div className="flex-1 min-w-0 space-y-4">
            {/* Video loader */}
            <div className="bg-card rounded-xl border border-border p-4 space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-primary">Local Video (optional)</h2>
                {videoMode && <button onClick={clearVideo} className="text-[10px] text-destructive hover:opacity-70">Remove</button>}
              </div>
              {!videoMode ? (
                <label className="flex items-center gap-2 cursor-pointer border border-dashed border-border rounded-lg px-4 py-3 hover:bg-muted/40 transition-colors">
                  <Upload className="w-4 h-4 text-muted-foreground" />
                  <span className="text-sm text-muted-foreground">Load video file…</span>
                  <input type="file" accept="video/*" className="hidden" onChange={handleVideoFile} />
                </label>
              ) : (
                <>
                  <div className="w-full flex items-center justify-center bg-black rounded-lg overflow-hidden" style={{ height: videoHeight }}>
                    <video ref={videoRef} src={videoSrc} className="max-w-full max-h-full" controls={false} playsInline />
                  </div>
                  {/* Resize handle */}
                  <div
                    onMouseDown={handleResizeMouseDown}
                    className="w-full h-3 flex items-center justify-center cursor-ns-resize group -mt-1 -mb-1"
                    title="Drag to resize video"
                  >
                    <div className="w-16 h-1 rounded-full bg-border group-hover:bg-primary transition-colors" />
                  </div>
                </>
              )}
            </div>

            {/* HR + Event Overlay Chart */}
            {chartData.length > 0 && (
              <div className="bg-card rounded-xl border border-border p-4 space-y-3">
                <div className="flex items-center justify-between">
                  <h2 className="text-xs font-semibold uppercase tracking-wider text-primary">HR + Event Overlay</h2>
                  {zoomDomain && (
                    <button onClick={() => setZoomDomain(null)} className="flex items-center gap-1 text-[10px] text-primary border border-primary rounded px-2 py-0.5">
                      <ZoomOut className="w-3 h-3" /> Reset Zoom
                    </button>
                  )}
                  {!zoomDomain && <span className="text-[10px] text-muted-foreground">Drag to zoom</span>}
                </div>
                <div className="h-56 cursor-crosshair select-none" onMouseLeave={handleChartMouseUp}>
                  <ResponsiveContainer width="100%" height="100%">
                    <ComposedChart
                      data={displayData}
                      margin={{ top: 8, right: 4, bottom: 0, left: -20 }}
                      onMouseDown={handleChartMouseDown}
                      onMouseMove={handleChartMouseMove}
                      onMouseUp={handleChartMouseUp}
                    >
                      <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                      <XAxis dataKey="t" tick={{ fontSize: 9 }} tickFormatter={fmtMmSs} tickCount={8} type="number" domain={xDomain} />
                      <YAxis tick={{ fontSize: 9 }} domain={["auto", "auto"]} />
                      <Tooltip
                        formatter={(val) => [`${Math.round(val)} bpm`, "HR"]}
                        labelFormatter={(v) => fmtMmSs(Math.round(Number(v)))}
                        contentStyle={{ fontSize: 11 }}
                      />
                      {phaseMarkers.map((pm) => (
                        <ReferenceLine key={pm.label} x={pm.time_s} stroke={pm.color} strokeWidth={1.5}
                          strokeDasharray="4 2" label={{ value: pm.label, fontSize: 7, fill: pm.color, position: "top" }} />
                      ))}
                      {events.map((ev, i) => {
                        const color = EVENT_COLORS[i % EVENT_COLORS.length];
                        return (
                          <ReferenceLine key={i} x={ev.time_s} stroke={color} strokeWidth={1.5} strokeDasharray="2 3"
                            strokeOpacity={activeEventIdx === i ? 1 : 0.5}
                            label={{ value: `E${i + 1}`, fontSize: 7, fill: color, position: "insideTopLeft" }}
                          />
                        );
                      })}
                      <ReferenceLine x={playbackTime} stroke="hsl(var(--primary))" strokeWidth={2}
                        label={{ value: fmtMmSs(playbackTime), fontSize: 8, fill: "hsl(var(--primary))", position: "top" }} />
                      <Line type="monotone" dataKey="hr" stroke="hsl(var(--primary))" strokeWidth={2} dot={false} isAnimationActive={false} />
                    </ComposedChart>
                  </ResponsiveContainer>
                </div>
              </div>
            )}

            {/* Playback controls */}
            <div className="bg-card rounded-xl border border-border p-4 space-y-4">
              <div className="flex items-center gap-2 flex-wrap">
                <button onClick={handlePlayPause} className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-primary text-primary-foreground hover:bg-primary/90 text-sm font-medium">
                  {isPlaying ? <><Pause className="w-4 h-4" />Pause</> : <><Play className="w-4 h-4" />Play</>}
                </button>
                <button onClick={handleStop} className="p-2 rounded-lg bg-muted text-muted-foreground hover:text-foreground">
                  <Square className="w-4 h-4" />
                </button>
                <button
                  onClick={() => { setTtsEnabled((v) => !v); if (ttsEnabled) stopTTS(); }}
                  className={`flex items-center gap-1.5 px-3 py-2 rounded-lg text-sm font-medium transition-colors ${ttsEnabled ? "bg-primary/10 text-primary" : "bg-muted text-muted-foreground"}`}
                  title={ttsEnabled ? "Mute TTS audio (sync continues)" : "Unmute TTS audio"}
                >
                  {ttsEnabled ? <Volume2 className="w-4 h-4" /> : <VolumeX className="w-4 h-4" />}
                  {ttsEnabled ? "Mute" : "Unmuted"}
                </button>
                <div className="relative">
                  <button onClick={() => setShowVoicePicker((v) => !v)} className="flex items-center gap-1 px-2 py-2 rounded-lg bg-muted text-muted-foreground hover:text-foreground text-xs capitalize">
                    {voice} <ChevronDown className="w-3 h-3" />
                  </button>
                  {showVoicePicker && (
                    <div className="absolute left-0 top-full mt-1 z-50 bg-popover border border-border rounded-lg shadow-lg py-1 min-w-[100px]">
                      {OAI_VOICES.map((v) => (
                        <button key={v} className={`w-full text-left px-3 py-1.5 text-xs hover:bg-muted capitalize ${voice === v ? "text-primary font-medium" : "text-foreground"}`}
                          onClick={() => { setVoice(v); voiceRef.current = v; localStorage.setItem("tts_oai_voice", v); setShowVoicePicker(false); }}>
                          {v}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
                {currentHR && <span className="font-mono text-sm font-bold text-primary ml-auto">{currentHR} bpm</span>}
                <span className="font-mono text-sm text-muted-foreground">{fmtMmSs(playbackTime)}</span>
              </div>
              <div className="space-y-1">
                <input type="range" min={0} max={maxTime} step={0.5} value={playbackTime} onChange={handleScrub}
                  className="w-full h-1.5 cursor-pointer" style={{ accentColor: "hsl(var(--primary))" }} />
                <div className="relative h-2">
                  {events.map((ev, i) => {
                    const color = EVENT_COLORS[i % EVENT_COLORS.length];
                    return (
                      <button key={i} onClick={() => handleJump(ev.time_s)}
                        className="absolute top-0 w-1 h-2 rounded-full transform -translate-x-0.5 opacity-80 hover:opacity-100 hover:scale-150 transition-all"
                        style={{ left: `${(ev.time_s / maxTime) * 100}%`, background: color }}
                        title={`${fmtMmSs(ev.time_s)} — ${ev.note}`} />
                    );
                  })}
                </div>
                <div className="flex justify-between text-[9px] text-muted-foreground">
                  <span>0:00</span><span>{fmtMmSs(maxTime)}</span>
                </div>
              </div>
            </div>

            {/* Log Event */}
            <div className="bg-card rounded-xl border border-border p-4 space-y-3">
              <h2 className="text-xs font-semibold uppercase tracking-wider text-primary flex items-center gap-2">
                Log Event at {fmtMmSs(Math.round(playbackTime))}
                {newEventNote.trim() && <span className="text-[9px] font-normal text-muted-foreground normal-case tracking-normal">press <kbd className="px-1 py-0.5 rounded bg-muted border border-border font-mono">Enter</kbd> or <kbd className="px-1 py-0.5 rounded bg-muted border border-border font-mono">S</kbd> to save</span>}
              </h2>
              <div className="flex flex-wrap gap-1.5">
                {EVENT_CATEGORIES.map((c) => {
                  const active = newEventCats.includes(c.value);
                  return (
                    <button key={c.value} type="button"
                      onClick={() => setNewEventCats((prev) => prev.includes(c.value) ? prev.filter((v) => v !== c.value) : [...prev, c.value])}
                      className="text-[10px] px-2 py-0.5 rounded-full border font-medium transition-all"
                      style={active ? { background: c.color, color: "#fff", borderColor: c.color } : { background: c.color + "18", color: c.color, borderColor: c.color + "44" }}
                    >{c.label}</button>
                  );
                })}
              </div>
              <div className="flex gap-2 items-end">
                <textarea
                  value={newEventNote}
                  onChange={(e) => setNewEventNote(e.target.value)}
                  onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); if (newEventNote.trim() && selectedSession && !savingEvent) handleSaveEvent(); } }}
                  placeholder={isTranscribing ? "Transcribing…" : isRecording ? "Recording… tap mic to stop" : "Describe the event… or tap mic to dictate"}
                  rows={2}
                  className="flex-1 resize-none text-sm bg-background border border-border rounded-lg px-3 py-2 focus:outline-none focus:ring-1 focus:ring-primary disabled:opacity-50"
                  disabled={isTranscribing}
                />
                <button onClick={toggleRecording} disabled={isTranscribing}
                  className={`shrink-0 w-10 h-10 rounded-lg flex items-center justify-center transition-colors border disabled:opacity-40 ${isRecording ? "bg-destructive/10 border-destructive text-destructive animate-pulse" : "bg-muted border-border text-muted-foreground hover:text-foreground"}`}
                  title={isRecording ? "Stop & transcribe" : "Dictate event note"}>
                  {isTranscribing
                    ? <span className="w-4 h-4 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                    : isRecording ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
                </button>
                <button onClick={handleSaveEvent} disabled={!newEventNote.trim() || savingEvent}
                  className="shrink-0 w-10 h-10 rounded-lg flex items-center justify-center bg-primary text-primary-foreground disabled:opacity-40 hover:bg-primary/90 transition-colors" title="Save event">
                  {savingEvent ? <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" /> : <Plus className="w-4 h-4" />}
                </button>
              </div>
              {isRecording && (
                <p className="text-[10px] text-destructive flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-destructive animate-pulse inline-block" />
                  Recording… tap mic again to stop and transcribe
                </p>
              )}
              {isTranscribing && (
                <p className="text-[10px] text-primary flex items-center gap-1.5">
                  <span className="w-2 h-2 rounded-full bg-primary animate-pulse inline-block" />
                  Transcribing with Whisper…
                </p>
              )}
            </div>

            {/* AI Narration panels */}
            {(hasCascade || hasAnalysis) && (
              <div className="bg-card rounded-xl border border-border p-4 space-y-3">
                <div className="flex items-center justify-between flex-wrap gap-2">
                  <h2 className="text-xs font-semibold uppercase tracking-wider text-primary">AI Narration</h2>
                  <div className="flex gap-1.5 flex-wrap">
                    {["events", ...(hasCascade ? ["cascade"] : []), ...(hasAnalysis ? ["analysis"] : [])].map((m) => (
                      <button key={m} onClick={() => { setTtsMode(m); stopTTS(); }}
                        className="px-2.5 py-1 rounded-full text-[10px] font-semibold border capitalize transition-colors"
                        style={ttsMode === m
                          ? { background: "hsl(var(--primary))", color: "hsl(var(--primary-foreground))", borderColor: "hsl(var(--primary))" }
                          : { borderColor: "hsl(var(--border))", color: "hsl(var(--muted-foreground))" }}>
                        {m === "cascade" ? "Cascade Overview" : m === "analysis" ? "Session Analysis" : "Events Only"}
                      </button>
                    ))}
                  </div>
                </div>
                {ttsMode === "events" && (
                  <p className="text-xs text-muted-foreground">TTS reads each event note as playback reaches it. Switch to Cascade or Analysis to read full AI text.</p>
                )}
                {ttsMode === "cascade" && hasCascade && (
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2">
                      <button onClick={() => aiReadingRef.current ? stopTTS() : startAIReading(cascadeParas, 0)}
                        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-primary/10 text-primary text-xs font-medium hover:bg-primary/20">
                        {aiReadingRef.current ? <><Pause className="w-3 h-3" />Pause</> : <><Play className="w-3 h-3" />Read Cascade</>}
                      </button>
                      <span className="text-[10px] text-muted-foreground">Tap paragraph to jump</span>
                    </div>
                    {cascadeParas.map((text, i) => (
                      <AIParagraph key={i} text={text} isActive={activePara === i} isBuffering={bufferingPara === i} onClick={() => startAIReading(cascadeParas, i)} />
                    ))}
                  </div>
                )}
                {ttsMode === "analysis" && hasAnalysis && (
                  <div className="space-y-1.5">
                    <div className="flex items-center gap-2">
                      <button onClick={() => aiReadingRef.current ? stopTTS() : startAIReading(analysisParas, 0)}
                        className="flex items-center gap-1.5 px-2.5 py-1.5 rounded-lg bg-primary/10 text-primary text-xs font-medium hover:bg-primary/20">
                        {aiReadingRef.current ? <><Pause className="w-3 h-3" />Pause</> : <><Play className="w-3 h-3" />Read Analysis</>}
                      </button>
                      <span className="text-[10px] text-muted-foreground">Tap paragraph to jump</span>
                    </div>
                    {analysisParas.map((text, i) => (
                      <AIParagraph key={i} text={text} isActive={activePara === i} isBuffering={bufferingPara === i} onClick={() => startAIReading(analysisParas, i)} />
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ── Right sidebar: current event + events list ── */}
          {events.length > 0 && (
            <div className="w-72 shrink-0 space-y-3 sticky top-4 self-start" style={{ maxHeight: videoMode ? videoHeight + 80 : undefined, overflowY: videoMode ? "auto" : undefined }}>
              {/* Current event */}
              <div className="bg-card rounded-xl border border-border p-3 space-y-2">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-primary">Current Event</h2>
                {navEv ? (
                  <div className="rounded-lg px-3 py-2.5" style={{ background: navColor + "18", borderLeft: `3px solid ${navColor}` }}>
                    <div className="flex items-center gap-1.5 mb-1.5">
                      <button onClick={() => handleJump(events[Math.max(0, activeEventIdx - 1)].time_s)} className="p-0.5 rounded hover:bg-black/10">
                        <ChevronLeft className="w-4 h-4" style={{ color: navColor }} />
                      </button>
                      <span className="font-mono text-[11px] font-bold" style={{ color: navColor }}>E{activeEventIdx + 1}/{events.length}</span>
                      <span className="font-mono text-[10px] text-muted-foreground">{fmtMmSs(navEv.time_s)}</span>
                      {currentHR && <span className="font-mono text-[10px] font-bold text-primary ml-auto">{currentHR} bpm</span>}
                      <button onClick={() => handleJump(events[Math.min(events.length - 1, activeEventIdx + 1)].time_s)} className="p-0.5 rounded hover:bg-black/10">
                        <ChevronRight className="w-4 h-4" style={{ color: navColor }} />
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-1 mb-1">{getCategories(navEv).map((c) => <CategoryPill key={c} value={c} />)}</div>
                    <p className="text-xs text-foreground/90 leading-relaxed">{navEv.note}</p>
                  </div>
                ) : (
                  <p className="text-xs text-muted-foreground">No event reached yet.</p>
                )}
              </div>

              {/* Events list */}
              <div className="bg-card rounded-xl border border-border p-3 space-y-2">
                <h2 className="text-xs font-semibold uppercase tracking-wider text-primary">Events ({events.length})</h2>
                <div className="space-y-1 max-h-[calc(100vh-320px)] overflow-y-auto">
                  {events.map((ev, i) => {
                    const cats = getCategories(ev);
                    const color = EVENT_COLORS[i % EVENT_COLORS.length];
                    const isActive = i === activeEventIdx;
                    const isPast = i < activeEventIdx;
                    return (
                      <button key={i} onClick={() => handleJump(ev.time_s)}
                        className={`w-full flex items-start gap-2 rounded-lg px-2 py-1.5 text-left transition-opacity ${isActive ? "" : isPast ? "opacity-40" : "opacity-70"}`}
                        style={{ background: isActive ? color + "30" : color + "15", borderLeft: `3px solid ${color}`, outline: isActive ? `1px solid ${color}55` : "none" }}>
                        <span className="font-mono text-[9px] shrink-0 mt-0.5 font-bold" style={{ color }}>
                          E{i + 1} {fmtMmSs(ev.time_s)}
                        </span>
                        <div className="flex-1 min-w-0 flex flex-col gap-0.5">
                          <div className="flex flex-wrap gap-0.5">{cats.map((c) => <CategoryPill key={c} value={c} />)}</div>
                          <span className="text-[10px] text-foreground/90 leading-snug truncate">{ev.note}</span>
                        </div>
                        {(() => { const hr = nearestHR(chartData, ev.time_s); return hr && <span className="font-mono text-[9px] shrink-0 font-bold text-primary/80 mt-0.5">{hr}</span>; })()}
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}