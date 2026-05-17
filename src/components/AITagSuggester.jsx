import { useState } from "react";
import { base44 } from "@/api/base44Client";
import { Sparkles, Plus, Check } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function AITagSuggester({ session, onTagsAdded }) {
  const [loading, setLoading] = useState(false);
  const [suggestions, setSuggestions] = useState([]);
  const [selected, setSelected] = useState(new Set());
  const [saved, setSaved] = useState(false);

  const existingTags = new Set((session.tags || []).map((t) => t.toLowerCase()));

  const suggest = async () => {
    setLoading(true);
    setSuggestions([]);
    setSaved(false);
    setSelected(new Set());

    const events = (session.event_timeline || []).map((ev) => {
      const cats = Array.isArray(ev.category) ? ev.category : [ev.category].filter(Boolean);
      return `[${cats.join("+")}] ${Math.floor(ev.time_s / 60)}:${String(ev.time_s % 60).padStart(2, "0")} — ${ev.note}`;
    });

    const res = await base44.integrations.Core.InvokeLLM({
      prompt: `You are a tagging assistant for a personal biophysiological session journal. Analyze the session data below and suggest 5–10 concise, searchable tags that best describe this session. Tags should capture: stimulation methods, physical sensations, build type, mood, notable events, equipment used, or any other distinguishing characteristics.

Tags must be:
- Lowercase, hyphenated (e.g. "slow-build", "e-stim", "high-intensity")
- Specific and searchable (not generic like "good" or "session")
- Based only on what's actually present in the data

Session data:
- Methods: ${(session.methods || []).join(", ")}
- Intensity: ${session.intensity}/10
- Satisfaction: ${session.satisfaction}/10
- Build type: ${session.build_type || "N/A"}
- Mood: ${session.mood || "N/A"}
- Climax duration: ${session.climax_duration || "N/A"}
- Foley size: ${session.foley_size ? session.foley_size + " Fr" : "N/A"}
- E-stim notes: ${session.estim_notes || "N/A"}
- Notes: ${session.notes || "none"}
- Event timeline (${events.length} events):
${events.length ? events.join("\n") : "none"}

Return ONLY the tag array, no explanation.`,
      response_json_schema: {
        type: "object",
        properties: {
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["tags"],
      },
    });

    const raw = typeof res === "string" ? JSON.parse(res) : res;
    const parsed = raw?.response ?? raw;
    const newTags = (parsed.tags || []).filter((t) => !existingTags.has(t.toLowerCase()));
    setSuggestions(newTags);
    setSelected(new Set(newTags)); // pre-select all
    setLoading(false);
  };

  const toggleTag = (tag) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag); else next.add(tag);
      return next;
    });
  };

  const applyTags = async () => {
    const toAdd = [...selected];
    if (!toAdd.length) return;
    const merged = [...new Set([...(session.tags || []), ...toAdd])];
    await base44.entities.Session.update(session.id, { tags: merged });
    onTagsAdded(merged);
    setSaved(true);
    setSuggestions([]);
    setSelected(new Set());
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs text-muted-foreground">Auto-suggest tags from notes &amp; events</span>
        <Button
          size="sm"
          variant="outline"
          onClick={suggest}
          disabled={loading}
          className="h-7 text-xs gap-1.5"
        >
          {loading
            ? <><span className="w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />Thinking…</>
            : <><Sparkles className="w-3 h-3" />Suggest Tags</>}
        </Button>
      </div>

      {saved && (
        <p className="text-xs text-primary flex items-center gap-1">
          <Check className="w-3 h-3" /> Tags added successfully
        </p>
      )}

      {suggestions.length > 0 && (
        <div className="space-y-2 bg-muted/40 rounded-xl p-3">
          <p className="text-[10px] uppercase font-semibold tracking-wider text-muted-foreground">
            Tap to select · then apply
          </p>
          <div className="flex flex-wrap gap-1.5">
            {suggestions.map((tag) => {
              const active = selected.has(tag);
              return (
                <button
                  key={tag}
                  onClick={() => toggleTag(tag)}
                  className="text-xs px-2.5 py-1 rounded-full border font-medium transition-all"
                  style={active
                    ? { background: "hsl(var(--primary))", color: "#fff", borderColor: "hsl(var(--primary))" }
                    : { background: "transparent", color: "hsl(var(--muted-foreground))", borderColor: "hsl(var(--border))" }}
                >
                  {active ? <span className="inline-flex items-center gap-1"><Check className="w-2.5 h-2.5" />{tag}</span> : tag}
                </button>
              );
            })}
          </div>
          <Button
            size="sm"
            onClick={applyTags}
            disabled={selected.size === 0}
            className="h-7 text-xs gap-1"
          >
            <Plus className="w-3 h-3" /> Add {selected.size} tag{selected.size !== 1 ? "s" : ""}
          </Button>
        </div>
      )}
    </div>
  );
}