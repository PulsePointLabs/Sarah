import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Activity, Clapperboard, Droplets, Gauge, Loader2, Maximize2, ScanSearch, Video, X } from "lucide-react";
import moment from "moment";
import { base44 } from "@/api/base44Client";
import PageHeader from "../components/PageHeader";
import HRTimelineChart from "../components/HRTimelineChart";
import InteractiveTimelinePlayer, { TimelineWaypointDetail } from "../components/InteractiveTimelinePlayer";
import SavedMotionSummaryCard from "../components/SavedMotionSummaryCard";
import TelemetryTheaterCharts from "../components/TelemetryTheaterCharts";
import { EVENT_CATEGORIES, normalizeCategoryArray } from "../components/session-form/EventTimelineSection";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { bloodPressureReadingsFromSession, pulseOxReadingsFromSession } from "@/lib/sessionContext";
import { nearestTimedReading, normalizeTimedReadings, readingSequenceAt } from "@/lib/telemetryTheater";
import { selectNearbyVitalReadings } from "@/lib/nearbyVitals";
import { buildNearClimaxContextEvidence, filterContradictedNearClimaxEvents, getContextConfirmedNearClimaxEvents } from "@/utils/nearClimaxEvents";

function formatTime(value) {
  const total = Math.max(0, Math.round(Number(value) || 0));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function reviewLabel(record, isExploration = false) {
  const title = isExploration ? `${record?.title || record?.exploration_type || "Body Exploration"} · ` : "";
  const date = record?.date ? moment(record.date).format("MMM D, YYYY") : `Undated ${isExploration ? "exploration" : "session"}`;
  const time = record?.start_time ? ` · ${record.start_time}` : "";
  const duration = record?.duration_minutes ? ` · ${record.duration_minutes}m` : "";
  const events = (record?.event_timeline || []).length ? ` · ${record.event_timeline.length} events` : "";
  return `${title}${date}${time}${duration}${events}`;
}

function linkedVideoAngle(video, index = 0) {
  const name = `${video?.label || ""} ${video?.filename || ""} ${video?.path || ""}`.toLowerCase().replace(/[_-]+/g, " ");
  if (/\bfeet?\b/.test(name)) return "Feet";
  if (/\b(lateral|side)\b/.test(name)) return "Lateral";
  if (/\b(wide|main|primary|front)\b/.test(name)) return "Wide";
  return "Wide";
}

function getCategoryMeta(value) {
  return EVENT_CATEGORIES.find((category) => category.value === value)
    || EVENT_CATEGORIES[EVENT_CATEGORIES.length - 1];
}

const REVIEW_EVENT_FILTERS = [
  { key: "all", label: "All events" },
  { key: "physical", label: "Physical" },
  { key: "stimulation", label: "Stimulation" },
  { key: "sensation", label: "Sensation" },
  { key: "motion", label: "Motion-derived" },
  { key: "artifact", label: "Artifacts" },
  { key: "ai", label: "AI" },
];

function isArtifactEvent(event) {
  const note = String(event?.note || "").toLowerCase();
  const tags = Array.isArray(event?.annotation_tags) ? event.annotation_tags.map((tag) => String(tag).toLowerCase()) : [];
  const categories = normalizeCategoryArray(event?.category).map((category) => String(category).toLowerCase());
  return note.includes("artifact")
    || tags.includes("artifact")
    || categories.includes("artifact")
    || note.includes("telemetry noise")
    || note.includes("contact artifact");
}

function isAiEvent(event) {
  return event?.source === "ai_video_pass"
    || event?.source === "ai_audio_pass"
    || event?.ai_generated === true
    || event?.annotation_origin === "ai"
    || event?.ai_annotation?.source === "ai"
    || event?.ai_annotation?.source === "sarah_video_pass"
    || event?.ai_annotation?.source === "sarah_audio_pass";
}

function matchesReviewEventFilter(event, filterKey) {
  if (!filterKey || filterKey === "all") return true;
  const categories = normalizeCategoryArray(event?.category);
  if (filterKey === "motion") return event?.source === "motion_derived";
  if (filterKey === "artifact") return isArtifactEvent(event);
  if (filterKey === "ai") return isAiEvent(event);
  if (filterKey === "physical") return categories.includes("physical");
  if (filterKey === "stimulation") return categories.some((category) => category === "stimulation" || category.startsWith("stimulation_"));
  if (filterKey === "sensation") return categories.includes("sensation");
  return true;
}

function MotionDerivedBadge({ event }) {
  if (event?.verification_status === "reviewed_verified") {
    return (
      <span className="rounded-full border border-emerald-400/30 bg-emerald-400/10 px-1.5 py-0.5 text-[9px] font-semibold text-emerald-300">
        Verified
      </span>
    );
  }
  if (event?.verification_status === "reviewed_adjusted") {
    return (
      <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-1.5 py-0.5 text-[9px] font-semibold text-amber-300">
        Reviewed / adjusted
      </span>
    );
  }
  return (
    <span className="rounded-full border border-primary/30 bg-primary/10 px-1.5 py-0.5 text-[9px] font-semibold text-primary">
      Motion-derived
    </span>
  );
}

function describeEventDistance(eventTime, currentTime) {
  const delta = Math.round(Number(eventTime || 0) - Number(currentTime || 0));
  if (Math.abs(delta) <= 1) return "now";
  return `${Math.abs(delta)}s ${delta < 0 ? "ago" : "ahead"}`;
}

function nearestHeartRate(rows, timeS) {
  if (!rows.length || !Number.isFinite(Number(timeS))) return null;
  let nearest = rows[0];
  let nearestDistance = Math.abs(Number(rows[0].time_offset_s || 0) - Number(timeS));

  rows.forEach((row) => {
    const distance = Math.abs(Number(row.time_offset_s || 0) - Number(timeS));
    if (distance < nearestDistance) {
      nearest = row;
      nearestDistance = distance;
    }
  });

  const hr = Number(nearest?.hr);
  return Number.isFinite(hr) ? Math.round(hr) : null;
}

function FocusMetric({ label, value, suffix = "", accent = "text-foreground" }) {
  if (value == null) return null;
  return (
    <div className="rounded-lg border border-border bg-muted/20 px-3 py-2">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className={`mt-1 font-mono text-lg font-bold ${accent}`}>{value}{suffix}</p>
    </div>
  );
}

function VitalReadingCard({ label, reading, kind, tone = "text-zinc-100", onSeek }) {
  const value = kind === "bp"
    ? (reading ? `${reading.systolic_mm_hg}/${reading.diastolic_mm_hg}` : "--/--")
    : (reading ? `${reading.spo2_percent}%` : "--");
  return (
    <button
      type="button"
      disabled={!reading}
      onClick={() => reading && onSeek?.(reading.time_offset_s)}
      className="rounded-xl border border-white/10 bg-white/[0.045] px-3 py-2 text-left transition enabled:hover:border-teal-300/40 enabled:hover:bg-teal-300/[0.06] disabled:cursor-default"
    >
      <p className="text-[9px] font-bold uppercase tracking-[0.16em] text-zinc-500">{label}</p>
      <p className={`mt-1 font-mono text-lg font-black ${tone}`}>{value}</p>
      <p className="mt-0.5 font-mono text-[9px] text-zinc-500">
        {reading ? `${Number(reading.time_offset_s) < 0 ? "−" : "+"}${formatTime(Math.abs(reading.time_offset_s))}${kind === "bp" && reading.pulse_bpm ? ` · ${reading.pulse_bpm} bpm` : ""}` : "No reading"}
      </p>
    </button>
  );
}

function ActivityBar({ label, value, color }) {
  if (value == null) return null;
  const width = Math.max(0, Math.min(100, Number(value) || 0));
  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between text-[11px]">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono font-semibold text-foreground">{value}</span>
      </div>
      <div className="h-2 overflow-hidden rounded-full bg-muted">
        <div className="h-full rounded-full" style={{ width: `${width}%`, background: color }} />
      </div>
    </div>
  );
}

