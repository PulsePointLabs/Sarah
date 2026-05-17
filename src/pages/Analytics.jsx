import { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import PageHeader from "../components/PageHeader";
import CompareHRTimelineChart from "../components/CompareHRTimelineChart";
import CompareStats from "../components/CompareStats";
import EMGOverlayChart from "../components/analytics/EMGOverlayChart";
import ClimaxMetricsChart from "../components/analytics/ClimaxMetricsChart";
import { BarChart2, CheckSquare, Square, ChevronDown, ChevronUp } from "lucide-react";
import moment from "moment";

const MAX_SELECT = 6;

function SessionRow({ session: s, selected, onToggle }) {
  return (
    <button
      onClick={() => onToggle(s.id)}
      className={[
        "w-full flex items-center gap-3 px-3 py-2.5 rounded-lg border text-left transition-colors",
        selected
          ? "border-primary bg-primary/8 text-foreground"
          : "border-border bg-card text-foreground hover:bg-muted/50",
      ].join(" ")}
    >
      {selected
        ? <CheckSquare className="w-4 h-4 text-primary shrink-0" />
        : <Square className="w-4 h-4 text-muted-foreground shrink-0" />}
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium">{moment(s.date).format("MMM D, YYYY")}</p>
        <p className="text-[11px] text-muted-foreground truncate">
          {s.duration_minutes ? `${s.duration_minutes}m` : ""}
          {s.methods?.length ? ` · ${s.methods.slice(0, 2).join(", ")}` : ""}
          {s.no_climax ? " · No climax" : ""}
        </p>
      </div>
      <div className="flex flex-col items-end gap-0.5 shrink-0">
        {s.intensity != null && (
          <span className="text-[10px] text-muted-foreground">I:{s.intensity}/10</span>
        )}
        {s.satisfaction != null && (
          <span className="text-[10px] text-muted-foreground">S:{s.satisfaction}/10</span>
        )}
      </div>
      {s.emg_enabled && (
        <Badge variant="outline" className="text-[9px] py-0 shrink-0">EMG</Badge>
      )}
    </button>
  );
}

export default function Analytics() {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(new Set());
  const [showAll, setShowAll] = useState(false);

  // Data for charts
  const [hrTimelines, setHrTimelines] = useState([]);
  const [emgMap, setEmgMap] = useState({});
  const [loadingData, setLoadingData] = useState(false);

  useEffect(() => {
    base44.entities.Session.list("-date", 200).then((data) => {
      setSessions(data);
      setLoading(false);
    });
  }, []);

  // Reload chart data whenever selection changes
  useEffect(() => {
    if (selected.size === 0) {
      setHrTimelines([]);
      setEmgMap({});
      return;
    }
    const selectedSessions = sessions.filter((s) => selected.has(s.id));
    (async () => {
      setLoadingData(true);
      const [hrResults, emgResults] = await Promise.all([
        Promise.all(
          selectedSessions.map((s) =>
            base44.entities.HeartRateTimeline.filter({ session: s.id }, "time_offset_s", 2000)
              .then((rows) => ({ label: moment(s.date).format("M/D/YY"), rows }))
          )
        ),
        Promise.all(
          selectedSessions
            .filter((s) => s.emg_enabled)
            .map((s) =>
              base44.entities.EMGTimeline.filter({ session: s.id }, "time_s", 3000)
                .then((rows) => ({
                  sessionId: s.id,
                  label: moment(s.date).format("M/D/YY"),
                  rows,
                  channelMode: s.emg_channels || "single",
                }))
            )
        ),
      ]);

      setHrTimelines(hrResults.filter((r) => r.rows.length > 0));

      const map = {};
      emgResults.forEach((r) => { map[r.sessionId] = r; });
      setEmgMap(map);
      setLoadingData(false);
    })();
  }, [selected, sessions]);

  const toggleSelect = (id) => {
    const next = new Set(selected);
    if (next.has(id)) {
      next.delete(id);
    } else if (next.size < MAX_SELECT) {
      next.add(id);
    }
    setSelected(next);
  };

  const selectedSessions = sessions.filter((s) => selected.has(s.id));
  const hasEMG = selectedSessions.some((s) => s.emg_enabled && emgMap[s.id]);
  const displayedSessions = showAll ? sessions : sessions.slice(0, 20);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Analytics"
        subtitle="Select up to 6 sessions to compare"
        action={
          selected.size > 0 && (
            <Button variant="outline" size="sm" onClick={() => setSelected(new Set())}>
              Clear ({selected.size})
            </Button>
          )
        }
      />

      <div className="px-4 pb-10 space-y-5">
        {/* Session selector */}
        <div className="space-y-1.5">
          <p className="text-[11px] uppercase font-semibold text-muted-foreground tracking-wider">
            Sessions · select up to {MAX_SELECT}
          </p>
          {sessions.length === 0 ? (
            <p className="text-sm text-muted-foreground py-8 text-center">No sessions recorded yet</p>
          ) : (
            <>
              {displayedSessions.map((s) => (
                <SessionRow
                  key={s.id}
                  session={s}
                  selected={selected.has(s.id)}
                  onToggle={toggleSelect}
                />
              ))}
              {sessions.length > 20 && (
                <button
                  onClick={() => setShowAll((v) => !v)}
                  className="w-full flex items-center justify-center gap-1 py-2 text-xs text-muted-foreground hover:text-foreground transition-colors"
                >
                  {showAll ? <><ChevronUp className="w-3.5 h-3.5" /> Show less</> : <><ChevronDown className="w-3.5 h-3.5" /> Show all {sessions.length} sessions</>}
                </button>
              )}
            </>
          )}
        </div>

        {/* Charts */}
        {selected.size > 0 && (
          <>
            {loadingData ? (
              <div className="flex items-center justify-center h-20 gap-2 text-sm text-muted-foreground">
                <div className="w-5 h-5 border-2 border-primary border-t-transparent rounded-full animate-spin" />
                Loading data…
              </div>
            ) : (
              <div className="space-y-4">
                <div className="flex items-center gap-2 pt-1">
                  <BarChart2 className="w-4 h-4 text-primary" />
                  <p className="text-sm font-semibold">
                    Comparing {selectedSessions.length} session{selectedSessions.length > 1 ? "s" : ""}
                  </p>
                </div>

                {/* HR overlay */}
                {hrTimelines.length > 0 && (
                  <CompareHRTimelineChart timelines={hrTimelines} sessions={selectedSessions} />
                )}

                {/* Summary stats */}
                <CompareStats sessions={selectedSessions} />

                {/* Climax & subjective bar charts */}
                <ClimaxMetricsChart sessions={selectedSessions} />

                {/* EMG overlay */}
                {hasEMG && (
                  <EMGOverlayChart emgMap={emgMap} sessions={selectedSessions} />
                )}

                {!hasEMG && selectedSessions.some((s) => s.emg_enabled) && (
                  <div className="bg-card rounded-xl border border-border p-4 text-center text-xs text-muted-foreground">
                    EMG data not yet available — still loading or no samples recorded
                  </div>
                )}
              </div>
            )}
          </>
        )}

        {selected.size === 0 && (
          <div className="text-center py-10 text-muted-foreground text-sm">
            Select 2 or more sessions above to see overlaid charts
          </div>
        )}
      </div>
    </div>
  );
}