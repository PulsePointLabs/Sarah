import { useEffect, useState } from "react";
import { base44 } from "@/api/base44Client";
import { AlertCircle, Brain, Activity, Lightbulb, TrendingUp, Zap, ChevronDown, ChevronUp } from "lucide-react";
import TTSReader from "./TTSReader";
import { Button } from "@/components/ui/button";
import { EVENT_CATEGORIES } from "./session-form/EventTimelineSection";
import { buildAIGroundingContext, buildOptionalFirstNameToneCue, PERSONALIZED_ANATOMY_OUTPUT_RULE } from "@/lib/aiGrounding";
import { listBackgroundJobs, startBackgroundJob, waitForBackgroundJob } from "@/lib/backgroundJobs";
import { SESSION_CONTEXT_GROUNDING_RULE, structuredSessionContextForAI } from "@/lib/sessionContext";
import { getMotionEvidenceDigest, getMotionEvidenceSummary } from "@/utils/sessionMotionEvidence";
import { buildSessionAIContentMeta, formatGeneratedAt, isSessionAIContentStale } from "@/utils/aiContentMetadata";
import { repairAITextBlocks, repairCharacterSplitParagraph } from "@/utils/aiTextRepair";
function buildSessionContext(session, timelineRows) {
  const hrMin = timelineRows.length ? Math.round(Math.min(...timelineRows.map(r => Number(r.hr)))) : null;
  const hrMax = timelineRows.length ? Math.round(Math.max(...timelineRows.map(r => Number(r.hr)))) : null;
  return [
    `Session date: ${session.date?.slice(0, 10)}`,
    `Duration: ${session.duration_minutes ?? "?"}min`,
    `Methods: ${(session.methods || []).join(", ")}`,
    session.foley_size ? `Foley: ${session.foley_size}Fr ${session.foley_type || ""}` : null,
    session.estim_notes ? `E-Stim notes: ${session.estim_notes}` : null,
    `Intensity: ${session.intensity}/10, Build quality: ${session.build_quality}/10, Satisfaction: ${session.satisfaction}/10`,
    [
      session.release_completeness ? `release completeness ${session.release_completeness}/10` : null,
      session.arousal_depth ? `arousal depth ${session.arousal_depth}/10` : null,
      session.erection_stability ? `response stability ${session.erection_stability}/10` : null,
      session.stimulation_fit ? `stimulation fit ${session.stimulation_fit}/10` : null,
      session.control ? `edge/control quality ${session.control}/10` : null,
      session.sensory_immersion ? `sensory immersion ${session.sensory_immersion}/10` : null,
      session.recovery_quality ? `recovery quality ${session.recovery_quality}/10` : null,
      session.discomfort_interference ? `discomfort/interruption impact ${session.discomfort_interference}/10` : null,
    ].filter(Boolean).length
      ? `Targeted subjective metrics: ${[
        session.release_completeness ? `release completeness ${session.release_completeness}/10` : null,
        session.arousal_depth ? `arousal depth ${session.arousal_depth}/10` : null,
        session.erection_stability ? `response stability ${session.erection_stability}/10` : null,
        session.stimulation_fit ? `stimulation fit ${session.stimulation_fit}/10` : null,
        session.control ? `edge/control quality ${session.control}/10` : null,
        session.sensory_immersion ? `sensory immersion ${session.sensory_immersion}/10` : null,
        session.recovery_quality ? `recovery quality ${session.recovery_quality}/10` : null,
        session.discomfort_interference ? `discomfort/interruption impact ${session.discomfort_interference}/10` : null,
      ].filter(Boolean).join(", ")}`
      : null,
    session.primary_limiting_factor ? `Primary limiting factor: ${session.primary_limiting_factor}` : null,
    session.subjective_notes ? `Subjective metric notes: ${session.subjective_notes}` : null,
    `Build type: ${session.build_type}${session.custom_build_type ? " — " + session.custom_build_type : ""}`,
    `Climax duration: ${session.climax_duration ?? "?"}`,
    `Mood: ${session.mood}, Hydration: ${session.hydration}`,
    hrMin != null ? `HR: min ${hrMin}, avg ${session.avg_hr ?? "?"}, max ${hrMax}, at climax ${session.hr_at_climax ?? "?"}` : null,
    session.pre_climax_offset_s != null ? `Phase markers: pre-climax ${Math.round(session.pre_climax_offset_s)}s, climax ${Math.round(session.climax_offset_s)}s, recovery ${session.recovery_offset_s != null ? Math.round(session.recovery_offset_s) + "s" : "?"}` : null,
    session.ejaculate_volume ? `Ejaculate: ${session.ejaculate_volume}` : null,
    session.unusual_sensations ? `Unusual sensations: ${session.unusual_sensations}` : null,
    (session.discomfort_entries || []).length ? `Discomfort: ${session.discomfort_entries.map(e => `sev ${e.severity}/10 — ${e.note}`).join("; ")}` : null,
    (session.event_timeline || []).length ? `Events: ${session.event_timeline.map(e => `[${e.time_s}s] ${e.note}`).join(" | ")}` : null,
    session.notes ? `Session notes: ${session.notes}` : null,
    session.ai_analysis?.summary ? `AI analysis summary: ${session.ai_analysis.summary}` : null,
  ].filter(Boolean).join("\n");
}

