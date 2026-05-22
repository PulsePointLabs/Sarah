import { useCallback, useEffect, useRef, useState } from "react";
import { Clapperboard, ScanSearch, Video } from "lucide-react";
import moment from "moment";
import { base44 } from "@/api/base44Client";
import PageHeader from "../components/PageHeader";
import HRTimelineChart from "../components/HRTimelineChart";
import InteractiveTimelinePlayer, { TimelineWaypointDetail } from "../components/InteractiveTimelinePlayer";
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

export default function SessionReviewPlayer() {
  const videoRef = useRef(null);
  const fileInputRef = useRef(null);
  const videoUrlRef = useRef(null);

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
  const [selectedEventIdx, setSelectedEventIdx] = useState(null);
  const [timelineWaypointDetail, setTimelineWaypointDetail] = useState(null);
  const [followTimeline, setFollowTimeline] = useState(true);

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
  };

  const handleVideoChange = (event) => {
    loadVideoFile(event.target.files?.[0]);
    event.target.value = "";
  };

  const handleSelectSession = async (id) => {
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

  const handleReviewWaypointActivate = useCallback((waypoint) => {
    if (!followTimeline || !waypoint) return Promise.resolve();
    return seekVideoTo(waypoint.time_s, true, true);
  }, [followTimeline, seekVideoTo]);

  const handleWaypointChange = (detail) => {
    setTimelineWaypointDetail(detail);
  };

  const handleSelectEventIndex = (index) => {
    setSelectedEventIdx(index);
    if (index != null && followTimeline) {
      seekVideoTo(selectedSession?.event_timeline?.[index]?.time_s, true);
    }
  };

  const hasTimelineReview = selectedSession
    && (timelineRows.length > 0
      || (selectedSession.event_timeline || []).length > 0
      || (selectedSession.ai_near_climax_events || []).length > 0
      || selectedSession.pre_climax_offset_s != null
      || selectedSession.climax_offset_s != null
      || selectedSession.recovery_offset_s != null);

  return (
    <div>
      <PageHeader
        title="Session Review Player"
        subtitle="Review a full video beside the event timeline and let each waypoint bring the matching observation into view."
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

                {videoSrc ? (
                  <div className="space-y-3 p-4">
                    <div className="overflow-hidden rounded-lg bg-black">
                      <video
                        ref={videoRef}
                        src={videoSrc}
                        controls
                        playsInline
                        className="aspect-video max-h-[72vh] w-full bg-black object-contain"
                        onTimeUpdate={(event) => setVideoTime(event.currentTarget.currentTime)}
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
                      Timeline playback will seek this video to each event, phase marker, and review waypoint.
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
                      The timeline player advances through each waypoint. With Follow timeline on, the video seeks and plays from the matching timestamp before the next waypoint timer begins.
                    </p>
                  </div>
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
                    <TimelineWaypointDetail
                      waypoint={timelineWaypointDetail?.waypoint}
                      currentHR={timelineWaypointDetail?.currentHR}
                    />
                  </div>

                  <InteractiveTimelinePlayer
                    session={selectedSession}
                    timelineRows={timelineRows}
                    onActiveEventIndexChange={setSelectedEventIdx}
                    onActiveWaypointChange={handleWaypointChange}
                    onWaypointActivate={handleReviewWaypointActivate}
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
