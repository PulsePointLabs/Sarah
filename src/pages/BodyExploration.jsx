import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate } from "react-router-dom";
import { Activity, ArrowRight, Pencil, Plus, ScanSearch, Trash2, Video } from "lucide-react";
import moment from "moment";
import { base44 } from "@/api/base44Client";
import PageHeader from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import { serverUrl } from "@/lib/mobileApiBase";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

const REVIEW_VIDEO_FIELDS = [
  "id",
  "title",
  "analysis_title",
  "file_url",
  "video_url",
  "filename",
  "duration_seconds",
  "session_id",
  "record_type",
  "exported_at",
  "created_date",
];

function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  if (!total) return "";
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  return hours
    ? `${hours}:${String(minutes).padStart(2, "0")}:${String(remainder).padStart(2, "0")}`
    : `${minutes}:${String(remainder).padStart(2, "0")}`;
}

function reviewVideoUrl(reviewVideo) {
  const raw = reviewVideo?.file_url || reviewVideo?.video_url || "";
  if (!raw) return "";
  const url = serverUrl(raw);
  const version = reviewVideo?.exported_at || reviewVideo?.created_date || reviewVideo?.filename || "latest";
  return `${url}${url.includes("?") ? "&" : "?"}v=${encodeURIComponent(version)}`;
}

function ExplorationCard({ exploration, reviewVideo, onDelete }) {
  const navigate = useNavigate();
  const dateLabel = exploration.date ? moment(exploration.date).format("MMM D, YYYY") : "Undated";
  const title = exploration.title || exploration.exploration_type || "Body Exploration";
  const openDetail = () => navigate(`/exploration/${exploration.id}`);
  const openEdit = (event) => {
    event.stopPropagation();
    navigate(`/exploration/${exploration.id}/edit`);
  };
  const handleKeyDown = (event) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openDetail();
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={openDetail}
      onKeyDown={handleKeyDown}
      className="block cursor-pointer rounded-xl border border-border bg-card p-4 text-left transition-colors hover:border-primary/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/70"
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="truncate text-sm font-semibold text-foreground">{title}</p>
          <p className="mt-1 text-xs text-muted-foreground">
            {dateLabel}
            {exploration.start_time ? ` · ${exploration.start_time}` : ""}
            {exploration.duration_minutes ? ` · ${exploration.duration_minutes}m` : ""}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            aria-label={`Edit ${title}`}
            title="Edit exploration"
            onClick={openEdit}
            className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-primary/10 hover:text-primary"
          >
            <Pencil className="h-3.5 w-3.5" />
          </button>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <button
                type="button"
                aria-label={`Delete ${title}`}
                title="Delete exploration"
                onClick={(event) => event.stopPropagation()}
                className="rounded-md p-1.5 text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive"
              >
                <Trash2 className="h-3.5 w-3.5" />
              </button>
            </AlertDialogTrigger>
            <AlertDialogContent onClick={(event) => event.stopPropagation()}>
              <AlertDialogHeader>
                <AlertDialogTitle>Delete this body exploration?</AlertDialogTitle>
                <AlertDialogDescription>
                  {title} from {dateLabel} will be permanently removed. This cannot be undone.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  onClick={() => onDelete(exploration)}
                  className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                >
                  Delete exploration
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
          <ArrowRight className="ml-1 h-4 w-4 text-muted-foreground" />
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-1.5">
        {(exploration.methods || []).slice(0, 4).map((method) => <Badge key={method} variant="secondary" className="text-[10px]">{method}</Badge>)}
        {exploration.avg_hr || exploration.max_hr ? <Badge variant="outline" className="gap-1 text-[10px]"><Activity className="h-3 w-3" /> HR</Badge> : null}
        {exploration.emg_enabled ? <Badge variant="outline" className="text-[10px]">EMG</Badge> : null}
        {reviewVideo ? <Badge variant="outline" className="gap-1 text-[10px]"><Video className="h-3 w-3" /> Review video ready</Badge> : null}
      </div>
      {(exploration.findings || exploration.notes) && <p className="mt-3 line-clamp-2 text-xs leading-5 text-foreground/80">{exploration.findings || exploration.notes}</p>}
      {reviewVideo && (
        <div
          className="mt-4 overflow-hidden rounded-lg border border-border bg-black"
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <div className="flex items-center justify-between gap-3 bg-background px-3 py-2 text-xs">
            <span className="min-w-0 truncate font-semibold text-foreground">
              {reviewVideo.analysis_title || reviewVideo.title || "AI body exploration review"}
            </span>
            {formatDuration(reviewVideo.duration_seconds) && (
              <span className="shrink-0 font-mono text-muted-foreground">{formatDuration(reviewVideo.duration_seconds)}</span>
            )}
          </div>
          <video
            key={reviewVideo.id}
            src={reviewVideoUrl(reviewVideo)}
            controls
            preload="metadata"
            playsInline
            className="aspect-video w-full bg-black object-contain"
          />
        </div>
      )}
    </div>
  );
}

export default function BodyExploration() {
  const [items, setItems] = useState(null);
  const [reviewVideos, setReviewVideos] = useState([]);
  const { toast } = useToast();

  useEffect(() => {
    Promise.all([
      base44.entities.BodyExploration.list("-date", 100),
      base44.entities.SessionReviewVideo.listFields(REVIEW_VIDEO_FIELDS, "-created_date", 125).catch(() => []),
    ])
      .then(([explorations, videos]) => {
        setItems(explorations);
        setReviewVideos(videos);
      })
      .catch(() => {
        setItems([]);
        setReviewVideos([]);
      });
  }, []);

  const latestReviewVideoByExploration = useMemo(() => {
    const explorationIds = new Set((items || []).map((item) => String(item.id)));
    const videosByExploration = new Map();
    for (const video of reviewVideos) {
      const explorationId = String(video?.session_id || "");
      if (!explorationIds.has(explorationId) || videosByExploration.has(explorationId)) continue;
      if (!video?.file_url && !video?.video_url) continue;
      videosByExploration.set(explorationId, video);
    }
    return videosByExploration;
  }, [items, reviewVideos]);

  const deleteExploration = async (exploration) => {
    try {
      await base44.entities.BodyExploration.delete(exploration.id);
      setItems((current) => (current || []).filter((item) => item.id !== exploration.id));
      toast({ title: "Body exploration deleted", duration: 2000 });
    } catch (error) {
      toast({ title: `Delete failed: ${error.message}`, variant: "destructive" });
    }
  };

  return (
    <div>
      <PageHeader
        title="Body Exploration"
        subtitle="Instrumentation, body mapping, and non-climax physiological experimentation"
        icon={ScanSearch}
        action={<Link to="/exploration/new"><Button size="sm" className="gap-1.5"><Plus className="h-4 w-4" /> New</Button></Link>}
      />
      <div className="space-y-3 px-4 pb-8">
        <div className="rounded-xl border border-border bg-card p-4">
          <p className="text-sm text-foreground">
            Track body exploration and instrumentation records separately from climax-oriented sessions while keeping heart-rate data, optional EMG, notes, and AI findings available.
          </p>
        </div>
        {!items && <div className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">Loading exploration records...</div>}
        {items?.length === 0 && <div className="rounded-xl border border-border bg-card p-6 text-sm text-muted-foreground">No body exploration records yet.</div>}
        <div className="grid gap-3 lg:grid-cols-2">
          {(items || []).map((item) => (
            <ExplorationCard
              key={item.id}
              exploration={item}
              reviewVideo={latestReviewVideoByExploration.get(String(item.id))}
              onDelete={deleteExploration}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
