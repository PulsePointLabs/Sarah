import { useState, useEffect, useMemo } from "react";
import { base44 } from "@/api/base44Client";
import {
  ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip,
  CartesianGrid, ReferenceLine } from
"recharts";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Brain, Activity, TrendingDown, Clock, Zap, AlertCircle } from "lucide-react";
import TTSReader from "../components/TTSReader";
import CascadeTrendPanel from "../components/CascadeTrendPanel";

// ─── helpers ──────────────────────────────────────────────────────────────────

function fmtRel(s) {
  const sign = s >= 0 ? "+" : "-";
  const abs = Math.abs(Math.round(s));
  const m = Math.floor(abs / 60);
  const sec = abs % 60;
  return `${sign}${m > 0 ? `${m}m` : ""}${sec}s`;
}

function fmtDur(s) {
  const v = Math.round(s);
  return v >= 60 ? `${Math.floor(v / 60)}m${v % 60}s` : `${v}s`;
}

const PHASE_COLORS = ["#3b82f6", "#ef4444", "#f59e0b", "#a855f7", "#10b981", "#f43f5e", "#0ea5e9", "#8b5cf6"];

const SECTION_COLORS = {
  "chart-1": "hsl(var(--chart-1))",
  "chart-2": "hsl(var(--chart-2))",
  "chart-4": "hsl(var(--chart-4))",
  "accent": "hsl(var(--accent))",
  "destructive": "hsl(var(--destructive))"
};

// ─── Heatmap cell ─────────────────────────────────────────────────────────────

function HeatmapCell({ value, min, max }) {
  if (value == null) return <td className="w-4 h-6 bg-muted/20" />;
  const pct = max > min ? (value - min) / (max - min) : 0;
  const r = Math.round(pct * 239 + (1 - pct) * 59);
  const g = Math.round((1 - pct) * 130 + pct * 68);
  const b = Math.round((1 - pct) * 246 + pct * 68);
  return (
    <td
      className="w-4 h-6 text-center text-[8px] font-mono cursor-default"
      style={{ background: `rgb(${r},${g},${b})`, color: pct > 0.5 ? "#fff" : "#111" }}
      title={`${Math.round(value)} bpm`}>
      
      {Math.round(value)}
    </td>);

}

// ─── Section / Item for AI output ─────────────────────────────────────────────

function Section({ icon, title, color, children }) {
  return (
    <div>
      <p className="flex items-center gap-1 font-semibold mb-1.5" style={{ color: SECTION_COLORS[color] }}>
        {icon}{title}
      </p>
      <ul className="space-y-1">{children}</ul>
    </div>);

}

function Item({ text }) {
  return (
    <li className="text-[#ffffff] pl-3 py-0.5 text-sm leading-relaxed border-l-2 border-primary/40">• {text}</li>);

}

// ─── AI Insight panel ─────────────────────────────────────────────────────────