function buildWarmMotionEvidence(session) {
  const evidence = getMotionEvidenceSummary(session);
  if (!evidence.hasAnyMotionEvidence) return "";
  return `

REVIEWED MEDIA-DERIVED MOTION EVIDENCE (observational evidence only):
${getMotionEvidenceDigest(session)}

MOTION INTERPRETATION RULES:
- This summary contains compact locally derived movement signals, not raw video or raw landmarks.
- Use it only for visible movement timing, side-to-side comparison, or cautious correlation with heart rate and logged events.
- Do not infer intent, mechanism, muscle force, neurological meaning, or arousal state from movement alone.
- Any hand cadence estimate is an observational hand-movement cadence proxy, not confirmed stroke speed.

EVIDENCE PRECEDENCE HIERARCHY FOR MOVEMENT:
- Saved motion telemetry has precedence for visible lower-body movement timing, left/right comparison, asymmetry, cadence proxy, and motion peaks.
- User-verified motion-derived events have been visually reviewed and may be treated as stronger observational evidence than unverified motion-derived events. Verification does not establish intent, force, neurological mechanism, or physiological cause.
- For stimulation pause/resume timing and pause duration, explicit manually entered timeline events tagged stimulation_paused or stimulation_resumed take priority over motion-derived hand pause/resume candidates. Hand tracking can miss or misclassify activity, so use motion-derived pauses only as secondary corroboration when manual pause/resume events exist.
- If there are no explicit manually entered stimulation pause/resume events, describe motion-derived pauses only as observed hand-activity gap candidates, not confirmed stimulation pauses.
- Manual notes remain valuable when they add context motion cannot infer, such as repositioning, method changes, breathing changes, subjective sensation, or interruption.
- If a vague manual movement description conflicts with saved motion telemetry, prefer telemetry for the visible movement description while preserving the note as subjective or contextual history.
- Treat motion-derived evidence as observational only. Do not infer intent, arousal phase, muscle force, neurological meaning, or physiological mechanism from motion alone.`;
}

const AI_SESSION_TYPE_GROUNDING_V1 = `
SESSION TYPE / INTENT GROUNDING - HIGH PRIORITY:
- Before interpreting this session, infer the session intent from build_type, methods, notes, event timeline, phase markers, climax fields, HR data, journal, and saved motion evidence.
- Distinguish masturbation/stimulation sessions from body exploration, sensation mapping, positioning review, recovery review, device fit/comfort review, or other non-climax observational sessions.
- Absence of climax is not missing data, failure, or an incomplete session when the session appears exploratory or observational. Do not imply that heart-rate data, event notes, motion evidence, or metrics are absent if they are present in the prompt.
- If climax, ejaculation, pre-climax, or recovery markers are absent, say that those specific phase markers are not logged; do not generalize that session evidence is missing.
- For body exploration sessions, analyze the available evidence on its own terms: what the body was doing, which sensations or positions were being mapped, how HR changed, what events were logged, what motion evidence showed, and what was learned.
- For masturbation/stimulation sessions, interpret stimulation efficiency, arousal build, plateau, climax approach, climax/release when present, and recovery when supported.
- For mixed sessions, explicitly separate exploratory/body-mapping goals from stimulation/arousal goals.
`;

const BODY_STATE_INTERPRETIVE_STYLE_V1 = `
BODY-STATE INTERPRETIVE STYLE - RESTORE PULSEPOINT FEEL:
- Do not let the analysis become only "this happened, then this happened." Use the timeline as evidence for what the body was doing in each phase.
- When HR, event notes, subjective sensations, movement evidence, or stimulation changes line up, translate them into body-state language: autonomic loading, sensory focus, pelvic/urethral/prostatic awareness when supported, muscular tension or settling when supported, preparation, plateauing, thresholding, recovery, or exploratory mapping.
- Prefer phrasing like "at this point your body appears to be..." or "this looks like..." when evidence supports a visible/physiological state.
- Keep mechanism calibrated. Do not overclaim. But when the data supports it, explain the likely physiological meaning instead of merely retelling the timestamp.
- In body exploration sessions, "what your body is doing" may mean mapping sensation, testing comfort, observing HR response, position tolerance, device fit, movement patterns, or nervous-system settling rather than arousal escalation.
`;

const WARM_COMPANION_OUTPUT_DISCIPLINE = `
COMPANION VOICE AND SINGLE-PASS STRUCTURE - HIGH PRIORITY:
- Address the person directly throughout. Never write "the user," "the user's notes," "the subject," "the participant," or "the patient." Say "your notes," "you observed," "your body," "your pattern," or "your recovery."
- Produce one interpretive pass through the timeline only. The executive summary should preview the central arc without replaying details. The chronological deep dive is the only place to narrate sequential events.
- Do not re-explain the same insertion, heart-rate shift, movement event, or sensory note in multiple sections. Later sections should synthesize implications, not retell the event sequence.
- Organize the existing response keys as follows:
  * summary = Executive Summary: rich and concise.
  * arousal_arc = Chronological Deep Dive: one ordered, phase-by-phase timeline pass.
  * event_analysis = Motion Telemetry Interpretation and evidence integration: asymmetry, cadence proxy, movement patterns, conflicts between sources, and new implications only; do not replay chronology.
  * notable_findings = Pattern Recognition / Cross-Session Context and clearly identified hypotheses.
  * recommendations = Recommendations / Experiments: focused next steps grounded in supported findings.
- Prefix speculative mechanisms with "Hypothesis:" or "One possible explanation:" and qualify them with wording such as "may suggest" or "is consistent with."
- Describe observed findings confidently, but never say evidence "proves," "confirms," or "indicates definitively" an inferred physiological mechanism.
- If a subjective note conflicts with stronger direct visual review, reviewed media-derived evidence, telemetry, or a corrected later observation, prefer the stronger evidence and explicitly acknowledge the discrepancy. Do not build recommendations on a disputed note as though it were settled fact.
`;