function nearestMotionSample(summary, timeS) {
  const timeline = Array.isArray(summary?.derived_timeline) ? summary.derived_timeline : [];
  if (!timeline.length || !Number.isFinite(Number(timeS))) return null;
  return timeline.reduce((closest, sample) => (
    Math.abs(Number(sample.time_s) - Number(timeS)) < Math.abs(Number(closest.time_s) - Number(timeS))
      ? sample
      : closest
  ), timeline[0]);
}

function nearestCadenceSample(summary, timeS) {
  const timeline = Array.isArray(summary?.hand_cadence_timeline) ? summary.hand_cadence_timeline : [];
  if (!timeline.length || !Number.isFinite(Number(timeS))) return null;
  return timeline.reduce((closest, sample) => (
    Math.abs(Number(sample.time_s) - Number(timeS)) < Math.abs(Number(closest.time_s) - Number(timeS))
      ? sample
      : closest
  ), timeline[0]);
}

function lowerBodyPatternCandidates(summary) {
  const patterns = summary?.lower_body_pattern_summary;
  if (!patterns) return [];
  return [
    ...(patterns.oscillatory_candidates || []),
    ...(patterns.divergence_candidates || []),
    ...(patterns.sustained_activity_shift_candidates || []),
    ...(patterns.burst_candidates || []),
  ].sort((a, b) => Number(a.time_s) - Number(b.time_s));
}

function activeLowerBodyPattern(summary, timeS) {
  if (!Number.isFinite(Number(timeS))) return null;
  const candidates = lowerBodyPatternCandidates(summary);
  return candidates
    .filter((candidate) => (
      Number(timeS) >= Number(candidate.start_time_s) - 0.5
      && Number(timeS) <= Number(candidate.start_time_s) + Number(candidate.duration_s || 0) + 0.5
    ))
    .sort((a, b) => Math.abs(Number(a.time_s) - Number(timeS)) - Math.abs(Number(b.time_s) - Number(timeS)))[0] || null;
}

function postureCandidates(summary) {
  return Array.isArray(summary?.lower_body_posture_summary?.posture_candidates)
    ? summary.lower_body_posture_summary.posture_candidates
    : [];
}

function activePostureCandidate(summary, timeS) {
  if (!Number.isFinite(Number(timeS))) return null;
  return postureCandidates(summary)
    .filter((candidate) => (
      Number(timeS) >= Number(candidate.start_time_s) - 0.5
      && Number(timeS) <= Number(candidate.start_time_s) + Number(candidate.duration_s || 0) + 0.5
    ))
    .sort((a, b) => Math.abs(Number(a.time_s) - Number(timeS)) - Math.abs(Number(b.time_s) - Number(timeS)))[0] || null;
}

