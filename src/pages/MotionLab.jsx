import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { ArrowRight, ListPlus, Maximize2, Minimize2, Play, ShieldCheck, Trash2, Video } from "lucide-react";
import moment from "moment";
import { base44 } from "@/api/base44Client";
import PageHeader from "../components/PageHeader";
import LocalMotionAnalysisPanel from "../components/LocalMotionAnalysisPanel";
import SavedMotionSummaryCard from "../components/SavedMotionSummaryCard";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { getMotionEvidenceSummary } from "@/utils/sessionMotionEvidence";

const FEED_ROLES = [
  { value: "composite", label: "Composite / Picture-in-Picture" },
  { value: "lower_body", label: "Feet / Lower Body Camera" },
  { value: "main", label: "Main Focus Camera" },
  { value: "lateral", label: "Lateral Angle" },
];
const MOTION_LAB_PREVIEW_PREFERENCES_KEY = "pulsepoint.motionLab.previewPreferences.v1";
const DEFAULT_FLOATING_PREVIEW_WIDTH = 608;
const DEFAULT_FLOATING_PREVIEW_POSITION = { x: 16, y: 64 };

function clampFloatingPreviewWidth(value) {
  const viewportMax = typeof window === "undefined" ? DEFAULT_FLOATING_PREVIEW_WIDTH : Math.max(320, window.innerWidth - 32);
  const parsed = Number(value);
  return Math.min(viewportMax, Math.max(320, Number.isFinite(parsed) ? parsed : DEFAULT_FLOATING_PREVIEW_WIDTH));
}

function clampFloatingPreviewPosition(position, width = DEFAULT_FLOATING_PREVIEW_WIDTH, height = 220) {
  if (typeof window === "undefined") return DEFAULT_FLOATING_PREVIEW_POSITION;
  const x = Number(position?.x);
  const y = Number(position?.y);
  const maxX = Math.max(8, window.innerWidth - clampFloatingPreviewWidth(width) - 8);
  const maxY = Math.max(8, window.innerHeight - Math.max(100, Number(height) || 220) - 8);
  return {
    x: Math.min(maxX, Math.max(8, Number.isFinite(x) ? x : DEFAULT_FLOATING_PREVIEW_POSITION.x)),
    y: Math.min(maxY, Math.max(8, Number.isFinite(y) ? y : DEFAULT_FLOATING_PREVIEW_POSITION.y)),
  };
}

function readPreviewPreferences() {
  if (typeof window === "undefined") {
    return { floating: false, width: DEFAULT_FLOATING_PREVIEW_WIDTH, position: DEFAULT_FLOATING_PREVIEW_POSITION };
  }
  try {
    const parsed = JSON.parse(window.localStorage.getItem(MOTION_LAB_PREVIEW_PREFERENCES_KEY) || "{}");
    const width = clampFloatingPreviewWidth(parsed.width);
    return {
      floating: parsed.floating === true,
      width,
      position: clampFloatingPreviewPosition(parsed.position, width),
    };
  } catch {
    return { floating: false, width: DEFAULT_FLOATING_PREVIEW_WIDTH, position: DEFAULT_FLOATING_PREVIEW_POSITION };
  }
}

function labelForSession(session) {
  return `${moment(session.date).format("MMM D, YYYY")}${session.start_time ? ` · ${session.start_time}` : ""}${session.duration_minutes ? ` · ${session.duration_minutes}m` : ""}`;
}

function feedLabel(role) {
  return FEED_ROLES.find((feed) => feed.value === role)?.label || role;
}

function nearestTimelinePoint(points, timeS, toleranceS = 0.3) {
  if (!Array.isArray(points) || !points.length) return null;
  const nearest = points.reduce((closest, point) => (
    Math.abs(Number(point.time_s) - timeS) < Math.abs(Number(closest.time_s) - timeS) ? point : closest
  ), points[0]);
  return Math.abs(Number(nearest.time_s) - timeS) <= toleranceS ? nearest : null;
}

