import { useState } from "react";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Plus, Trash2, Pencil, Check, X } from "lucide-react";

export const EVENT_CATEGORIES = [
  { value: "stimulation", label: "Stimulation", color: "#3b82f6" },
  { value: "stimulation_started", label: "Stim Started", color: "#06b6d4" },
  { value: "stimulation_paused", label: "Stim Paused", color: "#f97316" },
  { value: "stimulation_resumed", label: "Stim Resumed", color: "#22c55e" },
  { value: "stimulation_stopped", label: "Stim Stopped", color: "#ef4444" },
  { value: "sensation", label: "Sensation", color: "#a855f7" },
  { value: "physical", label: "Physical", color: "#10b981" },
  { value: "other", label: "Other", color: "#94a3b8" },
];

// Legacy string categories to migrate away from (old pause/resume values)
const LEGACY_PAUSE_RESUME = ["pause", "resume", "paused", "resumed"];

// Normalize a raw category value to a clean array, stripping legacy pause/resume strings
export function normalizeCategoryArray(raw) {
  if (!raw) return [];
  const arr = Array.isArray(raw) ? raw : [raw];
  // Strip old bare-string pause/resume tags that are no longer valid
  return arr.filter((v) => typeof v === "string" && v && !LEGACY_PAUSE_RESUME.includes(v.toLowerCase()));
}

function getCategoryMeta(value) {
  return EVENT_CATEGORIES.find((c) => c.value === value) || EVENT_CATEGORIES[EVENT_CATEGORIES.length - 1];
}

