import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, ChevronDown, ChevronUp, Save, ScanSearch } from "lucide-react";
import { base44 } from "@/api/base44Client";
import PageHeader from "@/components/PageHeader";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { useToast } from "@/components/ui/use-toast";
import SessionInfoSection from "@/components/session-form/SessionInfoSection";
import HeartRateSection from "@/components/session-form/HeartRateSection";
import PulseOxSection from "@/components/session-form/PulseOxSection";
import EMGSection from "@/components/session-form/EMGSection";
import EventTimelineSection from "@/components/session-form/EventTimelineSection";
import NotesMediaSection from "@/components/session-form/NotesMediaSection";

const TYPE_OPTIONS = ["Body exploration", "Foley insertion", "Urethral sounding", "Device fit trial", "Non-masturbatory experimentation", "Other"];
const METHOD_OPTIONS = ["Foley Catheter", "Urethral Sound", "Manual Observation", "Device Fit Trial", "MyoWare EMG", "Other"];
const SECTIONS = [
  { id: "overview", label: "Exploration Details" },
  { id: "info", label: "Timing" },
  { id: "hr", label: "Heart Rate" },
  { id: "pulse-ox", label: "Pulse Oximetry" },
  { id: "emg", label: "EMG (Optional)" },
  { id: "events", label: "Timestamped Notes" },
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

function ChipGroup({ options, selected = [], onChange }) {
  return <div className="flex flex-wrap gap-2">{options.map((option) => {
    const active = selected.includes(option);
    return <button key={option} type="button" onClick={() => onChange(active ? selected.filter((item) => item !== option) : [...selected, option])} className={`rounded-lg border px-3 py-2 text-sm font-medium ${active ? "border-primary bg-primary text-primary-foreground" : "border-border bg-card text-foreground"}`}>{option}</button>;
  })}</div>;
}

export default function NewBodyExploration() {
  const { id } = useParams();
  const navigate = useNavigate();
  const { toast } = useToast();
  const [saving, setSaving] = useState(false);
  const [expanded, setExpanded] = useState(new Set(["overview", "info", "hr", "pulse-ox"]));
  const [data, setData] = useState({
    date: new Date().toISOString(),
    title: "",
    exploration_type: "Body exploration",
    methods: [],
    focus_areas: "",
    purpose: "",
    devices: "",
    tags: [],
    media_images: [],
    hr_timeline: [],
    standalone_body_exploration: true,
    telemetry_only: true,
  });
  const [loading, setLoading] = useState(!!id);

  useEffect(() => {
    if (!id) return;
    (async () => {
      const [items, timelineRows] = await Promise.all([
        base44.entities.BodyExploration.filter({ id }),
        base44.entities.HeartRateTimeline.filter({ session: id }, "time_offset_s", 10000),
      ]);
      const exploration = items[0];
      if (exploration) {
        setData({
          ...exploration,
          standalone_body_exploration: true,
          telemetry_only: true,
          _csv_rows: timelineRows.length ? timelineRows : exploration._csv_rows,
        });
      }
      setLoading(false);
    })();
  }, [id]);

  const update = (field, value) => setData((current) => ({ ...current, [field]: value }));
  const toggle = (id) => setExpanded((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });

  const save = async () => {
    setSaving(true);
    try {
      const duration = calcDuration(data.start_time, data.end_time);
      const { _csv_rows, _pulse_ox_rows, _emg_rows, _emg_channel_mode, ...record } = data;
      const exploration = id
        ? await base44.entities.BodyExploration.update(id, { ...record, duration_minutes: duration || data.duration_minutes })
        : await base44.entities.BodyExploration.create({ ...record, duration_minutes: duration || data.duration_minutes });
      if (_csv_rows?.length) {
        const res = await base44.functions.invoke("saveTimelineData", { session_id: exploration.id, entity: "HeartRateTimeline", rows: _csv_rows });
        if (res.data?.error) throw new Error(res.data.error);
      }
      if (_emg_rows?.length) {
        await base44.functions.invoke("saveTimelineData", { session_id: exploration.id, entity: "EMGTimeline", action: "clear" });
        for (let index = 0; index < _emg_rows.length; index += 5000) {
          const res = await base44.functions.invoke("saveTimelineData", { session_id: exploration.id, entity: "EMGTimeline", action: "append", rows: _emg_rows.slice(index, index + 5000) });
          if (res.data?.error) throw new Error(res.data.error);
        }
      }
      toast({ title: id ? "Body exploration updated" : "Body exploration saved", duration: 2000 });
      navigate(`/exploration/${exploration.id}`);
    } catch (error) {
      toast({ title: `Save failed: ${error.message}`, variant: "destructive" });
    } finally {
      setSaving(false);
    }
  };

  if (loading) return <div className="flex h-64 items-center justify-center"><div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent" /></div>;

  const detailSection = (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div><Label className="text-xs text-muted-foreground">Title</Label><Input value={data.title} onChange={(event) => update("title", event.target.value)} placeholder="e.g. Foley insertion comfort review" className="mt-1 h-11" /></div>
        <div>
          <Label className="text-xs text-muted-foreground">Exploration Type</Label>
          <select value={data.exploration_type} onChange={(event) => update("exploration_type", event.target.value)} className="mt-1 h-11 w-full rounded-lg border border-border bg-background px-3 text-sm">
            {TYPE_OPTIONS.map((option) => <option key={option} value={option}>{option}</option>)}
          </select>
        </div>
      </div>
      <div><Label className="mb-2 block text-xs text-muted-foreground">Methods / Instrumentation</Label><ChipGroup options={METHOD_OPTIONS} selected={data.methods} onChange={(methods) => update("methods", methods)} /></div>
      <div className="grid gap-3 sm:grid-cols-2">
        <div><Label className="text-xs text-muted-foreground">Foley Size</Label><Input value={data.foley_size || ""} onChange={(event) => update("foley_size", event.target.value)} placeholder="e.g. 18 Fr" className="mt-1 h-11" /></div>
        <div><Label className="text-xs text-muted-foreground">Foley Type</Label><Input value={data.foley_type || ""} onChange={(event) => update("foley_type", event.target.value)} placeholder="e.g. silicone" className="mt-1 h-11" /></div>
      </div>
      <div><Label className="text-xs text-muted-foreground">Purpose / Question</Label><Textarea value={data.purpose || ""} onChange={(event) => update("purpose", event.target.value)} rows={2} placeholder="What are you exploring, comparing, or trying to observe?" className="mt-1" /></div>
      <div><Label className="text-xs text-muted-foreground">Focus Areas</Label><Textarea value={data.focus_areas || ""} onChange={(event) => update("focus_areas", event.target.value)} rows={2} placeholder="Anatomical area, device interaction, comfort, insertion response, positioning, fit..." className="mt-1" /></div>
      <div><Label className="text-xs text-muted-foreground">Devices / Setup</Label><Textarea value={data.devices || ""} onChange={(event) => update("devices", event.target.value)} rows={2} placeholder="Instrumentation, lubrication, positioning, setup details..." className="mt-1" /></div>
      <div><Label className="text-xs text-muted-foreground">Observed Findings</Label><Textarea value={data.findings || ""} onChange={(event) => update("findings", event.target.value)} rows={3} placeholder="What was noticed during the exploration?" className="mt-1" /></div>
      <div><Label className="text-xs text-muted-foreground">Comfort Notes</Label><Textarea value={data.comfort_notes || ""} onChange={(event) => update("comfort_notes", event.target.value)} rows={2} placeholder="Comfort, pressure, tension, movement, irritation, or tolerance observations." className="mt-1" /></div>
      <div><Label className="text-xs text-muted-foreground">Sounding Notes</Label><Textarea value={data.sounding_notes || ""} onChange={(event) => update("sounding_notes", event.target.value)} rows={2} placeholder="Optional instrumentation observations." className="mt-1" /></div>
    </div>
  );

  const renderSection = (id) => {
    const props = { data, onChange: setData };
    if (id === "overview") return detailSection;
    if (id === "info") return <SessionInfoSection {...props} />;
    if (id === "hr") return <HeartRateSection {...props} />;
    if (id === "pulse-ox") return <PulseOxSection {...props} />;
    if (id === "emg") return <EMGSection {...props} />;
    if (id === "events") return <EventTimelineSection {...props} />;
    if (id === "notes") return <NotesMediaSection {...props} />;
    return null;
  };

  return (
    <div>
      <PageHeader
        title={id ? "Edit Body Exploration" : "New Body Exploration"}
        subtitle="Standalone instrumentation and observation record"
        icon={ScanSearch}
        action={id ? <Button variant="ghost" size="sm" onClick={() => navigate(-1)} className="gap-1.5"><ArrowLeft className="h-4 w-4" /> Back</Button> : null}
      />
      <div className="space-y-2 px-4 pb-8">
        <div className="rounded-xl border border-primary/25 bg-primary/10 p-4 text-sm text-foreground">This workflow is separate from climax-oriented sessions. Heart-rate telemetry and pulse-ox CSV imports are supported, EMG is optional, and AI feedback focuses on exploration, instrumentation, comfort, and observed findings.</div>
        {SECTIONS.map((section) => <div id={section.id} key={section.id} className="scroll-mt-24 overflow-hidden rounded-xl border border-border bg-card">
          <button type="button" onClick={() => toggle(section.id)} className="flex w-full items-center justify-between px-4 py-3 text-sm font-semibold">{section.label}{expanded.has(section.id) ? <ChevronUp className="h-4 w-4" /> : <ChevronDown className="h-4 w-4" />}</button>
          {expanded.has(section.id) && <div className="border-t border-border px-4 pb-4 pt-3">{renderSection(section.id)}</div>}
        </div>)}
        <Button onClick={save} disabled={saving} className="mt-4 h-14 w-full gap-2 text-base font-semibold"><Save className="h-5 w-5" />{saving ? "Saving..." : id ? "Save Changes" : "Save Body Exploration"}</Button>
      </div>
    </div>
  );
}
