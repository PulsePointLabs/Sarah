import { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { Trophy, Brain, Star, Activity, Heart, Zap } from "lucide-react";
import { Link } from "react-router-dom";
import TTSReader from "./TTSReader";
import moment from "moment";

function Item({ text }) {
  return (
    <li className="text-[#ffffff] pl-3 py-0.5 text-sm/3 leading-relaxed border-l-2 border-primary/40">
      {text}
    </li>);

}

export default function BestSessionPanel({ sessions }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [savedId, setSavedId] = useState(null);
  const [bestSession, setBestSession] = useState(null);

  useEffect(() => {
    // Try to load cached result
    base44.entities.SessionClusterAnalysis.list("-updated_date", 1).then((rows) => {
      const stored = rows.find((r) => r.best_session_result);
      if (stored) {
        setResult(stored.best_session_result);
        setSavedId(stored.id);
        if (stored.best_session_result.session_id) {
          setBestSession(sessions.find((s) => s.id === stored.best_session_result.session_id) || null);
        }
      }
    });
  }, [sessions.length]);

  const calcPauseS = (s) => {
    const events = s.event_timeline || [];
    const cats = (ev) => Array.isArray(ev.category) ? ev.category : [ev.category].filter(Boolean);
    const sorted = [...events].sort((a, b) => a.time_s - b.time_s);
    let total = 0,start = null;
    for (const ev of sorted) {
      const c = cats(ev);
      if (c.includes("stimulation_paused") && start == null) start = ev.time_s;
      if (c.includes("stimulation_resumed") && start != null) {total += ev.time_s - start;start = null;}
    }
    return total;
  };

  const runAnalysis = async () => {
    setLoading(true);
    try {
      const summaries = sessions.slice(0, 100).map((s) => {
        const h = s.start_time ? parseInt(s.start_time.split(":")[0], 10) : null;
        const timeOfDay = h !== null ?
        h >= 5 && h < 12 ? "morning" : h >= 12 && h < 17 ? "afternoon" : h >= 17 && h < 21 ? "evening" : "night" :
        undefined;
        return {
          id: s.id,
          date: s.date?.slice(0, 10),
          start_time_et: s.start_time || undefined,
          time_of_day: timeOfDay,
          duration_minutes: s.duration_minutes,
          intensity: s.intensity,
          satisfaction: s.satisfaction,
          build_quality: s.build_quality,
          build_type: s.build_type,
          climax_duration: s.climax_duration,
          mood: s.mood,
          methods: s.methods,
          avg_hr: s.avg_hr,
          max_hr: s.max_hr,
          hr_at_climax: s.hr_at_climax,
          hr_avg_pre_to_climax: s.hr_avg_pre_to_climax,
          ejaculate_volume: s.ejaculate_volume,
          discomfort: s.discomfort,
          discomfort_entries: s.discomfort_entries?.length ? s.discomfort_entries : undefined,
          unusual_sensations: s.unusual_sensations || undefined,
          notes: s.notes || undefined,
          event_count: (s.event_timeline || []).length,
          pause_time_s: calcPauseS(s) || undefined,
          has_phase_markers: s.climax_offset_s != null,
          pre_to_climax_s: s.pre_climax_offset_s != null && s.climax_offset_s != null ?
          Math.round(s.climax_offset_s - s.pre_climax_offset_s) : undefined,
          recovery_onset_s: s.climax_offset_s != null && s.recovery_offset_s != null ?
          Math.round(s.recovery_offset_s - s.climax_offset_s) : undefined,
          is_favorite: s.is_favorite || undefined,
          tags: s.tags?.length ? s.tags : undefined
        }; // closes the object literal
      }); // closes the .map()

      const res = await base44.integrations.Core.InvokeLLM({
        model: "claude_sonnet_4_6",
        prompt: `You are a physiological research assistant analyzing sexual response session data. Your task is to identify the single best session overall and explain in depth why it stands out.

Consider ALL factors holistically:
- Physiological quality: HR data, HR at climax, build quality, intensity
- Cascade quality: phase marker timing, build-to-climax duration, recovery speed
- Subjective quality: satisfaction, mood, climax duration
- Time of day (ET): morning/afternoon/evening/night sessions may show different physiological patterns — factor this in
- Session richness: event logs, notes, unusual sensations
- Efficiency: pause time (less is generally better for a focused session)
- Absence of negatives: discomfort, low ratings
- Methods used and their synergy
- Any standout notes or unusual observations

Return the session ID of the best session, and a thorough, specific explanation referencing actual data values.
IMPORTANT: In the runner_up field, refer to sessions by their date (e.g. "April 5, 2025"), NOT by their ID.

CRITICAL — TEXT-TO-SPEECH FORMATTING:
All output fields will be read aloud. You MUST follow these rules in every string:
- Spell out ALL numbers as words: "eight out of ten" not "8/10", "one hundred and twenty beats per minute" not "120 bpm", "forty-five seconds" not "45s"
- Never use abbreviations: write "beats per minute" not "bpm", "minutes" not "min", "seconds" not "s"
- Never use bullet symbols (•, -, *) — write in flowing prose sentences only
- Never start a sentence with a digit — restructure if needed
- Use natural spoken language with commas for cadence
- Each array item should be a full, self-contained prose sentence or two

Sessions data:
${JSON.stringify(summaries, null, 2)}`,
        response_json_schema: {
          type: "object",
          properties: {
            session_id: { type: "string" },
            headline: { type: "string" },
            summary: { type: "string" },
            physiological_reasons: { type: "array", items: { type: "string" } },
            subjective_reasons: { type: "array", items: { type: "string" } },
            cascade_reasons: { type: "array", items: { type: "string" } },
            notable_details: { type: "array", items: { type: "string" } },
            runner_up: { type: "string" }
          },
          required: ["session_id", "headline", "summary", "physiological_reasons", "subjective_reasons"]
        }
      });

      const raw = typeof res === "string" ? JSON.parse(res) : res;
      const parsed = raw?.response ?? raw;
      setResult(parsed);

      const found = sessions.find((s) => s.id === parsed.session_id) || null;
      setBestSession(found);

      // Persist into SessionClusterAnalysis
      if (savedId) {
        await base44.entities.SessionClusterAnalysis.update(savedId, { best_session_result: parsed });
      } else {
        const created = await base44.entities.SessionClusterAnalysis.create({
          best_session_result: parsed,
          session_count: sessions.length
        });
        setSavedId(created.id);
      }
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="bg-card rounded-xl border-2 border-primary/30 p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-primary flex items-center gap-1.5">
          <Trophy className="w-4 h-4" /> AI Best Session
        </h3>
        <div className="flex items-center gap-2">
          <button
            onClick={runAnalysis}
            disabled={loading}
            className="text-xs px-3 py-1.5 rounded-lg bg-primary text-primary-foreground font-semibold flex items-center gap-1.5 disabled:opacity-50">
            
            {loading ?
            <><span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />Analyzing…</> :
            <><Brain className="w-3 h-3" />{result ? "Re-analyze" : "Find Best Session"}</>}
          </button>
        </div>
      </div>

      {!result && !loading &&
      <p className="text-xs text-muted-foreground">
          AI analyzes all {sessions.length} sessions holistically — HR, cascade phases, satisfaction, events, notes, pauses, and more — to find your best session and explain why. Uses Claude Sonnet.
        </p>
      }

      {loading && !result &&
      <p className="text-xs text-muted-foreground animate-pulse">Analyzing all sessions to find the best one…</p>
      }

      {result &&
      <div className="space-y-3">
          {/* Winner banner */}
          {bestSession &&
        <Link to={`/sessions/${bestSession.id}`}>
              <div className="bg-primary/10 rounded-xl px-4 py-3 flex items-center gap-3 hover:bg-primary/15 transition-colors cursor-pointer">
                <div className="w-10 h-10 rounded-full bg-primary flex items-center justify-center shrink-0">
                  <Trophy className="w-5 h-5 text-primary-foreground" />
                </div>
                <div>
                  <p className="text-sm font-bold text-primary">{moment(bestSession.date).format("MMMM D, YYYY")}</p>
                  <p className="text-xs text-muted-foreground">
                    {bestSession.start_time ? bestSession.start_time + " · " : ""}
                    {bestSession.duration_minutes ? `${bestSession.duration_minutes}m · ` : ""}
                    {(bestSession.methods || []).join(", ")}
                  </p>
                </div>
                <div className="ml-auto flex gap-2">
                  {bestSession.intensity &&
              <div className="text-center">
                      <p className="text-base font-bold font-mono">{bestSession.intensity}</p>
                      <p className="text-[9px] text-muted-foreground">INT</p>
                    </div>
              }
                  {bestSession.satisfaction &&
              <div className="text-center">
                      <p className="text-base font-bold font-mono">{bestSession.satisfaction}</p>
                      <p className="text-[9px] text-muted-foreground">SAT</p>
                    </div>
              }
                  {bestSession.max_hr &&
              <div className="text-center">
                      <p className="text-base font-bold font-mono">{bestSession.max_hr}</p>
                      <p className="text-[9px] text-muted-foreground">HR</p>
                    </div>
              }
                </div>
              </div>
            </Link>
        }

          {result.headline &&
        <p className="text-base font-semibold text-foreground">{result.headline}</p>
        }
          {(() => {
            const paras = [
              result.summary,
              ...(result.physiological_reasons || []),
              ...(result.cascade_reasons || []),
              ...(result.subjective_reasons || []),
              ...(result.notable_details || []),
              ...(result.runner_up ? [result.runner_up] : []),
            ].filter(Boolean);
            return (
              <TTSReader
                paragraphs={paras}
                renderParagraph={(text, idx, isActive) => (
                  <p className={`text-sm leading-relaxed pl-3 border-l-2 py-1 transition-all duration-200 rounded-r-md ${
                    isActive ? "border-primary bg-primary/10 text-foreground font-medium" : "border-primary/30 text-[#ffffff]"
                  }`}>
                    {text}
                  </p>
                )}
              />
            );
          })()}
        </div>
      }
    </div>);

}