import { useEffect, useState } from "react";
import { Activity, AlertCircle, Brain, Lightbulb, ScanSearch, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { base44 } from "@/api/base44Client";
import { buildAIGroundingContext, PERSONALIZED_ANATOMY_OUTPUT_RULE } from "@/lib/aiGrounding";
import { pulseOxReadingsFromSession } from "@/lib/sessionContext";
import { buildBodyExplorationVideoPassDigest, buildBodyExplorationVisualEvidenceDigest } from "@/lib/visualEvidence";
import AIOutputReader from "./AIOutputReader";
import { EVENT_CATEGORIES, EXPLORATION_EVENT_CATEGORIES } from "./session-form/EventTimelineSection";
import { buildGenericAIContentMeta, formatGeneratedAt, getAIContentGeneratedAt } from "@/utils/aiContentMetadata";
import { SessionReviewVideoExportButton, reviewVideoTitleWithDate } from "./SessionAIPanel";
import { recoverCompletedAIJob, startRecoverableAIJob, waitForRecoverableAIJob } from "@/lib/recoverableAIJobs";
import { friendlyJobErrorMessage } from "@/lib/jobErrorMessages";
import {
  FOCUSED_FOLEY_SECTION_DEFS,
  buildFocusedFoleyProfileContext,
  focusedFoleyPromptBlock,
  focusedFoleyResponseSchema,
  isFocusedFoleyExploration,
  normalizeFocusedFoleyAnalysis,
} from "@/lib/bodyExplorationFocus";

const SECTION_DEFS = [
  { key: "telemetry_findings", label: "Telemetry Findings", icon: <Activity className="h-3.5 w-3.5" />, color: "hsl(var(--chart-2))" },
  { key: "mechanical_findings", label: "Mechanical Findings", icon: <ScanSearch className="h-3.5 w-3.5" />, color: "hsl(var(--primary))" },
  { key: "comfort_safety_findings", label: "Comfort & Safety", icon: <ShieldCheck className="h-3.5 w-3.5" />, color: "hsl(var(--chart-3))" },
  { key: "recommendations", label: "Review Notes", icon: <Lightbulb className="h-3.5 w-3.5" />, color: "hsl(var(--chart-4))" },
];

const FOCUSED_SECTION_ICONS = {
  procedural_course: <ScanSearch className="h-3.5 w-3.5" />,
  clinical_interpretation: <Brain className="h-3.5 w-3.5" />,
  body_response_felt_experience: <Activity className="h-3.5 w-3.5" />,
  placement_confidence: <ShieldCheck className="h-3.5 w-3.5" />,
  prior_comparison: <ScanSearch className="h-3.5 w-3.5" />,
  focused_follow_up: <Lightbulb className="h-3.5 w-3.5" />,
};

function sectionDefsForResult(result) {
  if (result?._focus?.mode === "foley_insertion") {
    return FOCUSED_FOLEY_SECTION_DEFS.map((section) => ({
      ...section,
      icon: FOCUSED_SECTION_ICONS[section.key] || <ScanSearch className="h-3.5 w-3.5" />,
      color: "hsl(var(--primary))",
    }));
  }
  return SECTION_DEFS;
}

const ANATOMICAL_LATERALITY_RULE = `
ANATOMICAL LEFT/RIGHT DISCIPLINE:
- "Your left" and "your right" must mean Ben's anatomical left/right, not the viewer's screen-left/screen-right.
- When you are facing the camera, your anatomical right appears on the viewer's left. In foot-of-table, overhead, supine, mirrored, rotated, composite, or cropped views, left/right can be ambiguous.
- Preserve anatomical identity across poses and camera angles. A bruise, mole, scar, catheter/tubing position, pelvic finding, genital finding, or skin mark on your anatomical right remains right-sided when you move from supine to standing, turn toward the camera, rotate, or appear in another crop or camera lane.
- Track stable landmarks such as your umbilicus, sternum, pubic mound, inguinal creases, thighs, known scars, moles, bruises, catheter exit angle, and manual side notes before assigning side.
- Do not convert screen position into anatomical laterality unless body landmarks, tracking labels, manual notes, or source metadata clearly establish orientation.
- If laterality is uncertain, say "screen-left", "screen-right", "near/far", "upper/lower", "one hand/the other hand", or "one leg/the other leg" instead of anatomical left/right.
- Apply this to body exploration, Foley/procedure review, head-to-toe assessments, lower-body/foot findings, hand/tool descriptions, posture/asymmetry comments, and any visual evidence imported from Sarah video-pass cards.
`;

const PRODUCTION_BODY_EXPLORATION_STYLE = `
PRODUCTION-FACING BODY EXPLORATION STYLE:
- Write for a viewer-facing review, not an internal QA audit. Do not narrate "corrections", "timeline mismatch", "video-pass conflict", "not directly documented", "not visible", "could not confirm", "visual ambiguity", or "future video reviews" unless the uncertainty is safety-critical.
- Use the resolved procedural sequence in a clean way. If a video-pass card conflicts with timestamped manual notes, silently use the manual notes as the timeline of record and omit the conflict/correction language from the final analysis.
- Do not bore viewers with repeated evidence limitations. Preserve accuracy by omitting unsupported details rather than explaining every unsupported detail.
- Keep the analysis detailed, but make the flow feel like a confident procedural narration: what you did, how your body responded, what the catheter/device mechanics were, and what was physiologically useful.
- Visible hands are your hands. Say "your hand" or "your hands". Use "your gloved hand" only when the glove itself matters to sterile technique. Never write "a gloved hand", "the gloved hand", "operator", "operator's hand", "clinician", "assistant", or "the person".
- Do not infer povidone-iodine or antiseptic staining from natural penile/glans color, lighting, shadow, camera white balance, or warm tissue tone. Only call visible iodine/staining when the swab/applicator or manual note places iodine at that exact stage.
- For this Foley insertion pattern, if the manual notes say draping happened before swabbing, then both swabbing passes occur after draping. Do not write that staining or swabbing preceded draping because of amber-looking tissue tone in an earlier frame.
- If there were two swabbing passes, describe them as two passes total. Do not invent an initial prep pass before draping plus two later passes.
`;

const SARAH_LANGUAGE_VARIETY_RULE = `
SARAH LANGUAGE VARIETY RULE:
- Do not make "consistent with", "consistent", or "consistently" your default evidence phrase. In the full analysis, use this word family at most once unless quoting a saved source or preserving a user quote.
- Prefer direct procedural and physiological narration: "matches", "aligns with", "supports", "fits with", "helps explain", "tracks with", "remains stable", "holds steady", "repeats across", "points toward", or simply state the observation.
- Before returning final output, scan for repeated phrasing and rewrite any extra "consistent" constructions into natural viewer-facing language.
`;

function categoryLabel(value) {
  return [...EVENT_CATEGORIES, ...EXPLORATION_EVENT_CATEGORIES].find((item) => item.value === value)?.label || String(value || "Other");
}

function aiErrorMessage(error) {
  return friendlyJobErrorMessage(error, { preserveContext: false }) || "Analysis failed";
}

function normalizeAnalysis(raw, { focusedFoley = false } = {}) {
  if (focusedFoley) return normalizeFocusedFoleyAnalysis(raw);
  const parsed = raw?.response ?? raw;
  if (!parsed?.summary || !parsed?.telemetry_findings?.length || !parsed?.mechanical_findings?.length) {
    throw new Error("AI returned an incomplete body exploration analysis. Please try again.");
  }
  return cleanupProductionAnalysis(parsed);
}

function cleanupProductionText(value) {
  return String(value || "")
    .replace(/\b(?:a|the)\s+gloved\s+hand\b/gi, "your hand")
    .replace(/\b(?:a|the)\s+gloved\s+hands\b/gi, "your hands")
    .replace(/\bone\s+gloved\s+hand\b/gi, "one hand")
    .replace(/\bthe\s+other\s+gloved\s+hand\b/gi, "the other hand")
    .replace(/\boperator'?s?\s+hand\b/gi, "your hand")
    .replace(/\boperator\b/gi, "you")
    .replace(/\bthe video-pass (?:confirms|labels|shows|suggests)\b/gi, "the reviewed video shows")
    .replace(/\bpossible visual\/timeline mismatch worth flagging:?/gi, "")
    .replace(/\bvisual\/timeline mismatch\b/gi, "sequence detail")
    .replace(/\bthe procedural timeline of record anchors this as\b/gi, "this is")
    .replace(/\btimestamped notes clearly place\b/gi, "your notes place")
    .replace(/\bnot directly documented in this record\b/gi, "handled outside the reviewed camera view")
    .replace(/\bFor future video reviews,[^.]*\.\s*/gi, "")
    .replace(/\s+/g, " ")
    .trim();
}

function cleanupProductionAnalysis(analysis) {
  const cleanArray = (rows) => (Array.isArray(rows) ? rows.map(cleanupProductionText).filter(Boolean) : []);
  return {
    ...analysis,
    summary: cleanupProductionText(analysis.summary),
    telemetry_findings: cleanArray(analysis.telemetry_findings),
    mechanical_findings: cleanArray(analysis.mechanical_findings),
    comfort_safety_findings: cleanArray(analysis.comfort_safety_findings),
    recommendations: cleanArray(analysis.recommendations)
      .filter((line) => !/\bvideo review|visual ambiguity|mislabeled landmark|future video\b/i.test(line)),
  };
}

function telemetrySummary(rows, exploration) {
  if (!rows.length) return null;
  const hrs = rows.map((row) => Number(row.hr)).filter(Number.isFinite);
  const duration = Math.max(...rows.map((row) => Number(row.time_offset_s) || 0));
  return {
    total_points: rows.length,
    duration_s: Math.round(duration),
    hr_min: hrs.length ? Math.round(Math.min(...hrs)) : null,
    hr_max: hrs.length ? Math.round(Math.max(...hrs)) : exploration.max_hr || null,
    hr_avg: exploration.avg_hr || null,
  };
}

function pulseOxSummary(exploration) {
  const readings = pulseOxReadingsFromSession(exploration);
  if (!readings.length) return null;
  const spo2Values = readings.map((reading) => Number(reading.spo2_percent)).filter(Number.isFinite);
  const pulseValues = readings.map((reading) => Number(reading.pulse_bpm)).filter(Number.isFinite);
  return {
    total_points: readings.length,
    spo2_latest_percent: readings[readings.length - 1]?.spo2_percent ?? null,
    spo2_average_percent: Math.round(spo2Values.reduce((sum, value) => sum + value, 0) / spo2Values.length),
    spo2_minimum_percent: Math.min(...spo2Values),
    pulse_average_bpm: pulseValues.length
      ? Math.round(pulseValues.reduce((sum, value) => sum + value, 0) / pulseValues.length)
      : null,
    source: readings.find((reading) => reading.source_app || reading.source_device)?.source_app
      || readings.find((reading) => reading.source_device)?.source_device
      || null,
  };
}

export default function BodyExplorationAIPanel({ exploration, timelineRows, emgRows, userProfile }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(exploration.ai_body_exploration || null);
  const [error, setError] = useState("");
  const generatedAt = getAIContentGeneratedAt(result);
  const jobKey = `body-exploration-analysis:${exploration.id}`;
  const focusedFoley = isFocusedFoleyExploration(exploration);

  const attachAnalysisMeta = (analysis, previousAnalysis) => {
    return {
      ...(previousAnalysis || {}),
      ...analysis,
      _meta: buildGenericAIContentMeta(previousAnalysis?._meta, null, {
        source_exploration_updated_at: exploration.updated_date || exploration.updated_at || exploration.modified_date || null,
        source_event_count: Array.isArray(exploration.event_timeline) ? exploration.event_timeline.length : 0,
        source_hr_row_count: Array.isArray(timelineRows) ? timelineRows.length : 0,
        source_emg_row_count: Array.isArray(emgRows) ? emgRows.length : 0,
      }),
    };
  };

  const persistAnalysisResult = async (raw) => {
    const previousAnalysis = exploration.ai_body_exploration || result;
    const parsed = attachAnalysisMeta(normalizeAnalysis(raw, { focusedFoley }), previousAnalysis);
    setResult(parsed);
    await base44.entities.BodyExploration.update(exploration.id, { ai_body_exploration: parsed });
    return parsed;
  };

  useEffect(() => {
    let cancelled = false;
    const recover = async () => {
      try {
        const job = await recoverCompletedAIJob(jobKey);
        if (!job || cancelled) return;
        if (job.status === "complete" && job.result) {
          setLoading(true);
          await persistAnalysisResult(job.result);
          if (!cancelled) setError("");
        } else if (job.status === "running" || job.status === "queued") {
          if (!cancelled) setLoading(true);
          const completed = await waitForRecoverableAIJob(jobKey, job.id, { intervalMs: 1800 });
          if (!cancelled) {
            await persistAnalysisResult(completed.result);
            setError("");
          }
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

  const analyze = async () => {
    setLoading(true);
    setError("");
    try {
      const sortedRows = [...timelineRows].sort((a, b) => Number(a.time_offset_s) - Number(b.time_offset_s));
      const nearestHr = (timeS) => {
        if (!sortedRows.length) return null;
        return sortedRows.reduce((best, row) => {
          const dist = Math.abs(Number(row.time_offset_s) - Number(timeS || 0));
          return dist < best.dist ? { dist, row } : best;
        }, { dist: Number.POSITIVE_INFINITY, row: sortedRows[0] }).row?.hr;
      };
      const events = (exploration.event_timeline || []).map((event) => {
        const labels = (Array.isArray(event.category) ? event.category : [event.category].filter(Boolean))
          .map(categoryLabel)
          .join("+");
        const hr = nearestHr(event.time_s);
        return `[${Math.floor(Number(event.time_s || 0) / 60)}:${String(Math.round(Number(event.time_s || 0) % 60)).padStart(2, "0")}] ${labels || "Observation"} - ${event.note}${hr != null ? ` [heart rate ${Math.round(Number(hr))} beats per minute]` : ""}`;
      });
      const groundingContext = buildAIGroundingContext(userProfile, { includeProfile: !focusedFoley });
      const focusedProfileContext = focusedFoley ? buildFocusedFoleyProfileContext(userProfile) : "";
      const visualEvidenceContext = buildBodyExplorationVisualEvidenceDigest(exploration);
      const videoPassEvidenceContext = buildBodyExplorationVideoPassDigest(exploration);
      const responseSchema = focusedFoley ? focusedFoleyResponseSchema() : {
        type: "object",
        properties: {
          summary: { type: "string" },
          telemetry_findings: { type: "array", items: { type: "string" }, description: "Landmark/window-specific HR or EMG interpretation where possible; do not merely list min/avg/max." },
          mechanical_findings: { type: "array", items: { type: "string" }, description: "Procedure mechanics by visible/logged landmark: prep, lubrication, meatal engagement, urethral passage, sphincters, bladder entry/urine return, balloon, securement, dwell/removal when supported." },
          comfort_safety_findings: { type: "array", items: { type: "string" }, description: "Comfort, sterile/safety controls, tissue state, irritation/lack of irritation, tension, dwell tolerance, uncertainty, and risk-control observations." },
          recommendations: { type: "array", items: { type: "string" }, description: "Focused review notes or future documentation gaps grounded in the procedure evidence, phrased without pressure." },
        },
        required: ["summary", "telemetry_findings", "mechanical_findings", "comfort_safety_findings", "recommendations"],
      };
      const aiPayload = {
        model: "claude_sonnet_4_6",
        max_tokens: 10000,
        prompt: `You are a warm, careful physiological analyst reviewing a BODY EXPLORATION / INSTRUMENTATION record.

This record is not a climax-oriented masturbation session. Do not force pre-climax, climax, ejaculation, recovery, arousal-score, or orgasm framing onto it unless the person explicitly logged relevant language in the exploration record.

PRIMARY ANALYSIS GOAL:
Reconstruct the procedural arc from the best available evidence. This should feel like a careful Foley/instrumentation review, not a generic session summary. When reviewed video-pass evidence exists, use it as the highest-priority evidence for visible timing, device/tool handling, body position, tissue state, and procedure mechanics. Use notes/profile context to explain what the visual evidence and telemetry mean, but do not let broad history replace the procedural tracking.

EVIDENCE PRECEDENCE AND CONFLICT RULES:
- Timestamped manual/user event notes are the procedural timeline of record for stage order and timing.
- Video-pass evidence is visual evidence. Use it to support, refine, or flag uncertainty around the manual timeline; do not let a shaky video-pass label silently move a procedure step earlier or later.
- If video-pass evidence appears to conflict with a manual note, explicitly describe it as a possible visual/timeline mismatch and anchor the procedural sequence to the manual note unless current-frame evidence directly proves otherwise.
- Do not describe povidone-iodine, lubricant, Foley-at-meatus contact, insertion, urine return, balloon fill, securement, or cleanup before the first manual note or current-frame evidence that supports that specific item/action.
- Resolve evidence conflicts internally. The final answer should not contain process language such as "video-pass labels", "possible visual/timeline mismatch", "timeline of record anchors", "not directly documented", or "correction"; it should present the corrected procedural story cleanly.
- Assume visible hands are your hands unless another participant is clearly visible or explicitly logged as assisting. Do not introduce another person, helper, clinician, operator, or assistant from hands alone. Prefer "your hand" or "your hands"; use "your gloved hand" only when glove/sterile technique is the relevant point.

PROCEDURAL TRACKING RULE:
- For Foley insertion, urethral sounding, dilation, or similar instrumentation, track the session by landmark/window when evidence supports it: setup and sterile field, foreskin/glans/meatal prep, lubrication or urethral instillation, meatal engagement, spongy urethral passage, external sphincter resistance or relaxation, prostatic/internal sphincter passage, bladder entry or urine return, balloon inflation/seating, securement/alignment, dwell comfort, removal or post-procedure state.
- Treat prep/swabbing as its own meaningful procedural stage. If video-pass evidence describes circular swabbing, applicator contact, surface wiping, antiseptic painting, glans/meatal prep, or cleaning/mapping around the meatus, preserve that as prep. Do not merge it into catheter advancement or insertion unless the reviewed evidence separately shows a catheter/sound entering or moving through the meatus.
- In each relevant landmark, identify what was directly visible, what was logged by timestamped note, what telemetry did, and what remains uncertain.
- Prefer concrete observations like catheter type/size, orientation, insertion depth progression, rotation maneuver, resistance point, urine bypass/return, balloon volume/seat, securement slack, meatal tension, tissue color, lubricant leakage, scrotal/foreskin state, leg/foot/body response, and comfort/tolerance cues.
- If a landmark is not visually reviewed or not timestamped, say that limitation instead of smoothing over it. Do not invent a complete procedural sequence from profile history alone.
- When telemetry is available, compare heart-rate changes around landmarks rather than only giving session min/avg/max. Explain whether a visible/logged step produced a rise, plateau, dip, or no measurable response. If only whole-session telemetry exists, say it cannot be tied to landmarks.
- When prior comparison context is relevant, keep it secondary and specific: use it to explain how this insertion differs in size, lubrication, substance context, resistance, comfort, urine return, securement, or dwell tolerance. Do not turn the review into a broad longitudinal Foley biography.
- The best output should resemble a procedural evidence review: timeline-aware, landmark-specific, visibly grounded, mechanically precise, and cautious about uncertainty.

Focus on:
- what the body and telemetry did during exploration or instrumentation
- comfort, discomfort, tolerance, and repeated observed findings
- device interaction, fit, pressure, movement, or positioning when logged
- useful next-review notes grounded in the actual record

${groundingContext}
${focusedProfileContext}
${visualEvidenceContext}
${videoPassEvidenceContext}
${PERSONALIZED_ANATOMY_OUTPUT_RULE}
${ANATOMICAL_LATERALITY_RULE}
${PRODUCTION_BODY_EXPLORATION_STYLE}
${SARAH_LANGUAGE_VARIETY_RULE}
${focusedFoley ? focusedFoleyPromptBlock() : ""}

STYLE:
- Write directly to the person using "you" and "your".
- Never use "subject", "operator", "patient", "participant", "the person", "the user", "the user's", "a gloved hand", or "the gloved hand". Prefer "you", "your notes", "your hand", "your hands", or "your gloved hand" only when glove/sterile technique matters.
- Keep the tone useful, calm, personalized, and data-grounded.
- Use paragraphs that read naturally aloud.
- Spell out measurements and numbers in natural spoken prose where practical.
- Do not invent anatomy, mechanisms, intent, goals, risk, or findings not present in the record.
- Do not collapse reviewed video evidence into a high-level summary. Preserve useful procedural landmarks, frame/window timing, and evidence hierarchy in the final sections.

BODY EXPLORATION RECORD:
${JSON.stringify({
  date: exploration.date?.slice(0, 10),
  start_time: exploration.start_time,
  duration_minutes: exploration.duration_minutes,
  exploration_type: exploration.exploration_type,
  methods: exploration.methods,
  focus_areas: exploration.focus_areas,
  purpose: exploration.purpose,
  devices: exploration.devices,
  foley_size: exploration.foley_size,
  foley_type: exploration.foley_type,
  sounding_notes: exploration.sounding_notes,
  comfort_notes: exploration.comfort_notes,
  findings: exploration.findings,
  notes: exploration.notes,
  unusual_sensations: exploration.unusual_sensations,
  tags: exploration.tags,
  body_composition: exploration.body_composition
    ? {
      ...exploration.body_composition,
      interpretation_rule: "Contextual smart-scale trend estimate only; do not claim an acute exploration effect.",
    }
    : null,
  heart_rate: telemetrySummary(timelineRows, exploration),
  pulse_oximetry: pulseOxSummary(exploration),
  emg_rows: emgRows.length,
  reviewed_visual_evidence: visualEvidenceContext || null,
  reviewed_video_pass_evidence: videoPassEvidenceContext || null,
}, null, 2)}

${events.length ? `TIMESTAMPED NOTES:\n${events.join("\n")}` : "No timestamped notes were recorded."}`,
        response_json_schema: responseSchema,
      };
      const job = await startRecoverableAIJob(jobKey, aiPayload, {
        title: "Body Exploration AI analysis",
        label: "Body Exploration AI analysis",
        source: "body_exploration_analysis",
        recordType: "body_exploration",
        sessionId: exploration.id,
        route: `/exploration/${encodeURIComponent(exploration.id)}#exploration-ai-analysis`,
      });
      const completed = await waitForRecoverableAIJob(jobKey, job.id, {
        intervalMs: 1800,
      });
      await persistAnalysisResult(completed.result);
    } catch (err) {
      setError(aiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const activeSectionDefs = sectionDefsForResult(result);
  const paragraphs = result
    ? [result.summary, ...activeSectionDefs.flatMap((section) => result[section.key] || [])].filter(Boolean)
    : [];
  const paragraphMeta = result
    ? [{ type: "summary" }, ...activeSectionDefs.flatMap((section) => (result[section.key] || []).map(() => ({ type: "section", section })))]
    : [];
  const reviewVideoTitle = reviewVideoTitleWithDate("AI Body Exploration Analysis", exploration);

  return (
    <div id="exploration-ai-analysis" className="scroll-mt-24 rounded-xl border border-border bg-card p-4 space-y-3">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h3 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-primary">
            <Brain className="h-4 w-4" /> AI Body Exploration Analysis
          </h3>
          {!result && <p className="mt-1 text-xs text-muted-foreground">Useful feedback and findings for exploration, instrumentation, telemetry, and comfort observations.</p>}
          {result && (
            <p className="mt-1 text-[11px] text-muted-foreground">
              {generatedAt ? `Generated ${formatGeneratedAt(generatedAt)}` : "Generated time unavailable"}
            </p>
          )}
        </div>
        <Button size="sm" onClick={analyze} disabled={loading} className="h-8 gap-1.5 text-xs">
          {loading ? <><span className="h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />Analyzing</> : <><Brain className="h-3 w-3" />{result ? "Re-analyze" : "Analyze"}</>}
        </Button>
      </div>
      {error && (
        <div className="flex gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
          <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>{error}</span>
        </div>
      )}
      {result && (
        <>
          <div id="exploration-ai-video" className="scroll-mt-24">
            <SessionReviewVideoExportButton
              session={exploration}
              analysisTitle={reviewVideoTitle}
              sourceGeneratedAt={generatedAt}
              paragraphs={paragraphs}
              paragraphMeta={paragraphMeta}
              recordType="body_exploration"
            />
          </div>
          <AIOutputReader
            sessionId={`body-exploration-${exploration.id}`}
            title="AI Body Exploration Analysis"
            sessionDate={exploration.date}
            sourceGeneratedAt={generatedAt}
            paragraphs={paragraphs}
            paragraphMeta={paragraphMeta}
          />
        </>
      )}
    </div>
  );
}
