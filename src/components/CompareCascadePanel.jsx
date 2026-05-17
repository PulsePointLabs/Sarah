import { useState, useEffect, useRef } from "react";
import { base44 } from "@/api/base44Client";
import { TrendingUp, Activity, Zap, Flag, Brain, Lightbulb } from "lucide-react";
import TTSReader from "./TTSReader";
import moment from "moment";

const PHASE_COLORS = {
  build: "#6366f1",
  pre_climax: "#a855f7",
  climax: "#ef4444",
  recovery: "#3b82f6"
};

function Section({ color, icon, title, items }) {
  if (!items?.length) return null;
  return (
    <div className="rounded-lg p-3 space-y-1.5" style={{ background: color + "12", borderLeft: `3px solid ${color}` }}>
      <p className="text-xs font-semibold flex items-center gap-1.5" style={{ color }}>
        {icon}{title}
      </p>
      <ul className="space-y-1">
        {items.map((s, i) =>
        <li key={i} className="text-[#ffffff] pl-2 text-sm leading-relaxed">• {s}</li>
        )}
      </ul>
    </div>);

}

export default function CompareCascadePanel({ sessions, timelineMap, userProfile }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [savedId, setSavedId] = useState(null);
  const sessionKey = sessions.map((s) => s.id).sort().join(",") + ":cascade";
  const prevKeyRef = useRef(null);

  useEffect(() => {
    if (prevKeyRef.current === sessionKey) return;
    prevKeyRef.current = sessionKey;
    setResult(null);
    setSavedId(null);

    base44.entities.CompareAnalysisResult.filter({ session_key: sessionKey }, "-updated_date", 1).then((rows) => {
      if (rows[0]) {
        setResult(rows[0].result);
        setSavedId(rows[0].id);
      }
    });
  }, [sessionKey]);

  const runAnalysis = async (existingId) => {
    setLoading(true);
    try {
      const nearestHR = (rows, time_s) => {
        if (!rows?.length) return null;
        let best = rows[0];
        let bestDist = Math.abs(Number(rows[0].time_offset_s) - time_s);
        for (const r of rows) {
          const d = Math.abs(Number(r.time_offset_s) - time_s);
          if (d < bestDist) {bestDist = d;best = r;}
        }
        return Math.round(Number(best.hr));
      };

      const fmtDurWords = (sec) => {
        if (sec == null) return null;
        const m = Math.floor(sec / 60);
        const s2 = Math.round(sec % 60);
        if (m === 0) return `${s2} second${s2 !== 1 ? "s" : ""}`;
        if (s2 === 0) return `${m} minute${m !== 1 ? "s" : ""}`;
        return `${m} minute${m !== 1 ? "s" : ""} and ${s2} second${s2 !== 1 ? "s" : ""}`;
      };
      const fmtHR = (bpm) => bpm != null ? `${bpm} beats per minute` : null;

      const sessionSummaries = sessions.map((s) => {
        const rows = timelineMap[s.id] || [];
        const hrAtPre = s.pre_climax_offset_s != null ? nearestHR(rows, s.pre_climax_offset_s) : null;
        const hrAtClimax = s.hr_at_climax || (s.climax_offset_s != null ? nearestHR(rows, s.climax_offset_s) : null);
        const hrAtRecovery = s.recovery_offset_s != null ? nearestHR(rows, s.recovery_offset_s) : null;
        const buildDur = s.pre_climax_offset_s != null && s.climax_offset_s != null ?
          Math.round(s.climax_offset_s - s.pre_climax_offset_s) : null;
        const recoveryOnset = s.recovery_offset_s != null && s.climax_offset_s != null ?
          Math.round(s.recovery_offset_s - s.climax_offset_s) : null;

        return {
          label: moment(s.date).format("MMM D, YYYY"),
          build_type: s.build_type,
          build_quality_out_of_ten: s.build_quality,
          intensity_out_of_ten: s.intensity,
          satisfaction_out_of_ten: s.satisfaction,
          climax_duration: s.climax_duration,
          mood: s.mood,
          methods: s.methods,
          avg_heart_rate: fmtHR(s.avg_hr),
          max_heart_rate: fmtHR(s.max_hr),
          heart_rate_at_pre_climax: fmtHR(hrAtPre),
          heart_rate_at_climax: fmtHR(hrAtClimax),
          heart_rate_at_recovery: fmtHR(hrAtRecovery),
          heart_rate_avg_pre_to_climax: fmtHR(s.hr_avg_pre_to_climax),
          heart_rate_avg_at_climax_window: fmtHR(s.hr_avg_at_climax_window),
          build_duration: fmtDurWords(buildDur),
          recovery_onset: fmtDurWords(recoveryOnset),
          ejaculate_volume: s.ejaculate_volume,
          unusual_sensations: s.unusual_sensations || undefined,
          discomfort_entries: s.discomfort_entries?.length ? s.discomfort_entries : undefined,
          notes: s.notes || undefined,
          tags: s.tags?.length ? s.tags : undefined,
          event_count: (s.event_timeline || []).length,
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

Use this profile to interpret cascade phase differences — compare observed arc shapes against the user's typical response style, and flag sessions where the cascade deviated meaningfully from their norm.` : "";

      const res = await base44.integrations.Core.InvokeLLM({
        model: "claude_sonnet_4_6",
        prompt: `You are a physiological research assistant specializing in sexual response. Perform a comparative cascade analysis across ${sessions.length} sessions. Write directly to the person — use "you" and "your" throughout.${arousalProfile}

For each cascade phase — Build, Pre-Climax, Climax, Recovery — identify meaningful differences and patterns. Reference specific values when relevant. Focus on what changed between sessions and what those changes imply physiologically.

CRITICAL FOR TEXT-TO-SPEECH QUALITY — these rules are mandatory, no exceptions:
- All numeric values are already pre-formatted as words in the data (e.g. "seventy-two beats per minute", "three minutes and forty seconds") — use them verbatim, never substitute digits
- NEVER use parenthetical numbers like "(9)" or "(72 bpm)" — always write the value as a full phrase in the sentence
- NEVER write abbreviations: "bpm", "HR", "s", "min" — always write the full words
- Write in short, spoken sentences — maximum two clauses per sentence
- No bullet points, no lists, no markdown, no em-dashes used to stack clauses
- Each item in the JSON arrays must be a single focused idea, 2–3 sentences max
- Use commas and periods to create natural speech rhythm
- Never start a sentence with a digit — restructure the sentence instead

Sessions:
${JSON.stringify(sessionSummaries, null, 2)}

Provide structured findings per phase, cross-session notable findings, and a standout observation.`,
        response_json_schema: {
          type: "object",
          properties: {
            summary: { type: "string" },
            build_differences: { type: "array", items: { type: "string" } },
            pre_climax_differences: { type: "array", items: { type: "string" } },
            climax_differences: { type: "array", items: { type: "string" } },
            recovery_differences: { type: "array", items: { type: "string" } },
            notable_findings: { type: "array", items: { type: "string" } },
            standout: { type: "string" }
          },
          required: ["summary", "build_differences", "pre_climax_differences", "climax_differences", "recovery_differences", "notable_findings"]
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
          <TrendingUp className="w-4 h-4" /> Comparative Cascade Analysis
        </h3>
        <div className="flex items-center gap-2">
          <button
            onClick={() => runAnalysis(savedId)}
            disabled={loading}
            className="text-xs px-3 py-1.5 rounded-lg bg-primary text-primary-foreground font-semibold flex items-center gap-1.5 disabled:opacity-50">
            
            {loading ?
            <><span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />Analyzing…</> :
            <><Brain className="w-3 h-3" />{result ? "Re-analyze" : "Analyze"}</>}
          </button>
        </div>
      </div>

      {!result && !loading &&
      <p className="text-xs text-muted-foreground">
          Compare cascade phases across all selected sessions — build, pre-climax, climax, and recovery differences. Uses Claude Sonnet.
        </p>
      }

      {loading && !result &&
      <p className="text-xs text-muted-foreground animate-pulse">Running comparative cascade analysis…</p>
      }

      {result && (() => {
        const PHASES = [
          { key: "build_differences", color: PHASE_COLORS.build },
          { key: "pre_climax_differences", color: PHASE_COLORS.pre_climax },
          { key: "climax_differences", color: PHASE_COLORS.climax },
          { key: "recovery_differences", color: PHASE_COLORS.recovery },
          { key: "notable_findings", color: "#f59e0b" },
        ];
        const paras = [];
        if (result.summary) paras.push({ text: result.summary, color: null });
        for (const ph of PHASES) {
          for (const item of (result[ph.key] || [])) paras.push({ text: item, color: ph.color });
        }
        if (result.standout) paras.push({ text: result.standout, color: "accent" });

        return (
          <TTSReader
            paragraphs={paras.map(p => p.text)}
            renderParagraph={(text, idx, isActive, isBuffering) => {
              const meta = paras[idx];
              return (
                <p
                  className={`text-sm pl-3 border-l-2 py-1 leading-relaxed transition-all duration-200 rounded-r-md flex items-center gap-2 ${isActive ? "font-medium" : ""}`}
                  style={{
                    borderColor: isActive ? (meta.color || "hsl(var(--primary))") : (meta.color ? meta.color + "66" : "hsl(var(--primary) / 0.4)"),
                    background: isActive ? (meta.color ? meta.color + "18" : "hsl(var(--primary) / 0.08)") : "transparent",
                    color: isActive ? "#fff" : meta.color ? "#ffffff" : "hsl(var(--foreground))",
                  }}
                >
                  {isBuffering && <span className="shrink-0 w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />}
                  {text}
                </p>
              );
            }}
          />
        );
      })()}
    </div>);

}