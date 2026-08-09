import { useEffect, useMemo, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Activity, ArrowLeft, Brain, Clapperboard, MessageCircle, Pencil, ScanSearch } from "lucide-react";
import moment from "moment";
import { base44 } from "@/api/base44Client";
import PageHeader from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import SessionTelemetryDashboard from "@/components/SessionTelemetryDashboard";
import PulseOxSessionChart from "@/components/PulseOxSessionChart";
import BodyCompositionSummaryCard from "@/components/BodyCompositionSummaryCard";
import BodyExplorationNearbyVitalsPanel from "@/components/BodyExplorationNearbyVitalsPanel";
import BodyExplorationAIPanel from "@/components/BodyExplorationAIPanel";
import AIChat from "@/components/AIChat";
import LinkedLocalVideoManager from "@/components/LinkedLocalVideoManager";
import RecordStoryVideoPlayer, { buildRecordStoryVideoSources } from "@/components/RecordStoryVideoPlayer";
import VideoSyncPlayer from "@/components/VideoSyncPlayer";
import { pulseOxReadingsFromSession } from "@/lib/sessionContext";
import { buildBodyExplorationPhysiologyEvidence } from "@/lib/bodyExplorationPhysiology";
import { selectNearbyVitalReadings } from "@/lib/nearbyVitals";
import { kilogramsToPounds } from "@/lib/bodyComposition";
import {
  buildBodyExplorationVisualEvidenceDigest,
  buildBodyExplorationVideoPassDigest,
  getReviewedVisualClips,
  isVisualReviewSource,
  makeBodyExplorationVisualEvidenceEntry,
  normalizeBodyExplorationVisualEvidence,
  normalizeSessionKeyVideoClips,
} from "@/lib/visualEvidence";

function Info({ label, value }) {
  if (!value && value !== 0) return null;
  return <div className="border-b border-border py-2 last:border-0"><p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p><p className="mt-1 whitespace-pre-wrap text-sm text-foreground">{value}</p></div>;
}

