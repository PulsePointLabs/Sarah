import { useState, useEffect, useRef } from "react";
import { base44 } from "@/api/base44Client";
import { Brain, Activity, TrendingUp, Zap, Lightbulb, AlertCircle } from "lucide-react";
import TTSReader from "./TTSReader";

const SECTION_COLORS = {
  "chart-1": "hsl(var(--chart-1))",
  "chart-2": "hsl(var(--chart-2))",
  "chart-4": "hsl(var(--chart-4))",
  accent: "hsl(var(--accent))",
  destructive: "hsl(var(--destructive))"
};

function Section({ icon, title, color, children }) {
  return (
    <div className="bg-muted/40 rounded-lg p-3 space-y-2">
      <p className="flex items-center gap-1.5 text-xs font-semibold" style={{ color: SECTION_COLORS[color] }}>
        {icon}{title}
      </p>
      <ul className="space-y-1.5">{children}</ul>
    </div>);

}

function Item({ text }) {
  return (
    <li className="text-[#ffffff] pl-3 py-0.5 text-sm leading-relaxed border-l-2 border-primary/40">{text}</li>);

}

export default function CompareAIPanel({ sessions, userProfile }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [savedId, setSavedId] = useState(null);
  const sessionKey = sessions.map((s) => s.id).sort().join(",");
  const prevKeyRef = useRef(null);

  // Load persisted result for this exact set of sessions
  useEffect(() => {
    if (prevKeyRef.current === sessionKey) return;
    prevKeyRef.current = sessionKey;
    setResult(null);
    setSavedId(null);

    base44.entities.CompareAnalysisResult.filter({ session_key: sessionKey }, "-updated_date", 1).then((rows) => {
      if (rows[0]) {
        setResult(rows[0].result);
        setSavedId(rows[0].id);
      } else {
        // No cached result — auto-run analysis
        runAnalysis(null);
      }
    });
  }, [sessionKey]);

  const runAnalysis = async (existingId) => {
    setLoading(true);
    try {
      const fmtDurWords = (sec) => {
        if (sec == null) return null;
        const m = Math.floor(sec / 60);
        const s2 = Math.round(sec % 60);
        if (m === 0) return `${s2} second${s2 !== 1 ? "s" : ""}`;
        if (s2 === 0) return `${m} minute${m !== 1 ? "s" : ""}`;
        return `${m} minute${m !== 1 ? "s" : ""} and ${s2} second${s2 !== 1 ? "s" : ""}`;
      };
      const fmtHR = (bpm) => bpm != null ? `${bpm} beats per minute` : null;

      const summary = sessions.map((s) => {
        const h = s.start_time ? parseInt(s.start_time.split(":")[0], 10) : null;
        const timeOfDay = h !== null ?
        h >= 5 && h < 12 ? "morning" : h >= 12 && h < 17 ? "afternoon" : h >= 17 && h < 21 ? "evening" : "night" :
        undefined;
        const buildDur = s.pre_climax_offset_s != null && s.climax_offset_s != null
          ? Math.round(s.climax_offset_s - s.pre_climax_offset_s) : null;
        const recOnset = s.recovery_offset_s != null && s.climax_offset_s != null
          ? Math.round(s.recovery_offset_s - s.climax_offset_s) : null;
        return {
          date: s.date ? (() => {
            const d = new Date(s.date);
            return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
          })() : undefined,
          time_of_day: timeOfDay,
          duration: s.duration_minutes ? fmtDurWords(s.duration_minutes * 60) : undefined,
          intensity_out_of_ten: s.intensity,
          satisfaction_out_of_ten: s.satisfaction,
          build_quality_out_of_ten: s.build_quality,
          build_type: s.build_type,
          climax_duration: s.climax_duration,
          mood: s.mood,
          methods: s.methods,
          avg_heart_rate: fmtHR(s.avg_hr),
          max_heart_rate: fmtHR(s.max_hr),
          heart_rate_at_climax: fmtHR(s.hr_at_climax),
          heart_rate_avg_pre_to_climax: fmtHR(s.hr_avg_pre_to_climax),
          build_duration: buildDur != null ? fmtDurWords(buildDur) : undefined,
          recovery_onset_after_climax: recOnset != null ? fmtDurWords(recOnset) : undefined,
          ejaculate_volume: s.ejaculate_volume,
          unusual_sensations: s.unusual_sensations || undefined,
          discomfort_entries: s.discomfort_entries?.length ? s.discomfort_entries : undefined,
          notes: s.notes || undefined,
          events: (() => {
            const evs = (s.event_timeline || []).filter((e) => e.note?.trim());
            if (!evs.length) return undefined;
            return evs.map((e) => {
              const m = Math.floor(e.time_s / 60);
              const sec = e.time_s % 60;
              const cats = Array.isArray(e.category) ? e.category : [e.category].filter(Boolean);
              return `[${m}:${String(sec).padStart(2, "0")}${cats.length ? ` · ${cats.join(", ")}` : ""}] ${e.note}`;
            });
          })(),
        };
      });

      const arousalProfile = userProfile && (userProfile.arousal_response_style || userProfile.arousal_notes || userProfile.climax_sensitivity) ? `

USER AROUSAL PROFILE:
${JSON.stringify({
  arousal_response_style: userProfile.arousal_response_style,
  typical_build_duration: userProfile.typical_build_duration,
  climax_sensitivity: userProfile.climax_sensitivity,
  preferred_stimulation: userProfile.preferred_stimulation,
  refractory_pattern: userProfile.refractory_pattern,
  arousal_notes: userProfile.arousal_notes,
}, null, 2)}

Use this profile to contextualize the comparison — note which sessions aligned with or deviated from the user's known arousal patterns. Reference preferred methods and typical response style when interpreting differences.` : "";

      const res = await base44.integrations.Core.InvokeLLM({
        model: "claude_sonnet_4_6",
        prompt: `You are a physiological research assistant and anatomist specializing in sexual response. Compare the following ${sessions.length} sessions side-by-side, analyzing the full cascade arc: Build Phase → Pre-Climax → Climax → Recovery. Write directly to the person — use "you" and "your" throughout, as if speaking to them personally.

PHYSIOLOGICAL & ANATOMICAL LENS — apply throughout:
- Interpret HR trajectories as windows into sympathetic nervous system activation, parasympathetic withdrawal, and autonomic arousal state
- Reference relevant anatomy where appropriate: pelvic floor engagement, prostatic engorgement, pudendal nerve pathways, bulbocavernosus/ischiocavernosus activity
- Connect phase durations and HR inflections to their likely anatomical and neurological drivers
- Interpret build types physiologically — what does a "gradual" vs "stepwise" vs "spike" pattern suggest about autonomic ramp-up?

CRITICAL FOR TEXT-TO-SPEECH QUALITY — these rules are mandatory, no exceptions:
- All numeric values are already pre-formatted as words in the data (e.g. "seventy-two beats per minute", "three minutes and forty seconds") — use them verbatim, never substitute digits
- NEVER use parenthetical numbers like "(9)" or "(72 bpm)" — always write the value as a full phrase in the sentence
- NEVER write abbreviations: "bpm", "HR", "s", "min", "bpm/min" — always write the full words
- Write in short, spoken sentences — maximum two clauses per sentence
- No bullet points, no lists, no markdown, no em-dashes used to stack clauses
- Each paragraph in the JSON output must be a single focused idea, 2–3 sentences max
- Use commas and periods to create natural speech rhythm
- Never start a sentence with a digit — restructure the sentence instead
- Explain any anatomical terms briefly in plain language
${arousalProfile}

Sessions:
${JSON.stringify(summary, null, 2)}

EVENT NOTES INSTRUCTIONS:
- Each session includes a timestamped event log. These are first-person notes the user wrote during or after the session.
- When the AI finds an event particularly relevant — e.g., a sensation, stimulation change, or physical event that correlates with an HR shift, a phase transition, or a meaningful difference between sessions — incorporate its content directly into the analysis.
- Quote or paraphrase the note naturally within a sentence rather than listing it separately.
- Do not attempt to reference every event. Only surface events that add genuine insight to the comparison.
- When citing an event, mention its approximate time in the session (e.g., "around the eight-minute mark").

Provide a structured comparative analysis covering key differences, HR patterns, phase timing, event notes, and recommendations.`,
        response_json_schema: {
          type: "object",
          properties: {
            summary: { type: "string" },
            key_differences: { type: "array", items: { type: "string" } },
            hr_comparison: { type: "array", items: { type: "string" } },
            phase_comparison: { type: "array", items: { type: "string" } },
            standout_session: { type: "string" },
            recommendations: { type: "array", items: { type: "string" } }
          },
          required: ["summary", "key_differences", "hr_comparison", "phase_comparison", "recommendations"]
        }
      });

      const raw = typeof res === "string" ? JSON.parse(res) : res;
      const parsed = raw?.response ?? raw;
      setResult(parsed);

      if (existingId) {
        await base44.entities.CompareAnalysisResult.update(existingId, { result: parsed, session_key: sessionKey });
      } else {
        const created = await base44.entities.CompareAnalysisResult.create({ result: parsed, session_key: sessionKey });
        setSavedId(created.id);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-card rounded-xl border border-border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-primary flex items-center gap-1.5">
          <Brain className="w-4 h-4" /> AI Comparison Analysis
        </h3>
        <div className="flex items-center gap-2">
        <button
            onClick={() => runAnalysis(savedId)}
            disabled={loading}
            className="text-xs px-3 py-1.5 rounded-lg bg-primary text-primary-foreground font-semibold flex items-center gap-1.5 disabled:opacity-50">
            
          {loading ?
            <><span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />Analyzing…</> :
            <><Brain className="w-3 h-3" />Re-analyze</>}
        </button>
        </div>
      </div>

      {loading && !result &&
      <p className="text-xs text-muted-foreground animate-pulse">Running AI comparison analysis…</p>
      }

      {result && (() => {
        const paras = [
          result.summary,
          ...(result.key_differences || []),
          ...(result.hr_comparison || []),
          ...(result.phase_comparison || []),
          ...(result.standout_session ? [result.standout_session] : []),
          ...(result.recommendations || []),
        ].filter(Boolean);

        const sessionDatesLabel = sessions
          .map(s => {
            if (!s.date) return null;
            const d = new Date(s.date);
            return d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
          })
          .filter(Boolean)
          .join(" & ");
        const compareTitle = `Session Comparison – ${sessionDatesLabel}`;

        return (
          <TTSReader
            title={compareTitle}
            paragraphs={paras}
            renderParagraph={(text, idx, isActive, isBuffering) => (
              <p className={`text-sm leading-relaxed pl-3 border-l-2 py-1 transition-all duration-200 rounded-r-md flex items-center gap-2 ${
                idx === 0
                  ? isActive ? "border-primary bg-primary/10 text-foreground font-bold" : "border-primary text-foreground font-medium"
                  : isActive ? "border-primary bg-primary/10 text-foreground font-medium" : "border-primary/30 text-foreground/80"
              }`}>
                {isBuffering && <span className="shrink-0 w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />}
                {text}
              </p>
            )}
          />
        );
      })()}
    </div>);

}