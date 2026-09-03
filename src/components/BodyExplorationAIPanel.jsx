import { useEffect, useState } from "react";
import { Activity, AlertCircle, Brain, Lightbulb, ScanSearch, ShieldCheck } from "lucide-react";
import { Button } from "@/components/ui/button";
import { base44 } from "@/api/base44Client";
import { buildAIGroundingContext, PERSONALIZED_ANATOMY_OUTPUT_RULE } from "@/lib/aiGrounding";
import { buildSarahPersonalityPrompt, readSarahPersonalitySettings } from "@/utils/sarahPersonality";
import {
  INTEGRATED_HEAD_TO_TOE_RULE,
  NO_CLIPBOARD_CLUTCHING_RULE,
  removeMedicalReferralAndWarningLanguage,
  UNMIRRORED_ANATOMICAL_LATERALITY_RULE,
  VISUAL_TELEMETRY_SEPARATION_RULE,
} from "@/lib/analysisOutputRules";
import { pulseOxReadingsFromSession } from "@/lib/sessionContext";
import { buildBodyExplorationPhysiologyEvidence } from "@/lib/bodyExplorationPhysiology";
import { buildBodyExplorationVideoPassDigest, buildBodyExplorationVisualEvidenceDigest } from "@/lib/visualEvidence";
import AIOutputReader from "./AIOutputReader";
import { EVENT_CATEGORIES, EXPLORATION_EVENT_CATEGORIES } from "./session-form/EventTimelineSection";
import { buildGenericAIContentMeta, formatGeneratedAt, getAIContentGeneratedAt } from "@/utils/aiContentMetadata";
import { SessionReviewVideoExportButton, reviewVideoTitleWithDate } from "./SessionAIPanel";
import { recoverCompletedAIJob, startRecoverableAIJob, waitForRecoverableAIJob } from "@/lib/recoverableAIJobs";
import { friendlyJobErrorMessage } from "@/lib/jobErrorMessages";
import { formatSecondsAsWords, repairNumericElapsedTimeReferences } from "@/utils/aiTextRepair";
import { buildBodyExplorationReaderContent } from "@/lib/bodyExplorationNarrative";
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
  { key: "comfort_safety_findings", label: "Comfort & Body Response", icon: <ShieldCheck className="h-3.5 w-3.5" />, color: "hsl(var(--chart-3))" },
  { key: "recommendations", label: "What This Adds", icon: <Lightbulb className="h-3.5 w-3.5" />, color: "hsl(var(--chart-4))" },
];

const DEEP_SECTION_DEFS = [
  { key: "integrated_physiology", label: "Integrated Physiology", icon: <Activity className="h-3.5 w-3.5" />, color: "hsl(var(--chart-2))" },
  { key: "mechanical_sensory_synthesis", label: "Mechanical & Sensory Synthesis", icon: <ScanSearch className="h-3.5 w-3.5" />, color: "hsl(var(--primary))" },
  { key: "user_sarah_findings", label: "Head-to-Toe Body Response", icon: <Brain className="h-3.5 w-3.5" />, color: "hsl(var(--chart-3))" },
  { key: "outcome_comparison", label: "Outcome & Comparison", icon: <ShieldCheck className="h-3.5 w-3.5" />, color: "hsl(var(--chart-4))" },
  { key: "recommendations", label: "What This Adds", icon: <Lightbulb className="h-3.5 w-3.5" />, color: "hsl(var(--chart-4))" },
];

const FOCUSED_SECTION_ICONS = {
  procedural_course: <ScanSearch className="h-3.5 w-3.5" />,
  clinical_interpretation: <Brain className="h-3.5 w-3.5" />,
  body_response_felt_experience: <Activity className="h-3.5 w-3.5" />,
  placement_confidence: <ShieldCheck className="h-3.5 w-3.5" />,
  prior_comparison: <ScanSearch className="h-3.5 w-3.5" />,
  focused_follow_up: <Lightbulb className="h-3.5 w-3.5" />,
};