function combineDerivedTimelines(lowerSummary, handSummary) {
  const lowerTimeline = Array.isArray(lowerSummary?.derived_timeline) ? lowerSummary.derived_timeline : [];
  const handTimeline = Array.isArray(handSummary?.derived_timeline) ? handSummary.derived_timeline : [];
  const basis = lowerTimeline.length ? lowerTimeline : handTimeline;
  if (!basis.length) return [];
  return basis.map((point) => {
    const timeS = Number(point.time_s) || 0;
    const lower = lowerTimeline.length ? nearestTimelinePoint(lowerTimeline, timeS) : null;
    const hand = handTimeline.length ? nearestTimelinePoint(handTimeline, timeS) : null;
    return {
      time_s: point.time_s,
      activity: lower?.activity ?? hand?.activity,
      left_lower_body_activity: lower?.left_lower_body_activity,
      right_lower_body_activity: lower?.right_lower_body_activity,
      left_forefoot_activity: lower?.left_forefoot_activity,
      right_forefoot_activity: lower?.right_forefoot_activity,
      hand_activity: hand?.hand_activity ?? hand?.activity,
      region_segment_id: lower?.region_segment_id || hand?.region_segment_id,
      region_segment_label: lower?.region_segment_label || hand?.region_segment_label,
      region_segment_boundary: lower?.region_segment_boundary || hand?.region_segment_boundary,
    };
  });
}

function combineFeedSummaries(feedSummaries) {
  const entries = Object.entries(feedSummaries || {}).filter(([, summary]) => summary && typeof summary === "object");
  if (!entries.length) return null;
  if (entries.length === 1 && entries[0][0] === "composite") return entries[0][1];

  const summaries = Object.fromEntries(entries);
  const lower = summaries.lower_body || summaries.composite || summaries.lateral || summaries.main;
  const hand = summaries.main || summaries.composite || summaries.lateral || summaries.lower_body;
  const lowerRole = entries.find(([, summary]) => summary === lower)?.[0];
  const handRole = entries.find(([, summary]) => summary === hand)?.[0];
  const latest = entries
    .map(([, summary]) => summary)
    .sort((first, second) => new Date(second.analyzed_at || 0) - new Date(first.analyzed_at || 0))[0];
  const findings = entries.flatMap(([role, summary]) => (
    (Array.isArray(summary.findings) ? summary.findings : []).map((finding) => `${feedLabel(role)}: ${finding}`)
  ));
  const reviewPeaks = entries.flatMap(([role, summary]) => (
    (Array.isArray(summary.review_peaks) ? summary.review_peaks : []).map((peak) => ({ ...peak, feed_role: role }))
  )).sort((first, second) => Number(first.time_s) - Number(second.time_s));

  return {
    ...latest,
    source: "local_mediapipe_multi_feed_review",
    analyzed_at: new Date().toISOString(),
    feed_summaries: summaries,
    analyzed_feeds: entries.map(([role]) => role),
    feed_summary_note: "Each local video feed was configured and analyzed independently. Combined values align derived signals by session playback time; compare only supported channels from each feed.",
    lower_body_source_feed: lowerRole,
    hand_source_feed: handRole,
    lower_body_tracking_method: lower?.lower_body_tracking_method,
    left_right_orientation: lower?.left_right_orientation,
    forefoot_enabled: lower?.forefoot_enabled,
    roi_configuration: lower?.roi_configuration,
    region_segments: lower?.region_segments,
    region_segment_summary: lower?.region_segment_summary,
    posture_reference_times_s: lower?.posture_reference_times_s,
    left_lower_body_coverage_pct: lower?.left_lower_body_coverage_pct,
    right_lower_body_coverage_pct: lower?.right_lower_body_coverage_pct,
    asymmetry_summary: lower?.asymmetry_summary,
    lower_body_pattern_summary: lower?.lower_body_pattern_summary,
    lower_body_posture_summary: lower?.lower_body_posture_summary,
    left_lower_body_average_activity: lower?.left_lower_body_average_activity,
    right_lower_body_average_activity: lower?.right_lower_body_average_activity,
    left_forefoot_average_activity: lower?.left_forefoot_average_activity,
    right_forefoot_average_activity: lower?.right_forefoot_average_activity,
    hand_coverage_pct: hand?.hand_coverage_pct,
    hand_average_activity: hand?.hand_average_activity,
    hand_movement_summary: hand?.hand_movement_summary,
    hand_behavior_summary: hand?.hand_behavior_summary,
    hand_behavior_reference_times_s: hand?.hand_behavior_reference_times_s,
    hand_cadence_timeline: hand?.hand_cadence_timeline,
    quality_indicators: {
      left_lower_body: lower?.quality_indicators?.left_lower_body,
      right_lower_body: lower?.quality_indicators?.right_lower_body,
      hands: hand?.quality_indicators?.hands,
    },
    findings,
    review_peaks: reviewPeaks,
    derived_timeline: combineDerivedTimelines(lower, hand),
    multi_feed_guardrail: "Signals were derived from separate local camera feeds. Do not interpret differences caused by framing, sync drift, or feed-specific visibility as physiology without direct video confirmation.",
  };
}

