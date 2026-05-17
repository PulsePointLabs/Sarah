import { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import PageHeader from "../components/PageHeader";
import VideoSyncPlayer from "../components/VideoSyncPlayer";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import moment from "moment";

export default function VideoPlayer() {
  const [sessions, setSessions] = useState([]);
  const [selectedId, setSelectedId] = useState("");
  const [selectedSession, setSelectedSession] = useState(null);
  const [timelineRows, setTimelineRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [loadingSession, setLoadingSession] = useState(false);

  useEffect(() => {
    base44.entities.Session.list("-date", 200).then((data) => {
      setSessions(data);
      setLoading(false);
    });
  }, []);

  const handleSelectSession = async (id) => {
    setSelectedId(id);
    setSelectedSession(null);
    setTimelineRows([]);
    if (!id) return;
    setLoadingSession(true);
    const [sessionList, rows] = await Promise.all([
      base44.entities.Session.filter({ id }),
      base44.entities.HeartRateTimeline.filter({ session: id }, "time_offset_s", 10000),
    ]);
    setSelectedSession(sessionList[0] || null);
    setTimelineRows(rows);
    setLoadingSession(false);
  };

  return (
    <div>
      <PageHeader title="Video Sync Player" subtitle="Load a local video and sync it with HR data and event notes" />

      <div className="px-4 pb-8 space-y-4">
        {/* Session picker */}
        <div className="bg-card rounded-xl border border-border p-4 space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">Select Session</p>
          {loading ? (
            <div className="h-10 flex items-center">
              <span className="text-sm text-muted-foreground">Loading sessions…</span>
            </div>
          ) : (
            <Select value={selectedId} onValueChange={handleSelectSession}>
              <SelectTrigger className="h-11">
                <SelectValue placeholder="Choose a session…" />
              </SelectTrigger>
              <SelectContent>
                {sessions.map((s) => (
                  <SelectItem key={s.id} value={s.id}>
                    {moment(s.date).format("MMM D, YYYY")}
                    {s.start_time ? ` · ${s.start_time}` : ""}
                    {s.duration_minutes ? ` · ${s.duration_minutes}m` : ""}
                    {s.no_climax ? " · NC" : ""}
                    {(s.event_timeline || []).length > 0 ? ` · ${s.event_timeline.length} events` : ""}
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
        {selectedSession && !loadingSession && (
          <VideoSyncPlayer session={selectedSession} timelineRows={timelineRows} />
        )}

        {/* Empty state */}
        {!selectedId && !loading && (
          <div className="text-center py-16 text-muted-foreground">
            <p className="text-sm">Select a session above to load the video sync player</p>
          </div>
        )}
      </div>
    </div>
  );
}