function getCategoryMeta(value) {
  return EVENT_CATEGORIES.find((c) => c.value === value) || EVENT_CATEGORIES[EVENT_CATEGORIES.length - 1];
}

const SECTION_COLORS = {
  primary: "hsl(var(--primary))",
  "chart-1": "hsl(var(--chart-1))",
  "chart-2": "hsl(var(--chart-2))",
  "chart-4": "hsl(var(--chart-4))",
  accent: "hsl(var(--accent))",
  destructive: "hsl(var(--destructive))",
};

function aiErrorMessage(error) {
  const raw = error?.data?.error || error?.message || String(error || "Analysis failed");
  try {
    const parsed = JSON.parse(raw);
    return parsed?.error?.message || parsed?.message || parsed?.error || raw;
  } catch {
    return raw;
  }
}

function completedAt(job) {
  return job?.finishedAt || job?.updatedAt || job?.createdAt || null;
}

function isNewerCompletedJob(job, savedResult) {
  if (job?.status !== "complete") return false;
  const jobTime = new Date(completedAt(job) || 0).getTime();
  const savedTime = new Date(savedResult?._meta?.last_generated_at || savedResult?._meta?.updated_at || 0).getTime();
  return Number.isFinite(jobTime) && jobTime > (Number.isFinite(savedTime) ? savedTime : 0);
}

function normalizeSessionAnalysis(res) {
  const raw = typeof res === "string" ? JSON.parse(res) : res;
  const parsed = raw?.response ?? raw;
  const hasContent =
    parsed?.summary ||
    parsed?.arousal_arc?.length ||
    parsed?.phase_analysis?.length ||
    parsed?.event_analysis?.length ||
    parsed?.hr_analysis?.length;

  if (!hasContent || parsed?.raw) {
    throw new Error("AI returned text, but not the structured session analysis the app needs. Please try again.");
  }

  return repairAITextBlocks(parsed);
}

function Section({ icon, title, color, children }) {
  return (
    <div className="bg-muted/60 rounded-lg p-3 space-y-2">
      <p className="flex items-center gap-1.5 text-xs font-semibold" style={{ color: SECTION_COLORS[color] }}>
        {icon}{title}
      </p>
      <ul className="space-y-1.5">{children}</ul>
    </div>
  );
}

function Item({ text }) {
  return (
    <li className="text-sm text-foreground leading-relaxed pl-3 border-l-2 border-primary/40 py-1">
      {text}
    </li>
  );
}

function AnalysisStatus({ job }) {
  const progress = job?.progress || {};
  const total = Number(progress.total || 0);
  const current = Number(progress.current || 0);
  const pct = total > 0 ? Math.max(8, Math.min(100, Math.round((current / total) * 100))) : 18;
  const label = progress.message || (job?.status === "queued" ? "Queued…" : "Working…");
  return (
    <div className="rounded-lg border border-primary/25 bg-primary/8 px-3 py-3 text-xs">
      <div className="flex items-start gap-2">
        <span className="mt-0.5 h-3.5 w-3.5 shrink-0 animate-spin rounded-full border-2 border-primary border-t-transparent" />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <p className="font-semibold text-foreground">{label}</p>
            <span className="rounded-full bg-primary/10 px-2 py-0.5 font-mono text-[10px] uppercase text-primary">
              {job?.status || "starting"}{progress.phase ? ` / ${progress.phase}` : ""}
            </span>
          </div>
          <div className="mt-2 h-2 overflow-hidden rounded-full bg-muted">
            <div className="h-full rounded-full bg-primary transition-all" style={{ width: `${pct}%` }} />
          </div>
          <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
            {job?.id && <span>Job {String(job.id).slice(0, 8)}</span>}
            {progress.model && <span>Model {progress.model}</span>}
            {total > 0 && <span>Step {Math.min(current + 1, total)} of {total}</span>}
          </div>
        </div>
      </div>
    </div>
  );
}