function fmtTime(totalSeconds) {
  const value = Math.max(0, Math.round(Number(totalSeconds) || 0));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, "0")}`;
}

function isAIGeneratedAnnotation(event) {
  return event?.source === "ai_video_pass"
    || event?.source === "ai_audio_pass"
    || event?.ai_generated === true
    || event?.annotation_origin === "ai"
    || event?.ai_annotation?.source === "sarah_video_pass"
    || event?.ai_annotation?.source === "sarah_audio_pass"
    || Boolean(event?.audio_review);
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
              {isAIGeneratedAnnotation(event) && <Badge variant="secondary" className="text-[10px]">AI generated</Badge>}
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

function buildExplorationChatContext(exploration, timelineRows, emgRows, nearbyVitals) {
  const pulseOxReadings = pulseOxReadingsFromSession(exploration);
  const spo2Values = pulseOxReadings.map((reading) => Number(reading.spo2_percent)).filter(Number.isFinite);
  const pulseValues = pulseOxReadings.map((reading) => Number(reading.pulse_bpm)).filter(Number.isFinite);
  const physiologyEvidence = buildBodyExplorationPhysiologyEvidence({ exploration, timelineRows, emgRows, nearbyVitals });
  const { high_resolution_trajectory: _trajectory, ...chatPhysiologyEvidence } = physiologyEvidence;
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
    exploration.body_composition
      ? `Attached weigh-in (${exploration.body_composition.measured_at || "time unknown"}): weight ${kilogramsToPounds(exploration.body_composition.weight_kg)?.toFixed(1) ?? "unknown"} lb, body fat ${exploration.body_composition.body_fat_percent ?? "unavailable"}%, lean mass ${kilogramsToPounds(exploration.body_composition.lean_body_mass_kg)?.toFixed(1) ?? "unavailable"} lb. Use pounds as the primary unit. Treat smart-scale composition as contextual trend estimates, not an acute effect of this exploration.`
      : null,
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
    spo2Values.length
      ? `Pulse oximetry: ${pulseOxReadings.length} samples; average SpO2 ${Math.round(spo2Values.reduce((sum, value) => sum + value, 0) / spo2Values.length)}%; minimum SpO2 ${Math.min(...spo2Values)}%${pulseValues.length ? `; average pulse ${Math.round(pulseValues.reduce((sum, value) => sum + value, 0) / pulseValues.length)} bpm` : ""}.`
      : null,
    emgRows.length ? `EMG rows available: ${emgRows.length}.` : null,
    `Measured physiology evidence and nearby imported vitals:\n${JSON.stringify(chatPhysiologyEvidence, null, 2)}`,
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
  const [nearbyVitalImports, setNearbyVitalImports] = useState({
    bloodPressure: [],
    bloodGlucose: [],
    bodyComposition: [],
    pulseOx: [],
  });
  const [userProfile, setUserProfile] = useState(null);
  const [chatMessages, setChatMessages] = useState([]);
  const [explorationNotes, setExplorationNotes] = useState("");
  const [inspectionTime, setInspectionTime] = useState(0);
  const [selectedEventIndex, setSelectedEventIndex] = useState(null);
  const [pendingTimestampReview, setPendingTimestampReview] = useState(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState("");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setLoadError("");

    (async () => {
      try {
        const items = await base44.entities.BodyExploration.filter(
          { id },
          undefined,
          1,
          undefined,
          { timeoutMs: 15000 },
        );
        if (cancelled) return;
        const loadedExploration = items[0] || null;
        setExploration(loadedExploration);
        setChatMessages(loadedExploration?.ai_body_exploration?._chat_messages || []);
        setExplorationNotes(loadedExploration?.notes || "");
        setLoading(false);
        if (!loadedExploration) return;

        const [hr, emg, profile, bloodPressure, bloodGlucose, bodyComposition, pulseOx] = await Promise.all([
          base44.entities.HeartRateTimeline.filter({ session: id }, "time_offset_s", 10000, undefined, { timeoutMs: 30000 }).catch(() => []),
          base44.entities.EMGTimeline.filter({ session: id }, "time_s", 10000, undefined, { timeoutMs: 30000 }).catch(() => []),
          base44.auth.me().catch(() => null),
          base44.entities.BloodPressureReading.list("-measured_at", 250).catch(() => []),
          base44.entities.BloodGlucoseReading.list("-measured_at", 250).catch(() => []),
          base44.entities.BodyCompositionReading.list("-measured_at", 250).catch(() => []),
          base44.entities.PulseOxReading.list("-measured_at", 5000).catch(() => []),
        ]);
        if (cancelled) return;
        setTimelineRows(hr || []);
        setEmgRows(emg || []);
        setUserProfile(profile);
        setNearbyVitalImports({ bloodPressure, bloodGlucose, bodyComposition, pulseOx });
      } catch (error) {
        if (cancelled) return;
        setExploration(null);
        setLoadError(error?.message || "Could not load this body exploration record.");
        setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [id]);

  const nearbyVitals = useMemo(
    () => selectNearbyVitalReadings(exploration || {}, nearbyVitalImports),
    [exploration, nearbyVitalImports],
  );

  const explorationForTelemetry = useMemo(() => {
    if (!exploration) return null;
    const attached = pulseOxReadingsFromSession(exploration);
    const during = (nearbyVitals.pulseOx || [])
      .filter((reading) => reading.relationship === "during exploration")
      .map((reading) => ({ ...reading, time_offset_s: Number(reading.delta_minutes) * 60 }));
    if (!during.length) return exploration;
    return { ...exploration, pulse_ox_readings: [...attached, ...during] };
  }, [exploration, nearbyVitals]);

  const linkedLocalVideos = useMemo(
    () => exploration?.linked_local_videos || [],
    [exploration?.linked_local_videos],
  );
  const uploadedExplorationVideos = useMemo(
    () => (Array.isArray(exploration?.media_videos) ? exploration.media_videos.filter(Boolean) : []),
    [exploration?.media_videos],
  );
  const explorationVideoSources = useMemo(
    () => buildRecordStoryVideoSources({
      linkedVideos: linkedLocalVideos,
      uploadedVideos: uploadedExplorationVideos,
      recordLabel: "body exploration",
    }),
    [linkedLocalVideos, uploadedExplorationVideos],
  );

  if (loading) return <div className="flex h-64 items-center justify-center"><div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" /></div>;
  if (loadError) return <div className="p-6 text-center text-destructive">Could not load this body exploration record: {loadError}</div>;
  if (!exploration) return <div className="p-6 text-center text-muted-foreground">Body exploration record not found.</div>;
  const reviewedMediaClips = getReviewedVisualClips(exploration.ai_body_exploration?._visual_findings || []);
  const pulseOxReadings = pulseOxReadingsFromSession(explorationForTelemetry || exploration);
  const nearbyVitalCount = nearbyVitals.bloodPressure.length
    + nearbyVitals.bloodGlucose.length
    + nearbyVitals.bodyComposition.length
    + nearbyVitals.pulseOx.length;
  const handleAskSarahAtTimestamp = ({
    timeSeconds,
    sourceUrl,
    sourcePath = "",
    timelineOffsetSeconds = 0,
    sourceLabel = "Body exploration video",
    sourceKind = "body_exploration_video",
  }) => {
    if (!sourceUrl && !sourcePath) return;
    setPendingTimestampReview({
      requestId: `body-exploration-video-review-${Date.now()}-${Math.random().toString(16).slice(2)}`,
      timeSeconds: Math.max(0, Number(timeSeconds) || 0),
      sourceUrl,
      sourcePath,
      timelineOffsetSeconds: Number(timelineOffsetSeconds) || 0,
      sourceLabel,
      sourceKind,
    });
    window.requestAnimationFrame(() => {
      document.getElementById("body-exploration-sarah-chat")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  };

  return (
    <div>
      <PageHeader
        title={exploration.title || exploration.exploration_type || "Body Exploration"}
        subtitle={`${exploration.date ? moment(exploration.date).format("MMM D, YYYY") : "Undated"}${exploration.duration_minutes ? ` · ${exploration.duration_minutes} minutes` : ""}`}
        icon={ScanSearch}
        action={<div className="flex flex-wrap gap-2"><Link to="/exploration"><Button size="sm" variant="outline" className="gap-1.5"><ArrowLeft className="h-4 w-4" /> All</Button></Link><Link to={`/review-player?type=body_exploration&exploration=${encodeURIComponent(exploration.id)}`}><Button size="sm" variant="outline" className="gap-1.5"><Clapperboard className="h-4 w-4" /> Review</Button></Link><Link to={`/exploration/${exploration.id}/edit`}><Button size="sm" className="gap-1.5"><Pencil className="h-4 w-4" /> Edit</Button></Link></div>}
      />
      <div className="space-y-4 px-4 pb-8">
        <div className="rounded-xl border border-border bg-card p-4">
          <div className="flex flex-wrap gap-1.5">
            {(exploration.methods || []).map((method) => <Badge key={method} variant="secondary">{method}</Badge>)}
            {timelineRows.length > 0 && <Badge variant="outline" className="gap-1"><Activity className="h-3 w-3" /> HR</Badge>}
            {emgRows.length > 0 && <Badge variant="outline">EMG</Badge>}
            {pulseOxReadings.length > 0 && <Badge variant="outline">SpO2</Badge>}
            {nearbyVitalCount > 0 && <Badge variant="outline">Nearby vitals {nearbyVitalCount.toLocaleString()}</Badge>}
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

        <SessionTelemetryDashboard
          session={explorationForTelemetry || exploration}
          timelineRows={timelineRows}
          emgRows={emgRows}
          inspectionTime={inspectionTime}
          onInspectionTimeChange={setInspectionTime}
          selectedEventIndex={selectedEventIndex}
          onSelectEventIndex={(index) => {
            setSelectedEventIndex(index);
            const eventTime = Number(exploration.event_timeline?.[index]?.time_s);
            if (Number.isFinite(eventTime)) setInspectionTime(eventTime);
          }}
          recordType="body_exploration"
        />
        <BodyExplorationNearbyVitalsPanel nearbyVitals={nearbyVitals} />
        {exploration.body_composition && (
          <BodyCompositionSummaryCard reading={exploration.body_composition} title="Exploration Weigh-In" />
        )}
        {pulseOxReadings.length > 0 && (
          <PulseOxSessionChart session={explorationForTelemetry || exploration} sectionId="body-exploration-pulse-ox" />
        )}
        {pulseOxReadings.length === 0 && (
          <section id="body-exploration-pulse-ox" className="scroll-mt-24 rounded-xl border border-border bg-card p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-primary">
                  <Activity className="h-3.5 w-3.5" /> Pulse Oximetry
                </h3>
                <p className="mt-1 text-sm text-muted-foreground">
                  No SpO2 readings are saved for this exploration. Import the EMAY pulse-ox CSV from the Pulse Oximetry section in Edit.
                </p>
              </div>
              <Button asChild size="sm" variant="outline" className="shrink-0">
                <Link to={`/exploration/${exploration.id}/edit#pulse-ox`}>Import SpO2</Link>
              </Button>
            </div>
          </section>
        )}

        {explorationVideoSources.length > 0 && (
          <RecordStoryVideoPlayer
            linkedVideos={linkedLocalVideos}
            uploadedVideos={uploadedExplorationVideos}
            recordLabel="body exploration"
            sectionId="body-exploration-story-video"
            onAskSarahAtTimestamp={handleAskSarahAtTimestamp}
          />
        )}

        <section className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-sm font-semibold text-foreground">Sarah review</h2>
              <p className="text-xs text-muted-foreground">Analysis and annotation tools are up here so the record is useful immediately.</p>
            </div>
            <Button asChild size="sm" variant="outline" className="gap-1.5">
              <Link to={`/ai-annotation?type=body_exploration&id=${exploration.id}`}>
                <Clapperboard className="h-4 w-4" /> Open AI Annotation
              </Link>
            </Button>
          </div>
          <BodyExplorationAIPanel exploration={exploration} timelineRows={timelineRows} emgRows={emgRows} nearbyVitals={nearbyVitals} userProfile={userProfile} />
        </section>

        <div id="body-exploration-sarah-chat" className="scroll-mt-24 space-y-3 rounded-xl border border-border bg-card p-4">
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
            context={buildExplorationChatContext(exploration, timelineRows, emgRows, nearbyVitals)}
            savedVideoClips={normalizeSessionKeyVideoClips(exploration)}
            sessionVideoSources={explorationVideoSources}
            pendingTimestampReview={pendingTimestampReview}
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

        <section className="space-y-3">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Media, telemetry, and notes</h2>
            <p className="text-xs text-muted-foreground">Original evidence and long timelines stay available without pushing Sarah's analysis to the bottom.</p>
          </div>
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
            <details className="rounded-xl border border-border bg-card p-4">
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
          {(exploration.event_timeline || []).length > 0 && <TimestampedNotes events={exploration.event_timeline} />}
        </section>

        <div className="rounded-xl border border-border bg-muted/20 p-4 text-xs text-muted-foreground">
          <p className="flex items-center gap-1.5 font-semibold uppercase tracking-wider text-primary"><Brain className="h-3.5 w-3.5" /> Standalone exploration mode</p>
          <p className="mt-2">This record does not use climax phase markers or arousal-session completion logic.</p>
        </div>
      </div>
    </div>
  );
}
