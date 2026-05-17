import { useState } from "react";
import { base44 } from "@/api/base44Client";
import { Zap, Brain, ChevronDown, ChevronUp } from "lucide-react";
import { Button } from "@/components/ui/button";
import TTSReader from "./TTSReader";

function fmtMmSs(s) {
  const totalS = Math.round(Number(s));
  const m = Math.floor(totalS / 60);
  const sec = totalS % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

const SECTIONS = [
  { key: "physiological_interpretation", label: "Physiological Interpretation", single: true, color: "hsl(var(--chart-3))" },
  { key: "pattern_analysis", label: "Pattern Analysis", color: "hsl(var(--primary))" },
  { key: "role_in_arousal_arc", label: "Role in Arousal Arc", single: true, color: "hsl(var(--chart-2))" },
  { key: "recommendations", label: "Recommendations", color: "hsl(var(--accent))" },
];

export default function NearClimaxSessionOverview({ session, nearClimaxEvents, userProfile }) {
  const [collapsed, setCollapsed] = useState(true);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(session.ai_near_climax_overview ?? null);

  if (!nearClimaxEvents || nearClimaxEvents.length === 0) return null;

  const profileContext = userProfile && (userProfile.arousal_response_style || userProfile.arousal_notes || userProfile.climax_sensitivity)
    ? `\nUSER AROUSAL PROFILE:\n- Arousal style: ${userProfile.arousal_response_style || "—"}\n- Typical build duration: ${userProfile.typical_build_duration || "—"}\n- Climax sensitivity: ${userProfile.climax_sensitivity || "—"}\n- Preferred stimulation: ${(userProfile.preferred_stimulation || []).join(", ") || "—"}\n- Arousal notes: ${userProfile.arousal_notes || "none"}\n`
    : "";

  const analyze = async () => {
    setLoading(true);
    setResult(null);

    const eventsForPrompt = nearClimaxEvents.map((ev, i) => ({
      index: i + 1,
      start: fmtMmSs(ev.start_offset_s),
      peak: fmtMmSs(ev.peak_offset_s),
      end: fmtMmSs(ev.end_offset_s),
      base_hr: ev.base_hr,
      peak_hr: ev.peak_hr,
      rise_bpm: ev.rise_bpm,
      sustained_s: ev.sustained_s,
      duration_s: ev.duration_s,
      label: ev.ai_label || null,
      note_corroborated: ev.note_corroborated,
    }));

    const userEvents = (session.event_timeline || []).map((e) => ({
      time: fmtMmSs(e.time_s),
      category: Array.isArray(e.category) ? e.category : [e.category].filter(Boolean),
      note: e.note,
    }));

    const existingAnalysis = session.ai_analysis
      ? [session.ai_analysis.summary, ...(session.ai_analysis.arousal_arc || [])].filter(Boolean).join(" ")
      : "";

    const res = await base44.integrations.Core.InvokeLLM({
      model: "claude_sonnet_4_6",
      prompt: `You are a physiological analyst providing a session-specific interpretation of near-climax events detected in heart rate data. Write directly to the person — use "you" and "your" throughout, as if speaking to them personally.

DEFINITION: A near-climax event is a sustained HR elevation (8+ bpm rise, held for 20+ seconds, then resolved) occurring before the actual climax window. These may represent arousal plateaus, stimulation intensity peaks, autonomic surges, physical reflexes, or deliberate arousal control — interpret based on context, not assumption.

CRITICAL FOR TEXT-TO-SPEECH QUALITY:
- Spell out all numbers as words: "twelve beats per minute", "forty seconds", "two minutes and thirty seconds"
- Write "beats per minute" not "bpm", "seconds" not "s", "minutes" not "min"  
- Conversational prose — short sentences, natural cadence, no bullet-point thinking
- No digits starting a sentence

${profileContext}
SESSION CONTEXT:
- Date: ${session.date?.slice(0, 10) || "?"}
- Duration: ${session.duration_minutes || "?"} minutes
- Methods: ${(session.methods || []).join(", ") || "?"}
- Intensity: ${session.intensity || "?"}/10 | Satisfaction: ${session.satisfaction || "?"}/10
- Mood: ${session.mood || "?"} | Build type: ${session.build_type || "?"}
- Max HR: ${session.max_hr || "?"} bpm | Avg HR: ${session.avg_hr || "?"} bpm
- Climax at: ${session.climax_offset_s != null ? fmtMmSs(session.climax_offset_s) : "none"}
${existingAnalysis ? `\nAI SESSION ANALYSIS CONTEXT:\n${existingAnalysis.slice(0, 1000)}` : ""}

NEAR-CLIMAX EVENTS DETECTED (${nearClimaxEvents.length} total):
${JSON.stringify(eventsForPrompt, null, 2)}

${userEvents.length > 0 ? `USER-LOGGED EVENTS:\n${userEvents.map((e) => `[${e.time}] ${e.category.join(",")} — ${e.note}`).join("\n")}` : ""}

Analyze these events in the context of this specific session. Cover:
1. What these events physiologically represent for this session — avoid defaulting to "edging"
2. Patterns across the events (timing, intensity, spacing, relationship to user-logged events)
3. How they fit into the overall arousal arc and what they signal about the build
4. Actionable insights — what these events suggest for future sessions`,
      response_json_schema: {
        type: "object",
        properties: {
          summary: { type: "string" },
          physiological_interpretation: { type: "string" },
          pattern_analysis: { type: "array", items: { type: "string" } },
          role_in_arousal_arc: { type: "string" },
          recommendations: { type: "array", items: { type: "string" } },
        },
        required: ["summary", "physiological_interpretation", "pattern_analysis", "role_in_arousal_arc", "recommendations"],
      },
    });

    const raw = typeof res === "string" ? JSON.parse(res) : res;
    const parsed = raw?.response ?? raw;
    setResult(parsed);
    await base44.entities.Session.update(session.id, { ai_near_climax_overview: parsed });
    setLoading(false);
  };

  const paras = [];
  const paraMeta = [];
  if (result) {
    if (result.summary) { paras.push(result.summary); paraMeta.push({ type: "summary" }); }
    for (const sec of SECTIONS) {
      if (sec.single) {
        if (result[sec.key]) { paras.push(result[sec.key]); paraMeta.push({ type: "section", sec, first: true }); }
      } else {
        (result[sec.key] || []).forEach((item, i) => {
          paras.push(item);
          paraMeta.push({ type: "section", sec, first: i === 0 });
        });
      }
    }
  }

  return (
    <div className="bg-card rounded-xl border border-border p-4 space-y-3" style={{ borderColor: "hsl(var(--chart-3) / 0.3)" }}>
      <div className="flex items-center justify-between">
        <button className="flex items-center gap-1.5 flex-1 text-left" onClick={() => setCollapsed((v) => !v)}>
          <h3 className="text-xs font-semibold uppercase tracking-wider flex items-center gap-1.5" style={{ color: "hsl(var(--chart-3))" }}>
            <Zap className="w-4 h-4" /> Near-Climax Overview
          </h3>
          {collapsed ? <ChevronDown className="w-4 h-4 text-muted-foreground ml-1" /> : <ChevronUp className="w-4 h-4 text-muted-foreground ml-1" />}
        </button>
        <Button
          size="sm"
          onClick={analyze}
          disabled={loading}
          className="h-7 text-xs gap-1.5"
        >
          {loading
            ? <><span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />Analyzing…</>
            : <><Brain className="w-3 h-3" />{result ? "Re-analyze" : "Analyze"}</>}
        </Button>
      </div>

      {!collapsed && !result && !loading && (
        <p className="text-xs text-muted-foreground">
          Session-specific narrative analysis of the {nearClimaxEvents.length} near-climax event{nearClimaxEvents.length !== 1 ? "s" : ""} detected above — what they represent, how they fit the arc, and what they suggest. Uses Claude Sonnet.
        </p>
      )}

      {!collapsed && result && (
        <TTSReader
          sessionId={session.id + "_nc_overview"}
          title="Near-Climax Overview"
          sessionDate={session.date}
          paragraphs={paras}
          renderParagraph={(text, idx, isActive, isBuffering) => {
            const meta = paraMeta[idx];
            if (!meta) return null;

            if (meta.type === "summary") {
              return (
                <p className={`text-base font-medium leading-relaxed border-l-2 pl-3 py-1 transition-all duration-200 rounded-r-md flex items-center gap-2 ${isActive ? "border-chart-3 bg-chart-3/10 text-foreground" : "border-chart-3/50 text-foreground"}`}
                  style={{ borderColor: isActive ? "hsl(var(--chart-3))" : "hsl(var(--chart-3) / 0.5)" }}>
                  {isBuffering && <span className="shrink-0 w-3 h-3 border-2 border-t-transparent rounded-full animate-spin" style={{ borderColor: "hsl(var(--chart-3))", borderTopColor: "transparent" }} />}
                  {text}
                </p>
              );
            }

            const { sec, first } = meta;
            return (
              <div>
                {first && (
                  <p className="text-[10px] font-semibold uppercase tracking-wider mt-3 mb-1.5" style={{ color: sec.color }}>
                    {sec.label}
                  </p>
                )}
                <li
                  className="text-sm pl-3 border-l-2 py-1.5 leading-relaxed list-none transition-all duration-200 rounded-r-md flex items-start gap-2"
                  style={{
                    borderColor: isActive ? sec.color : sec.color + "55",
                    background: isActive ? sec.color + "18" : "transparent",
                    color: "hsl(var(--foreground))",
                  }}
                >
                  {isBuffering && <span className="shrink-0 w-3 h-3 border-2 border-t-transparent rounded-full animate-spin mt-0.5" style={{ borderColor: sec.color, borderTopColor: "transparent" }} />}
                  {text}
                </li>
              </div>
            );
          }}
        />
      )}
    </div>
  );
}