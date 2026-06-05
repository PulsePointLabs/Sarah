import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Activity, ArrowLeft, Brain, Clapperboard, MessageCircle, Pencil, ScanSearch } from "lucide-react";
import moment from "moment";
import { base44 } from "@/api/base44Client";
import PageHeader from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import HRTimelineChart from "@/components/HRTimelineChart";
import EMGTimelineChart from "@/components/EMGTimelineChart";
import BodyExplorationAIPanel from "@/components/BodyExplorationAIPanel";
import AIChat from "@/components/AIChat";
import LinkedLocalVideoManager from "@/components/LinkedLocalVideoManager";
import VideoSyncPlayer from "@/components/VideoSyncPlayer";
import {
  buildBodyExplorationVisualEvidenceDigest,
  buildBodyExplorationVideoPassDigest,
  getReviewedVisualClips,
  isVisualReviewSource,
  makeBodyExplorationVisualEvidenceEntry,
  normalizeBodyExplorationVisualEvidence,
} from "@/lib/visualEvidence";

function Info({ label, value }) {
  if (!value && value !== 0) return null;
  return <div className="border-b border-border py-2 last:border-0"><p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p><p className="mt-1 whitespace-pre-wrap text-sm text-foreground">{value}</p></div>;
}

function fmtTime(totalSeconds) {
  const value = Math.max(0, Math.round(Number(totalSeconds) || 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

function TimestampedNotes({ events }) {
  return (
    <details className="rounded-xl border border-border bg-card p-4">
      <summary className="cursor-pointer list-none">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h3 className="text-xs font-semibold uppercase tracking-wider text-primary">Timestamped Notes</h3>
            <p className="mt-1 text-xs text-muted-foreground">Observation notes for this body exploration record.</p>
          </div>
          <Badge variant="outline" className="text-[10px]">{events.length} notes</Badge>
        </div>
      </summary>
      <div className="mt-3 space-y-2">
        {events.map((event, index) => (
          <div key={`${event.time_s || 0}-${index}`} className="rounded-lg border border-border bg-muted/20 px-3 py-2">
            <div className="flex flex-wrap items-center gap-2 text-xs">
              <span className="font-mono font-semibold text-primary">{fmtTime(event.time_s)}</span>
              {(Array.isArray(event.category) ? event.category : [event.category].filter(Boolean)).map((category) => (
                <Badge key={`${index}-${category}`} variant="outline" className="text-[10px]">{String(category).replaceAll("_", " ")}</Badge>
              ))}
            </div>
            <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-foreground">{event.note}</p>
          </div>
        ))}
      </div>
    </details>
  );
}

function buildExplorationChatContext(exploration, timelineRows, emgRows) {
  const events = (exploration.event_timeline || []).map((event) => {
    const m = Math.floor(Number(event.time_s || 0) / 60);
    const sec = Math.round(Number(event.time_s || 0) % 60);
    const categories = (Array.isArray(event.category) ? event.category : [event.category].filter(Boolean))
      .map((category) => String(category).replaceAll("_", " "))
      .join(", ");
    return `[${m}:${String(sec).padStart(2, "0")}]${categories ? ` ${categories}:` : ""} ${event.note}`;
  });

  return [
    `Body exploration date: ${exploration.date?.slice(0, 10) || "undated"}`,
    `Type: ${exploration.exploration_type || "body exploration"}`,
    exploration.title ? `Title: ${exploration.title}` : null,
    exploration.duration_minutes ? `Duration: ${exploration.duration_minutes} minutes` : null,
    (exploration.methods || []).length ? `Methods: ${exploration.methods.join(", ")}` : null,
    exploration.focus_areas ? `Focus areas: ${exploration.focus_areas}` : null,
    exploration.purpose ? `Purpose / question: ${exploration.purpose}` : null,
    exploration.devices ? `Devices / setup: ${exploration.devices}` : null,
    exploration.foley_size ? `Foley: ${exploration.foley_size}${exploration.foley_type ? ` ${exploration.foley_type}` : ""}` : null,
    exploration.findings ? `Observed findings: ${exploration.findings}` : null,
    exploration.comfort_notes ? `Comfort notes: ${exploration.comfort_notes}` : null,
    exploration.sounding_notes ? `Instrumentation notes: ${exploration.sounding_notes}` : null,
    exploration.unusual_sensations ? `Unusual sensations: ${exploration.unusual_sensations}` : null,
    exploration.notes ? `Exploration notes: ${exploration.notes}` : null,
    timelineRows.length ? `Heart-rate rows available: ${timelineRows.length}; avg ${exploration.avg_hr || "unknown"} bpm; max ${exploration.max_hr || "unknown"} bpm.` : null,
    emgRows.length ? `EMG rows available: ${emgRows.length}.` : null,
    events.length ? `Timestamped notes:\n${events.join("\n")}` : null,
    buildBodyExplorationVisualEvidenceDigest(exploration),
    buildBodyExplorationVideoPassDigest(exploration),
  ].filter(Boolean).join("\n");
}

export default function BodyExplorationDetail() {
  const { id } = useParams();
  const [exploration, setExploration] = useState(null);
  const [timelineRows, setTimelineRows] = useState([]);
  const [emgRows, setEmgRows] = useState([]);
  const [userProfile, setUserProfile] = useState(null);
  const [chatMessages, setChatMessages] = useState([]);
  const [explorationNotes, setExplorationNotes] = useState("");
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      base44.entities.BodyExploration.filter({ id }),
      base44.entities.HeartRateTimeline.filter({ session: id }, "time_offset_s", 10000),
      base44.entities.EMGTimeline.filter({ session: id }, "time_s", 10000),
      base44.auth.me(),
    ]).then(([items, hr, emg, profile]) => {
      const loadedExploration = items[0] || null;
      setExploration(loadedExploration);
      setTimelineRows(hr || []);
      setEmgRows(emg || []);
      setUserProfile(profile);
      setChatMessages(loadedExploration?.ai_body_exploration?._chat_messages || []);
      setExplorationNotes(loadedExploration?.notes || "");
    }).finally(() => setLoading(false));
  }, [id]);

  if (loading) return <div className="flex h-64 items-center justify-center"><div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" /></div>;
  if (!exploration) return <div className="p-6 text-center text-muted-foreground">Body exploration record not found.</div>;
  const reviewedMediaClips = getReviewedVisualClips(exploration.ai_body_exploration?._visual_findings || []);
  const linkedLocalVideos = exploration.linked_local_videos || [];

  return (
    <div>
      <PageHeader
        title={exploration.title || exploration.exploration_type || "Body Exploration"}
        subtitle={`${exploration.date ? moment(exploration.date).format("MMM D, YYYY") : "Undated"}${exploration.duration_minutes ? ` · ${exploration.duration_minutes} minutes` : ""}`}
        icon={ScanSearch}
        action={<div className="flex gap-2"><Link to="/exploration"><Button size="sm" variant="outline" className="gap-1.5"><ArrowLeft className="h-4 w-4" /> All</Button></Link><Link to={`/exploration/${exploration.id}/edit`}><Button size="sm" className="gap-1.5"><Pencil className="h-4 w-4" /> Edit</Button></Link></div>}
      />
      <div className="space-y-4 px-4 pb-8">
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex flex-wrap gap-1.5">
            {(exploration.methods || []).map((method) => <Badge key={method} variant="secondary">{method}</Badge>)}
            {timelineRows.length > 0 && <Badge variant="outline" className="gap-1"><Activity className="h-3 w-3" /> HR</Badge>}
            {emgRows.length > 0 && <Badge variant="outline">EMG</Badge>}
          </div>
          <div className="mt-3 grid gap-4 lg:grid-cols-2">
            <div>
              <Info label="Exploration Type" value={exploration.exploration_type} />
              <Info label="Purpose / Question" value={exploration.purpose} />
              <Info label="Focus Areas" value={exploration.focus_areas} />
              <Info label="Devices / Setup" value={exploration.devices} />
              <Info label="Foley" value={exploration.foley_size ? `${exploration.foley_size}${exploration.foley_type ? ` · ${exploration.foley_type}` : ""}` : null} />
            </div>
            <div>
              <Info label="Observed Findings" value={exploration.findings} />
              <Info label="Comfort Notes" value={exploration.comfort_notes} />
              <Info label="Instrumentation Notes" value={exploration.sounding_notes} />
              <Info label="Notes" value={exploration.notes} />
            </div>
          </div>
        </div>

        {timelineRows.length > 0 && <div className="rounded-xl border border-border bg-card p-4"><h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-primary">Heart Rate Timeline</h3><HRTimelineChart rows={timelineRows} events={exploration.event_timeline || []} noClimax /></div>}
        {emgRows.length > 0 && <div className="rounded-xl border border-border bg-card p-4"><h3 className="mb-3 text-xs font-semibold uppercase tracking-wider text-primary">EMG Timeline</h3><EMGTimelineChart rows={emgRows} channelMode={exploration.emg_channels || "single"} events={exploration.event_timeline || []} timelineRows={timelineRows} /></div>}
        {(exploration.event_timeline || []).length > 0 && <TimestampedNotes events={exploration.event_timeline} />}
        <LinkedLocalVideoManager
          videos={linkedLocalVideos}
          title="Linked Original Videos"
          helper="Save local references to original body exploration recordings for review and Video Sync. The app stores the path and fingerprint metadata only; raw video is not copied into the database."
          onChange={async (nextVideos) => {
            await base44.entities.BodyExploration.update(id, { linked_local_videos: nextVideos });
            setExploration((prev) => ({ ...prev, linked_local_videos: nextVideos }));
          }}
        />
        {linkedLocalVideos.length > 0 && (
          <details className="rounded-xl border border-border bg-card p-4" open>
            <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-primary">
              Rich Linked Video Playback
            </summary>
            <p className="mt-1 text-xs text-muted-foreground">
              Play the linked original video with synchronized event notes and telemetry context.
            </p>
            <div className="mt-3">
              <VideoSyncPlayer
                key={`body-media-sync:${exploration.id}:${linkedLocalVideos.map((video) => video.fingerprint || video.path).join("|")}`}
                session={exploration}
                timelineRows={timelineRows}
                recordType="body_exploration"
              />
            </div>
          </details>
        )}
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-primary">
                <Clapperboard className="h-4 w-4" /> AI Procedure Video + Audio Passes
              </h3>
              <p className="mt-1 text-xs text-muted-foreground">
                Run and manage Sarah video/audio analysis from the central AI Annotation workbench. That page handles body explorations and sessions with the same event clearing and filtering controls.
              </p>
            </div>
            <Button asChild size="sm" variant="outline" className="gap-1.5">
              <Link to={`/ai-annotation?type=body_exploration&id=${exploration.id}`}>
                <Clapperboard className="h-4 w-4" /> Open AI Annotation
              </Link>
            </Button>
          </div>
        </div>

        <div className="rounded-xl border border-border bg-card p-4 space-y-3">
          <div>
            <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-primary">
              <MessageCircle className="h-4 w-4" /> Sarah Review Chat
            </h3>
            <p className="mt-1 text-xs text-muted-foreground">
              Ask Sarah about this exploration, attach images, or clip local video for technique, device fit, visible anatomy, positioning, and reaction review.
            </p>
          </div>
          <AIChat
            mode="session"
            visualEvidenceScope="body_exploration"
            subjectLabel="body exploration"
            userProfile={userProfile}
            scopeId={id}
            context={buildExplorationChatContext(exploration, timelineRows, emgRows)}
            savedMessages={chatMessages}
            savedNotes={explorationNotes}
            defaultOpen
            onSaveMessages={async (msgs) => {
              setChatMessages(msgs);
              let updatedAi = { ...(exploration.ai_body_exploration || {}), _chat_messages: msgs };
              setExploration((prev) => {
                if (!prev) return prev;
                updatedAi = { ...(prev.ai_body_exploration || updatedAi), _chat_messages: msgs };
                return { ...prev, ai_body_exploration: updatedAi };
              });
              await base44.entities.BodyExploration.update(id, { ai_body_exploration: updatedAi });
            }}
            onSaveNotes={async (merged, meta = {}) => {
              setExplorationNotes(merged);
              const conversation = Array.isArray(meta.conversation) ? meta.conversation : chatMessages;
              if (Array.isArray(conversation)) setChatMessages(conversation);
              const updatedAi = {
                ...(exploration.ai_body_exploration || {}),
                _chat_messages: conversation,
              };
              if (isVisualReviewSource(meta.source)) {
                const visualEntry = makeBodyExplorationVisualEvidenceEntry(meta, merged);
                updatedAi._visual_findings = normalizeBodyExplorationVisualEvidence([
                  visualEntry,
                  ...((exploration.ai_body_exploration || {})._visual_findings || []),
                ]);
              }
              setExploration((prev) => ({
                ...prev,
                notes: merged,
                ai_body_exploration: { ...(prev?.ai_body_exploration || {}), ...updatedAi },
              }));
              await base44.entities.BodyExploration.update(id, {
                notes: merged,
                ai_body_exploration: updatedAi,
              });
            }}
          />
          {reviewedMediaClips.length > 0 && (
            <details className="rounded-lg border border-border bg-muted/20 p-3">
              <summary className="cursor-pointer text-[10px] font-semibold uppercase tracking-wider text-primary">
                Sarah Reviewed Clips ({reviewedMediaClips.length})
              </summary>
              <div className="mt-3 space-y-2">
                {reviewedMediaClips.map((clip, index) => (
                  <div key={`${clip.processedClipUrl}-${index}`} className="rounded-lg border border-border bg-background/40 p-2">
                    <div className="mb-1 flex flex-wrap items-center justify-between gap-2 text-[10px] text-muted-foreground">
                      <span className="font-semibold text-primary">{clip.label || clip.filename || "Reviewed clip"}</span>
                      <span>{clip.evidenceDate || "Undated"} · {clip.startSeconds != null && clip.endSeconds != null ? `${Number(clip.startSeconds).toFixed(1)}-${Number(clip.endSeconds).toFixed(1)}s` : "trimmed clip"}</span>
                    </div>
                    <video src={clip.processedClipUrl} controls className="w-full rounded-lg bg-black" />
                  </div>
                ))}
              </div>
            </details>
          )}
        </div>

        <BodyExplorationAIPanel exploration={exploration} timelineRows={timelineRows} emgRows={emgRows} userProfile={userProfile} />
        <div className="rounded-xl border border-border bg-muted/20 p-4 text-xs text-muted-foreground">
          <p className="flex items-center gap-1.5 font-semibold uppercase tracking-wider text-primary"><Brain className="h-3.5 w-3.5" /> Standalone exploration mode</p>
          <p className="mt-2">This record does not use climax phase markers or arousal-session completion logic.</p>
        </div>
      </div>
    </div>
  );
}
