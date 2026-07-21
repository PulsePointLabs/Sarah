import { useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";
import { Button } from "@/components/ui/button";
import { AlertCircle, TrendingUp, Zap, Activity, Flag, Brain, ChevronDown, ChevronUp } from "lucide-react";
import AIOutputReader from "./AIOutputReader";
import { EVENT_CATEGORIES } from "./session-form/EventTimelineSection";
import { generateSessionKeyVideoClips, SessionReviewVideoExportButton } from "./SessionAIPanel";
import { buildAIGroundingContext, PERSONALIZED_ANATOMY_OUTPUT_RULE } from "@/lib/aiGrounding";
import { buildSessionVisualEvidenceDigest } from "@/lib/visualEvidence";
import { buildSessionAIContentMeta, formatGeneratedAt } from "@/utils/aiContentMetadata";
import { recoverCompletedAIJob, startRecoverableAIJob, waitForRecoverableAIJob } from "@/lib/recoverableAIJobs";

function getCategoryMeta(value) {
  return EVENT_CATEGORIES.find((c) => c.value === value) || EVENT_CATEGORIES[EVENT_CATEGORIES.length - 1];
}

function fmtMmSs(s) {
  const totalS = Math.round(Number(s));
  const m = Math.floor(totalS / 60);
  const sec = totalS % 60;
  return `${m}:${sec.toString().padStart(2, "0")}`;
}

function fmtDur(s) {
  const v = Math.round(Math.abs(s));
  return v >= 60 ? `${Math.floor(v / 60)}m ${v % 60}s` : `${v}s`;
}

const CASCADE_PHASES = [
  { key: "build_phase", color: "#6366f1", title: "Build Phase", icon: <Activity className="w-3.5 h-3.5" /> },
  { key: "pre_climax_phase", color: "#a855f7", title: "Pre-Climax", icon: <Zap className="w-3.5 h-3.5" /> },
  { key: "climax_phase", color: "#ef4444", title: "Climax", icon: <Flag className="w-3.5 h-3.5" /> },
  { key: "recovery_phase", color: "#3b82f6", title: "Recovery", icon: <TrendingUp className="w-3.5 h-3.5" style={{ transform: "scaleY(-1)" }} /> },
  { key: "physiological_findings", color: "#10b981", title: "Physiological Findings", icon: <Brain className="w-3.5 h-3.5" /> },
  { key: "event_sequence_analysis", color: "#f59e0b", title: "Event Sequence Analysis", icon: <Zap className="w-3.5 h-3.5" /> },
];

function aiErrorMessage(error) {
  const raw = error?.data?.error || error?.message || String(error || "Analysis failed");
  try {
    const parsed = JSON.parse(raw);
    return parsed?.error?.message || parsed?.message || parsed?.error || raw;
  } catch {
    return raw;
  }
}

function normalizeCascadeOverview(res) {
  const raw = typeof res === "string" ? JSON.parse(res) : res;
  const parsed = raw?.response ?? raw;
  const hasContent =
    parsed?.summary ||
    parsed?.build_phase ||
    parsed?.pre_climax_phase ||
    parsed?.climax_phase ||
    parsed?.recovery_phase;

  if (!hasContent || parsed?.raw) {
    throw new Error("AI returned text, but not the structured cascade overview the app needs. Please try again.");
  }

  return parsed;
}

function paragraphIndexForCascadeClip(clip, paras, session) {
  const time = Number(clip?.session_time_s);
  if (!Number.isFinite(time)) return Math.min(1, Math.max(0, paras.length - 1));
  const climax = Number(session?.climax_offset_s);
  const recovery = Number(session?.recovery_offset_s);
  const pre = Number(session?.pre_climax_offset_s);
  let targetKey = "build_phase";
  if (Number.isFinite(climax) && Math.abs(time - climax) <= 30) targetKey = "climax_phase";
  else if (Number.isFinite(recovery) && time >= recovery) targetKey = "recovery_phase";
  else if (Number.isFinite(pre) && time >= pre) targetKey = "pre_climax_phase";
  const index = paras.findIndex((para) => para.key === targetKey);
  return index >= 0 ? index : Math.min(1, Math.max(0, paras.length - 1));
}

function PhaseBlock({ color, icon, title, items }) {
  if (!items?.length) return null;
  return (
    <div className="rounded-lg p-3 space-y-1.5" style={{ background: color + "12", borderLeft: `3px solid ${color}` }}>
      <p className="text-xs font-semibold flex items-center gap-1.5" style={{ color }}>
        {icon}{title}
      </p>
      <ul className="space-y-1">
        {items.map((s, i) =>
        <li key={i} className="text-[#ffffff] pl-2">• {s}</li>
        )}
      </ul>
    </div>);

}

export default function CascadeOverviewPanel({ session, timelineRows, emgRows = [], userProfile, sessionJournal }) {
  const [collapsed, setCollapsed] = useState(true);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(session.ai_cascade ?? null);
  const [error, setError] = useState("");
  const jobKey = `cascade-overview:${session.id}`;

  const hasMarkers = session.climax_offset_s != null;
  const cascadeReaderData = (() => {
    if (!result) return { paras: [], paraMeta: [] };
    const paras = [];
    const paraMeta = [];
    if (result.summary) {
      paras.push(result.summary);
      paraMeta.push({ type: "summary" });
    }
    for (const ph of CASCADE_PHASES) {
      const val = result[ph.key];
      if (!val) continue;
      const values = Array.isArray(val) ? val : [val];
      for (const text of values) {
        paras.push(text);
        paraMeta.push({
          type: ph.key === "cascade_quality" ? "section" : "phase",
          sec: {
            key: ph.key,
            label: ph.title,
            color: ph.color,
          },
        });
      }
    }
    if (result.cascade_quality) {
      paras.push(result.cascade_quality);
      paraMeta.push({
        type: "section",
        sec: {
          key: "cascade_quality",
          label: "Cascade Quality Assessment",
          color: "hsl(var(--primary))",
        },
      });
    }
    return { paras, paraMeta };
  })();

  const persistCascadeResult = async (rawResult) => {
    const parsed = normalizeCascadeOverview(rawResult);
    const clipResult = await generateSessionKeyVideoClips({
      session,
      timelineRows,
      label: "Cascade Overview",
    }).catch((clipError) => ({
      clips: [],
      error: clipError?.message || "Could not generate key video clips.",
    }));
    const stored = {
      ...parsed,
      _meta: {
        ...buildSessionAIContentMeta(session, session.ai_cascade?._meta || {}),
        key_video_clips: clipResult.clips || [],
        key_video_clip_error: clipResult.error || "",
      },
    };
    setResult(stored);
    await base44.entities.Session.update(session.id, { ai_cascade: stored });
    return stored;
  };

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
        if (!cancelled && completed.result) {
          await persistCascadeResult(completed.result);
          setError("");
        }
      } catch (err) {
        if (!cancelled) setError(aiErrorMessage(err));
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    recover();
    return () => {
      cancelled = true;
    };
  }, [jobKey]);

  // Nearest HR lookup from timeline
  const nearestHR = (time_s) => {
    if (!timelineRows.length) return null;
    let best = timelineRows[0];
    let bestDist = Math.abs(Number(timelineRows[0].time_offset_s) - time_s);
    for (const r of timelineRows) {
      const d = Math.abs(Number(r.time_offset_s) - time_s);
      if (d < bestDist) {bestDist = d;best = r;}
    }
    return Math.round(Number(best.hr));
  };

  const analyze = async () => {
    setLoading(true);
    setError("");

    try {

    const formatTimeWords = (seconds) => {
      const m = Math.floor(seconds / 60);
      const s = Math.round(seconds % 60);
      if (m === 0) return `${s} second${s !== 1 ? 's' : ''}`;
      if (s === 0) return `${m} minute${m !== 1 ? 's' : ''}`;
      return `${m} minute${m !== 1 ? 's' : ''} and ${s} second${s !== 1 ? 's' : ''}`;
    };

    // Annotate events with HR and phase context
    const annotatedEvents = (session.event_timeline || []).map((ev) => {
      const timeWords = formatTimeWords(ev.time_s);
      const hr = nearestHR(ev.time_s);
      const catMeta = getCategoryMeta(ev.category);
      const relToClimax = session.climax_offset_s != null ? Math.round(ev.time_s - session.climax_offset_s) : null;
      const relStr = relToClimax != null ? ` (${formatTimeWords(Math.abs(relToClimax))} ${relToClimax >= 0 ? 'after' : 'before'} climax)` : "";
      return `[${catMeta.label}] at ${timeWords}${relStr} — ${ev.note}${hr != null ? ` (heart rate: ${hr} beats per minute)` : ""}`;
    });

    // Build HR at key phase markers
    const hrAtPre = session.pre_climax_offset_s != null ? nearestHR(session.pre_climax_offset_s) : null;
    const hrAtClimax = session.hr_at_climax || (session.climax_offset_s != null ? nearestHR(session.climax_offset_s) : null);
    const hrAtRecovery = session.recovery_offset_s != null ? nearestHR(session.recovery_offset_s) : null;

    const buildDur = session.pre_climax_offset_s != null && session.climax_offset_s != null ?
    Math.round(session.climax_offset_s - session.pre_climax_offset_s) : null;
    const recoveryOnset = session.recovery_offset_s != null && session.climax_offset_s != null ?
    Math.round(session.recovery_offset_s - session.climax_offset_s) : null;

    const h = session.start_time ? parseInt(session.start_time.split(":")[0], 10) : null;
    const timeOfDay = h !== null ?
    h >= 5 && h < 12 ? "morning" : h >= 12 && h < 17 ? "afternoon" : h >= 17 && h < 21 ? "evening" : "night" :
    null;

    // Build EMG summary (mirrors SessionAIPanel logic)
    const emgSummary = (() => {
      if (!emgRows.length) return null;
      const isDual = emgRows.some((r) => r.left_pct != null || r.right_pct != null);
      const step = Math.max(1, Math.floor(emgRows.length / 200));
      const sampled = emgRows.filter((_, i) => i % step === 0);

      if (isDual) {
        const leftPcts = sampled.map((r) => r.left_pct).filter((v) => v != null);
        const rightPcts = sampled.map((r) => r.right_pct).filter((v) => v != null);
        const avg = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;
        const max = (arr) => arr.length ? Math.round(Math.max(...arr)) : null;
        const leftClipPct = leftPcts.length ? Math.round((leftPcts.filter((v) => v >= 99).length / leftPcts.length) * 100) : 0;
        const rightClipPct = rightPcts.length ? Math.round((rightPcts.filter((v) => v >= 99).length / rightPcts.length) * 100) : 0;

        // Phase-windowed EMG averages for cascade correlation
        const phaseAvg = (pcts, timeKey) => {
          if (session[timeKey + '_offset_s'] == null) return null;
          const phaseRows = sampled.filter((r) => {
            const t = r.time_s;
            if (timeKey === 'pre_climax') return t >= (session.pre_climax_offset_s - 30) && t <= session.pre_climax_offset_s;
            if (timeKey === 'climax') return Math.abs(t - session.climax_offset_s) <= 30;
            if (timeKey === 'recovery') return t >= session.climax_offset_s && t <= (session.climax_offset_s + 60);
            return false;
          });
          const vals = phaseRows.map((r) => r.left_pct ?? r.right_pct).filter((v) => v != null);
          return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length) : null;
        };

        const leftTraj = sampled.filter((r) => r.left_pct != null).map((r) => `${r.time_s.toFixed(1)}s:${Math.round(r.left_pct)}%`).join(" ");
        const rightTraj = sampled.filter((r) => r.right_pct != null).map((r) => `${r.time_s.toFixed(1)}s:${Math.round(r.right_pct)}%`).join(" ");
        return {
          channel_mode: "dual",
          total_samples: emgRows.length,
          target_area: session.emg_target_area || undefined,
          sensor_type: session.emg_sensor_type || undefined,
          left_avg_pct: avg(leftPcts),
          left_max_pct: max(leftPcts),
          left_clip_percent_of_time: leftClipPct,
          right_avg_pct: avg(rightPcts),
          right_max_pct: max(rightPcts),
          right_clip_percent_of_time: rightClipPct,
          left_trajectory: leftTraj,
          right_trajectory: rightTraj,
          calibration: {
            rest_l: session.emg_rest_left, max_l: session.emg_max_left,
            rest_r: session.emg_rest_right, max_r: session.emg_max_right,
            lr_flipped: session.emg_left_right_flipped,
          },
          placement_notes: {
            left: session.emg_left_placement_notes,
            right: session.emg_right_placement_notes,
            calibration: session.emg_calibration_notes,
            general: session.emg_general_notes,
          },
          placement_photo_tags: (session.emg_placement_photos || []).map((p) => `${p.tag}: ${p.caption}`).filter(Boolean),
        };
      } else {
        const pcts = sampled.map((r) => r.level_pct).filter((v) => v != null);
        const avg = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : null;
        const clipPct = pcts.length ? Math.round((pcts.filter((v) => v >= 99).length / pcts.length) * 100) : 0;
        const traj = sampled.filter((r) => r.level_pct != null).map((r) => `${r.time_s.toFixed(1)}s:${Math.round(r.level_pct)}%`).join(" ");
        return {
          channel_mode: "single",
          total_samples: emgRows.length,
          target_area: session.emg_target_area || undefined,
          sensor_type: session.emg_sensor_type || undefined,
          avg_pct: avg(pcts),
          max_pct: pcts.length ? Math.round(Math.max(...pcts)) : null,
          clip_percent_of_time: clipPct,
          trajectory: traj,
          calibration: { rest: session.emg_rest_left, max: session.emg_max_left, calibration_notes: session.emg_calibration_notes },
          placement_notes: session.emg_left_placement_notes,
          general_notes: session.emg_general_notes,
          placement_photo_tags: (session.emg_placement_photos || []).map((p) => `${p.tag}: ${p.caption}`).filter(Boolean),
        };
      }
    })();

    // Compute physiological metrics from HR timeline
    const sortedRows = [...timelineRows].sort((a, b) => Number(a.time_offset_s) - Number(b.time_offset_s));
    const hrVals = sortedRows.map((r) => Number(r.hr)).filter((v) => !isNaN(v));
    const baselineHR = hrVals.length ? Math.round(hrVals.slice(0, Math.min(10, Math.floor(hrVals.length * 0.1))).reduce((a, b) => a + b, 0) / Math.max(1, Math.min(10, Math.floor(hrVals.length * 0.1)))) : null;
    const diffs = hrVals.slice(1).map((v, i) => Math.pow(v - hrVals[i], 2));
    const rmssd = diffs.length ? Math.round(Math.sqrt(diffs.reduce((a, b) => a + b, 0) / diffs.length) * 10) / 10 : null;

    let sympatheticIndex = null;
    if (session.pre_climax_offset_s != null && session.climax_offset_s != null && baselineHR) {
      const buildRows = sortedRows.filter((r) => Number(r.time_offset_s) >= session.pre_climax_offset_s && Number(r.time_offset_s) <= session.climax_offset_s);
      if (buildRows.length) {
        sympatheticIndex = Math.round(buildRows.reduce((a, r) => a + Number(r.hr), 0) / buildRows.length - baselineHR);
      }
    }

    let recoverySlope = null;
    if (session.climax_offset_s != null) {
      const postClimax = sortedRows.filter((r) => Number(r.time_offset_s) >= session.climax_offset_s && Number(r.time_offset_s) <= session.climax_offset_s + 60);
      if (postClimax.length >= 2) {
        const first = postClimax[0], last = postClimax[postClimax.length - 1];
        const dt = Number(last.time_offset_s) - Number(first.time_offset_s);
        if (dt > 0) recoverySlope = Math.round(((Number(last.hr) - Number(first.hr)) / dt) * 100) / 100;
      }
    }

    let buildRateBpmPerSec = null;
    if (session.pre_climax_offset_s != null && session.climax_offset_s != null) {
      const hrPre = nearestHR(session.pre_climax_offset_s);
      const hrClimaxVal = hrAtClimax;
      const dt = session.climax_offset_s - session.pre_climax_offset_s;
      if (hrPre && hrClimaxVal && dt > 0) buildRateBpmPerSec = Math.round(((hrClimaxVal - hrPre) / dt) * 100) / 100;
    }

    const peakHR = hrAtClimax;
    let plateauDuration = null;
    if (peakHR && session.climax_offset_s != null) {
      const near = sortedRows.filter((r) => Math.abs(Number(r.hr) - peakHR) <= 5 && Math.abs(Number(r.time_offset_s) - session.climax_offset_s) <= 90);
      if (near.length >= 2) plateauDuration = Math.round(Number(near[near.length - 1].time_offset_s) - Number(near[0].time_offset_s));
    }

    const hrTrajectory = (() => {
      if (!sortedRows.length) return null;
      const step = Math.max(1, Math.floor(sortedRows.length / 80));
      return sortedRows.filter((_, i) => i % step === 0)
        .map((r) => `${Math.round(Number(r.time_offset_s))}s:${Math.round(Number(r.hr))}`)
        .join("  ");
    })();

    const physiologicalMetrics = {
      estimated_baseline_hr_bpm: baselineHR,
      peak_hr_bpm: peakHR,
      hr_rise_above_baseline_bpm: peakHR && baselineHR ? Math.round(peakHR - baselineHR) : null,
      sympathetic_activation_index_bpm: sympatheticIndex,
      build_rate_bpm_per_second: buildRateBpmPerSec,
      plateau_duration_near_peak_s: plateauDuration,
      recovery_slope_bpm_per_second: recoverySlope,
      hr_variability_roughness_rmssd: rmssd,
    };

    const arousalProfile = userProfile && (userProfile.arousal_response_style || userProfile.arousal_notes || userProfile.climax_sensitivity) ? `

USER AROUSAL PROFILE:
${JSON.stringify({
      arousal_response_style: userProfile.arousal_response_style,
      typical_build_duration: userProfile.typical_build_duration,
      climax_sensitivity: userProfile.climax_sensitivity,
      preferred_stimulation: userProfile.preferred_stimulation,
      refractory_pattern: userProfile.refractory_pattern,
      arousal_notes: userProfile.arousal_notes
    }, null, 2)}

    Use this arousal profile to contextualize the cascade — compare the observed build arc, phase durations, and recovery against the user's known response style. Note deviations and what factors may have caused them.` : "";

    const groundingContext = buildAIGroundingContext(userProfile);
    const reviewedVisualEvidence = buildSessionVisualEvidenceDigest(session);

    const estimScreenshots = [
      ...(session.estim_screenshots || []),
      ...(session.estim_screenshot && !(session.estim_screenshots?.includes(session.estim_screenshot)) ? [session.estim_screenshot] : []),
    ].filter(Boolean);

    const aiPayload = {
      model: "claude_sonnet_4_6",
      max_tokens: 7000,
      ...(estimScreenshots.length > 0 ? { images: estimScreenshots } : {}),
      prompt: `You are a physiological research assistant and anatomist specializing in sexual response. Analyze the climax cascade arc of this single session in depth, integrating HR data, EMG data (if present), anatomy, and event timing. Write directly to the person — use "you" and "your" throughout, as if speaking to them personally.

${groundingContext}
${reviewedVisualEvidence}
${PERSONALIZED_ANATOMY_OUTPUT_RULE}

PHYSIOLOGICAL & ANATOMICAL LENS — CONDITIONAL USE ONLY:
Only mention specific physiological phases, anatomical structures, or mechanisms when the session data gives you a concrete reason to do so. Never insert these as generic background explanation.
- BUILD: Sympathetic tone ramp-up, pelvic floor baseline tone, how stimulation method drives afferent nerve signaling — only narrate if HR or event data shows it
- PRE-CLIMAX: Emission phase signals, HR acceleration, sensory events — ground every claim in the data
- CLIMAX: Peak physiology, contraction pattern, ejaculate correlates — reference actual HR values and events
- RECOVERY: Parasympathetic rebound, HR descent rate, refractory physiology — use the computed recovery slope
- Preserve the explanatory "why." When phase timing, heart-rate movement, stimulation changes, event notes, or subjective metrics line up, explain the likely autonomic or sensory mechanism behind that cascade pattern.
- Discuss stimulation-to-body links when supported: how pressure, friction, suction, vibration, e-stim, foley/urethral input, perineal contact, or technique shifts likely changed sensory input, pelvic floor tone, autonomic loading, or climax threshold.${emgSummary ? `

EMG INTERPRETATION RULES — apply carefully:
- EMG % is NORMALIZED RELATIVE ACTIVATION, not absolute force. Never claim EMG % equals muscle force.
- Left/right comparisons are only valid when each channel was independently calibrated.
- If placement differs between sides, note that asymmetry may reflect placement, not true muscle asymmetry.
- Clipping (100%) means timing data is useful but high-end detail is compressed.
- One flat/noisy channel suggests sensor dropout — call it out.
- Correlate EMG bursts with HR changes and event markers phase by phase.
- If EMG peaks precede HR rise, describe EMG leading the HR response.
- If HR rises without EMG change, note this as possible autonomic/non-muscular response.
- Describe the likely target muscle based on placement notes and photo tags.` : ""}${estimScreenshots.length > 0 ? `

E-STIM SCREENSHOTS ATTACHED (${estimScreenshots.length}): Analyze waveform types, frequencies, pulse widths, and channel configurations. Interpret how these settings shaped each phase of the cascade.` : ""}

COMPUTED PHYSIOLOGICAL METRICS:
- estimated_baseline_hr_bpm: resting-like HR at session start
- hr_rise_above_baseline_bpm: total HR elevation from baseline to climax peak
- sympathetic_activation_index_bpm: mean HR elevation above baseline during build phase
- build_rate_bpm_per_second: speed of HR rise during pre-climax buildup
- plateau_duration_near_peak_s: seconds HR stayed within 5 bpm of climax peak
- recovery_slope_bpm_per_second: rate of HR descent in first 60s post-climax (negative = falling)
- hr_variability_roughness_rmssd: beat-to-beat roughness (proxy for autonomic variability)
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
- Each phase must be written as 3–5 complete flowing prose sentences, rich and specific
${arousalProfile}
${hrTrajectory ? `\nHR TRAJECTORY (time_s:bpm, sampled):\n${hrTrajectory}\n\nUse this to trace the sympathetic activation arc through each phase.` : ""}

For each phase write a rich prose paragraph — speak naturally and directly to the person, grounding each claim in the HR data, computed metrics, EMG (if present), and event notes:
1. BUILD: arousal arc, HR climb rate, stimulation dynamics, autonomic activation trajectory, any EMG activation onset
2. PRE-CLIMAX: final ascent, emission phase signals, HR acceleration, sensory events, EMG leading patterns
3. CLIMAX: peak physiology, HR plateau/spike, contraction correlates from EMG, ejaculate, subjective experience
4. RECOVERY: autonomic rebound, recovery slope interpretation, parasympathetic signals, post-climax sensations
5. PHYSIOLOGICAL FINDINGS: interpret the computed metrics — sympathetic load, build rate, plateau duration, recovery efficiency. Are there signs of strong autonomic regulation or areas to watch? Then explicitly compare the subjective ratings (intensity, satisfaction, mood) to the objective physiological output — does the reported intensity match the HR rise above baseline? Does satisfaction align with plateau duration and recovery efficiency? Call out any clear divergences and suggest what they might mean.
6. EVENT SEQUENCE ANALYSIS: Review the annotated event timeline carefully. Identify meaningful timing patterns — do specific stimulation changes consistently precede rapid HR acceleration? Are discomfort notes clustered at particular phase transitions? Are there event sequences (e.g. a pause followed by resumed stimulation) that produced notable HR responses? Name the actual events and timestamps when describing these patterns.
7. CASCADE QUALITY: holistic assessment — how well did all the signals (HR, EMG, events, subjective scores) align? What made this cascade distinctive? 1–2 actionable observations for future sessions.

${sessionJournal ? `SESSION JOURNAL (person's post-session reflections — use to connect subjective experience to cascade phases):
Emotional: ${sessionJournal.emotional_reflection || ""}
Physiological: ${sessionJournal.physiological_observations || ""}
Narrative: ${sessionJournal.experience_narrative || ""}
Insights: ${sessionJournal.insights || ""}
${sessionJournal.key_moments?.length ? `Key moments: ${sessionJournal.key_moments.join("; ")}` : ""}
Next intentions: ${sessionJournal.next_session_intentions || ""}

Reference the journal when interpreting cascade phases — note where subjective experience matches or diverges from the physiological data.

` : ""}Session cascade data:
${JSON.stringify({
        date: session.date ? (() => {
          const d = new Date(session.date);
          return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
        })() : undefined,
        start_time_et: session.start_time || undefined,
        time_of_day: timeOfDay || undefined,
        duration_minutes: session.duration_minutes,
        build_type: session.build_type,
        build_quality: session.build_quality,
        climax_duration: session.climax_duration,
        intensity: session.intensity,
        satisfaction: session.satisfaction,
        mood: session.mood,
        methods: session.methods,
        foley_size: session.foley_size,
        foley_type: session.foley_type,
        estim_notes: session.estim_notes,
        sleeve_type: session.sleeve_type,
        avg_hr: session.avg_hr,
        max_hr: session.max_hr,
        hr_at_climax: hrAtClimax,
        hr_at_pre_climax_marker: hrAtPre,
        hr_at_recovery_marker: hrAtRecovery,
        hr_avg_pre_to_climax: session.hr_avg_pre_to_climax,
        hr_avg_at_climax_window: session.hr_avg_at_climax_window,
        build_duration_s: buildDur,
        recovery_onset_s: recoveryOnset,
        ejaculate_volume: session.ejaculate_volume,
        unusual_sensations: session.unusual_sensations,
        hydration: session.hydration,
        substances: session.substances,
        discomfort_entries: session.discomfort_entries?.length ? session.discomfort_entries : undefined,
        notes: session.notes || undefined
      }, null, 2)}
${annotatedEvents.length > 0 ? `\nAnnotated event timeline (with HR at each moment):\n${annotatedEvents.join("\n")}` : ""}${emgSummary ? `\n\nEMG DATA:\n${JSON.stringify(emgSummary, null, 2)}\n\nAnalyze EMG activation patterns alongside HR through each cascade phase. Reference timing relationships between EMG bursts and HR changes. Check for clipping, asymmetry, and relate bursts to event markers and phase markers.` : ""}`,
      response_json_schema: {
        type: "object",
        properties: {
          summary: { type: "string" },
          build_phase: { type: "string" },
          pre_climax_phase: { type: "string" },
          climax_phase: { type: "string" },
          recovery_phase: { type: "string" },
          physiological_findings: { type: "string" },
          event_sequence_analysis: { type: "string" },
          cascade_quality: { type: "string" }
        },
        required: ["summary", "build_phase", "pre_climax_phase", "climax_phase", "recovery_phase", "physiological_findings", "event_sequence_analysis", "cascade_quality"]
      }
    };
    const job = await startRecoverableAIJob(jobKey, aiPayload, {
      title: "Cascade Overview",
      label: "Cascade Overview",
      source: "cascade_overview",
      sessionId: session.id,
    });
    const completed = await waitForRecoverableAIJob(jobKey, job.id, { intervalMs: 1800 });
    await persistCascadeResult(completed.result);
    } catch (err) {
      console.error("AI Cascade overview failed:", err);
      setError(aiErrorMessage(err));
    } finally {
    setLoading(false);
    }
  };

  return (
    <div className="bg-card rounded-xl border border-border p-4 space-y-3">
      <div className="flex items-center justify-between">
        <button className="flex items-center gap-1.5 flex-1 text-left" onClick={() => setCollapsed((v) => !v)}>
          <h3 className="text-xs font-semibold uppercase tracking-wider text-primary flex items-center gap-1.5">
            <TrendingUp className="w-4 h-4" /> Cascade Overview
          </h3>
          {collapsed ? <ChevronDown className="w-4 h-4 text-muted-foreground ml-1" /> : <ChevronUp className="w-4 h-4 text-muted-foreground ml-1" />}
        </button>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            onClick={analyze}
            disabled={loading || !hasMarkers}
            className="h-7 text-xs gap-1.5">
            
            {loading ?
            <><span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />Analyzing…</> :
            <><Brain className="w-3 h-3" />Analyze</>}
          </Button>
        </div>
      </div>

      {!collapsed && !hasMarkers &&
      <p className="text-xs text-muted-foreground">
          Set Pre-Climax, Climax, and Recovery markers on the HR timeline above to enable cascade analysis.
        </p>
      }

      {!collapsed && hasMarkers && !result && !loading &&
      <p className="text-xs text-muted-foreground">
          Analyze the full cascade arc — build, pre-climax, climax, and recovery — with event correlations. Uses Claude Sonnet.
        </p>
      }

      {!collapsed && error &&
      <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      }

      {/* Phase timing mini-summary */}
      {!collapsed && hasMarkers &&
      <div className="grid grid-cols-2 gap-2">
          {session.pre_climax_offset_s != null && session.climax_offset_s != null &&
        <div className="bg-muted/50 rounded-lg px-3 py-2 flex flex-col items-center">
              <p className="text-[9px] uppercase text-muted-foreground tracking-wide">Build → Climax</p>
              <p className="text-base font-bold font-mono" style={{ color: "#a855f7" }}>
                {fmtDur(session.climax_offset_s - session.pre_climax_offset_s)}
              </p>
            </div>
        }
          {session.recovery_offset_s != null && session.climax_offset_s != null &&
        <div className="bg-muted/50 rounded-lg px-3 py-2 flex flex-col items-center">
              <p className="text-[9px] uppercase text-muted-foreground tracking-wide">Recovery Onset</p>
              <p className="text-base font-bold font-mono" style={{ color: "#3b82f6" }}>
                +{fmtDur(session.recovery_offset_s - session.climax_offset_s)}
              </p>
            </div>
        }
        </div>
      }

      {!collapsed && result && (() => {
        // Build flat paragraph list with metadata for rendering
        // phases are now strings (prose), support both string and legacy array format
        const paras = [];
        if (result.summary) paras.push({ key: "summary", text: result.summary, type: "summary", color: null });
        for (const ph of CASCADE_PHASES) {
          const val = result[ph.key];
          if (!val) continue;
          if (Array.isArray(val)) {
            for (const item of val) paras.push({ key: ph.key, text: item, type: "phase", color: ph.color, title: ph.title });
          } else {
            paras.push({ key: ph.key, text: val, type: "phase", color: ph.color, title: ph.title });
          }
        }
        if (result.cascade_quality) paras.push({ key: "cascade_quality", text: result.cascade_quality, type: "quality", color: null });
        const keyVideoClips = Array.isArray(result?._meta?.key_video_clips) ? result._meta.key_video_clips : [];
        const keyVideoClipError = result?._meta?.key_video_clip_error || "";
        const clipsByParagraph = keyVideoClips.reduce((map, clip) => {
          const paraIndex = paragraphIndexForCascadeClip(clip, paras, session);
          if (!map.has(paraIndex)) map.set(paraIndex, []);
          map.get(paraIndex).push(clip);
          return map;
        }, new Map());

        return (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
              <span>
                {result?._meta?.last_generated_at
                  ? `Generated ${formatGeneratedAt(result._meta.last_generated_at)}`
                  : "Generated time unavailable"}
              </span>
              {keyVideoClips.length > 0 && (
                <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 font-semibold text-primary">
                  {keyVideoClips.length} key video clip{keyVideoClips.length === 1 ? "" : "s"}
                </span>
              )}
            </div>
            {!keyVideoClips.length && keyVideoClipError && (
              <div className="rounded-lg border border-amber-400/30 bg-amber-400/10 px-3 py-2 text-xs text-amber-100">
                Key video clips were not added: {keyVideoClipError}
              </div>
            )}
            {cascadeReaderData.paras.length > 0 && (
              <div className="rounded-xl border border-primary/20 bg-primary/[0.045] p-3">
                <div className="mb-2">
                  <p className="text-xs font-semibold uppercase tracking-wider text-primary">Climax Cascade Video</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    Builds a narrated MP4 from this cascade overview and phase analysis.
                  </p>
                </div>
                <SessionReviewVideoExportButton
                  session={session}
                  analysisTitle="Climax Cascade"
                  sourceGeneratedAt={result?._meta?.last_generated_at ? `${result._meta.last_generated_at}:climax-cascade` : `${session.id || session.date || "session"}:climax-cascade`}
                  paragraphs={cascadeReaderData.paras}
                  paragraphMeta={cascadeReaderData.paraMeta}
                  timelineRows={timelineRows}
                  emgRows={emgRows}
                />
              </div>
            )}
            <AIOutputReader
              sessionId={session.id}
              title="Cascade Overview"
              sessionDate={session.date}
              sourceGeneratedAt={result?._meta?.last_generated_at}
              paragraphs={paras.map((p) => p.text)}
              paragraphMeta={paras.map((meta, paraIdx) => {
                const clips = clipsByParagraph.get(paraIdx) || [];
                return meta.type === "summary"
                  ? { type: "summary", clips }
                  : {
                    type: meta.type === "quality" ? "section" : "phase",
                    clips,
                    sec: {
                      key: meta.type === "quality" ? "cascade_quality" : meta.title,
                      label: meta.type === "quality" ? "Cascade Quality Assessment" : meta.title,
                      color: meta.color || "hsl(var(--primary))",
                    },
                  };
              })}
            />
          </div>);


      })()}
    </div>);

}