export default function SessionReviewPlayer() {
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedType = searchParams.get("type") === "body_exploration" || searchParams.has("exploration")
    ? "body_exploration"
    : "session";
  const requestedRecordId = searchParams.get("exploration") || searchParams.get("session") || "";
  const focusView = searchParams.get("display") === "focus";
  const videoRef = useRef(null);
  const fileInputRef = useRef(null);
  const videoUrlRef = useRef(null);
  const timelineSeekRef = useRef(false);
  const autoVideoPathRef = useRef("");
  const autoVideoAbortRef = useRef(null);
  const pendingVideoSwitchRef = useRef(null);

  const [sessions, setSessions] = useState([]);
  const [explorations, setExplorations] = useState([]);
  const [recordType, setRecordType] = useState(requestedType);
  const [selectedId, setSelectedId] = useState("");
  const [selectedSession, setSelectedSession] = useState(null);
  const [timelineRows, setTimelineRows] = useState([]);
  const [pulseOxImports, setPulseOxImports] = useState([]);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [loadingReview, setLoadingReview] = useState(false);
  const [videoSrc, setVideoSrc] = useState("");
  const [videoName, setVideoName] = useState("");
  const [videoTime, setVideoTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [videoPlaying, setVideoPlaying] = useState(false);
  const [videoLoadStatus, setVideoLoadStatus] = useState("");
  const [videoLoadError, setVideoLoadError] = useState("");
  const [activeLinkedVideoPath, setActiveLinkedVideoPath] = useState("");
  const [timelineSyncTime, setTimelineSyncTime] = useState(null);
  const [selectedEventIdx, setSelectedEventIdx] = useState(null);
  const [timelineWaypointDetail, setTimelineWaypointDetail] = useState(null);
  const [followTimeline, setFollowTimeline] = useState(true);
  const [eventFilter, setEventFilter] = useState("all");
  const [eventSearch, setEventSearch] = useState("");
  const reviewTime = Number.isFinite(Number(timelineSyncTime)) ? Number(timelineSyncTime) : videoTime;

  const filteredEventEntries = useMemo(() => {
    const searchNeedle = String(eventSearch || "").trim().toLowerCase();
    return (selectedSession?.event_timeline || [])
      .map((event, index) => ({ event, index }))
      .filter(({ event }) => matchesReviewEventFilter(event, eventFilter))
      .filter(({ event }) => {
        if (!searchNeedle) return true;
        const categoryText = normalizeCategoryArray(event.category).join(" ");
        return `${event.note || ""} ${categoryText} ${event.source || ""}`.toLowerCase().includes(searchNeedle);
      });
  }, [eventFilter, eventSearch, selectedSession?.event_timeline]);
  const nearbyEvents = useMemo(() => (
    filteredEventEntries
      .map(({ event, index }) => ({
        event,
        index,
        distance: Math.abs(Number(event.time_s || 0) - reviewTime),
      }))
      .sort((a, b) => a.distance - b.distance)
      .slice(0, 3)
  ), [filteredEventEntries, reviewTime]);
  const reviewEventSummary = useMemo(() => {
    const sourceEvents = selectedSession?.event_timeline || [];
    return {
      total: sourceEvents.length,
      filtered: filteredEventEntries.length,
      motion: sourceEvents.filter((event) => event?.source === "motion_derived").length,
      artifacts: sourceEvents.filter((event) => isArtifactEvent(event)).length,
      ai: sourceEvents.filter((event) => isAiEvent(event)).length,
    };
  }, [filteredEventEntries.length, selectedSession?.event_timeline]);
  const nearbyEventsLabel = eventFilter === "all" && !eventSearch.trim()
    ? "The closest observation to the current video moment stays first."
    : `${filteredEventEntries.length} matching event${filteredEventEntries.length === 1 ? "" : "s"} in this review focus.`;

  const currentReviewEvent = nearbyEvents[0] || null;
  const currentReviewEventHR = useMemo(
    () => nearestHeartRate(timelineRows, currentReviewEvent?.event?.time_s),
    [currentReviewEvent?.event?.time_s, timelineRows],
  );
  const playbackHR = useMemo(() => nearestHeartRate(timelineRows, reviewTime), [reviewTime, timelineRows]);
  const savedMotion = selectedSession?.motion_analysis_summary;
  const playbackMotion = useMemo(() => nearestMotionSample(savedMotion, reviewTime), [reviewTime, savedMotion]);
  const playbackCadence = useMemo(() => nearestCadenceSample(savedMotion, reviewTime), [reviewTime, savedMotion]);
  const selectedSessionWithPulseOx = useMemo(() => {
    if (!selectedSession || !pulseOxImports.length) return selectedSession;
    const nearby = selectNearbyVitalReadings(
      selectedSession,
      { pulseOx: pulseOxImports },
      { pulseOx: 24 },
      recordType === "body_exploration" ? "exploration" : "session",
    );
    const during = nearby.pulseOx.filter((reading) => /^during\s+/i.test(String(reading.relationship || "")));
    if (!during.length) return selectedSession;
    return {
      ...selectedSession,
      pulse_ox_readings: [...pulseOxReadingsFromSession(selectedSession), ...during],
    };
  }, [pulseOxImports, recordType, selectedSession]);
  const nearClimaxContextEvidence = useMemo(
    () => buildNearClimaxContextEvidence(selectedSession || {}),
    [selectedSession]
  );
  const reviewNearClimaxEvents = useMemo(
    () => filterContradictedNearClimaxEvents(selectedSession?.ai_near_climax_events || [], nearClimaxContextEvidence),
    [nearClimaxContextEvidence, selectedSession?.ai_near_climax_events]
  );
  const confirmedNearClimaxEvents = useMemo(
    () => getContextConfirmedNearClimaxEvents(reviewNearClimaxEvents, nearClimaxContextEvidence),
    [nearClimaxContextEvidence, reviewNearClimaxEvents]
  );
  const bloodPressureRows = useMemo(
    () => normalizeTimedReadings(bloodPressureReadingsFromSession(selectedSessionWithPulseOx), selectedSessionWithPulseOx),
    [selectedSessionWithPulseOx],
  );
  const pulseOxRows = useMemo(
    () => normalizeTimedReadings(pulseOxReadingsFromSession(selectedSessionWithPulseOx), selectedSessionWithPulseOx),
    [selectedSessionWithPulseOx],
  );
  const bpSequence = useMemo(() => readingSequenceAt(bloodPressureRows, reviewTime), [bloodPressureRows, reviewTime]);
  const pulseOxNow = useMemo(() => nearestTimedReading(pulseOxRows, reviewTime, 90), [pulseOxRows, reviewTime]);
  const physiologyNow = useMemo(() => {
    if (!timelineRows.length) return null;
    return timelineRows.reduce((best, row) => (
      Math.abs(Number(row.time_offset_s) - reviewTime) < Math.abs(Number(best.time_offset_s) - reviewTime) ? row : best
    ), timelineRows[0]);
  }, [reviewTime, timelineRows]);

  useEffect(() => {
    Promise.all([
      base44.entities.Session.list("-date", 250).catch(() => []),
      base44.entities.BodyExploration.list("-date", 250).catch(() => []),
    ])
      .then(([sessionRows, explorationRows]) => {
        setSessions(sessionRows);
        setExplorations(explorationRows);
      })
      .finally(() => setLoadingSessions(false));
  }, []);

  useEffect(() => () => {
    if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current);
  }, []);

  const releaseVideoUrl = useCallback(() => {
    if (!videoUrlRef.current) return;
    URL.revokeObjectURL(videoUrlRef.current);
    videoUrlRef.current = null;
  }, []);

  const prepareLinkedVideo = useCallback((linked, { preservePosition = false } = {}) => {
    if (!linked?.path || autoVideoPathRef.current === linked.path) return;
    const previousTime = preservePosition ? Number(videoRef.current?.currentTime || 0) : 0;
    const shouldPlay = preservePosition && !videoRef.current?.paused;
    autoVideoAbortRef.current?.abort();
    const controller = new AbortController();
    autoVideoAbortRef.current = controller;
    autoVideoPathRef.current = linked.path;
    setActiveLinkedVideoPath(linked.path);
    pendingVideoSwitchRef.current = { time: previousTime, shouldPlay };
    setVideoLoadStatus("Preparing linked video…");
    setVideoLoadError("");
    base44.integrations.Core.ConvertLocalVideoForPlayback({
      path: linked.path,
      label: linked.label || linked.filename || "telemetry-theater",
      signal: controller.signal,
    }).then((result) => {
      const rawUrl = result?.url || result?.file_url;
      if (!rawUrl) throw new Error("Playback preparation did not return a video URL.");
      releaseVideoUrl();
      setVideoSrc(base44.integrations.Core.localVisionAssetUrl(rawUrl));
      setVideoName(linked.label || linked.filename || linked.path.split(/[\\/]/).pop());
      setVideoTime(previousTime);
      setTimelineSyncTime(previousTime);
      setVideoLoadStatus("");
      autoVideoAbortRef.current = null;
    }).catch((error) => {
      if (error?.name === "AbortError") return;
      setVideoLoadStatus("");
      setVideoLoadError(error?.data?.error || error?.message || "Could not prepare the linked video.");
      autoVideoAbortRef.current = null;
      if (autoVideoPathRef.current === linked.path) autoVideoPathRef.current = "";
      pendingVideoSwitchRef.current = null;
    });
  }, [releaseVideoUrl]);

  useEffect(() => {
    const linked = (selectedSession?.linked_local_videos || []).find((video) => video?.path && video.exists !== false);
    if (!linked?.path || autoVideoPathRef.current === linked.path) return undefined;
    prepareLinkedVideo(linked);
    return () => {
      autoVideoAbortRef.current?.abort();
      autoVideoAbortRef.current = null;
    };
  }, [prepareLinkedVideo, selectedSession]);

  const loadVideoFile = (file) => {
    if (!file) return;
    autoVideoAbortRef.current?.abort();
    autoVideoAbortRef.current = null;
    autoVideoPathRef.current = "";
    setActiveLinkedVideoPath("");
    releaseVideoUrl();
    const nextUrl = URL.createObjectURL(file);
    videoUrlRef.current = nextUrl;
    setVideoSrc(nextUrl);
    setVideoName(file.name);
    setVideoTime(0);
    setVideoDuration(0);
    setVideoPlaying(false);
    setTimelineSyncTime(0);
  };

  const handleVideoChange = (event) => {
    loadVideoFile(event.target.files?.[0]);
    event.target.value = "";
  };

  const handleSelectSession = useCallback(async (id, typeOverride = recordType) => {
    autoVideoAbortRef.current?.abort();
    autoVideoAbortRef.current = null;
    autoVideoPathRef.current = "";
    releaseVideoUrl();
    setVideoSrc("");
    setVideoName("");
    setVideoTime(0);
    setVideoDuration(0);
    setTimelineSyncTime(0);
    setVideoLoadStatus("");
    setVideoLoadError("");
    setActiveLinkedVideoPath("");
    setPulseOxImports([]);
    setSelectedId(id);
    setSelectedSession(null);
    setTimelineRows([]);
    setSelectedEventIdx(null);
    setTimelineWaypointDetail(null);
    if (!id) return;

    setLoadingReview(true);
    try {
      const entity = typeOverride === "body_exploration" ? base44.entities.BodyExploration : base44.entities.Session;
      const [sessionRows, rows, importedPulseOx] = await Promise.all([
        entity.filter({ id }),
        base44.entities.HeartRateTimeline.filter({ session: id }, "time_offset_s", 10000),
        base44.entities.PulseOxReading.list("-measured_at", 5000).catch(() => []),
      ]);
      setSelectedSession(sessionRows[0] || null);
      setTimelineRows(rows);
      setPulseOxImports(importedPulseOx);
    } finally {
      setLoadingReview(false);
    }
  }, [recordType]);

  useEffect(() => {
    const requestedRecords = requestedType === "body_exploration" ? explorations : sessions;
    if (!requestedRecordId || loadingSessions || selectedId || !requestedRecords.some((record) => record.id === requestedRecordId)) return;
    setRecordType(requestedType);
    handleSelectSession(requestedRecordId, requestedType);
  }, [explorations, handleSelectSession, loadingSessions, requestedRecordId, requestedType, selectedId, sessions]);

  const handleRecordTypeChange = (type) => {
    setRecordType(type);
    setSelectedId("");
    setSelectedSession(null);
    setTimelineRows([]);
    setSelectedEventIdx(null);
    setTimelineWaypointDetail(null);
    autoVideoPathRef.current = "";
    setVideoLoadStatus("");
    setVideoLoadError("");
    setActiveLinkedVideoPath("");
    setPulseOxImports([]);
    const next = new URLSearchParams(searchParams);
    next.delete("session");
    next.delete("exploration");
    if (type === "body_exploration") next.set("type", "body_exploration");
    else next.delete("type");
    setSearchParams(next, { replace: true });
  };

  const records = recordType === "body_exploration" ? explorations : sessions;
  const isExploration = recordType === "body_exploration";
  const linkedVideos = useMemo(
    () => (selectedSession?.linked_local_videos || []).filter((video) => video?.path && video.exists !== false),
    [selectedSession?.linked_local_videos],
  );

  const handleLinkedVideoChange = (path) => {
    const linked = linkedVideos.find((video) => video.path === path);
    if (linked) prepareLinkedVideo(linked, { preservePosition: true });
  };

  const handleVideoMetadataLoaded = (event) => {
    const duration = event.currentTarget.duration || 0;
    setVideoDuration(duration);
    const pending = pendingVideoSwitchRef.current;
    if (!pending) return;
    const nextTime = Math.max(0, Math.min(Number(pending.time) || 0, duration || Number(pending.time) || 0));
    event.currentTarget.currentTime = nextTime;
    setVideoTime(nextTime);
    setTimelineSyncTime(nextTime);
    if (pending.shouldPlay) event.currentTarget.play().catch(() => {});
    pendingVideoSwitchRef.current = null;
  };

  const seekVideoTo = useCallback((timeS, shouldPlay = false, waitForSeek = false) => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(Number(timeS))) return Promise.resolve();
    const nextTime = Math.max(0, Math.min(Number(timeS), Number.isFinite(video.duration) ? video.duration : Number(timeS)));
    const playVideo = () => {
      if (shouldPlay) video.play().catch(() => {});
    };

    if (!waitForSeek || video.readyState < 1) {
      video.currentTime = nextTime;
      setVideoTime(nextTime);
      playVideo();
      return Promise.resolve();
    }

    return new Promise((resolve) => {
      let timeoutId = null;
      const finish = () => {
        if (timeoutId) window.clearTimeout(timeoutId);
        video.removeEventListener("seeked", finish);
        setVideoTime(video.currentTime);
        playVideo();
        resolve();
      };

      if (!video.seeking && Math.abs(video.currentTime - nextTime) < 0.15) {
        finish();
        return;
      }

      video.addEventListener("seeked", finish);
      video.currentTime = nextTime;
      setVideoTime(nextTime);

      // Local media should emit seeked; keep playback moving if a browser misses it.
      timeoutId = window.setTimeout(finish, 8000);
    });
  }, []);

  const handleWaypointChange = (detail) => {
    setTimelineWaypointDetail(detail);
  };

  const handleTimelinePlayingChange = useCallback((playing) => {
    const video = videoRef.current;
    if (!video) return;
    if (playing) {
      video.play().catch(() => {});
      return;
    }
    video.pause();
  }, []);

  const handleTimelinePlaybackRateChange = useCallback((rate) => {
    const video = videoRef.current;
    if (!video || !Number.isFinite(Number(rate))) return;
    video.playbackRate = Number(rate);
  }, []);

  const handleTimelineTimeChange = useCallback((timeS) => {
    setTimelineSyncTime(timeS);
    if (!followTimeline) return;
    timelineSeekRef.current = true;
    seekVideoTo(timeS, false, true).finally(() => {
      window.setTimeout(() => {
        timelineSeekRef.current = false;
      }, 0);
    });
  }, [followTimeline, seekVideoTo]);

  const handleVideoSeeked = (event) => {
    const nextTime = event.currentTarget.currentTime;
    setVideoTime(nextTime);
    if (!timelineSeekRef.current) {
      setTimelineSyncTime(nextTime);
    }
  };

  const handleVideoTimeUpdate = (event) => {
    const nextTime = event.currentTarget.currentTime;
    setVideoTime(nextTime);
    setTimelineSyncTime(nextTime);
  };

  const handleSelectEventIndex = (index) => {
    setSelectedEventIdx(index);
    if (index != null && followTimeline) {
      seekVideoTo(selectedSession?.event_timeline?.[index]?.time_s, true);
    }
  };

  useEffect(() => {
    setSelectedEventIdx(nearbyEvents[0]?.index ?? null);
  }, [nearbyEvents]);

  useEffect(() => {
    setEventFilter("all");
    setEventSearch("");
  }, [selectedId]);

  const hasTimelineReview = selectedSession
    && (timelineRows.length > 0
      || (selectedSession.event_timeline || []).length > 0
      || (selectedSession.ai_near_climax_events || []).length > 0
      || selectedSession.pre_climax_offset_s != null
      || selectedSession.climax_offset_s != null
      || selectedSession.recovery_offset_s != null);
  const setFocusView = (enabled) => {
    const next = new URLSearchParams(searchParams);
    if (enabled) {
      next.set("display", "focus");
      if (selectedId && isExploration) {
        next.set("type", "body_exploration");
        next.set("exploration", selectedId);
        next.delete("session");
      } else if (selectedId) {
        next.set("session", selectedId);
        next.delete("exploration");
        next.delete("type");
      }
    }
    else next.delete("display");
    setSearchParams(next);
  };

  if (focusView && selectedSession && !loadingReview) {
    const motion = savedMotion;
    const currentLeft = playbackMotion?.left_lower_body_activity;
    const currentRight = playbackMotion?.right_lower_body_activity;
    const currentTotal = Number(currentLeft || 0) + Number(currentRight || 0);
    const currentIndex = currentTotal > 0 ? (Number(currentLeft || 0) - Number(currentRight || 0)) / currentTotal : null;
    const sideBalance = currentIndex != null
      ? (Math.abs(currentIndex) <= 0.1 ? "Similar now" : `${currentIndex > 0 ? "Left" : "Right"} now`)
      : null;
    const currentPattern = activeLowerBodyPattern(motion, reviewTime);
    const durationS = Math.max(
      Number(videoDuration) || 0,
      Number(selectedSession.duration_minutes || 0) * 60,
      ...timelineRows.map((row) => Number(row.time_offset_s) || 0),
      ...(motion?.derived_timeline || []).map((row) => Number(row.time_s) || 0),
      ...pulseOxRows.map((row) => Number(row.time_offset_s) || 0),
      ...bloodPressureRows.map((row) => Number(row.time_offset_s) || 0),
    );
    const currentRmssd = ["moderate", "high"].includes(String(physiologyNow?.hrv_quality || "").toLowerCase())
      ? Number(physiologyNow?.hrv_rmssd_ms) || null
      : null;
    const currentRespiration = !physiologyNow?.respiration_unavailable_reason && Number(physiologyNow?.respiration_bpm) > 0
      ? Number(physiologyNow.respiration_bpm)
      : null;

    return (
      <div className="h-screen overflow-hidden bg-[#050608] text-zinc-100">
        <div className="pointer-events-none fixed inset-0 bg-[radial-gradient(circle_at_18%_15%,rgba(20,184,166,0.12),transparent_35%),radial-gradient(circle_at_88%_5%,rgba(168,85,247,0.12),transparent_30%)]" />
        <div className="relative flex h-full min-h-0 flex-col gap-2.5 p-2.5 md:p-3">
          <header className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-white/10 bg-black/45 px-4 py-2.5 shadow-2xl backdrop-blur-xl">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className="h-2 w-2 animate-pulse rounded-full bg-teal-300 shadow-[0_0_14px_rgba(45,212,191,0.8)]" />
                <p className="text-[10px] font-black uppercase tracking-[0.24em] text-teal-300">Session Telemetry Theater</p>
              </div>
              <p className="mt-0.5 truncate text-xs text-zinc-400">{reviewLabel(selectedSession, isExploration)}{videoName ? ` · ${videoName}` : ""}</p>
            </div>
            <div className="flex items-center gap-2">
              {linkedVideos.length > 0 && (
                <Select value={activeLinkedVideoPath || linkedVideos[0]?.path} onValueChange={handleLinkedVideoChange}>
                  <SelectTrigger className="h-9 w-[12rem] border-white/10 bg-white/5 text-xs text-zinc-200">
                    <Video className="mr-2 h-4 w-4 shrink-0 text-teal-300" />
                    <SelectValue placeholder="Choose camera" />
                  </SelectTrigger>
                  <SelectContent>
                    {linkedVideos.map((video, index) => (
                      <SelectItem key={video.id || video.path} value={video.path}>
                        {linkedVideoAngle(video, index)} · {video.label || video.filename || `Camera ${index + 1}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              )}
              <button type="button" onClick={() => fileInputRef.current?.click()} className="inline-flex items-center gap-2 rounded-xl border border-white/10 bg-white/5 px-3 py-2 text-xs font-medium text-zinc-200 hover:border-teal-300/40">
                Browse…
              </button>
              <button
                type="button"
                onClick={() => setFocusView(false)}
                className="inline-flex items-center gap-2 rounded-xl border border-teal-300/25 bg-teal-300/10 px-3 py-2 text-xs font-semibold text-teal-200"
              >
                <X className="h-4 w-4" />
                Exit Theater
              </button>
              <input ref={fileInputRef} type="file" accept="video/*" className="hidden" onChange={handleVideoChange} />
            </div>
          </header>

          <div className="grid min-h-0 flex-1 grid-rows-[minmax(48vh,1.4fr)_minmax(0,1fr)] gap-2.5 xl:grid-cols-[minmax(0,1fr)_27rem] xl:grid-rows-1">
            <section className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-white/10 bg-black/60 shadow-[0_30px_80px_rgba(0,0,0,0.55)]">
                {currentReviewEvent && (
                  <button
                    type="button"
                    onClick={() => handleSelectEventIndex(currentReviewEvent.index)}
                    className="grid h-[4.25rem] shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-3 overflow-hidden border-b border-teal-300/15 bg-teal-300/[0.06] px-4 py-2 text-left"
                  >
                    <div className="min-w-0 overflow-hidden">
                      <div className="flex items-center gap-1.5 overflow-hidden whitespace-nowrap">
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-teal-300">Closest Event</span>
                        {normalizeCategoryArray(currentReviewEvent.event.category).map((category) => {
                          const meta = getCategoryMeta(category);
                          return (
                            <span key={category} className="rounded-full border px-1.5 py-0.5 text-[9px] font-semibold" style={{ color: meta.color, borderColor: `${meta.color}44`, background: `${meta.color}18` }}>
                              {meta.label}
                            </span>
                          );
                        })}
                        {currentReviewEvent.event.source === "motion_derived" && <MotionDerivedBadge event={currentReviewEvent.event} />}
                      </div>
                      <p className="line-clamp-2 text-sm leading-5 text-zinc-200" title={currentReviewEvent.event.note || "Event note"}>{currentReviewEvent.event.note || "Event note"}</p>
                    </div>
                    <span className="font-mono text-sm font-semibold text-teal-300">{formatTime(currentReviewEvent.event.time_s)}</span>
                  </button>
                )}
                <div className="relative flex min-h-0 flex-1 items-center justify-center bg-black">
                  {videoSrc ? (
                    <video
                      ref={videoRef}
                      src={videoSrc}
                      controls
                      playsInline
                      className="h-full max-h-full w-full bg-black object-contain"
                      onTimeUpdate={handleVideoTimeUpdate}
                      onPlay={() => setVideoPlaying(true)}
                      onPause={() => setVideoPlaying(false)}
                      onSeeked={handleVideoSeeked}
                      onLoadedMetadata={handleVideoMetadataLoaded}
                    />
                  ) : videoLoadStatus ? (
                    <div className="flex flex-col items-center gap-3 text-teal-200">
                      <Loader2 className="h-9 w-9 animate-spin" />
                      <span className="text-sm font-semibold">{videoLoadStatus}</span>
                      <span className="text-xs text-zinc-500">Telemetry is ready while the MP4 preview finishes.</span>
                    </div>
                  ) : (
                    <button type="button" onClick={() => fileInputRef.current?.click()} className="flex flex-col items-center gap-3 text-zinc-500 hover:text-teal-300">
                      <Video className="h-10 w-10" />
                      <span className="text-sm font-semibold">Load the full {isExploration ? "body exploration" : "session"} video</span>
                      {videoLoadError && <span className="max-w-md text-center text-xs text-rose-400">{videoLoadError}</span>}
                    </button>
                  )}
                  <div className="pointer-events-none absolute bottom-3 left-3 rounded-xl border border-white/10 bg-black/60 px-3 py-1.5 font-mono text-sm font-black text-white backdrop-blur">
                    {formatTime(reviewTime)} <span className="text-zinc-600">/</span> {formatTime(durationS)}
                  </div>
                </div>
                <div className="grid grid-cols-3 gap-px border-t border-white/10 bg-white/10 sm:grid-cols-6">
                  <FocusMetric label="Heart Rate" value={playbackHR ?? "--"} suffix={playbackHR != null ? " bpm" : ""} accent="text-rose-400" />
                  <FocusMetric label="SpO₂" value={pulseOxNow?.spo2_percent ?? "--"} suffix={pulseOxNow ? "%" : ""} accent="text-sky-400" />
                  <FocusMetric label="Blood Pressure" value={bpSequence.previous ? `${bpSequence.previous.systolic_mm_hg}/${bpSequence.previous.diastolic_mm_hg}` : "--/--"} accent="text-amber-300" />
                  <FocusMetric label="RMSSD" value={currentRmssd != null ? currentRmssd.toFixed(1) : "--"} suffix={currentRmssd != null ? " ms" : ""} accent="text-teal-300" />
                  <FocusMetric label="Respiration" value={currentRespiration != null ? currentRespiration.toFixed(1) : "--"} suffix={currentRespiration != null ? "/min" : ""} accent="text-blue-300" />
                  <FocusMetric label="Motion Balance" value={sideBalance || "--"} accent="text-violet-300" />
                </div>
            </section>

            <aside className="flex min-h-0 flex-col overflow-hidden rounded-2xl border border-white/10 bg-black/40 p-2 shadow-2xl backdrop-blur-xl">
              <div className="mb-1.5 shrink-0 rounded-xl border border-white/10 bg-gradient-to-br from-amber-300/[0.08] to-sky-300/[0.04] p-2">
                <div className="mb-1.5 flex items-center justify-between">
                  <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-[0.16em] text-amber-300"><Gauge className="h-3.5 w-3.5" /> BP sequence</div>
                  <div className="flex items-center gap-1.5 text-[10px] text-sky-300"><Droplets className="h-3.5 w-3.5" /> {pulseOxRows.length} SpO₂</div>
                </div>
                <div className="grid grid-cols-2 gap-1.5">
                  <VitalReadingCard label="Previous BP" reading={bpSequence.previous} kind="bp" tone="text-amber-200" onSeek={(time) => seekVideoTo(time, false, true)} />
                  <VitalReadingCard label="Upcoming BP" reading={bpSequence.upcoming} kind="bp" tone="text-amber-200" onSeek={(time) => seekVideoTo(time, false, true)} />
                </div>
              </div>
              <div className="min-h-0 flex-1">
                <TelemetryTheaterCharts
                compact
                timelineRows={timelineRows}
                pulseOxRows={pulseOxRows}
                bloodPressureRows={bloodPressureRows}
                motionSummary={motion}
                cursor={reviewTime}
                durationS={durationS}
                onSeek={(time) => seekVideoTo(time, false, true)}
                />
              </div>
              {(currentPattern || playbackCadence?.movement_cycles_per_minute_estimate != null) && (
                <div className="mt-1.5 shrink-0 truncate rounded-lg border border-violet-300/20 bg-violet-300/[0.06] px-2 py-1 text-[10px] text-zinc-400">
                  <span className="font-semibold text-violet-300">At this moment:</span>{currentPattern ? ` ${currentPattern.label}.` : ""}{playbackCadence?.movement_cycles_per_minute_estimate != null ? ` Cadence proxy ${playbackCadence.movement_cycles_per_minute_estimate} cycles/min.` : ""}
                </div>
              )}
            </aside>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Review Player"
        subtitle="Review a session or body exploration video with its heart-rate trace, event markers, and nearby observations moving with playback."
      />

      <div className="px-4 pb-8 space-y-4">
        <div className="rounded-xl border border-border bg-card p-4 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-primary">Review Source</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Choose a session or body exploration first, then load the full local recording for timeline-guided review.
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <div className="inline-flex rounded-lg border border-border bg-background p-1">
                <button type="button" onClick={() => handleRecordTypeChange("session")} className={`rounded-md px-3 py-1.5 text-xs font-medium ${!isExploration ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}>Sessions</button>
                <button type="button" onClick={() => handleRecordTypeChange("body_exploration")} className={`rounded-md px-3 py-1.5 text-xs font-medium ${isExploration ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}>Body Exploration</button>
              </div>
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90"
              >
                <Video className="h-4 w-4" />
                {videoSrc ? "Change Video" : "Load Full Video"}
              </button>
              {selectedSession && (
                <button
                  type="button"
                  onClick={() => setFocusView(true)}
                  className="inline-flex h-10 items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-4 text-sm font-semibold text-primary transition-colors hover:bg-primary/15"
                >
                  <Maximize2 className="h-4 w-4" />
                  Telemetry Theater
                </button>
              )}
            </div>
            <input ref={fileInputRef} type="file" accept="video/*" className="hidden" onChange={handleVideoChange} />
          </div>

          {loadingSessions ? (
            <div className="flex h-11 items-center text-sm text-muted-foreground">Loading review records...</div>
          ) : (
            <Select value={selectedId} onValueChange={handleSelectSession}>
              <SelectTrigger className="h-11">
                <SelectValue placeholder={isExploration ? "Choose a body exploration to review..." : "Choose a session to review..."} />
              </SelectTrigger>
              <SelectContent>
                {records.map((record) => (
                  <SelectItem key={record.id} value={record.id}>
                    {reviewLabel(record, isExploration)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
        </div>

        {videoSrc && !selectedSession && !loadingReview && (
          <div className="overflow-hidden rounded-xl border border-border bg-card">
            <div className="border-b border-border px-4 py-3">
              <p className="text-xs font-semibold uppercase tracking-wider text-primary">Local Video Preview</p>
              <p className="mt-1 truncate text-xs text-muted-foreground">{videoName}</p>
            </div>
            <div className="space-y-3 p-4">
              <div className="overflow-hidden rounded-lg bg-black">
                <video
                  ref={videoRef}
                  src={videoSrc}
                  controls
                  playsInline
                  className="aspect-video max-h-[58vh] w-full bg-black object-contain"
                  onTimeUpdate={handleVideoTimeUpdate}
                  onPlay={() => setVideoPlaying(true)}
                  onPause={() => setVideoPlaying(false)}
                  onSeeked={handleVideoSeeked}
                  onLoadedMetadata={(event) => setVideoDuration(event.currentTarget.duration || 0)}
                />
              </div>
              <p className="rounded-lg bg-muted/35 px-3 py-2 text-xs text-muted-foreground">
                This local preview supports motion analysis without attaching the recording to a stored record.
              </p>
            </div>
          </div>
        )}

        <div className="rounded-xl border border-primary/20 bg-primary/[0.05] p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-start gap-3">
              <Activity className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-primary">Motion Processing Moved to Motion Lab</p>
                <p className="mt-1 text-sm text-muted-foreground">
                  Review Player now concentrates on playback, saved motion evidence, and timeline confirmation. Configure or re-run local detection in Motion Lab.
                </p>
              </div>
            </div>
            {isExploration && selectedSession?.id ? (
              <Link
                to={`/exploration/${encodeURIComponent(selectedSession.id)}`}
                className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
              >
                Open Exploration
              </Link>
            ) : (
              <Link
                to={`/motion-lab${selectedSession?.id ? `?session=${encodeURIComponent(selectedSession.id)}` : ""}`}
                className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
              >
                Open Motion Lab
              </Link>
            )}
          </div>
        </div>

        {selectedSession?.motion_analysis_summary && (
          <SavedMotionSummaryCard
            summary={selectedSession.motion_analysis_summary}
            onSeek={videoSrc ? (timeS) => seekVideoTo(timeS, false, true) : undefined}
            playbackTime={videoTime}
          />
        )}

        {loadingReview && (
          <div className="flex h-28 items-center justify-center rounded-xl border border-border bg-card">
            <div className="h-6 w-6 animate-spin rounded-full border-4 border-primary border-t-transparent" />
          </div>
        )}

        {!selectedId && !loadingSessions && (
          <div className="rounded-xl border border-border bg-card px-4 py-14 text-center text-sm text-muted-foreground">
            Select a {isExploration ? "body exploration" : "session"} to open its timeline review.
          </div>
        )}

        {selectedSession && !loadingReview && (
          <div className="grid gap-4 2xl:grid-cols-[minmax(520px,1.2fr)_minmax(420px,0.8fr)]">
            <section className="min-w-0 space-y-4 2xl:sticky 2xl:top-20 2xl:self-start">
              <div className="overflow-hidden rounded-xl border border-border bg-card">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
                  <div className="flex min-w-0 items-center gap-2">
                    <Clapperboard className="h-4 w-4 shrink-0 text-primary" />
                    <div className="min-w-0">
                      <p className="text-xs font-semibold uppercase tracking-wider text-primary">Full Video Review</p>
                      <p className="truncate text-xs text-muted-foreground">{videoName || "No local video loaded yet"}</p>
                    </div>
                  </div>
                  <label className="inline-flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs font-medium text-foreground">
                    <input
                      type="checkbox"
                      checked={followTimeline}
                      onChange={(event) => setFollowTimeline(event.target.checked)}
                      className="h-3.5 w-3.5 accent-primary"
                    />
                    Follow timeline
                  </label>
                </div>

                {currentReviewEvent && (
                  <button
                    type="button"
                    onClick={() => handleSelectEventIndex(currentReviewEvent.index)}
                    className="w-full border-b border-primary/20 bg-primary/[0.08] px-4 py-3 text-left transition-colors hover:bg-primary/[0.12]"
                  >
                    <div className="flex flex-wrap items-start justify-between gap-3">
                      <div className="min-w-0 flex-1 space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span className="text-[10px] font-semibold uppercase tracking-wider text-primary">
                            Current Event
                          </span>
                          {normalizeCategoryArray(currentReviewEvent.event.category).map((category) => {
                            const meta = getCategoryMeta(category);
                            return (
                              <span
                                key={category}
                                className="rounded-full border px-1.5 py-0.5 text-[9px] font-semibold"
                                style={{
                                  background: `${meta.color}18`,
                                  borderColor: `${meta.color}44`,
                                  color: meta.color,
                                }}
                              >
                                {meta.label}
                              </span>
                            );
                          })}
                          {currentReviewEvent.event.source === "motion_derived" && <MotionDerivedBadge event={currentReviewEvent.event} />}
                        </div>
                        <p className="text-sm leading-relaxed text-foreground">
                          {currentReviewEvent.event.note || "Event note"}
                        </p>
                      </div>
                      <div className="flex shrink-0 items-center gap-3 rounded-lg border border-border bg-card/80 px-3 py-2">
                        <div className="text-right">
                          <p className="font-mono text-xs font-semibold text-foreground">
                            {formatTime(currentReviewEvent.event.time_s)}
                          </p>
                          <p className="font-mono text-[10px] text-muted-foreground">
                            {describeEventDistance(currentReviewEvent.event.time_s, reviewTime)}
                          </p>
                        </div>
                        <div className="h-8 w-px bg-border" />
                        <div className="text-right">
                          <p className="font-mono text-sm font-bold text-destructive">
                            {currentReviewEventHR != null ? currentReviewEventHR : "--"}
                          </p>
                          <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                            {currentReviewEventHR != null ? "bpm" : "no HR"}
                          </p>
                        </div>
                      </div>
                    </div>
                  </button>
                )}

                {videoSrc ? (
                  <div className="space-y-3 p-4">
                    <div className="overflow-hidden rounded-lg bg-black">
                      <video
                        ref={videoRef}
                        src={videoSrc}
                        controls
                        playsInline
                        className="aspect-video max-h-[72vh] w-full bg-black object-contain"
                        onTimeUpdate={handleVideoTimeUpdate}
                        onPlay={() => setVideoPlaying(true)}
                        onPause={() => setVideoPlaying(false)}
                        onSeeked={handleVideoSeeked}
                        onLoadedMetadata={(event) => setVideoDuration(event.currentTarget.duration || 0)}
                      />
                    </div>
                    <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg bg-muted/35 px-3 py-2 text-xs">
                      <span className="font-mono font-semibold text-primary">{formatTime(videoTime)}</span>
                      <span className="text-muted-foreground">
                        {videoDuration ? `${formatTime(videoDuration)} full recording` : "Loading video timing..."}
                      </span>
                    </div>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => fileInputRef.current?.click()}
                    className="flex min-h-[360px] w-full flex-col items-center justify-center gap-3 px-6 text-muted-foreground transition-colors hover:text-primary"
                  >
                    <Video className="h-10 w-10" />
                    <span className="text-sm font-semibold">Load the full {isExploration ? "body exploration" : "session"} video</span>
                    <span className="max-w-md text-center text-xs">
                      Load the recording, then let the video carry the telemetry and nearby event notes with it.
                    </span>
                  </button>
                )}
              </div>

              <div className="rounded-xl border border-border bg-card p-4">
                <div className="flex items-start gap-3">
                  <ScanSearch className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
                  <div className="space-y-1">
                    <p className="text-xs font-semibold uppercase tracking-wider text-primary">Review Behavior</p>
                    <p className="text-sm text-muted-foreground">
                      Video and timeline controls share play, pause, speed, and seek state. Let the recording play naturally, or use a marker to jump to a review moment.
                    </p>
                  </div>
                </div>
              </div>

              <div className="rounded-xl border border-border bg-card p-4 space-y-3">
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-primary">Review Focus</p>
                    <p className="mt-1 text-sm text-muted-foreground">
                      Narrow the event stream before you start chasing moments through the recording.
                    </p>
                  </div>
                  <div className="grid min-w-[16rem] grid-cols-2 gap-2 sm:grid-cols-4">
                    <FocusMetric label="Events" value={reviewEventSummary.total} />
                    <FocusMetric label="Filtered" value={reviewEventSummary.filtered} accent="text-primary" />
                    <FocusMetric label="Artifacts" value={reviewEventSummary.artifacts} />
                    <FocusMetric label="Motion" value={reviewEventSummary.motion} />
                  </div>
                </div>
                <div className="flex flex-wrap gap-2">
                  {REVIEW_EVENT_FILTERS.map((filter) => (
                    <button
                      key={filter.key}
                      type="button"
                      onClick={() => setEventFilter(filter.key)}
                      className={`rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors ${
                        eventFilter === filter.key
                          ? "border-primary bg-primary text-primary-foreground"
                          : "border-border bg-muted/20 text-foreground hover:border-primary/40"
                      }`}
                    >
                      {filter.label}
                    </button>
                  ))}
                </div>
                <div className="flex flex-col gap-2 sm:flex-row">
                  <input
                    type="text"
                    value={eventSearch}
                    onChange={(event) => setEventSearch(event.target.value)}
                    placeholder="Search event notes, categories, or source..."
                    className="h-10 flex-1 rounded-lg border border-border bg-background px-3 text-sm text-foreground placeholder:text-muted-foreground"
                  />
                  {(eventFilter !== "all" || eventSearch.trim()) && (
                    <button
                      type="button"
                      onClick={() => {
                        setEventFilter("all");
                        setEventSearch("");
                      }}
                      className="inline-flex h-10 items-center justify-center rounded-lg border border-border bg-muted/20 px-4 text-sm font-semibold text-foreground hover:border-primary/40"
                    >
                      Clear focus
                    </button>
                  )}
                </div>
              </div>
            </section>

            <section className="min-w-0 space-y-4">
              {hasTimelineReview ? (
                <>
                  <div className="rounded-xl border border-border bg-card p-4 space-y-3">
                    <div>
                      <h2 className="text-xs font-semibold uppercase tracking-wider text-primary">Timeline Heart Rate Trace</h2>
                      <p className="mt-1 text-sm text-muted-foreground">
                        The active event stays highlighted while the review player moves through the {isExploration ? "body exploration" : "session"}.
                      </p>
                    </div>
                    {timelineRows.length > 0 ? (
                      <HRTimelineChart
                        rows={timelineRows}
                        savedMarkers={{
                          pre_climax_offset_s: selectedSession.pre_climax_offset_s,
                          climax_offset_s: selectedSession.climax_offset_s,
                          recovery_offset_s: selectedSession.recovery_offset_s,
                        }}
                        noClimax={!!selectedSession.no_climax}
                        nearClimaxEvents={reviewNearClimaxEvents}
                        confirmedNearClimaxEvents={confirmedNearClimaxEvents}
                        events={selectedSession.event_timeline || []}
                        selectedEventIndex={selectedEventIdx}
                        onSelectEventIndex={handleSelectEventIndex}
                        initialWindow="full"
                      />
                    ) : (
                      <p className="rounded-lg border border-border bg-muted/25 px-3 py-3 text-sm text-muted-foreground">
                        No imported heart-rate timeline is available for this {isExploration ? "body exploration" : "session"} yet. Event review still works below.
                      </p>
                    )}
                    <SavedMotionSummaryCard
                      summary={selectedSession.motion_analysis_summary}
                      onSeek={videoSrc ? (timeS) => seekVideoTo(timeS, false, true) : undefined}
                      playbackTime={videoTime}
                      chartOnly
                    />
                    <TimelineWaypointDetail
                      waypoint={timelineWaypointDetail?.waypoint}
                      currentHR={timelineWaypointDetail?.currentHR}
                    />
                    {nearbyEvents.length > 0 && (
                      <div className="space-y-2 rounded-lg border border-border bg-muted/20 p-3">
                        <div>
                          <p className="text-[10px] font-semibold uppercase tracking-wider text-primary">Nearby Events</p>
                          <p className="text-xs text-muted-foreground">
                            {nearbyEventsLabel}
                          </p>
                        </div>
                        <div className="space-y-2">
                          {nearbyEvents.map(({ event, index }) => {
                            const categories = normalizeCategoryArray(event.category);
                            return (
                              <button
                                key={`${event.time_s}-${index}`}
                                type="button"
                                onClick={() => handleSelectEventIndex(index)}
                                className="w-full rounded-lg border border-border bg-card/80 px-3 py-2 text-left transition-colors hover:border-primary/40 hover:bg-card"
                              >
                                <div className="flex flex-wrap items-start justify-between gap-2">
                                  <div className="flex flex-wrap items-center gap-1.5">
                                    {categories.map((category) => {
                                      const meta = getCategoryMeta(category);
                                      return (
                                        <span
                                          key={category}
                                          className="rounded-full border px-1.5 py-0.5 text-[9px] font-semibold"
                                          style={{
                                            background: `${meta.color}18`,
                                            borderColor: `${meta.color}44`,
                                            color: meta.color,
                                          }}
                                        >
                                          {meta.label}
                                        </span>
                                      );
                                    })}
                                    {event.source === "motion_derived" && <MotionDerivedBadge event={event} />}
                                  </div>
                                  <div className="flex shrink-0 items-center gap-2 font-mono text-[10px] text-muted-foreground">
                                    <span>{formatTime(event.time_s)}</span>
                                    <span>{describeEventDistance(event.time_s, reviewTime)}</span>
                                  </div>
                                </div>
                                <p className="mt-1.5 line-clamp-3 text-sm leading-relaxed text-foreground">
                                  {event.note || "Event note"}
                                </p>
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    )}
                    {!nearbyEvents.length && (
                      <p className="rounded-lg border border-border bg-muted/25 px-3 py-3 text-sm text-muted-foreground">
                        No event notes match the current review focus.
                      </p>
                    )}
                  </div>

                  <InteractiveTimelinePlayer
                    session={selectedSession}
                    timelineRows={timelineRows}
                    onActiveEventIndexChange={setSelectedEventIdx}
                    onActiveWaypointChange={handleWaypointChange}
                    externalPlaying={videoSrc ? videoPlaying : undefined}
                    externalTime={timelineSyncTime}
                    onPlayingChange={handleTimelinePlayingChange}
                    onTimeChange={handleTimelineTimeChange}
                    onPlaybackRateChange={handleTimelinePlaybackRateChange}
                    continuousPlayback={!!videoSrc}
                  />
                </>
              ) : (
                <div className="rounded-xl border border-border bg-card px-4 py-10 text-sm text-muted-foreground">
                  This {isExploration ? "body exploration" : "session"} does not have event notes, markers, or timeline rows to review yet.
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