function AIInsightPanel({ sessions }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [savedId, setSavedId] = useState(null);
  const [userProfile, setUserProfile] = useState(null);

  useEffect(() => {
    base44.entities.CascadeAnalysisResult.list("-updated_date", 1).then((rows) => {
      if (rows[0]) {
        setResult(rows[0].result);
        setSavedId(rows[0].id);
      }
    });
    base44.auth.me().then((u) => setUserProfile(u)).catch(() => {});
  }, []);

  const analyze = async () => {
    setLoading(true);
    setResult(null);

    // Build nearest-HR lookup per session for event annotation
    const nearestHR = (rows, time_s) => {
      if (!rows?.length) return null;
      let best = rows[0];
      let bestDist = Math.abs(Number(rows[0].time_offset_s) - time_s);
      for (const r of rows) {
        const d = Math.abs(Number(r.time_offset_s) - time_s);
        if (d < bestDist) {bestDist = d;best = r;}
        if (Number(r.time_offset_s) > time_s + 10) break;
      }
      return Math.round(Number(best.hr));
    };

    // Build temporal trend data to feed AI
    const chronological = [...sessions].sort((a, b) => new Date(a.date) - new Date(b.date));
    const temporalTrend = chronological.map((s) => {
      const rows = (s._hrRows || []).sort((a, b) => Number(a.time_offset_s) - Number(b.time_offset_s));
      const nearHR = (t) => {
        if (!rows.length || t == null) return null;
        let best = rows[0], bestD = Infinity;
        for (const r of rows) {
          const d = Math.abs(Number(r.time_offset_s) - t);
          if (d < bestD) { bestD = d; best = r; }
          if (Number(r.time_offset_s) > t + 10) break;
        }
        return Math.round(Number(best.hr));
      };
      const peakHr = s.hr_at_climax || nearHR(s.climax_offset_s);
      const buildDur = s.pre_climax_offset_s != null && s.climax_offset_s != null
        ? Math.round(s.climax_offset_s - s.pre_climax_offset_s) : null;
      const recoveryOnset = s.recovery_offset_s != null && s.climax_offset_s != null
        ? Math.round(s.recovery_offset_s - s.climax_offset_s) : null;
      return {
        date: s.date ? new Date(s.date).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : null,
        peak_hr_bpm: peakHr,
        build_duration_s: buildDur,
        recovery_onset_s: recoveryOnset,
        satisfaction: s.satisfaction,
        intensity: s.intensity,
        build_type: s.build_type,
        methods: s.methods,
      };
    });

    const summary = sessions.map((s) => {
      const rows = (s._hrRows || []).sort((a, b) => Number(a.time_offset_s) - Number(b.time_offset_s));

      // Sample HR at key phase points for cascade shape description
      const hrAt = (offset_s) => {
        if (offset_s == null || !rows.length) return null;
        return nearestHR(rows, offset_s);
      };

      // Annotate events with HR and category — TTS-friendly word format
      const formatTimeWords = (seconds) => {
        const m = Math.floor(seconds / 60);
        const sec = Math.round(seconds % 60);
        if (m === 0) return `${sec} second${sec !== 1 ? "s" : ""}`;
        if (sec === 0) return `${m} minute${m !== 1 ? "s" : ""}`;
        return `${m} minute${m !== 1 ? "s" : ""} and ${sec} second${sec !== 1 ? "s" : ""}`;
      };
      const annotatedEvents = (s.event_timeline || []).map((e) => {
        const timeWords = formatTimeWords(e.time_s);
        const hr = nearestHR(rows, e.time_s);
        const relToClimax = s.climax_offset_s != null ? Math.round(e.time_s - s.climax_offset_s) : null;
        const relStr = relToClimax != null ? ` (${formatTimeWords(Math.abs(relToClimax))} ${relToClimax >= 0 ? "after" : "before"} climax)` : "";
        const cats = Array.isArray(e.category) ? e.category : [e.category].filter(Boolean);
        const catStr = cats.length ? `[${cats.join("+")}]` : "";
        return `${catStr} at ${timeWords}${relStr} — ${e.note}${hr != null ? ` (heart rate: ${hr} beats per minute)` : ""}`.trim();
      });

      // Build cascade shape: HR at pre-climax, climax, and recovery markers
      const fmtDurWords = (sec) => {
        const m = Math.floor(sec / 60);
        const s2 = sec % 60;
        if (m === 0) return `${s2} second${s2 !== 1 ? "s" : ""}`;
        if (s2 === 0) return `${m} minute${m !== 1 ? "s" : ""}`;
        return `${m} minute${m !== 1 ? "s" : ""} and ${s2} second${s2 !== 1 ? "s" : ""}`;
      };
      const buildDurRaw = s.pre_climax_offset_s != null ? Math.round(s.climax_offset_s - s.pre_climax_offset_s) : null;
      const recOnsetRaw = s.recovery_offset_s != null ? Math.round(s.recovery_offset_s - s.climax_offset_s) : null;
      const hrRise = (s.hr_at_climax || hrAt(s.climax_offset_s)) != null && hrAt(s.pre_climax_offset_s) != null ?
        Math.round((s.hr_at_climax || hrAt(s.climax_offset_s)) - hrAt(s.pre_climax_offset_s)) : null;
      const cascadeShape = {
        hr_at_pre_climax_marker: hrAt(s.pre_climax_offset_s),
        hr_at_climax_marker: s.hr_at_climax || hrAt(s.climax_offset_s),
        hr_at_recovery_marker: hrAt(s.recovery_offset_s),
        build_duration: buildDurRaw != null ? fmtDurWords(buildDurRaw) : null,
        recovery_onset: recOnsetRaw != null ? fmtDurWords(recOnsetRaw) : null,
        hr_rise_pre_to_climax_bpm: hrRise,
      };

      const spokenDate = s.date ? (() => {
        const d = new Date(s.date);
        return d.toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
      })() : null;

      return {
        date: spokenDate,
        cascade_shape: cascadeShape,
        hr_avg_pre_to_climax: s.hr_avg_pre_to_climax,
        hr_avg_at_climax_window: s.hr_avg_at_climax_window,
        avg_hr: s.avg_hr,
        max_hr: s.max_hr,
        intensity: s.intensity,
        satisfaction: s.satisfaction,
        build_type: s.build_type,
        climax_duration: s.climax_duration,
        mood: s.mood,
        methods: s.methods,
        event_notes: annotatedEvents.length > 0 ? annotatedEvents : undefined,
        discomfort_entries: s.discomfort_entries?.length > 0 ? s.discomfort_entries : undefined,
        notes: s.notes || undefined
      };
    });

    // Compute physiological metrics per session
    const physiologicalMetrics = sessions.map((s) => {
      const rows = (s._hrRows || []).sort((a, b) => Number(a.time_offset_s) - Number(b.time_offset_s));
      if (!rows.length) return null;

      const hrVals = rows.map((r) => Number(r.hr)).filter((v) => !isNaN(v));
      const baselineHR = hrVals.slice(0, Math.min(10, Math.floor(hrVals.length * 0.1))).reduce((a, b) => a + b, 0) / Math.max(1, Math.min(10, Math.floor(hrVals.length * 0.1)));

      // Successive differences for HRV-adjacent roughness (RMSSD approximation)
      const diffs = hrVals.slice(1).map((v, i) => Math.pow(v - hrVals[i], 2));
      const rmssd = diffs.length ? Math.round(Math.sqrt(diffs.reduce((a, b) => a + b, 0) / diffs.length) * 10) / 10 : null;

      // Sympathetic drive index: mean elevation above baseline during build phase
      let sympatheticIndex = null;
      if (s.pre_climax_offset_s != null && s.climax_offset_s != null) {
        const buildRows = rows.filter((r) => Number(r.time_offset_s) >= s.pre_climax_offset_s && Number(r.time_offset_s) <= s.climax_offset_s);
        if (buildRows.length) {
          const buildHRs = buildRows.map((r) => Number(r.hr));
          sympatheticIndex = Math.round(buildHRs.reduce((a, b) => a + b, 0) / buildHRs.length - baselineHR);
        }
      }

      // Recovery slope: BPM/second descent rate after climax marker
      let recoverySlope = null;
      if (s.climax_offset_s != null) {
        const postClimax = rows.filter((r) => Number(r.time_offset_s) >= s.climax_offset_s && Number(r.time_offset_s) <= s.climax_offset_s + 60);
        if (postClimax.length >= 2) {
          const first = postClimax[0], last = postClimax[postClimax.length - 1];
          const dt = Number(last.time_offset_s) - Number(first.time_offset_s);
          if (dt > 0) recoverySlope = Math.round(((Number(last.hr) - Number(first.hr)) / dt) * 100) / 100; // bpm/s (negative = descent)
        }
      }

      // HR plateau duration near climax: seconds within 5 bpm of peak
      const peakHR = s.hr_at_climax || nearestHR(rows, s.climax_offset_s);
      let plateauDuration = null;
      if (peakHR && s.climax_offset_s != null) {
        const near = rows.filter((r) => Math.abs(Number(r.hr) - peakHR) <= 5 && Math.abs(Number(r.time_offset_s) - s.climax_offset_s) <= 90);
        if (near.length >= 2) {
          plateauDuration = Math.round(Number(near[near.length - 1].time_offset_s) - Number(near[0].time_offset_s));
        }
      }

      // Build rate: BPM/second during pre→climax
      let buildRateBpmPerSec = null;
      if (s.pre_climax_offset_s != null && s.climax_offset_s != null) {
        const hrPre = nearestHR(rows, s.pre_climax_offset_s);
        const hrClimaxVal = peakHR;
        const dt = s.climax_offset_s - s.pre_climax_offset_s;
        if (hrPre && hrClimaxVal && dt > 0) buildRateBpmPerSec = Math.round(((hrClimaxVal - hrPre) / dt) * 100) / 100;
      }

      const spokenDate = s.date ? new Date(s.date).toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" }) : null;
      return {
        date: spokenDate,
        estimated_baseline_hr_bpm: Math.round(baselineHR),
        peak_hr_bpm: peakHR,
        hr_rise_above_baseline_bpm: peakHR ? Math.round(peakHR - baselineHR) : null,
        sympathetic_activation_index_bpm: sympatheticIndex,
        build_rate_bpm_per_second: buildRateBpmPerSec,
        plateau_duration_near_peak_s: plateauDuration,
        recovery_slope_bpm_per_second: recoverySlope,
        hr_variability_roughness_rmssd: rmssd,
        session_duration_minutes: s.duration_minutes,
      };
    }).filter(Boolean);

    const withRecovery = summary.filter((s) => s.cascade_shape?.recovery_onset_s != null);
    const avgRecoveryOnset = withRecovery.length ?
    Math.round(withRecovery.reduce((a, s) => a + s.cascade_shape.recovery_onset_s, 0) / withRecovery.length) :
    null;

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

Use this profile throughout the analysis — compare observed cascade patterns against the user's known arousal response style. Note sessions that align with or deviate from their typical build arc, sensitivity, and refractory pattern.` : "";

    const res = await base44.integrations.Core.InvokeLLM({
      model: "claude_sonnet_4_6",
      prompt: `You are a physiological research assistant analyzing sexual response cascade data across ${sessions.length} sessions. Write directly to the person — use "you" and "your" throughout, as if speaking to them personally.

CHRONOLOGICAL TREND DATA (sessions in date order — use this for temporal analysis):
${JSON.stringify(temporalTrend, null, 2)}

COMPUTED PHYSIOLOGICAL METRICS (per session):
- estimated_baseline_hr_bpm: resting-like HR at session start (proxy for pre-arousal state)
- hr_rise_above_baseline_bpm: total heart rate elevation from baseline to climax peak
- sympathetic_activation_index_bpm: mean HR elevation above baseline during the build phase (proxy for sustained sympathetic drive)
- build_rate_bpm_per_second: speed of heart rate rise during pre-climax buildup (higher = faster ramp-up)
- plateau_duration_near_peak_s: seconds heart rate stayed within 5 bpm of the climax peak (longer = more sustained peak)
- recovery_slope_bpm_per_second: rate of HR descent in first 60 seconds post-climax (negative = falling; closer to 0 = slower recovery)
- hr_variability_roughness_rmssd: beat-to-beat roughness of HR signal (proxy for autonomic variability; higher = more parasympathetic activity mixed in)
${JSON.stringify(physiologicalMetrics, null, 2)}

CRITICAL FOR TEXT-TO-SPEECH QUALITY:
- Write all times as words: "ten minutes and thirty seconds" not "10:30"
- Spell out all numbers as words (e.g., "seventy-two beats per minute" not "72 bpm", "eight out of ten" not "8/10")
- Write "beats per minute" not "bpm", "heart rate" not "HR", "seconds" not "s", "minutes" not "min"
- Write in conversational, sentence-based prose with natural pauses — no bullet points, no lists, no markdown
- Use short sentences and simple grammar optimized for audio readability
- Explain anatomical terms briefly and accessibly — don't assume medical background
- Use commas and periods to create natural speech cadence
- Never start a sentence with a digit — restructure if needed
${arousalProfile}

Each session includes the full cascade arc: pre-climax buildup, climax peak, and recovery onset.
Where available, event notes are annotated with heart rate values and their timing relative to the climax marker.

Session data:
${JSON.stringify(summary, null, 2)}

Provide a comprehensive, multi-layered analysis covering:

1. CASCADE OVERVIEW: Paint a vivid picture of your physiological arc. How does the pre-climax buildup typically unfold — is it gradual or steep? What is the peak climax like — sharp and explosive, or sustained and rolling? How does recovery typically proceed? What remains consistent across sessions, and where do you see meaningful variation? ${avgRecoveryOnset ? `Average recovery onset is approximately ${avgRecoveryOnset >= 60 ? `${Math.floor(avgRecoveryOnset/60)} minute${Math.floor(avgRecoveryOnset/60) !== 1 ? "s" : ""}${avgRecoveryOnset % 60 > 0 ? ` and ${avgRecoveryOnset % 60} seconds` : ""}` : `${avgRecoveryOnset} seconds`} post-climax.` : ""}

2. HEART RATE SIGNATURE: Deep analysis of your heart rate curves. Describe the characteristic rate of rise during buildup. What happens at the climax peak — is there a pronounced spike, a plateau, or something more subtle? What is the descent pattern? Are there inflection points or repeated micro-peaks that signal something physiologically meaningful?

3. EVENT NOTE PATTERNS: Synthesize all your logged events — what physiological states do they cluster around? Do stimulation changes, sensations, and other events appear more often at specific phases? Do certain event combinations predict a different cascade shape or heart rate trajectory?

4. BUILD PHASE ANALYSIS: Detailed examination of pre-climax buildup. How long does build typically take? What is the characteristic heart rate acceleration? Are there pauses or plateaus during buildup, or is the trajectory smooth? Does buildup quality or intensity affect the rate of rise?

5. CLIMAX DYNAMICS: Intensive analysis of the climax event itself. How pronounced is the peak? What is the typical heart rate at climax relative to average? How does climax duration vary, and what seems to predict longer or shorter climax events? What is the relationship between intensity, satisfaction, and climax signature?

6. RECOVERY TRAJECTORY: Post-climax physiology. How quickly does heart rate descend after climax? Is recovery smooth or jagged? Do you see rebound patterns? How does recovery onset timing vary, and what contextual factors seem to affect recovery speed?

7. COMMON SIGNATURES: Recurring physiological fingerprints across your full cascade arc — patterns that appear again and again, even when other variables change.

8. CONTEXTUAL CORRELATIONS: How do intensity, mood, hydration, methods, and environment link to cascade shape? Does a "high intensity" session produce a different cascade than a "low intensity" one? Are there mood states that consistently produce different physiological arcs?

9. PREDICTIVE INSIGHTS: Which factors best predict cascade quality, peak heart rate, recovery speed, or satisfaction? Can you predict how a session will unfold based on early buildup dynamics?

10. ANOMALIES: Sessions that deviate from your typical pattern — unusual cascade shapes, unexpected heart rate behavior, or atypical event correlations. What made them different?

11. PHENOTYPE CLUSTERS: Distinct cascade response profiles within your data. Do you have multiple "types" of sessions with meaningfully different arcs?

12. TEMPORAL EVOLUTION: How has your cascade changed over time? Is your peak heart rate trending up or down across sessions? Is your build duration getting longer or shorter? Is recovery speed changing? Are satisfaction scores correlating with any physiological trends over time? Be specific about what has improved, declined, or remained stable — and offer a hypothesis for why.

13. PHYSIOLOGICAL FINDINGS: Using the computed physiological metrics, interpret what is happening in the body. Discuss: the estimated sympathetic activation (how hard the autonomic nervous system is working during buildup), the cardiovascular stress load implied by the HR rise above baseline, what the build rate and plateau duration reveal about arousal physiology, and what the recovery slope says about parasympathetic rebound. Are there signs of efficient autonomic regulation or evidence of fatigue? Does HR variability roughness suggest moments of parasympathetic competition during arousal? Be accessible — explain what these metrics mean in plain terms, not clinical jargon.

14. CASCADE HEALTH SCORE: Based on all the data, give a holistic assessment of cascade health and quality. Consider: consistency of response, appropriateness of heart rate peaks, recovery efficiency, the relationship between physiological output and subjective satisfaction, and any signs of improvement or areas for attention. Conclude with 2–3 concrete, actionable observations the person could explore in future sessions.

Be specific and reference actual values — but always written as spoken words, never digits or abbreviations.`,
      response_json_schema: {
        type: "object",
        properties: {
          summary: { type: "string", description: "2-3 sentence overview" },
          cascade_overview: { type: "array", items: { type: "string" }, description: "4-5 detailed paragraphs describing the physiological arc" },
          heart_rate_signature: { type: "array", items: { type: "string" }, description: "3-4 paragraphs analyzing HR curves, peaks, and patterns" },
          event_note_patterns: { type: "array", items: { type: "string" }, description: "3-4 paragraphs on event clustering and correlations" },
          build_phase_analysis: { type: "array", items: { type: "string" }, description: "3-4 paragraphs on pre-climax buildup dynamics" },
          climax_dynamics: { type: "array", items: { type: "string" }, description: "3-4 paragraphs on climax intensity, duration, and variation" },
          recovery_trajectory: { type: "array", items: { type: "string" }, description: "3-4 paragraphs on post-climax recovery patterns" },
          common_signatures: { type: "array", items: { type: "string" }, description: "2-3 paragraphs on recurring physiological signatures" },
          contextual_correlations: { type: "array", items: { type: "string" }, description: "3-4 paragraphs linking intensity, mood, methods to cascade shape" },
          predictive_insights: { type: "array", items: { type: "string" }, description: "3-4 paragraphs on what predicts quality" },
          anomalies: { type: "array", items: { type: "string" }, description: "2-3 paragraphs on unusual sessions" },
          phenotype_clusters: { type: "array", items: { type: "string" }, description: "3-4 paragraphs on distinct response profiles" },
          temporal_evolution: { type: "array", items: { type: "string" }, description: "3-4 paragraphs on how cascade metrics have changed over time across sessions" },
          physiological_findings: { type: "array", items: { type: "string" }, description: "3-4 paragraphs interpreting autonomic, sympathetic, and cardiovascular physiological patterns from computed metrics" },
          cascade_health_score: { type: "array", items: { type: "string" }, description: "3-4 paragraphs on overall cascade health, quality assessment, and actionable observations" }
        },
        required: ["summary", "cascade_overview", "heart_rate_signature", "event_note_patterns", "build_phase_analysis", "climax_dynamics", "recovery_trajectory", "common_signatures", "contextual_correlations", "predictive_insights", "phenotype_clusters", "temporal_evolution", "physiological_findings", "cascade_health_score"]
      }
    });

    console.log("AI Cascade result:", res);
    const raw = typeof res === "string" ? JSON.parse(res) : res;
    const parsed = raw?.response ?? raw;
    setResult(parsed);
    if (savedId) {
      await base44.entities.CascadeAnalysisResult.update(savedId, { result: parsed, session_count: sessions.length });
    } else {
      const created = await base44.entities.CascadeAnalysisResult.create({ result: parsed, session_count: sessions.length });
      setSavedId(created.id);
    }
    setLoading(false);
  };

  return (
    <div className="bg-card rounded-xl border border-border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-primary flex items-center gap-1.5">
          <Brain className="w-4 h-4" /> AI Cascade Analysis
        </h3>
        <div className="flex items-center gap-2">
        <Button size="sm" onClick={analyze} disabled={loading || sessions.length < 2} className="h-7 text-xs gap-1.5">
          {loading ?
            <><span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />Analyzing…</> :
            <><Brain className="w-3 h-3" />Analyze</>}
        </Button>
        </div>
      </div>

      {sessions.length < 2 &&
      <p className="text-xs text-muted-foreground flex items-center gap-1.5">
          <AlertCircle className="w-3.5 h-3.5" />Need at least 2 sessions with climax markers to run AI analysis.
        </p>
      }

      {!result && !loading && sessions.length >= 2 &&
      <p className="text-xs text-muted-foreground">
          Click Analyze to generate AI-powered physiological insights across all aligned sessions. Uses Claude Sonnet (advanced model).
        </p>
      }

      {result && (() => {
         const SECTION_ORDER = [
          { key: "summary", label: null },
          { key: "cascade_overview", label: "Cascade Overview" },
          { key: "heart_rate_signature", label: "Heart Rate Signature" },
          { key: "event_note_patterns", label: "Event Note Patterns" },
          { key: "build_phase_analysis", label: "Build Phase Analysis" },
          { key: "climax_dynamics", label: "Climax Dynamics" },
          { key: "recovery_trajectory", label: "Recovery Trajectory" },
          { key: "common_signatures", label: "Common Signatures" },
          { key: "contextual_correlations", label: "Contextual Correlations" },
          { key: "predictive_insights", label: "Predictive Insights" },
          { key: "anomalies", label: "Anomalies & Outliers" },
          { key: "phenotype_clusters", label: "Response Profiles" },
          { key: "temporal_evolution", label: "How You've Changed Over Time" },
          { key: "physiological_findings", label: "Physiological Findings" },
          { key: "cascade_health_score", label: "Cascade Health Assessment" },
        ];

        const paras = [];
        const paraMeta = [];

        if (result.summary) {
          paras.push(result.summary);
          paraMeta.push({ type: "summary" });
        }

        for (const { key, label } of SECTION_ORDER) {
          if (key === "summary") continue;
          const items = result[key] || [];
          if (items.length) {
            for (let i = 0; i < items.length; i++) {
              paras.push(items[i]);
              paraMeta.push({ type: "section", sectionKey: key, label, isFirst: i === 0 });
            }
          }
        }

        if (!paras.length) return <p className="text-xs text-muted-foreground italic">Analysis returned no content. Please try again.</p>;

        const sectionFirstIdx = {};
        paraMeta.forEach((m, i) => {
          if (m.type === "section" && m.isFirst && sectionFirstIdx[m.sectionKey] == null) {
            sectionFirstIdx[m.sectionKey] = i;
          }
        });

        const SECTION_COLORS = {
          cascade_overview: "hsl(var(--chart-1))",
          heart_rate_signature: "hsl(var(--destructive))",
          event_note_patterns: "hsl(var(--accent))",
          build_phase_analysis: "hsl(var(--chart-3))",
          climax_dynamics: "hsl(var(--chart-2))",
          recovery_trajectory: "hsl(var(--chart-4))",
          common_signatures: "hsl(var(--chart-1))",
          contextual_correlations: "hsl(var(--accent))",
          predictive_insights: "hsl(var(--primary))",
          anomalies: "hsl(var(--destructive))",
          phenotype_clusters: "hsl(var(--chart-2))",
          temporal_evolution: "hsl(var(--chart-4))",
          physiological_findings: "hsl(var(--chart-5))",
          cascade_health_score: "hsl(var(--primary))",
        };

         return (
          <TTSReader
            paragraphs={paras}
            renderParagraph={(text, idx, isActive, isBuffering) => {
              const meta = paraMeta[idx];
              if (!meta) return null;

              if (meta.type === "summary") {
                return (
                  <p className={`text-base font-medium leading-relaxed border-l-2 pl-3 py-1 transition-all duration-200 rounded-r-md flex items-center gap-2 ${
                    isActive ? "border-primary bg-primary/10 text-foreground" : isBuffering ? "border-primary/60 bg-primary/5 text-foreground" : "border-primary/50 text-foreground"
                  }`}>
                    {isBuffering && <span className="shrink-0 w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />}
                    {text}
                  </p>
                );
              }

              const sectionColor = SECTION_COLORS[meta.sectionKey] || "hsl(var(--primary))";
              const isFirst = sectionFirstIdx[meta.sectionKey] === idx;

              return (
                <div>
                  {isFirst && meta.label && (
                    <p className="text-xs font-semibold uppercase tracking-wider mt-4 mb-2 pt-2 border-t border-border" style={{ color: sectionColor }}>
                      {meta.label}
                    </p>
                  )}
                  <p className={`text-sm leading-relaxed pl-3 border-l-2 py-1.5 transition-all duration-200 rounded-r-md flex items-start gap-2 ${
                    isActive ? "font-medium" : "text-foreground/80"
                  }`}
                  style={{
                    borderColor: isActive ? sectionColor : isBuffering ? sectionColor + "99" : sectionColor + "44",
                    background: isActive ? sectionColor + "18" : isBuffering ? sectionColor + "0a" : "transparent",
                  }}>
                    {isBuffering && <span className="shrink-0 w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin mt-1" />}
                    {text}
                  </p>
                </div>
              );
            }}
          />
        );
      })()}
    </div>);

}

// ─── Main Page ─────────────────────────────────────────────────────────────────

export default function CascadeAnalysis() {
  const [sessions, setSessions] = useState([]);
  const [hrData, setHrData] = useState({});
  const [loading, setLoading] = useState(true);
  const [windowSec, setWindowSec] = useState(120);

  useEffect(() => {
    (async () => {
      const all = await base44.entities.Session.list("-date", 200);
      const withClimax = all.filter((s) => s.climax_offset_s != null);
      setSessions(withClimax);

      const hrMap = {};
      const BATCH = 5;
      for (let i = 0; i < withClimax.length; i += BATCH) {
        const batch = withClimax.slice(i, i + BATCH);
        await Promise.all(
          batch.map(async (s) => {
            const rows = await base44.entities.HeartRateTimeline.filter({ session: s.id }, "time_offset_s", 10000);
            if (rows.length > 0) hrMap[s.id] = rows;
          })
        );
      }
      setHrData(hrMap);
      setLoading(false);
    })();
  }, []);

  const eligibleSessions = useMemo(
    () => sessions.filter((s) => hrData[s.id]?.length > 0),
    [sessions, hrData]
  );

  const BUCKET = 5;

  const makeBuckets = (win) => {
    const b = [];
    for (let t = -win; t <= win; t += BUCKET) b.push(t);
    return b;
  };

  const alignedData = useMemo(() => {
    const buckets = makeBuckets(windowSec);
    return eligibleSessions.map((s) => {
      const rows = hrData[s.id];
      const climaxT = s.climax_offset_s;
      const hrByRel = {};
      rows.forEach((r) => {
        const rel = Math.round((Number(r.time_offset_s) - climaxT) / BUCKET) * BUCKET;
        if (rel >= -windowSec && rel <= windowSec) {
          if (!hrByRel[rel]) hrByRel[rel] = [];
          hrByRel[rel].push(Number(r.hr));
        }
      });
      const series = {};
      buckets.forEach((t) => {
        series[t] = hrByRel[t] ? hrByRel[t].reduce((a, b) => a + b, 0) / hrByRel[t].length : null;
      });
      const preRel = s.pre_climax_offset_s != null ? Math.round(s.pre_climax_offset_s - climaxT) : null;
      const recRel = s.recovery_offset_s != null ? Math.round(s.recovery_offset_s - climaxT) : null;
      return { session: s, series, preRel, recRel };
    });
  }, [eligibleSessions, hrData, windowSec]);

  const chartData = useMemo(() => {
    if (!alignedData.length) return [];
    const buckets = makeBuckets(windowSec);
    return buckets.map((t) => {
      const point = { rel: t };
      const vals = [];
      alignedData.forEach(({ session, series }) => {
        const v = series[t];
        point[session.id] = v != null ? Math.round(v) : null;
        if (v != null) vals.push(v);
      });
      point._avg = vals.length > 0 ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
      return point;
    });
  }, [alignedData, windowSec]);

  const buckets = makeBuckets(windowSec);
  const allHRVals = alignedData.flatMap(({ series }) => Object.values(series).filter(Boolean));
  const hrMin = allHRVals.length ? Math.min(...allHRVals) : 50;
  const hrMax = allHRVals.length ? Math.max(...allHRVals) : 180;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
      </div>);

  }

  if (sessions.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center h-64 gap-2 text-center px-6">
        <Activity className="w-10 h-10 text-muted-foreground" />
        <p className="text-muted-foreground text-sm">No sessions with climax markers found. Set climax markers in a session to enable cascade analysis.</p>
      </div>);

  }

  return (
    <div className="px-4 py-6 pb-24 space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Cascade Analysis</h1>
        <p className="text-sm text-muted-foreground mt-0.5">{eligibleSessions.length} sessions aligned by climax event</p>
      </div>

      {/* Window selector */}
      <div className="flex gap-1 flex-wrap">
        {[60, 120, 180, 300].map((w) =>
        <Button key={w} size="sm" variant={windowSec === w ? "default" : "outline"} className="h-7 text-xs" onClick={() => setWindowSec(w)}>
            ±{w / 60}m
          </Button>
        )}
      </div>

      {eligibleSessions.length === 0 &&
      <div className="bg-muted/40 rounded-xl p-4 text-sm text-muted-foreground text-center">
          Sessions have climax markers but no imported HR data. Upload HR CSVs to enable cascade visualizations.
        </div>
      }

      {/* Overlaid HR curves */}
      {eligibleSessions.length > 0 &&
      <div className="bg-card rounded-xl border border-border p-4 space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-primary">Aligned HR Cascade (time relative to climax)</h3>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                <XAxis dataKey="rel" tick={{ fontSize: 9 }} tickFormatter={fmtRel} />
                <YAxis tick={{ fontSize: 9 }} domain={["auto", "auto"]} />
                <Tooltip
                labelFormatter={(v) => `Climax ${fmtRel(Number(v))}`}
                formatter={(val, name) => [
                val ? `${val} bpm` : "—",
                name === "_avg" ? "Avg" : eligibleSessions.find((s) => s.id === name)?.date?.slice(0, 10) || name]
                }
                contentStyle={{ fontSize: 10 }} />
              
                <ReferenceLine x={0} stroke="#ef4444" strokeWidth={2} label={{ value: "Climax", fontSize: 8, fill: "#ef4444", position: "top" }} />
                {eligibleSessions.map((s, i) =>
              <Line key={s.id} type="monotone" dataKey={s.id} stroke={PHASE_COLORS[i % PHASE_COLORS.length]} strokeWidth={1} dot={false} strokeOpacity={0.4} connectNulls isAnimationActive={false} />
              )}
                <Line type="monotone" dataKey="_avg" stroke="#ffffff" strokeWidth={2.5} dot={false} connectNulls isAnimationActive={false} name="Avg" />
              </LineChart>
            </ResponsiveContainer>
          </div>
          <p className="text-[10px] text-muted-foreground">White line = population average. Colored lines = individual sessions.</p>
        </div>
      }

      {/* Heatmap */}
      {alignedData.length > 0 &&
      <div className="bg-card rounded-xl border border-border p-4 space-y-3">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-primary">HR Heatmap (sessions × time)</h3>
          <div className="overflow-x-auto">
            <table className="border-separate border-spacing-0.5">
              <thead>
                <tr>
                  <th className="text-[8px] text-muted-foreground text-left pr-2 font-normal w-12">Session</th>
                  {buckets.filter((_, i) => i % 4 === 0).map((t) =>
                <th key={t} className="text-[7px] text-muted-foreground font-normal" colSpan={4}>{fmtRel(t)}</th>
                )}
                </tr>
              </thead>
              <tbody>
                {alignedData.map(({ session, series }) =>
              <tr key={session.id}>
                    <td className="text-[8px] text-muted-foreground pr-2 whitespace-nowrap">{session.date?.slice(5, 10)}</td>
                    {buckets.map((t) =>
                <HeatmapCell key={t} value={series[t]} min={hrMin} max={hrMax} />
                )}
                  </tr>
              )}
              </tbody>
            </table>
          </div>
          <div className="flex items-center gap-2 mt-1">
            <span className="text-[9px] text-muted-foreground">{Math.round(hrMin)} bpm</span>
            <div className="flex-1 h-2 rounded" style={{ background: "linear-gradient(to right, rgb(59,130,246), rgb(239,68,68))" }} />
            <span className="text-[9px] text-muted-foreground">{Math.round(hrMax)} bpm</span>
          </div>
        </div>
      }

      {/* Phase timing summary */}
      {eligibleSessions.length > 0 &&
      <PhaseSummary sessions={eligibleSessions} />
      }

      {/* Cascade Evolution Over Time */}
      {eligibleSessions.length >= 3 && (
        <CascadeTrendPanel sessions={eligibleSessions} hrData={hrData} />
      )}

      {/* AI Panel */}
      <AIInsightPanel sessions={(eligibleSessions.length > 0 ? eligibleSessions : sessions).map((s) => ({ ...s, _hrRows: hrData[s.id] || [] }))} />
    </div>);

}

