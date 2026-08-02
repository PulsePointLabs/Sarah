import { useEffect, useMemo, useRef, useState } from "react";
import { Clapperboard, Maximize2, Sparkles } from "lucide-react";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { serverUrl } from "@/lib/mobileApiBase";
import { videoPosterDataUrl } from "@/lib/videoPoster";

function sourcePriority(video = {}) {
  const text = `${video?.label || ""} ${video?.filename || ""} ${video?.path || ""}`.toLowerCase();
  if (/\b(composite|pip|picture[-_\s]?in[-_\s]?picture|obs)\b/.test(text)) return 0;
  if (/\b(main|focus|primary|close|genital|shaft|glans)\b/.test(text)) return 1;
  if (/\b(side|lateral|angle)\b/.test(text)) return 8;
  if (/\b(feet|foot|toe|toes|heel|heels|lower[-_\s]?body|legs?|pelvis)\b/.test(text)) return 9;
  return 3;
}

export function buildRecordStoryVideoSources({ linkedVideos = [], uploadedVideos = [], recordLabel = "session" }) {
  const linkedSources = Array.isArray(linkedVideos)
    ? linkedVideos
        .filter((video) => video?.path && video.exists !== false)
        .sort((a, b) => sourcePriority(a) - sourcePriority(b))
        .map((video, index) => ({
          id: video.id || video.path || `linked-${index}`,
          label: video.label || video.filename || (index === 0 ? `${recordLabel} composite` : `Linked video ${index + 1}`),
          url: base44.integrations.Core.localVideoStreamUrl(video.path),
          path: video.path,
          timelineOffsetSeconds: Number(video.timelineOffsetSeconds) || 0,
          sourceKind: "linked_local_video",
        }))
    : [];

  if (linkedSources.length) return linkedSources;

  return Array.isArray(uploadedVideos)
    ? uploadedVideos.filter(Boolean).map((url, index) => ({
        id: `uploaded-${index}`,
        label: index === 0 ? `Uploaded ${recordLabel} video` : `Uploaded video ${index + 1}`,
        url: serverUrl(url),
        timelineOffsetSeconds: 0,
        sourceKind: `uploaded_${recordLabel.replaceAll(" ", "_")}_video`,
      }))
    : [];
}

function cacheBustedMediaUrl(fileUrl = "", cacheKey = "") {
  const url = serverUrl(fileUrl);
  if (!url) return "";
  const version = String(cacheKey || Date.now()).replace(/[^a-zA-Z0-9_.-]/g, "");
  return `${url}${url.includes("?") ? "&" : "?"}v=${encodeURIComponent(version)}`;
}

