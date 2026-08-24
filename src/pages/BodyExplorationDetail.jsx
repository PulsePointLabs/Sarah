import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { Activity, ArrowLeft, Brain, Clock, Clapperboard, FileText, Gauge, HeartPulse, ListChecks, MessageCircle, Pencil, ScanSearch, Star, Timer, Trash2 } from "lucide-react";
import moment from "moment";
import { base44 } from "@/api/base44Client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import SessionTelemetryDashboard from "@/components/SessionTelemetryDashboard";
import SessionSectionNavigator from "@/components/SessionSectionNavigator";
import PulseOxSessionChart from "@/components/PulseOxSessionChart";
import BodyCompositionSummaryCard from "@/components/BodyCompositionSummaryCard";
import BodyExplorationNearbyVitalsPanel from "@/components/BodyExplorationNearbyVitalsPanel";
import BodyExplorationAIPanel from "@/components/BodyExplorationAIPanel";
import AIChat from "@/components/AIChat";
import LinkedLocalVideoManager from "@/components/LinkedLocalVideoManager";
import RecordStoryVideoPlayer, { buildRecordStoryVideoSources } from "@/components/RecordStoryVideoPlayer";
import VideoSyncPlayer from "@/components/VideoSyncPlayer";
import { connectDuringPulseOxReadings, pulseOxReadingsFromSession } from "@/lib/sessionContext";
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

function NarrativeField({ label, value }) {
  if (!value && value !== 0) return null;
  return (
    <div className="border-b border-border/70 py-3 last:border-0">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-1 max-w-5xl whitespace-pre-wrap text-sm leading-relaxed text-foreground">{value}</p>
    </div>
  );
}

