import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router-dom";
import { base44 } from "@/api/base44Client";
import { serverUrl } from "@/lib/mobileApiBase";
import { downloadOrSaveUrl, openAndroidDownloads } from "@/lib/nativeFileSaver";
import { getBackgroundJob, listBackgroundJobs } from "@/lib/backgroundJobs";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Play, Pause, Download, Trash2, Music, Video, ChevronDown, ChevronRight, ExternalLink, RefreshCw, AlertTriangle } from "lucide-react";
import { Button } from "@/components/ui/button";
import PageHeader from "@/components/PageHeader";
import { buildAudioExportFilename } from "@/utils/exportFilenames";

const formatDuration = (seconds) => {
  if (!seconds) return null;
  const mins = Math.floor(seconds / 60);
  const secs = Math.round(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, "0")}`;
};

const RAW_SECTION_TITLE_RE = /^tts-section-\d+$/i;
const RECENT_AUDIO_LIMIT = 50;
const RECENT_VIDEO_LIMIT = 50;
const AUDIO_EXPORT_FIELDS = [
  "id",
  "title",
  "analysis_title",
  "file_url",
  "audio_url",
  "download_url",
  "url",
  "duration_seconds",
  "voice",
  "speed",
  "model",
  "format",
  "render_version",
  "size",
  "filename",
  "tts_session_key",
  "analysis_title",
  "session_date",
  "source_generated_at",
  "exported_at",
  "has_chapters",
  "chapter_count",
  "sidecar_chapters_available",
  "chapter_json_url",
  "chapter_cue_url",
  "chapter_txt_url",
  "notes",
  "section_name",
  "created_date",
  "updated_date",
];
const REVIEW_VIDEO_FIELDS = [
  "id",
  "title",
  "analysis_title",
  "file_url",
  "video_url",
  "download_url",
  "url",
  "manifest_url",
  "filename",
  "duration_seconds",
  "session_id",
  "record_type",
  "session_date",
  "source_generated_at",
  "exported_at",
  "audio_reused",
  "clip_count",
  "cited_time_count",
  "visual_mode",
  "watermark_enabled",
  "watermark_preset",
  "created_date",
  "updated_date",
];

async function triggerDownloadOrOpen(url, filename = "", options = {}) {
  if (!url) return;
  return downloadOrSaveUrl(url, filename, options);
}

const getRawAudioUrl = (export_) => (
  export_?.file_url ||
  export_?.audio_url ||
  export_?.download_url ||
  export_?.url ||
  ""
);

const virtualExportFromJob = (job) => {
  if (!job?.result?.file_url) return null;
  const title = job?.meta?.title || job?.payload?.title || job?.meta?.label || "Completed audio render";
  return {
    id: `job:${job.id}`,
    title,
    analysis_title: title,
    file_url: job.result.file_url,
    duration_seconds: Math.round(Number(job.result.duration_seconds || 0)),
    voice: job?.payload?.voice,
    speed: job?.payload?.speed,
    model: job?.payload?.model,
    format: job.result.format || job?.payload?.outputFormat || "mp3",
    render_version: job.result.render_version,
    silence_trim: job.result.silence_trim || null,
    size: job.result.size,
    filename: job.result.filename || String(job.result.file_url).split("/").pop(),
    tts_session_key: job?.meta?.sessionId || null,
    source_generated_at: job?.meta?.sourceGeneratedAt || null,
    exported_at: job.finishedAt || job.updatedAt || job.createdAt,
    created_date: job.finishedAt || job.updatedAt || job.createdAt,
    has_chapters: Boolean(job.result.has_chapters),
    chapter_format: job.result.chapter_format || "sidecar",
    chapter_count: Number(job.result.chapter_count || 0),
    sidecar_chapters_available: Boolean(job.result.sidecar_chapters_available),
    chapter_json_url: job.result.chapter_json_url || null,
    chapter_cue_url: job.result.chapter_cue_url || null,
    chapter_txt_url: job.result.chapter_txt_url || null,
    _source: "completed_tts_job",
  };
};

const audioExportRecordFromJob = (job) => {
  const export_ = virtualExportFromJob(job);
  if (!export_) return null;
  const created = getCreatedTimestamp(export_) || new Date().toISOString();
  return {
    id: `tts-job-${job.id}`,
    title: export_.title,
    analysis_title: export_.analysis_title,
    file_url: export_.file_url,
    duration_seconds: export_.duration_seconds,
    voice: export_.voice || null,
    speed: export_.speed || null,
    model: export_.model || null,
    format: export_.format,
    render_version: export_.render_version || null,
    silence_trim: export_.silence_trim || null,
    size: export_.size || null,
    filename: export_.filename || buildAudioExportFilename({
      title: export_.title,
      sessionDate: created,
      extension: getDownloadExtension(export_),
    }),
    tts_session_key: export_.tts_session_key,
    source_generated_at: export_.source_generated_at,
    exported_at: export_.exported_at || created,
    has_chapters: export_.has_chapters,
    chapter_format: export_.chapter_format || "sidecar",
    chapter_count: export_.chapter_count,
    chapter_source: "tts_export",
    sidecar_chapters_available: export_.sidecar_chapters_available,
    chapter_json_url: export_.chapter_json_url,
    chapter_cue_url: export_.chapter_cue_url,
    chapter_txt_url: export_.chapter_txt_url,
    audio_content_version: export_.source_generated_at,
    recovered_from_job_id: job.id,
    notes: "Recovered from a completed background audio render.",
    created_date: created,
  };
};

const getAudioUrl = (export_) => serverUrl(getRawAudioUrl(export_));

const getRawVideoUrl = (video) => (
  video?.file_url ||
  video?.video_url ||
  video?.download_url ||
  video?.url ||
  ""
);

const getVideoUrl = (video) => {
  const url = serverUrl(getRawVideoUrl(video));
  if (!url) return "";
  const version = [
    video?.filename,
    video?.exported_at,
    video?.created_date,
    video?.source_generated_at,
    video?.watermark_enabled ? "wm" : "nowm",
  ].filter(Boolean).join("-");
  const cleaned = String(version || Date.now()).replace(/[^a-zA-Z0-9_.-]/g, "");
  return `${url}${url.includes("?") ? "&" : "?"}v=${encodeURIComponent(cleaned)}`;
};

const virtualVideoFromJob = (job) => {
  const result = job?.result || job?.result_summary || {};
  const progress = job?.progress || {};
  const fileUrl = result.file_url || progress.result_file_url || progress.file_url || "";
  if (!fileUrl) return null;
  const isProfileAnatomyVideo = job?.type === "profile_anatomy_video";
  const title = job?.meta?.title || result?.record?.title || job?.payload?.title || (isProfileAnatomyVideo ? "Profile anatomy video" : "Completed review video");
  return {
    id: `job:${job.id}`,
    title,
    analysis_title: result?.record?.analysis_title || title,
    file_url: fileUrl,
    filename: result.filename || progress.result_filename || progress.filename || String(fileUrl).split("/").pop(),
    duration_seconds: Math.round(Number(result.duration_seconds || progress.result_duration_seconds || progress.duration_seconds || 0)),
    size: result.size || progress.result_size || progress.size || null,
    mimeType: "video/mp4",
    session_id: job?.meta?.sessionId || result?.record?.session_id || null,
    source_generated_at: job?.meta?.sourceGeneratedAt || result?.record?.source_generated_at || null,
    exported_at: job.finishedAt || job.updatedAt || job.createdAt,
    created_date: job.finishedAt || job.updatedAt || job.createdAt,
    audio_reused: Boolean(result.audio_reused),
    clip_count: Number(result.clip_count || 0),
    cited_time_count: Number(result.cited_time_count || 0),
    manifest_url: result.manifest_url || null,
    visual_mode: result.record?.visual_mode || result.render_version || (isProfileAnatomyVideo ? "profile_anatomy_video" : null),
    review_type: job?.meta?.reviewType || job?.payload?.reviewType || result.review_scope || progress.review_scope || null,
    record_type: job?.meta?.recordType || job?.payload?.recordType || result?.record?.record_type || null,
    session_date: job?.meta?.sessionDate || job?.payload?.sessionDate || result?.record?.session_date || null,
    watermark_enabled: Boolean(result?.watermark?.watermark_enabled ?? result?.record?.watermark_enabled ?? result?.watermark_enabled),
    watermark_preset: result?.watermark?.preset || result?.record?.watermark_preset || result?.watermark_preset || null,
    _source: isProfileAnatomyVideo ? "completed_profile_anatomy_video_job" : "completed_review_video_job",
  };
};

const hydrateJobsWithResults = async (jobs = []) => (
  Promise.all((jobs || []).map(async (job) => {
    if (!job?.id || job.result || !job.hasResult) return job;
    try {
      return await getBackgroundJob(job.id);
    } catch (error) {
      console.warn("Could not hydrate completed background job:", error);
      return job;
    }
  }))
);

const getCreatedTimestamp = (export_) => (
  export_?.exported_at ||
  export_?.created_date ||
  export_?.updated_date ||
  export_?.source_generated_at ||
  ""
);

const timestampMs = (export_) => {
  const parsed = Date.parse(getCreatedTimestamp(export_));
  return Number.isFinite(parsed) ? parsed : 0;
};

const formatCreatedTimestamp = (value) => {
  if (!value) return "Unknown creation time";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "Unknown creation time";
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
};

const formatQueryError = (error) => {
  if (!error) return "";
  const status = error?.status ? `${error.status} ` : "";
  return `${status}${error?.message || "Request failed"}`.trim();
};

const parseLocalDateOnly = (value) => {
  const match = String(value || "").match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!match) return null;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
};

const formatSessionDate = (session) => {
  const source = session?.date || session?.start_time || session?.created_date;
  if (!source) return "";
  const date = session?.date ? parseLocalDateOnly(source) : new Date(source);
  if (!date || Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
};

const formatReviewVideoSessionDate = (value) => {
  if (!value) return "";
  const date = parseLocalDateOnly(value) || new Date(value);
  if (!date || Number.isNaN(date.getTime())) return "";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
};

const reviewVideoRecordType = (video) => {
  const type = String(video?.record_type || video?.recordType || video?.review_type || "").toLowerCase();
  if (type === "body_exploration" || type === "body exploration") return "body_exploration";
  if (/body[-_\s]?exploration/i.test(`${video?.analysis_title || ""} ${video?.title || ""} ${video?.filename || ""}`)) return "body_exploration";
  return "session";
};

const titleFromFilename = (filename = "") => {
  const base = String(filename)
    .split(/[\\/]/)
    .pop()
    ?.replace(/\.[^.]+$/, "")
    .trim();

  if (!base) return "";

  return base
    .replace(/^\d{4}-\d{2}-\d{2}[-_\s]*/i, "")
    .replace(/[-_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
};

const cleanDisplayTitle = (export_) => {
  const candidates = [
    export_?.analysis_title,
    export_?.title,
    titleFromFilename(export_?.filename),
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);

  const usefulTitle = candidates.find((value) => !RAW_SECTION_TITLE_RE.test(value));
  return usefulTitle || export_?.section_name || "TTS audio export";
};

const cleanVideoTitle = (video) => {
  const candidates = [
    video?.analysis_title,
    video?.title,
    titleFromFilename(video?.filename),
  ]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return candidates[0] || "Session review video";
};

function LibrarySection({ icon, title, count, helper, open, onToggle, children }) {
  return (
    <section className="rounded-xl border border-border bg-card overflow-hidden">
      <button
        type="button"
        onClick={onToggle}
        className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/35 transition-colors"
        aria-expanded={open}
      >
        <span className="text-primary">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold uppercase tracking-wider text-primary">{title}</span>
            <span className="rounded-full bg-primary/10 px-2 py-0.5 text-xs font-semibold text-primary">{count}</span>
          </span>
          {helper && <span className="mt-1 block text-xs text-muted-foreground">{helper}</span>}
        </span>
        {open ? <ChevronDown className="h-4 w-4 text-muted-foreground" /> : <ChevronRight className="h-4 w-4 text-muted-foreground" />}
      </button>
      {open && <div className="border-t border-border p-3 md:p-4">{children}</div>}
    </section>
  );
}

const getDownloadExtension = (export_) => {
  if (export_?.format) return String(export_.format).replace(/^\./, "");
  const source = export_?.filename || getRawAudioUrl(export_);
  const match = String(source || "").match(/\.([a-z0-9]+)(?:[?#].*)?$/i);
  return match?.[1] || "mp3";
};

export default function Library() {
  const queryClient = useQueryClient();
  const [playingId, setPlayingId] = useState(null);
  const [audioRef, setAudioRef] = useState(null);
  const [videosOpen, setVideosOpen] = useState(false);
  const [audioOpen, setAudioOpen] = useState(false);
  const [downloadNotice, setDownloadNotice] = useState(null);
  const recoveringJobIdsRef = useRef(new Set());

  const { data: exports = [], isLoading, error: audioExportsError } = useQuery({
    queryKey: ["audioExports"],
    queryFn: () => base44.entities.AudioExport.listFields(AUDIO_EXPORT_FIELDS, "-created_date", 125),
    placeholderData: [],
  });

  const { data: completedJobs = [], isLoading: jobsLoading, error: completedJobsError } = useQuery({
    queryKey: ["completedTtsExportJobs"],
    queryFn: async () => {
      const result = await listBackgroundJobs({
        type: "tts_export",
        status: "complete",
        metaSource: "TTSReader",
        includeCleared: true,
        limit: 40,
      });
      return result.jobs || [];
    },
    placeholderData: [],
  });

  const { data: reviewVideos = [], isLoading: videosLoading, error: reviewVideosError } = useQuery({
    queryKey: ["sessionReviewVideos"],
    queryFn: () => base44.entities.SessionReviewVideo.listFields(REVIEW_VIDEO_FIELDS, "-created_date", 125),
    placeholderData: [],
  });

  const { data: sessionLookupRows = [], error: sessionLookupError } = useQuery({
    queryKey: ["librarySessionLookup"],
    queryFn: () => base44.entities.Session.listFields(["id", "date", "start_time", "created_date"], "-date", 150),
    placeholderData: [],
  });

  const { data: explorationLookupRows = [], error: explorationLookupError } = useQuery({
    queryKey: ["libraryBodyExplorationLookup"],
    queryFn: () => base44.entities.BodyExploration.listFields(["id", "date", "start_time", "created_date", "title", "exploration_type"], "-date", 150),
    placeholderData: [],
  });

  const { data: completedVideoJobs = [], isLoading: videoJobsLoading, error: completedVideoJobsError } = useQuery({
    queryKey: ["completedSessionReviewVideoJobs"],
    queryFn: async () => {
      const result = await listBackgroundJobs({
        type: "session_review_video",
        status: "complete",
        includeCleared: true,
        limit: 40,
      });
      return result.jobs || [];
    },
    placeholderData: [],
  });

  const { data: completedProfileVideoJobs = [], isLoading: profileVideoJobsLoading, error: completedProfileVideoJobsError } = useQuery({
    queryKey: ["completedProfileAnatomyVideoJobs"],
    queryFn: async () => {
      const result = await listBackgroundJobs({
        type: "profile_anatomy_video",
        status: "complete",
        includeCleared: true,
        limit: 40,
      });
      return result.jobs || [];
    },
    placeholderData: [],
  });

  useEffect(() => {
    if (isLoading || jobsLoading) return;
    const existingUrls = new Set(exports.map((export_) => getRawAudioUrl(export_)).filter(Boolean));
    const missingJobs = completedJobs.filter((job) => (
      job?.id &&
      job?.result?.file_url &&
      !existingUrls.has(job.result.file_url) &&
      !recoveringJobIdsRef.current.has(job.id)
    ));
    if (!missingJobs.length) return;

    let cancelled = false;
    missingJobs.forEach(async (job) => {
      recoveringJobIdsRef.current.add(job.id);
      const record = audioExportRecordFromJob(job);
      if (!record) return;
      try {
        await base44.entities.AudioExport.create(record);
        if (!cancelled) queryClient.invalidateQueries({ queryKey: ["audioExports"] });
      } catch (error) {
        console.warn("Could not recover completed audio render into Audio Library:", error);
        recoveringJobIdsRef.current.delete(job.id);
      }
    });

    return () => {
      cancelled = true;
    };
  }, [completedJobs, exports, isLoading, jobsLoading, queryClient]);

  const downloadableExports = useMemo(() => (
    [
      ...exports,
      ...completedJobs
        .map(virtualExportFromJob)
        .filter(Boolean)
        .filter((jobExport) => !exports.some((export_) => getRawAudioUrl(export_) === jobExport.file_url)),
    ]
      .filter((export_) => Boolean(getRawAudioUrl(export_)))
      .sort((a, b) => timestampMs(b) - timestampMs(a))
      .slice(0, RECENT_AUDIO_LIMIT)
  ), [completedJobs, exports]);

  const downloadableVideos = useMemo(() => (
    [
      ...reviewVideos,
      ...[...completedVideoJobs, ...completedProfileVideoJobs]
        .map(virtualVideoFromJob)
        .filter(Boolean)
        .filter((jobVideo) => !reviewVideos.some((video) => getRawVideoUrl(video) === jobVideo.file_url)),
    ]
      .filter((video) => Boolean(getRawVideoUrl(video)))
      .sort((a, b) => timestampMs(b) - timestampMs(a))
      .slice(0, RECENT_VIDEO_LIMIT)
  ), [completedProfileVideoJobs, completedVideoJobs, reviewVideos]);

  const sessionsById = useMemo(() => {
    const map = new Map();
    for (const session of sessionLookupRows || []) {
      if (session?.id) map.set(String(session.id), session);
    }
    return map;
  }, [sessionLookupRows]);

  const explorationsById = useMemo(() => {
    const map = new Map();
    for (const exploration of explorationLookupRows || []) {
      if (exploration?.id) map.set(String(exploration.id), exploration);
    }
    return map;
  }, [explorationLookupRows]);

  useEffect(() => {
    if (downloadableVideos.length > 0) setVideosOpen(true);
  }, [downloadableVideos.length]);

  const libraryErrors = [
    ["Audio exports", audioExportsError],
    ["Audio jobs", completedJobsError],
    ["Review videos", reviewVideosError],
    ["Review video jobs", completedVideoJobsError],
    ["Profile video jobs", completedProfileVideoJobsError],
    ["Session dates", sessionLookupError],
    ["Body exploration dates", explorationLookupError],
  ].filter(([, error]) => Boolean(error));

  const refreshLibrary = () => {
    queryClient.invalidateQueries({ queryKey: ["audioExports"] });
    queryClient.invalidateQueries({ queryKey: ["completedTtsExportJobs"] });
    queryClient.invalidateQueries({ queryKey: ["sessionReviewVideos"] });
    queryClient.invalidateQueries({ queryKey: ["librarySessionLookup"] });
    queryClient.invalidateQueries({ queryKey: ["libraryBodyExplorationLookup"] });
    queryClient.invalidateQueries({ queryKey: ["completedSessionReviewVideoJobs"] });
    queryClient.invalidateQueries({ queryKey: ["completedProfileAnatomyVideoJobs"] });
  };

  const deleteExport = useMutation({
    mutationFn: (id) => base44.entities.AudioExport.delete(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["audioExports"] }),
  });

  const deleteReviewVideo = useMutation({
    mutationFn: (id) => base44.entities.SessionReviewVideo.delete(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["sessionReviewVideos"] }),
  });

  const handlePlay = (export_) => {
    if (playingId === export_.id) {
      audioRef?.pause();
      setPlayingId(null);
    } else {
      if (audioRef) audioRef.pause();
      const audio = new Audio(getAudioUrl(export_));
      audio.onended = () => setPlayingId(null);
      audio.play();
      setAudioRef(audio);
      setPlayingId(export_.id);
    }
  };

  const startLibraryDownload = async (url, filename, options = {}) => {
    if (!url) return;
    setDownloadNotice({
      type: "working",
      message: `Choose where to save ${filename || "download"}...`,
    });
    try {
      const result = await triggerDownloadOrOpen(url, filename, options);
      const androidStatus = result?.downloadStatus?.status;
      setDownloadNotice({
        type: result?.openedExternally ? "warning" : "ok",
        action: result?.systemDownload ? "openDownloads" : null,
        message: result?.nativeDownload
          ? `Native download started: ${filename || "file"}. Watch the Android notification for progress.`
          : result?.systemDownload
          ? `Queued in Android Downloads: ${filename || "file"}`
          : result?.systemPicker
          ? `Saved ${filename || "file"} (${Math.round(Number(result.bytes || 0) / 1024 / 1024)} MB).`
          : result?.openedExternally
          ? `Android opened the download link externally for ${filename || "this file"}.`
          : androidStatus
            ? `Android download ${androidStatus}: ${filename || "file"}`
            : `Download started: ${filename || "file"}`,
      });
    } catch (error) {
      setDownloadNotice({
        type: "error",
        message: error?.message || "Download failed before Android accepted it.",
      });
    }
  };

  const handleDownload = async (export_) => {
    const url = getAudioUrl(export_);
    if (!url) return;
    await startLibraryDownload(url, buildAudioExportFilename({
      title: cleanDisplayTitle(export_),
      sessionDate: export_.session_date || getCreatedTimestamp(export_),
      extension: getDownloadExtension(export_),
    }), { mimeType: export_?.format ? `audio/${String(export_.format).replace("mp3", "mpeg")}` : undefined });
  };

  const handleDownloadVideo = async (video) => {
    const url = getVideoUrl(video);
    if (!url) return;
    await startLibraryDownload(
      url,
      video.filename || `${cleanVideoTitle(video).replace(/[^a-zA-Z0-9_-]+/g, "-") || "Session-Review-Video"}.mp4`,
      { mimeType: "video/mp4" }
    );
  };

  const handleDownloadManifest = async (video) => {
    if (!video?.manifest_url) return;
    await startLibraryDownload(
      serverUrl(video.manifest_url),
      `${(video.filename || cleanVideoTitle(video)).replace(/\.[^.]+$/, "")}.review-manifest.json`,
      { mimeType: "application/json" }
    );
  };

  const handleDownloadChapters = (export_) => {
    const baseFilename = buildAudioExportFilename({
      title: cleanDisplayTitle(export_),
      sessionDate: export_.session_date || getCreatedTimestamp(export_),
      extension: getDownloadExtension(export_),
    }).replace(/\.[^.]+$/, "");
    [
      { url: serverUrl(export_.chapter_json_url), suffix: ".chapters.json" },
      { url: serverUrl(export_.chapter_cue_url), suffix: ".cue" },
      { url: serverUrl(export_.chapter_txt_url), suffix: ".chapters.txt" },
    ].filter((entry) => entry.url).forEach((entry, index) => {
      window.setTimeout(() => {
        startLibraryDownload(entry.url, `${baseFilename}${entry.suffix}`).catch(() => {});
      }, index * 120);
    });
  };

  const handleDelete = (id) => {
    if (confirm("Delete this audio export?")) {
      deleteExport.mutate(id);
    }
  };

  const handleDeleteReviewVideo = (video) => {
    if (String(video?.id || "").startsWith("job:")) return;
    if (confirm("Delete this review video record? The uploaded MP4 file may remain on disk.")) {
      deleteReviewVideo.mutate(video.id);
    }
  };

  const libraryLoading = isLoading || jobsLoading || videosLoading || videoJobsLoading || profileVideoJobsLoading;

  return (
    <div className="space-y-6">
      <PageHeader
        title="Multimedia Library"
        subtitle="Manage review videos, narrated audio exports, manifests, chapters, and past downloads"
        action={(
          <Button variant="outline" size="sm" onClick={refreshLibrary} className="gap-2">
            <RefreshCw className="h-4 w-4" />
            Refresh
          </Button>
        )}
      />

      {libraryLoading && (
        <div className="mx-4 flex items-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm text-muted-foreground">
          <RefreshCw className="h-4 w-4 animate-spin text-primary" />
          Loading latest media. Available results are shown as they arrive.
        </div>
      )}

      {downloadNotice && (
        <div className={[
          "mx-4 flex items-start justify-between gap-3 rounded-lg border px-3 py-2 text-sm",
          downloadNotice.type === "error"
            ? "border-destructive/30 bg-destructive/10 text-destructive"
            : downloadNotice.type === "warning"
              ? "border-amber-300 bg-amber-50 text-amber-950 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100"
              : downloadNotice.type === "working"
                ? "border-primary/20 bg-primary/10 text-primary"
                : "border-emerald-300 bg-emerald-50 text-emerald-950 dark:border-emerald-500/40 dark:bg-emerald-500/10 dark:text-emerald-100",
        ].join(" ")}>
          <span className="min-w-0">{downloadNotice.message}</span>
          <button
            type="button"
            onClick={() => setDownloadNotice(null)}
            className="shrink-0 text-xs font-semibold opacity-70 hover:opacity-100"
          >
            Dismiss
          </button>
          {downloadNotice.action === "openDownloads" && (
            <button
              type="button"
              onClick={() => openAndroidDownloads().catch(() => {})}
              className="shrink-0 text-xs font-semibold opacity-80 hover:opacity-100"
            >
              Open Downloads
            </button>
          )}
        </div>
      )}

      {libraryErrors.length > 0 && (
        <div className="mx-4 rounded-xl border border-amber-300 bg-amber-50 p-4 text-amber-950 dark:border-amber-500/40 dark:bg-amber-500/10 dark:text-amber-100">
          <div className="flex items-start gap-3">
            <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0" />
            <div className="min-w-0">
              <p className="font-semibold">Library refresh had trouble reaching part of Sarah.</p>
              <p className="mt-1 text-sm opacity-90">
                Saved files are not deleted. Some sections may be incomplete until the API or app shell refreshes.
              </p>
              <div className="mt-2 space-y-1 text-xs">
                {libraryErrors.map(([label, error]) => (
                  <p key={label}>
                    <span className="font-semibold">{label}:</span> {formatQueryError(error)}
                  </p>
                ))}
              </div>
            </div>
          </div>
        </div>
      )}

      {downloadableVideos.length > 0 && (
        <LibrarySection
          icon={<Video className="h-4 w-4" />}
          title="Review Videos"
          count={downloadableVideos.length}
          helper="Narrated MP4 review videos, manifests, and completed background renders."
          open={videosOpen}
          onToggle={() => setVideosOpen((value) => !value)}
        >
          <div className="grid gap-4">
            {downloadableVideos.map((video) => {
              const title = cleanVideoTitle(video);
              const created = getCreatedTimestamp(video);
              const duration = formatDuration(video.duration_seconds);
              const recordType = reviewVideoRecordType(video);
              const sourceRecord = video.session_id
                ? (recordType === "body_exploration" ? explorationsById : sessionsById).get(String(video.session_id))
                : null;
              const sessionDate = formatSessionDate(sourceRecord) || formatReviewVideoSessionDate(video.session_date || video.source_generated_at);
              const sourceRoute = recordType === "body_exploration" ? `/exploration/${video.session_id}` : `/sessions/${video.session_id}`;
              return (
                <div
                  key={video.id}
                  className="bg-card rounded-lg border border-border p-4 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between hover:shadow-md transition-shadow"
                >
                  <div className="flex-1 min-w-0">
                    <h3 className="font-semibold text-foreground truncate">
                      {sessionDate ? `${title} · ${sessionDate}` : title}
                    </h3>
                    <p className="text-xs text-primary mt-1">
                      Created {formatCreatedTimestamp(created)}
                    </p>
                    {sessionDate && (
                      <p className="text-xs text-muted-foreground mt-1">
                        {recordType === "body_exploration" ? "Body exploration" : "Source session"}: {sessionDate}
                      </p>
                    )}
                    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-xs text-muted-foreground">
                      {duration && <span>{duration}</span>}
                      {video.audio_reused != null && <span>{video.audio_reused ? "Reused narration" : "Rendered narration"}</span>}
                      {video.clip_count != null && <span>{video.clip_count} clips indexed</span>}
                      {video.cited_time_count != null && <span>{video.cited_time_count} cited moments</span>}
                      {video.visual_mode && <span>{String(video.visual_mode).replace(/_/g, " ")}</span>}
                      {video.watermark_enabled != null && <span>{video.watermark_enabled ? "Watermarked" : "No watermark"}</span>}
                      {video.watermark_preset && <span>{String(video.watermark_preset).replace(/_/g, " ")}</span>}
                    </div>
                    {video.filename && (
                      <p className="text-xs text-muted-foreground mt-2 truncate">{video.filename}</p>
                    )}
                    {video._source === "completed_review_video_job" && (
                      <p className="mt-2 rounded-md border border-amber-400/25 bg-amber-400/10 px-2 py-1 text-xs text-amber-800 dark:text-amber-100">
                        Recovered from a completed background video render. Download works; saving to SessionReviewVideo may have been interrupted.
                      </p>
                    )}
                  </div>
                  <div className="flex items-center gap-2 sm:ml-4 shrink-0">
                    {video.session_id && (
                      <Button
                        asChild
                        size="sm"
                        variant="outline"
                        className="gap-1.5"
                        title={recordType === "body_exploration" ? "Open body exploration" : "Open source session"}
                      >
                        <Link to={sourceRoute}>
                          <ExternalLink className="w-4 h-4" />
                          <span>{recordType === "body_exploration" ? "Open exploration" : "Open session"}</span>
                        </Link>
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleDownloadVideo(video)}
                      className="text-muted-foreground hover:text-foreground"
                      title="Download review video"
                    >
                      <Download className="w-4 h-4" />
                    </Button>
                    {video.manifest_url && (
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => handleDownloadManifest(video)}
                        className="text-muted-foreground hover:text-foreground"
                        title="Download review manifest"
                      >
                        <Download className="w-4 h-4" />
                        <span className="sr-only">Download review manifest</span>
                      </Button>
                    )}
                    <Button
                      size="sm"
                      variant="ghost"
                      onClick={() => handleDeleteReviewVideo(video)}
                      disabled={String(video.id || "").startsWith("job:")}
                      className="text-destructive/60 hover:text-destructive hover:bg-destructive/10"
                    >
                      <Trash2 className="w-4 h-4" />
                    </Button>
                  </div>
                </div>
              );
            })}
          </div>
        </LibrarySection>
      )}

      {downloadableExports.length === 0 && downloadableVideos.length === 0 && !libraryLoading ? (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <Music className="w-12 h-12 text-muted-foreground mb-3 opacity-50" />
          <h3 className="text-lg font-semibold text-foreground mb-1">
            {libraryErrors.length ? "Saved recordings could not load" : "No downloadable exports yet"}
          </h3>
          <p className="text-sm text-muted-foreground">
            {libraryErrors.length
              ? "Sarah still has saved media on disk and in the database, but this page could not fetch it. Try Refresh or reopen the app shell."
              : "Export TTS audio or build a review video from a session to add files to your library"}
          </p>
        </div>
      ) : downloadableExports.length > 0 ? (
        <LibrarySection
          icon={<Music className="h-4 w-4" />}
          title="Audio Exports"
          count={downloadableExports.length}
          helper="Narrated TTS exports, chapter sidecars, and recoverable completed renders."
          open={audioOpen}
          onToggle={() => setAudioOpen((value) => !value)}
        >
        <div className="grid gap-4">
          <div className="text-xs text-muted-foreground px-1">
            Showing {downloadableExports.length} most recent downloadable audio export{downloadableExports.length === 1 ? "" : "s"}.
          </div>
          {downloadableExports.map((export_) => {
            const title = cleanDisplayTitle(export_);
            const created = getCreatedTimestamp(export_);
            const duration = formatDuration(export_.duration_seconds);
            const rawTitle = String(export_.title || "").trim();
            const showRawTitle = rawTitle && rawTitle !== title && RAW_SECTION_TITLE_RE.test(rawTitle);
            return (
            <div
              key={export_.id}
              className="bg-card rounded-lg border border-border p-4 flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between hover:shadow-md transition-shadow"
            >
              <div className="flex-1 min-w-0">
                <h3 className="font-semibold text-foreground truncate">{title}</h3>
                <p className="text-xs text-primary mt-1">
                  Created {formatCreatedTimestamp(created)}
                </p>
                {export_.section_name && (
                  <p className="text-xs text-muted-foreground mt-1">{export_.section_name}</p>
                )}
                {showRawTitle && (
                  <p className="text-xs text-muted-foreground mt-1">Source ID: {rawTitle}</p>
                )}
                {export_.notes && (
                  <p className="text-sm text-muted-foreground mt-1 line-clamp-2">{export_.notes}</p>
                )}
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 mt-2 text-xs text-muted-foreground">
                  {duration && <span>{duration}</span>}
                  {export_.voice && <span>Voice: {export_.voice}</span>}
                  {export_.speed && <span>Speed: {export_.speed}x</span>}
                  {export_.format && <span>{String(export_.format).toUpperCase()}</span>}
                  {export_.sidecar_chapters_available && (
                    <span>{export_.chapter_count || 0} chapters</span>
                  )}
                </div>
                {export_.filename && (
                  <p className="text-xs text-muted-foreground mt-2 truncate">{export_.filename}</p>
                )}
                {export_._source === "completed_tts_job" && (
                  <p className="mt-2 rounded-md border border-amber-400/25 bg-amber-400/10 px-2 py-1 text-xs text-amber-100">
                    Recovered from a completed background render. Download works; saving to AudioExport was interrupted.
                  </p>
                )}
              </div>

              <div className="flex items-center gap-2 sm:ml-4 shrink-0">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => handlePlay(export_)}
                  className="text-primary hover:bg-primary/10"
                >
                  {playingId === export_.id ? (
                    <Pause className="w-4 h-4" />
                  ) : (
                    <Play className="w-4 h-4" />
                  )}
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => handleDownload(export_)}
                  className="text-muted-foreground hover:text-foreground"
                  title="Download audio"
                >
                  <Download className="w-4 h-4" />
                </Button>
                {export_.sidecar_chapters_available && (
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => handleDownloadChapters(export_)}
                    className="text-muted-foreground hover:text-foreground"
                    title="Download chapter files"
                  >
                    <Download className="w-4 h-4" />
                    <span className="sr-only">Download chapter files</span>
                  </Button>
                )}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => handleDelete(export_.id)}
                  disabled={export_._source === "completed_tts_job"}
                  className="text-destructive/60 hover:text-destructive hover:bg-destructive/10"
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            </div>
            );
          })}
        </div>
        </LibrarySection>
      ) : null}
    </div>
  );
}