export default function RecordStoryVideoPlayer({
  linkedVideos = [],
  uploadedVideos = [],
  recordLabel = "session",
  sectionId = "record-story-video",
  onAskSarahAtTimestamp,
}) {
  const playableVideos = useMemo(
    () => buildRecordStoryVideoSources({ linkedVideos, uploadedVideos, recordLabel }),
    [linkedVideos, recordLabel, uploadedVideos],
  );
  const [activeIndex, setActiveIndex] = useState(0);
  const [playbackSpeed, setPlaybackSpeed] = useState(1);
  const [playheadSeconds, setPlayheadSeconds] = useState(0);
  const [resolvedVideoUrls, setResolvedVideoUrls] = useState({});
  const [videoLoadState, setVideoLoadState] = useState({ busy: false, error: "" });
  const videoRef = useRef(null);
  const wrapperRef = useRef(null);

  useEffect(() => {
    setActiveIndex((current) => Math.min(current, Math.max(0, playableVideos.length - 1)));
  }, [playableVideos.length]);

  useEffect(() => {
    if (videoRef.current) videoRef.current.playbackRate = playbackSpeed;
  }, [activeIndex, playbackSpeed]);

  const activeVideo = playableVideos[activeIndex] || playableVideos[0] || null;
  const activeResolvedVideoUrl = activeVideo
    ? resolvedVideoUrls[activeVideo.id] || activeVideo.url
    : "";
  const activeVideoUrl = cacheBustedMediaUrl(
    activeResolvedVideoUrl,
    [activeVideo?.id, activeVideo?.label, activeVideo?.timelineOffsetSeconds, activeResolvedVideoUrl, activeIndex].filter(Boolean).join("-"),
  );
  const titleLabel = recordLabel === "body exploration" ? "Body Exploration Video" : "Session Video";
  const activeVideoPoster = videoPosterDataUrl({
    title: activeVideo?.label || `${recordLabel} video`,
    subtitle: `Sarah source ${recordLabel} video`,
    timestamp: "Tap to play",
  });

  useEffect(() => {
    let cancelled = false;
    const controller = new AbortController();
    const current = playableVideos[activeIndex] || playableVideos[0];
    if (!current?.id) return undefined;
    if (current.sourceKind !== "linked_local_video" || resolvedVideoUrls[current.id]) {
      setVideoLoadState((previous) => (previous.busy || previous.error ? { busy: false, error: "" } : previous));
      return undefined;
    }

    setVideoLoadState({ busy: true, error: "" });
    base44.integrations.Core.ConvertLocalVideoForPlayback({
      path: current.path,
      label: current.label || `${recordLabel}-video`,
      signal: controller.signal,
    }).then((result) => {
      if (cancelled) return;
      const nextUrl = result?.url || result?.file_url || "";
      if (!nextUrl) throw new Error("Playback preview did not return a video URL.");
      setResolvedVideoUrls((previous) => ({ ...previous, [current.id]: nextUrl }));
      setVideoLoadState({ busy: false, error: "" });
    }).catch((error) => {
      if (cancelled) return;
      setVideoLoadState({
        busy: false,
        error: error?.data?.error || error?.message || `Could not prepare this local ${recordLabel} video for browser playback.`,
      });
    });

    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [activeIndex, playableVideos, recordLabel, resolvedVideoUrls]);

  if (!activeVideo) return null;

  const openFullscreen = async () => {
    const video = videoRef.current;
    const target = wrapperRef.current || video;
    if (!video || !target) return;
    video.controls = true;
    try {
      const requestFullscreen = target.requestFullscreen || target.webkitRequestFullscreen || target.msRequestFullscreen;
      if (requestFullscreen) await requestFullscreen.call(target);
      else if (typeof video.webkitEnterFullscreen === "function") video.webkitEnterFullscreen();
    } catch (error) {
      console.warn(`Could not open ${recordLabel} video fullscreen:`, error);
    }
  };

  const askSarahAboutMoment = () => {
    if (!activeResolvedVideoUrl) return;
    onAskSarahAtTimestamp?.({
      timeSeconds: Math.max(0, Number(playheadSeconds) || 0),
      sourceUrl: activeResolvedVideoUrl,
      sourcePath: activeVideo.path || "",
      timelineOffsetSeconds: Number(activeVideo.timelineOffsetSeconds) || 0,
      sourceLabel: activeVideo.label || `${recordLabel} video`,
      sourceKind: activeVideo.sourceKind || `${recordLabel.replaceAll(" ", "_")}_video`,
    });
  };

  return (
    <section id={sectionId} className="scroll-mt-24">
      <div className="w-full rounded-xl border border-primary/20 bg-card p-3 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-primary">
              <Clapperboard className="h-3.5 w-3.5" /> {titleLabel}
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Play or seek to an individual section, then ask Sarah to sample timestamped frames from that exact moment.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <div className="inline-flex rounded-full border border-border bg-muted/35 p-1">
              {[0.5, 1, 1.5, 2].map((speed) => (
                <button
                  key={speed}
                  type="button"
                  onClick={() => setPlaybackSpeed(speed)}
                  className={`rounded-full px-2 py-1 text-[10px] font-semibold ${playbackSpeed === speed ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
                >
                  {speed}x
                </button>
              ))}
            </div>
            <Button type="button" size="sm" variant="outline" className="h-8 gap-1.5" onClick={openFullscreen}>
              <Maximize2 className="h-3.5 w-3.5" /> Fullscreen
            </Button>
          </div>
        </div>

        <div className="mt-3 flex flex-wrap items-center justify-between gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2">
          <div className="min-w-0">
            <p className="truncate text-xs font-semibold text-foreground">{activeVideo.label}</p>
            <p className="text-[11px] font-semibold tracking-[0.14em] text-muted-foreground tabular-nums">
              {Math.floor(playheadSeconds / 60)}:{Math.round(playheadSeconds % 60).toString().padStart(2, "0")}
              {activeVideo.timelineOffsetSeconds ? ` · sync offset ${activeVideo.timelineOffsetSeconds > 0 ? "+" : ""}${activeVideo.timelineOffsetSeconds}s` : ""}
            </p>
          </div>
          <Button type="button" size="sm" className="h-8 gap-1.5" onClick={askSarahAboutMoment} disabled={videoLoadState.busy || Boolean(videoLoadState.error)}>
            <Sparkles className="h-3.5 w-3.5" /> Ask Sarah About This Moment
          </Button>
        </div>

        {playableVideos.length > 1 && (
          <div className="mt-3 flex flex-wrap gap-2">
            {playableVideos.map((video, index) => (
              <Button
                key={video.id || index}
                type="button"
                size="sm"
                variant={index === activeIndex ? "default" : "outline"}
                className="h-7 text-[10px]"
                onClick={() => setActiveIndex(index)}
              >
                {video.label || `Video ${index + 1}`}
              </Button>
            ))}
          </div>
        )}

        <div ref={wrapperRef} className="relative mt-3 max-w-full overflow-hidden rounded-lg border border-border bg-black">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-border bg-background px-3 py-2 text-xs">
            <span className="font-semibold text-foreground">{titleLabel}</span>
            <span className="text-muted-foreground">{activeVideo.label || "Primary source video"}</span>
          </div>
          {videoLoadState.busy ? (
            <div className="flex aspect-video w-full flex-col items-center justify-center gap-2 bg-black px-6 text-center">
              <p className="text-sm font-semibold text-white">Preparing browser playback</p>
              <p className="max-w-md text-xs text-white/75">Converting this local source to a browser-friendly MP4 for reliable play, seek, and Sarah frame review.</p>
            </div>
          ) : videoLoadState.error ? (
            <div className="flex aspect-video w-full flex-col items-center justify-center gap-2 bg-black px-6 text-center">
              <p className="text-sm font-semibold text-white">Video preview unavailable</p>
              <p className="max-w-md text-xs text-white/75">{videoLoadState.error}</p>
            </div>
          ) : (
            <video
              ref={videoRef}
              key={activeVideoUrl}
              src={activeVideoUrl}
              poster={activeVideoPoster}
              controls
              playsInline
              preload="metadata"
              className="aspect-video w-full bg-black object-contain"
              onLoadedMetadata={(event) => {
                event.currentTarget.playbackRate = playbackSpeed;
                setPlayheadSeconds(event.currentTarget.currentTime || 0);
              }}
              onTimeUpdate={(event) => setPlayheadSeconds(event.currentTarget.currentTime || 0)}
              onSeeked={(event) => setPlayheadSeconds(event.currentTarget.currentTime || 0)}
            />
          )}
          <div className="pointer-events-none absolute bottom-3 left-3 max-w-[calc(100%-1.5rem)] truncate rounded-full border border-white/15 bg-black/72 px-3 py-1.5 text-[12px] font-semibold tracking-[0.18em] text-white shadow-[0_6px_18px_rgba(0,0,0,0.34)] tabular-nums backdrop-blur-sm">
            {Math.floor(playheadSeconds / 60)}:{Math.round(playheadSeconds % 60).toString().padStart(2, "0")}
          </div>
        </div>
      </div>
    </section>
  );
}
