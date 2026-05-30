import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { Activity, ArrowLeft, Brain, Pencil, ScanSearch } from "lucide-react";
import moment from "moment";
import { base44 } from "@/api/base44Client";
import PageHeader from "@/components/PageHeader";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import HRTimelineChart from "@/components/HRTimelineChart";
import EMGTimelineChart from "@/components/EMGTimelineChart";
import BodyExplorationAIPanel from "@/components/BodyExplorationAIPanel";

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

export default function BodyExplorationDetail() {
  const { id } = useParams();
  const [exploration, setExploration] = useState(null);
  const [timelineRows, setTimelineRows] = useState([]);
  const [emgRows, setEmgRows] = useState([]);
  const [userProfile, setUserProfile] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      base44.entities.BodyExploration.filter({ id }),
      base44.entities.HeartRateTimeline.filter({ session: id }, "time_offset_s", 10000),
      base44.entities.EMGTimeline.filter({ session: id }, "time_s", 10000),
      base44.auth.me(),
    ]).then(([items, hr, emg, profile]) => {
      setExploration(items[0] || null);
      setTimelineRows(hr || []);
      setEmgRows(emg || []);
      setUserProfile(profile);
    }).finally(() => setLoading(false));
  }, [id]);

  if (loading) return <div className="flex h-64 items-center justify-center"><div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" /></div>;
  if (!exploration) return <div className="p-6 text-center text-muted-foreground">Body exploration record not found.</div>;

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
        <BodyExplorationAIPanel exploration={exploration} timelineRows={timelineRows} emgRows={emgRows} userProfile={userProfile} />
        <div className="rounded-xl border border-border bg-muted/20 p-4 text-xs text-muted-foreground">
          <p className="flex items-center gap-1.5 font-semibold uppercase tracking-wider text-primary"><Brain className="h-3.5 w-3.5" /> Standalone exploration mode</p>
          <p className="mt-2">This record does not use climax phase markers or arousal-session completion logic.</p>
        </div>
      </div>
    </div>
  );
}