function formatDuration(seconds) {
  if (!Number.isFinite(Number(seconds))) return "--";
  const rounded = Math.max(0, Math.round(Number(seconds)));
  const minutes = Math.floor(rounded / 60);
  const remainder = rounded % 60;
  return minutes ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

function formatStatus(value) {
  if (!value) return "Saved";
  return String(value).replaceAll("_", " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function formatFoley(size, type) {
  const rawSize = String(size || "").trim();
  const displaySize = rawSize && !/\bfr(?:ench)?\b/i.test(rawSize) ? `${rawSize} Fr` : rawSize;
  return [displaySize, type].filter(Boolean).join(" · ");
}

function SnapshotMetric({ icon: Icon, label, value, tone = "text-foreground" }) {
  return (
    <div className="min-w-0 rounded-xl border border-border bg-card/70 p-3">
      <div className="flex items-center gap-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
        <Icon className="h-3.5 w-3.5 shrink-0" />
        <span className="truncate">{label}</span>
      </div>
      <p className={`mt-2 truncate font-mono text-xl font-bold ${tone}`}>{value ?? "--"}</p>
    </div>
  );
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
  const navigate = useNavigate();
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
  const [activeSectionId, setActiveSectionId] = useState("exploration-snapshot");

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
    return connectDuringPulseOxReadings(exploration, nearbyVitals, "exploration");
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

  const scrollToSection = (section) => {
    setActiveSectionId(section.id);
    const element = document.getElementById(section.id);
    if (element instanceof HTMLDetailsElement) element.open = true;
    window.requestAnimationFrame(() => element?.scrollIntoView({ behavior: "smooth", block: "start", inline: "nearest" }));
  };

  const handleDelete = async () => {
    await base44.entities.BodyExploration.delete(id);
    navigate("/exploration");
  };

  const toggleFavorite = async () => {
    const next = !exploration.is_favorite;
    await base44.entities.BodyExploration.update(id, { is_favorite: next });
    setExploration((current) => ({ ...current, is_favorite: next }));
  };

  if (loading) return <div className="flex h-64 items-center justify-center"><div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" /></div>;
  if (loadError) return <div className="p-6 text-center text-destructive">Could not load this body exploration record: {loadError}</div>;
  if (!exploration) return <div className="p-6 text-center text-muted-foreground">Body exploration record not found.</div>;
  const reviewedMediaClips = getReviewedVisualClips(exploration.ai_body_exploration?._visual_findings || []);
  const pulseOxReadings = pulseOxReadingsFromSession(explorationForTelemetry || exploration);
  const nearbyVitalCount = nearbyVitals.bloodPressure.length
    + nearbyVitals.bloodGlucose.length
    + nearbyVitals.bodyComposition.length
    + nearbyVitals.pulseOx.length;
  const durationSeconds = Number.isFinite(Number(exploration.capture_wall_duration_seconds))
    ? Number(exploration.capture_wall_duration_seconds)
    : Number.isFinite(Number(exploration.duration_minutes))
      ? Number(exploration.duration_minutes) * 60
      : null;
  const pausedSeconds = Number.isFinite(Number(exploration.capture_paused_duration_seconds))
    ? Number(exploration.capture_paused_duration_seconds)
    : 0;
  const activeDurationSeconds = Number.isFinite(Number(exploration.capture_active_duration_seconds))
    ? Number(exploration.capture_active_duration_seconds)
    : durationSeconds != null
      ? Math.max(0, durationSeconds - pausedSeconds)
      : null;
  const pulseOxValues = pulseOxReadings
    .map((reading) => Number(reading.spo2_percent ?? reading.spo2 ?? reading.oxygen_saturation))
    .filter(Number.isFinite);
  const averageSpo2 = exploration.avg_spo2_percent ?? (pulseOxValues.length
    ? Math.round((pulseOxValues.reduce((sum, value) => sum + value, 0) / pulseOxValues.length) * 10) / 10
    : null);
  const latestBloodPressure = exploration.latest_blood_pressure_reading
    || exploration.session_context?.blood_pressure
    || nearbyVitals.bloodPressure.find((reading) => reading.relationship === "during exploration")
    || null;
  const bloodPressureText = latestBloodPressure
    ? `${latestBloodPressure.systolic_mm_hg ?? latestBloodPressure.systolic}/${latestBloodPressure.diastolic_mm_hg ?? latestBloodPressure.diastolic} mmHg`
    : "--";
  const hasProcedureDetails = Boolean(exploration.devices || exploration.foley_size || exploration.foley_type || exploration.sounding_notes || (exploration.methods || []).length);
  const hasFindings = Boolean(exploration.findings || exploration.comfort_notes || exploration.unusual_sensations);
  const sectionLinks = [
    { id: "exploration-snapshot", label: "Exploration Snapshot", group: "Overview" },
    { id: "exploration-record", label: "Record Details", group: "Overview" },
    { id: "session-telemetry", label: "Physiology Dashboard", group: "Physiology" },
    ...(nearbyVitalCount ? [{ id: "body-exploration-nearby-vitals", label: "Nearby Vitals", group: "Physiology" }] : []),
    { id: "body-exploration-pulse-ox", label: "Pulse Oximetry", group: "Physiology" },
    ...(explorationVideoSources.length ? [{ id: "body-exploration-story-video", label: "Exploration Video", group: "Review" }] : []),
    { id: "exploration-ai-review", label: "Sarah Review", group: "Review" },
    { id: "body-exploration-sarah-chat", label: "Ask Sarah", group: "Review" },
    { id: "exploration-media", label: "Media & Notes", group: "Evidence" },
  ];
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
    <div className="w-full max-w-[100vw] overflow-x-hidden overscroll-x-none">
      <div className="flex max-w-full min-w-0 flex-wrap items-center gap-2 px-3 pt-4 md:px-4">
        <Button variant="ghost" size="icon" onClick={() => navigate(-1)} className="shrink-0" aria-label="Back">
          <ArrowLeft className="h-5 w-5" />
        </Button>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-lg font-bold">{exploration.title || exploration.exploration_type || "Body Exploration"}</h1>
          <p className="flex min-w-0 flex-wrap items-center gap-1 text-sm text-muted-foreground">
            <ScanSearch className="h-3.5 w-3.5" />
            {exploration.date ? moment(exploration.date).format("MMM D, YYYY") : "Undated"}
            {exploration.start_time && <><Clock className="ml-1 h-3 w-3" />{exploration.start_time}</>}
            {exploration.end_time && ` – ${exploration.end_time}`}
            {durationSeconds != null && <> · <strong>{formatDuration(durationSeconds)}</strong></>}
          </p>
        </div>
        <Button variant="ghost" size="icon" onClick={() => navigate(`/exploration/${exploration.id}/edit`)} className="shrink-0" aria-label="Edit exploration">
          <Pencil className="h-5 w-5 text-muted-foreground" />
        </Button>
        <Button variant="outline" size="sm" className="gap-1.5" onClick={() => navigate(`/review-player?type=body_exploration&exploration=${encodeURIComponent(exploration.id)}&display=focus`)}>
          <Clapperboard className="h-3.5 w-3.5" /> Telemetry Theater
        </Button>
        <Button variant="ghost" size="icon" onClick={toggleFavorite} className="shrink-0" aria-label={exploration.is_favorite ? "Remove favorite" : "Add favorite"}>
          <Star className={`h-5 w-5 ${exploration.is_favorite ? "fill-yellow-500 text-yellow-500" : "text-muted-foreground"}`} />
        </Button>
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="ghost" size="icon" className="shrink-0" aria-label="Delete exploration"><Trash2 className="h-5 w-5 text-destructive" /></Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Delete body exploration?</AlertDialogTitle>
              <AlertDialogDescription>This permanently removes this record. Linked original video files are not deleted.</AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction onClick={handleDelete} className="bg-destructive text-destructive-foreground">Delete</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>

      <SessionSectionNavigator
        sections={sectionLinks}
        onSelect={scrollToSection}
        activeSectionId={activeSectionId}
        title="Exploration Sections"
        description="Move through this body exploration without losing the thread."
      />

      <div className="min-w-0 max-w-full space-y-4 overflow-x-hidden px-3 py-4 pb-24 md:px-4 xl:pr-60 [overflow-wrap:anywhere]">
        <section id="exploration-snapshot" className="scroll-mt-24 space-y-3 rounded-2xl border border-primary/20 bg-gradient-to-br from-primary/[0.08] via-card to-card p-4">
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-[0.2em] text-primary">Exploration Snapshot</p>
              <h2 className="mt-1 text-lg font-semibold text-foreground">What was captured at a glance</h2>
            </div>
            <Badge variant="outline" className="capitalize">{formatStatus(exploration.capture_status)}</Badge>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
            <SnapshotMetric icon={Timer} label="Duration" value={durationSeconds != null ? formatDuration(durationSeconds) : "--"} tone="text-primary" />
            <SnapshotMetric icon={HeartPulse} label="Average HR" value={exploration.avg_hr != null ? `${exploration.avg_hr} bpm` : "--"} />
            <SnapshotMetric icon={HeartPulse} label="Peak HR" value={exploration.max_hr != null ? `${exploration.max_hr} bpm` : "--"} tone="text-rose-400" />
            <SnapshotMetric icon={Gauge} label="Blood Pressure" value={bloodPressureText} />
            <SnapshotMetric icon={Activity} label="Average SpO2" value={averageSpo2 != null ? `${averageSpo2}%` : "--"} tone="text-cyan-400" />
            <SnapshotMetric icon={ListChecks} label="Events" value={(exploration.event_timeline || []).length} />
            <SnapshotMetric icon={Clock} label="Active Time" value={activeDurationSeconds != null ? formatDuration(activeDurationSeconds) : "--"} />
            <SnapshotMetric icon={Clock} label="Pause Time" value={pausedSeconds > 0 ? formatDuration(pausedSeconds) : "None"} />
            <SnapshotMetric icon={Activity} label="HR Samples" value={timelineRows.length ? timelineRows.length.toLocaleString() : "--"} />
            <SnapshotMetric icon={Activity} label="EMG Samples" value={emgRows.length ? emgRows.length.toLocaleString() : exploration.emg_enabled ? "Pending" : "--"} />
            <SnapshotMetric icon={Activity} label="SpO2 Samples" value={pulseOxReadings.length ? pulseOxReadings.length.toLocaleString() : "--"} />
            <SnapshotMetric icon={FileText} label="Methods" value={(exploration.methods || []).length || "--"} />
          </div>
          <div className="flex flex-wrap gap-1.5 border-t border-border/60 pt-3">
            {exploration.exploration_type && <Badge variant="secondary">{exploration.exploration_type}</Badge>}
            {(exploration.methods || []).map((method) => <Badge key={method} variant="secondary">{method}</Badge>)}
            {(exploration.tags || []).map((tag) => <Badge key={tag} variant="outline">{tag}</Badge>)}
            {timelineRows.length > 0 && <Badge variant="outline" className="gap-1"><Activity className="h-3 w-3" /> HR</Badge>}
            {emgRows.length > 0 && <Badge variant="outline">EMG</Badge>}
            {pulseOxReadings.length > 0 && <Badge variant="outline">SpO2</Badge>}
            {nearbyVitalCount > 0 && <Badge variant="outline">Nearby vitals {nearbyVitalCount.toLocaleString()}</Badge>}
          </div>
        </section>

        <section id="exploration-record" className="scroll-mt-24 space-y-3">
          <details className="rounded-xl border border-border bg-card p-4" open>
            <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-primary">Purpose & Focus</summary>
            <div className="mt-2">
              <NarrativeField label="Purpose / Question" value={exploration.purpose} />
              <NarrativeField label="Focus Areas" value={exploration.focus_areas} />
              {!exploration.purpose && !exploration.focus_areas && <p className="py-3 text-sm text-muted-foreground">No purpose or focus notes are saved yet.</p>}
            </div>
          </details>

          {hasProcedureDetails && (
            <details className="rounded-xl border border-border bg-card p-4">
              <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-primary">Methods, Devices & Setup</summary>
              <div className="mt-2">
                {(exploration.methods || []).length > 0 && <div className="flex flex-wrap gap-1.5 py-2">{exploration.methods.map((method) => <Badge key={method} variant="secondary">{method}</Badge>)}</div>}
                <NarrativeField label="Devices / Setup" value={exploration.devices} />
                <NarrativeField label="Foley" value={formatFoley(exploration.foley_size, exploration.foley_type)} />
                <NarrativeField label="Instrumentation Notes" value={exploration.sounding_notes} />
              </div>
            </details>
          )}

          {hasFindings && (
            <details className="rounded-xl border border-border bg-card p-4" open>
              <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-primary">Findings & Tolerance</summary>
              <div className="mt-2">
                <NarrativeField label="Observed Findings" value={exploration.findings} />
                <NarrativeField label="Comfort Notes" value={exploration.comfort_notes} />
                <NarrativeField label="Unusual Sensations" value={exploration.unusual_sensations} />
              </div>
            </details>
          )}

          {exploration.notes && (
            <details className="rounded-xl border border-border bg-card p-4">
              <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-primary">Additional Notes</summary>
              <div className="mt-2"><NarrativeField label="Notes" value={exploration.notes} /></div>
            </details>
          )}

          {(exploration.capture_source || exploration.hr_source_label || exploration.capture_wall_duration_seconds != null) && (
            <details className="rounded-xl border border-border bg-card p-4">
              <summary className="cursor-pointer text-xs font-semibold uppercase tracking-wider text-primary">Capture Provenance</summary>
              <div className="mt-2 grid gap-x-6 md:grid-cols-2">
                <NarrativeField label="Capture Source" value={exploration.capture_source} />
                <NarrativeField label="Heart Rate Source" value={exploration.hr_source_label || exploration.hr_source} />
                <NarrativeField label="Capture Status" value={formatStatus(exploration.capture_status)} />
                <NarrativeField label="Wall Time" value={exploration.capture_wall_duration_seconds != null ? formatDuration(exploration.capture_wall_duration_seconds) : null} />
              </div>
            </details>
          )}
        </section>

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

        <section id="exploration-ai-review" className="scroll-mt-24 space-y-3">
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

        <section id="exploration-media" className="scroll-mt-24 space-y-3">
          <div>
            <h2 className="text-sm font-semibold text-foreground">Media, telemetry, and notes</h2>
            <p className="text-xs text-muted-foreground">Original evidence and long timelines stay available without pushing Sarah's analysis to the bottom.</p>
          </div>
          {(exploration.media_images || []).length > 0 && (
            <div className="rounded-xl border border-border bg-card p-4">
              <p className="mb-3 text-xs font-semibold uppercase tracking-wider text-primary">Saved Images</p>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-4">
                {exploration.media_images.map((url, index) => (
                  <a key={`${url}-${index}`} href={url} target="_blank" rel="noreferrer" className="overflow-hidden rounded-lg border border-border bg-muted/20">
                    <img src={url} alt={`Body exploration evidence ${index + 1}`} className="aspect-square h-full w-full object-cover transition-transform hover:scale-[1.02]" />
                  </a>
                ))}
              </div>
            </div>
          )}
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
