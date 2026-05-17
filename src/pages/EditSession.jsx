import { useState, useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
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
import { Save, ChevronDown, ChevronUp, ArrowLeft, XCircle } from "lucide-react";

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

export default function EditSession() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [saving, setSaving] = useState(false); // false | "Saving session…" | { label: string, pct: number }

  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState(new Set(["info", "hr", "subjective", "methods"]));
  const [data, setData] = useState(null);

  useEffect(() => {
    (async () => {
      const [results, timelineRows] = await Promise.all([
        base44.entities.Session.filter({ id }),
        base44.entities.HeartRateTimeline.filter({ session: id }, "time_offset_s", 10000),
      ]);
      if (results[0]) {
        const session = results[0];
        // Auto-derive start_time from the session date if not already stored
        if (!session.start_time && session.date) {
          const etTime = new Date(session.date).toLocaleTimeString("en-US", {
            timeZone: "America/New_York",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          });
          session.start_time = etTime === "24:00" ? "00:00" : etTime;
        }
        // Pre-populate _csv_rows from stored timeline so chart + marker UI shows on edit
        if (timelineRows.length > 0) {
          session._csv_rows = timelineRows;
        }
        setData(session);
      }
      setLoading(false);
    })();
  }, [id]);

  const toggleSection = (sectionId) => {
    const next = new Set(expanded);
    if (next.has(sectionId)) next.delete(sectionId);
    else next.add(sectionId);
    setExpanded(next);
  };

  const handleSave = async () => {
    if (!data.methods?.length) {
      toast({ title: "Please select at least one method", variant: "destructive" });
      return;
    }
    setSaving({ label: "Saving session…", pct: 0 });
    try {

      const duration = calcDuration(data.start_time, data.end_time);
      // Exclude internal/computed fields that shouldn't be re-saved
      const { _csv_rows, _emg_rows, _emg_channel_mode, ai_analysis, ai_cascade, ...sessionData } = data;
      // _emg_rows is only used for in-memory preview; emg_data_file URL is already in sessionData

      // Sanitize event_timeline: ensure category is always a clean array of strings
      const LEGACY = ["pause", "resume", "paused", "resumed"];
      if (sessionData.event_timeline) {
        sessionData.event_timeline = sessionData.event_timeline.map((ev) => {
          const raw = ev.category;
          const arr = Array.isArray(raw) ? raw : (raw ? [raw] : []);
          const cats = arr.filter((v) => typeof v === "string" && v && !LEGACY.includes(v.toLowerCase()));
          return { ...ev, category: cats.length ? cats : ["other"] };
        });
      }

      await base44.entities.Session.update(id, {
        ...sessionData,
        duration_minutes: duration || data.duration_minutes,
      });
      if (_csv_rows && _csv_rows.length > 0) {
        setSaving({ label: "Saving heart rate data…", pct: 10 });
        const res = await base44.functions.invoke("saveTimelineData", {
          session_id: id, entity: "HeartRateTimeline", rows: _csv_rows,
        });
        if (res.data?.error) throw new Error(res.data.error);
      }
      // EMG data is stored as a file URL (emg_data_file) on the session — no separate upload needed
      setSaving(false);
      toast({ title: "Session updated!", duration: 2000 });
      navigate(`/sessions/${id}`);
    } catch (err) {
      toast({ title: "Save failed: " + err.message, variant: "destructive" });
      setSaving(false);
    }
  };

  const renderSection = (sectionId) => {
    const props = { data, onChange: setData };
    switch (sectionId) {
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

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  if (!data) {
    return <div className="p-6 text-center text-muted-foreground">Session not found</div>;
  }

  return (
    <div>
      <PageHeader
        title="Edit Session"
        subtitle="Update session details"
        action={
          <Button variant="ghost" size="sm" onClick={() => navigate(-1)} className="gap-1.5">
            <ArrowLeft className="w-4 h-4" /> Back
          </Button>
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

        {SECTIONS.map(({ id: sId, label }) => (
          <div key={sId} className="bg-card rounded-xl border border-border overflow-hidden">
            <button
              type="button"
              onClick={() => toggleSection(sId)}
              className="w-full flex items-center justify-between px-4 py-3 text-sm font-semibold"
            >
              {label}
              {expanded.has(sId) ? <ChevronUp className="w-4 h-4" /> : <ChevronDown className="w-4 h-4" />}
            </button>
            {expanded.has(sId) && (
              <div className="px-4 pb-4 border-t border-border pt-3">
                {renderSection(sId)}
              </div>
            )}
          </div>
        ))}

        {saving && typeof saving === "object" && (
          <div className="mt-4 bg-card border border-border rounded-xl p-4 space-y-2">
            <div className="flex items-center justify-between text-sm">
              <span className="text-foreground font-medium">{saving.label}</span>
              <span className="font-mono text-primary font-bold">{saving.pct}%</span>
            </div>
            <div className="h-2.5 bg-muted rounded-full overflow-hidden">
              <div
                className="h-full bg-primary rounded-full transition-all duration-300"
                style={{ width: `${saving.pct}%` }}
              />
            </div>
          </div>
        )}
        <Button
          onClick={handleSave}
          disabled={!!saving}
          className="w-full h-14 text-base font-semibold gap-2 mt-4"
        >
          <Save className="w-5 h-5" />
          {saving ? (typeof saving === "object" ? "Saving…" : saving) : "Save Changes"}
        </Button>
      </div>
    </div>
  );
}