function fmtMmSs(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, "0")}`;
}

function CategoryPill({ value, small }) {
  const meta = getCategoryMeta(value);
  return (
    <span
      className={`inline-flex items-center rounded-full font-medium ${small ? "text-[9px] px-1.5 py-0" : "text-[10px] px-2 py-0.5"}`}
      style={{ background: meta.color + "22", color: meta.color, border: `1px solid ${meta.color}44` }}
    >
      {meta.label}
    </span>
  );
}

// Multi-category pill selector
function CategorySelector({ selected, onChange }) {
  const toggle = (val) => {
    if (selected.includes(val)) {
      onChange(selected.filter((v) => v !== val));
    } else {
      onChange([...selected, val]);
    }
  };
  return (
    <div className="flex flex-wrap gap-1.5">
      {EVENT_CATEGORIES.map((c) => {
        const active = selected.includes(c.value);
        return (
          <button key={c.value} type="button" onClick={() => toggle(c.value)}
            className="text-[10px] px-2 py-0.5 rounded-full border font-medium transition-all"
            style={active
              ? { background: c.color, color: "#fff", borderColor: c.color }
              : { background: c.color + "18", color: c.color, borderColor: c.color + "44" }
            }
          >{c.label}</button>
        );
      })}
    </div>
  );
}

// Normalize: events may have category as string or array, strip legacy values
function getCategories(ev) {
  return normalizeCategoryArray(ev.category);
}

function EventRow({ ev, idx, onRemove, onUpdate }) {
  const [editing, setEditing] = useState(false);
  const [editMin, setEditMin] = useState(String(Math.floor(ev.time_s / 60)));
  const [editSec, setEditSec] = useState(String(ev.time_s % 60));
  const [editNote, setEditNote] = useState(ev.note);
  const [editCats, setEditCats] = useState(normalizeCategoryArray(ev.category).length ? normalizeCategoryArray(ev.category) : ["other"]);

  const cats = getCategories(ev);
  const primaryMeta = getCategoryMeta(cats[0]);

  const saveEdit = () => {
    const m = parseInt(editMin, 10) || 0;
    const s = Math.min(59, parseInt(editSec, 10) || 0);
    onUpdate(idx, { ...ev, time_s: m * 60 + s, note: editNote.trim() || ev.note, category: editCats });
    setEditing(false);
  };

  const cancelEdit = () => {
    setEditMin(String(Math.floor(ev.time_s / 60)));
    setEditSec(String(ev.time_s % 60));
    setEditNote(ev.note);
    setEditCats(normalizeCategoryArray(ev.category).length ? normalizeCategoryArray(ev.category) : ["other"]);
    setEditing(false);
  };

  if (editing) {
    return (
      <div className="rounded-lg px-3 py-2.5 space-y-2" style={{ background: primaryMeta.color + "12", borderLeft: `3px solid ${primaryMeta.color}` }}>
        <div className="flex items-center gap-2">
          <Input type="number" min={0} value={editMin} onChange={(e) => setEditMin(e.target.value)}
            className="h-8 w-14 font-mono text-center text-xs" placeholder="Min" />
          <span className="text-muted-foreground font-bold">:</span>
          <Input type="number" min={0} max={59} value={editSec} onChange={(e) => setEditSec(e.target.value)}
            className="h-8 w-14 font-mono text-center text-xs" placeholder="Sec" />
        </div>
        <CategorySelector selected={editCats} onChange={setEditCats} />
        <Textarea value={editNote} onChange={(e) => setEditNote(e.target.value)} rows={2} className="text-sm resize-none" />
        <div className="flex gap-2">
          <Button size="sm" className="h-7 text-xs gap-1" onClick={saveEdit}><Check className="w-3 h-3" />Save</Button>
          <Button size="sm" variant="ghost" className="h-7 text-xs gap-1" onClick={cancelEdit}><X className="w-3 h-3" />Cancel</Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex items-start gap-2 rounded-lg px-3 py-2" style={{ background: primaryMeta.color + "0f", borderLeft: `3px solid ${primaryMeta.color}44` }}>
      <span className="font-mono text-xs text-primary shrink-0 mt-0.5 w-10">{fmtMmSs(ev.time_s)}</span>
      <div className="flex-1 min-w-0">
        <div className="flex flex-wrap gap-1 mb-0.5">
          {cats.map((c) => <CategoryPill key={c} value={c} small />)}
          {cats.length === 0 && <CategoryPill value="other" small />}
        </div>
        <p className="text-sm text-foreground leading-snug whitespace-pre-wrap">{ev.note}</p>
      </div>
      <div className="flex items-center gap-1 shrink-0 mt-0.5">
        <button onClick={() => setEditing(true)} className="text-muted-foreground hover:text-primary transition-colors">
          <Pencil className="w-3.5 h-3.5" />
        </button>
        <button onClick={() => onRemove(idx)} className="text-muted-foreground hover:text-destructive transition-colors">
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );
}

export default function EventTimelineSection({ data, onChange }) {
  const events = data.event_timeline || [];
  const [minutes, setMinutes] = useState("");
  const [seconds, setSeconds] = useState("");
  const [noteInput, setNoteInput] = useState("");
  const [categories, setCategories] = useState(["stimulation"]);
  const [timeError, setTimeError] = useState(false);

  const update = (newEvents) => onChange({ ...data, event_timeline: newEvents });

  const addEvent = () => {
    const m = parseInt(minutes, 10);
    const s = parseInt(seconds || "0", 10);
    if (isNaN(m) || m < 0 || isNaN(s) || s < 0 || s > 59) { setTimeError(true); return; }
    if (!noteInput.trim()) return;
    setTimeError(false);
    const totalSeconds = m * 60 + s;
    const newEvent = { time_s: totalSeconds, note: noteInput.trim(), category: categories };
    const sorted = [...events, newEvent].sort((a, b) => a.time_s - b.time_s);
    update(sorted);
    setMinutes("");
    setSeconds("");
    setNoteInput("");
  };

  const removeEvent = (idx) => update(events.filter((_, i) => i !== idx));

  const updateEvent = (idx, updated) => {
    const newEvents = events.map((e, i) => i === idx ? updated : e).sort((a, b) => a.time_s - b.time_s);
    update(newEvents);
  };

  return (
    <div className="space-y-4">
      <h3 className="text-sm font-semibold uppercase tracking-wider text-primary">Event Timeline</h3>
      <p className="text-xs text-muted-foreground -mt-2">
        Log notable moments — stimulation changes, sensations, pauses, or physical events. Select multiple tags.
      </p>

      {events.length > 0 && (
        <div className="space-y-1.5">
          {events.map((ev, i) => (
            <EventRow key={i} ev={ev} idx={i} onRemove={removeEvent} onUpdate={updateEvent} />
          ))}
        </div>
      )}

      <div className="space-y-2 bg-muted/30 rounded-xl p-3">
        <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Add Event</p>

        <div className="flex items-center gap-2">
          <Input type="number" min={0} value={minutes}
            onChange={(e) => { setMinutes(e.target.value); setTimeError(false); }}
            placeholder="Min" className={`h-9 w-16 font-mono text-center text-sm ${timeError ? "border-destructive" : ""}`} />
          <span className="text-muted-foreground font-bold text-lg">:</span>
          <Input type="number" min={0} max={59} value={seconds}
            onChange={(e) => { setSeconds(e.target.value); setTimeError(false); }}
            placeholder="Sec" className={`h-9 w-16 font-mono text-center text-sm ${timeError ? "border-destructive" : ""}`} />
          {timeError && <p className="text-[10px] text-destructive">Valid time required</p>}
        </div>

        <CategorySelector selected={categories} onChange={setCategories} />

        <div className="flex gap-2 items-end">
          <Textarea value={noteInput} onChange={(e) => setNoteInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); addEvent(); } }}
            placeholder="Describe the event…"
            rows={2} className="resize-none text-sm flex-1" />
          <Button type="button" onClick={addEvent} size="icon" className="h-10 w-10 shrink-0">
            <Plus className="w-4 h-4" />
          </Button>
        </div>
      </div>
    </div>
  );
}