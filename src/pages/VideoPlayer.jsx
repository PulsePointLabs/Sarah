import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { base44 } from "@/api/base44Client";
import PageHeader from "../components/PageHeader";
import VideoSyncPlayer from "../components/VideoSyncPlayer";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Activity, AlertCircle, ArrowLeft, RefreshCw } from "lucide-react";
import moment from "moment";

const RECORD_PICKER_FIELDS = [
  "date",
  "start_time",
  "duration_minutes",
  "no_climax",
  "title",
  "exploration_type",
];

const VIDEO_SYNC_RECORD_FIELDS = [
  ...RECORD_PICKER_FIELDS,
  "event_timeline",
  "linked_local_videos",
  "motion_analysis_summary",
  "pre_climax_offset_s",
  "climax_offset_s",
  "recovery_offset_s",
];

const VIDEO_SYNC_TIMELINE_FIELDS = [
  "session",
  "time_offset_s",
  "hr",
  "hr_smoothed",
  "baseline_hr",
  "elevated_delta",
  "hr_source",
  "rr_intervals_ms",
  "hrv_rmssd_ms",
  "hrv_sdnn_ms",
  "hrv_quality",
  "respiration_bpm",
  "respiration_source",
  "respiration_confidence",
  "respiration_unavailable_reason",
  "motion_class",
  "motion_dynamic_rms_mg",
  "motion_peak_dynamic_mg",
  "multimodal_state",
  "signal_confidence_level",
  "signal_confidence_score",
];