export default function SessionAIPanel({ session, timelineRows, emgRows = [], userProfile, sessionJournal, mode = "companion", onAnalysisSaved }) {
  const isTechnical = mode === "technical";
  const analysisField = isTechnical ? "ai_session_deep_dive" : "ai_analysis";
  const analysisLabel = isTechnical ? "AI Session Technical Deep Dive" : "AI Session Analysis";
  const analysisTitle = isTechnical ? "Technical Session Deep Dive" : "AI Session Analysis";
  const [collapsed, setCollapsed] = useState(true);
  const [loading, setLoading] = useState(false);
  const [jobStatus, setJobStatus] = useState(null);
  const [result, setResult] = useState(repairAITextBlocks(session[analysisField] ?? null));
  const [error, setError] = useState("");
  const resultStale = isSessionAIContentStale(result, session);

  useEffect(() => {
    setResult(repairAITextBlocks(session[analysisField] ?? null));
  }, [analysisField, session]);

  useEffect(() => {
    let cancelled = false;

    const reconnect = async () => {
      try {
        const data = await listBackgroundJobs({
          type: "ai_invoke",
          status: "queued,running,complete",
          metaSessionId: session.id,
          limit: 4,
        });
        if (cancelled) return;
        const job = (data.jobs || []).find((item) => item.meta?.label === analysisLabel);
        if (!job) return;
        if (job.status === "complete" && !isNewerCompletedJob(job, result || session[analysisField])) return;

        setCollapsed(false);
        setJobStatus(job);
        setLoading(job.status !== "complete");

        const completedJob = job.status === "complete"
          ? job
          : await waitForBackgroundJob(job.id, {
            intervalMs: 1200,
            onProgress: (nextJob) => {
              if (!cancelled) setJobStatus(nextJob);
            },
          });
        if (cancelled) return;
        if (!isNewerCompletedJob(completedJob, result || session[analysisField])) return;

        const parsed = normalizeSessionAnalysis(completedJob.result);
        const storedResult = {
          ...parsed,
          _meta: buildSessionAIContentMeta(session, (result || session[analysisField])?._meta, completedAt(completedJob)),
        };
        setResult(storedResult);
        setJobStatus({
          ...completedJob,
          progress: {
            ...(completedJob.progress || {}),
            phase: "saving",
            current: 3,
            total: 3,
            message: "Recovered complete analysis; saving it back to the session…",
          },
        });
        await base44.entities.Session.update(session.id, { [analysisField]: storedResult });
        onAnalysisSaved?.(analysisField, storedResult);
      } catch (err) {
        if (!cancelled) {
          console.warn(`${analysisLabel} reconnect skipped:`, err);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    reconnect();
    return () => {
      cancelled = true;
    };
  }, [analysisField, analysisLabel, onAnalysisSaved, result, session, session.id]);

  const analyze = async () => {
    setLoading(true);
    setError("");
    setCollapsed(false);
    setJobStatus({
      status: "starting",
      progress: {
        phase: "building",
        current: 0,
        total: 3,
        message: "Building session context, HR timeline, event notes, and profile grounding…",
      },
    });

    try {

    // Build EMG summary for AI
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
        // Detect clipping
        const leftClipPct = leftPcts.length ? Math.round((leftPcts.filter((v) => v >= 99).length / leftPcts.length) * 100) : 0;
        const rightClipPct = rightPcts.length ? Math.round((rightPcts.filter((v) => v >= 99).length / rightPcts.length) * 100) : 0;
        // Trajectory (sampled as "time_s:pct" pairs)
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
            rest_l: session.emg_rest_left,
            max_l: session.emg_max_left,
            rest_r: session.emg_rest_right,
            max_r: session.emg_max_right,
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
          calibration: {
            rest: session.emg_rest_left,
            max: session.emg_max_left,
            calibration_notes: session.emg_calibration_notes,
          },
          placement_notes: session.emg_left_placement_notes,
          general_notes: session.emg_general_notes,
          placement_photo_tags: (session.emg_placement_photos || []).map((p) => `${p.tag}: ${p.caption}`).filter(Boolean),
        };
      }
    })();

    const estimScreenshots = [
      ...(session.estim_screenshots || []),
      ...(session.estim_screenshot && !(session.estim_screenshots?.includes(session.estim_screenshot)) ? [session.estim_screenshot] : []),
    ].filter(Boolean);

    const hrSummary = timelineRows.length > 0 ? {
      total_points: timelineRows.length,
      duration_s: Math.round(Math.max(...timelineRows.map(r => Number(r.time_offset_s) || 0))),
      hr_min: Math.round(Math.min(...timelineRows.map(r => Number(r.hr)))),
      hr_avg: Math.round(timelineRows.reduce((sum, row) => sum + Number(row.hr), 0) / timelineRows.length),
      hr_max: Math.round(Math.max(...timelineRows.map(r => Number(r.hr)))),
    } : null;

    // Sample HR trajectory for the prompt (~1 point every 15s)
    const hrTrajectory = (() => {
      if (!timelineRows.length) return null;
      const step = Math.max(1, Math.floor(timelineRows.length / 60));
      return timelineRows
        .filter((_, i) => i % step === 0)
        .map(r => `${Math.round(Number(r.time_offset_s))}s:${Math.round(Number(r.hr))}`)
        .join("  ");
    })();

    // Build a sorted HR lookup from timeline rows for nearest-HR matching
    const sortedRows = [...timelineRows].sort((a, b) => Number(a.time_offset_s) - Number(b.time_offset_s));
    const nearestHR = (time_s) => {
      if (!sortedRows.length) return null;
      let best = sortedRows[0];
      let bestDist = Math.abs(Number(sortedRows[0].time_offset_s) - time_s);
      for (const r of sortedRows) {
        const d = Math.abs(Number(r.time_offset_s) - time_s);
        if (d < bestDist) { bestDist = d; best = r; }
        if (Number(r.time_offset_s) > time_s + 10) break; // past the window, stop early
      }
      return Math.round(Number(best.hr));
    };

    const formatTimeWords = (seconds) => {
      const m = Math.floor(seconds / 60);
      const s = Math.round(seconds % 60);
      if (m === 0) return `${s} second${s !== 1 ? 's' : ''}`;
      if (s === 0) return `${m} minute${m !== 1 ? 's' : ''}`;
      return `${m} minute${m !== 1 ? 's' : ''} and ${s} second${s !== 1 ? 's' : ''}`;
    };

    const eventTimeline = (session.event_timeline || []).map(e => {
      const timeWords = formatTimeWords(e.time_s);
      const hr = nearestHR(e.time_s);
      const categories = Array.isArray(e.category) ? e.category : [e.category].filter(Boolean);
      const categoryLabels = categories.map((category) => getCategoryMeta(category).label).join(", ") || "Other";
      const provenance = e.source === "motion_derived" ? "motion-derived observation" : "manual observation";
      const relToClimax = session.climax_offset_s != null ? Math.round(e.time_s - session.climax_offset_s) : null;
      const relStr = relToClimax != null ? ` (${formatTimeWords(Math.abs(relToClimax))} ${relToClimax >= 0 ? 'after' : 'before'} climax)` : "";
      return `[${categoryLabels}; ${provenance}] at ${timeWords}${relStr} — ${e.note}${hr != null ? ` (heart rate: ${hr} beats per minute)` : ''}`;
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

Use this arousal profile to personalize analysis: compare the observed build arc and climax pattern against the user's known response style. Note deviations (e.g. faster/slower than typical, more/less sensitive). Reference preferred methods when interpreting session effectiveness.` : "";

    const groundingContext = buildAIGroundingContext(userProfile);
    const firstNameToneCue = !isTechnical ? buildOptionalFirstNameToneCue(userProfile) : "";
    const structuredSessionContext = structuredSessionContextForAI(session);
    const warmMotionEvidence = buildWarmMotionEvidence(session);

    const journalContext = sessionJournal ? `

SESSION JOURNAL (person's own reflections after this session — treat as first-person subjective data):
Emotional reflection: ${sessionJournal.emotional_reflection || ""}
Physiological observations: ${sessionJournal.physiological_observations || ""}
Experience narrative: ${sessionJournal.experience_narrative || ""}
Insights: ${sessionJournal.insights || ""}
Next session intentions: ${sessionJournal.next_session_intentions || ""}
${sessionJournal.key_moments?.length ? `Key moments noted: ${sessionJournal.key_moments.join("; ")}` : ""}

Factor the journal into your analysis — where the person's subjective experience aligns with or diverges from the objective physiological data is especially worth noting.` : "";

    const aiPayload = {
      model: "claude_sonnet_4_6",
      ...(isTechnical ? { max_tokens: 12000 } : {}),
      ...(!isTechnical ? {
        temperature: 0.5,
        schema_mode: "base44_parity",
      } : {}),
      ...(estimScreenshots.length > 0 ? { file_urls: estimScreenshots } : {}),
      prompt: `${isTechnical
        ? `You are an expert physiologist and anatomist specializing in sexual response, body-state interpretation, and careful review of intimate physiology data. Analyze this session as a rich, cohesive physiological story. Integrate session intent, arousal or exploration context, anatomy, heart rate data, stimulation or body-mapping technique, event notes, motion evidence when present, and subjective experience. Write directly to the person — use "you" and "your" throughout, as if speaking to them personally.

TARGET SESSION ANALYSIS STYLE:
- Begin with a substantial overview that synthesizes the session's outcome, heart-rate arc, stimulation context, notable physiology, and why the session behaved the way it did.
- Then explain the session through meaningful physiological windows based on session intent: baseline/entry state, exploration or stimulation phase, sensory/body-state transitions, plateaus or settling, pre-climax when supported, climax or intentionally non-climax outcome, and recovery or end-state.
- A window may be chronological when chronology explains the physiology. The point is not to avoid time; the point is to make each time window explain arousal state, autonomic loading, sensory input, technique effectiveness, or recovery.
- Keep the older PulsePoint feel: detailed, insightful, physiology-forward, personally grounded, and useful for later comparison across sessions.
- Do not flatten the analysis into generic observations or a short summary. This is a deep session interpretation.`
        : `You are an expert physiologist and anatomist specializing in sexual response, body-state interpretation, and careful review of intimate physiology data. Analyze this session by first identifying whether it is primarily masturbation/stimulation, body exploration, sensation mapping, recovery review, or mixed. Integrate anatomy, heart rate data, event timeline, motion evidence when present, subjective experience, and session intent into a cohesive narrative. Write directly to the person — use "you" and "your" throughout, as if speaking to them personally. Keep this natural, clinically grounded, and never forced. Let the narration feel warmly attentive and quietly familiar with the person's established patterns, noticing what stands out with natural human interest while staying grounded in the provided evidence.`}

${isTechnical ? groundingContext : ""}
${!isTechnical ? SESSION_CONTEXT_GROUNDING_RULE : ""}
${AI_SESSION_TYPE_GROUNDING_V1}
${BODY_STATE_INTERPRETIVE_STYLE_V1}
${warmMotionEvidence}
${PERSONALIZED_ANATOMY_OUTPUT_RULE}
${firstNameToneCue}
${!isTechnical ? WARM_COMPANION_OUTPUT_DISCIPLINE : ""}

PHYSIOLOGICAL & ANATOMICAL LENS${isTechnical ? ":" : " — CONDITIONAL USE ONLY:"}
- Only mention specific physiological phases (e.g. emission, expulsion, plateau) or anatomical structures (e.g. pudendal nerve, bulbocavernosus, prostatic urethra) when the session data — an event note, HR pattern, subjective metric, or logged sensation — gives you a concrete reason to do so. Never insert these as generic background explanation.
${isTechnical
  ? "- Interpret HR trajectory as a real-time window into sympathetic/parasympathetic balance — but only narrate a mechanism if the HR data actually shows it (e.g. a clear spike, an unexpected plateau, a slow recovery)."
  : "- Interpret HR trajectory as a real-time window into sympathetic/parasympathetic balance — but only narrate a mechanism if the HR data actually shows it (e.g. a clear spike, an unexpected plateau, a slow recovery)."}
${isTechnical
  ? `- Preserve the explanatory "why" as the center of the answer. When stimulation changes, heart-rate movement, physical cues, or subjective metrics line up, explain the likely mechanism behind the pattern instead of merely restating that it happened.
- Discuss stimulation-to-body links when supported: how pressure, friction, suction, vibration, e-stim, foley/urethral input, perineal contact, or technique shifts likely changed sensory input, pelvic floor tone, autonomic loading, or climax threshold.
- Preserve timeline awareness without becoming a transcript. Use time windows, HR ranges, plateaus, marker timing, and major transitions when they clarify the physiology. Do not list every note in order unless each one changes the interpretation.
- When the data allows more than one explanation, state the most plausible possibilities without inventing certainty. For example, a HR change after a technique shift may reflect sensory novelty, increased stimulation efficiency, pelvic floor recruitment, breath/position change, or sympathetic loading depending on the notes around it.`
  : ""}
- If foley or urethral stimulation is logged, discuss urethral sensory dynamics — but only in terms of what actually happened (logged sensations, HR response, notes). Skip if there's nothing to connect it to.
- If e-stim is present, discuss fiber recruitment and frequency effects only if the e-stim notes or settings screenshots give you something specific to work with.
- Connect subjective sensations (pressure, throb, tightness, wave) to anatomical generators ONLY if the user actually logged those sensations.
- When figures from saved session summaries and sampled timeline calculations differ, use the directly computed timeline figure for timeline interpretation and explicitly state that a stored summary differs or may reflect rounding. Never silently cite conflicting heart-rate maxima or averages.
- Interpret discomfort anatomically ONLY if discomfort entries are present.
- The goal is ${isTechnical
  ? "a tight, evidence-driven explanation of what happened and why it likely happened. Every anatomical or physiological claim must be traceable to a specific data point in the session, but do not omit relevant physiology when the data supports it."
  : "a tight, evidence-driven analysis of what actually happened — not a physiology lecture. Every anatomical or physiological claim must be traceable to a specific data point in the session."}
${emgSummary ? `
EMG INTERPRETATION RULES — apply carefully:
- EMG % is NORMALIZED RELATIVE ACTIVATION, NOT absolute force. Never claim EMG % equals muscle force.
- Left/right comparisons are only valid when each channel was independently calibrated.
- If placement differs between sides, note that asymmetry may reflect placement differences, not true muscle asymmetry.
- Clipping (100%) means timing data is useful but high-end intensity detail is compressed — recommend raising max calibration or lowering gain.
- One flat/noisy channel suggests sensor dropout, poor contact, or cross-talk — call this out.
- If diff_pct is near zero during high activity, describe bilateral symmetry.
- If one side rises earlier, describe it as a lead/phase difference.
- If EMG peaks precede HR rise, describe EMG leading the HR response.
- If HR rises without EMG change, note this as a possible autonomic or non-muscular response.
- Describe the likely target muscle based on placement notes and photo tags when available.` : ""}

CRITICAL FOR TEXT-TO-SPEECH QUALITY:
- Write all times as words: "ten minutes and thirty seconds" not "10:30"
- Spell out all numbers as words (e.g., "ten beats per minute" not "10 bpm")
- Write in conversational, sentence-based prose with natural pauses
- Use short sentences and simple grammar optimized for audio readability
- Avoid dense jargon — explain anatomical concepts briefly but accessibly
- Use commas and periods to create natural speech cadence
${arousalProfile}${estimScreenshots.length > 0 ? `

E-STIM SCREENSHOTS ATTACHED (${estimScreenshots.length}): Analyze the waveform types, frequencies, pulse widths, and channel configurations. Interpret how these settings recruited sensory vs motor fibers, shaped smooth muscle tone, and drove the arousal arc through the session.` : ""}${eventTimeline.length > 0 ? `

SESSION EVENT TIMELINE (with heart rate at each moment):
${eventTimeline.join('\n')}

${isTechnical
  ? `This is evidence for the physiological arc. Do not write a note-by-note transcript. Use the timeline to identify major transitions, clusters, body findings, stimulation shifts, phase markers, and recovery cues, then explain how those details connect to the HR trajectory and subjective outcome.

Use time references when they anchor the arc, but each time reference should answer "what changed and why might it matter?" Connect stimulation changes, physical findings, HR movement, and subjective context into mechanism-level interpretation. If a technique shift appears to change arousal, explain the plausible sensory/autonomic reason. If HR rises, plateaus, or drops, explain what that likely says about sympathetic load, parasympathetic settling, pelvic floor engagement, sensory novelty, stimulation efficiency, or recovery state.

The best output should feel like: "Here is what was happening in the body during this phase, here is why this stimulation/body cue mattered, and here is how it shaped the next phase" — not "at this timestamp, then at this timestamp."`
  : `This is primary evidence for the single Chronological Deep Dive. Group closely related events into meaningful body-state transitions rather than narrating every note separately. At each major transition, explain what the body appears to be doing and why that matters. Reserve movement telemetry synthesis, recurring patterns, hypotheses, and recommendations for their dedicated sections; do not retell this timeline there.`}` : ""}

${hrTrajectory ? `HR TRAJECTORY (time_s:bpm, sampled):
${hrTrajectory}

Use this to trace sympathetic activation patterns, body-state transitions, exploratory response, arousal plateaus when relevant, and correlation between HR changes and event timing. For non-climax body exploration sessions, HR still matters: use it to describe autonomic response, settling, activation, comfort/discomfort, or positional/sensory response rather than looking for a climax arc.` : ""}

Session data:
${JSON.stringify({
  date: session.date ? (() => {
    const d = new Date(session.date);
    return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,"0")}-${String(d.getDate()).padStart(2,"0")}`;
  })() : undefined,
  time_of_day: session.start_time ? (() => {
    const h = parseInt(session.start_time.split(":")[0], 10);
    if (h >= 5 && h < 12) return "morning";
    if (h >= 12 && h < 17) return "afternoon";
    if (h >= 17 && h < 21) return "evening";
    return "night";
  })() : undefined,
  duration_minutes: session.duration_minutes,
  intensity: session.intensity,
  satisfaction: session.satisfaction,
  build_quality: session.build_quality,
  ...(isTechnical ? {
    release_completeness: session.release_completeness,
    arousal_depth: session.arousal_depth,
    erection_stability: session.erection_stability,
    stimulation_fit: session.stimulation_fit,
    edge_control_quality: session.control,
    sensory_immersion: session.sensory_immersion,
    recovery_quality: session.recovery_quality,
    discomfort_interruption_impact: session.discomfort_interference,
    primary_limiting_factor: session.primary_limiting_factor,
    subjective_notes: session.subjective_notes,
  } : {}),
  build_type: session.build_type,
  climax_duration: session.climax_duration,
  mood: session.mood,
  environment: session.environment,
  methods: session.methods,
  foley_size: session.foley_size,
  foley_type: session.foley_type,
  estim_notes: session.estim_notes,
  ejaculate_volume: session.ejaculate_volume,
  hydration: session.hydration,
  substances: session.substances,
  ...(!isTechnical && structuredSessionContext ? { session_context: structuredSessionContext } : {}),
  discomfort_entries: session.discomfort_entries?.length > 0 ? session.discomfort_entries : undefined,
  unusual_sensations: session.unusual_sensations,
  refractory_notes: session.refractory_notes,
  notes: session.notes,
  hr: hrSummary ? {
    timeline_derived_avg: hrSummary.hr_avg,
    timeline_derived_max: hrSummary.hr_max,
    timeline_derived_min: hrSummary.hr_min,
    hr_at_climax: session.hr_at_climax,
    ...(session.avg_hr != null && Number(session.avg_hr) !== hrSummary.hr_avg ? { stored_summary_avg: session.avg_hr } : {}),
    ...(session.max_hr != null && Number(session.max_hr) !== hrSummary.hr_max ? { stored_summary_max: session.max_hr } : {}),
  } : undefined,
  phase_markers_s: {
    pre_climax: session.pre_climax_offset_s,
    climax: session.climax_offset_s,
    recovery: session.recovery_offset_s,
  },
}, null, 2)}

${session.discomfort_entries?.length > 0 ? "Discomfort entries present — analyze each for likely anatomical cause (nerve, tissue, positional), severity context, and whether it disrupted the arousal arc." : ""}
${emgSummary ? `\nEMG DATA:\n${JSON.stringify(emgSummary, null, 2)}\n\nAnalyze EMG activation patterns alongside HR. Reference timing relationships between EMG and HR changes. Check for clipping, asymmetry, noise, and relate activation bursts to event markers and phase markers when present. Describe what muscle the sensor likely captures based on placement notes and target area.` : ""}
${journalContext}

Provide ${isTechnical
  ? "a rich, physiologically-grounded analysis that tells the story of this session — from the autonomic and anatomical level up to the subjective experience. It should be detailed enough to explain the HR arc, phase shifts, stimulation effectiveness, distinctive sensations, and recovery pattern, while remaining smooth enough for text-to-speech narration."
  : "a rich, physiologically-grounded analysis that tells the story of this session — from the autonomic and anatomical level up to the subjective experience."}`,
      response_json_schema: {
        type: "object",
        properties: {
          summary: isTechnical
            ? { type: "string", description: "One cohesive overview emphasizing physiology, arousal pattern, stimulation effectiveness, and why the session behaved the way it did." }
            : { type: "string", description: "Executive Summary: a rich but concise overview of the session arc and defining findings, without retelling the full chronology." },
          arousal_arc: isTechnical
            ? { type: "array", items: { type: "string" }, description: "Several detailed phase/window paragraphs explaining the HR/autonomic arc, exploration or stimulation links, supported anatomy, body-state transitions, pre-climax/climax/recovery shifts when present, and why the session progressed as it did." }
            : { type: "array", items: { type: "string" }, description: "Chronological Deep Dive: the only detailed ordered pass through the session arc; group related events into meaningful body-state transitions and explain what the body appears to be doing at those moments." },
          event_analysis: isTechnical
            ? { type: "array", items: { type: "string" }, description: "Several interpretive paragraphs about major event clusters, phase markers, distinctive sensations/findings, HR-supported turning points, and what made the session notable. Use time anchors when they strengthen the interpretation." }
            : { type: "array", items: { type: "string" }, description: "Motion Telemetry Interpretation and evidence synthesis: interpret asymmetry, cadence proxy, movement patterns, and evidence discrepancies without replaying the chronology." },
          emg_analysis: { type: "array", items: { type: "string" }, description: "EMG signal quality, activation patterns, L/R comparison, EMG vs HR, calibration notes — only if EMG data present" },
          notable_findings: isTechnical
            ? { type: "array", items: { type: "string" } }
            : { type: "array", items: { type: "string" }, description: "Pattern recognition, cross-session context when supported, and clearly labelled hypotheses with calibrated mechanism language." },
          recommendations: isTechnical
            ? { type: "array", items: { type: "string" } }
            : { type: "array", items: { type: "string" }, description: "Focused recommendations or experiments grounded in supported findings rather than repeated narrative." },
        },
        required: ["summary", "arousal_arc", "event_analysis", "notable_findings", "recommendations"],
      },
      label: analysisLabel,
    };

    setJobStatus({
      status: "starting",
      progress: {
        phase: "queueing",
        current: 0,
        total: 3,
        message: "Sending analysis to the background queue so it can continue outside the active tab…",
      },
    });
    const startedJob = await startBackgroundJob("ai_invoke", aiPayload, {
      sessionId: session.id,
      label: analysisLabel,
    });
    setJobStatus(startedJob);
    const completedJob = await waitForBackgroundJob(startedJob.id, {
      intervalMs: 1200,
      onProgress: setJobStatus,
    });

    const parsed = normalizeSessionAnalysis(completedJob.result);
    const storedResult = {
      ...parsed,
      _meta: buildSessionAIContentMeta(session, session[analysisField]?._meta, completedAt(completedJob)),
    };
    setResult(storedResult);
    setJobStatus({
      ...completedJob,
      progress: {
        ...(completedJob.progress || {}),
        phase: "saving",
        current: 3,
        total: 3,
        message: "Saving analysis to the session…",
      },
    });
    await base44.entities.Session.update(session.id, { [analysisField]: storedResult });
    onAnalysisSaved?.(analysisField, storedResult);
    } catch (err) {
      console.error(`${analysisLabel} failed:`, err);
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
            <Brain className="w-4 h-4" /> {analysisTitle}
          </h3>
          {collapsed ? <ChevronDown className="w-4 h-4 text-muted-foreground ml-1" /> : <ChevronUp className="w-4 h-4 text-muted-foreground ml-1" />}
        </button>
        <Button size="sm" onClick={analyze} disabled={loading} className="h-7 text-xs gap-1.5">
          {loading
            ? <><span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />Working…</>
            : <><Brain className="w-3 h-3" />Analyze</>}
        </Button>
      </div>

      {!collapsed && loading && <AnalysisStatus job={jobStatus} />}

      {!collapsed && !result && !loading && (
        <p className="text-xs text-muted-foreground">
          {isTechnical
            ? "Click Analyze for the newer deeper technical pass across physiology, timeline structure, and session turning points. Uses Claude Sonnet."
            : "Click Analyze to generate the original warm AI physiological session analysis. Uses Claude Sonnet."}
        </p>
      )}

      {!collapsed && error && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {!collapsed && result && (() => {
        // Support both old schema (hr_analysis/phase_analysis) and new schema (arousal_arc/event_analysis)
        const arousalItems = result.arousal_arc || result.phase_analysis || [];
        const eventItems = result.event_analysis || result.hr_analysis || [];
        const emgItems = result.emg_analysis || [];

        const paras = [
          result.summary,
          ...arousalItems,
          ...eventItems,
          ...emgItems,
          ...(result.notable_findings || []),
          ...(result.recommendations || []),
        ]
          .filter(Boolean)
          .map(repairCharacterSplitParagraph);

        // Build a flat index → section label map for rendering
        let idx = 0;
        const sections = [];
        if (result.summary) sections.push({ label: null, color: "primary", items: [result.summary], start: idx++ });
        if (arousalItems.length) { sections.push({ label: isTechnical ? "Arousal Arc" : "Chronological Deep Dive", color: "chart-2", icon: <TrendingUp className="w-3.5 h-3.5" />, items: arousalItems, start: idx }); idx += arousalItems.length; }
        if (eventItems.length) { sections.push({ label: isTechnical ? "Event Analysis" : "Motion & Evidence Interpretation", color: "chart-1", icon: <Activity className="w-3.5 h-3.5" />, items: eventItems, start: idx }); idx += eventItems.length; }
        if (emgItems.length) { sections.push({ label: "EMG Analysis", color: "chart-3", icon: <Activity className="w-3.5 h-3.5" />, items: emgItems, start: idx }); idx += emgItems.length; }
        if (result.notable_findings?.length) { sections.push({ label: isTechnical ? "Notable Findings" : "Patterns & Hypotheses", color: "chart-4", icon: <Zap className="w-3.5 h-3.5" />, items: result.notable_findings, start: idx }); idx += result.notable_findings.length; }
        if (result.recommendations?.length) { sections.push({ label: isTechnical ? "Recommendations" : "Recommendations & Experiments", color: "accent", icon: <Lightbulb className="w-3.5 h-3.5" />, items: result.recommendations, start: idx }); }

        return (
          <div className="space-y-3">
            <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
              <span>
                {result?._meta?.last_generated_at
                  ? `Generated ${formatGeneratedAt(result._meta.last_generated_at)}`
                  : "Generated time unavailable"}
              </span>
              {resultStale && (
                <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 font-semibold text-amber-300">
                  May be stale - newer saved evidence exists
                </span>
              )}
            </div>
            <TTSReader
              sessionId={session.id}
              title={analysisTitle}
              sessionDate={session.date}
              sourceGeneratedAt={result?._meta?.last_generated_at}
              paragraphs={paras}
              renderParagraph={(text, paraIdx, isActive, isBuffering) => {
              // Find which section this paragraph belongs to
              let section = sections[0];
              for (const sec of sections) {
                if (paraIdx >= sec.start) section = sec;
              }
              const isSummary = section.label === null;
              if (isSummary) {
                return (
                  <p className={`text-base font-medium leading-relaxed border-l-2 pl-3 py-1 transition-all duration-200 rounded-r-md flex items-center gap-2 ${isActive ? "border-primary bg-primary/8 text-foreground" : isBuffering ? "border-primary/60 bg-primary/5 text-foreground" : "border-primary/50 text-foreground"}`}>
                    {isBuffering && <span className="shrink-0 w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />}
                    {text}
                  </p>
                );
              }
              return (
                <li className={`text-base leading-relaxed pl-3 border-l-2 py-1 transition-all duration-200 rounded-r-md list-none flex items-center gap-2 ${isActive ? "border-primary bg-primary/8 text-foreground font-medium" : isBuffering ? "border-primary/60 bg-primary/5 text-foreground" : "border-primary/30 text-foreground"}`}>
                  {isBuffering && <span className="shrink-0 w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" />}
                  {text}
                </li>
              );
              }}
            />
          </div>
        );
      })()}
    </div>
  );
}
