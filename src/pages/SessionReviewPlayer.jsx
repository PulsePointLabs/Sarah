import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Activity, Clapperboard, HeartPulse, Maximize2, ScanSearch, Video, X } from "lucide-react";
import moment from "moment";
import { base44 } from "@/api/base44Client";
import PageHeader from "../components/PageHeader";
import HRTimelineChart from "../components/HRTimelineChart";
import InteractiveTimelinePlayer, { TimelineWaypointDetail } from "../components/InteractiveTimelinePlayer";
import SavedMotionSummaryCard from "../components/SavedMotionSummaryCard";
import { EVENT_CATEGORIES, normalizeCategoryArray } from "../components/session-form/EventTimelineSection";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";

function formatTime(value) {
  const total = Math.max(0, Math.round(Number(value) || 0));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function reviewLabel(session) {
  const date = session?.date ? moment(session.date).format("MMM D, YYYY") : "Undated session";
  const time = session?.start_time ? ` · ${session.start_time}` : "";
  const duration = session?.duration_minutes ? ` · ${session.duration_minutes}m` : "";
  const events = (session?.event_timeline || []).length ? ` · ${session.event_timeline.length} events` : "";
  return `${date}${time}${duration}${events}`;
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
  const requestedSessionId = searchParams.get("session") || "";
  const focusView = searchParams.get("display") === "focus";
  const videoRef = useRef(null);
  const fileInputRef = useRef(null);
  const videoUrlRef = useRef(null);
  const timelineSeekRef = useRef(false);

  const [sessions, setSessions] = useState([]);
  const [selectedId, setSelectedId] = useState("");
  const [selectedSession, setSelectedSession] = useState(null);
  const [timelineRows, setTimelineRows] = useState([]);
  const [loadingSessions, setLoadingSessions] = useState(true);
  const [loadingReview, setLoadingReview] = useState(false);
  const [videoSrc, setVideoSrc] = useState("");
  const [videoName, setVideoName] = useState("");
  const [videoTime, setVideoTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState(0);
  const [videoPlaying, setVideoPlaying] = useState(false);
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

  useEffect(() => {
    base44.entities.Session.list("-date", 250)
      .then((rows) => setSessions(rows))
      .catch(() => setSessions([]))
      .finally(() => setLoadingSessions(false));
  }, []);

  useEffect(() => () => {
    if (videoUrlRef.current) URL.revokeObjectURL(videoUrlRef.current);
  }, []);

  const releaseVideoUrl = () => {
    if (!videoUrlRef.current) return;
    URL.revokeObjectURL(videoUrlRef.current);
    videoUrlRef.current = null;
  };

  const loadVideoFile = (file) => {
    if (!file) return;
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

  const handleSelectSession = useCallback(async (id) => {
    setSelectedId(id);
    setSelectedSession(null);
    setTimelineRows([]);
    setSelectedEventIdx(null);
    setTimelineWaypointDetail(null);
    if (!id) return;

    setLoadingReview(true);
    try {
      const [sessionRows, rows] = await Promise.all([
        base44.entities.Session.filter({ id }),
        base44.entities.HeartRateTimeline.filter({ session: id }, "time_offset_s", 10000),
      ]);
      setSelectedSession(sessionRows[0] || null);
      setTimelineRows(rows);
    } finally {
      setLoadingReview(false);
    }
  }, []);

  useEffect(() => {
    if (!requestedSessionId || loadingSessions || selectedId || !sessions.some((session) => session.id === requestedSessionId)) return;
    handleSelectSession(requestedSessionId);
  }, [handleSelectSession, loadingSessions, requestedSessionId, selectedId, sessions]);

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
      if (selectedId) next.set("session", selectedId);
    }
    else next.delete("display");
    setSearchParams(next);
  };

  if (focusView && selectedSession && !loadingReview) {
    const motion = savedMotion;
    const rhythm = motion?.hand_movement_summary;
    const currentLeft = playbackMotion?.left_lower_body_activity;
    const currentRight = playbackMotion?.right_lower_body_activity;
    const currentTotal = Number(currentLeft || 0) + Number(currentRight || 0);
    const currentIndex = currentTotal > 0 ? (Number(currentLeft || 0) - Number(currentRight || 0)) / currentTotal : null;
    const sideBalance = currentIndex != null
      ? (Math.abs(currentIndex) <= 0.1 ? "Similar now" : `${currentIndex > 0 ? "Left" : "Right"} now`)
      : null;
    const lowerBodyPatterns = motion?.lower_body_pattern_summary;
    const postureSummary = motion?.lower_body_posture_summary;
    const currentPattern = activeLowerBodyPattern(motion, reviewTime);
    const currentPosture = activePostureCandidate(motion, reviewTime);
    const reviewPatterns = lowerBodyPatternCandidates(motion)
      .filter((candidate) => ["oscillatory_candidate", "left_right_divergence"].includes(candidate.type))
      .slice(0, 6);

    return (
      <div className="h-screen overflow-hidden bg-background p-3">
        <div className="flex h-full min-h-0 flex-col gap-3">
          <header className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-border bg-card px-4 py-3">
            <div className="min-w-0">
              <p className="text-xs font-semibold uppercase tracking-wider text-primary">Evidence Review Display</p>
              <p className="truncate text-sm text-foreground">{reviewLabel(selectedSession)}{videoName ? ` · ${videoName}` : ""}</p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => fileInputRef.current?.click()}
                className="inline-flex items-center gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs font-medium text-foreground hover:border-primary/40"
              >
                <Video className="h-4 w-4 text-primary" />
                {videoSrc ? "Change Video" : "Load Video"}
              </button>
              <button
                type="button"
                onClick={() => setFocusView(false)}
                className="inline-flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/10 px-3 py-2 text-xs font-semibold text-primary"
              >
                <X className="h-4 w-4" />
                Exit Display View
              </button>
              <input ref={fileInputRef} type="file" accept="video/*" className="hidden" onChange={handleVideoChange} />
            </div>
          </header>

          <div className="grid min-h-0 flex-1 gap-3 xl:grid-cols-[minmax(0,1fr)_22rem]">
            <section className="grid min-h-0 grid-rows-[auto_minmax(0,1fr)] gap-3">
              <div className="grid gap-3 2xl:grid-cols-2">
                <div className="rounded-xl border border-border bg-card p-3">
                  <div className="mb-2 flex items-center gap-2">
                    <HeartPulse className="h-4 w-4 text-primary" />
                    <p className="text-xs font-semibold uppercase tracking-wider text-primary">Heart Rate Trace</p>
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
                      nearClimaxEvents={selectedSession.ai_near_climax_events || []}
                      events={selectedSession.event_timeline || []}
                      selectedEventIndex={selectedEventIdx}
                      onSelectEventIndex={handleSelectEventIndex}
                      initialWindow="full"
                      compact
                      playbackTime={videoTime}
                    />
                  ) : (
                    <p className="px-3 py-8 text-sm text-muted-foreground">No heart-rate trace available for this session.</p>
                  )}
                </div>
                {motion ? (
                  <SavedMotionSummaryCard
                    summary={motion}
                    onSeek={videoSrc ? (timeS) => seekVideoTo(timeS, false, true) : undefined}
                    playbackTime={videoTime}
                    chartOnly
                    focus
                  />
                ) : (
                  <div className="rounded-xl border border-border bg-card p-3">
                    <div className="mb-2 flex items-center gap-2">
                      <Activity className="h-4 w-4 text-primary" />
                      <p className="text-xs font-semibold uppercase tracking-wider text-primary">Motion Trace</p>
                    </div>
                    <p className="px-3 py-8 text-sm text-muted-foreground">Save a local motion summary to show movement telemetry here.</p>
                  </div>
                )}
              </div>

              <div className="flex min-h-0 flex-col overflow-hidden rounded-xl border border-border bg-card">
                {currentReviewEvent && (
                  <button
                    type="button"
                    onClick={() => handleSelectEventIndex(currentReviewEvent.index)}
                    className="flex flex-wrap items-center justify-between gap-3 border-b border-primary/20 bg-primary/[0.07] px-4 py-2 text-left"
                  >
                    <div className="min-w-0">
                      <div className="flex flex-wrap items-center gap-1.5">
                        <span className="text-[10px] font-semibold uppercase tracking-wider text-primary">Current Event</span>
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
                      <p className="truncate text-sm text-foreground">{currentReviewEvent.event.note || "Event note"}</p>
                    </div>
                    <span className="font-mono text-sm font-semibold text-primary">{formatTime(currentReviewEvent.event.time_s)}</span>
                  </button>
                )}
                <div className="flex min-h-0 flex-1 items-center justify-center bg-black">
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
                      onLoadedMetadata={(event) => setVideoDuration(event.currentTarget.duration || 0)}
                    />
                  ) : (
                    <button type="button" onClick={() => fileInputRef.current?.click()} className="flex flex-col items-center gap-3 text-muted-foreground hover:text-primary">
                      <Video className="h-10 w-10" />
                      <span className="text-sm font-semibold">Load the full session video</span>
                    </button>
                  )}
                </div>
              </div>
            </section>

            <aside className="min-h-0 space-y-3 overflow-y-auto pr-1">
              <div className="rounded-xl border border-border bg-card p-3 space-y-3">
                <p className="text-xs font-semibold uppercase tracking-wider text-primary">Current Telemetry</p>
                <div className="grid grid-cols-2 gap-2">
                  <FocusMetric label="Position" value={formatTime(reviewTime)} accent="text-primary" />
                  <FocusMetric label="Heart Rate" value={playbackHR ?? "--"} suffix={playbackHR != null ? " bpm" : ""} accent="text-destructive" />
                </div>
                <label className="inline-flex items-center gap-2 text-xs font-medium text-foreground">
                  <input type="checkbox" checked={followTimeline} onChange={(event) => setFollowTimeline(event.target.checked)} className="h-3.5 w-3.5 accent-primary" />
                  Follow telemetry while the video plays
                </label>
              </div>

              <div className="rounded-xl border border-border bg-card p-3 space-y-3">
                <p className="text-xs font-semibold uppercase tracking-wider text-primary">Movement At Playback Position</p>
                {motion ? (
                  <>
                    <div className="grid grid-cols-2 gap-2">
                      <FocusMetric label="Left Foot / Leg Now" value={currentLeft ?? "--"} accent="text-primary" />
                      <FocusMetric label="Right Foot / Leg Now" value={currentRight ?? "--"} accent="text-amber-400" />
                      <FocusMetric label="Balance Now" value={sideBalance ?? "--"} />
                      <FocusMetric label="Index Now" value={currentIndex == null ? "--" : currentIndex.toFixed(2)} />
                    </div>
                    <div className="space-y-2 rounded-lg border border-border bg-muted/15 p-2.5">
                      <ActivityBar label="Left foot / leg activity now" value={currentLeft} color="hsl(var(--primary))" />
                      <ActivityBar label="Right foot / leg activity now" value={currentRight} color="#f59e0b" />
                    </div>
                    <p className="text-[11px] leading-relaxed text-muted-foreground">
                      Playback-time value from the saved motion trace. Session averages: left {motion.left_lower_body_average_activity ?? "-"} / right {motion.right_lower_body_average_activity ?? "-"}. Side comparison is observational and reflects the saved region assignments.
                    </p>
                    {currentPattern && (
                      <div className="rounded-lg border border-primary/25 bg-primary/[0.08] px-2.5 py-2">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-primary">Current Review Candidate</p>
                        <p className="mt-1 text-xs font-medium text-foreground">{currentPattern.label}</p>
                        <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">Visual motion proxy only; review the video before describing this as a specific movement or spasm.</p>
                      </div>
                    )}
                    {currentPosture && (
                      <div className="rounded-lg border border-primary/25 bg-primary/[0.08] px-2.5 py-2">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-primary">Calibrated Posture Candidate</p>
                        <p className="mt-1 text-xs font-medium text-foreground">{currentPosture.posture_phrase}</p>
                        <p className="mt-1 text-[10px] leading-relaxed text-muted-foreground">Matched against foot-region appearance at a reference moment you marked in the recording; this is a visual posture proxy only.</p>
                      </div>
                    )}
                  </>
                ) : (
                  <p className="text-xs text-muted-foreground">No saved motion summary yet.</p>
                )}
              </div>

              {lowerBodyPatterns && (
                <div className="rounded-xl border border-primary/20 bg-primary/[0.04] p-3 space-y-3">
                  <p className="text-xs font-semibold uppercase tracking-wider text-primary">Lower-Body Pattern Review</p>
                  <div className="grid grid-cols-2 gap-2">
                    <FocusMetric label="Movement Bursts" value={lowerBodyPatterns.movement_burst_count} />
                    <FocusMetric label="Oscillatory / Shudder-Like" value={lowerBodyPatterns.oscillatory_candidate_count} />
                    <FocusMetric label="Sustained Elevations" value={lowerBodyPatterns.sustained_activity_shift_count} />
                    <FocusMetric label="Side Divergences" value={lowerBodyPatterns.left_right_divergence_count} />
                  </div>
                  {reviewPatterns.length > 0 && (
                    <div className="space-y-1.5">
                      {reviewPatterns.map((candidate) => (
                        <button
                          key={`${candidate.type}-${candidate.time_s}`}
                          type="button"
                          onClick={() => seekVideoTo(candidate.time_s, false, true)}
                          disabled={!videoSrc}
                          className="flex w-full items-center justify-between gap-2 rounded-lg border border-border bg-card/60 px-2.5 py-2 text-left enabled:hover:border-primary/40 disabled:cursor-default"
                        >
                          <span className="line-clamp-1 text-[11px] text-foreground">{candidate.label}</span>
                          <span className="shrink-0 font-mono text-[11px] font-semibold text-primary">{formatTime(candidate.time_s)}</span>
                        </button>
                      ))}
                    </div>
                  )}
                  <p className="text-[10px] leading-relaxed text-muted-foreground">
                    These flags are activity-pattern proxies only. Directional posture changes such as feet moving outward are not measured in this version.
                  </p>
                </div>
              )}

              {postureSummary && postureCandidates(motion).length > 0 && (
                <div className="rounded-xl border border-primary/20 bg-primary/[0.04] p-3 space-y-3">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs font-semibold uppercase tracking-wider text-primary">Calibrated Foot Appearance Moments</p>
                    <span className="text-[10px] text-muted-foreground">{postureSummary.coverage_pct}% coverage</span>
                  </div>
                  <div className="space-y-1.5">
                    {postureCandidates(motion).slice(0, 8).map((candidate) => (
                      <button
                        key={`${candidate.posture}-${candidate.time_s}`}
                        type="button"
                        onClick={() => seekVideoTo(candidate.time_s, false, true)}
                        disabled={!videoSrc}
                        className="flex w-full items-center justify-between gap-2 rounded-lg border border-border bg-card/60 px-2.5 py-2 text-left enabled:hover:border-primary/40 disabled:cursor-default"
                      >
                        <span className="line-clamp-1 text-[11px] text-foreground">{candidate.posture_phrase}</span>
                        <span className="shrink-0 font-mono text-[11px] font-semibold text-primary">{formatTime(candidate.time_s)}</span>
                      </button>
                    ))}
                  </div>
                  <p className="text-[10px] leading-relaxed text-muted-foreground">
                    These moments compare visible foot-region appearance to your marked examples. They do not measure pressure, force, or physiological cause.
                  </p>
                </div>
              )}

              {(rhythm?.reliability === "moderate" || playbackMotion?.hand_activity != null) && (
                <div className="rounded-xl border border-[#a78bfa]/30 bg-[#a78bfa]/[0.07] p-3 space-y-3">
                  <p className="text-xs font-semibold uppercase tracking-wider text-[#a78bfa]">Hand Movement At Playback Position</p>
                  <div className="grid grid-cols-2 gap-2">
                    <FocusMetric label="Hand Activity Now" value={playbackMotion?.hand_activity ?? "--"} accent="text-[#a78bfa]" />
                    <FocusMetric
                      label="Rolling Cadence Proxy"
                      value={playbackCadence?.movement_cycles_per_minute_estimate ?? "--"}
                      suffix={playbackCadence?.movement_cycles_per_minute_estimate != null ? " cycles/min" : ""}
                      accent="text-[#a78bfa]"
                    />
                    <FocusMetric label="Session Cadence Proxy" value={rhythm?.movement_cycles_per_minute_estimate ?? "--"} suffix={rhythm?.movement_cycles_per_minute_estimate != null ? " cycles/min" : ""} />
                    <FocusMetric label="Pauses 2s+ (Session)" value={rhythm?.pause_count ?? "--"} />
                  </div>
                  {!Array.isArray(motion.hand_cadence_timeline) && (
                    <p className="rounded-lg border border-[#a78bfa]/20 bg-background/25 px-2.5 py-2 text-[11px] leading-relaxed text-muted-foreground">
                      This saved analysis predates rolling cadence storage. Re-run motion analysis and save the summary to show a playback-time cadence proxy here.
                    </p>
                  )}
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    Playback-time hand activity is read from the saved motion trace. Rolling cadence is derived from visible hand-movement rhythm in a local time window; it is not confirmed stroke technique, force, or physiological state.
                  </p>
                </div>
              )}

              {nearbyEvents.length > 0 && (
                <div className="rounded-xl border border-border bg-card p-3 space-y-2">
                  <p className="text-xs font-semibold uppercase tracking-wider text-primary">Nearby Events</p>
                  {nearbyEvents.map(({ event, index }) => (
                    <button key={`${event.time_s}-${index}`} type="button" onClick={() => handleSelectEventIndex(index)} className="block w-full rounded-lg border border-border bg-muted/15 px-2.5 py-2 text-left hover:border-primary/40">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-mono text-[11px] font-semibold text-primary">{formatTime(event.time_s)}</span>
                        {event.source === "motion_derived" && <MotionDerivedBadge event={event} />}
                      </div>
                      <p className="mt-1 line-clamp-2 text-xs text-foreground">{event.note}</p>
                    </button>
                  ))}
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
        title="Session Review Player"
        subtitle="Review a full video with the heart-rate trace, event markers, and nearby observations moving with playback."
      />

      <div className="px-4 pb-8 space-y-4">
        <div className="rounded-xl border border-border bg-card p-4 space-y-3">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-xs font-semibold uppercase tracking-wider text-primary">Review Source</p>
              <p className="mt-1 text-sm text-muted-foreground">
                Choose the session first, then load the full local recording for timeline-guided review.
              </p>
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
                Display View
              </button>
            )}
            <input ref={fileInputRef} type="file" accept="video/*" className="hidden" onChange={handleVideoChange} />
          </div>

          {loadingSessions ? (
            <div className="flex h-11 items-center text-sm text-muted-foreground">Loading sessions...</div>
          ) : (
            <Select value={selectedId} onValueChange={handleSelectSession}>
              <SelectTrigger className="h-11">
                <SelectValue placeholder="Choose a session to review..." />
              </SelectTrigger>
              <SelectContent>
                {sessions.map((session) => (
                  <SelectItem key={session.id} value={session.id}>
                    {reviewLabel(session)}
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
                This local preview supports motion analysis without attaching the recording to a stored session.
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
            <Link
              to={`/motion-lab${selectedSession?.id ? `?session=${encodeURIComponent(selectedSession.id)}` : ""}`}
              className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground hover:bg-primary/90"
            >
              Open Motion Lab
            </Link>
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
            Select a session to open its timeline review.
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
                    <span className="text-sm font-semibold">Load the full session video</span>
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
                        The active event stays highlighted while the review player moves through the session.
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
                        nearClimaxEvents={selectedSession.ai_near_climax_events || []}
                        events={selectedSession.event_timeline || []}
                        selectedEventIndex={selectedEventIdx}
                        onSelectEventIndex={handleSelectEventIndex}
                        initialWindow="full"
                      />
                    ) : (
                      <p className="rounded-lg border border-border bg-muted/25 px-3 py-3 text-sm text-muted-foreground">
                        No imported heart-rate timeline is available for this session yet. Event review still works below.
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
                  This session does not have event notes, markers, or timeline rows to review yet.
                </div>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  );
}
