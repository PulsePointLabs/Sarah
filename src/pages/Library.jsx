import { useMemo, useState } from "react";
import { base44 } from "@/api/base44Client";
import { serverUrl } from "@/lib/mobileApiBase";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Play, Pause, Download, Trash2, Music } from "lucide-react";
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
const RECENT_AUDIO_LIMIT = 75;

const getRawAudioUrl = (export_) => (
  export_?.file_url ||
  export_?.audio_url ||
  export_?.download_url ||
  export_?.url ||
  ""
);

const getAudioUrl = (export_) => serverUrl(getRawAudioUrl(export_));

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

  const { data: exports = [], isLoading } = useQuery({
    queryKey: ["audioExports"],
    queryFn: () => base44.entities.AudioExport.list("-created_date", 250),
  });

  const downloadableExports = useMemo(() => (
    exports
      .filter((export_) => Boolean(getRawAudioUrl(export_)))
      .sort((a, b) => timestampMs(b) - timestampMs(a))
      .slice(0, RECENT_AUDIO_LIMIT)
  ), [exports]);

  const deleteExport = useMutation({
    mutationFn: (id) => base44.entities.AudioExport.delete(id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: ["audioExports"] }),
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

  const handleDownload = (export_) => {
    const url = getAudioUrl(export_);
    if (!url) return;
    const a = document.createElement("a");
    a.href = url;
    a.download = buildAudioExportFilename({
      title: cleanDisplayTitle(export_),
      sessionDate: export_.session_date || getCreatedTimestamp(export_),
      extension: getDownloadExtension(export_),
    });
    a.click();
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
        const a = document.createElement("a");
        a.href = entry.url;
        a.download = `${baseFilename}${entry.suffix}`;
        a.click();
      }, index * 120);
    });
  };

  const handleDelete = (id) => {
    if (confirm("Delete this audio export?")) {
      deleteExport.mutate(id);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-96">
        <div className="w-8 h-8 border-4 border-slate-200 border-t-slate-800 rounded-full animate-spin"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <PageHeader
        title="Audio Library"
        subtitle="Manage your TTS exports and past downloads"
      />

      {downloadableExports.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-12 text-center">
          <Music className="w-12 h-12 text-muted-foreground mb-3 opacity-50" />
          <h3 className="text-lg font-semibold text-foreground mb-1">No downloadable audio exports yet</h3>
          <p className="text-sm text-muted-foreground">
            Export TTS audio from a session to add files to your library
          </p>
        </div>
      ) : (
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
                  className="text-destructive/60 hover:text-destructive hover:bg-destructive/10"
                >
                  <Trash2 className="w-4 h-4" />
                </Button>
              </div>
            </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
