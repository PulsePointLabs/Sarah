import { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { BookOpen, ChevronDown, ChevronUp, Trash2, Calendar, Clock } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import TTSReader from "../components/TTSReader";
import moment from "moment";

const SECTION_COLORS = {
  emotional_reflection:       "hsl(var(--chart-3))",
  physiological_observations: "hsl(var(--primary))",
  experience_narrative:       "hsl(var(--chart-2))",
  insights:                   "hsl(var(--accent))",
  next_session_intentions:    "hsl(var(--chart-4))",
};

const SECTION_LABELS = {
  emotional_reflection:       "Emotional Reflection",
  physiological_observations: "Physiological Observations",
  experience_narrative:       "Experience Narrative",
  insights:                   "Insights",
  next_session_intentions:    "Next Session Intentions",
};

const ORDERED_KEYS = [
  "emotional_reflection",
  "physiological_observations",
  "experience_narrative",
  "insights",
  "next_session_intentions",
];

function buildParagraphs(j) {
  const paras = [];
  const meta = [];
  if (j?.title) { paras.push(j.title); meta.push({ type: "title" }); }
  for (const key of ORDERED_KEYS) {
    if (!j?.[key]) continue;
    paras.push(j[key]);
    meta.push({ type: "section", key });
  }
  for (const moment of (j?.key_moments || [])) {
    paras.push(moment);
    meta.push({ type: "moment" });
  }
  return { paras, meta };
}

function JournalCard({ journal, onDelete }) {
  const [expanded, setExpanded] = useState(false);
  const [deleting, setDeleting] = useState(false);

  const dateStr = journal.session_date
    ? moment(journal.session_date).format("MMMM D, YYYY")
    : moment(journal.created_date).format("MMMM D, YYYY");

  const timeStr = journal.session_date
    ? moment(journal.session_date).format("h:mm A")
    : null;

  const ai = journal.ai_journal;
  const { paras, meta } = buildParagraphs(ai);

  const handleDelete = async () => {
    setDeleting(true);
    await base44.entities.Journal.delete(journal.id);
    onDelete(journal.id);
  };

  return (
    <div className="bg-card rounded-xl border border-border overflow-hidden">
      {/* Header */}
      <button
        className="w-full flex items-center justify-between px-4 py-3 text-left hover:bg-muted/30 transition-colors"
        onClick={() => setExpanded(v => !v)}
      >
        <div className="flex items-center gap-3 min-w-0">
          <div className="w-8 h-8 rounded-lg bg-accent/10 flex items-center justify-center shrink-0">
            <BookOpen className="w-4 h-4 text-accent" />
          </div>
          <div className="min-w-0">
            <p className="font-semibold text-sm truncate">
              {ai?.title || dateStr}
            </p>
            <div className="flex items-center gap-2 mt-0.5 flex-wrap">
              <span className="text-[11px] text-muted-foreground flex items-center gap-1">
                <Calendar className="w-3 h-3" />{dateStr}
              </span>
              {timeStr && (
                <span className="text-[11px] text-muted-foreground flex items-center gap-1">
                  <Clock className="w-3 h-3" />{timeStr}
                </span>
              )}
              {ai && <Badge variant="secondary" className="text-[9px] h-4 px-1.5">AI generated</Badge>}
            </div>
          </div>
        </div>
        <div className="flex items-center gap-1.5 shrink-0 ml-2">
          <Button
            size="sm" variant="ghost"
            onClick={e => { e.stopPropagation(); handleDelete(); }}
            disabled={deleting}
            className="h-7 w-7 p-0 text-destructive/60 hover:text-destructive"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </Button>
          {expanded
            ? <ChevronUp className="w-4 h-4 text-muted-foreground" />
            : <ChevronDown className="w-4 h-4 text-muted-foreground" />}
        </div>
      </button>

      {/* Expanded content */}
      {expanded && (
        <div className="px-4 pb-4 space-y-4 border-t border-border pt-3">
          {/* Voice transcript */}
          {journal.voice_transcript && (
            <div className="space-y-1">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Your Notes</p>
              <p className="text-sm text-foreground/80 whitespace-pre-wrap leading-relaxed bg-muted/40 rounded-lg px-3 py-2">
                {journal.voice_transcript}
              </p>
            </div>
          )}

          {/* AI journal output */}
          {ai && paras.length > 0 ? (
            <TTSReader
              sessionId={`journal-list-${journal.id}`}
              title={`${dateStr} – Session Journal`}
              paragraphs={paras}
              renderParagraph={(text, idx, isActive, isBuffering) => {
                const m = meta[idx];
                if (!m) return null;

                if (m.type === "title") {
                  return (
                    <p className={`text-base font-semibold leading-snug border-l-2 pl-3 py-1 transition-all rounded-r-md ${
                      isActive ? "border-accent bg-accent/10 text-foreground" : "border-accent/50 text-foreground"
                    }`}>
                      {text}
                    </p>
                  );
                }

                if (m.type === "moment") {
                  return (
                    <li className={`text-sm pl-3 border-l-2 py-0.5 list-none leading-relaxed transition-all rounded-r-md ${
                      isActive ? "border-chart-4 bg-chart-4/10" : "border-chart-4/40"
                    }`} style={{ color: "hsl(var(--foreground))" }}>
                      {isBuffering && <span className="inline-block w-2.5 h-2.5 border-2 border-t-transparent rounded-full animate-spin mr-1.5 align-middle" style={{ borderColor: "hsl(var(--chart-4))" }} />}
                      {text}
                    </li>
                  );
                }

                const color = SECTION_COLORS[m.key] || "hsl(var(--primary))";
                const label = SECTION_LABELS[m.key] || m.key;

                return (
                  <div
                    className="pl-3 border-l-2 py-2 leading-relaxed transition-all duration-200 rounded-r-md"
                    style={{
                      borderColor: isActive ? color : color + "66",
                      background: isActive ? color + "18" : isBuffering ? color + "0f" : "transparent",
                    }}
                  >
                    <p className="text-[10px] font-semibold uppercase tracking-wider mb-1 flex items-center gap-1" style={{ color }}>
                      {isBuffering && <span className="w-2.5 h-2.5 border-2 border-t-transparent rounded-full animate-spin shrink-0" style={{ borderColor: color, borderTopColor: "transparent" }} />}
                      {label}
                    </p>
                    <p className="text-sm" style={{ color: isActive ? "#fff" : "hsl(var(--foreground))" }}>{text}</p>
                  </div>
                );
              }}
            />
          ) : (
            <p className="text-xs text-muted-foreground">No AI journal generated for this entry.</p>
          )}
        </div>
      )}
    </div>
  );
}

export default function JournalList() {
  const [journals, setJournals] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    base44.entities.Journal.list("-session_date", 200).then((rows) => {
      setJournals(rows);
      setLoading(false);
    });
  }, []);

  const handleDelete = (id) => {
    setJournals(prev => prev.filter(j => j.id !== id));
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="px-4 py-6 pb-24 space-y-4">
      <div>
        <h1 className="text-2xl font-bold tracking-tight flex items-center gap-2">
          <BookOpen className="w-6 h-6 text-accent" /> Session Journal
        </h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          {journals.length} {journals.length === 1 ? "entry" : "entries"}
        </p>
      </div>

      {journals.length === 0 ? (
        <div className="text-center py-16 text-muted-foreground">
          <BookOpen className="w-10 h-10 mx-auto mb-3 opacity-30" />
          <p className="text-sm">No journal entries yet.</p>
          <p className="text-xs mt-1">Open a session and click <strong>Generate</strong> in the Session Journal section.</p>
        </div>
      ) : (
        <div className="space-y-3">
          {journals.map(j => (
            <JournalCard key={j.id} journal={j} onDelete={handleDelete} />
          ))}
        </div>
      )}
    </div>
  );
}