function sectionDefsForResult(result, { focusedFoley = false } = {}) {
  if (focusedFoley) {
    return FOCUSED_FOLEY_SECTION_DEFS.map((section) => ({
      ...section,
      icon: FOCUSED_SECTION_ICONS[section.key] || <ScanSearch className="h-3.5 w-3.5" />,
      color: "hsl(var(--primary))",
    }));
  }
  if (Array.isArray(result?.integrated_physiology)) return DEEP_SECTION_DEFS;
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

const DEEP_BODY_EXPLORATION_SYNTHESIS_RULE = `
DEEP BODY EXPLORATION SYNTHESIS - HIGH PRIORITY:
- Treat this exploration as a rich physiological record, not a list of timestamped actions. Chronology is an evidence index, not the report structure.
- At least sixty percent of the analysis should explain physiological response, cross-signal relationships, visible body response, sensory-mechanical interpretation, and recovery. Routine procedural chronology should occupy no more than twenty percent.
- Compress repeated fill, clamp, reposition, retention, leakage, contraction, and release cycles into three to five response phases. Do not reproduce the event log with prose wrapped around every timestamp.
- Select no more than six major elapsed-time anchors across the entire report unless an additional time is essential to distinguish conflicting evidence. A paragraph may discuss a sustained window without reciting every event inside it.
- Every substantive paragraph should integrate at least two evidence streams when available: the person's first-person notes or interview findings, reviewed visual findings, heart rate, quality-gated RR/HRV, respiration, motion/position, EMG, blood pressure, blood glucose, pulse oximetry, body composition/weight, or procedural mechanics.
- Explain what changed, the evidence supporting it, the most plausible physiological or mechanical interpretation, what remains uncertain, and why the pattern matters in this person's record.
- Give the person's observations and Sarah's reviewed findings real analytical weight. Identify where they converge, where one adds information the other could not supply, and where subjective intensity differs from measured load. Do not create a repetitive two-column recap.
- Use the full trajectory. Discuss sustained phases, transitions, repeated responses, recovery, and relationships across streams. Do not elevate a single extreme sample into the main conclusion.
- HRV discipline: a sustained quality-gated RR pattern may support discussion of parasympathetic modulation. A single very high RMSSD value or abrupt one-bin jump may be artifact, ectopy, movement, or transient irregularity; describe it as a candidate signal unless surrounding RR quality and adjacent windows support it. Do not call one RMSSD spike proof of a vagal reflex.
- Separate observation from mechanism. Use language such as "supports", "may reflect", or "is physiologically compatible with" when causation is not established.
- Prefer synthesis over repetition. A timestamp belongs only when it anchors a major transition or a cross-stream relationship.
- Visual evidence is not decoration. Use it only for something the reviewed frames or clips actually establish: regional or generalized skin/tissue change, posture or arching, abdominal contour change, bracing/release, breathing, tremor or spasm-like movement, leg or foot response, positioning, equipment contact, visible genital/perineal state, leakage/expulsion, or recovery behavior. Do not describe internal depth, sigmoid entry, retained volume, intraluminal pressure, sphincter tone, bladder causation, or autonomic mechanism as visually confirmed.
- Use an elapsed window in the same sentence for the small number of major visual/procedural anchors selected for the report. Do not attach a timestamp to every supporting visual detail; consolidate related observations into the anchored body-state phase.
- If no reviewed visual window supports a claim, keep it explicitly as a user report, telemetry interpretation, or cautious inference and do not imply Sarah saw it.
- A single extreme RMSSD bin must not be called a vagal reflex or a parasympathetic opening. First inspect adjacent RR quality and sustained behavior; otherwise label it a candidate transient or artifact-sensitive observation.
- Do not call an elevated heart-rate or blood-pressure response benign, non-pathological, expected, or free of cardiovascular strain unless the available record genuinely supports that conclusion. Describe the measured load and uncertainty instead.
- Do not recommend escalating insertion depth, pressure, retention hardware, catheterization, or other invasive technique. Keep follow-up focused on measurement quality, safer workflow, equipment integrity, comfort, and what would clarify the physiology next time.
`;

const BODY_EXPLORATION_VIDEO_ALIGNMENT_RULE = `
BODY EXPLORATION REVIEW-VIDEO EVIDENCE CONTRACT - MANDATORY:
- Select no more than six visually demonstrable actions or body-state transitions as review-video anchors, each with its exact elapsed time or short elapsed window. Supporting details within the same phase do not each need another timestamp.
- Keep the words describing an anchored action next to its time citation. Do not place a timestamp in one paragraph and the corresponding anchor several paragraphs later.
- One sentence should describe one visual concept or one tightly linked response window. Do not combine condom-catheter placement, enema insertion, leakage, leg trembling, accessory retrieval, and defecation in one sentence.
- Never use a visually unrelated moment merely because it is dramatic. The editor must show the cited source interval for the action being described.
- Untimed whole-session physiology may be narrated over continuous footage from the most recently matched evidence window. It must not trigger a jump to an unrelated event.
- Oxygen saturation, blood pressure, blood glucose, body composition, and similar measurements are telemetry unless the sentence explicitly describes a visible measurement action or device readout. A telemetry-only statement does not require matching device footage and may be omitted when it does not add useful physiological context.
- If a visual claim cannot be tied to a reviewed or logged source interval, omit the visual claim from narration rather than inviting substitute footage.
`;

const ELAPSED_TIME_OUTPUT_RULE = `
ELAPSED SESSION TIME - MANDATORY:
- All event offsets are elapsed session time, never times of day.
- Write offsets explicitly as "twelve minutes and twenty-six seconds elapsed" or "from thirty-three minutes and twenty seconds through thirty-five minutes and two seconds elapsed".
- Never output session offsets as 12:26, 33:20, "twelve twenty-six", or similar clock-style wording.
- A true clock time may be written as a time of day only when it includes AM or PM and clearly refers to when the session began.
`;

const TTS_FRIENDLY_STRUCTURE_RULE = `
TTS-FRIENDLY BODY EXPLORATION STRUCTURE - MANDATORY:
- Every schema field already maps to a visible and spoken section heading. Return only complete prose paragraphs inside schema fields.
- Never embed a heading, caption, phase label, time-range label, markdown heading, bullet, numbered list, or label followed by a colon inside a paragraph.
- Use medium-length sentences with natural transitions and punctuation. Break apart dense multi-clause sentences before returning them.
- Write units in natural spoken form: milliliters, milligrams per deciliter, millimeters of mercury, milliseconds, beats per minute, and percent. Do not use cc, mL, mg/dL, mmHg, bpm, slash-form blood pressure, or symbol-heavy shorthand in the returned prose.
- Keep elapsed anchors readable aloud. Use a small number of exact anchors such as "at twelve minutes and twenty-six seconds elapsed"; do not put long start-to-end ranges in parentheses.
- Do not repeat the section heading in the first sentence. The interface presents and speaks the heading separately.
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
  const hasDeepStructure = parsed?.summary
    && parsed?.integrated_physiology?.length
    && parsed?.mechanical_sensory_synthesis?.length
    && parsed?.user_sarah_findings?.length;
  const hasLegacyStructure = parsed?.summary && parsed?.telemetry_findings?.length && parsed?.mechanical_findings?.length;
  if (!hasDeepStructure && !hasLegacyStructure) {
    throw new Error("AI returned an incomplete body exploration analysis. Please try again.");
  }
  return cleanupProductionAnalysis(parsed);
}

function cleanupProductionText(value) {
  const cleaned = repairNumericElapsedTimeReferences(String(value || ""))
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
    .replace(/\b(\d+(?:\.\d+)?)\s*(?:mL|ml|cc)\b/g, "$1 milliliters")
    .replace(/\b(\d+(?:\.\d+)?)\s*bpm\b/gi, "$1 beats per minute")
    .replace(/\b(\d{2,3})\s*\/\s*(\d{2,3})\s*(?:mm\s*hg|mmhg)?\b/gi, "$1 over $2 millimeters of mercury")
    .replace(/\bmg\s*\/\s*d[lL]\b/g, "milligrams per deciliter")
    .replace(/\bmm\s*hg\b/gi, "millimeters of mercury")
    .replace(/\s+/g, " ")
    .trim();
  return removeMedicalReferralAndWarningLanguage(cleaned);
}

function cleanupProductionAnalysis(analysis) {
  const cleanArray = (rows) => (Array.isArray(rows) ? rows.map(cleanupProductionText).filter(Boolean) : []);
  return {
    ...analysis,
    summary: cleanupProductionText(analysis.summary),
    integrated_physiology: cleanArray(analysis.integrated_physiology),
    mechanical_sensory_synthesis: cleanArray(analysis.mechanical_sensory_synthesis),
    user_sarah_findings: cleanArray(analysis.user_sarah_findings),
    outcome_comparison: cleanArray(analysis.outcome_comparison),
    telemetry_findings: cleanArray(analysis.telemetry_findings),
    mechanical_findings: cleanArray(analysis.mechanical_findings),
    comfort_safety_findings: cleanArray(analysis.comfort_safety_findings),
    recommendations: cleanArray(analysis.recommendations)
      .filter((line) => !/\bvideo review|visual ambiguity|mislabeled landmark|future video\b/i.test(line)),
  };
}

export default function BodyExplorationAIPanel({ exploration, timelineRows, emgRows, nearbyVitals, userProfile }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(exploration.ai_body_exploration || null);
  const [error, setError] = useState("");
  const generatedAt = getAIContentGeneratedAt(result);
  const jobKey = `body-exploration-analysis:${exploration.id}`;
  const focusedFoley = isFocusedFoleyExploration(exploration);
  const savedCloudPass = (Array.isArray(exploration?.ai_body_exploration?.cloud_multimodal_passes)
    ? exploration.ai_body_exploration.cloud_multimodal_passes
    : []).find((entry) => entry?.result?.ok);
  const savedCloudVisualWindows = Array.isArray(savedCloudPass?.result?.multimodal_windows)
    ? savedCloudPass.result.multimodal_windows.length
    : Number(savedCloudPass?.result?.visual_summary?.semantic_windows || 0);
  const savedCloudAudioCues = Number(savedCloudPass?.result?.audio_summary?.reviewable_acoustic_candidates || 0);

  const attachAnalysisMeta = (analysis, previousAnalysis) => {
    const next = {
      ...(previousAnalysis || {}),
      ...analysis,
      _meta: buildGenericAIContentMeta(previousAnalysis?._meta, null, {
        source_exploration_updated_at: exploration.updated_date || exploration.updated_at || exploration.modified_date || null,
        source_event_count: Array.isArray(exploration.event_timeline) ? exploration.event_timeline.length : 0,
        source_hr_row_count: Array.isArray(timelineRows) ? timelineRows.length : 0,
        source_emg_row_count: Array.isArray(emgRows) ? emgRows.length : 0,
        source_nearby_vital_count: ["bloodPressure", "bloodGlucose", "bodyComposition", "pulseOx"]
          .reduce((sum, key) => sum + (Array.isArray(nearbyVitals?.[key]) ? nearbyVitals[key].length : 0), 0),
      }),
    };
    if (!focusedFoley && next?._focus?.mode === "foley_insertion") {
      delete next._focus;
      delete next._debug_provenance;
    }
    return next;
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
        return `[elapsed ${formatSecondsAsWords(event.time_s)}] ${labels || "Observation"} - ${event.note}${hr != null ? ` [heart rate ${Math.round(Number(hr))} beats per minute]` : ""}`;
      });
      const groundingContext = buildAIGroundingContext(userProfile, { includeProfile: !focusedFoley });
      const focusedProfileContext = focusedFoley ? buildFocusedFoleyProfileContext(userProfile) : "";
      const visualEvidenceContext = buildBodyExplorationVisualEvidenceDigest(exploration);
      const videoPassEvidenceContext = buildBodyExplorationVideoPassDigest(exploration);
      const physiologyEvidence = buildBodyExplorationPhysiologyEvidence({ exploration, timelineRows, emgRows, nearbyVitals });
      const responseSchema = focusedFoley ? focusedFoleyResponseSchema() : {
        type: "object",
        properties: {
          summary: { type: "string" },
          integrated_physiology: { type: "array", items: { type: "string" }, description: "Four to six substantive synthesis paragraphs. This is the majority of the report. Integrate full-trajectory heart rate, quality-gated RR/HRV, respiration, motion, EMG, blood pressure, glucose, SpO2, baseline context, load, and recovery where available. Explain relationships, provenance, and uncertainty; do not list metrics or events." },
          mechanical_sensory_synthesis: { type: "array", items: { type: "string" }, description: "Three to five substantive phase-based paragraphs connecting mechanics, position, verified visible whole-body response, comfort, and first-person sensation. Include regional skin/tissue change, posture or arching, bracing/release, breathing, tremor/spasm-like movement, genital/perineal response, and lower-body response when supported. Compress repeated cycles instead of narrating each action." },
          user_sarah_findings: { type: "array", items: { type: "string" }, description: "Six to ten substantive paragraphs forming the core systematic head-to-toe review. In stable order cover every visible region: face/jaw; neck/shoulders; arms/hands; chest/breathing; abdomen/trunk and arching; pelvis/perineum; genital/tissue state; thighs/legs; ankles/feet/toes; then coordinated whole-body state. Describe baseline-to-change-to-peak-to-resolution patterns and meaningful pertinent negatives. Explicitly distinguish no sampled visible response from anatomy that was obscured or not reviewed. Use only a few elapsed-time anchors for major transitions; do not timestamp every claim. Keep telemetry out of direct visual descriptions, then correlate separately where useful." },
          outcome_comparison: { type: "array", items: { type: "string" }, description: "One to three paragraphs explaining immediate outcome and cautious comparison with prior explorations when supported." },
          recommendations: { type: "array", items: { type: "string" }, description: "Two to four evidence-grounded takeaways, useful comparisons, or data-quality improvements. Never include medical warnings, care escalation, testing advice, or physician/clinician referral." },
        },
        required: ["summary", "integrated_physiology", "mechanical_sensory_synthesis", "user_sarah_findings", "outcome_comparison", "recommendations"],
      };
      const aiPayload = {
        model: "claude_sonnet_4_6",
        max_tokens: 10000,
        prompt: `You are a warm, careful physiological analyst reviewing a BODY EXPLORATION / INSTRUMENTATION record.

This record is not a climax-oriented masturbation session. Do not force pre-climax, climax, ejaculation, recovery, arousal-score, or orgasm framing onto it unless the person explicitly logged relevant language in the exploration record.

PRIMARY ANALYSIS GOAL:
${focusedFoley
  ? "Reconstruct this Foley/instrumentation procedure by meaningful anatomical and mechanical landmarks, then explain the body response and placement evidence."
  : "Develop an integrated, in-depth account of what this exploration revealed about your physiology, mechanics, sensation, and immediate outcome. Use the event sequence as supporting structure, not as the product."}

EVIDENCE PRECEDENCE AND CONFLICT RULES:
- Timestamped manual/user event notes are the procedural timeline of record for stage order and timing.
- Video-pass evidence is visual evidence. Use it to support or refine the manual timeline; do not let a shaky visual label silently move a step earlier or later.
- If visual evidence conflicts with a manual note, resolve the sequence internally and anchor timing to the manual note unless current-frame evidence directly establishes otherwise.
- Do not describe a preparation, insertion, fill, removal, bodily response, or outcome before the first manual note or reviewed evidence supporting it.
- Resolve evidence conflicts internally. The final answer should not contain process language such as "video-pass labels", "possible visual/timeline mismatch", "timeline of record anchors", "not directly documented", or "correction"; it should present the corrected procedural story cleanly.
- Assume visible hands are your hands unless another participant is clearly visible or explicitly logged as assisting. Do not introduce another person, helper, clinician, operator, or assistant from hands alone. Prefer "your hand" or "your hands"; use "your gloved hand" only when glove/sterile technique is the relevant point.

${focusedFoley ? `FOLEY PROCEDURAL TRACKING RULE:
- Track meaningful landmarks when supported: setup and sterile field, foreskin/glans/meatal prep, lubrication or urethral instillation, meatal engagement, urethral passage, sphincter resistance or relaxation, bladder entry or urine return, balloon inflation/seating, securement/alignment, dwell comfort, removal, and post-procedure state.
- Treat prep/swabbing as its own stage. Do not merge it into advancement unless reviewed evidence separately shows a catheter or sound entering the meatus.
- Prefer concrete observations such as catheter type/size, orientation, depth progression, resistance point, urine return, balloon seat, securement slack, meatal tension, leakage, tissue state, body response, and tolerance.` : `BODY EXPLORATION TRACKING RULE:
- Organize the record into a small number of meaningful physiological windows: entry/baseline state, major mechanical or sensory transitions, peak-load windows, release or resolution, and immediate recovery when present.
- For enema or rectal exploration, distinguish filling/distension, clamp or flow changes, position, leakage or expulsion, retention effort, cramping/contractions, defecation/release, urinary response, and recovery only when supported. Synthesize repeated cycles instead of narrating every clamp movement.
- For other exploration types, choose equivalent windows based on the actual method and the person's stated purpose.
- In each selected window, connect first-person sensation, visible/logged mechanics, and the measured physiology. State meaningful disagreement or uncertainty without turning the report into an evidence audit.`}
- When telemetry is available, compare heart-rate changes around landmarks rather than only giving session min/avg/max. Explain whether a visible/logged step produced a rise, plateau, dip, or no measurable response. If only whole-session telemetry exists, say it cannot be tied to landmarks.
- Use the full measured physiology evidence provided below: heart rate, RR intervals, quality-gated HRV, respiration when usable, motion/position when usable, multimodal state, recovery drops, response latency, EMG channels, attached or nearby pulse oximetry, blood pressure, blood glucose, and body composition/weight.
- The adaptive trajectory preserves up to roughly two hundred forty time bins across the complete record. Use it to identify sustained changes, transitions, and recovery instead of relying only on min/average/max.
- Include a substantive baseline-and-trends interpretation. Treat the first recorded window as an entry-state reference, not proof of a true resting baseline, then compare it with the middle, peak-load, release/end, and recovery windows using every quality-gated signal available.
- Nearby vital imports are contextual measurements with exact time distance and source. Include them when they help interpret the body state, but never imply the exploration caused a reading merely because it was nearby.
- Respect provenance and quality gates. Do not interpret unavailable respiration/motion, zero placeholder values, or low/unavailable HRV as physiology. Smart-scale composition values are trends, while weight is a measured contextual value.
- When prior comparison context is relevant, keep it secondary and specific to the current exploration's method, body response, comfort, and outcome.
- The best output should be evidence-dense but readable: integrated, physiologically substantive, mechanically precise, personal, and cautious about uncertainty.

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
${UNMIRRORED_ANATOMICAL_LATERALITY_RULE}
${PRODUCTION_BODY_EXPLORATION_STYLE}
${SARAH_LANGUAGE_VARIETY_RULE}
${ELAPSED_TIME_OUTPUT_RULE}
${TTS_FRIENDLY_STRUCTURE_RULE}
${DEEP_BODY_EXPLORATION_SYNTHESIS_RULE}
${BODY_EXPLORATION_VIDEO_ALIGNMENT_RULE}
${INTEGRATED_HEAD_TO_TOE_RULE}
${VISUAL_TELEMETRY_SEPARATION_RULE}
${NO_CLIPBOARD_CLUTCHING_RULE}
${focusedFoley ? focusedFoleyPromptBlock() : ""}
${buildSarahPersonalityPrompt(readSarahPersonalitySettings())}

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
  attached_pulse_oximetry_samples: pulseOxReadingsFromSession(exploration).length,
  high_definition_physiology: physiologyEvidence,
  reviewed_visual_evidence: visualEvidenceContext || null,
  reviewed_video_pass_evidence: videoPassEvidenceContext || null,
}, null, 2)}

${events.length ? `RAW TIMESTAMPED NOTES - EVIDENCE INDEX ONLY; DO NOT USE THIS LIST AS THE REPORT OUTLINE:\n${events.join("\n")}` : "No timestamped notes were recorded."}`,
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

  const displayResult = result ? cleanupProductionAnalysis(result) : null;
  const activeSectionDefs = sectionDefsForResult(displayResult, { focusedFoley });
  const { paragraphs, paragraphMeta } = buildBodyExplorationReaderContent(displayResult, activeSectionDefs);
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
          {(savedCloudVisualWindows > 0 || savedCloudAudioCues > 0) && (
            <p className="mt-1 text-[11px] text-cyan-200">
              Enhanced evidence available: {savedCloudVisualWindows} cloud visual window{savedCloudVisualWindows === 1 ? "" : "s"} · {savedCloudAudioCues} audio cue{savedCloudAudioCues === 1 ? "" : "s"}
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
