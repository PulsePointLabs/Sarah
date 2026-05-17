import { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import PageHeader from "../components/PageHeader";
import SessionCard from "../components/SessionCard";
import CompareHRTimelineChart from "../components/CompareHRTimelineChart";
import CompareStats from "../components/CompareStats";
import { GitCompare } from "lucide-react";
import CompareAIPanel from "../components/CompareAIPanel";
import ArousalComparisonAIPanel from "../components/ArousalComparisonAIPanel";
import CascadeOverviewPanel from "../components/CascadeOverviewPanel";
import CompareCascadePanel from "../components/CompareCascadePanel";
import SessionTimelineNarrative from "../components/SessionTimelineNarrative";
import SessionDiffSummary from "../components/SessionDiffSummary";
import moment from "moment";

function MetricRow({ label, value, max = 10 }) {
  const pct = value ? (value / max) * 100 : 0;
  return (
    <div>
      <div className="flex justify-between text-[10px]">
        <span className="text-muted-foreground">{label}</span>
        <span className="font-mono font-bold">{value || "—"}</span>
      </div>
      <div className="h-1.5 bg-muted rounded-full overflow-hidden mt-0.5">
        <div className="h-full bg-primary rounded-full" style={{ width: `${pct}%` }} />
      </div>
    </div>
  );
}

function fmtSec(v) {
  if (v == null) return null;
  const total = Math.round(Number(v));
  const m = Math.floor(total / 60);
  const sec = total % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function CompareColumn({ session: s }) {
  const buildTypeLabel = s.build_type === "Other" && s.custom_build_type ? s.custom_build_type : s.build_type;
  const preClimax = fmtSec(s.pre_climax_offset_s);
  const climaxT = fmtSec(s.climax_offset_s);
  const recovery = fmtSec(s.recovery_offset_s);
  const buildToClimax = (s.pre_climax_offset_s != null && s.climax_offset_s != null)
    ? fmtSec(Math.abs(s.climax_offset_s - s.pre_climax_offset_s)) : null;
  const climaxToRec = (s.climax_offset_s != null && s.recovery_offset_s != null)
    ? fmtSec(Math.abs(s.recovery_offset_s - s.climax_offset_s)) : null;
  return (
    <div className="bg-card rounded-xl border border-border p-3 flex-1 min-w-[140px] space-y-3">
      <div className="text-center">
        <p className="text-sm font-bold">{moment(s.date).format("M/D/YY")}</p>
        <p className="text-[10px] text-muted-foreground">
          {s.start_time || ""}
          {s.duration_minutes ? ` · ${s.duration_minutes}m` : ""}
        </p>
      </div>

      <div className="space-y-2">
        <MetricRow label="Intensity" value={s.intensity} max={10} />
        <MetricRow label="Build Quality" value={s.build_quality} max={10} />
        <MetricRow label="Satisfaction" value={s.satisfaction} max={10} />
      </div>

      {buildTypeLabel && (
        <div className="text-center">
          <Badge variant="outline" className="text-[9px] py-0">{buildTypeLabel}</Badge>
        </div>
      )}

      <div className="space-y-1 pt-2 border-t border-border">
        <p className="text-[10px] text-muted-foreground uppercase font-semibold">Heart Rate</p>
        <div className="grid grid-cols-3 gap-1 text-center">
          {[["Avg", s.avg_hr], ["Max", s.max_hr], ["Clx", s.hr_at_climax]].map(([l, v]) => (
            <div key={l}>
              <p className="text-lg font-bold font-mono">{v || "—"}</p>
              <p className="text-[9px] text-muted-foreground">{l}</p>
            </div>
          ))}
        </div>
        {(s.hr_avg_pre_to_climax || s.hr_avg_at_climax_window) && (
          <div className="space-y-1 pt-1">
            {s.hr_avg_pre_to_climax && (
              <div className="flex justify-between text-[10px]">
                <span className="text-muted-foreground">Pre→Clx Avg</span>
                <span className="font-mono font-bold">{s.hr_avg_pre_to_climax} bpm</span>
              </div>
            )}
            {s.hr_avg_at_climax_window && (
              <div className="flex justify-between text-[10px]">
                <span className="text-muted-foreground">±30s Clx Avg</span>
                <span className="font-mono font-bold">{s.hr_avg_at_climax_window} bpm</span>
              </div>
            )}
          </div>
        )}
      </div>

      <div className="pt-2 border-t border-border">
        <p className="text-[10px] text-muted-foreground uppercase font-semibold mb-1">Methods</p>
        <div className="flex flex-wrap gap-1">
          {(s.methods || []).map((m) => <Badge key={m} variant="secondary" className="text-[9px] py-0">{m}</Badge>)}
        </div>
      </div>

      {(preClimax || climaxT || recovery) && (
        <div className="pt-2 border-t border-border space-y-1">
          <p className="text-[10px] text-muted-foreground uppercase font-semibold">Phase Times</p>
          {preClimax && <div className="flex justify-between text-[10px]"><span className="text-muted-foreground">Pre-Climax</span><span className="font-mono">{preClimax}</span></div>}
          {climaxT && <div className="flex justify-between text-[10px]"><span className="text-muted-foreground">Climax</span><span className="font-mono">{climaxT}</span></div>}
          {recovery && <div className="flex justify-between text-[10px]"><span className="text-muted-foreground">Recovery</span><span className="font-mono">{recovery}</span></div>}
          {buildToClimax && <div className="flex justify-between text-[10px] pt-1 border-t border-border"><span className="text-muted-foreground">Pre→Climax</span><span className="font-mono font-bold text-destructive">{buildToClimax}</span></div>}
          {climaxToRec && <div className="flex justify-between text-[10px]"><span className="text-muted-foreground">Climax→Rec</span><span className="font-mono font-bold text-chart-5">{climaxToRec}</span></div>}
        </div>
      )}
      {s.notes && (
        <div className="pt-2 border-t border-border">
          <p className="text-[10px] text-muted-foreground uppercase font-semibold mb-1">Notes</p>
          <p className="text-xs line-clamp-3">{s.notes}</p>
        </div>
      )}
    </div>
  );
}

export default function Compare() {
  const [sessions, setSessions] = useState([]);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState(new Set());
  const [comparing, setComparing] = useState(false);
  const [timelines, setTimelines] = useState([]);
  const [loadingTimelines, setLoadingTimelines] = useState(false);
  const [timelineMap, setTimelineMap] = useState({});
  const [userProfile, setUserProfile] = useState(null);

  useEffect(() => {
    (async () => {
      const [data, profile] = await Promise.all([
        base44.entities.Session.list("-date", 200),
        base44.auth.me().catch(() => null),
      ]);
      setSessions(data);
      setUserProfile(profile);
      setLoading(false);
    })();
  }, []);

  // Fetch HR timelines when entering compare mode
  useEffect(() => {
    if (!comparing) return;
    (async () => {
      setLoadingTimelines(true);
      const results = await Promise.all(
        selectedSessions.map((s) =>
          base44.entities.HeartRateTimeline.filter({ session: s.id }, "time_offset_s", 2000)
            .then((rows) => ({ label: moment(s.date).format("M/D/YY"), rows }))
        )
      );
      setTimelines(results.filter((r) => r.rows.length > 0));
      // Build a map from session id → rows for cascade panels
      const map = {};
      selectedSessions.forEach((s, i) => { map[s.id] = results[i]?.rows || []; });
      setTimelineMap(map);
      setLoadingTimelines(false);
    })();
  }, [comparing]);

  const toggleSelect = (id) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else if (next.size < 5) next.add(id);
    setSelected(next);
  };

  const selectedSessions = sessions.filter((s) => selected.has(s.id));

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
        title="Compare"
        subtitle={comparing ? `${selected.size} sessions` : "Select sessions to compare"}
        action={
          comparing ? (
            <Button variant="outline" size="sm" onClick={() => setComparing(false)}>Back</Button>
          ) : (
            <Button size="sm" disabled={selected.size < 2} onClick={() => setComparing(true)} className="gap-1.5">
              <GitCompare className="w-4 h-4" /> Compare ({selected.size})
            </Button>
          )
        }
      />

      <div className="px-4 pb-6">
        {!comparing ? (
          <div className="space-y-2">
            {sessions.length === 0 ? (
              <p className="text-center text-muted-foreground py-12 text-sm">No sessions to compare</p>
            ) : (
              sessions.map((s) => (
                <SessionCard key={s.id} session={s} selectable selected={selected.has(s.id)} onSelect={toggleSelect} />
              ))
            )}
          </div>
        ) : (
          <div className="space-y-4">
            {/* 2-session focused diff summary — shown first */}
            {selectedSessions.length === 2 && (
              <SessionDiffSummary sessionA={selectedSessions[0]} sessionB={selectedSessions[1]} />
            )}

            {loadingTimelines ? (
              <div className="flex items-center justify-center h-20">
                <div className="w-6 h-6 border-4 border-primary border-t-transparent rounded-full animate-spin" />
              </div>
            ) : timelines.length > 0 ? (
              <CompareHRTimelineChart timelines={timelines} sessions={selectedSessions} />
            ) : null}
            <CompareStats sessions={selectedSessions} />
            <ArousalComparisonAIPanel sessions={selectedSessions} timelineMap={timelineMap} userProfile={userProfile} />
            <CompareAIPanel sessions={selectedSessions} userProfile={userProfile} />
            <CompareCascadePanel sessions={selectedSessions} timelineMap={timelineMap} userProfile={userProfile} />
            <div className="flex gap-3 overflow-x-auto pb-4 snap-x">
              {selectedSessions.map((s) => <CompareColumn key={s.id} session={s} />)}
            </div>

            {/* Per-session cascade analysis */}
            <div className="space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-primary">Cascade Analysis Per Session</h3>
              {selectedSessions.map((s) => (
                <div key={s.id} className="space-y-1">
                  <p className="text-xs text-muted-foreground font-semibold">{moment(s.date).format("MMM D, YYYY")}</p>
                  <CascadeOverviewPanel session={s} timelineRows={timelineMap[s.id] || []} userProfile={userProfile} />
                </div>
              ))}
            </div>

            {/* Per-session timeline & arousal narrative */}
            <div className="space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-wider text-primary">Timeline &amp; Arousal Narrative Per Session</h3>
              {selectedSessions.map((s) => (
                <div key={s.id} className="space-y-1">
                  <p className="text-xs text-muted-foreground font-semibold">{moment(s.date).format("MMM D, YYYY")}</p>
                  <SessionTimelineNarrative session={s} timelineRows={timelineMap[s.id] || []} userProfile={userProfile} />
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}