function PhaseSummary({ sessions }) {
  const preDurations = sessions.filter((s) => s.pre_climax_offset_s != null).map((s) => s.climax_offset_s - s.pre_climax_offset_s).filter((d) => d > 0);
  const recDurations = sessions.filter((s) => s.recovery_offset_s != null).map((s) => s.recovery_offset_s - s.climax_offset_s).filter((d) => d > 0);
  const avg = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;
  const avgPre = avg(preDurations);
  const avgRec = avg(recDurations);

  return (
    <div className="bg-card rounded-xl border border-border p-4 space-y-3">
      <h3 className="text-xs font-semibold uppercase tracking-wider text-primary">Phase Timing Summary</h3>
      <div className="grid grid-cols-3 gap-3">
        <div className="bg-muted/50 rounded-lg p-3 text-center">
          <p className="text-[9px] text-muted-foreground uppercase">Sessions</p>
          <p className="text-2xl font-bold font-mono">{sessions.length}</p>
        </div>
        {avgPre &&
        <div className="bg-muted/50 rounded-lg p-3 text-center">
            <p className="text-[9px] text-muted-foreground uppercase">Avg Build→Climax</p>
            <p className="text-xl font-bold font-mono text-chart-3">{fmtDur(avgPre)}</p>
          </div>
        }
        {avgRec &&
        <div className="bg-muted/50 rounded-lg p-3 text-center">
            <p className="text-[9px] text-muted-foreground uppercase">Avg Recovery Onset</p>
            <p className="text-xl font-bold font-mono text-chart-2">{fmtDur(avgRec)}</p>
          </div>
        }
      </div>
      <div className="space-y-1.5">
        {sessions.map((s) => {
          const buildDur = s.pre_climax_offset_s != null ? Math.round(s.climax_offset_s - s.pre_climax_offset_s) : null;
          const recDur = s.recovery_offset_s != null ? Math.round(s.recovery_offset_s - s.climax_offset_s) : null;
          return (
            <div key={s.id} className="flex items-center gap-2 flex-wrap">
              <span className="text-[9px] text-muted-foreground w-12 shrink-0">{s.date?.slice(5, 10)}</span>
              {buildDur > 0 && <Badge variant="outline" className="text-[9px] h-5 px-1.5 text-chart-3 border-chart-3/30">Build {fmtDur(buildDur)}</Badge>}
              {recDur > 0 && <Badge variant="outline" className="text-[9px] h-5 px-1.5 text-chart-2 border-chart-2/30">Recovery +{fmtDur(recDur)}</Badge>}
              {s.intensity && <Badge variant="secondary" className="text-[9px] h-5 px-1.5">I:{s.intensity}</Badge>}
              {s.hr_at_climax && <Badge variant="secondary" className="text-[9px] h-5 px-1.5">♥ {s.hr_at_climax}</Badge>}
            </div>);

        })}
      </div>
    </div>);

}