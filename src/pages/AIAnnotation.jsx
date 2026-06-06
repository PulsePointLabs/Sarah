import { useEffect, useMemo, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { ArrowLeft, Clapperboard, Loader2, ScanSearch, Sparkles, Trash2 } from "lucide-react";
import moment from "moment";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
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
import AIVideoPassPanel from "../components/AIVideoPassPanel";
import LinkedLocalVideoManager from "../components/LinkedLocalVideoManager";

function recordLabel(record, type = "session") {
  if (!record) return type === "body_exploration" ? "Select a body exploration" : "Select a session";
  const date = record.date ? moment(record.date).format("MMM D, YYYY") : "Undated";
  const time = type === "session" && record.start_time ? ` ${record.start_time}` : "";
  const title = type === "body_exploration" ? ` · ${record.title || record.exploration_type || "Body exploration"}` : "";
  const duration = record.duration_minutes ? ` · ${record.duration_minutes}m` : "";
  const videoCount = (record.linked_local_videos || []).length ? ` · ${record.linked_local_videos.length} linked` : "";
  return `${date}${time}${title}${duration}${videoCount}`;
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

function clearAIPassAnalysis(record, type) {
  const analysisField = type === "body_exploration" ? "ai_body_exploration" : "ai_analysis";
  const existingAnalysis = record?.[analysisField] || {};
  const retainedAnalysis = { ...existingAnalysis };
  delete retainedAnalysis._video_pass_findings;
  delete retainedAnalysis._video_pass_findings_updated_at;
  delete retainedAnalysis._video_pass_detail_flow;
  delete retainedAnalysis._video_pass_digest;
  delete retainedAnalysis.ai_audio_passes;
  return { analysisField, retainedAnalysis };
}

function storedAIPassFindingCount(record, type) {
  const analysisField = type === "body_exploration" ? "ai_body_exploration" : "ai_analysis";
  const analysis = record?.[analysisField] || {};
  const videoFindings = Array.isArray(analysis._video_pass_findings) ? analysis._video_pass_findings.length : 0;
  const audioPasses = Array.isArray(analysis.ai_audio_passes) ? analysis.ai_audio_passes.length : 0;
  return videoFindings + audioPasses;
}

export default function AIAnnotation() {
  const { id } = useParams();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const [sessions, setSessions] = useState([]);
  const [explorations, setExplorations] = useState([]);
  const [selectedType, setSelectedType] = useState(searchParams.get("type") === "body_exploration" ? "body_exploration" : "session");
  const [selectedId, setSelectedId] = useState(searchParams.get("id") || id || "");
  const [record, setRecord] = useState(null);
  const [timelineRows, setTimelineRows] = useState([]);
  const [loadingRecords, setLoadingRecords] = useState(true);
  const [loadingRecord, setLoadingRecord] = useState(false);
  const [error, setError] = useState("");
  const [cursorSeconds, setCursorSeconds] = useState(0);
  const [ignoreCompletedJobsBefore, setIgnoreCompletedJobsBefore] = useState(0);
  const records = selectedType === "body_exploration" ? explorations : sessions;
  const entity = selectedType === "body_exploration" ? base44.entities.BodyExploration : base44.entities.Session;
  const detailPath = record?.id
    ? selectedType === "body_exploration" ? `/exploration/${record.id}` : `/sessions/${record.id}`
    : "";
  const detailLabel = selectedType === "body_exploration" ? "Exploration Details" : "Session Details";
  const aiGeneratedEventCount = useMemo(
    () => (record?.event_timeline || []).filter(isAIGeneratedAnnotation).length,
    [record?.event_timeline],
  );
  const storedAIPassCount = useMemo(
    () => storedAIPassFindingCount(record, selectedType),
    [record, selectedType],
  );
  const clearableAIPassCount = aiGeneratedEventCount + storedAIPassCount;

  useEffect(() => {
    let cancelled = false;
    setLoadingRecords(true);
    Promise.all([
      base44.entities.Session.list("-date", 250).catch(() => []),
      base44.entities.BodyExploration.list("-date", 250).catch(() => []),
    ])
      .then(([sessionRows, explorationRows]) => {
        if (cancelled) return;
        setSessions(sessionRows || []);
        setExplorations(explorationRows || []);
        if (!selectedId) {
          const defaults = selectedType === "body_exploration" ? explorationRows : sessionRows;
          if (defaults?.[0]?.id) setSelectedId(defaults[0].id);
        }
      })
      .catch((err) => {
        if (!cancelled) setError(err?.message || "Could not load annotation records.");
      })
      .finally(() => {
        if (!cancelled) setLoadingRecords(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId, selectedType]);

  useEffect(() => {
    const queryType = searchParams.get("type") === "body_exploration" ? "body_exploration" : "session";
    const queryId = searchParams.get("id") || id || "";
    if (queryType !== selectedType) setSelectedType(queryType);
    if (queryId && queryId !== selectedId) setSelectedId(queryId);
  }, [id, searchParams, selectedId, selectedType]);

  useEffect(() => {
    const nextId = id || selectedId;
    if (!nextId) return;
    if (nextId !== selectedId) setSelectedId(nextId);
    let cancelled = false;
    setLoadingRecord(true);
    setError("");
    Promise.all([
      entity.filter({ id: nextId }),
      base44.entities.HeartRateTimeline.filter({ session: nextId }, "time_offset_s", 10000),
    ])
      .then(([recordRows, rows]) => {
        if (cancelled) return;
        setRecord(recordRows[0] || null);
        setTimelineRows(rows || []);
        setCursorSeconds(0);
      })
      .catch((err) => {
        if (!cancelled) setError(err?.message || "Could not load the selected annotation record.");
      })
      .finally(() => {
        if (!cancelled) setLoadingRecord(false);
      });
    return () => {
      cancelled = true;
    };
  }, [entity, id, selectedId]);

  const linkedLocalVideos = useMemo(() => record?.linked_local_videos || [], [record]);

  const navigateToRecord = (type, nextId) => {
    if (!nextId) return;
    if (type === "session") navigate(`/sessions/${nextId}/ai-annotation`);
    else navigate(`/ai-annotation?type=body_exploration&id=${nextId}`);
  };

  const handleTypeChange = (nextType) => {
    setSelectedType(nextType);
    const nextRecords = nextType === "body_exploration" ? explorations : sessions;
    const nextId = nextRecords[0]?.id || "";
    setSelectedId(nextId);
    setRecord(null);
    setTimelineRows([]);
    if (nextId) navigateToRecord(nextType, nextId);
    else navigate(`/ai-annotation?type=${nextType}`);
  };

  const handleRecordChange = (nextId) => {
    setSelectedId(nextId);
    navigateToRecord(selectedType, nextId);
  };

  const updateLinkedVideos = async (nextVideos) => {
    if (!record?.id) return;
    await entity.update(record.id, { linked_local_videos: nextVideos });
    setRecord((current) => (current ? { ...current, linked_local_videos: nextVideos } : current));
    const updateList = (current) => current.map((item) => (
      item.id === record.id ? { ...item, linked_local_videos: nextVideos } : item
    ));
    if (selectedType === "body_exploration") setExplorations(updateList);
    else setSessions(updateList);
  };

  const clearAIGeneratedEvents = async () => {
    if (!record?.id || !clearableAIPassCount) return;
    const retainedEvents = (record.event_timeline || []).filter((event) => !isAIGeneratedAnnotation(event));
    const { analysisField, retainedAnalysis } = clearAIPassAnalysis(record, selectedType);
    const updated = {
      event_timeline: retainedEvents,
      [analysisField]: retainedAnalysis,
    };
    await entity.update(record.id, updated);
    setIgnoreCompletedJobsBefore(Date.now());
    setRecord((current) => (current ? { ...current, ...updated } : current));
    const updateList = (current) => current.map((item) => (
      item.id === record.id ? { ...item, ...updated } : item
    ));
    if (selectedType === "body_exploration") setExplorations(updateList);
    else setSessions(updateList);
  };

  return (
    <div className="mx-auto max-w-7xl space-y-4 px-4 py-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wider text-primary">Sarah annotation workbench</p>
          <h1 className="mt-1 flex items-center gap-2 text-2xl font-bold">
            <Sparkles className="h-5 w-5 text-primary" /> AI Assisted Annotation
          </h1>
          <p className="mt-1 max-w-3xl text-sm text-muted-foreground">
            Run video and audio passes against linked local recordings, review Sarah&apos;s findings, and accept them into a session or body exploration timeline.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          {record?.id && detailPath && (
            <Button asChild variant="outline" className="h-9">
              <Link to={detailPath}>
                <ArrowLeft className="mr-2 h-4 w-4" /> {detailLabel}
              </Link>
            </Button>
          )}
          {record?.id && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button
                  variant="outline"
                  disabled={clearableAIPassCount === 0}
                  className="h-9 border-destructive/30 text-destructive hover:bg-destructive/10 disabled:border-border disabled:text-muted-foreground"
                >
                  <Trash2 className="mr-2 h-4 w-4" /> Clear AI Events ({clearableAIPassCount})
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Clear AI-generated annotations?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This removes {aiGeneratedEventCount} accepted Sarah timeline annotation{aiGeneratedEventCount === 1 ? "" : "s"} and {storedAIPassCount} stored video/audio pass result{storedAIPassCount === 1 ? "" : "s"} from this {selectedType === "body_exploration" ? "body exploration" : "session"}. Manual notes and non-AI events are kept.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={clearAIGeneratedEvents} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                    Clear AI annotations
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
        </div>
      </div>

      <section className="rounded-xl border border-border bg-card p-4">
        <div className="grid gap-3 lg:grid-cols-[12rem_minmax(18rem,1fr)_auto]">
          <label className="space-y-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-primary">Record Type</span>
            <select
              value={selectedType}
              disabled={loadingRecords}
              onChange={(event) => handleTypeChange(event.target.value)}
              className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm"
            >
              <option value="session">Sessions</option>
              <option value="body_exploration">Body Exploration</option>
            </select>
          </label>
          <label className="space-y-1">
            <span className="text-[11px] font-semibold uppercase tracking-wider text-primary">
              {selectedType === "body_exploration" ? "Body Exploration" : "Session"}
            </span>
            <select
              value={selectedId}
              disabled={loadingRecords}
              onChange={(event) => handleRecordChange(event.target.value)}
              className="h-10 w-full rounded-lg border border-border bg-background px-3 text-sm"
            >
              {!selectedId && <option value="">Select a record</option>}
              {records.map((item) => (
                <option key={item.id} value={item.id}>{recordLabel(item, selectedType)}</option>
              ))}
            </select>
          </label>
          <div className="flex items-end gap-2 text-xs text-muted-foreground">
            <div className="rounded-lg border border-border bg-muted/20 px-3 py-2">
              <span className="font-mono text-primary">{timelineRows.length}</span> telemetry rows
            </div>
            <div className="rounded-lg border border-border bg-muted/20 px-3 py-2">
              <span className="font-mono text-primary">{linkedLocalVideos.length}</span> linked videos
            </div>
            <div className="rounded-lg border border-border bg-muted/20 px-3 py-2">
              <span className="font-mono text-primary">{aiGeneratedEventCount}</span> AI events
            </div>
          </div>
        </div>
        {error && <p className="mt-3 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">{error}</p>}
      </section>

      {loadingRecord && (
        <div className="flex items-center gap-2 rounded-xl border border-border bg-card p-4 text-sm text-muted-foreground">
          <Loader2 className="h-4 w-4 animate-spin text-primary" /> Loading annotation workspace...
        </div>
      )}

      {!loadingRecord && record && (
        <>
          <section className="rounded-xl border border-border bg-card p-4">
            <LinkedLocalVideoManager
              videos={linkedLocalVideos}
              title="Linked Original Videos"
              helper="Choose the source recordings Sarah should review. Store path/fingerprint metadata only; raw video stays local."
              onChange={updateLinkedVideos}
            />
          </section>

          <section className="rounded-xl border border-border bg-card p-4">
            <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
              <div>
                <h2 className="flex items-center gap-2 text-sm font-semibold text-foreground">
                  <Clapperboard className="h-4 w-4 text-primary" /> Video and Audio Passes
                </h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Pick the recording and view type, then run passes from the cursor or smart windows. Cursor is currently {Math.floor(cursorSeconds / 60)}:{String(Math.round(cursorSeconds % 60)).padStart(2, "0")}.
                </p>
              </div>
            </div>
            <AIVideoPassPanel
              session={record}
              timelineRows={timelineRows}
              linkedLocalVideos={linkedLocalVideos}
              recordType={selectedType}
              onSessionUpdate={(updated) => setRecord((current) => ({ ...(current || {}), ...updated }))}
              onCursorChange={setCursorSeconds}
              ignoreCompletedJobsBefore={ignoreCompletedJobsBefore}
            />
          </section>
        </>
      )}

      {!loadingRecord && !record && (
        <div className="rounded-xl border border-border bg-card p-5 text-sm text-muted-foreground">
          <div className="flex items-center gap-2">
            {selectedType === "body_exploration" ? <ScanSearch className="h-4 w-4 text-primary" /> : <Clapperboard className="h-4 w-4 text-primary" />}
            <span>Select a {selectedType === "body_exploration" ? "body exploration record" : "session"} with linked local video to start an AI assisted annotation pass.</span>
          </div>
        </div>
      )}
    </div>
  );
}
