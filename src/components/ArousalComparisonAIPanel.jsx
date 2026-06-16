import { useState, useEffect, useRef } from "react";
import { base44 } from "@/api/base44Client";
import { TrendingUp } from "lucide-react";
import AIOutputReader from "./AIOutputReader";
import moment from "moment";
import { buildAIGroundingContext } from "@/lib/aiGrounding";
import { buildGenericAIContentMeta, formatGeneratedAt, getAIContentGeneratedAt } from "@/utils/aiContentMetadata";
import { recoverCompletedAIJob, startRecoverableAIJob, waitForRecoverableAIJob } from "@/lib/recoverableAIJobs";

function fmtDurWords(sec) {
  if (sec == null) return null;
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  if (m === 0) return `${s} second${s !== 1 ? "s" : ""}`;
  if (s === 0) return `${m} minute${m !== 1 ? "s" : ""}`;
  return `${m} minute${m !== 1 ? "s" : ""} and ${s} second${s !== 1 ? "s" : ""}`;
}

function buildHRSummary(rows) {
  if (!rows || rows.length === 0) return null;
  const hrs = rows.map((r) => Number(r.hr_smoothed || r.hr));
  const min = Math.min(...hrs);
  const max = Math.max(...hrs);
  const avg = Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length);
  const range = max - min || 1;

  // Sample ~40 evenly-spaced points for trajectory description
  const step = Math.max(1, Math.floor(rows.length / 40));
  const sampled = rows.filter((_, i) => i % step === 0);

  // Rate of change segments
  const gradients = [];
  for (let i = 1; i < sampled.length; i++) {
    const dt = Number(sampled[i].time_offset_s) - Number(sampled[i - 1].time_offset_s);
    const dhr = Number(sampled[i].hr) - Number(sampled[i - 1].hr);
    if (dt > 0) gradients.push({ t: Math.round(Number(sampled[i].time_offset_s)), bpmPerMin: Math.round((dhr / dt) * 60) });
  }

  // Normalized trajectory as percentage of HR range
  const normalizedTrajectory = sampled.map((r) => ({
    t: Math.round(Number(r.time_offset_s)),
    pct: Math.round(((Number(r.hr) - min) / range) * 100),
  }));

  // Plateau detection (sustained within ±4 bpm for >30s)
  const plateaus = [];
  let pStart = null; let pHR = null;
  for (let i = 0; i < rows.length; i++) {
    const hr = Number(rows[i].hr);
    const t = Number(rows[i].time_offset_s);
    if (pStart == null) { pStart = t; pHR = hr; }
    else if (Math.abs(hr - pHR) > 4) {
      const dur = t - pStart;
      if (dur >= 30) plateaus.push({ start_s: Math.round(pStart), duration_s: Math.round(dur), avg_hr: Math.round(pHR) });
      pStart = t; pHR = hr;
    } else {
      pHR = pHR * 0.7 + hr * 0.3;
    }
  }

  return {
    min_hr: min, avg_hr: avg, max_hr: max,
    hr_range: max - min,
    normalized_trajectory: normalizedTrajectory
      .map((p) => `${fmtDurWords(p.t)}:${p.pct}%`).join(", "),
    rate_of_change_bpm_per_min: gradients
      .filter((_, i) => i % 3 === 0)
      .map((g) => `${fmtDurWords(g.t)}:${g.bpmPerMin > 0 ? "+" : ""}${g.bpmPerMin}`)
      .join(", "),
    plateaus: plateaus.map((p) =>
      `plateau for ${fmtDurWords(p.duration_s)} starting at ${fmtDurWords(p.start_s)} (~${p.avg_hr} bpm avg)`
    ),
  };
}

