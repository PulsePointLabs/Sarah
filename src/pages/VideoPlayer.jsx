import { useCallback, useState, useEffect } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { base44 } from "@/api/base44Client";
import PageHeader from "../components/PageHeader";
import VideoSyncPlayer from "../components/VideoSyncPlayer";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Activity, ArrowLeft, RefreshCw } from "lucide-react";
import moment from "moment";

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

  const handleSelectRecord = useCallback(async (id, typeOverride = recordType) => {
    setSelectedId(id);
    setSelectedRecord(null);
    setTimelineRows([]);
    if (!id) return;
    setLoadingSession(true);
    const entity = typeOverride === "body_exploration" ? base44.entities.BodyExploration : base44.entities.Session;
    const [recordList, rows] = await Promise.all([
      entity.filter({ id }),
      base44.entities.HeartRateTimeline.filter({ session: id }, "time_offset_s", 10000),
    ]);
    setSelectedRecord(recordList[0] || null);
    setTimelineRows(rows);
    setLoadingSession(false);
  }, [recordType]);

  useEffect(() => {
    Promise.all([
      base44.entities.Session.list("-date", 200).catch(() => []),
      base44.entities.BodyExploration.list("-date", 200).catch(() => []),
    ]).then(([sessionRows, explorationRows]) => {
      setSessions(sessionRows);
      setExplorations(explorationRows);
      setLoading(false);
      const requestedType = searchParams.get("type") === "body_exploration" || searchParams.get("exploration")
        ? "body_exploration"
        : "session";
      const requestedId = searchParams.get("id") || searchParams.get("session") || searchParams.get("exploration") || "";
      if (requestedId) {
        setRecordType(requestedType);
        handleSelectRecord(requestedId, requestedType);
      }
    });
  }, [handleSelectRecord, searchParams]);

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
        </div>

        {/* Loading state */}
        {loadingSession && (
          <div className="flex items-center justify-center h-32">
            <div className="w-6 h-6 border-4 border-primary border-t-transparent rounded-full animate-spin" />
          </div>
        )}

        {/* Player */}
        {selectedRecord && !loadingSession && (
          <VideoSyncPlayer key={`${recordType}:${selectedRecord.id}`} session={selectedRecord} timelineRows={timelineRows} recordType={recordType} />
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
