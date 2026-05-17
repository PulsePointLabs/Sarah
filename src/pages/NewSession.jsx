import { useState } from "react";
import { useNavigate } from "react-router-dom";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { useToast } from "@/components/ui/use-toast";
import PageHeader from "../components/PageHeader";
import SessionInfoSection from "../components/session-form/SessionInfoSection";
import HeartRateSection from "../components/session-form/HeartRateSection";
import MethodsSection from "../components/session-form/MethodsSection";
import SubjectiveSection from "../components/session-form/SubjectiveSection";
import NoClimaxSubjectiveSection from "../components/session-form/NoClimaxSubjectiveSection";
import PhysiologicalSection from "../components/session-form/PhysiologicalSection";
import ContextSection from "../components/session-form/ContextSection";
import NotesMediaSection from "../components/session-form/NotesMediaSection";
import EventTimelineSection from "../components/session-form/EventTimelineSection";
import EMGSection from "../components/session-form/EMGSection";
import { Zap, Save, ChevronDown, ChevronUp, XCircle } from "lucide-react";
import { Link } from "react-router-dom";

const SECTIONS = [
  { id: "info", label: "Session Info" },
  { id: "hr", label: "Heart Rate" },
  { id: "emg", label: "EMG (MyoWare)" },
  { id: "methods", label: "Methods & Devices" },
  { id: "subjective", label: "Subjective Metrics" },
  { id: "physio", label: "Physiological" },
  { id: "context", label: "Context" },
  { id: "events", label: "Event Timeline" },
  { id: "notes", label: "Notes & Media" },
];

function calcDuration(start, end) {
  if (!start || !end) return null;
  const [sh, sm] = start.split(":").map(Number);
  const [eh, em] = end.split(":").map(Number);
  let diff = (eh * 60 + em) - (sh * 60 + sm);
  if (diff < 0) diff += 1440;
  return diff;
}

export default function NewSession() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [saving, setSaving] = useState(false); // false | true | string
  const [expanded, setExpanded] = useState(new Set(["info", "subjective", "methods"]));
  const [data, setData] = useState({
    date: new Date().toISOString(),
    methods: [],
    intensity: 5,
    buildup_quality: 5,
    control: 5,
    satisfaction: 5,
    substances: [],
    tags: [],
    media_images: [],
    hr_timeline: [],
    is_favorite: false,
  });

  const toggleSection = (id) => {
    const next = new Set(expanded);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setExpanded(next);
  };

  const handleSave = async () => {
    if (!data.methods?.length) {
      toast({ title: "Please select at least one method", variant: "destructive" });
      return;
    }
    setSaving(true);
    const duration = calcDuration(data.start_time, data.end_time);
    const { _csv_rows, _emg_rows, _emg_channel_mode, ...sessionData } = data;
    const session = await base44.entities.Session.create({
      ...sessionData,
      duration_minutes: duration || data.duration_minutes,
    });
    // Import HeartRateTimeline rows via backend function
    if (_csv_rows && _csv_rows.length > 0) {
      const res = await base44.functions.invoke("saveTimelineData", {
        session_id: session.id, entity: "HeartRateTimeline", rows: _csv_rows,
      });
      if (res.data?.error) throw new Error(res.data.error);
    }
    // Import EMGTimeline rows in chunks to avoid timeouts
    if (_emg_rows && _emg_rows.length > 0) {
      const clearRes = await base44.functions.invoke("saveTimelineData", {
        session_id: session.id, entity: "EMGTimeline", action: "clear",
      });
      if (clearRes.data?.error) throw new Error(clearRes.data.error);

      const EMG_CHUNK = 5000;
      for (let i = 0; i < _emg_rows.length; i += EMG_CHUNK) {
        const chunk = _emg_rows.slice(i, i + EMG_CHUNK);
        const res = await base44.functions.invoke("saveTimelineData", {
          session_id: session.id, entity: "EMGTimeline", action: "append", rows: chunk,
        });
        if (res.data?.error) throw new Error(res.data.error);
        const pct = Math.min(100, Math.round(((i + chunk.length) / _emg_rows.length) * 100));
        setSaving(`Saving EMG… ${pct}%`);
      }
    }
    setSaving(false);
    toast({ title: "Session saved!", duration: 2000 });
    navigate("/sessions");
  };

  const renderSection = (id) => {
    const props = { data, onChange: setData };
    switch (id) {
      case "info": return <SessionInfoSection {...props} />;
      case "hr": return <HeartRateSection {...props} />;
      case "methods": return <MethodsSection {...props} />;
      case "subjective": return data.no_climax ? <NoClimaxSubjectiveSection {...props} /> : <SubjectiveSection {...props} />;
      case "physio": return <PhysiologicalSection {...props} />;
      case "context": return <ContextSection {...props} />;
      case "events": return <EventTimelineSection {...props} />;
      case "emg": return <EMGSection {...props} />;
      case "notes": return <NotesMediaSection {...props} />;
      default: return null;
    }
  };

  return (
    <div>
      <PageHeader
        title="New Session"
        subtitle="Full entry mode"
        action={
          <Link to="/new/quick">
            <Button variant="outline" size="sm" className="gap-1.5">
              <Zap className="w-4 h-4" /> Quick
            </Button>
          </Link>
        }
      />

      <div className="px-4 space-y-2 pb-6">
        {/* No-Climax Toggle */}
        <button
          type="button"
          onClick={() => setData((d) => ({ ...d, no_climax: !d.no_climax }))}
          className={`w-full flex items-center gap-3 px-4 py-3 rounded-xl border font-medium text-sm transition-all ${
            data.no_climax
              ? "bg-chart-4/15 border-chart-4/60 text-chart-4"
              : "bg-card border-border text-muted-foreground"
          }`}
        >
          <XCircle className="w-4 h-4 shrink-0" />
          <span className="flex-1 text-left">
            {data.no_climax ? "No Climax Session — toggled on" : "Mark as No-Climax Session"}
          </span>
          <span className={`text-xs px-2 py-0.5 rounded-full ${data.no_climax ? "bg-chart-4/20 text-chart-4" : "bg-muted text-muted-foreground"}`}>
            {data.no_climax ? "ON" : "OFF"}
          </span>
        </button>

        {SECTIONS.map(({ id, label }) => (
          <div key={id} className="bg-card rounded-xl border border-border overflow-hidden">
            <button
              type="button"
              onClick={() => toggleSection(id)}
              className="w-full flex items-center justify-between px-4 py-3 text-sm font-semibold"
            >
              {label}
              {expanded.has(id) ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>
            {expanded.has(id) && (
              <div className="px-4 pb-4 border-t border-border pt-3">
                {renderSection(id)}
              </div>
            )}
          </div>
        ))}

        <Button
          onClick={handleSave}
          disabled={saving}
          className="w-full h-14 text-base font-semibold gap-2 mt-4"
        >
          <Save className="w-5 h-5" />
          {saving ? (typeof saving === "string" ? saving : "Saving...") : "Save Session"}
        </Button>
      </div>
    </div>
  );
}