export default function ArousalComparisonAIPanel({ sessions, timelineMap = {}, userProfile }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);

  const sessionKey = "arousal_" + sessions.map((s) => s.id).sort().join(",");
  const jobKey = `arousal-comparison:${sessionKey}`;
  const prevKeyRef = useRef(null);
  const generatedAt = getAIContentGeneratedAt(result);

  const persistResult = async (rawResult) => {
    const raw = typeof rawResult === "string" ? JSON.parse(rawResult) : rawResult;
    const parsed = {
      ...(raw?.response ?? raw),
      _meta: buildGenericAIContentMeta(result?._meta, null, {
        source_session_count: sessions.length,
        source_session_ids: sessions.map((s) => s.id).filter(Boolean),
      }),
    };
    setResult(parsed);

    const existing = await base44.entities.CompareAnalysisResult.filter({ session_key: sessionKey }, "-updated_date", 1);
    if (existing[0]) {
      await base44.entities.CompareAnalysisResult.update(existing[0].id, { result: parsed, session_key: sessionKey });
    } else {
      await base44.entities.CompareAnalysisResult.create({ result: parsed, session_key: sessionKey });
    }
    return parsed;
  };

  useEffect(() => {
    if (prevKeyRef.current === sessionKey) return;
    prevKeyRef.current = sessionKey;
    setResult(null);
    base44.entities.CompareAnalysisResult.filter({ session_key: sessionKey }, "-updated_date", 1).then((rows) => {
      if (rows[0]) setResult(rows[0].result);
    });
  }, [sessionKey]);

  useEffect(() => {
    let cancelled = false;
    const recover = async () => {
      try {
        const job = await recoverCompletedAIJob(jobKey);
        if (!job || cancelled) return;
        setLoading(true);
        const completed = job.status === "complete"
          ? job
          : await waitForRecoverableAIJob(jobKey, job.id, { intervalMs: 1800 });
        if (!cancelled && completed.result) await persistResult(completed.result);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    recover();
    return () => {
      cancelled = true;
    };
  }, [jobKey]);

  const runAnalysis = async () => {
    setLoading(true);
    try {
      const sessionSummaries = sessions.map((s, i) => {
        const rows = timelineMap[s.id] || [];
        const hrSummary = buildHRSummary(rows);
        const buildDur = s.pre_climax_offset_s != null && s.climax_offset_s != null
          ? fmtDurWords(Math.abs(s.climax_offset_s - s.pre_climax_offset_s)) : null;
        const totalDur = s.duration_minutes ? fmtDurWords(s.duration_minutes * 60) : null;
        const events = (s.event_timeline || [])
          .filter((e) => e.note?.trim())
          .map((e) => {
            const m = Math.floor(e.time_s / 60);
            const sec = e.time_s % 60;
            return `[${m}:${String(sec).padStart(2, "0")}] ${e.note}`;
          });

        return {
          label: moment(s.date).format("MMMM D, YYYY"),
          duration: totalDur,
          intensity_out_of_ten: s.intensity,
          build_quality_out_of_ten: s.build_quality,
          satisfaction_out_of_ten: s.satisfaction,
          build_type: s.build_type === "Other" && s.custom_build_type ? s.custom_build_type : s.build_type,
          climax_duration: s.climax_duration,
          mood: s.mood,
          methods: s.methods,
          no_climax: s.no_climax || false,
          pre_climax_offset: s.pre_climax_offset_s != null ? fmtDurWords(s.pre_climax_offset_s) : null,
          climax_offset: s.climax_offset_s != null ? fmtDurWords(s.climax_offset_s) : null,
          recovery_offset: s.recovery_offset_s != null ? fmtDurWords(s.recovery_offset_s) : null,
          build_to_climax_duration: buildDur,
          hr: hrSummary,
          events: events.length ? events : null,
          notes: s.notes || null,
        };
      });

      const arousalProfile = userProfile && (userProfile.arousal_response_style || userProfile.arousal_notes)
        ? `\nUSER AROUSAL PROFILE:\n${JSON.stringify({
            arousal_response_style: userProfile.arousal_response_style,
            typical_build_duration: userProfile.typical_build_duration,
            climax_sensitivity: userProfile.climax_sensitivity,
            preferred_stimulation: userProfile.preferred_stimulation,
            arousal_notes: userProfile.arousal_notes,
          }, null, 2)}`
        : "";
      const groundingContext = buildAIGroundingContext(userProfile);

      const aiPayload = {
        model: "claude_sonnet_4_6",
        prompt: `You are an expert in physiological arousal analysis. Your task is to deeply compare the AROUSAL PATTERNS across these ${sessions.length} sessions — focusing specifically on how arousal built, peaked, and resolved, not just final metrics.

${groundingContext}

YOUR FOCUS AREAS:
1. Arousal shape and trajectory — how did arousal unfold over time? Was it a slow ramp, stepwise, erratic, plateau-driven?
2. Momentum and pacing — when did arousal accelerate? When did it stall or plateau? How long did each phase sustain?
3. Peak arousal dynamics — how high did arousal climb (relative to each session's range)? How quickly?
4. Build-to-peak mechanics — what drove the most productive arousal periods? What patterns correlate with higher satisfaction?
5. Recovery arc — how quickly did arousal resolve after climax? What does that suggest?
6. Cross-session patterns — what stays stable across sessions? What varies? What does the variation reveal?

The normalized HR trajectory data (0–100% of each session's HR range) is your primary arousal signal. Use it to tell the story of how arousal moved.

STYLE — CRITICAL (for text-to-speech):
- Write directly to the person using "you" and "your"
- Narrative prose — no bullet points, no markdown, no abbreviations
- Never use "bpm", "HR", "s", "min" — write full words
- Never write bare digits — all numbers should be written as words or integrated naturally into sentences
- Short, spoken sentences — two clauses max
- Each output array item should be 2–4 sentences, one focused idea
${arousalProfile}

SESSION DATA:
${JSON.stringify(sessionSummaries, null, 2)}`,
        response_json_schema: {
          type: "object",
          properties: {
            summary: { type: "string", description: "2-3 sentence overview of how arousal compared across the sessions" },
            trajectory_comparison: { type: "array", items: { type: "string" }, description: "3-5 observations comparing the shape and arc of arousal across sessions" },
            momentum_and_pacing: { type: "array", items: { type: "string" }, description: "3-4 insights about how arousal momentum built, stalled, or recovered in each session" },
            peak_dynamics: { type: "array", items: { type: "string" }, description: "2-3 observations about how arousal peaked — speed, height, and duration of peak states" },
            what_drove_arousal: { type: "array", items: { type: "string" }, description: "2-4 specific patterns or events that most strongly drove arousal in these sessions" },
            cross_session_patterns: { type: "array", items: { type: "string" }, description: "2-3 insights about what stays stable vs different across sessions and what that reveals" },
          },
          required: ["summary", "trajectory_comparison", "momentum_and_pacing", "peak_dynamics", "what_drove_arousal", "cross_session_patterns"],
        },
      };
      const job = await startRecoverableAIJob(jobKey, aiPayload, {
        title: "Arousal comparison analysis",
        label: "Arousal comparison analysis",
        source: "arousal_comparison",
        sessionKey,
      });
      const completed = await waitForRecoverableAIJob(jobKey, job.id, { intervalMs: 1800 });
      await persistResult(completed.result);
    } finally {
      setLoading(false);
    }
  };

  const SECTIONS = [
    { key: "trajectory_comparison", label: "Arousal Trajectory", color: "hsl(var(--chart-1))" },
    { key: "momentum_and_pacing",   label: "Momentum & Pacing",  color: "hsl(var(--chart-2))" },
    { key: "peak_dynamics",         label: "Peak Dynamics",      color: "hsl(var(--chart-3))" },
    { key: "what_drove_arousal",    label: "What Drove Arousal", color: "hsl(var(--chart-4))" },
    { key: "cross_session_patterns",label: "Cross-Session Patterns", color: "hsl(var(--accent))" },
  ];

  const paras = result ? [
    result.summary,
    ...(result.trajectory_comparison || []),
    ...(result.momentum_and_pacing || []),
    ...(result.peak_dynamics || []),
    ...(result.what_drove_arousal || []),
    ...(result.cross_session_patterns || []),
  ].filter(Boolean) : [];

  const paraMeta = result ? [
    { type: "summary" },
    ...(result.trajectory_comparison || []).map(() => ({ type: "section", key: "trajectory_comparison" })),
    ...(result.momentum_and_pacing || []).map(() => ({ type: "section", key: "momentum_and_pacing" })),
    ...(result.peak_dynamics || []).map(() => ({ type: "section", key: "peak_dynamics" })),
    ...(result.what_drove_arousal || []).map(() => ({ type: "section", key: "what_drove_arousal" })),
    ...(result.cross_session_patterns || []).map(() => ({ type: "section", key: "cross_session_patterns" })),
  ] : [];

  const sessionDatesLabel = sessions
    .map((s) => s.date ? moment(s.date).format("MMM D") : null)
    .filter(Boolean).join(" & ");

  return (
    <div className="bg-card rounded-xl border border-border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-primary flex items-center gap-1.5">
          <TrendingUp className="w-4 h-4" /> Arousal Comparison Analysis
        </h3>
        <button
          onClick={runAnalysis}
          disabled={loading}
          className="text-xs px-3 py-1.5 rounded-lg bg-primary text-primary-foreground font-semibold flex items-center gap-1.5 disabled:opacity-50"
        >
          {loading
            ? <><span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />Analyzing…</>
            : <><TrendingUp className="w-3 h-3" />{result ? "Re-analyze" : "Analyze"}</>}
        </button>
      </div>

      {!result && !loading && (
        <p className="text-xs text-muted-foreground">
          Compare arousal trajectory, momentum, pacing, and peak dynamics across the selected sessions. Uses Claude Sonnet.
        </p>
      )}

      {loading && !result && (
        <p className="text-xs text-muted-foreground animate-pulse">Analyzing arousal patterns…</p>
      )}

      {result && (
        <div className="space-y-3">
          <div className="text-[10px] text-muted-foreground">
            {generatedAt ? `Generated ${formatGeneratedAt(generatedAt)}` : "Generated time unavailable"}
          </div>
          <AIOutputReader
            sessionId={"arousal_compare_" + sessionKey}
            title={`Arousal Comparison – ${sessionDatesLabel}`}
            sessionDate={sessions[0]?.date}
            sourceGeneratedAt={generatedAt}
            paragraphs={paras}
            paragraphMeta={paraMeta.map((meta) => {
              if (meta.type === "summary") return meta;
              const sec = SECTIONS.find((item) => item.key === meta.key);
              return { type: "section", sec };
            })}
          />
        </div>
      )}
    </div>
  );
}