export default function MotionLab() {
  const [searchParams] = useSearchParams();
  const requestedSessionId = searchParams.get("session") || "";
  const videoRef = useRef(null);
  const feedWorkspacesRef = useRef({});
  const fileInputRef = useRef(null);
  const previewRef = useRef(null);
  const [sessions, setSessions] = useState([]);
  const [selectedId, setSelectedId] = useState("");
  const [selectedSession, setSelectedSession] = useState(null);
  const [feedRole, setFeedRole] = useState("composite");
  const [feedWorkspaces, setFeedWorkspaces] = useState({});
  const [feedSummaries, setFeedSummaries] = useState({});
  const [feedFinalizedEvents, setFeedFinalizedEvents] = useState({});
  const [queue, setQueue] = useState([]);
  const [loading, setLoading] = useState(true);
  const [previewFloating, setPreviewFloating] = useState(() => readPreviewPreferences().floating);
  const [floatingPreviewWidth, setFloatingPreviewWidth] = useState(() => readPreviewPreferences().width);
  const [floatingPreviewPosition, setFloatingPreviewPosition] = useState(() => readPreviewPreferences().position);

  useEffect(() => {
    try {
      window.localStorage.setItem(MOTION_LAB_PREVIEW_PREFERENCES_KEY, JSON.stringify({
        floating: previewFloating,
        width: clampFloatingPreviewWidth(floatingPreviewWidth),
        position: floatingPreviewPosition,
      }));
    } catch {
      // UI preferences are optional; storage restrictions should not block analysis.
    }
  }, [floatingPreviewPosition, floatingPreviewWidth, previewFloating]);

  useEffect(() => {
    const clampAfterResize = () => {
      setFloatingPreviewWidth((current) => clampFloatingPreviewWidth(current));
      setFloatingPreviewPosition((current) => clampFloatingPreviewPosition(
        current,
        floatingPreviewWidth,
        previewRef.current?.getBoundingClientRect().height,
      ));
    };
    window.addEventListener("resize", clampAfterResize);
    return () => window.removeEventListener("resize", clampAfterResize);
  }, [floatingPreviewWidth]);

  useEffect(() => {
    if (!previewFloating) return;
    setFloatingPreviewPosition((current) => clampFloatingPreviewPosition(
      current,
      floatingPreviewWidth,
      previewRef.current?.getBoundingClientRect().height,
    ));
  }, [floatingPreviewWidth, previewFloating]);

  useEffect(() => {
    base44.entities.Session.list("-date", 300)
      .then((rows) => {
        setSessions(rows);
        if (requestedSessionId && rows.some((session) => session.id === requestedSessionId)) {
          setSelectedId(requestedSessionId);
          setSelectedSession(rows.find((session) => session.id === requestedSessionId));
        }
      })
      .finally(() => setLoading(false));
  }, [requestedSessionId]);

  const selectSession = (id) => {
    if (id !== selectedId) {
      setFeedWorkspaces((current) => {
        Object.values(current).forEach((workspace) => {
          if (workspace.videoSrc) URL.revokeObjectURL(workspace.videoSrc);
        });
        return {};
      });
      setFeedSummaries({});
      setFeedFinalizedEvents({});
      setQueue([]);
    }
    setSelectedId(id);
    setSelectedSession(sessions.find((session) => session.id === id) || null);
  };

  useEffect(() => {
    feedWorkspacesRef.current = feedWorkspaces;
  }, [feedWorkspaces]);

  useEffect(() => () => {
    Object.values(feedWorkspacesRef.current).forEach((workspace) => {
      if (workspace.videoSrc) URL.revokeObjectURL(workspace.videoSrc);
    });
  }, []);

  const loadVideo = useCallback((file, role = feedRole) => {
    if (!file) return;
    const source = URL.createObjectURL(file);
    setFeedWorkspaces((current) => {
      if (current[role]?.videoSrc) URL.revokeObjectURL(current[role].videoSrc);
      return {
        ...current,
        [role]: {
          ...(current[role] || {}),
          videoFile: file,
          videoSrc: source,
          videoName: file.name,
          videoTime: 0,
          videoDuration: 0,
          videoPlaying: false,
          status: "Configured",
        },
      };
    });
  }, [feedRole]);

  const activeFeed = feedWorkspaces[feedRole] || {};
  const videoSrc = activeFeed.videoSrc || "";
  const videoName = activeFeed.videoName || "";
  const videoFile = activeFeed.videoFile || null;
  const videoTime = activeFeed.videoTime || 0;
  const videoDuration = activeFeed.videoDuration || 0;
  const videoPlaying = activeFeed.videoPlaying || false;

  const updateFeedWorkspace = (role, patch) => {
    setFeedWorkspaces((current) => ({
      ...current,
      [role]: { ...(current[role] || {}), ...patch },
    }));
  };

  const addToQueue = () => {
    if (!selectedSession || !videoFile) return;
    setQueue((existing) => {
      const nextItem = {
        id: existing.find((item) => item.sessionId === selectedSession.id && item.feedRole === feedRole)?.id || `${Date.now()}-${existing.length}`,
        sessionId: selectedSession.id,
        sessionLabel: labelForSession(selectedSession),
        feedRole,
        videoFile,
        videoName,
        status: feedSummaries[feedRole] ? "Completed" : "Ready",
      };
      const withoutRole = existing.filter((item) => !(item.sessionId === selectedSession.id && item.feedRole === feedRole));
      return [...withoutRole, nextItem];
    });
  };

  const activateQueueItem = (item) => {
    selectSession(item.sessionId);
    setFeedRole(item.feedRole);
    if (!feedWorkspaces[item.feedRole]?.videoSrc && item.videoFile) loadVideo(item.videoFile, item.feedRole);
  };

  const updateSessionEverywhere = (nextSession) => {
    setSelectedSession(nextSession);
    setSessions((current) => current.map((session) => session.id === nextSession.id ? { ...session, ...nextSession } : session));
  };

  const tagFeedEvents = (role, events) => (Array.isArray(events) ? events : []).map((event) => ({
    ...event,
    motion_evidence: {
      ...(event.motion_evidence || {}),
      feed_role: role,
      feed_label: feedLabel(role),
    },
  }));

  const saveSummary = async (role, summary, finalizedMotionEvents = []) => {
    if (!selectedSession?.id) throw new Error("Choose a target session before saving derived motion evidence.");
    const previouslySavedFeedSummaries = selectedSession.motion_analysis_summary?.feed_summaries || {};
    const nextSummaries = { ...previouslySavedFeedSummaries, ...feedSummaries, [role]: summary };
    const nextFinalizedEvents = { ...feedFinalizedEvents, [role]: tagFeedEvents(role, finalizedMotionEvents) };
    const combinedSummary = combineFeedSummaries(nextSummaries);
    const nonMotionEvents = (selectedSession.event_timeline || []).filter((event) => event.source !== "motion_derived");
    const finalizedRoles = new Set(Object.keys(nextFinalizedEvents));
    const retainedOtherFeedEvents = (selectedSession.event_timeline || []).filter((event) => (
      event.source === "motion_derived"
      && event.motion_evidence?.feed_role
      && !finalizedRoles.has(event.motion_evidence.feed_role)
    ));
    const eventTimeline = [...nonMotionEvents, ...retainedOtherFeedEvents, ...Object.values(nextFinalizedEvents).flat()]
      .sort((a, b) => Number(a.time_s) - Number(b.time_s));
    const updated = await base44.entities.Session.update(selectedSession.id, {
      motion_analysis_summary: combinedSummary,
      event_timeline: eventTimeline,
    });
    setFeedSummaries(nextSummaries);
    setFeedFinalizedEvents(nextFinalizedEvents);
    updateFeedWorkspace(role, { status: "Completed" });
    updateSessionEverywhere({ ...updated, motion_analysis_summary: combinedSummary, event_timeline: eventTimeline });
    setQueue((current) => current.map((item) => item.sessionId === selectedSession.id && item.feedRole === role
      ? { ...item, status: "Completed" }
      : item));
  };

  const acceptSuggestions = async (role, suggestedEvents) => {
    if (!selectedSession?.id) throw new Error("Choose a target session before promoting observations.");
    const existing = selectedSession.event_timeline || [];
    const additions = tagFeedEvents(role, suggestedEvents).filter((candidate) => (
      !existing.some((event) => (
        event.source === "motion_derived"
        && event.motion_evidence?.suggestion_type === candidate.motion_evidence?.suggestion_type
        && event.motion_evidence?.feed_role === role
        && Math.abs(Number(event.time_s) - Number(candidate.time_s)) <= 0.75
      ))
    ));
    if (!additions.length) return selectedSession;
    const eventTimeline = [...existing, ...additions].sort((a, b) => Number(a.time_s) - Number(b.time_s));
    const updated = await base44.entities.Session.update(selectedSession.id, { event_timeline: eventTimeline });
    const nextSession = { ...updated, event_timeline: eventTimeline };
    updateSessionEverywhere(nextSession);
    return nextSession;
  };

  const seek = (timeS) => {
    if (!videoRef.current) return;
    videoRef.current.currentTime = Number(timeS) || 0;
    updateFeedWorkspace(feedRole, { videoTime: Number(timeS) || 0 });
  };

  const beginFloatingResize = (event) => {
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const startX = event.clientX;
    const startWidth = floatingPreviewWidth;
    const onPointerMove = (moveEvent) => {
      const nextWidth = clampFloatingPreviewWidth(startWidth + moveEvent.clientX - startX);
      setFloatingPreviewWidth(nextWidth);
      setFloatingPreviewPosition((current) => clampFloatingPreviewPosition(
        current,
        nextWidth,
        previewRef.current?.getBoundingClientRect().height,
      ));
    };
    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };

  const beginFloatingDrag = (event) => {
    if (!previewFloating) return;
    event.preventDefault();
    event.currentTarget.setPointerCapture?.(event.pointerId);
    const startX = event.clientX;
    const startY = event.clientY;
    const startPosition = floatingPreviewPosition;
    const onPointerMove = (moveEvent) => {
      setFloatingPreviewPosition(clampFloatingPreviewPosition({
        x: startPosition.x + moveEvent.clientX - startX,
        y: startPosition.y + moveEvent.clientY - startY,
      }, floatingPreviewWidth, previewRef.current?.getBoundingClientRect().height));
    };
    const onPointerUp = () => {
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("pointerup", onPointerUp);
    };
    window.addEventListener("pointermove", onPointerMove);
    window.addEventListener("pointerup", onPointerUp);
  };

  const evidence = getMotionEvidenceSummary(selectedSession);
  const configuredRoles = FEED_ROLES.filter((role) => role.value === feedRole || feedWorkspaces[role.value]?.videoSrc);

  const rightRailHeader = (
    <div className="space-y-1.5">
      {/* MOTION_LAB_RIGHT_RAIL_COMPOSED_STACK_V1 */}
      {videoSrc ? (
        <div
          ref={previewRef}
          className={`rounded-xl border border-border bg-card p-2.5 space-y-2 ${
          previewFloating
            ? "fixed z-[60] min-w-[20rem] max-w-[calc(100vw-2rem)] border-primary/35 shadow-2xl"
            : ""
          }`}
          style={previewFloating ? {
            width: `min(${floatingPreviewWidth}px, calc(100vw - 2rem))`,
            left: `${floatingPreviewPosition.x}px`,
            top: `${floatingPreviewPosition.y}px`,
          } : undefined}
        >
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div
              onPointerDown={beginFloatingDrag}
              className={`${previewFloating ? "touch-none cursor-move select-none rounded-md border border-transparent px-1.5 py-1 hover:border-primary/20 hover:bg-primary/[0.05]" : ""}`}
              title={previewFloating ? "Drag to move preview" : undefined}
            >
              <p className="text-xs font-semibold uppercase tracking-wider text-primary">Local Processing Preview</p>
              {previewFloating && <p className="text-[9px] text-muted-foreground">Drag to move</p>}
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setPreviewFloating((floating) => !floating)}
                className="inline-flex items-center gap-1.5 rounded-md border border-primary/25 bg-primary/[0.06] px-2.5 py-1.5 text-xs font-medium text-primary hover:border-primary/45 hover:bg-primary/10"
              >
                {previewFloating ? <Minimize2 className="h-3.5 w-3.5" /> : <Maximize2 className="h-3.5 w-3.5" />}
                {previewFloating ? "Dock preview" : "Float preview"}
              </button>
              {selectedSession && (
                <Link to={`/review-player?session=${encodeURIComponent(selectedSession.id)}`} className="inline-flex items-center gap-1 text-xs font-medium text-primary hover:underline">
                  Return to Review Player <ArrowRight className="h-3 w-3" />
                </Link>
              )}
            </div>
          </div>
          {previewFloating && (
            <p className="text-[10px] text-muted-foreground">
              Drag the header to move; drag the resize grip below to resize. Video seeking remains available in the player controls.
            </p>
          )}
          <video
            ref={videoRef}
            src={videoSrc}
            controls
            playsInline
            className={`${previewFloating ? "max-h-[42vh]" : "2xl:max-h-[24vh] max-h-[42vh]"} w-full rounded-lg bg-black object-contain`}
            onTimeUpdate={(event) => updateFeedWorkspace(feedRole, { videoTime: event.currentTarget.currentTime })}
            onPlay={() => updateFeedWorkspace(feedRole, { videoPlaying: true })}
            onPause={() => updateFeedWorkspace(feedRole, { videoPlaying: false })}
            onLoadedMetadata={(event) => {
              const savedTime = Number(feedWorkspaces[feedRole]?.videoTime) || 0;
              if (savedTime > 0 && savedTime < event.currentTarget.duration) {
                event.currentTarget.currentTime = savedTime;
              }
              updateFeedWorkspace(feedRole, { videoDuration: event.currentTarget.duration || 0 });
              setFloatingPreviewPosition((current) => clampFloatingPreviewPosition(
                current,
                floatingPreviewWidth,
                previewRef.current?.getBoundingClientRect().height,
              ));
            }}
          />
          {previewFloating && (
            <button
              type="button"
              onPointerDown={beginFloatingResize}
              className="ml-auto flex h-5 w-20 touch-none cursor-ew-resize items-center justify-center rounded-md border border-primary/30 bg-primary/10 text-[9px] font-semibold uppercase tracking-wider text-primary hover:bg-primary/20"
              aria-label="Drag to resize floating preview"
              title="Drag horizontally to resize preview"
            >
              Resize
            </button>
          )}
        </div>
      ) : (
        <div className="rounded-xl border border-dashed border-border bg-card p-8 text-center text-sm text-muted-foreground">
          Load a local video to configure and run derived motion analysis.
        </div>
      )}

      {selectedSession?.motion_analysis_summary && evidence.hasSavedTelemetry && (
        <SavedMotionSummaryCard summary={selectedSession.motion_analysis_summary} compact onSeek={videoSrc ? seek : undefined} playbackTime={videoTime} />
      )}
    </div>
  );

  return (
    <div>
      <PageHeader title="Motion Lab" subtitle="Local-only motion detection, configuration, and derived evidence saving" />
      <div className="space-y-1.5 px-1.5 pb-3">
        <div className="rounded-xl border border-primary/20 bg-primary/[0.05] px-3 py-2">
          <div className="flex items-start gap-2">
            <ShieldCheck className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
            <div>
              <p className="text-sm font-semibold text-foreground">Videos stay local to this browser session.</p>
              <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                Motion Lab saves only derived telemetry, review summaries, and explicitly promoted observations. Raw video, local file paths, frames, and MediaPipe landmarks are not persisted.
              </p>
            </div>
          </div>
        </div>

        <div className="grid gap-1.5 xl:grid-cols-[16rem_minmax(0,1fr)]">
          <aside className="space-y-1.5">
            <div className="rounded-xl border border-border bg-card p-2.5 space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-primary">Analysis Target</p>
              {loading ? <p className="text-sm text-muted-foreground">Loading sessions...</p> : (
                <Select value={selectedId} onValueChange={selectSession}>
                  <SelectTrigger><SelectValue placeholder="Choose a session..." /></SelectTrigger>
                  <SelectContent>
                    {sessions.map((session) => <SelectItem key={session.id} value={session.id}>{labelForSession(session)}</SelectItem>)}
                  </SelectContent>
                </Select>
              )}
              <Select value={feedRole} onValueChange={setFeedRole}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {FEED_ROLES.map((role) => <SelectItem key={role.value} value={role.value}>{role.label}</SelectItem>)}
                </SelectContent>
              </Select>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Each feed is independent. Select a feed, load its local recording, then configure and finalize its derived analysis separately.
              </p>
              <div className="grid gap-1.5">
                {FEED_ROLES.map((role) => {
                  const workspace = feedWorkspaces[role.value];
                  const hasFinal = !!(
                    feedSummaries[role.value]
                    || selectedSession?.motion_analysis_summary?.feed_summaries?.[role.value]
                    || (role.value === "composite" && selectedSession?.motion_analysis_summary && !selectedSession.motion_analysis_summary.feed_summaries)
                  );
                  return (
                    <button
                      key={role.value}
                      type="button"
                      onClick={() => setFeedRole(role.value)}
                      className={`flex items-center justify-between gap-2 rounded-md border px-2.5 py-2 text-left text-[11px] transition-colors ${
                        feedRole === role.value ? "border-primary/45 bg-primary/[0.09]" : "border-border bg-muted/10 hover:border-primary/25"
                      }`}
                    >
                      <span className="truncate text-foreground">{role.label}</span>
                      <span className={`shrink-0 rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${
                        hasFinal
                          ? "bg-emerald-400/10 text-emerald-300"
                          : workspace?.videoSrc
                            ? "bg-primary/10 text-primary"
                            : "bg-muted text-muted-foreground"
                      }`}>
                        {hasFinal ? "Finalized" : workspace?.videoSrc ? "Configured" : "Empty"}
                      </span>
                    </button>
                  );
                })}
              </div>
              <button type="button" onClick={() => fileInputRef.current?.click()} className="inline-flex w-full items-center justify-center gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2 text-sm font-medium hover:border-primary/40 hover:text-primary">
                <Video className="h-4 w-4" />
                {videoSrc ? `Change ${feedLabel(feedRole)} video` : `Load ${feedLabel(feedRole)} video`}
              </button>
              <input ref={fileInputRef} type="file" accept="video/*" className="hidden" onChange={(event) => { loadVideo(event.target.files?.[0]); event.target.value = ""; }} />
              {videoName && <p className="truncate text-xs text-muted-foreground">{videoName}</p>}
              {selectedSession?.motion_analysis_summary?.feed_summaries && (
                <p className="rounded-md border border-primary/15 bg-primary/[0.04] px-2.5 py-2 text-[10px] leading-relaxed text-muted-foreground">
                  Saved combined evidence includes {selectedSession.motion_analysis_summary.analyzed_feeds?.map(feedLabel).join(" + ") || "multiple feeds"}. Reload a local recording only when you want to review or reprocess that feed.
                </p>
              )}
              <button type="button" disabled={!selectedSession || !videoFile} onClick={addToQueue} className="inline-flex w-full items-center justify-center gap-2 rounded-lg bg-primary/10 px-3 py-2 text-xs font-semibold text-primary disabled:opacity-40">
                <ListPlus className="h-3.5 w-3.5" /> Stage in processing queue
              </button>
            </div>

            <div className="rounded-xl border border-border bg-card p-2.5 space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-primary">Processing Queue</p>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                Queue items retain local file access only while this page is open. Configure and finalize each feed independently; finalized feeds are combined in the selected session's derived summary.
              </p>
              {queue.length === 0 ? <p className="rounded-lg bg-muted/20 p-3 text-xs text-muted-foreground">No videos staged yet.</p> : queue.map((item) => (
                <div key={item.id} className="rounded-lg border border-border bg-muted/10 p-2.5 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <p className="truncate text-xs font-medium text-foreground">{item.videoName}</p>
                      <p className="truncate text-[10px] text-muted-foreground">{item.sessionLabel}</p>
                    </div>
                    <span className={`rounded-full px-1.5 py-0.5 text-[9px] font-semibold ${item.status === "Completed" ? "bg-emerald-400/10 text-emerald-300" : "bg-primary/10 text-primary"}`}>{item.status}</span>
                  </div>
                  <p className="text-[10px] text-muted-foreground">{FEED_ROLES.find((role) => role.value === item.feedRole)?.label}</p>
                  <div className="flex gap-1.5">
                    <button type="button" onClick={() => activateQueueItem(item)} className="inline-flex items-center gap-1 rounded-md border border-primary/25 px-2 py-1 text-[10px] text-primary">
                      <Play className="h-3 w-3" /> Activate
                    </button>
                    <button type="button" onClick={() => setQueue((current) => current.filter((value) => value.id !== item.id))} className="rounded-md border border-border px-2 py-1 text-[10px] text-muted-foreground hover:text-destructive">
                      <Trash2 className="h-3 w-3" />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </aside>

          <section className="grid gap-1.5 2xl:grid-cols-[minmax(0,1fr)_minmax(21rem,25rem)]">
            {/* MOTION_LAB_EDITOR_FIRST_WORKSPACE_V1 */}
            <div className="contents">
              {configuredRoles.map((role) => {
                const workspace = feedWorkspaces[role.value] || {};
                const active = role.value === feedRole;
                return (
                  <div key={`${selectedId || "no-session"}-${role.value}`} className={active ? "contents" : "hidden"} aria-hidden={!active}>
                    <LocalMotionAnalysisPanel
                      videoSrc={workspace.videoSrc || ""}
                      videoDuration={workspace.videoDuration || 0}
                      videoTime={workspace.videoTime || 0}
                      videoPlaying={active ? !!workspace.videoPlaying : false}
                      selectedSession={selectedSession}
                      analysisFeedLabel={role.value === "composite" ? null : role.label}
                      splitWorkspaceLayout
                      rightRailHeader={rightRailHeader}
                      onSeek={(timeS) => {
                        if (active) seek(timeS);
                        else updateFeedWorkspace(role.value, { videoTime: Number(timeS) || 0 });
                      }}
                      onSaveSummary={(summary, events) => saveSummary(role.value, summary, events)}
                      onAcceptSuggestions={(events) => acceptSuggestions(role.value, events)}
                    />
                  </div>
                );
              })}
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}
