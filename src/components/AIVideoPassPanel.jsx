import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ChevronUp, Clapperboard, Loader2, Mic, Play, Sparkles, Trash2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { base44 } from "@/api/base44Client";
import { listBackgroundJobs, startBackgroundJob, waitForBackgroundJob } from "@/lib/backgroundJobs";
import { sessionContextEvidenceText } from "@/lib/sessionContext";
import { EXPLORATION_EVENT_CATEGORIES } from "@/components/session-form/EventTimelineSection";
import {
  buildBodyExplorationVideoPassDigest,
  buildSessionVideoPassDigest,
  normalizeBodyExplorationVideoPassFindings,
  normalizeSessionVideoPassFindings,
} from "@/lib/visualEvidence";

function fmtMmSs(totalSeconds) {
  const v = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const m = Math.floor(v / 60);
  const s = v % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtSignedMmSs(totalSeconds) {
  const value = Number(totalSeconds) || 0;
  return `${value < 0 ? "-" : ""}${fmtMmSs(Math.abs(value))}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function timelineOffsetSeconds(video) {
  return Number(video?.timelineOffsetSeconds) || 0;
}

function sourceTimeForSession(sessionSeconds, video) {
  return Math.max(0, Number(sessionSeconds || 0) - timelineOffsetSeconds(video));
}

function sessionTimeForSource(sourceSeconds, video) {
  return Math.max(0, Number(sourceSeconds || 0) + timelineOffsetSeconds(video));
}

function estimateSessionEnd(session, timelineRows = []) {
  const candidates = [
    session?.duration_s,
    session?.duration_seconds,
    session?.recording_duration_s,
    session?.end_offset_s,
    session?.recovery_offset_s ? Number(session.recovery_offset_s) + 120 : null,
    session?.climax_offset_s ? Number(session.climax_offset_s) + 180 : null,
    ...timelineRows.map((row) => row.time_offset_s),
    ...(session?.event_timeline || []).map((event) => event.time_s),
  ].map(Number).filter((value) => Number.isFinite(value) && value > 0);
  return candidates.length ? Math.max(...candidates) : 600;
}

function compactText(value, max = 1400) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return text.length > max ? `${text.slice(0, max - 1).trim()}…` : text;
}

function listText(values) {
  if (Array.isArray(values)) return values.filter(Boolean).join(", ");
  return String(values || "").trim();
}

function buildSessionVideoContext(session, selectedVideo, timelineRows = []) {
  const methods = listText(session?.methods);
  const tags = listText(session?.tags);
  const linkedLabel = selectedVideo?.label || selectedVideo?.filename || selectedVideo?.path || "";
  const anchors = [
    session?.pre_climax_offset_s != null ? `pre-climax marker ${fmtMmSs(session.pre_climax_offset_s)}` : null,
    session?.climax_offset_s != null ? `climax marker ${fmtMmSs(session.climax_offset_s)}` : null,
    session?.recovery_offset_s != null ? `recovery marker ${fmtMmSs(session.recovery_offset_s)}` : null,
  ].filter(Boolean).join("; ");
  const deviceLines = [
    methods ? `Methods: ${methods}` : null,
    session?.sleeve_type ? `Sleeve: ${session.sleeve_type}` : null,
    session?.foley_type ? `Foley: ${session.foley_type}` : null,
    session?.tens_placement ? `TENS placement: ${session.tens_placement}` : null,
    session?.estim_notes ? `E-stim notes: ${compactText(session.estim_notes, 500)}` : null,
    session?.refractory_notes ? `Refractory notes: ${compactText(session.refractory_notes, 500)}` : null,
    tags ? `Tags: ${tags}` : null,
  ].filter(Boolean);
  const contextText = sessionContextEvidenceText(session);
  const timelineEvents = (session?.event_timeline || [])
    .filter((event) => String(event?.note || "").trim())
    .slice()
    .sort((a, b) => Number(a.time_s || 0) - Number(b.time_s || 0))
    .slice(0, 80)
    .map((event) => `[${fmtMmSs(event.time_s)}] ${compactText(event.note, 180)}`)
    .join(" | ");
  const audioPasses = (Array.isArray(session?.ai_analysis?.ai_audio_passes) ? session.ai_analysis.ai_audio_passes : [])
    .slice(0, 12)
    .map((pass) => {
      const spoken = (pass.events || [])
        .filter((event) => event.transcript)
        .slice(0, 6)
        .map((event) => `[${fmtMmSs(event.startSeconds)}] "${compactText(event.transcript, 140)}"`)
        .join(" | ");
      return `${fmtMmSs(pass.start_s)}-${fmtMmSs(pass.end_s)}: ${spoken || compactText(pass.summary, 220)}`;
    })
    .filter(Boolean)
    .join(" || ");
  const telemetrySpan = timelineRows.length
    ? `Telemetry rows: ${timelineRows.length}; session span approximately ${fmtMmSs(estimateSessionEnd(session, timelineRows))}.`
    : "";

  return [
    linkedLabel ? `Linked video selected: ${linkedLabel}` : null,
    selectedVideo ? `Linked video alignment: source video 0:00 = session ${fmtSignedMmSs(timelineOffsetSeconds(selectedVideo))}.` : null,
    anchors ? `Timing anchors: ${anchors}` : null,
    telemetrySpan,
    deviceLines.length ? `Known methods/devices/materials: ${deviceLines.join(" | ")}` : null,
    contextText ? `Structured session context: ${contextText}` : null,
    session?.notes ? `Full session notes: ${compactText(session.notes, 1800)}` : null,
    timelineEvents ? `Manual/timestamped session notes: ${timelineEvents}` : null,
    audioPasses ? `Accepted audio-pass evidence: ${audioPasses}` : null,
  ].filter(Boolean).join("\n");
}

function buildBodyExplorationVideoContext(exploration, selectedVideo, timelineRows = []) {
  const methods = listText(exploration?.methods);
  const linkedLabel = selectedVideo?.label || selectedVideo?.filename || selectedVideo?.path || "";
  const deviceLines = [
    methods ? `Methods: ${methods}` : null,
    exploration?.exploration_type ? `Exploration type: ${exploration.exploration_type}` : null,
    exploration?.focus_areas ? `Focus areas: ${compactText(exploration.focus_areas, 600)}` : null,
    exploration?.purpose ? `Purpose/question: ${compactText(exploration.purpose, 700)}` : null,
    exploration?.devices ? `Devices/setup: ${compactText(exploration.devices, 900)}` : null,
    exploration?.foley_size ? `Foley size: ${exploration.foley_size}` : null,
    exploration?.foley_type ? `Foley type: ${exploration.foley_type}` : null,
    exploration?.sounding_notes ? `Instrumentation notes: ${compactText(exploration.sounding_notes, 900)}` : null,
    exploration?.comfort_notes ? `Comfort/tolerance notes: ${compactText(exploration.comfort_notes, 900)}` : null,
    exploration?.unusual_sensations ? `Unusual sensations: ${compactText(exploration.unusual_sensations, 700)}` : null,
    exploration?.findings ? `Logged findings: ${compactText(exploration.findings, 900)}` : null,
  ].filter(Boolean);
  const timelineEvents = (exploration?.event_timeline || [])
    .filter((event) => String(event?.note || "").trim())
    .slice()
    .sort((a, b) => Number(a.time_s || 0) - Number(b.time_s || 0))
    .slice(0, 80)
    .map((event) => `[${fmtMmSs(event.time_s)}] ${compactText(event.note, 180)}`)
    .join(" | ");
  const audioPasses = (Array.isArray(exploration?.ai_body_exploration?.ai_audio_passes) ? exploration.ai_body_exploration.ai_audio_passes : [])
    .slice(0, 12)
    .map((pass) => {
      const spoken = (pass.events || [])
        .filter((event) => event.transcript)
        .slice(0, 6)
        .map((event) => `[${fmtMmSs(event.startSeconds)}] "${compactText(event.transcript, 140)}"`)
        .join(" | ");
      return `${fmtMmSs(pass.start_s)}-${fmtMmSs(pass.end_s)}: ${spoken || compactText(pass.summary, 220)}`;
    })
    .filter(Boolean)
    .join(" || ");
  const telemetrySpan = timelineRows.length
    ? `Telemetry rows: ${timelineRows.length}; exploration span approximately ${fmtMmSs(estimateSessionEnd(exploration, timelineRows))}.`
    : "";

  return [
    linkedLabel ? `Linked video selected: ${linkedLabel}` : null,
    selectedVideo ? `Linked video alignment: source video 0:00 = exploration ${fmtSignedMmSs(timelineOffsetSeconds(selectedVideo))}.` : null,
    telemetrySpan,
    deviceLines.length ? `Known exploration/procedure context: ${deviceLines.join(" | ")}` : null,
    exploration?.notes ? `Full exploration notes: ${compactText(exploration.notes, 1800)}` : null,
    timelineEvents ? `Manual/timestamped exploration notes: ${timelineEvents}` : null,
    audioPasses ? `Accepted audio-pass evidence: ${audioPasses}` : null,
  ].filter(Boolean).join("\n");
}

function candidateWindows(session, timelineRows, count = 6, clipSeconds = 24, forcedEnd = null) {
  const end = Number.isFinite(Number(forcedEnd)) && Number(forcedEnd) > 0
    ? Number(forcedEnd)
    : estimateSessionEnd(session, timelineRows);
  const anchors = [];
  [
    session?.pre_climax_offset_s,
    session?.climax_offset_s,
    session?.recovery_offset_s,
  ].map(Number).filter((value) => Number.isFinite(value) && value > 0).forEach((value) => anchors.push(value));

  (session?.event_timeline || [])
    .filter((event) => String(event?.note || "").trim())
    .slice()
    .sort((a, b) => Number(a.time_s || 0) - Number(b.time_s || 0))
    .forEach((event) => {
      const note = String(event.note || "").toLowerCase();
      if (/(climax|ejac|orgasm|pause|resume|stroke|stimulation|foley|catheter|insert|insertion|withdraw|removal|sound|sounding|dilator|meatus|urethra|urethral|balloon|instrument|comfort|tolerance|feet|foot|toe|heel|erection|recovery|bracing)/.test(note)) {
        anchors.push(Number(event.time_s));
      }
    });

  if (anchors.length < count) {
    const spacing = end / (count + 1);
    for (let i = 1; i <= count; i += 1) anchors.push(spacing * i);
  }

  const used = [];
  return anchors
    .filter((value) => Number.isFinite(value) && value >= 0)
    .sort((a, b) => a - b)
    .map((anchor) => {
      const start = clamp(anchor - clipSeconds / 2, 0, Math.max(0, end - clipSeconds));
      return { start, end: Math.min(end, start + clipSeconds) };
    })
    .filter((window) => {
      const key = Math.round(window.start / 10);
      if (used.includes(key)) return false;
      used.push(key);
      return true;
    })
    .slice(0, count);
}

function sequentialWindows(startSeconds, session, timelineRows, count = 6, clipSeconds = 24, forcedEnd = null) {
  const sessionEnd = Number.isFinite(Number(forcedEnd)) && Number(forcedEnd) > 0
    ? Number(forcedEnd)
    : estimateSessionEnd(session, timelineRows);
  const windows = [];
  let cursor = clamp(Number(startSeconds) || 0, 0, Math.max(0, sessionEnd - 0.25));
  for (let i = 0; i < count && cursor < sessionEnd; i += 1) {
    const end = Math.min(sessionEnd, cursor + clipSeconds);
    windows.push({ start: cursor, end });
    cursor = end;
  }
  return windows;
}

function selectedVideoSessionEnd(video, fallbackEnd, metadataDuration = 0) {
  const durations = [
    video?.durationSeconds,
    video?.duration_seconds,
    video?.duration_s,
    metadataDuration,
  ].map(Number).filter((value) => Number.isFinite(value) && value > 0);
  if (!durations.length) return fallbackEnd;
  const videoEnd = sessionTimeForSource(Math.max(...durations), video);
  return Math.max(0, Math.min(fallbackEnd, videoEnd));
}

function nearestTelemetrySummary(timelineRows, start, end) {
  const rows = timelineRows.filter((row) => {
    const t = Number(row.time_offset_s);
    return Number.isFinite(t) && t >= start && t <= end;
  });
  if (!rows.length) return "No heart-rate samples in this window.";
  const hrs = rows.map((row) => Number(row.hr ?? row.heart_rate)).filter((value) => Number.isFinite(value));
  if (!hrs.length) return `${rows.length} telemetry samples, but no parsed BPM values.`;
  const min = Math.round(Math.min(...hrs));
  const max = Math.round(Math.max(...hrs));
  const avg = Math.round(hrs.reduce((sum, value) => sum + value, 0) / hrs.length);
  return `${rows.length} telemetry samples; HR avg ${avg} BPM, range ${min}-${max} BPM.`;
}

function isStaticTrackingMarkerFinding(finding) {
  const text = `${finding?.title || ""} ${finding?.text || finding?.findingText || ""}`.toLowerCase();
  if (!/(tracking marker|reflective marker|visible dot|bright dot|circular dot|marker dot|markers on both feet|dots on both feet)/.test(text)) {
    return false;
  }
  return !/(move|movement|shift|change|lost|loss|reacquir|occlud|hidden|blocked|asymmetr|toe curl|heel|plant|brace|bracing|foot position|feet position|marker placement changed|tracking quality)/.test(text);
}

function isTelemetryOnlyFinding(finding) {
  const text = `${finding?.title || ""} ${finding?.text || finding?.findingText || ""} ${finding?.note || ""}`.toLowerCase();
  if (!/(hr|heart rate|bpm|telemetry|overlay|phase label|trend chart|avg|max|sustained build|elevated|recovery label)/.test(text)) {
    return false;
  }
  if (/(without visible cause|no visible (?:cause|stimulation|movement|body movement|change)|despite no visible|no .*visible .*to account)/.test(text)) {
    return true;
  }
  return !/(stimulation|contact|stroke|hand|shaft|glans|genital|penis|scrot|foreskin|meatus|erection|engorg|flaccid|ejaculate|pre-ejac|lubric|device|sleeve|foley|perine|pelvic|abdomen|chest|breath|respir|foot|feet|toe|heel|leg|tens|relax|tens)/.test(text);
}

function isGenericControlObjectMention(item) {
  const text = `${item?.title || ""} ${item?.text || item?.findingText || ""} ${item?.note || ""}`.toLowerCase();
  if (!/(control object|control device|dark handheld object|handheld controller|remote|mouse|keyboard|phone|side-table object)/.test(text)) {
    return false;
  }
  return !/(vibrator|sleeve|foley|catheter|lubric|lube|bottle|ring|pump|tens|e-stim|estim|electrode|known device|identified device)/.test(text);
}

function isLowValueNoChangeForRole(item, role) {
  if (role !== "feet") return false;
  const text = `${item?.title || ""} ${item?.text || item?.findingText || ""} ${item?.note || ""}`.toLowerCase();
  if (!/(no visible|no change|unchanged|stationary|stillness|remain|remains|stay|stays|stable|continues|baseline|without interruption|no heel|no toe|no leg|no bracing|no tremor|no tension|no lower-body response)/.test(text)) {
    return false;
  }
  return !/(increases|decreases|begins|becomes|shifts|moves|plants further|planting increases|curl increases|toe curl visible|tremor visible|trembling|shudder|bracing develops|heel lifts|relaxes after|tenses|tensing|oscillation|asymmetry increases|left.*more than right|right.*more than left)/.test(text);
}

function neutralizeIntentLanguage(text) {
  return String(text || "")
    .replace(/\b(second|third|another|repeated)\s+hand-lift\s+edging\s+maneuver\b/gi, "$1 hand-lift stimulation change")
    .replace(/\bhand-lift\s+edging\s+maneuver\b/gi, "hand-lift stimulation change")
    .replace(/\bedging\s+maneuver\b/gi, "stimulation pause/withdrawal")
    .replace(/\bedging\s+pattern\b/gi, "pause/resume pattern")
    .replace(/\bdeliberate\s+edging\b/gi, "observed stimulation modulation")
    .replace(/\bintentional\s+edging\b/gi, "observed stimulation modulation")
    .replace(/\bedging\b/gi, "near-threshold modulation");
}

function cleanDraftEventNote(text) {
  return neutralizeIntentLanguage(text)
    .replace(/^\s*(?:this\s+)?window\s+opens\s+(?:with|at|showing)\s*/i, "")
    .replace(/^\s*(?:this\s+)?window\s+closes\s+(?:with|at|showing)\s*/i, "")
    .replace(/^\s*(?:the\s+)?window\s+opens[:\s-]*/i, "")
    .replace(/^\s*(?:the\s+)?window\s+closes[:\s-]*/i, "")
    .replace(/\b(?:this\s+)?window\s+opens\s+(?:with|at|showing)\b/gi, "")
    .replace(/\b(?:this\s+)?window\s+closes\s+(?:with|at|showing)\b/gi, "")
    .trim();
}

function normalizeDraftEventCategories(categories = [], note = "", fallbackWindow = {}, isExploration = false) {
  const list = (Array.isArray(categories) ? categories : [categories || "other"]).filter(Boolean);
  if (isExploration) {
    const allowed = new Set(EXPLORATION_EVENT_CATEGORIES.map((category) => category.value));
    const mapped = list.map((category) => {
      if (category === "equipment" || category === "environment") return "setup";
      if (category === "physiology" || category === "movement") return "physical";
      if (category === "device" || category === "foley" || category === "catheter" || category === "sounding") return "instrumentation";
      if (category === "device_change" || category === "instrument_change") return "instrumentation_change";
      if (category === "position_or_comfort" || category === "tolerance") return "comfort";
      return category;
    }).filter((category) => allowed.has(category));
    return mapped.length ? [...new Set(mapped)] : ["other"];
  }
  const text = String(note || "").toLowerCase();
  const windowStart = Number(fallbackWindow?.start || 0);
  return list.map((category) => {
    if (
      category === "stimulation_started"
      && windowStart > 30
      && !/(initial|first\s+contact|first\s+obvious|session\s+start|masturbation\s+begins)/.test(text)
    ) {
      return "stimulation_resumed";
    }
    if (
      category === "stimulation_stopped"
      && !/(post[-\s]?climax|post[-\s]?orgasm|after\s+climax|after\s+orgasm|end[-\s]?of[-\s]?session|session\s+end|final|recovery)/.test(text)
    ) {
      return "stimulation_paused";
    }
    return category;
  });
}

const VIDEO_ROLE_OPTIONS = [
  {
    value: "main",
    label: "Main / genital composite",
    shortLabel: "Main",
    helper: "Stimulation, genital state, devices, lubrication, and composite context.",
  },
  {
    value: "feet",
    label: "Feet / lower body",
    shortLabel: "Feet",
    helper: "Toe/heel position, planting, bracing, tremor, lower-body symmetry.",
  },
  {
    value: "lateral",
    label: "Lateral / full body",
    shortLabel: "Lateral",
    helper: "Head-to-toe posture, pelvic lift/drop, breathing cues, whole-body transitions.",
  },
];

function inferVideoRole(video = {}) {
  const descriptor = `${video.label || ""} ${video.filename || ""} ${video.path || ""}`.toLowerCase();
  if (/(foot|feet|lower|toe|heel)/.test(descriptor)) return "feet";
  if (/(side|lateral|full|body|wide)/.test(descriptor)) return "lateral";
  return "main";
}

function videoRoleLabel(role) {
  return VIDEO_ROLE_OPTIONS.find((option) => option.value === role)?.shortLabel || "Main";
}

function videoFocusInstruction(video = {}, selectedRole = "", isExploration = false) {
  const role = selectedRole || inferVideoRole(video);
  if (role === "feet") {
    if (isExploration) {
      return "This is the feet/lower-body evidence lane for a body exploration/procedure review. Findings and draft timeline events must be about visible feet, toes, heels, soles, ankles, legs, lower-body tension/relaxation/bracing/asymmetry, tremor, shudder, and lower-body response during instrumentation or positioning. Do not create hand, genital, or device events from the feet lane unless a visible lower-body response is the main event.";
    }
    return "This is the feet/lower-body evidence lane. Findings and draft timeline events must be about visible feet, toes, heels, soles, ankles, legs, lower-body tension/relaxation/bracing/asymmetry, tremor, shudder, and lower-body transitions. Actively compare frame-to-frame toe curl, downward plantar flexion/planting, heel separation/lift, foot fan/splay, leg tensing, tremble, oscillation, and left/right asymmetry. Do not create hand, genital, stimulation, device, lubricant, control-object, erection, or detumescence events from the feet lane; those belong to main/composite or lateral views. If the feet/lower body truly look static, say so once in the summary only and return empty findings/events rather than repeating no-change cards.";
  }
  if (role === "lateral") {
    return isExploration
      ? "This is a lateral/full-body angle for a body exploration/procedure review. Prioritize posture, positioning, breathing/body settling when visible, leg/foot tension or relaxation, comfort/tolerance cues, and meaningful whole-body response during instrumentation or setup changes."
      : "This is a lateral/full-body angle. Prioritize head-to-toe body state: posture, pelvic lift/drop, abdominal or chest motion if visible enough for cautious breathing assessment, leg/foot tension, relaxation, and meaningful whole-body transitions.";
  }
  if (isExploration) {
    return "This is the main body exploration/procedure view. Follow the visible procedure sequence naturally using current-frame action plus exploration context: positioning on the table, draping, swabbing/antiseptic prep, lubrication or urethral dilation, initial Foley handling, penis/glans stabilization, visible meatal engagement, visible advancement through urethral landmarks, bladder entry or urine confirmation, balloon inflation, drape removal, and urine collection in the bag. Describe only the stage/action actually visible in the current window. Foley or tubing presence is state, not action; do not convert visible tubing/field handling into insertion, placement, advancement, balloon inflation, securement, or finalization unless that exact action is visible or logged nearby. Do not treat procedure handling as active stimulation unless active stimulation is visibly present or logged.";
  }
  return "This is a main/genital-composite session view. Actively track visible stimulation mechanics first: hand-to-genital contact, stroking/shaft or glans motion, sleeve/device movement, perineal or scrotal-base contact, lubricant application, grip/contact changes, pauses/resumes, and device-plus-stimulation combinations such as Foley in place while stimulation continues. A Foley catheter, sleeve, lubricant, or other device being present does not make the window a resting state. Only call the window resting/no stimulation when sampled frames show no hand/device/body contact or stimulation motion across the window.";
}

function videoRoleHelper(role, isExploration = false) {
  if (isExploration) return videoFocusInstruction({}, role, true);
  return VIDEO_ROLE_OPTIONS.find((option) => option.value === role)?.helper || "";
}

const LOWER_BODY_TERMS = [
  "foot",
  "feet",
  "toe",
  "toes",
  "heel",
  "heels",
  "sole",
  "soles",
  "ankle",
  "ankles",
  "leg",
  "legs",
  "thigh",
  "thighs",
  "knee",
  "knees",
  "calf",
  "calves",
  "lower-body",
  "lower body",
  "plant",
  "planted",
  "planting",
  "brace",
  "bracing",
  "tremor",
  "shudder",
  "tension",
  "tensing",
  "relax",
  "relaxed",
  "splay",
  "outward",
  "inward",
  "curl",
  "curled",
  "flex",
  "flexes",
  "dorsiflex",
  "plantar",
  "asymmetry",
];

const NON_FEET_LANE_TERMS = [
  "hand",
  "hands",
  "finger",
  "fingers",
  "thumb",
  "palm",
  "wrist",
  "control object",
  "mouse",
  "remote",
  "side table",
  "genital",
  "penis",
  "penile",
  "shaft",
  "glans",
  "scrot",
  "foreskin",
  "perine",
  "stimulation",
  "contact",
  "stroke",
  "stroking",
  "lubrication",
  "lubricant",
  "lube",
  "device",
  "sleeve",
  "foley",
  "erection",
  "engorgement",
  "flaccid",
  "ejaculation",
  "ejaculate",
  "pre-ejaculate",
  "orgasm",
  "climax",
  "cum",
];

function firstTermIndex(text, terms) {
  const value = String(text || "").toLowerCase();
  return terms.reduce((best, term) => {
    const index = value.indexOf(term);
    if (index === -1) return best;
    return best === -1 ? index : Math.min(best, index);
  }, -1);
}

function isOutOfLaneForRole(item, role) {
  if (role !== "feet") return false;
  const text = [
    item?.title,
    item?.text,
    item?.note,
    item?.category,
    Array.isArray(item?.annotation_tags) ? item.annotation_tags.join(" ") : "",
  ].filter(Boolean).join(" ");
  const lowerIndex = firstTermIndex(text, LOWER_BODY_TERMS);
  const otherIndex = firstTermIndex(text, NON_FEET_LANE_TERMS);
  if (otherIndex === -1) return false;
  if (lowerIndex === -1) return true;
  return otherIndex < lowerIndex;
}

function normalizeAIResult(raw, fallbackWindow, selectedRole = "main", isExploration = false) {
  const value = typeof raw === "string" ? null : raw;
  const findings = Array.isArray(value?.findings)
    ? value.findings
    : [{
      title: "Video window review",
      text: typeof raw === "string" ? raw.trim() : "Sarah reviewed this window but did not return separate findings.",
      confidence: "moderate",
      category: "other",
    }];
  const events = Array.isArray(value?.events) ? value.events : [];
  return {
    summary: neutralizeIntentLanguage(value?.summary || findings[0]?.text || "Review complete."),
    findings: findings.map((finding) => ({
      title: neutralizeIntentLanguage(finding.title || "Finding"),
      text: neutralizeIntentLanguage(finding.text || finding.findingText || ""),
      confidence: finding.confidence || "moderate",
      category: finding.category || "other",
    })).filter((finding) => finding.text && !isStaticTrackingMarkerFinding(finding) && !isTelemetryOnlyFinding(finding) && !isGenericControlObjectMention(finding) && !isLowValueNoChangeForRole(finding, selectedRole) && !isOutOfLaneForRole(finding, selectedRole)),
    events: events.map((event) => {
      const note = cleanDraftEventNote(event.note || event.text || "");
      return {
        time_s: clamp(
          Number.isFinite(Number(event.time_s)) ? Number(event.time_s) : fallbackWindow.start,
          fallbackWindow.start,
          fallbackWindow.end,
        ),
        note,
        category: normalizeDraftEventCategories(event.category, note, fallbackWindow, isExploration),
        annotation_tags: Array.isArray(event.annotation_tags) ? event.annotation_tags : ["other_context"],
        confidence: event.confidence || "moderate",
      };
    }).filter((event) => event.note && !isStaticTrackingMarkerFinding({ title: "", text: event.note }) && !isTelemetryOnlyFinding({ title: "", text: event.note }) && !isGenericControlObjectMention(event) && !isLowValueNoChangeForRole(event, selectedRole) && !isOutOfLaneForRole(event, selectedRole)),
  };
}

function normalizeEventCategories(categories = [], isExploration = false) {
  const allowed = new Set(isExploration
    ? EXPLORATION_EVENT_CATEGORIES.map((category) => category.value)
    : ["stimulation", "stimulation_started", "stimulation_paused", "stimulation_resumed", "stimulation_stopped", "motion_pause", "motion_resume", "movement_observed", "sensation", "physical", "other"]);
  const mapped = categories.map((category) => {
    if (isExploration) {
      if (category === "equipment" || category === "environment") return "setup";
      if (category === "physiology" || category === "movement") return "physical";
      if (category === "device" || category === "foley" || category === "catheter" || category === "sounding") return "instrumentation";
      if (category === "device_change" || category === "instrument_change") return "instrumentation_change";
      if (category === "position_or_comfort" || category === "tolerance") return "comfort";
      return category;
    }
    if (category === "movement") return "movement_observed";
    if (category === "physiology") return "physical";
    if (category === "environment" || category === "equipment") return "other";
    return category;
  }).filter((category) => allowed.has(category));
  return mapped.length ? [...new Set(mapped)] : ["other"];
}

function eventFromCard(card, event, index, isExploration = false) {
  return {
    time_s: Number(event.time_s || card.window.start),
    note: event.note,
    category: normalizeEventCategories(event.category, isExploration),
    source: "ai_video_pass",
    ai_generated: true,
    annotation_origin: "ai",
    annotation_tags: event.annotation_tags?.length ? event.annotation_tags : ["other_context"],
    ai_annotation: {
      source: "sarah_video_pass",
      confidence: event.confidence || card.confidence || "moderate",
      clip_url: card.clipUrl,
      clip_start_s: card.window.start,
      clip_end_s: card.window.end,
      source_clip_start_s: card.sourceWindow?.start ?? card.window.start,
      source_clip_end_s: card.sourceWindow?.end ?? card.window.end,
      timeline_offset_s: timelineOffsetSeconds(card.sourceVideo),
      source_video_role: card.sourceVideoRole || inferVideoRole(card.sourceVideo),
      source_video: card.sourceVideo?.filename || card.sourceVideo?.label || "",
      source_video_fingerprint: card.sourceVideo?.fingerprint || "",
    },
    video_clip: {
      url: card.clipUrl,
      start_s: card.window.start,
      end_s: card.window.end,
      source_start_s: card.sourceWindow?.start ?? card.window.start,
      source_end_s: card.sourceWindow?.end ?? card.window.end,
      timeline_offset_s: timelineOffsetSeconds(card.sourceVideo),
      label: card.label,
    },
    title: `${card.label} finding ${index + 1}`,
  };
}

function isAIGeneratedPassEvent(event) {
  return event?.source === "ai_video_pass"
    || event?.source === "ai_audio_pass"
    || event?.ai_generated === true
    || event?.annotation_origin === "ai"
    || event?.ai_annotation?.source === "sarah_video_pass"
    || event?.ai_annotation?.source === "sarah_audio_pass"
    || Boolean(event?.audio_review);
}

function persistedCardFrom(card) {
  return {
    id: card.id,
    saved_at: new Date().toISOString(),
    label: card.label,
    source: "ai_video_pass",
    source_video: {
      id: card.sourceVideo?.id || null,
      label: card.sourceVideo?.label || "",
      filename: card.sourceVideo?.filename || "",
      fingerprint: card.sourceVideo?.fingerprint || "",
      role: card.sourceVideoRole || inferVideoRole(card.sourceVideo),
    },
    clip: {
      url: card.clipUrl,
      thumbnail_url: card.thumbnailUrl || "",
      start_s: card.window.start,
      end_s: card.window.end,
      duration_s: Number((card.window.end - card.window.start).toFixed(2)),
    },
    sampled_frames: card.sampledFrames || [],
    summary: card.summary,
    source_video_role: card.sourceVideoRole || inferVideoRole(card.sourceVideo),
    findings: card.findings,
    draft_events: card.events,
    telemetry: card.telemetry,
    motion_summary: card.motionSummary || null,
  };
}

function cardFromAIVideoJob(job, isExploration = false) {
  const meta = job?.meta || {};
  const cardMeta = meta.card || {};
  const result = job?.result;
  if (!result || !cardMeta.window) return null;
  const normalized = normalizeAIResult(result, cardMeta.window, cardMeta.sourceVideoRole || "main", isExploration);
  return {
    id: `job-${job.id}`,
    label: cardMeta.label || meta.title || "AI video pass",
    window: cardMeta.window,
    sourceWindow: cardMeta.sourceWindow || cardMeta.window,
    sourceVideo: cardMeta.sourceVideo || {},
    sourceVideoRole: cardMeta.sourceVideoRole || "main",
    clipUrl: cardMeta.clipUrl || "",
    thumbnailUrl: cardMeta.thumbnailUrl || "",
    sampledFrames: cardMeta.sampledFrames || [],
    motionSummary: cardMeta.motionSummary || null,
    telemetry: cardMeta.telemetry || "",
    ...normalized,
  };
}

async function runBackgroundAIVideoReview({ aiPayload, cardMeta, session, recordType, label, onProgress }) {
  const route = recordType === "body_exploration"
    ? `/ai-annotation?type=body_exploration&id=${encodeURIComponent(session.id)}`
    : `/sessions/${encodeURIComponent(session.id)}/ai-annotation`;
  const startedJob = await startBackgroundJob("ai_invoke", {
    ...aiPayload,
    label,
  }, {
    source: "ai_video_pass",
    sessionId: session.id,
    recordType,
    title: label,
    route,
    card: cardMeta,
  });
  onProgress?.(startedJob);
  const completedJob = await waitForBackgroundJob(startedJob.id, {
    intervalMs: 1200,
    onProgress,
  });
  return completedJob;
}

function blobToBase64(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || "").replace(/^data:[^;]+;base64,/, ""));
    reader.onerror = () => reject(reader.error || new Error("Could not read sampled frame."));
    reader.readAsDataURL(blob);
  });
}

async function sampledFrameImagePayload(frames = []) {
  const payload = [];
  for (const frame of frames.slice(0, 5)) {
    if (!frame?.url) continue;
    try {
      const response = await fetch(frame.url);
      if (!response.ok) continue;
      const blob = await response.blob();
      const data = await blobToBase64(blob);
      if (!data) continue;
      payload.push({
        filename: frame.url.split("/").pop() || "sampled-frame.jpg",
        media_type: blob.type || "image/jpeg",
        data,
      });
    } catch {
      // Reassessment can still use text context if an old sampled frame file expired.
    }
  }
  return payload;
}

function normalizeVideoPassFindingsForRecord(recordOrEntries, isExploration = false) {
  return isExploration
    ? normalizeBodyExplorationVideoPassFindings(recordOrEntries)
    : normalizeSessionVideoPassFindings(recordOrEntries);
}

function buildVideoPassDigestForRecord(analysisBase, isExploration = false) {
  return isExploration
    ? buildBodyExplorationVideoPassDigest({ ai_body_exploration: analysisBase })
    : buildSessionVideoPassDigest({ ai_analysis: analysisBase });
}

function compactVideoPassFlow(entries = []) {
  return normalizeSessionVideoPassFindings(entries).map((entry) => ({
    id: entry.id,
    label: entry.label,
    source_video: entry.source_video,
    clip: entry.clip,
    summary: entry.summary,
    findings: entry.findings.slice(0, 6),
    draft_events: entry.draft_events.slice(0, 5),
    telemetry: entry.telemetry,
    saved_at: entry.saved_at,
  }));
}

function compactCardContinuity(card, isExploration = false) {
  if (!card) return "";
  if (isExploration) {
    const findings = (card.findings || [])
      .map((finding) => `${finding.title || "Finding"}: ${finding.text || ""}`)
      .filter(Boolean)
      .slice(0, 3);
    const events = (card.events || [])
      .map((event) => `[${fmtMmSs(event.time_s)}] ${event.note}`)
      .filter(Boolean)
      .slice(0, 2);
    return [
      `Previous reviewed window: ${fmtMmSs(card.window?.start)} to ${fmtMmSs(card.window?.end)}.`,
      card.summary ? `Prior summary: ${card.summary}` : "",
      findings.length ? `Prior findings: ${findings.join(" | ")}` : "",
      events.length ? `Prior draft events: ${events.join(" | ")}` : "",
      "Use this as procedural continuity, but correct the stage if current frames show the sequence is earlier/later than the prior interpretation.",
      card.telemetry ? `Prior telemetry: ${card.telemetry}` : "",
    ].filter(Boolean).join("\n");
  }
  const findings = (card.findings || [])
    .map((finding) => `${finding.title || "Finding"}: ${finding.text || ""}`)
    .filter(Boolean)
    .slice(0, 4);
  const events = (card.events || [])
    .map((event) => `[${fmtMmSs(event.time_s)}] ${event.note}`)
    .filter(Boolean)
    .slice(0, 3);
  return [
    `Previous reviewed window: ${fmtMmSs(card.window?.start)} to ${fmtMmSs(card.window?.end)}.`,
    card.summary ? `Prior summary: ${card.summary}` : "",
    findings.length ? `Prior findings: ${findings.join(" | ")}` : "",
    events.length ? `Prior draft events: ${events.join(" | ")}` : "",
    "Use this only as continuity. Current sampled frames override the prior interpretation, especially if the prior window said no stimulation/no visible cause but this window shows hand/device contact, motion, or technique change.",
    card.telemetry ? `Prior telemetry: ${card.telemetry}` : "",
  ].filter(Boolean).join("\n");
}

function compactSavedContinuity(entry) {
  if (!entry) return "";
  const findings = (entry.findings || []).slice(0, 4);
  const events = (entry.draft_events || [])
    .map((event) => `[${fmtMmSs(event.time_s)}] ${event.note}`)
    .slice(0, 3);
  return [
    `Previous accepted Sarah video-pass window: ${fmtMmSs(entry.clip?.start_s)} to ${fmtMmSs(entry.clip?.end_s)}.`,
    entry.summary ? `Prior summary: ${entry.summary}` : "",
    findings.length ? `Prior findings: ${findings.join(" | ")}` : "",
    events.length ? `Prior draft events: ${events.join(" | ")}` : "",
    "Use this only as continuity. Current sampled frames override the accepted prior interpretation, especially if this window now shows visible contact, motion, or stimulation/procedure change.",
    entry.telemetry ? `Prior telemetry: ${entry.telemetry}` : "",
  ].filter(Boolean).join("\n");
}

function compactExplorationSequenceLedger(cards = []) {
  const recentCards = (cards || []).slice(-5);
  if (!recentCards.length) return "";
  const lines = recentCards.map((card) => {
    const eventText = (card.events || [])
      .map((event) => event.note)
      .filter(Boolean)
      .slice(0, 2)
      .join(" | ");
    const findingText = (card.findings || [])
      .map((finding) => finding.title || finding.text)
      .filter(Boolean)
      .slice(0, 2)
      .join(" | ");
    return `[${fmtMmSs(card.window?.start)}-${fmtMmSs(card.window?.end)}] ${compactText(card.summary || eventText || findingText, 280)}`;
  }).filter(Boolean);
  if (!lines.length) return "";
  return [
    "Prior body-exploration windows reviewed in this run:",
    ...lines,
    "Use this as a stage ledger, not a script. If a prior window already showed a Foley stage, do not claim that same stage is newly happening again unless the current sampled frames independently show a new repeat of that action. If the current frames only show a catheter or tubing already present, describe the current handling/state rather than re-labeling it as placement.",
  ].join("\n");
}

function findSavedPriorContinuity(session, selectedVideo, window, isExploration = false) {
  if (isExploration) return "";
  const currentStart = Number(window?.start);
  if (!Number.isFinite(currentStart)) return "";
  const selectedFingerprint = selectedVideo?.fingerprint || "";
  const selectedFilename = selectedVideo?.filename || selectedVideo?.label || "";
  const entries = normalizeVideoPassFindingsForRecord(session, isExploration)
    .filter((entry) => {
      const end = Number(entry.clip?.end_s);
      if (!Number.isFinite(end) || end > currentStart + 0.5) return false;
      const entryFingerprint = entry.source_video?.fingerprint || "";
      const entryFilename = entry.source_video?.filename || entry.source_video?.label || "";
      if (selectedFingerprint && entryFingerprint) return selectedFingerprint === entryFingerprint;
      if (selectedFilename && entryFilename) return selectedFilename === entryFilename;
      return true;
    })
    .sort((a, b) => Number(b.clip?.end_s || 0) - Number(a.clip?.end_s || 0));
  return compactSavedContinuity(entries[0]);
}

function sameClipRange(aStart, aEnd, bStart, bEnd) {
  return Math.abs(Number(aStart) - Number(bStart)) < 0.75
    && Math.abs(Number(aEnd) - Number(bEnd)) < 0.75;
}

function sameCardSource(card, source = {}) {
  const cardFingerprint = card.sourceVideo?.fingerprint || "";
  const cardFilename = card.sourceVideo?.filename || card.sourceVideo?.label || "";
  const sourceFingerprint = source.fingerprint || "";
  const sourceFilename = source.filename || source.label || "";
  if (cardFingerprint && sourceFingerprint) return cardFingerprint === sourceFingerprint;
  if (cardFilename && sourceFilename) return cardFilename === sourceFilename;
  return true;
}

function sameSavedCardClip(card, entry) {
  return sameClipRange(card.window?.start, card.window?.end, entry.clip?.start_s, entry.clip?.end_s)
    && sameCardSource(card, entry.source_video || {});
}

function persistedTimelineEventsForCard(card, session) {
  const cardStart = Number(card.window?.start);
  const cardEnd = Number(card.window?.end);
  if (!Number.isFinite(cardStart) || !Number.isFinite(cardEnd)) return [];
  return (session?.event_timeline || []).filter((event) => {
    if (event?.source !== "ai_video_pass") return false;
    const annotation = event.ai_annotation || {};
    if (!sameClipRange(cardStart, cardEnd, annotation.clip_start_s, annotation.clip_end_s)) return false;
    const sourceLabel = annotation.source_video || "";
    return sameCardSource(card, { filename: sourceLabel, label: sourceLabel, fingerprint: annotation.source_video_fingerprint || "" });
  });
}

function isCardAccepted(card, session, acceptedIds, isExploration = false) {
  if (acceptedIds.has(card.id)) return true;
  const savedCard = normalizeVideoPassFindingsForRecord(session, isExploration).some((entry) => sameSavedCardClip(card, entry));
  if (!savedCard) return false;
  if (!card.events?.length) return true;
  return persistedTimelineEventsForCard(card, session).length >= card.events.length;
}

function eventFromAudioResult(event, sourceVideo, isExploration = false) {
  return {
    time_s: Number(event.startSeconds || 0),
    note: event.note || "Audio activity detected.",
    category: isExploration
      ? (event.transcript ? ["instrumentation", "sensation"] : ["other"])
      : (event.transcript ? ["other", "sensation"] : ["other"]),
    annotation_tags: isExploration
      ? (event.transcript ? ["instrumentation_action", "sensation_report", "other_context"] : ["other_context"])
      : (event.transcript ? ["sensation_report", "other_context"] : ["other_context"]),
    source: "ai_audio_pass",
    ai_generated: true,
    annotation_origin: "ai",
    confidence: event.confidence || "moderate",
    ai_annotation: {
      source: "sarah_audio_pass",
      confidence: event.confidence || "moderate",
      source_video: sourceVideo?.filename || sourceVideo?.label || "",
      source_video_fingerprint: sourceVideo?.fingerprint || "",
      clip_start_s: Number(event.startSeconds || 0),
      clip_end_s: Number(event.endSeconds || 0),
    },
    audio_review: {
      source_video: {
        filename: sourceVideo?.filename || sourceVideo?.label || "",
        label: sourceVideo?.label || "",
        fingerprint: sourceVideo?.fingerprint || "",
      },
      start_s: Number(event.startSeconds || 0),
      end_s: Number(event.endSeconds || 0),
      source_start_s: Number(event.sourceStartSeconds ?? event.startSeconds ?? 0),
      source_end_s: Number(event.sourceEndSeconds ?? event.endSeconds ?? 0),
      duration_s: Number(event.durationSeconds || 0),
      transcript: event.transcript || "",
      transcription_error: event.transcriptionError || "",
    },
  };
}

export default function AIVideoPassPanel({
  session,
  timelineRows = [],
  linkedLocalVideos = [],
  recordType = "session",
  onSessionUpdate,
  onCursorChange,
  ignoreCompletedJobsBefore = 0,
}) {
  const isExploration = recordType === "body_exploration" || session?.standalone_body_exploration;
  const recordLabel = isExploration ? "exploration" : "session";
  const analysisField = isExploration ? "ai_body_exploration" : "ai_analysis";
  const entity = isExploration ? base44.entities.BodyExploration : base44.entities.Session;
  const availableVideos = useMemo(() => linkedLocalVideos.filter((video) => video?.path && video.exists !== false), [linkedLocalVideos]);
  const previewVideoRef = useRef(null);
  const [selectedPath, setSelectedPath] = useState(availableVideos[0]?.path || "");
  const [clipSeconds, setClipSeconds] = useState(24);
  const [windowCount, setWindowCount] = useState(5);
  const [scanMode, setScanMode] = useState("smart");
  const [autoContinue, setAutoContinue] = useState(false);
  const [scanCursor, setScanCursor] = useState(0);
  const [running, setRunning] = useState(false);
  const [reassessing, setReassessing] = useState(false);
  const [status, setStatus] = useState("");
  const [cards, setCards] = useState([]);
  const [error, setError] = useState("");
  const [expanded, setExpanded] = useState({});
  const [acceptedIds, setAcceptedIds] = useState(new Set());
  const [audioRunning, setAudioRunning] = useState(false);
  const [audioStatus, setAudioStatus] = useState("");
  const [audioError, setAudioError] = useState("");
  const [audioWindowSeconds, setAudioWindowSeconds] = useState(300);
  const [audioMaxSnippets, setAudioMaxSnippets] = useState(10);
  const [audioResult, setAudioResult] = useState(null);
  const [audioAccepted, setAudioAccepted] = useState(false);
  const [metadataDurationSeconds, setMetadataDurationSeconds] = useState(0);
  const freshRunStartedAtRef = useRef(ignoreCompletedJobsBefore || 0);

  const selectedVideo = availableVideos.find((video) => video.path === selectedPath) || availableVideos[0];
  const selectedVideoOffset = timelineOffsetSeconds(selectedVideo);
  const selectedVideoStreamUrl = selectedVideo?.path ? base44.integrations.Core.localVideoStreamUrl(selectedVideo.path) : "";
  const [selectedVideoRole, setSelectedVideoRole] = useState(inferVideoRole(selectedVideo));
  const selectedVideoRoleHelper = videoRoleHelper(selectedVideoRole, isExploration);
  const estimatedSessionEnd = useMemo(() => estimateSessionEnd(session, timelineRows), [session, timelineRows]);
  const sessionEnd = useMemo(
    () => selectedVideoSessionEnd(selectedVideo, estimatedSessionEnd, metadataDurationSeconds),
    [estimatedSessionEnd, metadataDurationSeconds, selectedVideo],
  );
  const plannedWindows = useMemo(
    () => isExploration && scanMode === "smart"
      ? sequentialWindows(0, session, timelineRows, windowCount, clipSeconds, sessionEnd)
      : scanMode === "continue"
      ? sequentialWindows(scanCursor, session, timelineRows, windowCount, clipSeconds, sessionEnd)
      : candidateWindows(session, timelineRows, windowCount, clipSeconds, sessionEnd),
    [isExploration, scanMode, scanCursor, session, timelineRows, windowCount, clipSeconds, sessionEnd],
  );
  const storedAIPassEventCount = useMemo(
    () => (session?.event_timeline || []).filter(isAIGeneratedPassEvent).length,
    [session?.event_timeline],
  );
  useEffect(() => {
    if (!ignoreCompletedJobsBefore) return;
    freshRunStartedAtRef.current = ignoreCompletedJobsBefore;
    setCards([]);
    setAcceptedIds(new Set());
    setAudioResult(null);
    setAudioAccepted(false);
  }, [ignoreCompletedJobsBefore]);

  const resetStoredAIPassState = async ({ message = "" } = {}) => {
    freshRunStartedAtRef.current = Date.now();
    const existingAnalysis = session?.[analysisField] || {};
    const retainedAnalysis = { ...existingAnalysis };
    delete retainedAnalysis._video_pass_findings;
    delete retainedAnalysis._video_pass_findings_updated_at;
    delete retainedAnalysis._video_pass_detail_flow;
    delete retainedAnalysis._video_pass_digest;
    delete retainedAnalysis.ai_audio_passes;
    const retainedEvents = (session?.event_timeline || []).filter((event) => !isAIGeneratedPassEvent(event));
    const updated = {
      event_timeline: retainedEvents,
      [analysisField]: retainedAnalysis,
    };
    await entity.update(session.id, updated);
    onSessionUpdate?.({ ...session, ...updated });
    setCards([]);
    setAcceptedIds(new Set());
    setAudioResult(null);
    setAudioAccepted(false);
    if (message) setStatus(message);
    return { ...session, ...updated };
  };

  const refreshCompletedVideoPassJobs = useCallback(async ({ quiet = false } = {}) => {
    if (!session?.id) return;
    try {
      const response = await listBackgroundJobs({
        type: "ai_invoke",
        status: "complete",
        limit: 30,
        metaSessionId: session.id,
        metaSource: "ai_video_pass",
      });
      const freshRunStartedAt = freshRunStartedAtRef.current;
      const completedCards = (response.jobs || [])
        .filter((job) => job?.meta?.recordType === recordType)
        .filter((job) => {
          if (!freshRunStartedAt) return true;
          const jobCreatedAt = Date.parse(job?.createdAt || job?.startedAt || job?.updatedAt || "");
          return Number.isFinite(jobCreatedAt) && jobCreatedAt >= freshRunStartedAt - 1000;
        })
        .map((job) => cardFromAIVideoJob(job, isExploration))
        .filter(Boolean)
        .sort((a, b) => Number(a.window?.start || 0) - Number(b.window?.start || 0));
      if (!completedCards.length) return;
      setCards((current) => {
        const existingKeys = new Set(current.map((card) => `${card.sourceVideo?.fingerprint || card.sourceVideo?.path || ""}:${Math.round(Number(card.window?.start || 0) * 10)}:${Math.round(Number(card.window?.end || 0) * 10)}`));
        const additions = completedCards.filter((card) => {
          const key = `${card.sourceVideo?.fingerprint || card.sourceVideo?.path || ""}:${Math.round(Number(card.window?.start || 0) * 10)}:${Math.round(Number(card.window?.end || 0) * 10)}`;
          if (existingKeys.has(key)) return false;
          existingKeys.add(key);
          return true;
        });
        if (!additions.length) return current;
        if (!quiet) setStatus(`Caught up ${additions.length} completed background video review${additions.length === 1 ? "" : "s"}.`);
        return [...current, ...additions].sort((a, b) => Number(a.window?.start || 0) - Number(b.window?.start || 0));
      });
    } catch (err) {
      if (!quiet) setError(err?.message || "Could not refresh background video pass results.");
    }
  }, [isExploration, recordType, session?.id]);

  useEffect(() => {
    refreshCompletedVideoPassJobs({ quiet: true });
    const interval = window.setInterval(() => refreshCompletedVideoPassJobs({ quiet: true }), 5000);
    const handleFocus = () => refreshCompletedVideoPassJobs({ quiet: false });
    const handleVisibility = () => {
      if (document.visibilityState === "visible") handleFocus();
    };
    window.addEventListener("focus", handleFocus);
    document.addEventListener("visibilitychange", handleVisibility);
    return () => {
      window.clearInterval(interval);
      window.removeEventListener("focus", handleFocus);
      document.removeEventListener("visibilitychange", handleVisibility);
    };
  }, [refreshCompletedVideoPassJobs]);

  const clearStoredAIPassEvents = async () => {
    await resetStoredAIPassState({
      message: `Cleared stored AI video/audio pass findings and ${storedAIPassEventCount} AI-generated annotation${storedAIPassEventCount === 1 ? "" : "s"} from this ${recordLabel}.`,
    });
  };

  const seekPreviewVideo = (seconds) => {
    const video = previewVideoRef.current;
    if (!video || !Number.isFinite(Number(seconds))) return;
    try {
      video.currentTime = clamp(sourceTimeForSession(seconds, selectedVideo), 0, Math.max(0, video.duration || sessionEnd || 0));
    } catch {
      // Some browser/container combinations reject seeking before metadata is ready.
    }
  };

  const resetScanCursor = () => {
    setScanCursor(0);
    onCursorChange?.(0);
    seekPreviewVideo(0);
    setStatus("");
  };

  const setCursorFromTimeline = (seconds) => {
    setScanMode("continue");
    const nextCursor = clamp(Number(seconds) || 0, 0, Math.max(0, sessionEnd - clipSeconds));
    setScanCursor(nextCursor);
    onCursorChange?.(nextCursor);
    seekPreviewVideo(nextCursor);
    setStatus(`Cursor set to ${fmtMmSs(seconds)}. Run Next Pass will continue from there.`);
  };

  useEffect(() => {
    setScanCursor(0);
    onCursorChange?.(0);
    setMetadataDurationSeconds(0);
    seekPreviewVideo(0);
  }, [selectedVideo?.path]);

  useEffect(() => {
    if (!selectedPath && availableVideos[0]?.path) {
      setSelectedPath(availableVideos[0].path);
    }
  }, [availableVideos, selectedPath]);

  useEffect(() => {
    setSelectedVideoRole(inferVideoRole(selectedVideo));
  }, [selectedVideo?.path]);

  useEffect(() => {
    const maxCursor = Math.max(0, sessionEnd - 0.25);
    if (scanCursor <= maxCursor) return;
    setScanCursor(maxCursor);
    onCursorChange?.(maxCursor);
    seekPreviewVideo(maxCursor);
  }, [onCursorChange, scanCursor, sessionEnd]);

  const runPass = async () => {
    if (!selectedVideo?.path || running) return;
    setRunning(true);
    setError("");
    setCards([]);
    setAcceptedIds(new Set());
    try {
      const workingSession = await resetStoredAIPassState({
        message: `Starting fresh ${recordLabel} video analysis: cleared prior AI pass findings, audio pass notes, and AI-generated annotations.`,
      });
      const nextCards = [];
      const videoContext = isExploration
        ? buildBodyExplorationVideoContext(workingSession, selectedVideo, timelineRows)
        : buildSessionVideoContext(workingSession, selectedVideo, timelineRows);
      let cursor = scanMode === "continue" ? scanCursor : 0;
      let batchNumber = 0;
      let windowsToRun = plannedWindows;
      while (windowsToRun.length) {
        batchNumber += 1;
        for (let i = 0; i < windowsToRun.length; i += 1) {
          const window = windowsToRun[i];
          if (window.start >= sessionEnd - 0.25) break;
          const label = `AI video pass ${fmtMmSs(window.start)}-${fmtMmSs(window.end)}`;
          const sourceStart = sourceTimeForSession(window.start, selectedVideo);
          const sourceEnd = Math.max(sourceStart + 0.25, Number(window.end || 0) - selectedVideoOffset);
          setStatus(`Preparing ${label}${autoContinue && scanMode === "continue" ? ` · batch ${batchNumber}` : ""}`);
          const preview = await base44.integrations.Core.ProcessLocalVideoClip({
            path: selectedVideo.path,
            startSeconds: sourceStart,
            endSeconds: sourceEnd,
            label,
            frameCount: 10,
          });
          const reviewWindow = {
            start: sessionTimeForSource(preview.startSeconds ?? sourceStart, selectedVideo),
            end: sessionTimeForSource(preview.endSeconds ?? sourceEnd, selectedVideo),
          };
          const telemetry = nearestTelemetrySummary(timelineRows, reviewWindow.start, reviewWindow.end);
          const frameTiming = (preview.frames || [])
            .map((frame, index) => `frame ${index + 1} = ${recordLabel} ${fmtMmSs(sessionTimeForSource(frame.frameTimeSeconds, selectedVideo))} (source ${fmtMmSs(frame.frameTimeSeconds)})`)
            .join(", ");
          setStatus(`Sarah reviewing ${label}${autoContinue && scanMode === "continue" ? ` · batch ${batchNumber}` : ""}`);
          const continuityContext = [
            isExploration ? compactExplorationSequenceLedger(nextCards) : "",
            compactCardContinuity(nextCards[nextCards.length - 1], isExploration)
              || findSavedPriorContinuity(workingSession, selectedVideo, window, isExploration),
          ].filter(Boolean).join("\n\n")
            || "No prior reviewed window is available. Treat this as the first observed window, then establish baseline context for the next window.";
          const images = (preview.frames || []).map((frame) => ({
            filename: frame.filename,
            media_type: frame.mimeType || "image/jpeg",
            data: frame.data,
          }));
          const aiPayload = {
            max_tokens: 2400,
            response_json_schema: {
              type: "object",
              properties: {
                summary: { type: "string" },
                findings: {
                  type: "array",
                  maxItems: 4,
                  items: {
                    type: "object",
                    properties: {
                      title: { type: "string" },
                      text: { type: "string" },
                      category: { type: "string", enum: isExploration ? ["instrumentation", "physiology", "physical", "movement", "comfort", "environment", "equipment", "other"] : ["stimulation", "physiology", "physical", "movement", "environment", "equipment", "other"] },
                      confidence: { type: "string", enum: ["low", "moderate", "high"] },
                    },
                    required: ["title", "text", "category", "confidence"],
                  },
                },
                events: {
                  type: "array",
                  maxItems: 3,
                  items: {
                    type: "object",
                    properties: {
                      time_s: { type: "number" },
                      note: { type: "string" },
                      category: {
                        type: "array",
                        items: {
                          type: "string",
                          enum: isExploration ? EXPLORATION_EVENT_CATEGORIES.map((category) => category.value) : ["stimulation", "stimulation_started", "stimulation_paused", "stimulation_resumed", "stimulation_stopped", "motion_pause", "motion_resume", "movement_observed", "sensation", "physical", "other"],
                        },
                      },
                      annotation_tags: { type: "array", items: { type: "string" } },
                      confidence: { type: "string", enum: ["low", "moderate", "high"] },
                    },
                    required: ["time_s", "note", "category", "annotation_tags", "confidence"],
                  },
                },
              },
              required: ["summary", "findings", "events"],
            },
            images,
            prompt: `${isExploration ? `HIGH-PRIORITY BODY EXPLORATION MODE:
This is a Body Exploration / instrumentation review, not an active-stimulation session analysis. Watch for procedure, setup, device position, genital/body state, tissue appearance, Foley catheter or urethral sound/dilator presence, insertion/withdrawal/adjustment, meatal/urethral context when visible or logged, comfort/tolerance cues, breathing/legs/body response, and telemetry-supported autonomic response.
Do not force a stimulation lifecycle. Do not create stimulation start/pause/resume/stop events. If masturbation or active stimulation is not visibly present and not logged, treat hands/devices as procedure/instrumentation context, not stimulation. Interpret Foley/sound/catheter evidence through the exploration notes and mechanical profile context when provided, while staying strict about what is visible.

Foley placement sequence to track when visible: positioning on the table; draping and field setup; swabbing/antiseptic prep; lubrication or possible urethral dilation with a syringe; initial Foley handling; left-hand penis/glans stabilization; right-hand catheter advancement past the meatus; continued advancement through visible urethral landmarks or resistance/rotation cues; bladder entry or urine confirmation; balloon inflation; drape removal; urine collected in the bag. Treat these as possible stages, not a script.

Foley state-versus-action rule: Foley catheter/tubing already being visible means "Foley/tubing remains present", not "inserted", "placed", "advanced", or "secured". Yellow tubing being moved, lifted, routed, or resting across the field is tubing handling unless the catheter shaft is visibly advancing at the meatus or balloon/securement hardware is visible. Do not mention StatLock, adhesive securement, securement finalization, balloon inflation, bladder entry, urine confirmation, or urine collection unless that exact item/action is visible in the sampled frames or explicitly logged in nearby notes.

Foley action evidence gates: use "swabbing/prep" only for visible wipe/swab/applicator contact; use "lubrication/dilation" only when a syringe, gel, lubricant, instillation, or urethral prep action is visible/supported; use "meatal engagement" only when the catheter/tool tip is visibly at the meatus; use "advancement/insertion" only when the catheter/tool is visibly moving through the meatus in this current window; use "already in place" when the Foley appears present but not actively advancing; use "positioning/tubing handling" when gloved hands are arranging tubing, drape, gauze, or field materials. If unsure between insertion and already-in-place handling, choose the more conservative "already in place/tubing handling" wording with low or moderate confidence.
Use exploration event categories only: instrumentation, instrumentation_change, physical, sensation, comfort, setup, or other.
Draft event examples for this mode: "Draping and field setup continue", "Swabbing/prep continues around the meatus", "Lubrication or dilation syringe is used near the meatus", "Left hand stabilizes the penis while the right hand positions the Foley", "Foley advancement is visible at the meatus", "Foley appears already in place while tubing is repositioned", "Urine appears in the tubing/bag", "Drape is removed while urine collects in the bag".` : ""}

You are Sarah, reviewing sampled frames from a linked local ${recordLabel} video. Analyze only what is visible or supported by telemetry/context. Do not infer intent, pressure, force, coverings, gloves, lubricant, device fit, sensation, electrodes, or cause beyond visible evidence. If a hand or object is partially blurred, occluded, bright, or low-detail, describe it neutrally as visible contact/hand position rather than naming gloves or materials.

${isExploration ? "Exploration/procedure context grounding" : "Session context grounding"} has priority when it identifies known setup, devices, materials, or technique. Use the ${recordLabel} notes, methods, devices, and timestamped/manual notes below to interpret ambiguous visible objects and contact locations. ${isExploration ? "For example, if the exploration context says an 18 French Foley catheter or urethral sound is in use and the frames show a matching device at the meatus, identify it as that supported instrumentation rather than vague stimulation or generic object handling." : "For example, if the session context says a vibrator is held at the perineum during stimulation and the frames show a matching device/contact at that location, call it a perineal vibrator/contact rather than a vague \"blue device near the scrotum and genitals.\""} If context and visuals do not line up, state the uncertainty instead of forcing the label.

Current-frame override rule: the sampled frames in this request are the primary evidence. Prior summaries, accepted cards, and continuity text can orient the sequence, but they must not override the current frames. If the prior window said "resting", "no stimulation", "no visible movement", or "HR rising without visible cause", actively re-check the current frames for hand/device contact, visible stroke or device motion, perineal contact, glans/shaft movement, sleeve/lubricant interaction, body/leg response, or procedure action before repeating that claim.

Positive action tracking rule: describe visible contact or motion before describing absence. For regular session reviews, if any sampled frame shows hand contact with the penis, glans, shaft, scrotal-base/perineal region, sleeve/device, or visible stimulation-related motion, treat the window as active stimulation/contact or a stimulation transition unless the sequence clearly shows a pause. For body exploration reviews, if any sampled frame shows swab/wipe/applicator/tool/catheter/tubing contact or setup movement, describe that procedural action rather than saying nothing is happening. For Foley reviews, prefer the exact visible action: table positioning, drape/setup, swabbing, lubrication/dilation, penis stabilization, catheter positioning, visible advancement, already-in-place catheter state, tubing handling, balloon inflation, drape removal, or urine collection.

Hard wording rule: do not use "edging", "edging maneuver", "intentional edging", "holding back", "delaying climax", or similar intent language unless the nearby session event, session note, or user caption explicitly uses that exact concept. If the visible behavior is a hand lift, withdrawal, pause, restart, speed change, or contact change, describe the observable behavior only.

Ejaculation and fluid evidence rule: do not infer orgasm, climax, ejaculation, or cum from shiny/clear wetness, glans sheen, lubrication sheen, hand movement, erection state, or a stimulation pause alone. Clear or glossy moisture on the glans/shaft is more likely lubricant, pre-ejaculate, or unspecified moisture unless there is strong supporting context. Only call ejaculate when the visible fluid is clearly whitish/opaque, there is a visible emission/spurt, or there is a nearby confirmed climax/ejaculation event in the session notes/timeline. When that threshold is met, say "ejaculate" or "visible ejaculate" directly; do not use vague residue/euphemism wording. Treat HR/telemetry as consistency context: if the window does not align with the session climax marker, recovery transition, or a plausible autonomic peak, label fluid as "visible moisture/sheen" or "possible lubricant/pre-ejaculate" rather than ejaculate. Never create multiple orgasms/climax events from repeated wetness or sheen across adjacent windows; carry forward that it is likely the same lubricant/moisture unless there is a clear new emission or confirmed event.

Perineum and underside anatomy rule: do not label the area under the scrotum as "base of penis" unless the penile shaft base is clearly visible and contacted. If contact is below or behind the scrotum, use "perineum", "perineal region", "underside/perineal contact", or "scrotal-base/perineal region" depending on what is visible. If the location is ambiguous between penile base, scrotal base, and perineum, state the uncertainty instead of forcing a penile-base label.

Timeline timing rule: sampled frames can lag the true transition. Do not assume the event happened exactly at the window start or window end. Use the most likely visible transition time from the sampled frames and nearby session notes. If the exact second is uncertain, keep the note phrased as "visible by", "around", "continues", "pauses", or "resumes" rather than claiming a precise start/stop. Never write filler such as "This window opens with", "Window opens at", "This window closes with", or "Window closes with" in event notes.

${isExploration ? "" : "Stimulation lifecycle rule: there should usually be only one \"stimulation_started\" event for the initial obvious masturbation/contact and only one \"stimulation_stopped\" event for the true post-climax/end-of-session cessation. Inside the session, use \"stimulation_paused\", \"stimulation_resumed\", or plain \"stimulation\" for hand lifts, contact changes, technique shifts, lubrication breaks, device handling, and post-climax milking/recovery transitions. Do not create repeated start/stop events for adjacent windows that are really pause/resume or method changes."}

Camera/view focus:
${videoFocusInstruction(selectedVideo, selectedVideoRole, isExploration)}

Source-lane rule: treat the selected camera as its own evidence lane. Main/composite owns genital, stimulation, hand contact, device, lubricant, and technique observations. Feet/lower-body owns feet, toes, heels, soles, ankles, legs, planting, bracing, tremor, shudder, and lower-body tension/relaxation observations. Lateral/full-body owns posture, pelvic lift/drop, breathing cues, whole-body tension, and major body transitions. For a feet/lower-body pass, do not draft timeline events about right/left hand movement, genital contact, control objects, lube/device handling, erection/genital state, or stimulation pause/resume unless a visible foot/leg change is the main event.

Feet-lane sensitivity rule: for feet/lower-body videos, look carefully for subtle but meaningful lower-body activity before claiming no change. Specifically compare toe curl/extension, toes pointing downward or relaxing, heel spread or lift, foot fan/splay, sole angle, ankle flexion, leg tension/relaxation, tremble, shudder, side-to-side oscillation, and left/right asymmetry. Downward planting, toe curl, tensing, trembling, or progressive foot fan are meaningful findings/events even if the body otherwise stays in place. Do not write repeated "no change", "stillness continues", "baseline unchanged", or "no lower-body response" findings/events across adjacent windows. If the only observation is static lower-body position, keep the summary to one brief sentence and return empty findings and empty events.

Observation priorities, in order:
1. Visible physiological response: erection/engorgement quality, genital position/state, glans/shaft/foreskin/scrotal/perineal state, visible skin color or surface sheen, cautious visible fluid/moisture labeling, pelvic lift/drop, and whether these change from the prior window.
2. ${isExploration ? "Procedure/instrumentation state: what body area or device/material is involved, whether procedure contact continues, starts, pauses, resumes, or changes, and whether motion/position shows setup, prep/swabbing, lubrication/dilation, visible meatal engagement, visible advancement, already-in-place catheter state, tubing/field handling, balloon inflation, drape removal, urine collection, or post-procedure checking. Do not claim insertion/advancement/securement from Foley or tubing presence alone." : "Stimulation state and technique: what body area is contacted, whether contact continues, starts, pauses, resumes, or changes, and whether motion/position suggests a technique shift."}
3. Whole-body and lower-body response: leg/foot activity, toe/heel/planting/bracing changes, abdominal/chest movement or breathing estimate only when enough body surface is visible, posture shifts, tremor, shudder, and relaxation/tension cues.
4. Device/material use: lubrication application, visible lubricant sheen, sleeve/Foley/e-stim/TENS/device use, device introduction/removal, and contact/fit changes when visible or supported.
5. Telemetry only as supporting context from stored session data. Do not visually analyze or report the HR overlay, phase label, trend chart, AVG, MAX, or timer as a finding/event unless it directly supports a visible physiological or ${isExploration ? "procedure" : "stimulation"} transition.

Generic object rule: ignore mouse, remote, keyboard, phone, dark handheld object, side-table object, or generic "control object" details. Do not write "reaches for control object", "returns to control object", "handheld controller", or similar language in findings or draft events. If the hand leaves or returns to the body, describe only the relevant body/${isExploration ? "procedure" : "session"} change, such as ${isExploration ? "\"prep contact pauses\", \"tool handling resumes\", \"hand stabilizes the glans\", or \"securement is adjusted\"" : "\"genital contact pauses\", \"stimulation resumes\", \"hand leaves genital contact\", or \"hand returns to genital contact\""}. Only identify an object when it is a known or clearly visible session-relevant item such as a silicone sleeve, vibrator, lubricant bottle, Foley catheter, TENS/e-stim component, pump, towel, or explicitly user-labeled device.

Output style: write the summary as a flowing chronological observation with the most useful visible physiology and ${isExploration ? "procedure/device landmark" : "stimulation"} changes first. Keep it to 2 concise sentences. Return 2-4 finding cards only when there are useful non-repetitive observations; return fewer or none when the window adds nothing. Each finding title should be under 9 words, and each finding text should be 1 concise sentence. Return 1-3 timeline events only when there is a meaningful change or useful timestampable observation. Avoid spending a finding slot on HR overlay text, static background objects, unchanged setup, no-change filler, or the mere presence of a control object.

Draft event style: write events like concise manual timeline notes, not analysis paragraphs. Prefer observations such as ${isExploration ? "\"Drape/setup position is visible\", \"Antiseptic prep continues around the meatus\", \"Lubrication/tool handling begins\", \"Meatal engagement begins\", \"Visible Foley advancement continues\", \"Foley appears already in place while tubing is handled\", or \"Dwell comfort appears stable\"" : "\"Left foot plants further while legs tense\", \"Pelvis lifts briefly then drops\", \"Lubrication applied to glans\", \"Perineal contact resumes below scrotum\", \"Stimulation resumes with mid-shaft to glans strokes\", \"Glans remains engorged with visible sheen\", \"Deep exhale visible through abdominal drop\", or \"Whitish ejaculate clearly visible after confirmed climax marker\""} only when strongly supported by context plus visible sequence. Do not include HR/BPM/overlay/timer language in event notes unless no visible body/${isExploration ? "procedure" : "stimulation"} change exists. Do not begin event notes with "this window opens", "window opens", "this window closes", or "window closes"; write the actual observed change directly.

Visible tools and materials matter when supported: identify lubrication bottles or lubricant application only when a bottle, gel/fluid, hand motion, shine, or user/session context makes that reasonably clear. ${isExploration ? "For body exploration, avoid generic \"object\" wording when the visible material is more likely swab, gauze, wipe, drape, towel, applicator, tubing, catheter shaft, lubricant, or syringe. Use the session context to name procedure-relevant materials when the sequence and visuals make that reasonable, but do not make every frame about the final device. Do not name securement hardware, StatLock, balloon, urine return, or bag collection unless visible." : "Identify devices such as a silicone sleeve, Foley catheter, e-stim/TENS leads, pump, towel, table, or camera/monitor setup when visible or strongly supported by session context."} If uncertain, say "possible" and mark confidence low or moderate. Write findings in direct second person using "you" and "your".

Foot and body tracking dots rule: circular dots or bright reflective spots on the feet/body are tracking markers by default, not electrodes. Call them "tracking markers", "reflective markers", or "visible dots" unless e-stim, TENS, electrode pads, electrode leads, or an electrode setup is explicitly mentioned in the session context, nearby events, or the user's caption. Never write "foot electrode markers" from appearance alone.

Do not create a standalone finding or timeline event just because static tracking markers are visible. Treat unchanged marker dots as scene context. Mention them only if they materially support a movement observation, marker loss/reacquisition, toe/heel/planting state, foot asymmetry, bracing, or a clear change in marker position/visibility.

Continuity rule: each window is part of a sequential review. Use the previous reviewed window below as context. In this current window, prioritize what continues, what changed, what started, what stopped, and what became more or less visible. Do not repeat stable background details from the prior window unless they changed or are needed to explain a new observation.
No-change claims require a fresh current-frame check. Avoid repeating "resting pre-stimulation state continues", "no manual stimulation visible", "no visible cause", or similar no-action language across adjacent windows unless the current sampled frames independently support it.
${continuityContext}

Limited ${recordLabel} context for this visual pass:
${videoContext || `No additional ${recordLabel} context is available.`}

${isExploration ? "Exploration" : "Session"} window: ${fmtMmSs(reviewWindow.start)} to ${fmtMmSs(reviewWindow.end)} (${reviewWindow.start.toFixed(1)}s-${reviewWindow.end.toFixed(1)}s).
Source video window: ${fmtMmSs(sourceStart)} to ${fmtMmSs(sourceEnd)}. Video 0:00 aligns to ${recordLabel} ${fmtSignedMmSs(selectedVideoOffset)}.
Sampled frame timing in image order: ${frameTiming || "No decoded frame timing was returned."}
Telemetry in this window: ${telemetry}
${isExploration ? "Exploration procedure/devices/context" : "Session methods/devices/context"}: ${isExploration ? [
  ...(workingSession?.methods || []),
  workingSession?.exploration_type ? `Type: ${workingSession.exploration_type}` : null,
  workingSession?.devices ? `Devices: ${workingSession.devices}` : null,
  workingSession?.foley_size ? `Foley size: ${workingSession.foley_size}` : null,
  workingSession?.foley_type ? `Foley: ${workingSession.foley_type}` : null,
  workingSession?.sounding_notes ? `Instrumentation notes: ${workingSession.sounding_notes}` : null,
  workingSession?.comfort_notes ? `Comfort notes: ${workingSession.comfort_notes}` : null,
].filter(Boolean).join(" | ") || "No specific device context listed." : [
  ...(workingSession?.methods || []),
  workingSession?.sleeve_type ? `Sleeve: ${workingSession.sleeve_type}` : null,
  workingSession?.foley_type ? `Foley: ${workingSession.foley_type}` : null,
  workingSession?.tens_placement ? `TENS placement: ${workingSession.tens_placement}` : null,
  workingSession?.estim_notes ? `E-stim notes: ${workingSession.estim_notes}` : null,
].filter(Boolean).join(" | ") || "No specific device context listed."}
Nearby ${recordLabel} events: ${(workingSession?.event_timeline || [])
  .filter((event) => {
    const t = Number(event.time_s || 0);
    if (!Number.isFinite(t)) return false;
    if (isExploration) return t >= window.start - 8 && t <= window.end + 8;
    return Math.abs(t - ((window.start + window.end) / 2)) <= 75;
  })
  .map((event) => `[${fmtMmSs(event.time_s)}] ${event.note}`)
  .join(" | ") || "None nearby."}

Return concise visual findings and 1-3 proposed timeline events only when the window contains useful non-repetitive evidence. Good targets are ${isExploration ? "procedural stage changes, draping/setup, meatal or glans prep, swab/applicator action, lubrication or instillation, meatal engagement, instrument advancement/withdrawal/adjustment, resistance/rotation in sequence, urine return/bladder entry, balloon/seating, securement/alignment, dwell comfort, post-procedure tissue state, anatomy/tissue changes, comfort/tolerance cues, breathing/body settling, leg/feet tension or relaxation, and telemetry-supported procedural physiology" : "genital state changes, stimulation technique shifts, lubrication or device-use moments, pauses/resumes, erection or physical-state changes, scrotal/perineal observations, cautious moisture/sheen observations, pelvic lift/drop, breathing/abdomen cues when visible, body/feet bracing, leg tensing/relaxing, toe curl/downward planting, tremble/shudder, device/position changes, and important setup context only when it changes interpretation"}. Use low confidence or omit the finding when the evidence is ambiguous. Keep the full JSON response compact so it can finish cleanly.`,
          };
          const cardMeta = {
            label,
            window: reviewWindow,
            sourceWindow: { start: sourceStart, end: sourceEnd },
            sourceVideo: {
              id: selectedVideo?.id || null,
              label: selectedVideo?.label || "",
              filename: selectedVideo?.filename || "",
              fingerprint: selectedVideo?.fingerprint || "",
              path: selectedVideo?.path || "",
            },
            sourceVideoRole: selectedVideoRole,
            clipUrl: preview.clip_url || preview.url || "",
            thumbnailUrl: preview.frames?.[0]?.url || "",
            sampledFrames: (preview.frames || []).map((frame) => ({
              url: frame.url || frame.file_url || "",
              frameTimeSeconds: frame.frameTimeSeconds,
              recordTimeSeconds: sessionTimeForSource(frame.frameTimeSeconds, selectedVideo),
              frameIndex: frame.frameIndex,
            })),
            motionSummary: preview.motion_summary || null,
            telemetry,
          };
          const completedJob = await runBackgroundAIVideoReview({
            aiPayload,
            cardMeta,
            session,
            recordType,
            label,
            onProgress: (job) => {
              const progress = job?.progress || {};
              const countText = progress.total ? ` (${progress.current || 0}/${progress.total})` : "";
              setStatus(progress.message || `Sarah reviewing ${label} in the background${countText}…`);
            },
          });
          const ai = completedJob.result;
          const normalized = normalizeAIResult(ai, reviewWindow, selectedVideoRole, isExploration);
          const card = {
            id: `${Date.now()}-${batchNumber}-${i}`,
            label,
            window: reviewWindow,
            sourceWindow: { start: sourceStart, end: sourceEnd },
            sourceVideo: selectedVideo,
            sourceVideoRole: selectedVideoRole,
            clipUrl: preview.clip_url || preview.url,
            thumbnailUrl: preview.frames?.[0]?.url || "",
            sampledFrames: (preview.frames || []).map((frame) => ({
              url: frame.url || frame.file_url || "",
              frameTimeSeconds: frame.frameTimeSeconds,
              recordTimeSeconds: sessionTimeForSource(frame.frameTimeSeconds, selectedVideo),
              frameIndex: frame.frameIndex,
            })),
            motionSummary: preview.motion_summary,
            telemetry,
            ...normalized,
          };
          nextCards.push(card);
          setCards([...nextCards]);
        }
        if (scanMode !== "continue" || !autoContinue) break;
        cursor = nextCards[nextCards.length - 1]?.window?.end || cursor;
        setScanCursor(cursor);
        onCursorChange?.(cursor);
        if (cursor >= sessionEnd - 0.5) break;
        windowsToRun = sequentialWindows(cursor, session, timelineRows, windowCount, clipSeconds, sessionEnd);
      }
      if (scanMode === "continue" && nextCards.length) {
        setScanCursor(nextCards[nextCards.length - 1].window.end);
      }
      setStatus(`Review complete: ${nextCards.length} windows ready${autoContinue && scanMode === "continue" ? " through the current forward run" : ""}.`);
    } catch (err) {
      setError(err?.data?.error || err?.message || "AI video pass failed.");
      setStatus("");
    } finally {
      setRunning(false);
    }
  };

  const reassessExplorationSequence = async () => {
    if (!isExploration || !cards.length || running || reassessing) return;
    setReassessing(true);
    setError("");
    try {
      let revisedCards = [...cards];
      const sequenceText = cards.map((card, index) => (
        `${index + 1}. ${fmtMmSs(card.window.start)}-${fmtMmSs(card.window.end)}: ${compactText(card.summary, 280)}`
      )).join("\n");

      for (let index = 0; index < cards.length; index += 1) {
        const card = revisedCards[index];
        if (!card || isCardAccepted(card, session, acceptedIds, isExploration)) continue;
        setStatus(`Reassessing Foley sequence ${index + 1}/${cards.length}: ${fmtMmSs(card.window.start)}-${fmtMmSs(card.window.end)}`);
        const images = await sampledFrameImagePayload(card.sampledFrames || []);
        const aiPayload = {
          max_tokens: 1800,
          images,
          response_json_schema: {
            type: "object",
            properties: {
              summary: { type: "string" },
              findings: {
                type: "array",
                maxItems: 3,
                items: {
                  type: "object",
                  properties: {
                    title: { type: "string" },
                    text: { type: "string" },
                    category: { type: "string", enum: ["instrumentation", "physiology", "physical", "movement", "comfort", "environment", "equipment", "other"] },
                    confidence: { type: "string", enum: ["low", "moderate", "high"] },
                  },
                  required: ["title", "text", "category", "confidence"],
                },
              },
              events: {
                type: "array",
                maxItems: 2,
                items: {
                  type: "object",
                  properties: {
                    time_s: { type: "number" },
                    note: { type: "string" },
                    category: { type: "array", items: { type: "string", enum: EXPLORATION_EVENT_CATEGORIES.map((category) => category.value) } },
                    annotation_tags: { type: "array", items: { type: "string" } },
                    confidence: { type: "string", enum: ["low", "moderate", "high"] },
                  },
                  required: ["time_s", "note", "category", "annotation_tags", "confidence"],
                },
              },
            },
            required: ["summary", "findings", "events"],
          },
          prompt: `You are Sarah doing a second-pass BODY EXPLORATION / Foley sequence audit for one already-generated video card.

Only correct the current card. Use the sampled frames in this request as primary evidence, and use the sequence list below only to avoid repeated or impossible Foley stage claims.

Full generated sequence before reassessment:
${sequenceText}

Current card to reassess:
Window: ${fmtMmSs(card.window.start)}-${fmtMmSs(card.window.end)}
Original summary: ${card.summary}
Original findings: ${(card.findings || []).map((finding) => `${finding.title}: ${finding.text}`).join(" | ") || "None"}
Original events: ${(card.events || []).map((event) => `[${fmtMmSs(event.time_s)}] ${event.note}`).join(" | ") || "None"}
Telemetry: ${card.telemetry || "None"}

Foley correction rules:
- Foley/tubing visible means present/state, not newly inserted, placed, advanced, secured, or finalized.
- Use insertion/advancement only if the sampled frames show catheter/tool movement through the meatus in this current window.
- Use already-in-place/tubing handling when tubing or catheter is visible but the catheter is not visibly advancing.
- Do not mention StatLock, securement, adhesive securement, securement finalization, balloon inflation, bladder entry, urine confirmation, or urine collection unless that exact thing is visible in the sampled frames or explicitly stated in the current card's nearby context.
- If a prior card already claimed a Foley stage, do not repeat it as newly happening here unless the current frames independently show a new repeat.
- Prefer conservative procedure labels: drape/setup, swabbing/prep, lubrication/dilation syringe, penis stabilization, catheter positioning, visible meatal engagement, visible advancement, already-in-place catheter state, tubing/field handling, drape removal, urine collection.
- If the original card overclaimed, rewrite it more conservatively. If it was already accurate, keep it concise.

Return a corrected compact card for this same window. Keep timeline events only for meaningful visible changes; if there is no timestampable change, return an empty events array.`,
        };
        const completedJob = await runBackgroundAIVideoReview({
          aiPayload,
          cardMeta: {
            label: `${card.label} reassessment`,
            window: card.window,
            sourceWindow: card.sourceWindow,
            sourceVideo: card.sourceVideo,
            sourceVideoRole: card.sourceVideoRole,
            clipUrl: card.clipUrl,
            thumbnailUrl: card.thumbnailUrl,
            sampledFrames: card.sampledFrames,
            motionSummary: card.motionSummary,
            telemetry: card.telemetry,
          },
          session,
          recordType,
          label: `${card.label} Foley reassessment`,
          onProgress: (job) => {
            const progress = job?.progress || {};
            if (progress.message) setStatus(progress.message);
          },
        });
        const normalized = normalizeAIResult(completedJob.result, card.window, card.sourceVideoRole, true);
        revisedCards = revisedCards.map((item, itemIndex) => (
          itemIndex === index
            ? { ...item, ...normalized, reassessed: true }
            : item
        ));
        setCards(revisedCards);
      }
      setStatus("Foley sequence reassessment complete. Review corrected cards before accepting.");
    } catch (err) {
      setError(err?.data?.error || err?.message || "Foley sequence reassessment failed.");
      setStatus("");
    } finally {
      setReassessing(false);
    }
  };

  const runAudioPass = async () => {
    if (!selectedVideo?.path || audioRunning) return;
    setAudioRunning(true);
    setAudioError("");
    setAudioAccepted(false);
    setAudioStatus(`Listening from ${fmtMmSs(scanCursor)}...`);
    try {
      const result = await base44.integrations.Core.ProcessLocalVideoAudio({
        path: selectedVideo.path,
        startSeconds: sourceTimeForSession(scanCursor, selectedVideo),
        windowSeconds: audioWindowSeconds,
        maxSnippets: audioMaxSnippets,
        transcribe: true,
      });
      setAudioResult({
        ...result,
        sourceStartSeconds: result.startSeconds,
        sourceEndSeconds: result.endSeconds,
        startSeconds: sessionTimeForSource(result.startSeconds, selectedVideo),
        endSeconds: sessionTimeForSource(result.endSeconds, selectedVideo),
        sessionStartSeconds: sessionTimeForSource(result.startSeconds, selectedVideo),
        sessionEndSeconds: sessionTimeForSource(result.endSeconds, selectedVideo),
        events: (result.events || []).map((event) => ({
          ...event,
          sourceStartSeconds: event.startSeconds,
          sourceEndSeconds: event.endSeconds,
          startSeconds: sessionTimeForSource(event.startSeconds, selectedVideo),
          endSeconds: sessionTimeForSource(event.endSeconds, selectedVideo),
        })),
      });
      setAudioStatus(result.summary || "Audio pass complete.");
    } catch (err) {
      setAudioError(err?.data?.error || err?.message || "Audio pass failed.");
      setAudioStatus("");
    } finally {
      setAudioRunning(false);
    }
  };

  const acceptAudioEvents = async () => {
    const events = (audioResult?.events || []).filter((event) => event.note);
    if (!events.length) return;
    const nextEvents = [
      ...(session?.event_timeline || []),
      ...events.map((event) => eventFromAudioResult(event, selectedVideo, isExploration)),
    ].sort((a, b) => Number(a.time_s || 0) - Number(b.time_s || 0));
    const existingAnalysis = session?.[analysisField] || {};
    const audioReview = {
      source_video: {
        filename: selectedVideo?.filename || selectedVideo?.label || "",
        label: selectedVideo?.label || "",
        fingerprint: selectedVideo?.fingerprint || "",
      },
      start_s: audioResult.startSeconds,
      end_s: audioResult.endSeconds,
      source_start_s: audioResult.sourceStartSeconds ?? audioResult.startSeconds,
      source_end_s: audioResult.sourceEndSeconds ?? audioResult.endSeconds,
      timeline_offset_s: selectedVideoOffset,
      summary: audioResult.summary,
      events,
      created_at: new Date().toISOString(),
    };
    const nextAnalysis = {
      ...existingAnalysis,
      ai_audio_passes: [
        audioReview,
        ...(Array.isArray(existingAnalysis.ai_audio_passes) ? existingAnalysis.ai_audio_passes : []),
      ].slice(0, 80),
    };
    const updated = { event_timeline: nextEvents, [analysisField]: nextAnalysis };
    await entity.update(session.id, updated);
    onSessionUpdate?.({ ...session, ...updated });
    setAudioAccepted(true);
  };

  const updateCardEventNote = (cardId, eventIndex, note) => {
    setCards((currentCards) => currentCards.map((card) => (
      card.id === cardId
        ? {
            ...card,
            events: (card.events || []).map((event, index) => (
              index === eventIndex ? { ...event, note } : event
            )),
          }
        : card
    )));
  };

  const acceptEvents = async (card, eventIndexes = null) => {
    const selectedEvents = eventIndexes
      ? card.events.filter((_, index) => eventIndexes.includes(index))
      : card.events;
    const cleanedEvents = selectedEvents
      .map((event) => ({ ...event, note: String(event.note || "").trim() }))
      .filter((event) => event.note);
    if (!selectedEvents.length && !card.findings.length) return;
    if (!cleanedEvents.length && !card.findings.length) return;
    const retainedEvents = (session?.event_timeline || []).filter((event) => {
      if (event?.source !== "ai_video_pass") return true;
      const annotation = event.ai_annotation || {};
      return !sameClipRange(card.window?.start, card.window?.end, annotation.clip_start_s, annotation.clip_end_s)
        || !sameCardSource(card, {
          filename: annotation.source_video || "",
          label: annotation.source_video || "",
          fingerprint: annotation.source_video_fingerprint || "",
        });
    });
    const nextEvents = [
      ...retainedEvents,
      ...cleanedEvents.map((event, index) => eventFromCard(card, event, index, isExploration)),
    ].sort((a, b) => Number(a.time_s || 0) - Number(b.time_s || 0));
    const existingAnalysis = session?.[analysisField] || {};
    const existingVideoPassFindings = Array.isArray(existingAnalysis._video_pass_findings)
      ? existingAnalysis._video_pass_findings
      : [];
    const cardToPersist = { ...card, events: cleanedEvents };
    const persistedCard = persistedCardFrom(cardToPersist);
    const nextVideoPassFindings = [
      persistedCard,
      ...existingVideoPassFindings.filter((item) => item?.id !== persistedCard.id && !sameSavedCardClip(card, item)),
    ].slice(0, 80);
    const nextAnalysisBase = {
      ...existingAnalysis,
      _video_pass_findings: nextVideoPassFindings,
      _video_pass_findings_updated_at: persistedCard.saved_at,
      _video_pass_detail_flow: compactVideoPassFlow(nextVideoPassFindings),
    };
    const nextAnalysis = {
      ...nextAnalysisBase,
      _video_pass_digest: buildVideoPassDigestForRecord(nextAnalysisBase, isExploration),
    };
    const updated = await entity.update(session.id, {
      event_timeline: nextEvents,
      [analysisField]: nextAnalysis,
    });
    onSessionUpdate?.({ ...session, ...updated, event_timeline: nextEvents, [analysisField]: nextAnalysis });
    setAcceptedIds((prev) => new Set([...prev, card.id]));
    setExpanded((prev) => ({ ...prev, [card.id]: false }));
  };

  const acceptAllDraftCards = async () => {
    const draftCards = cards.filter((card) => !isCardAccepted(card, session, acceptedIds, isExploration));
    if (!draftCards.length) return;
    const cardsToPersist = draftCards
      .map((card) => ({
        ...card,
        events: (card.events || [])
          .map((event) => ({ ...event, note: String(event.note || "").trim() }))
          .filter((event) => event.note),
      }))
      .filter((card) => card.events.length || card.findings.length);
    if (!cardsToPersist.length) return;

    const retainedEvents = (session?.event_timeline || []).filter((event) => {
      if (event?.source !== "ai_video_pass") return true;
      const annotation = event.ai_annotation || {};
      return !cardsToPersist.some((card) => (
        sameClipRange(card.window?.start, card.window?.end, annotation.clip_start_s, annotation.clip_end_s)
          && sameCardSource(card, {
            filename: annotation.source_video || "",
            label: annotation.source_video || "",
            fingerprint: annotation.source_video_fingerprint || "",
          })
      ));
    });
    const nextEvents = [
      ...retainedEvents,
      ...cardsToPersist.flatMap((card) => card.events.map((event, index) => eventFromCard(card, event, index, isExploration))),
    ].sort((a, b) => Number(a.time_s || 0) - Number(b.time_s || 0));

    const existingAnalysis = session?.[analysisField] || {};
    const existingVideoPassFindings = Array.isArray(existingAnalysis._video_pass_findings)
      ? existingAnalysis._video_pass_findings
      : [];
    const persistedCards = cardsToPersist.map((card) => persistedCardFrom(card));
    const nextVideoPassFindings = [
      ...persistedCards,
      ...existingVideoPassFindings.filter((item) => (
        !persistedCards.some((persistedCard) => item?.id === persistedCard.id)
          && !cardsToPersist.some((card) => sameSavedCardClip(card, item))
      )),
    ].slice(0, 80);
    const updatedAt = new Date().toISOString();
    const nextAnalysisBase = {
      ...existingAnalysis,
      _video_pass_findings: nextVideoPassFindings,
      _video_pass_findings_updated_at: updatedAt,
      _video_pass_detail_flow: compactVideoPassFlow(nextVideoPassFindings),
    };
    const nextAnalysis = {
      ...nextAnalysisBase,
      _video_pass_digest: buildVideoPassDigestForRecord(nextAnalysisBase, isExploration),
    };
    const updated = await entity.update(session.id, {
      event_timeline: nextEvents,
      [analysisField]: nextAnalysis,
    });
    onSessionUpdate?.({ ...session, ...updated, event_timeline: nextEvents, [analysisField]: nextAnalysis });
    setAcceptedIds((prev) => new Set([...prev, ...cardsToPersist.map((card) => card.id)]));
    setExpanded((prev) => cardsToPersist.reduce((next, card) => ({ ...next, [card.id]: false }), { ...prev }));
  };

  if (!availableVideos.length) {
    return (
      <div className="rounded-xl border border-border bg-muted/10 p-3 text-sm text-muted-foreground">
        Link a local original video first, then Sarah can scan candidate windows and build review cards.
      </div>
    );
  }

  return (
    <div className="rounded-xl border border-border bg-muted/10 p-3">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h4 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-primary">
            <Sparkles className="h-3.5 w-3.5" /> AI Video Pass
          </h4>
          <p className="mt-1 text-xs text-muted-foreground">
            Sarah scans candidate windows, creates short preview clips, and drafts {recordLabel} timeline findings for review.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {storedAIPassEventCount > 0 && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button type="button" variant="outline" className="h-8 border-destructive/30 text-destructive hover:bg-destructive/10">
                  <Trash2 className="mr-2 h-3.5 w-3.5" />
                  Clear AI Events ({storedAIPassEventCount})
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Clear stored AI-generated annotations?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This removes {storedAIPassEventCount} Sarah video/audio pass annotation{storedAIPassEventCount === 1 ? "" : "s"} from this {recordLabel}'s timeline. Manual event notes are kept.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction onClick={clearStoredAIPassEvents} className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
                    Clear AI annotations
                  </AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          )}
          {isExploration && cards.length > 0 && (
            <Button type="button" variant="outline" onClick={reassessExplorationSequence} disabled={running || reassessing} className="h-8">
              {reassessing ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="mr-2 h-3.5 w-3.5" />}
              Reassess Foley Sequence
            </Button>
          )}
          <Button type="button" onClick={runPass} disabled={running || reassessing || !selectedVideo || !plannedWindows.length} className="h-8">
            {running ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Clapperboard className="mr-2 h-3.5 w-3.5" />}
            {scanMode === "continue" ? (scanCursor > 0 ? "Run Next Pass" : "Start at 0:00") : "Run Pass"}
          </Button>
        </div>
      </div>

      <div className="mt-3 grid gap-2 lg:grid-cols-[minmax(16rem,1fr)_auto_auto_auto_auto_auto]">
        <select
          value={selectedVideo?.path || selectedPath}
          onChange={(event) => setSelectedPath(event.target.value)}
          className="h-9 rounded-lg border border-border bg-background px-3 text-sm"
        >
          {availableVideos.map((video) => (
            <option key={video.path} value={video.path}>{video.label || video.filename || video.path}</option>
          ))}
        </select>
        <label className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 text-xs text-muted-foreground">
          View
          <select
            value={selectedVideoRole}
            onChange={(event) => setSelectedVideoRole(event.target.value)}
            className="max-w-44 bg-transparent text-foreground outline-none"
          >
            {VIDEO_ROLE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>{option.label}</option>
            ))}
          </select>
        </label>
        <label className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 text-xs text-muted-foreground">
          Mode
          <select
            value={scanMode}
            onChange={(event) => setScanMode(event.target.value)}
            className="bg-transparent text-foreground outline-none"
          >
            <option value="smart">Smart windows</option>
            <option value="continue">Continue forward</option>
          </select>
        </label>
        <label className={`flex items-center gap-2 rounded-lg border border-border bg-background px-3 text-xs ${scanMode === "continue" ? "text-muted-foreground" : "text-muted-foreground/50"}`}>
          <input
            type="checkbox"
            checked={autoContinue}
            disabled={scanMode !== "continue"}
            onChange={(event) => setAutoContinue(event.target.checked)}
            className="h-3.5 w-3.5 accent-primary"
          />
          Auto-continue
        </label>
        <label className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 text-xs text-muted-foreground">
          Windows
          <input
            type="number"
            min="1"
            max="8"
            value={windowCount}
            onChange={(event) => setWindowCount(clamp(Number(event.target.value) || 1, 1, 8))}
            className="w-12 bg-transparent text-foreground outline-none"
          />
        </label>
        <label className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 text-xs text-muted-foreground">
          Seconds
          <input
            type="number"
            min="8"
            max="30"
            value={clipSeconds}
            onChange={(event) => setClipSeconds(clamp(Number(event.target.value) || 24, 8, 30))}
            className="w-12 bg-transparent text-foreground outline-none"
          />
        </label>
      </div>
      {selectedVideoRoleHelper && (
        <p className="mt-2 rounded-lg border border-primary/15 bg-primary/5 px-3 py-2 text-xs text-muted-foreground">
          <span className="font-semibold text-primary">{videoRoleLabel(selectedVideoRole)} focus:</span> {selectedVideoRoleHelper}
        </p>
      )}

      <div className="mt-3 rounded-xl border border-border bg-background/70 p-2">
        <div className="mb-2 flex flex-wrap items-center justify-between gap-2 px-1 text-xs">
          <div className="min-w-0">
            <p className="truncate font-semibold text-foreground">
              {selectedVideo?.label || selectedVideo?.filename || "Selected local video"}
            </p>
            <p className="text-muted-foreground">
              Preview at {recordLabel} <span className="font-mono text-primary">{fmtMmSs(scanCursor)}</span>
              {" · "}source <span className="font-mono text-primary">{fmtMmSs(sourceTimeForSession(scanCursor, selectedVideo))}</span>
              {" · "}{videoRoleLabel(selectedVideoRole)} lane
            </p>
            {selectedVideoOffset !== 0 && (
              <p className="mt-1 text-[10px] text-muted-foreground">
                Saved alignment: video 0:00 = {recordLabel} <span className="font-mono text-primary">{fmtSignedMmSs(selectedVideoOffset)}</span>.
              </p>
            )}
          </div>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8"
            onClick={() => seekPreviewVideo(scanCursor)}
          >
            Jump video to cursor
          </Button>
        </div>
        {selectedVideoStreamUrl ? (
          <video
            key={selectedVideo?.path}
            ref={previewVideoRef}
            src={selectedVideoStreamUrl}
            controls
            preload="metadata"
            className="max-h-[34rem] w-full rounded-lg bg-black object-contain"
            onLoadedMetadata={(event) => {
              const duration = Number(event.currentTarget.duration);
              setMetadataDurationSeconds(Number.isFinite(duration) && duration > 0 ? duration : 0);
              seekPreviewVideo(scanCursor);
            }}
            onSeeked={(event) => {
              const nextCursor = clamp(
                sessionTimeForSource(event.currentTarget.currentTime, selectedVideo),
                0,
                Math.max(0, sessionEnd - clipSeconds),
              );
              if (Math.abs(nextCursor - scanCursor) > 0.75) {
                setScanCursor(nextCursor);
                onCursorChange?.(nextCursor);
              }
            }}
          />
        ) : (
          <div className="flex aspect-video items-center justify-center rounded-lg bg-black text-sm text-muted-foreground">
            Select a linked local video to preview it here.
          </div>
        )}
      </div>

      <div className="mt-2 flex flex-wrap gap-1.5 text-[10px] text-muted-foreground">
        {scanMode === "continue" && (
          <button
            type="button"
            onClick={resetScanCursor}
            className="rounded-full border border-primary/25 bg-primary/10 px-2 py-1 font-semibold text-primary hover:bg-primary/15"
          >
            Cursor {fmtMmSs(scanCursor)} / {fmtMmSs(sessionEnd)} · reset to 0:00
          </button>
        )}
        <div className="flex min-w-[14rem] flex-1 items-center gap-2 rounded-full border border-border bg-card px-2 py-1">
          <span className="shrink-0 text-[10px] font-semibold text-muted-foreground">Jump</span>
          <input
            type="range"
            min="0"
            max={Math.max(0, Math.round(sessionEnd))}
            step={Math.max(1, Math.round(clipSeconds))}
            value={Math.round(scanCursor)}
            onChange={(event) => setCursorFromTimeline(Number(event.target.value))}
            className="h-2 min-w-0 flex-1 accent-primary"
            aria-label="Set AI video pass cursor"
          />
          <span className="shrink-0 font-mono text-primary">{fmtMmSs(scanCursor)}</span>
        </div>
        {plannedWindows.map((window) => (
          <button
            key={`${window.start}-${window.end}`}
            type="button"
            onClick={() => setCursorFromTimeline(window.start)}
            className="rounded-full border border-border bg-card px-2 py-1 hover:border-primary/50 hover:text-primary"
            title={`Start processing at ${fmtMmSs(window.start)}`}
          >
            {fmtMmSs(window.start)}-{fmtMmSs(window.end)}
          </button>
        ))}
        {!plannedWindows.length && (
          <span className="rounded-full border border-border bg-card px-2 py-1">End reached</span>
        )}
      </div>

      {(status || error) && (
        <div className={`mt-3 rounded-lg border px-3 py-2 text-xs ${error ? "border-destructive/40 bg-destructive/10 text-destructive" : "border-primary/20 bg-primary/10 text-primary"}`}>
          {error || status}
        </div>
      )}

      <div className="mt-3 rounded-xl border border-border bg-card/60 p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h5 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-primary">
              <Mic className="h-3.5 w-3.5" /> AI Audio Pass
            </h5>
            <p className="mt-1 text-xs text-muted-foreground">
              Local audio scan from the current cursor. Only short active snippets are sent to Whisper for spoken notes.
            </p>
          </div>
          <Button type="button" size="sm" variant="outline" onClick={runAudioPass} disabled={audioRunning || !selectedVideo} className="h-8">
            {audioRunning ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Mic className="mr-2 h-3.5 w-3.5" />}
            Listen from {fmtMmSs(scanCursor)}
          </Button>
        </div>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <label className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
            Scan minutes
            <input
              type="number"
              min="1"
              max="15"
              value={Math.round(audioWindowSeconds / 60)}
              onChange={(event) => setAudioWindowSeconds(clamp((Number(event.target.value) || 5) * 60, 60, 900))}
              className="w-14 bg-transparent text-foreground outline-none"
            />
          </label>
          <label className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
            Max snippets
            <input
              type="number"
              min="1"
              max="20"
              value={audioMaxSnippets}
              onChange={(event) => setAudioMaxSnippets(clamp(Number(event.target.value) || 10, 1, 20))}
              className="w-14 bg-transparent text-foreground outline-none"
            />
          </label>
        </div>
        {(audioStatus || audioError) && (
          <div className={`mt-3 rounded-lg border px-3 py-2 text-xs ${audioError ? "border-destructive/40 bg-destructive/10 text-destructive" : "border-primary/20 bg-primary/10 text-primary"}`}>
            {audioError || audioStatus}
          </div>
        )}
        {audioResult?.events?.length > 0 && (
          <div className="mt-3 rounded-lg border border-primary/20 bg-primary/5">
            <div className="flex flex-wrap items-center justify-between gap-2 border-b border-primary/15 px-3 py-2">
              <div>
                <p className="text-[10px] font-semibold uppercase tracking-wider text-primary">Draft Audio Timeline Notes</p>
                <p className="text-[10px] text-muted-foreground">
                  {fmtMmSs(audioResult.startSeconds)} to {fmtMmSs(audioResult.endSeconds)} · {audioResult.transcribedSegments} spoken segment{audioResult.transcribedSegments === 1 ? "" : "s"}
                </p>
              </div>
              <Button type="button" size="sm" variant="outline" className="h-7" onClick={acceptAudioEvents} disabled={audioAccepted}>
                <Check className="mr-1 h-3.5 w-3.5" /> {audioAccepted ? "Accepted" : "Save Audio Notes"}
              </Button>
            </div>
            <div className="space-y-1 p-2">
              {audioResult.events.map((event, index) => (
                <div key={`${event.startSeconds}-${index}`} className="rounded-md bg-background/70 px-2 py-1.5 text-sm">
                  <span className="mr-2 font-mono font-semibold text-primary">{fmtMmSs(event.startSeconds)}</span>
                  <span>{event.note}</span>
                  {event.transcriptionError && (
                    <p className="mt-1 text-[10px] text-destructive">{event.transcriptionError}</p>
                  )}
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {cards.length > 0 && (
        <div className="mt-3 grid gap-3">
          {cards.map((card) => {
            const isExpanded = expanded[card.id];
            const accepted = isCardAccepted(card, session, acceptedIds, isExploration);
            const compactAccepted = accepted && !isExpanded;
            return (
              <article key={card.id} className={`overflow-hidden rounded-xl border bg-card transition-opacity ${accepted ? "border-primary/25 opacity-80" : "border-border"}`}>
                <div className={`${compactAccepted ? "p-3" : "grid gap-3 p-3 lg:grid-cols-[minmax(15rem,22rem)_1fr]"}`}>
                  {compactAccepted ? (
                    <div className="flex flex-wrap items-center justify-between gap-3">
                      <div className="min-w-0">
                        <div className="flex flex-wrap items-center gap-2">
                          <h5 className="font-semibold text-foreground">{card.label}</h5>
                          <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                            Accepted
                          </span>
                        </div>
                        <p className="mt-1 text-xs text-muted-foreground">
                          {card.sourceVideo?.label || card.sourceVideo?.filename} · {fmtMmSs(card.window.start)} to {fmtMmSs(card.window.end)} · {card.events.length} timeline event{card.events.length === 1 ? "" : "s"}
                          {" "}· {videoRoleLabel(card.sourceVideoRole || inferVideoRole(card.sourceVideo))}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setExpanded((prev) => ({ ...prev, [card.id]: true }))}
                        className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                      >
                        <ChevronDown className="h-3.5 w-3.5" /> Review details
                      </button>
                    </div>
                  ) : (
                  <>
                  <button
                    type="button"
                    onClick={() => setExpanded((prev) => ({ ...prev, [card.id]: !prev[card.id] }))}
                    className="group relative overflow-hidden rounded-lg border border-border bg-black text-left"
                  >
                    <video
                      src={card.clipUrl}
                      muted
                      playsInline
                      preload="metadata"
                      className={`w-full bg-black object-contain ${isExpanded ? "max-h-[28rem]" : "aspect-video"}`}
                      controls={isExpanded}
                    />
                    {!isExpanded && (
                      <div className="absolute inset-0 flex items-center justify-center bg-black/10 opacity-90 transition-opacity group-hover:opacity-100">
                        <span className="rounded-full bg-background/80 p-2 text-foreground shadow">
                          <Play className="h-5 w-5" />
                        </span>
                      </div>
                    )}
                  </button>
                  <div className="min-w-0 space-y-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div>
                        <div className="flex flex-wrap items-center gap-2">
                          <h5 className="font-semibold text-foreground">{card.label}</h5>
                          {accepted && (
                            <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-[10px] font-semibold text-primary">
                              Accepted
                            </span>
                          )}
                          {card.reassessed && (
                            <span className="rounded-full border border-amber-400/40 bg-amber-400/10 px-2 py-0.5 text-[10px] font-semibold text-amber-300">
                              Reassessed
                            </span>
                          )}
                        </div>
                        <p className="text-xs text-muted-foreground">
                          {card.sourceVideo?.label || card.sourceVideo?.filename} · {fmtMmSs(card.window.start)} to {fmtMmSs(card.window.end)}
                          {" "}· {videoRoleLabel(card.sourceVideoRole || inferVideoRole(card.sourceVideo))}
                        </p>
                      </div>
                      <button
                        type="button"
                        onClick={() => setExpanded((prev) => ({ ...prev, [card.id]: !prev[card.id] }))}
                        className="inline-flex items-center gap-1 rounded-md border border-border px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                      >
                        {isExpanded ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
                        {isExpanded ? "Collapse" : "Expand clip"}
                      </button>
                    </div>
                    {Array.isArray(card.sampledFrames) && card.sampledFrames.length > 0 && (
                      <details className="rounded-lg border border-border bg-muted/15">
                        <summary className="cursor-pointer px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                          Sampled Frames Sarah Saw ({card.sampledFrames.length})
                        </summary>
                        <div className="grid grid-cols-3 gap-2 p-2 sm:grid-cols-4 lg:grid-cols-6">
                          {card.sampledFrames.map((frame, index) => (
                            <a
                              key={`${frame.url || "frame"}-${index}`}
                              href={frame.url}
                              target="_blank"
                              rel="noreferrer"
                              className="group overflow-hidden rounded-md border border-border bg-background"
                              title={`${recordLabel} ${fmtMmSs(frame.recordTimeSeconds)} · source ${fmtMmSs(frame.frameTimeSeconds)}`}
                            >
                              <img
                                src={frame.url}
                                alt={`Sampled frame ${index + 1}`}
                                loading="lazy"
                                className="aspect-video w-full object-cover transition-transform group-hover:scale-[1.03]"
                              />
                              <span className="block truncate px-1.5 py-1 text-[10px] text-muted-foreground">
                                {fmtMmSs(frame.recordTimeSeconds)}
                              </span>
                            </a>
                          ))}
                        </div>
                      </details>
                    )}
                    <p className="text-sm leading-relaxed text-foreground/90">{card.summary}</p>
                    <p className="rounded-md border border-primary/15 bg-primary/5 px-2 py-1 text-[10px] text-muted-foreground">
                      Accepting this card saves the summary, finding cards, clip range, and draft events into the {recordLabel} AI details.
                    </p>
                    <div className="space-y-1.5">
                      {card.findings.map((finding, index) => (
                        <div key={`${finding.title}-${index}`} className="rounded-lg border border-border bg-muted/20 px-3 py-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs font-semibold text-primary">{finding.title}</span>
                            <span className="rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">{finding.confidence}</span>
                          </div>
                          <p className="mt-1 text-sm leading-relaxed text-foreground/85">{finding.text}</p>
                        </div>
                      ))}
                    </div>
                    {card.events.length > 0 && (
                      <div className="rounded-lg border border-primary/20 bg-primary/5 p-2">
                        <div className="mb-1 flex items-center justify-between gap-2">
                          <span className="text-[10px] font-semibold uppercase tracking-wider text-primary">Draft Video Sync Events</span>
                          <Button type="button" size="sm" variant="outline" className="h-7" onClick={() => acceptEvents(card)} disabled={accepted}>
                            <Check className="mr-1 h-3.5 w-3.5" /> {accepted ? "Accepted" : "Save Findings + Events"}
                          </Button>
                        </div>
                        <div className="space-y-1">
                          {card.events.map((event, index) => (
                            <div key={`${event.time_s}-${index}`} className="flex items-start gap-2 rounded-md bg-background/60 px-2 py-1.5 text-xs">
                              <span className="mt-1.5 shrink-0 font-mono font-bold text-primary">{fmtMmSs(event.time_s)}</span>
                              <textarea
                                value={event.note || ""}
                                onChange={(changeEvent) => updateCardEventNote(card.id, index, changeEvent.target.value)}
                                disabled={accepted}
                                rows={2}
                                className="min-h-10 flex-1 resize-y rounded-md border border-border bg-background/80 px-2 py-1.5 leading-relaxed text-foreground/85 outline-none focus:border-primary/50 disabled:cursor-not-allowed disabled:opacity-70"
                                aria-label={`Edit draft event note ${index + 1}`}
                              />
                            </div>
                          ))}
                        </div>
                      </div>
                    )}
                    <p className="text-[10px] text-muted-foreground">{card.telemetry}</p>
                  </div>
                  </>
                  )}
                </div>
              </article>
            );
          })}
          {cards.some((card) => !isCardAccepted(card, session, acceptedIds, isExploration)) && (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-primary/25 bg-primary/5 px-3 py-2">
              <div>
                <p className="text-xs font-semibold uppercase tracking-wider text-primary">Batch Review Ready</p>
                <p className="text-xs text-muted-foreground">
                  Saves all unaccepted Sarah video-pass finding cards and edited timeline events in this list.
                </p>
              </div>
              <Button type="button" size="sm" onClick={acceptAllDraftCards} className="h-8">
                <Check className="mr-2 h-3.5 w-3.5" /> Accept All Findings & Events
              </Button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