export default function VideoPlayer() {
  const [searchParams] = useSearchParams();
  const [sessions, setSessions] = useState([]);
  const [explorations, setExplorations] = useState([]);
  const [recordType, setRecordType] = useState("session");
  const [selectedId, setSelectedId] = useState("");
  const [selectedRecord, setSelectedRecord] = useState(null);
  const [timelineRows, setTimelineRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingSession, setLoadingSession] = useState(false);
  const [recordListError, setRecordListError] = useState("");
  const [recordLoadError, setRecordLoadError] = useState("");
  const recordTypeRef = useRef(recordType);

  useEffect(() => {
    recordTypeRef.current = recordType;
  }, [recordType]);

  const handleSelectRecord = useCallback(async (id, typeOverride) => {
    const selectedType = typeOverride || recordTypeRef.current;
    setSelectedId(id);
    setSelectedRecord(null);
    setTimelineRows([]);
    setRecordLoadError("");
    if (!id) return;
    setLoadingSession(true);
    const entity = selectedType === "body_exploration" ? base44.entities.BodyExploration : base44.entities.Session;
    try {
      const [recordList, rows] = await Promise.all([
        entity.filterFields(
          { id },
          VIDEO_SYNC_RECORD_FIELDS,
          undefined,
          1,
          undefined,
          { timeoutMs: 20000 },
        ),
        base44.entities.HeartRateTimeline.filterFieldsSampled(
          { session: id },
          VIDEO_SYNC_TIMELINE_FIELDS,
          "time_offset_s",
          3000,
          10000,
          undefined,
          { timeoutMs: 30000 },
        ).catch(() => []),
      ]);
      const record = recordList[0] || null;
      setSelectedRecord(record);
      setTimelineRows(rows);
      if (!record) setRecordLoadError("That record is no longer available.");
    } catch (error) {
      console.error("Could not load the selected Video Sync record:", error);
      setRecordLoadError(error?.message || "Could not load the selected record.");
    } finally {
      setLoadingSession(false);
    }
  }, []);

  const loadRecordOptions = useCallback(async () => {
    setLoading(true);
    setRecordListError("");
    try {
      const [sessionResult, explorationResult] = await Promise.allSettled([
        base44.entities.Session.listFields(RECORD_PICKER_FIELDS, "-date", 200, undefined, { timeoutMs: 15000 }),
        base44.entities.BodyExploration.listFields(RECORD_PICKER_FIELDS, "-date", 200, undefined, { timeoutMs: 15000 }),
      ]);
      const sessionRows = sessionResult.status === "fulfilled" ? sessionResult.value : [];
      const explorationRows = explorationResult.status === "fulfilled" ? explorationResult.value : [];
      setSessions(sessionRows);
      setExplorations(explorationRows);

      const failures = [sessionResult, explorationResult].filter((result) => result.status === "rejected");
      if (failures.length) {
        console.error("Could not load one or more Video Sync record lists:", failures.map((result) => result.reason));
        setRecordListError(
          failures.length === 2
            ? "Sarah could not load the Video Sync record list."
            : "Sarah could not load one of the Video Sync record lists.",
        );
      }
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadRecordOptions().then(() => {
      const requestedType = searchParams.get("type") === "body_exploration" || searchParams.get("exploration")
        ? "body_exploration"
        : "session";
      const requestedId = searchParams.get("id") || searchParams.get("session") || searchParams.get("exploration") || "";
      if (requestedId) {
        setRecordType(requestedType);
        handleSelectRecord(requestedId, requestedType);
      }
    });
  }, [handleSelectRecord, loadRecordOptions, searchParams]);

  const handleRecordTypeChange = (type) => {
    setRecordType(type);
    setSelectedId("");
    setSelectedRecord(null);
    setTimelineRows([]);
  };

  const refreshSelectedRecord = async () => {
    if (!selectedId) return;
    await handleSelectRecord(selectedId);
  };
  const records = recordType === "body_exploration" ? explorations : sessions;

  return (
    <div>
      <PageHeader title="Video Sync Player" subtitle="Load a local video and sync it with HR data and event notes" />

      <div className="px-4 pb-8 space-y-4">
        {/* Record picker */}
        <div className="bg-card rounded-xl border border-border p-4 space-y-2">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Select Record</p>
            <div className="flex flex-wrap items-center gap-2">
              {recordType === "session" && selectedId && (
                <Link
                  to={`/sessions/${encodeURIComponent(selectedId)}`}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border bg-background px-2.5 py-1.5 text-xs font-medium text-foreground transition-colors hover:border-primary/40 hover:text-primary"
                >
                  <ArrowLeft className="h-3.5 w-3.5" />
                  Session Details
                </Link>
              )}
              {recordType === "session" && selectedId && (
                <Link
                  to={`/motion-lab?session=${encodeURIComponent(selectedId)}`}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-primary/30 bg-primary/10 px-2.5 py-1.5 text-xs font-medium text-primary transition-colors hover:bg-primary/15"
                >
                  <Activity className="h-3.5 w-3.5" />
                  Analyze in Motion Lab
                </Link>
              )}
              {selectedId && (
                <button
                  type="button"
                  onClick={refreshSelectedRecord}
                  disabled={loadingSession}
                  className="inline-flex items-center gap-1.5 rounded-lg border border-border px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:border-primary/40 hover:text-primary disabled:opacity-50"
                >
                  <RefreshCw className={`h-3.5 w-3.5 ${loadingSession ? "animate-spin" : ""}`} />
                  Refresh selected
                </button>
              )}
              <div className="inline-flex rounded-lg border border-border bg-background p-1">
                <button type="button" onClick={() => handleRecordTypeChange("session")} className={`rounded-md px-3 py-1 text-xs font-medium ${recordType === "session" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}>Sessions</button>
                <button type="button" onClick={() => handleRecordTypeChange("body_exploration")} className={`rounded-md px-3 py-1 text-xs font-medium ${recordType === "body_exploration" ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}>Body Exploration</button>
              </div>
            </div>
          </div>
          {loading ? (
            <div className="h-10 flex items-center">
              <span className="text-sm text-muted-foreground">Loading records…</span>
            </div>
          ) : (
            <Select value={selectedId} onValueChange={handleSelectRecord}>
              <SelectTrigger className="h-11">
                <SelectValue placeholder={recordType === "body_exploration" ? "Choose a body exploration record…" : "Choose a session…"} />
              </SelectTrigger>
              <SelectContent>
                {records.map((record) => (
                  <SelectItem key={record.id} value={record.id}>
                    {recordType === "body_exploration" && (record.title || record.exploration_type) ? `${record.title || record.exploration_type} · ` : ""}
                    {moment(record.date).format("MMM D, YYYY")}
                    {record.start_time ? ` · ${record.start_time}` : ""}
                    {record.duration_minutes ? ` · ${record.duration_minutes}m` : ""}
                    {recordType === "session" && record.no_climax ? " · NC" : ""}
                    {(record.event_timeline || []).length > 0 ? ` · ${record.event_timeline.length} events` : ""}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          )}
          {recordListError && (
            <div className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-sm text-amber-200">
              <span className="inline-flex items-center gap-2">
                <AlertCircle className="h-4 w-4 shrink-0" />
                {recordListError}
              </span>
              <button
                type="button"
                onClick={loadRecordOptions}
                disabled={loading}
                className="rounded-md border border-amber-400/30 px-2.5 py-1 text-xs font-semibold hover:bg-amber-400/10 disabled:opacity-50"
              >
                Retry
              </button>
            </div>
          )}
        </div>

        {/* Loading state */}
        {loadingSession && (
          <div className="flex items-center justify-center h-32">
            <div className="w-6 h-6 border-4 border-primary border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {recordLoadError && !loadingSession && (
          <div className="flex items-center gap-2 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0" />
            {recordLoadError}
          </div>
        )}

        {/* Player */}
        {selectedRecord && !loadingSession && (
          <VideoSyncPlayer
            key={`${recordType}:${selectedRecord.id}`}
            session={selectedRecord}
            timelineRows={timelineRows}
            recordType={recordType}
            onEventsChange={(eventTimeline) => {
              setSelectedRecord((current) => (current ? { ...current, event_timeline: eventTimeline } : current));
              if (recordType === "body_exploration") {
                setExplorations((current) => current.map((record) => (
                  record.id === selectedRecord.id ? { ...record, event_timeline: eventTimeline } : record
                )));
              } else {
                setSessions((current) => current.map((record) => (
                  record.id === selectedRecord.id ? { ...record, event_timeline: eventTimeline } : record
                )));
              }
            }}
          />
        )}

        {/* Empty state */}
        {!selectedId && !loading && (
          <div className="text-center py-16 text-muted-foreground">
            <p className="text-sm">Select a session or body exploration record above to load the video sync player</p>
          </div>
        )}
      </div>
    </div>
  );
}
