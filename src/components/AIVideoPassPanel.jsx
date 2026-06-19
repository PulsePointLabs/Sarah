import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronDown, ChevronUp, Clapperboard, Copy, Eye, Loader2, Mic, Play, ShieldCheck, Sparkles, Trash2 } from "lucide-react";
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
import {
  compactFrameRefs,
  buildSarahLocalAnnotationCards,
  displayCandidate,
  displayNotConfirmed,
  humanizeLocalVisionLabel,
  localVisionSummaryCounts,
  localVisionVerdict,
} from "@/lib/localVisionDisplay";
import { sessionContextEvidenceText } from "@/lib/sessionContext";
import { EXPLORATION_EVENT_CATEGORIES } from "@/components/session-form/EventTimelineSection";
import {
  buildBodyExplorationVideoPassDigest,
  buildSessionVideoPassDigest,
  normalizeBodyExplorationVideoPassFindings,
  normalizeSessionVideoPassFindings,
} from "@/lib/visualEvidence";
import { SARAH_APP_OVERLAY_TELEMETRY_RULE } from "@/lib/aiGrounding";
import {
  deviceEvidenceStageForText,
  hasUnsupportedMeatusContactClaim as hasUnsupportedMeatusContactClaimGuard,
  hasUnsupportedSleeveUseClaim as hasUnsupportedSleeveUseClaimGuard,
  sanitizeFoleyProcedureText as sanitizeFoleyProcedureTextGuard,
  sanitizeSecondPersonProcedureLanguage,
  sanitizeSleeveSessionText,
} from "@/lib/videoPassTextGuards";
import { reduceConsistencyPhraseRepetition } from "@/utils/aiTextRepair";

function fmtMmSs(totalSeconds) {
  const v = Math.max(0, Math.round(Number(totalSeconds) || 0));
  const m = Math.floor(v / 60);
  const s = v % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function fmtClockTime(value) {
  if (!value) return "";
  try {
    return new Date(value).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" });
  } catch {
    return "";
  }
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

function humanStatus(value = "") {
  if (value && typeof value === "object") {
    return Object.entries(value)
      .filter(([, entryValue]) => entryValue != null && entryValue !== "")
      .slice(0, 5)
      .map(([key, entryValue]) => `${key.replace(/_/g, " ")} ${String(entryValue).replace(/_/g, " ")}`)
      .join(" · ");
  }
  return String(value || "")
    .replace(/_/g, " ")
    .replace(/\bnot confirmed\b/gi, "not confirmed")
    .replace(/\bunknown\b/gi, "unknown")
    .trim();
}

function progressText(value = "") {
  if (!value) return "";
  if (typeof value === "string") return value.replace(/\s+/g, " ").trim();
  if (typeof value === "object") return humanStatus(value);
  return String(value).replace(/\s+/g, " ").trim();
}

const ANATOMICAL_LATERALITY_RULE = `Anatomical laterality rule: "your left" and "your right" must always mean Ben's anatomical left/right, not the viewer's screen-left/screen-right. When you are facing the camera, your anatomical right appears on the viewer's left; when the view is from your feet, overhead, mirrored, supine, rotated, close-cropped, or composite, laterality can flip or become ambiguous. Do not guess left/right from image position alone. Preserve anatomical identity across views: a bruise, mole, scar, catheter/tubing position, pelvic finding, genital finding, or skin mark on your anatomical right remains right-sided when you move from supine to standing, turn toward the camera, rotate, or appear in another camera lane. Track stable landmarks such as your umbilicus, sternum, pubic mound, inguinal creases, thighs, known scars, moles, bruises, catheter exit angle, and manual side notes before assigning side. If anatomical laterality is not unmistakable from body landmarks, camera orientation, tracking labels, or manual notes, use "screen-left/screen-right", "near/far", "upper/lower", "one hand/the other hand", or "one leg/the other leg" instead of anatomical left/right. For head-to-toe, masturbation, Foley/body exploration, and lower-body assessments, explicitly preserve this distinction.`;

const PRODUCTION_PROCEDURE_ANNOTATION_RULE = `Production procedure narration rule: output should be useful for later viewer-facing review, not an internal correction log. Do not write "possible visual/timeline mismatch", "correction", "video-pass conflict", "timeline of record", "not directly documented", "not visible", or "could not confirm" unless the uncertainty changes safety or the event should be rejected. If manual notes resolve the sequence, silently use the manual notes and write the clean visible/procedural action. Visible hands are your hands; write "your hand" or "your hands". Use "your gloved hand" only when glove/sterile technique matters. Never write "a gloved hand", "the gloved hand", "operator", "operator's hand", "clinician", or "assistant". Do not infer povidone-iodine from natural tissue color, warm lighting, shadow, or camera tone; only call iodine/staining when the swab/applicator or nearby manual note supports iodine at that stage. If manual notes place swabbing after draping, do not describe swabbing or iodine staining before draping. If two swabbing passes are logged, describe two passes total, not an extra prep pass.`;

function formatLocalVisionRollingState(state) {
  if (!state) return "";
  if (typeof state === "string") return state.replace(/\s+/g, " ").trim();
  if (typeof state !== "object") return "";
  const parts = [
    state.latest_candidate ? `latest checkpoint: ${humanStatus(state.latest_candidate)}` : null,
    state.scan_position_ms != null ? `through ${fmtMmSs(Number(state.scan_position_ms) / 1000)}` : null,
    state.manual_stimulation ? `manual stimulation ${humanStatus(state.manual_stimulation)}` : null,
    state.fluid_event ? `fluid event ${humanStatus(state.fluid_event)}` : null,
    state.anatomy_visibility && state.anatomy_visibility !== "unknown" ? `visibility ${humanStatus(state.anatomy_visibility)}` : null,
    state.confirmed_findings_count != null ? `${state.confirmed_findings_count} confirmed` : null,
    state.strong_candidates_count != null ? `${state.strong_candidates_count} candidate${state.strong_candidates_count === 1 ? "" : "s"}` : null,
  ].filter(Boolean);
  return parts.join(" · ");
}

function formatLocalVisionProgressMessage(progress = {}) {
  const phase = String(progress.phase || "running").replace(/_/g, " ");
  const message = progressText(progress.message);
  const candidate = progress.latest_candidate_window;
  const rollingState = formatLocalVisionRollingState(progress.latest_rolling_state || progress.rolling_state);
  const latestSummary = progressText(progress.latest_summary);
  const candidateText = candidate?.type
    ? `${humanStatus(candidate.type)} near ${fmtMmSs((candidate.start_ms || 0) / 1000)}-${fmtMmSs((candidate.end_ms || candidate.start_ms || 0) / 1000)}`
    : "";

  if (phase.includes("qwen review") && candidateText) {
    const qwen = progress.qwenCallsTotal != null
      ? `Qwen check ${Number(progress.qwenCallsCompleted || 0) + 1 > Number(progress.qwenCallsTotal) ? progress.qwenCallsCompleted : `${Number(progress.qwenCallsCompleted || 0) + 1}/${progress.qwenCallsTotal}`}`
      : "Qwen check";
    return `${qwen}: reviewing ${candidateText}.`;
  }
  if (phase.includes("qwen window sampling") && candidateText) {
    return `Sampling evidence frames for ${candidateText}.`;
  }
  if (latestSummary) return latestSummary;
  if (rollingState) return `Rolling read: ${rollingState}.`;
  if (message) return message;
  return "";
}

function localVisionProgressLogEntry(progress = {}) {
  const phase = String(progress.phase || "running").replace(/_/g, " ");
  const message = progressText(progress.message);
  const latestSummary = progressText(progress.latest_summary);
  const rollingSummary = formatLocalVisionRollingState(progress.latest_rolling_state || progress.rolling_state);
  const latestFrame = progress.latest_frame;
  const candidate = progress.latest_candidate_window;
  const details = [
    progress.framesScanned != null ? `${progress.framesScanned} frames scanned` : null,
    progress.scanned_frames != null ? `${progress.scanned_frames} frames scanned` : null,
    progress.candidatesFound != null ? `${progress.candidatesFound} candidates found` : null,
    progress.candidate_events != null ? `${progress.candidate_events} candidates` : null,
    progress.qwenCallsCompleted != null && progress.qwenCallsTotal != null ? `${progress.qwenCallsCompleted}/${progress.qwenCallsTotal} Qwen checks` : null,
    progress.confirmedFindingsCount != null ? `${progress.confirmedFindingsCount} confirmed` : null,
    progress.strongCandidatesCount != null ? `${progress.strongCandidatesCount} strong candidates` : null,
    progress.blocked_claims != null ? `${progress.blocked_claims} blocked claims` : null,
    candidate?.type ? `${humanStatus(candidate.type)} ${fmtMmSs((candidate.start_ms || 0) / 1000)}-${fmtMmSs((candidate.end_ms || candidate.start_ms || 0) / 1000)}` : null,
    candidate?.score != null ? `score ${Math.round(Number(candidate.score || 0) * 100)}%` : null,
    candidate?.roi?.label ? `ROI ${candidate.roi.label}${candidate.roi.motion_score != null ? ` ${Math.round(Number(candidate.roi.motion_score || 0) * 100)}%` : ""}` : null,
    latestFrame?.frame_id ? `${latestFrame.frame_id} @ ${fmtMmSs((latestFrame.time_ms || 0) / 1000)}` : null,
  ].filter(Boolean);
  const text = formatLocalVisionProgressMessage(progress) || rollingSummary || latestSummary || message || details.join(" · ");
  if (!text) return null;
  return {
    key: [
      progress.phase,
      message,
      latestSummary,
      rollingSummary,
      latestFrame?.frame_id,
      latestFrame?.time_ms,
      progress.framesScanned,
      progress.scanned_frames,
      progress.candidatesFound,
      progress.candidate_events,
      progress.qwenCallsCompleted,
      progress.confirmedFindingsCount,
      progress.strongCandidatesCount,
      progress.blocked_claims,
      candidate?.candidate_id,
      candidate?.type,
      candidate?.start_ms,
      candidate?.score,
    ].filter((value) => value != null).join("|"),
    phase,
    text,
    details: details.join(" · "),
    at: Date.now(),
  };
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
    .filter((event) => String(event?.note || "").trim() && !isAIGeneratedPassEvent(event))
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

function hasUnsupportedFoleySecurementClaim(item) {
  const text = `${item?.title || ""} ${item?.text || item?.findingText || ""} ${item?.note || ""}`.toLowerCase();
  return /(statlock|securement|securement device|securement work|securement finalization|anchor|anchoring|anchored)/.test(text)
    && /(foley|catheter|tubing|yellow|shaft|glans|penis|drape|field|gloved hand|hand)/.test(text);
}

function hasUnsupportedFoleyStageForecast(item) {
  const text = `${item?.title || ""} ${item?.text || item?.findingText || ""} ${item?.note || ""}`.toLowerCase();
  return /(meatal engagement|catheter engagement|foley engagement|insertion|advancement|advanced|entering|passes? (?:the )?meatus|catheter positioning|foley positioning)/.test(text)
    && /(imminent|about to|appears to|appears imminent|suggesting|consistent with|prepar(?:e|ing)|nearby|toward|lowering toward|positioning)/.test(text)
    && !/(visible advancement|visibly advancing|visible tip|tip visibly|tip at|entering the meatus is visible|through the meatus|less (?:of the )?(?:foley|catheter) (?:is )?visible|external (?:foley|catheter|shaft) (?:length )?(?:shortens|decreases|reduces)|progressive(?:ly)? (?:shortening|less visible)|remaining visible length)/.test(text);
}

function hasBlueObjectFoleyMislabel(item) {
  const text = `${item?.title || ""} ${item?.text || item?.findingText || ""} ${item?.note || ""}`.toLowerCase();
  return /(blue[-\s]?(?:tipped|capped)?\s+(?:object|item|bottle|cap)|blue\s+(?:object|item|bottle|cap))/.test(text)
    && /(foley|catheter|drainage tubing|catheter port|catheter already|already in place|right field edge|field edge|tray)/.test(text)
    && !/(catheter tip (?:is )?(?:visible|at|entering)|tip (?:is )?(?:visible|at|entering) (?:the )?meatus|shaft (?:is )?(?:visible|at|entering)|through (?:the )?meatus|connected tubing)/.test(text);
}

function hasUnsupportedAlreadyPlacedClaim(item) {
  const text = `${item?.title || ""} ${item?.text || item?.findingText || ""} ${item?.note || ""}`.toLowerCase();
  return /(already\s+(?:in\s+place|placed|inserted)|post[-\s]?placement|continued\s+dwell|dwell\s+interval|placement\s+(?:is\s+)?complete|completed\s+placement|catheter\s+(?:is\s+)?seated|seated\s+catheter|catheter\s+has\s+been\s+placed)/.test(text)
    && /(now\s+(?:clearly\s+)?visible|newly\s+visible|first\s+visible|becomes?\s+visible|change\s+from\s+prior|exits?\s+(?:the\s+)?glans|exiting\s+(?:the\s+)?glans|at\s+(?:the\s+)?glans|glans\/meatus|meatus|meatal|catheter\s+junction|yellow\s+tubing|foley\s+tubing|catheter\s+tubing|tubing\s+(?:visible|exiting|routing|handling)|gloved\s+hand|field\s+handling)/.test(text)
    && !/(manual(?:ly)?\s+(?:confirmed|logged)|explicitly\s+logged|urine\s+(?:return|visible|collection|collected)|balloon\s+(?:inflation|inflated)|bag\s+collection|drape\s+removal\s+with\s+urine)/.test(text);
}

function sanitizeExplorationFoleyText(text) {
  const value = neutralizeIntentLanguage(text);
  const { text: next } = sanitizeFoleyProcedureTextGuard(value);
  return reduceConsistencyPhraseRepetition(sanitizeSecondPersonProcedureLanguage(next)
    .replace(/\bthe\s+subject'?s\b/gi, "your")
    .replace(/\bsubject'?s\b/gi, "your")
    .replace(/\bthe\s+subject\b/gi, "you")
    .replace(/\bsubject\b/gi, "you")
    .replace(/\bthe\s+patient'?s\b/gi, "your")
    .replace(/\bpatient'?s\b/gi, "your")
    .replace(/\bthe\s+patient\b/gi, "you")
    .replace(/\bpatient\b/gi, "you")
    .replace(/\bthe\s+participant'?s\b/gi, "your")
    .replace(/\bparticipant'?s\b/gi, "your")
    .replace(/\bthe\s+participant\b/gi, "you")
    .replace(/\bparticipant\b/gi, "you")
    .replace(/\bthe\s+operator'?s\b/gi, "your")
    .replace(/\boperator'?s\b/gi, "your")
    .replace(/\bthe\s+operator\b/gi, "your gloved hand")
    .replace(/\boperator\b/gi, "your gloved hand")
    .replace(/\bthe\s+user'?s\b/gi, "your")
    .replace(/\buser'?s\b/gi, "your")
    .replace(/\bthe\s+user\b/gi, "you")
    .replace(/\buser\b/gi, "you")
    .replace(/\bthe\s+gloved\s+person'?s\b/gi, "your")
    .replace(/\bthe\s+gloved\s+person\b/gi, "your gloved hand")
    .replace(/\bgloved\s+person\b/gi, "your gloved hand")
    .replace(/\bthe\s+helper'?s\b/gi, "your")
    .replace(/\bthe\s+helper\b/gi, "your gloved hand")
    .replace(/\bhelper\b/gi, "your gloved hand")
    .replace(/\bleft\s+(blue-gloved\s+)?hand\b/gi, "one $1hand")
    .replace(/\bright\s+(blue-gloved\s+)?hand\b/gi, "the other $1hand")
    .replace(/\bleft\s+hand\b/gi, "one hand")
    .replace(/\bright\s+hand\b/gi, "the other hand")
    .replace(/\s+/g, " ")
    .trim(), 1);
}

function sanitizeRegularSessionDeviceText(text) {
  const value = neutralizeIntentLanguage(text);
  return reduceConsistencyPhraseRepetition(sanitizeSleeveSessionText(value).text, 1);
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
    helper: "Stimulation, penile/scrotal state, devices, lubrication, and composite context.",
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
  return "This is a main/genital-composite session view. Actively track visible stimulation mechanics and genital physiology: hand-to-genital contact, stroking/shaft or glans motion, sleeve/device movement, penile state, scrotal/testicular position, scrotal lift/retraction or relaxation/descent, scrotal skin tension/wrinkling, visible tissue color or sheen changes, perineal or scrotal-base contact, lubricant application, grip/contact changes, pauses/resumes, and device-plus-stimulation combinations such as Foley in place while stimulation continues. A Foley catheter, sleeve, lubricant, or other device being present does not make the window a resting state. Only call the window resting/no stimulation when sampled frames show no hand/device/body contact or stimulation motion across the window.";
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
  const cleanTextForMode = (text) => (
    isExploration ? sanitizeExplorationFoleyText(text) : sanitizeRegularSessionDeviceText(text)
  );
  return {
    summary: cleanTextForMode(value?.summary || findings[0]?.text || "Review complete."),
    findings: findings.map((finding) => ({
      title: hasUnsupportedFoleySecurementClaim(finding)
        ? "Tubing/field handling"
        : hasUnsupportedAlreadyPlacedClaim(finding)
        ? "Placement not confirmed"
        : hasUnsupportedMeatusContactClaimGuard(finding)
        ? "Meatus contact not confirmed"
        : hasUnsupportedFoleyStageForecast(finding)
        ? "Field preparation"
        : hasUnsupportedSleeveUseClaimGuard(finding)
        ? "Sleeve use not confirmed"
        : cleanTextForMode(finding.title || "Finding"),
      text: cleanTextForMode(finding.text || finding.findingText || ""),
      confidence: (hasUnsupportedFoleySecurementClaim(finding) || hasUnsupportedFoleyStageForecast(finding) || hasUnsupportedAlreadyPlacedClaim(finding) || hasUnsupportedMeatusContactClaimGuard(finding) || hasUnsupportedSleeveUseClaimGuard(finding)) && finding.confidence === "high" ? "moderate" : finding.confidence || "moderate",
      category: finding.category || "other",
    })).filter((finding) => finding.text && !isStaticTrackingMarkerFinding(finding) && !isTelemetryOnlyFinding(finding) && !isGenericControlObjectMention(finding) && !isLowValueNoChangeForRole(finding, selectedRole) && !isOutOfLaneForRole(finding, selectedRole)),
    events: events.map((event) => {
      const unsupportedFoleyForecast = isExploration && hasUnsupportedFoleyStageForecast(event);
      const unsupportedAlreadyPlaced = isExploration && hasUnsupportedAlreadyPlacedClaim(event);
      const unsupportedMeatusClaim = isExploration && hasUnsupportedMeatusContactClaimGuard(event);
      const unsupportedSleeveUse = !isExploration && hasUnsupportedSleeveUseClaimGuard(event);
      const note = cleanTextForMode(cleanDraftEventNote(event.note || event.text || ""));
      return {
        time_s: clamp(
          Number.isFinite(Number(event.time_s)) ? Number(event.time_s) : fallbackWindow.start,
          fallbackWindow.start,
          fallbackWindow.end,
        ),
        note,
        category: (unsupportedFoleyForecast || unsupportedMeatusClaim) ? ["setup"] : normalizeDraftEventCategories(event.category, note, fallbackWindow, isExploration),
        annotation_tags: Array.isArray(event.annotation_tags) ? event.annotation_tags : ["other_context"],
        confidence: (unsupportedFoleyForecast || unsupportedAlreadyPlaced || unsupportedMeatusClaim || unsupportedSleeveUse) && event.confidence === "high" ? "moderate" : event.confidence || "moderate",
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
  const sourceName = card.localVision ? "local_qwen25vl_video_pass" : "sarah_video_pass";
  return {
    time_s: Number(event.time_s || card.window.start),
    note: event.note,
    category: normalizeEventCategories(event.category, isExploration),
    source: "ai_video_pass",
    ai_generated: true,
    annotation_origin: "ai",
    annotation_tags: event.annotation_tags?.length ? event.annotation_tags : ["other_context"],
    ai_annotation: {
      source: sourceName,
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
    source: card.localVision ? "local_qwen25vl_video_pass" : "ai_video_pass",
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
    local_vision_result_id: card.localVisionResultId || null,
  };
}

function confidenceWord(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return "moderate";
  if (numeric >= 0.75) return "high";
  if (numeric >= 0.45) return "moderate";
  return "low";
}

function arrayFromMaybe(value) {
  if (Array.isArray(value)) return value.filter(Boolean);
  if (value == null) return [];
  return String(value).split(/[,\s]+/).map((item) => item.trim()).filter(Boolean);
}

const LOCAL_VISION_LABELS = {
  foley_catheter: "Foley catheter",
  foley_tubing: "Foley tubing",
  statlock_or_securement_device: "StatLock/securement",
  adhesive_securement_device: "Adhesive securement",
  gloved_hands_visible: "Gloved hands",
  prep_materials: "Prep materials",
  hands_touching_glans_or_meatus: "Hand/meatus contact",
  catheter_tip_at_or_entering_meatus: "Tip at meatus",
  visible_advancement_motion: "Advancement motion",
  tubing_routing_or_field_handling: "Tubing/field handling",
  urine_visible: "Urine return",
  balloon_inflation_visible: "Balloon inflation",
  drape_applied_adjusted_or_removed: "Drape movement",
  genital_state_visible: "Genital state",
  erection_state_visible: "Erection state",
  genital_visibility_obscured: "Genital visibility",
  hand_contact_with_genitals_visible: "Hand/genital contact",
  stroking_motion_visible: "Stroking motion",
  pelvic_motion_visible: "Pelvic motion",
  body_tension_or_relaxation_visible: "Body tension/relaxation",
  leg_or_foot_position_visible: "Leg/foot position",
  toe_curling_or_foot_flexion_visible: "Toe/foot flexion",
  ejaculation_or_fluid_release_visible: "Visible fluid release",
  visible_fluid_present: "Visible fluid",
  fluid_stream_or_droplet_visible: "Stream/droplet",
};

const LOCAL_ANALYSIS_TYPES = [
  { value: "general_session", label: "General Session" },
  { value: "body_exploration", label: "Body Exploration" },
  { value: "masturbation", label: "Masturbation Session" },
  { value: "foley_procedure", label: "Foley / Procedure Review" },
];

const LOCAL_ANALYSIS_MODES = [
  { value: "fast_preview", label: "Fast Forward Review", helper: "Cheap chronological CV scan with only a few targeted Qwen checks." },
  { value: "balanced", label: "Balanced Forward Review", helper: "Recommended. Chronological CV scan plus targeted Qwen candidate review." },
  { value: "deep_forensic", label: "Deep Forward Review", helper: "Slow/GPU-intensive. More candidate windows and Qwen calls." },
];

const LOCAL_VISION_ROI_PRESETS = {
  genital_hand_roi: {
    label: "Genital / hand activity",
    type: "genital_hand_roi",
    x: 0.2,
    y: 0.35,
    width: 0.6,
    height: 0.38,
  },
  feet_legs_roi: {
    label: "Feet / legs",
    type: "feet_legs_roi",
    x: 0.05,
    y: 0.55,
    width: 0.9,
    height: 0.38,
  },
  full_body_roi: {
    label: "Full body / posture",
    type: "full_body_roi",
    x: 0.05,
    y: 0.05,
    width: 0.9,
    height: 0.9,
  },
  foley_procedure_field_roi: {
    label: "Procedure field",
    type: "foley_procedure_field_roi",
    x: 0.18,
    y: 0.3,
    width: 0.64,
    height: 0.42,
  },
  tubing_bag_roi: {
    label: "Tubing / bag field",
    type: "tubing_bag_roi",
    x: 0.55,
    y: 0.2,
    width: 0.4,
    height: 0.55,
  },
};

function normalizeUiRoi(roi, index = 0) {
  const x = clamp(Number(roi?.x ?? 0), 0, 0.99);
  const y = clamp(Number(roi?.y ?? 0), 0, 0.99);
  return {
    id: roi?.id || `roi_${Date.now()}_${index}`,
    label: roi?.label || "Custom ROI",
    type: roi?.type || "custom_roi",
    x,
    y,
    width: clamp(Number(roi?.width ?? 0.25), 0.01, 1 - x),
    height: clamp(Number(roi?.height ?? 0.25), 0.01, 1 - y),
  };
}

function inferLocalAnalysisType(recordType, session) {
  const explicit = String(session?.local_vision_analysis_type || session?.analysis_type || session?.session_type || "").toLowerCase();
  if (["general_session", "body_exploration", "masturbation", "foley_procedure"].includes(explicit)) return explicit;
  if (["masturbation", "masturbation_session"].includes(explicit)) return "masturbation";
  if (["foley", "foley_procedure", "procedure"].includes(explicit)) return "foley_procedure";
  if (recordType === "body_exploration" || session?.standalone_body_exploration) return "body_exploration";
  return "general_session";
}

function localAnalysisTypeLabel(value) {
  return LOCAL_ANALYSIS_TYPES.find((item) => item.value === value)?.label || "General Session";
}

function localAnalysisModeLabel(value) {
  return LOCAL_ANALYSIS_MODES.find((item) => item.value === value)?.label || "Balanced Review";
}

function localAnalysisModeHelper(value) {
  return LOCAL_ANALYSIS_MODES.find((item) => item.value === value)?.helper || LOCAL_ANALYSIS_MODES[1].helper;
}

function adaptivePolicyForMode(mode) {
  if (mode === "fast_preview") {
    return {
      candidatePolicy: {
        baselineFps: 0.35,
        motionPeakFps: 2,
        maxCandidateWindows: 8,
        candidateWindowPreMs: 3000,
        candidateWindowPostMs: 3000,
        dedupe: true,
        thumbnailWidth: 512,
      },
      qwenPolicy: {
        enabled: true,
        maxQwenWindows: 3,
        maxFramesPerWindow: 6,
        splitByDomain: true,
      },
    };
  }
  if (mode === "deep_forensic") {
    return {
      candidatePolicy: {
        baselineFps: 1,
        motionPeakFps: 4,
        maxCandidateWindows: 40,
        candidateWindowPreMs: 5000,
        candidateWindowPostMs: 5000,
        dedupe: true,
        thumbnailWidth: 512,
      },
      qwenPolicy: {
        enabled: true,
        maxQwenWindows: 30,
        maxFramesPerWindow: 8,
        splitByDomain: true,
      },
    };
  }
  return {
    candidatePolicy: {
      baselineFps: 0.5,
      motionPeakFps: 2,
      maxCandidateWindows: 18,
      candidateWindowPreMs: 3000,
      candidateWindowPostMs: 3000,
      dedupe: true,
      thumbnailWidth: 512,
    },
    qwenPolicy: {
      enabled: true,
      maxQwenWindows: 12,
      maxFramesPerWindow: 8,
      splitByDomain: true,
    },
  };
}

function prettyLocalVisionLabel(label = "") {
  const key = String(label || "").trim();
  return LOCAL_VISION_LABELS[key] || key.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function localVisionEvidenceText(frameRefs = []) {
  const refs = arrayFromMaybe(frameRefs);
  if (!refs.length) return "";
  if (refs.length <= 3) return `Evidence frames: ${refs.join(", ")}.`;
  return `Evidence spans ${refs[0]}-${refs[refs.length - 1]} (${refs.length} frames).`;
}

function localVisionStatusCounts(items = []) {
  return arrayFromMaybe(items).reduce((counts, item) => {
    const status = item?.status || "unknown";
    counts[status] = (counts[status] || 0) + 1;
    return counts;
  }, {});
}

function localVisionStatusSummary(items = []) {
  const counts = localVisionStatusCounts(items);
  return [
    counts.visible ? `${counts.visible} visible` : null,
    counts.uncertain ? `${counts.uncertain} uncertain` : null,
    counts.not_visible ? `${counts.not_visible} not visible` : null,
  ].filter(Boolean).join(" · ") || "No returned rows";
}

function localVisionEvidenceRows(items = [], limit = 18) {
  return arrayFromMaybe(items)
    .slice()
    .sort((a, b) => {
      const order = { visible: 0, uncertain: 1, not_visible: 2 };
      const statusDelta = (order[a?.status] ?? 3) - (order[b?.status] ?? 3);
      if (statusDelta) return statusDelta;
      return Number(b?.confidence || 0) - Number(a?.confidence || 0);
    })
    .slice(0, limit);
}

function localVisionTierRows(items = [], limit = 12) {
  return arrayFromMaybe(items)
    .slice()
    .sort((a, b) => Number(a?.start_ms ?? a?.startMs ?? 0) - Number(b?.start_ms ?? b?.startMs ?? 0))
    .slice(0, limit);
}

function localVisionMsRange(item = {}) {
  const start = Number(item.start_ms ?? item.startMs ?? item.time_ms ?? 0);
  const end = Number(item.end_ms ?? item.endMs ?? item.start_ms ?? item.startMs ?? item.time_ms ?? start);
  return { start, end: Math.max(start, end) };
}

function formatLocalVisionMs(ms) {
  return fmtMmSs((Number(ms) || 0) / 1000);
}

function localVisionCoverageSummary(result = {}) {
  const range = result.range || result.window || {};
  const startMs = Number(range.startMs ?? range.start_ms ?? 0);
  const endMs = Number(range.endMs ?? range.end_ms ?? startMs);
  const debug = result.debug || {};
  const rawCounts = debug.rawEvidenceCounts || {};
  const candidateCount = arrayFromMaybe(result.candidate_windows).length;
  const coverageCount = arrayFromMaybe(result.coverage_segments).length;
  const qwenCalls = Number(debug.qwenCalls ?? rawCounts.qwen_results ?? 0);
  const frames = Number(arrayFromMaybe(result.evidence_frames).length || arrayFromMaybe(result.frame_evidence).length || debug.cvPrepassStats?.framesScanned || 0);
  const actionable = arrayFromMaybe(result.actionable_findings);
  const candidates = arrayFromMaybe(result.strong_candidates);
  const confirmedRange = actionable.length
    ? actionable.reduce((acc, item) => {
      const rangeInfo = localVisionMsRange(item);
      return {
        start: Math.min(acc.start, rangeInfo.start),
        end: Math.max(acc.end, rangeInfo.end),
      };
    }, { start: Infinity, end: 0 })
    : null;
  return {
    rangeText: `${formatLocalVisionMs(startMs)}-${formatLocalVisionMs(endMs)}`,
    scannedText: `${frames || "?"} evidence/CV frames`,
    candidateText: `${candidateCount} candidate window${candidateCount === 1 ? "" : "s"}`,
    coverageText: coverageCount ? `${coverageCount} coverage segment${coverageCount === 1 ? "" : "s"}` : "coverage segments unavailable",
    qwenText: qwenCalls ? `${qwenCalls} targeted Qwen review${qwenCalls === 1 ? "" : "s"}` : "no targeted Qwen reviews recorded",
    confirmedText: actionable.length
      ? `${actionable.length} confirmed finding${actionable.length === 1 ? "" : "s"} promoted${Number.isFinite(confirmedRange?.start) ? ` around ${formatLocalVisionMs(confirmedRange.start)}-${formatLocalVisionMs(confirmedRange.end)}` : ""}`
      : "no confirmed findings promoted",
    candidateReviewText: `${candidates.length} strong candidate${candidates.length === 1 ? "" : "s"} kept for manual review`,
  };
}

function localVisionSessionStory(result = {}) {
  const actionable = localVisionTierRows(result.actionable_findings, 20);
  const candidates = localVisionTierRows(result.strong_candidates, 20);
  const coverage = localVisionTierRows(result.coverage_segments, 30);
  const notConfirmed = arrayFromMaybe(result.not_confirmed);
  const lines = [];

  if (result.whole_video_story) {
    lines.push(result.whole_video_story);
  }

  if (actionable.length) {
    lines.push(`Confirmed: ${actionable.map((item) => {
      const range = localVisionMsRange(item);
      const label = String(item.label || item.event_type || "visual finding").replace(/_/g, " ");
      return `${formatLocalVisionMs(range.start)}-${formatLocalVisionMs(range.end)} ${label}`;
    }).join("; ")}.`);
  } else {
    lines.push("Confirmed: no gated visual event was promoted.");
  }

  if (candidates.length) {
    lines.push(`Review candidates: ${candidates.map((item) => {
      const range = localVisionMsRange(item);
      return `${formatLocalVisionMs(range.start)}-${formatLocalVisionMs(range.end)} ${candidateLabel(item).toLowerCase()}`;
    }).join("; ")}.`);
  }

  if (coverage.length) {
    const segments = coverage.slice(0, 10).map((segment) => {
      const range = localVisionMsRange(segment);
      const reviewed = segment.reviewed_by_qwen ? "Qwen-reviewed" : "CV-only";
      return `${formatLocalVisionMs(range.start)}-${formatLocalVisionMs(range.end)} ${String(segment.label || segment.type || "coverage").replace(/_/g, " ")} (${segment.status || "unknown"}, ${reviewed})`;
    });
    lines.push(`Whole-range coverage: ${segments.join("; ")}${coverage.length > segments.length ? `; plus ${coverage.length - segments.length} more segment${coverage.length - segments.length === 1 ? "" : "s"}` : ""}.`);
  }

  if (notConfirmed.length) {
    const labels = notConfirmed
      .map((item) => (typeof item === "string" ? item : item.label || item.claim || item.type || "not confirmed"))
      .map((label) => String(label).replace(/_/g, " "))
      .slice(0, 5);
    lines.push(`Not confirmed: ${labels.join("; ")}${notConfirmed.length > labels.length ? `; plus ${notConfirmed.length - labels.length} more` : ""}.`);
  }

  return lines;
}

function candidateLabel(candidate = {}) {
  return humanizeLocalVisionLabel(candidate.label || candidate.type || candidate.candidate_type || "candidate");
}

function progressCandidate(progress = {}) {
  return progress.latest_candidate_window || (
    progress.latest_candidate_type
      ? {
        candidate_id: progress.latest_candidate_id,
        type: progress.latest_candidate_type,
        score: progress.latest_candidate_score,
        reasons: progress.latest_candidate_reasons || [],
        frame_refs: progress.latest_candidate_frame_refs || [],
      }
      : null
  );
}

function sarahLocalVisionSummary(result) {
  const confirmed = arrayFromMaybe(result?.actionable_findings);
  const candidates = arrayFromMaybe(result?.strong_candidates);
  const notConfirmed = arrayFromMaybe(result?.not_confirmed);
  if (result?.mode || confirmed.length || candidates.length || notConfirmed.length) {
    if (confirmed.length) {
      return `Local analysis confirmed ${confirmed.length} finding${confirmed.length === 1 ? "" : "s"} with frame evidence. ${candidates.length ? `${candidates.length} candidate window${candidates.length === 1 ? "" : "s"} still need review.` : "No extra candidate windows were promoted beyond the visibility gates."}`;
    }
    if (candidates.length) {
      return `No confirmed timeline event was promoted. I found ${candidates.length} candidate window${candidates.length === 1 ? "" : "s"} worth review and kept unsupported items in not-confirmed instead of turning them into facts.`;
    }
    if (notConfirmed.length) {
      return `The local pass completed without enough visual evidence for confirmed events. Checked items are listed as not-confirmed so Session Analysis does not treat them as facts.`;
    }
  }
  const visibleItems = [
    ...(result?.visible_objects || []),
    ...(result?.visible_actions || []),
  ].filter((item) => item?.status === "visible");
  const visibleLabels = visibleItems.map((item) => prettyLocalVisionLabel(item.label).toLowerCase());
  const stages = (result?.stage_candidates || []).filter((stage) => stage.stage && stage.stage !== "unknown");
  const blocked = (result?.forbidden_or_not_visible || []).map((item) => item.claim).filter(Boolean);
  if (visibleLabels.includes("foley tubing") || visibleLabels.includes("gloved hands")) {
    const firstLine = [
      visibleLabels.includes("foley tubing") ? "Foley tubing" : null,
      visibleLabels.includes("gloved hands") ? "gloved hands" : null,
    ].filter(Boolean).join(" and ");
    const stageText = stages.length
      ? `The safest timestampable read is ${stages[0].stage.replace(/_/g, " ")}.`
      : "I do not have enough visual support for a more specific Foley stage.";
    const blockedText = blocked.length
      ? `I’m not calling ${blocked.slice(0, 4).join(", ")} from this window.`
      : "";
    return `${firstLine || "Procedure hardware"} is visible in this window. ${stageText} ${blockedText}`.trim();
  }
  if (visibleLabels.length) {
    return `I’m seeing ${visibleLabels.slice(0, 3).join(", ")} in this window. The local read stays limited to what the sampled frames actually show.`;
  }
  return result?.summary || "The local pass finished, but there is not enough visible evidence for a stronger claim.";
}

function localVisionCategory(type = "", isExploration = false) {
  const normalized = String(type || "").toLowerCase();
  if (isExploration) {
    if (normalized.includes("stage") || normalized.includes("catheter") || normalized.includes("tubing")) return ["instrumentation"];
    if (normalized.includes("fluid")) return ["physical"];
    if (normalized.includes("state")) return ["physical"];
    return ["setup"];
  }
  if (normalized.includes("motion") || normalized.includes("action")) return ["movement_observed"];
  if (normalized.includes("state") || normalized.includes("fluid")) return ["physical"];
  return ["other"];
}

function localVisionFindingFromItem(item, prefix = "") {
  if (!item || !["visible", "not_visible"].includes(item.status)) return null;
  const rawLabel = String(item.label || item.claim || "Finding");
  const title = `${prefix}${prettyLocalVisionLabel(rawLabel)}`.trim();
  const evidenceRefs = arrayFromMaybe(item.frame_refs);
  const status = item.status;
  const lowerLabel = rawLabel.toLowerCase();
  let text = item.reason || item.basis || "";
  if (status === "visible") {
    if (lowerLabel === "foley_tubing") text = "Foley tubing is visible across the sampled window.";
    else if (lowerLabel === "gloved_hands_visible") text = "Gloved hands are visible in the working field.";
    else if (lowerLabel === "tubing_routing_or_field_handling") text = "The visible action is tubing or field handling, not confirmed advancement or securement.";
    else text = `${title} is visible in the sampled frames.`;
  } else if (status === "not_visible") {
    if (lowerLabel === "foley_catheter") text = "I can’t clearly confirm the catheter shaft or tip here. Tubing can be visible without proving the catheter itself is visible.";
    else if (lowerLabel.includes("statlock") || lowerLabel.includes("securement")) text = "I do not see a distinct StatLock or adhesive securement anchor in this window.";
    else if (lowerLabel === "visible_advancement_motion") text = "I do not see clear frame-to-frame advancement through the meatus.";
    else if (lowerLabel === "urine_visible") text = "I do not see urine return in tubing, a bag, or a container.";
    else if (lowerLabel === "balloon_inflation_visible") text = "I do not see balloon-port or syringe inflation activity.";
    else text = `${title} is not clearly visible in this window.`;
  }
  return {
    title: title.length > 54 ? `${title.slice(0, 51)}...` : title,
    text,
    evidenceRefs,
    category: "instrumentation",
    confidence: confidenceWord(item.confidence),
  };
}

function localVisionDraftNote({ label, basis, refs = [], status = "confirmed" }) {
  const cleanLabel = humanizeLocalVisionLabel(label || "local visual finding");
  const cleanBasis = compactText(basis || "", 260);
  const evidenceRefs = compactFrameRefs(refs, 5);
  const evidence = evidenceRefs
    ? ` Evidence frames: ${evidenceRefs}.`
    : "";
  if (status === "candidate") {
    return `Possible visual activity candidate, not visually confirmed: ${cleanLabel}.${cleanBasis ? ` ${cleanBasis}` : ""}${evidence}`;
  }
  return `Local visual confirmed: ${cleanLabel}.${cleanBasis ? ` ${cleanBasis}` : ""}${evidence}`;
}

function localVisionEventFromItem(item, selectedVideo, windowInfo, isExploration, status = "confirmed", index = 0) {
  if (!item) return null;
  const range = localVisionMsRange(item);
  const fallbackMs = Number(windowInfo.startMs ?? windowInfo.start_ms ?? 0);
  const eventMs = Number.isFinite(range.start) ? range.start : fallbackMs;
  const label = item.label || item.event_type || item.type || item.candidate_type || "local visual finding";
  const refs = arrayFromMaybe(item.frame_refs || item.evidence_refs || item.frame_ref);
  const basis = item.basis || item.reason || (Array.isArray(item.reasons) ? item.reasons.join("; ") : "") || item.summary || "";
  return {
    time_s: sessionTimeForSource(eventMs / 1000, selectedVideo),
    note: localVisionDraftNote({ label, basis, refs, status }),
    evidenceRefs: refs,
    category: localVisionCategory(item.event_type || item.type || label, isExploration),
    annotation_tags: status === "candidate"
      ? ["local_vision", "visual_evidence", "candidate_not_confirmed"]
      : ["local_vision", "visual_evidence", "confirmed"],
    confidence: confidenceWord(item.confidence ?? item.score),
    index,
  };
}

function cardFromLocalVisionResult(result, selectedVideo, isExploration = false) {
  if (!result?.ok) return null;
  const windowInfo = result.window || result.range || {};
  const startSource = Number(windowInfo.startMs ?? windowInfo.start_ms ?? windowInfo.start_ms ?? 0) / 1000;
  const endSource = Number(windowInfo.endMs ?? windowInfo.end_ms ?? windowInfo.end_ms ?? startSource * 1000 + 1000) / 1000;
  const start = sessionTimeForSource(startSource, selectedVideo);
  const end = sessionTimeForSource(Math.max(startSource + 0.25, endSource), selectedVideo);
  const actionableFindings = arrayFromMaybe(result.actionable_findings).map((finding) => ({
    title: finding.label || finding.event_type || "Confirmed visual finding",
    text: finding.basis || finding.summary || finding.label || "Confirmed by local visual evidence.",
    evidenceRefs: arrayFromMaybe(finding.frame_refs),
    category: "local_vision",
    confidence: confidenceWord(finding.confidence),
  }));
  const strongCandidateFindings = arrayFromMaybe(result.strong_candidates).slice(0, 3).map((candidate) => ({
    title: candidateLabel(candidate),
    text: `${candidate.basis || candidate.reasons?.join("; ") || "Candidate window found by local CV/Qwen review."} This stays unconfirmed until the visual gate is met.`,
    evidenceRefs: arrayFromMaybe(candidate.frame_refs),
    category: "local_vision_candidate",
    confidence: confidenceWord(candidate.confidence ?? candidate.score),
  }));
  const visibleFindings = [
    ...actionableFindings,
    ...strongCandidateFindings,
    ...(result.visible_objects || []).map((item) => localVisionFindingFromItem(item)),
    ...(result.visible_actions || []).map((item) => localVisionFindingFromItem(item)),
    ...(result.stage_candidates || [])
      .filter((stage) => stage.stage && stage.stage !== "unknown")
      .map((stage) => ({
        title: String(stage.stage || "stage candidate").replace(/_/g, " "),
        text: stage.basis || "Local visual stage candidate.",
        evidenceRefs: arrayFromMaybe(stage.frame_refs),
        category: "instrumentation",
        confidence: confidenceWord(stage.confidence),
      })),
  ].filter(Boolean).slice(0, 5);
  const fallbackFinding = {
    title: "Local visual summary",
    text: sarahLocalVisionSummary(result),
    category: "other",
    confidence: confidenceWord(result.confidence?.overall),
  };
  const timelineEvents = (result.timeline_events || [])
    .map((event, index) => {
      const eventMs = Number(event.start_ms ?? event.time_ms ?? event.end_ms ?? windowInfo.startMs ?? 0);
      const time_s = sessionTimeForSource(eventMs / 1000, selectedVideo);
      const label = event.label || event.event_type || "Local visual event";
      const basis = event.basis || "";
      const refs = arrayFromMaybe(event.frame_refs || event.frame_ref);
      let note = `${label}${basis ? ` - ${basis}` : ""}`.trim();
      if (String(label).toLowerCase().includes("tubing/field handling")) {
        note = "Tubing/field handling is visible; advancement, urine return, balloon inflation, and securement are not confirmed in this window.";
      }
      return {
        time_s,
        note,
        evidenceRefs: refs,
        category: localVisionCategory(event.event_type || label, isExploration),
        annotation_tags: ["local_vision", "visual_evidence"],
        confidence: confidenceWord(event.confidence),
        index,
      };
    })
    .filter((event) => event.note)
    .slice(0, 8);
  const promotedEvents = arrayFromMaybe(result.actionable_findings)
    .map((item, index) => localVisionEventFromItem(item, selectedVideo, windowInfo, isExploration, "confirmed", index))
    .filter(Boolean);
  const candidateEvents = arrayFromMaybe(result.strong_candidates)
    .slice(0, 8)
    .map((item, index) => localVisionEventFromItem(item, selectedVideo, windowInfo, isExploration, "candidate", index))
    .filter(Boolean);
  const seenEventKeys = new Set();
  const events = [...timelineEvents, ...promotedEvents, ...candidateEvents]
    .filter((event) => {
      const key = `${Math.round(Number(event.time_s || 0) * 10) / 10}|${String(event.note || "").toLowerCase().slice(0, 80)}`;
      if (seenEventKeys.has(key)) return false;
      seenEventKeys.add(key);
      return true;
    })
    .sort((a, b) => Number(a.time_s || 0) - Number(b.time_s || 0))
    .slice(0, 12);
  const sampledFrames = (result.frame_evidence || result.evidence_frames || []).map((frame) => ({
    url: frame.image_path ? base44.integrations.Core.localVisionAssetUrl(frame.image_path) : "",
    frameTimeSeconds: Number(frame.time_ms || 0) / 1000,
    recordTimeSeconds: sessionTimeForSource(Number(frame.time_ms || 0) / 1000, selectedVideo),
    frameIndex: Number(String(frame.frame_id || "").replace(/\D/g, "")) || 0,
  })).filter((frame) => frame.url);
  return {
    id: `local-vision-${result.id || Date.now()}`,
    localVision: true,
    localVisionResultId: result.id || null,
    label: `Sarah local read ${fmtMmSs(start)}-${fmtMmSs(end)}`,
    window: { start, end },
    sourceWindow: { start: startSource, end: endSource },
    sourceVideo: selectedVideo,
    sourceVideoRole: inferVideoRole(selectedVideo),
    clipUrl: "",
    thumbnailUrl: sampledFrames[0]?.url || "",
    sampledFrames,
    motionSummary: null,
    telemetry: "Local-only visual evidence. Frames stayed on this machine; no cloud frame upload.",
    summary: result.summary || sarahLocalVisionSummary(result),
    findings: visibleFindings.length ? visibleFindings : [fallbackFinding],
    events,
    confidence: confidenceWord(result.confidence?.overall),
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

function cardDeviceEvidenceStatus(card) {
  const text = [
    card?.summary,
    ...(card?.findings || []).flatMap((finding) => [finding.title, finding.text]),
    ...(card?.events || []).map((event) => event.note),
  ].filter(Boolean).join(" ");
  return deviceEvidenceStageForText(text);
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
  const roiOverlayRef = useRef(null);
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
  const [visionEngine, setVisionEngine] = useState("local_qwen25vl");
  const [localAnalysisType, setLocalAnalysisType] = useState(() => inferLocalAnalysisType(recordType, session));
  const [localAnalysisMode, setLocalAnalysisMode] = useState("balanced");
  const [localVisionRois, setLocalVisionRois] = useState([]);
  const [roiEditMode, setRoiEditMode] = useState(false);
  const [activeRoiId, setActiveRoiId] = useState(null);
  const [localVisionFocus, setLocalVisionFocus] = useState(isExploration ? "foley" : "body");
  const [localVisionHealth, setLocalVisionHealth] = useState(null);
  const [localVisionRunning, setLocalVisionRunning] = useState(false);
  const [hybridSarahVerifying, setHybridSarahVerifying] = useState(false);
  const [localVisionStatus, setLocalVisionStatus] = useState("");
  const [localVisionError, setLocalVisionError] = useState("");
  const [localVisionProgress, setLocalVisionProgress] = useState(null);
  const [localVisionLiveLog, setLocalVisionLiveLog] = useState([]);
  const [localVisionResult, setLocalVisionResult] = useState(null);
  const [localVisionQuestion, setLocalVisionQuestion] = useState("");
  const [localVisionQaResult, setLocalVisionQaResult] = useState(null);
  const freshRunStartedAtRef = useRef(ignoreCompletedJobsBefore || 0);

  useEffect(() => {
    setLocalAnalysisType(inferLocalAnalysisType(recordType, session));
  }, [recordType, session?.id]);

  const addLocalVisionRoi = (presetKey) => {
    const preset = LOCAL_VISION_ROI_PRESETS[presetKey] || LOCAL_VISION_ROI_PRESETS.full_body_roi;
    const id = `roi_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
    setActiveRoiId(id);
    setRoiEditMode(true);
    setLocalVisionRois((current) => [
      ...current,
      normalizeUiRoi({ ...preset, id }, current.length),
    ]);
  };

  const updateLocalVisionRoi = (id, patch) => {
    setLocalVisionRois((current) => current.map((roi, index) => (
      roi.id === id ? normalizeUiRoi({ ...roi, ...patch }, index) : roi
    )));
  };

  const removeLocalVisionRoi = (id) => {
    if (activeRoiId === id) setActiveRoiId(null);
    setLocalVisionRois((current) => current.filter((roi) => roi.id !== id));
  };

  const pointFromRoiOverlay = useCallback((event) => {
    const bounds = roiOverlayRef.current?.getBoundingClientRect();
    if (!bounds?.width || !bounds?.height) return null;
    return {
      x: clamp((event.clientX - bounds.left) / bounds.width, 0, 1),
      y: clamp((event.clientY - bounds.top) / bounds.height, 0, 1),
    };
  }, []);

  const beginLocalVisionRoiDrag = useCallback((roi, mode, event) => {
    const startPoint = pointFromRoiOverlay(event);
    if (!startPoint) return;
    event.preventDefault();
    event.stopPropagation();
    event.currentTarget?.setPointerCapture?.(event.pointerId);
    setActiveRoiId(roi.id);
    setRoiEditMode(true);

    const initial = normalizeUiRoi(roi);
    const previousUserSelect = document.body.style.userSelect;
    document.body.style.userSelect = "none";

    const handleMove = (moveEvent) => {
      const nextPoint = pointFromRoiOverlay(moveEvent);
      if (!nextPoint) return;
      moveEvent.preventDefault();
      const dx = nextPoint.x - startPoint.x;
      const dy = nextPoint.y - startPoint.y;
      if (mode === "resize") {
        updateLocalVisionRoi(roi.id, {
          width: clamp(initial.width + dx, 0.03, 1 - initial.x),
          height: clamp(initial.height + dy, 0.03, 1 - initial.y),
        });
      } else {
        updateLocalVisionRoi(roi.id, {
          x: clamp(initial.x + dx, 0, 1 - initial.width),
          y: clamp(initial.y + dy, 0, 1 - initial.height),
        });
      }
    };

    const handleUp = () => {
      document.body.style.userSelect = previousUserSelect;
      window.removeEventListener("pointermove", handleMove);
      window.removeEventListener("pointerup", handleUp);
      window.removeEventListener("pointercancel", handleUp);
    };

    window.addEventListener("pointermove", handleMove, { passive: false });
    window.addEventListener("pointerup", handleUp, { once: true });
    window.addEventListener("pointercancel", handleUp, { once: true });
  }, [pointFromRoiOverlay]);

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

  const updateLocalVisionProgress = useCallback((progress) => {
    setLocalVisionProgress(progress);
    const entry = localVisionProgressLogEntry(progress);
    if (!entry) return;
    setLocalVisionLiveLog((current) => {
      if (current[0]?.key === entry.key) return current;
      return [entry, ...current.filter((item) => item.key !== entry.key)].slice(0, 10);
    });
  }, []);

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
    setLocalVisionResult(null);
    setLocalVisionQaResult(null);
    setLocalVisionError("");
    setLocalVisionStatus("");
    setLocalVisionProgress(null);
    setLocalVisionLiveLog([]);
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

  useEffect(() => {
    if (!session?.id || visionEngine === "cloud") return undefined;
    let cancelled = false;
    const syncRunningLocalJob = async () => {
      try {
        const response = await listBackgroundJobs({
          status: "queued,running",
          limit: 8,
          metaSessionId: session.id,
          metaSource: "AIVideoPassPanel",
        });
        if (cancelled) return;
        const job = (response.jobs || []).find((item) => (
          item?.type === "local_vision_analyze_forward"
            || item?.type === "local_vision_analyze_adaptive"
            || item?.type === "local_vision_analyze_continuous"
            || item?.type === "local_vision_analyze_window"
            || item?.type === "local_vision_ask_video"
        ));
        if (!job) {
          setLocalVisionRunning(false);
          setLocalVisionProgress(null);
          return;
        }
        const progress = job.progress || {};
        const count = progress.total ? ` (${progress.current || 0}/${progress.total})` : "";
        setLocalVisionRunning(true);
        updateLocalVisionProgress(progress);
        setLocalVisionError("");
        setLocalVisionStatus(`${progress.message || "Local Qwen job running..."}${count}`);
      } catch {
        // The tray handles global job errors; keep this local attachment best-effort.
      }
    };
    syncRunningLocalJob();
    const interval = window.setInterval(syncRunningLocalJob, 2000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [session?.id, updateLocalVisionProgress, visionEngine]);

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
    freshRunStartedAtRef.current = Date.now();
    try {
      const workingSession = session;
      setStatus(`Starting ${recordLabel} Claude/Sarah video pass. Previously accepted evidence is preserved.`);
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

Foley placement sequence to track when visible: positioning on the table; draping and field setup; swabbing/antiseptic prep; lubrication or possible urethral dilation with a syringe; initial Foley handling away from the body; penis/glans stabilization; catheter approach toward the meatus; catheter tip positioned at the meatus; insertion begins when the tip visibly enters the meatus; active advancement when catheter motion through the meatus is visible OR when the visible external catheter/shaft length progressively shortens across sampled frames while remaining aligned with the meatus/glans; seated/in-place state only after visible advancement/placement evidence plus a completion marker; bladder entry or urine confirmation; balloon inflation; drape removal; urine collected in the bag. Treat these as possible stages, not a script.

Foley state-versus-action rule: Foley catheter/tubing already being visible means "Foley/tubing remains present", not "inserted", "placed", "advanced", or "secured". Yellow tubing being moved, lifted, routed, or resting across the field is tubing handling unless the catheter shaft is visibly advancing at the meatus or balloon hardware is visible. Do not mention StatLock, adhesive securement, securement finalization, balloon inflation, bladder entry, urine confirmation, or urine collection unless that exact item/action is visible in the sampled frames or explicitly logged in nearby manual notes. Prior AI-generated events/findings do not count as manual evidence.

Procedure timeline authority rule: timestamped manual/user event notes are the procedural timeline of record. Use video to support, clarify, or flag uncertainty around those notes; do not let an AI visual guess move a procedural step earlier or later than the manual timeline. If a sampled frame appears to conflict with a nearby manual note, say there is a possible visual/timeline mismatch and keep the manual note as the anchor unless the current frames directly and unmistakably show otherwise. Do not describe povidone-iodine, lubricant, Foley contact, meatal engagement, bladder entry, balloon inflation, urine return, or securement before the first manual note or current-frame evidence that supports that specific item/action.
${PRODUCTION_PROCEDURE_ANNOTATION_RULE}

Known object correction: the blue item on the procedure tray/right field edge is a lubricant bottle or prep material, not a blue-tipped Foley. Do not identify that blue tray object as Foley tubing, catheter tip, catheter port, or evidence that the Foley is already inserted. A Foley/catheter claim requires the actual catheter shaft/tip, tubing connected to Foley hardware, or clear meatal contact/advancement visible in the current frames.

Already-in-place gate: do not use "already in place", "post-placement", "seated", or "dwell interval" just because Foley/catheter material is first visible at the glans or meatus. First clear visibility at the meatus/glans is usually "catheter tip at the meatus" or "insertion beginning" if the tip is entering. Use "already in place" only if an earlier manual note/current-run corrected reviewed window explicitly confirmed advancement/placement, or if urine return, balloon inflation, drape removal after placement, bag collection, or another completion marker is visible. Prior AI-generated claims do not count as confirmation.

Foley action evidence gates: use "glove change/prep" when hands are changing gloves or fresh gloves appear without a Foley/catheter in hand; use "swabbing/prep" only for visible wipe/swab/applicator contact; use "lubrication/dilation" only when a syringe, gel, lubricant, instillation, or urethral prep action is visible/supported; use "catheter not visible" when the actual catheter/tool tip is outside the frame, hidden by hands/body/drape, or cannot be separated from nearby materials; use "catheter approach" only when the actual catheter/tool is visible and being brought toward the meatus but has not reached it; use "catheter tip at the meatus" only when the actual tip is visibly touching or aligned at the meatus; use "insertion beginning" when the actual tip first visibly enters the meatus; use "active advancement" when catheter/tool motion through the meatus is visible OR when less external catheter/shaft remains visible across sampled frames while the visible catheter stays continuous/aligned with the meatus/glans; use "visible catheter/Foley-at-meatus state" only when Foley/catheter material is visibly at the glans/meatus but active advancement is not proven; use "already in place" only after the already-in-place gate above is satisfied; use "positioning/tubing handling" when gloved hands are arranging tubing, drape, gauze, or field materials away from the meatus. If unsure between prep/glove change and Foley handling, choose prep/glove change. If the Foley is not in frame, say it is not visible in this window. If unsure between not visible and approach, choose "catheter not visible." If unsure between approach and tip-at-meatus, choose "catheter approach." If unsure between tip-at-meatus and advancement, choose "catheter tip at the meatus" only when the tip/contact itself is visible and catheter length is not changing; choose "active advancement" when the external visible catheter length is progressively shortening at the meatus/glans. If unsure between insertion and already-in-place, choose "insertion beginning", "active advancement", or "visible catheter/Foley-at-meatus state" instead of already-in-place.

Foley advancement-length cue: actively compare sampled frames inside the current window and adjacent-window continuity. If the catheter/shaft is visibly aligned with the meatus/glans and progressively less of it remains outside the body, that is evidence of active advancement even if the exact tip is partly hidden by a hand or drape. Describe it as "visible/progressive Foley advancement" or "external catheter length shortens during insertion." Do not require the tip to be visible in every frame once insertion has begun. Still do not call the catheter fully seated, in bladder, or dwell/placed until urine return, balloon-port handling, bag collection, or a manual/current-run corrected completion marker supports that later stage.

No forecasted Foley stages: do not write "meatal engagement appears imminent", "catheter positioning", "advancement is about to begin", "preparing for insertion", or similar future-stage language. If the catheter/tool tip is not visibly at the meatus and advancement is not visible, describe the current visible action only: glove change, field prep, hand position, drape/gauze handling, packaging/tool handling, or tubing handling.

Meatal contact is its own stage: if the sampled frames show the actual catheter/Foley/tool tip touching or aligned at the meatus but do not prove motion through the meatus, say "catheter tip at the meatus" or "visible meatal contact/engagement." If the tip or meatus is out of frame, occluded, cropped, or ambiguous, do not say "at", "contacting", "touching", "entering", or "advancing through" the meatus. Do not downgrade true visible meatal contact to generic tubing/field handling. Upgrade meatal contact to active advancement when frame-to-frame catheter motion or progressive external-length shortening is visible. Do not upgrade it to already-in-place unless the already-in-place gate is satisfied.

${ANATOMICAL_LATERALITY_RULE}
${PRODUCTION_PROCEDURE_ANNOTATION_RULE}
Handedness/camera rule: do not label hands, feet, legs, or body sides as left or right unless anatomical laterality is unambiguous. Prefer "one hand", "the other hand", "upper hand", "lower hand", "near hand", "far hand", "screen-left foot", or "screen-right leg" for visual tracking when camera perspective is uncertain.
Hands and participation rule: assume visible hands are your hands unless another participant is clearly visible or explicitly logged as assisting. Do not introduce another person, helper, clinician, operator, or assistant from hands alone.
Personal language rule: write about Ben directly as "you" and "your". Never call him "the subject", "subject", "patient", "participant", "operator", "the person", "the user", "the user's", "a gloved hand", or "the gloved hand". Use "your hand" or "your hands"; use "your gloved hand" only when glove/sterile technique matters.
Use exploration event categories only: instrumentation, instrumentation_change, physical, sensation, comfort, setup, or other.
Draft event examples for this mode: "Fresh gloves/glove change visible during prep", "Draping and field setup continue", "Swabbing/prep continues around the meatus", "Lubrication or dilation syringe is used near the meatus", "One hand stabilizes the penis while the other brings the catheter toward the meatus" only if a Foley is visibly in hand, "Catheter tip is visible at the meatus" when contact/engagement is visible without confirmed advancement, "Foley insertion begins at the meatus" when the tip first visibly enters, "Foley advancement is visible at the meatus" when frame-to-frame advancement or progressive external-length shortening is visible, "Foley/tubing is being handled after insertion" only after completion is established, "Urine appears in the tubing/bag", "Drape is removed while urine collects in the bag".` : ""}

You are Sarah, reviewing sampled frames from a linked local ${recordLabel} video. Analyze only what is visible or supported by telemetry/context. Do not infer intent, pressure, force, coverings, gloves, lubricant, device fit, sensation, electrodes, or cause beyond visible evidence. If a hand or object is partially blurred, occluded, bright, or low-detail, describe it neutrally as visible contact/hand position rather than naming gloves or materials.

${SARAH_APP_OVERLAY_TELEMETRY_RULE}

${isExploration ? "Exploration/procedure context grounding" : "Session context grounding"} has priority when it identifies known setup, devices, materials, or technique. Use the ${recordLabel} notes, methods, devices, and timestamped/manual notes below to interpret ambiguous visible objects and contact locations. ${isExploration ? "For example, if the exploration context says an 18 French Foley catheter or urethral sound is in use and the frames show a matching device at the meatus, identify it as that supported instrumentation rather than vague stimulation or generic object handling." : "For example, if the session context says a vibrator is held at the perineum during stimulation and the frames show a matching device/contact at that location, call it a perineal vibrator/contact rather than a vague \"blue device near the scrotum and genitals.\""} If context and visuals do not line up, state the uncertainty instead of forcing the label.

${isExploration ? "Procedure chronology rule: manual/user timeline notes are stronger than prior AI video-pass cards for stage order and timing. Use the current sampled frames to describe what is visible now, but do not back-date iodine, lubricant, Foley-at-meatus contact, insertion, urine return, balloon fill, securement, or cleanup into a window unless either the current frames show it or a nearby manual note says it has happened. If the video appears to show something before the manual timeline allows it, label the visual as ambiguous or possible conflict instead of merging both claims." : ""}

Current-frame override rule: the sampled frames in this request are the primary evidence. Prior summaries, accepted cards, and continuity text can orient the sequence, but they must not override the current frames. If the prior window said "resting", "no stimulation", "no visible movement", or "HR rising without visible cause", actively re-check the current frames for hand/device contact, visible stroke or device motion, perineal contact, glans/shaft movement, sleeve/lubricant interaction, body/leg response, or procedure action before repeating that claim.

Scrotal/testicular observation rule: in regular session reviews, give the scrotum/testes the same attention as shaft/glans state when they are visible. Track scrotal/testicular position, progressive lift/retraction, relaxation/descent, asymmetry, skin tightening/wrinkling, surface sheen, and visible tissue color shifts such as flushing, darker/redder tone, blanching, or return toward baseline. Compare sampled frames and nearby windows before calling a change progressive. Do not overcall color or tissue changes from lighting, camera exposure, shadow, compression artifacts, or app overlays; use "visible color/tension change" or "possible lighting-related change" when uncertain.

Positive action tracking rule: describe visible contact or motion before describing absence. For regular session reviews, if any sampled frame shows hand contact with the penis, glans, shaft, scrotal-base/perineal region, sleeve/device, or visible stimulation-related motion, treat the window as active stimulation/contact or a stimulation transition unless the sequence clearly shows a pause. Do not claim sleeve-based stimulation, sleeve stroking, or sleeve placement until the sleeve is visibly placed on/over the shaft or visibly used around the penis; if the sleeve is only nearby, in hand, or outside the frame, describe hand contact/prep instead. For body exploration reviews, if any sampled frame shows glove change, swab/wipe/applicator/tool/catheter/tubing contact, or setup movement, describe that procedural action rather than saying nothing is happening. For Foley reviews, prefer the exact visible action: table positioning, glove change/prep, drape/setup, swabbing, lubrication/dilation, penis stabilization, catheter not visible, catheter approach, catheter tip at the meatus, insertion beginning, active advancement from visible motion or shortening external catheter length, visible catheter/Foley-at-meatus state, tubing handling, balloon inflation, drape removal, or urine collection. Do not use already-in-place unless completion evidence is visible or manually logged.

Hard wording rule: do not use "edging", "edging maneuver", "intentional edging", "holding back", "delaying climax", or similar intent language unless the nearby session event, session note, or user caption explicitly uses that exact concept. If the visible behavior is a hand lift, withdrawal, pause, restart, speed change, or contact change, describe the observable behavior only.

Ejaculation and fluid evidence rule: do not infer orgasm, climax, ejaculation, or cum from shiny/clear wetness, glans sheen, lubrication sheen, hand movement, erection state, or a stimulation pause alone. Clear or glossy moisture on the glans/shaft is more likely lubricant, pre-ejaculate, or unspecified moisture unless there is strong supporting context. Only call ejaculate when the visible fluid is clearly whitish/opaque, there is a visible emission/spurt, or there is a nearby confirmed climax/ejaculation event in the session notes/timeline. When that threshold is met, say "ejaculate" or "visible ejaculate" directly; do not use vague residue/euphemism wording. Treat HR/telemetry as consistency context: if the window does not align with the session climax marker, recovery transition, or a plausible autonomic peak, label fluid as "visible moisture/sheen" or "possible lubricant/pre-ejaculate" rather than ejaculate. Never create multiple orgasms/climax events from repeated wetness or sheen across adjacent windows; carry forward that it is likely the same lubricant/moisture unless there is a clear new emission or confirmed event.

Perineum and underside anatomy rule: do not label the area under the scrotum as "base of penis" unless the penile shaft base is clearly visible and contacted. If contact is below or behind the scrotum, use "perineum", "perineal region", "underside/perineal contact", or "scrotal-base/perineal region" depending on what is visible. If the location is ambiguous between penile base, scrotal base, and perineum, state the uncertainty instead of forcing a penile-base label.

Timeline timing rule: sampled frames can lag the true transition. Do not assume the event happened exactly at the window start or window end. Use the most likely visible transition time from the sampled frames and nearby session notes. If the exact second is uncertain, keep the note phrased as "visible by", "around", "continues", "pauses", or "resumes" rather than claiming a precise start/stop. Never write filler such as "This window opens with", "Window opens at", "This window closes with", or "Window closes with" in event notes.

${isExploration ? "" : "Stimulation lifecycle rule: there should usually be only one \"stimulation_started\" event for the initial obvious masturbation/contact and only one \"stimulation_stopped\" event for the true post-climax/end-of-session cessation. Inside the session, use \"stimulation_paused\", \"stimulation_resumed\", or plain \"stimulation\" for hand lifts, contact changes, technique shifts, lubrication breaks, device handling, and post-climax milking/recovery transitions. Do not create repeated start/stop events for adjacent windows that are really pause/resume or method changes."}

Camera/view focus:
${videoFocusInstruction(selectedVideo, selectedVideoRole, isExploration)}

Source-lane rule: treat the selected camera as its own evidence lane. Main/composite owns genital, stimulation, hand contact, device, lubricant, and technique observations. Feet/lower-body owns feet, toes, heels, soles, ankles, legs, planting, bracing, tremor, shudder, and lower-body tension/relaxation observations. Lateral/full-body owns posture, pelvic lift/drop, breathing cues, whole-body tension, and major body transitions. For a feet/lower-body pass, do not draft timeline events about right/left hand movement, genital contact, control objects, lube/device handling, erection/genital state, or stimulation pause/resume unless a visible foot/leg change is the main event.

${ANATOMICAL_LATERALITY_RULE}
${PRODUCTION_PROCEDURE_ANNOTATION_RULE}

Feet-lane sensitivity rule: for feet/lower-body videos, look carefully for subtle but meaningful lower-body activity before claiming no change. Specifically compare toe curl/extension, toes pointing downward or relaxing, heel spread or lift, foot fan/splay, sole angle, ankle flexion, leg tension/relaxation, tremble, shudder, side-to-side oscillation, and left/right asymmetry. Downward planting, toe curl, tensing, trembling, or progressive foot fan are meaningful findings/events even if the body otherwise stays in place. Do not write repeated "no change", "stillness continues", "baseline unchanged", or "no lower-body response" findings/events across adjacent windows. If the only observation is static lower-body position, keep the summary to one brief sentence and return empty findings and empty events.

Observation priorities, in order:
1. Visible physiological response: erection/engorgement quality, genital position/state, glans/shaft/foreskin/scrotal/testicular/perineal state, scrotal lift/retraction or relaxation/descent, scrotal skin tension/wrinkling, visible tissue color or surface sheen, cautious visible fluid/moisture labeling, pelvic lift/drop, and whether these change from the prior window.
2. ${isExploration ? "Procedure/instrumentation state: what body area or device/material is involved, whether procedure contact continues, starts, pauses, resumes, or changes, and whether motion/position shows glove change/prep, setup, prep/swabbing, lubrication/dilation, visible meatal contact/engagement, visible advancement, already-in-place catheter state, tubing/field handling, balloon inflation, drape removal, urine collection, or post-procedure checking. Do not claim insertion/advancement/securement from Foley or tubing presence alone. Do not claim meatal engagement is imminent; either the tip/contact at the meatus is visible now or it is not. If tip-at-meatus contact is visible but advancement is not, preserve that as meatal contact rather than downgrading to tubing handling." : "Stimulation state and technique: what body area is contacted, whether contact continues, starts, pauses, resumes, or changes, and whether motion/position suggests a technique shift."}
3. Whole-body and lower-body response: leg/foot activity, toe/heel/planting/bracing changes, abdominal/chest movement or breathing estimate only when enough body surface is visible, posture shifts, tremor, shudder, and relaxation/tension cues.
4. Device/material use: lubrication application, visible lubricant sheen, sleeve/Foley/e-stim/TENS/device use, device introduction/removal, and contact/fit changes when visible or supported.
5. Sarah app overlay interpretation when readable: if the visible Sarah overlay or captured app panel shows Current HR, AVG, MAX, RR samples, RMSSD, HRV quality, build confidence, AI Magic, near-climax, recovery, phase labels, timers, EMG levels, or heart-rate trend, treat it as app-generated telemetry evidence for this window. Use it to support physiological interpretation and timing correlation with visible body/procedure/stimulation changes. Do not make a standalone finding from overlay text alone unless the overlay change is itself the useful evidence.
6. Device overlay interpretation when readable: if a visible Howl, Coyote-E, e-stim, TENS, or stim-control overlay/screenshot shows frequency, intensity, power level, waveform, mode/program, channel state, playback status, ramp/activity state, or stimulation on/off state, extract and interpret those values naturally as device evidence. Do not say the device cannot be interpreted when readable values are visible. If the text is too small/blurred, say it is unreadable rather than absent.

Generic object rule: ignore mouse, remote, keyboard, phone, dark handheld object, side-table object, or generic "control object" details. Do not write "reaches for control object", "returns to control object", "handheld controller", or similar language in findings or draft events. If the hand leaves or returns to the body, describe only the relevant body/${isExploration ? "procedure" : "session"} change, such as ${isExploration ? "\"prep contact pauses\", \"tool handling resumes\", \"hand stabilizes the glans\", or \"tubing is repositioned\"" : "\"genital contact pauses\", \"stimulation resumes\", \"hand leaves genital contact\", or \"hand returns to genital contact\""}. Only identify an object when it is a known or clearly visible session-relevant item such as a silicone sleeve, vibrator, lubricant bottle, Foley catheter, TENS/e-stim component, pump, towel, or explicitly user-labeled device.

Output style: write the summary as a flowing chronological observation with the most useful visible physiology and ${isExploration ? "procedure/device landmark" : "stimulation"} changes first. Keep it to 2 concise sentences. Return 2-4 finding cards only when there are useful non-repetitive observations; return fewer or none when the window adds nothing. Each finding title should be under 9 words, and each finding text should be 1 concise sentence. Return 1-3 timeline events only when there is a meaningful change or useful timestampable observation. Avoid spending a finding slot on HR overlay text, static background objects, unchanged setup, no-change filler, or the mere presence of a control object.
Language variety rule: do not make "consistent with", "consistent", or "consistently" your default evidence phrase. Avoid this word family unless it is clearly the best wording; if it appears once, rewrite any later use in this window with "fits with", "aligns with", "matches", "supports", "stable", "repeated", "holds steady", or direct observation language.
Use direct, personal language: "you", "your glans", "your lower body", "your hand", or "your hands". Do not use detached research wording such as "subject", "the subject", "patient", "participant", "operator", "the person", "the user", "the user's", "a gloved hand", or "the gloved hand". Use "your gloved hand" only when glove/sterile technique matters. Assume the hand is yours unless another person is clearly visible or explicitly logged.

Draft event style: write events like concise manual timeline notes, not analysis paragraphs. Prefer observations such as ${isExploration ? "\"Drape/setup position is visible\", \"Antiseptic prep continues around the meatus\", \"Lubrication/tool handling begins\", \"Catheter is not visible in this window\", \"Catheter tip is visible at the meatus\" only when the actual tip is visible there, \"Visible Foley advancement continues\" only when frame-to-frame advancement is visible, or \"Tubing/field handling continues\"" : "\"Left foot plants further while legs tense\", \"Pelvis lifts briefly then drops\", \"Lubrication applied to glans\", \"Perineal contact resumes below scrotum\", \"Scrotum lifts progressively during stimulation\", \"Scrotal skin appears tighter/redder than prior frames\", \"Stimulation resumes with mid-shaft to glans strokes\", \"Glans remains engorged with visible sheen\", \"Sleeve use becomes visible\" only after visible placement/use, \"Deep exhale visible through abdominal drop\", or \"Whitish ejaculate clearly visible after confirmed climax marker\""} only when strongly supported by context plus visible sequence. Do not include HR/BPM/overlay/timer language in event notes unless no visible body/${isExploration ? "procedure" : "stimulation"} change exists. Do not begin event notes with "this window opens", "window opens", "this window closes", or "window closes"; write the actual observed change directly.

Visible tools and materials matter when supported: identify lubrication bottles or lubricant application only when a bottle, gel/fluid, hand motion, shine, or user/session context makes that reasonably clear. ${isExploration ? "For body exploration, avoid generic \"object\" wording when the visible material is more likely swab, gauze, wipe, drape, towel, applicator, tubing, catheter shaft, lubricant, or syringe. Use the session context to name procedure-relevant materials when the sequence and visuals make that reasonable, but do not make every frame about the final device. Do not name securement hardware, StatLock, balloon, urine return, or bag collection unless visible in current sampled frames or explicitly stated in nearby manual notes." : "Identify devices such as a silicone sleeve, Foley catheter, e-stim/TENS leads, pump, towel, table, Coyote-E/Howl overlay, stim-control display, or camera/monitor setup when visible or strongly supported by session context. When readable, preserve frequency, intensity, power, mode, waveform, channel, play/pause, and active/ramp state as concrete timeline evidence."} If uncertain, say "possible" and mark confidence low or moderate. Write findings in direct second person using "you" and "your".

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
    if (isExploration && isAIGeneratedPassEvent(event)) return false;
    const t = Number(event.time_s || 0);
    if (!Number.isFinite(t)) return false;
    if (isExploration) return t >= window.start - 8 && t <= window.end + 8;
    return Math.abs(t - ((window.start + window.end) / 2)) <= 75;
  })
  .map((event) => `[${fmtMmSs(event.time_s)}] ${event.note}`)
  .join(" | ") || "None nearby."}

Return concise visual findings and 1-3 proposed timeline events only when the window contains useful non-repetitive evidence. Good targets are ${isExploration ? "procedural stage changes, glove change/prep, draping/setup, meatal or glans prep, swab/applicator action, lubrication or instillation, visible catheter/Foley/tool tip contact at the meatus, meatal engagement only when visible, instrument advancement/withdrawal/adjustment only when visible, resistance/rotation in sequence, urine return/bladder entry, balloon/seating when visible, catheter already-in-place state, tubing/field handling away from the meatus, dwell comfort, post-procedure tissue state, anatomy/tissue changes, comfort/tolerance cues, breathing/body settling, leg/feet tension or relaxation, and telemetry-supported procedural physiology" : "genital state changes, stimulation technique shifts, lubrication or device-use moments, pauses/resumes, erection or physical-state changes, scrotal/perineal observations, cautious moisture/sheen observations, pelvic lift/drop, breathing/body cues, body/feet bracing, leg tensing/relaxing, toe curl/downward planting, tremble/shudder, device/position changes, and important setup context only when it changes interpretation"}. Use low confidence or omit the finding when the evidence is ambiguous. Keep the full JSON response compact so it can finish cleanly.`,
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
        `${index + 1}. ${fmtMmSs(card.window.start)}-${fmtMmSs(card.window.end)}: ${compactText(sanitizeExplorationFoleyText(card.summary), 280)}`
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
Original summary, possibly overclaimed: ${sanitizeExplorationFoleyText(card.summary)}
Original findings, possibly overclaimed: ${(card.findings || []).map((finding) => `${sanitizeExplorationFoleyText(finding.title)}: ${sanitizeExplorationFoleyText(finding.text)}`).join(" | ") || "None"}
Original events, possibly overclaimed: ${(card.events || []).map((event) => `[${fmtMmSs(event.time_s)}] ${sanitizeExplorationFoleyText(event.note)}`).join(" | ") || "None"}
Telemetry: ${card.telemetry || "None"}

Foley correction rules:
- Foley/tubing visible means present/state, not newly inserted, placed, advanced, secured, or finalized.
- Timestamped manual/user notes are the procedural timeline of record. Use the current sampled frames to correct visible evidence, but do not move iodine, lubricant, Foley-at-meatus contact, insertion, urine return, balloon inflation, or cleanup earlier/later than the manual timeline unless the current frames directly and unmistakably show that mismatch.
- If the visual card conflicts with a manual note, call it a possible visual/timeline mismatch rather than merging both into a false sequence.
- ${ANATOMICAL_LATERALITY_RULE}
- Assume visible hands are your hands unless another participant is clearly visible or explicitly logged as assisting. Write "you", "your", "your gloved hand", "one gloved hand", or "the other gloved hand"; do not use detached labels for you or your hands.
- Use catheter not visible when the actual catheter/tool tip is outside the frame, cropped, hidden, blocked by hands/body/drape, or cannot be distinguished from field materials.
- Use catheter approach only when the actual catheter/tool is visible moving toward the meatus but has not reached it.
- Use catheter tip at the meatus only when the actual tip is touching/aligned at the meatus but not visibly entering.
- Use insertion beginning only when the actual tip first visibly enters the meatus.
- Use active advancement if the sampled frames show catheter/tool movement through the meatus OR progressive shortening of the visible external catheter/shaft while it remains aligned/continuous at the meatus or glans.
- Do not require the exact tip to remain visible after insertion has begun; less external Foley visible across frames is useful advancement evidence.
- Do not use already-in-place/dwell/post-placement when the first clear evidence is Foley/catheter material at the glans or meatus. First visibility at the meatus/glans should be corrected to catheter tip at the meatus, insertion beginning, or active advancement depending on what the frames show.
- Use already-in-place only if an earlier manual note or earlier corrected reviewed window explicitly confirmed advancement/placement, or if urine return, balloon inflation, or another completion marker is visible. Prior AI-generated already-in-place language does not count as confirmation.
- Use tubing/field handling when tubing or catheter is visible away from the meatus and the catheter is not visibly advancing.
- Do not mention StatLock, securement, adhesive securement, securement finalization, balloon inflation, bladder entry, urine confirmation, or urine collection unless that exact thing is visible in the sampled frames or explicitly stated in nearby manual notes. Prior AI-generated events/findings do not count as manual evidence.
- If a prior card already claimed a Foley stage, do not repeat it as newly happening here unless the current frames independently show a new repeat.
- Prefer conservative procedure labels: drape/setup, swabbing/prep, lubrication/dilation syringe, penis stabilization, catheter approach, catheter tip at the meatus, insertion beginning, active advancement, visible catheter/Foley-at-meatus state, tubing/field handling, drape removal, urine collection.
- If the Foley is not in frame, say it is not visible in this window. Do not write "at the meatus", "contacting the meatus", "entering the meatus", or "advancing" unless the actual tip/contact/motion or progressive external-length shortening is visible in sampled frames.
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

  useEffect(() => {
    let cancelled = false;
    if (visionEngine === "cloud") return undefined;
    base44.integrations.Core.GetLocalVisionHealth()
      .then((health) => {
        if (!cancelled) setLocalVisionHealth(health);
      })
      .catch((err) => {
        if (!cancelled) {
          setLocalVisionHealth({ ok: false, error: err?.message || "Local Qwen service unavailable." });
        }
      });
    return () => {
      cancelled = true;
    };
  }, [visionEngine]);

  useEffect(() => {
    let cancelled = false;
    if (!session?.id || !selectedVideo?.path) return undefined;
    base44.integrations.Core.ListLocalVisionResults({ sessionId: session.id, limit: 12 })
      .then((payload) => {
        if (cancelled) return;
        const latest = (payload?.results || [])
          .filter((row) => row?.result?.ok)
          .filter((row) => !row.video_path || row.video_path === selectedVideo.path)
          .sort((a, b) => Date.parse(b.created_at || "") - Date.parse(a.created_at || ""))[0];
        if (!latest?.result) return;
        const restored = { ...latest.result, id: latest.id, created_at: latest.created_at, analysis_type: latest.analysis_type };
        setLocalVisionResult(restored);
        setLocalVisionStatus(`Loaded saved local vision ${latest.analysis_type || "analysis"} from ${new Date(latest.created_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`);
      })
      .catch(() => {
        // Loading saved local results is best-effort; failed restores should not block fresh analysis.
      });
    return () => {
      cancelled = true;
    };
  }, [isExploration, selectedVideo?.path, session?.id]);

  const restoreLatestLocalVisionResult = async () => {
    if (!session?.id || !selectedVideo?.path) return;
    setLocalVisionError("");
    setLocalVisionStatus("Checking saved local vision results...");
    try {
      const payload = await base44.integrations.Core.ListLocalVisionResults({ sessionId: session.id, limit: 12 });
      const latest = (payload?.results || [])
        .filter((row) => row?.result?.ok)
        .filter((row) => !row.video_path || row.video_path === selectedVideo.path)
        .sort((a, b) => Date.parse(b.created_at || "") - Date.parse(a.created_at || ""))[0];
      if (!latest?.result) {
        setLocalVisionStatus("No saved local vision result found for this selected video yet.");
        return;
      }
      const restored = { ...latest.result, id: latest.id, created_at: latest.created_at, analysis_type: latest.analysis_type };
      setLocalVisionResult(restored);
      setLocalVisionQaResult(null);
      setLocalVisionStatus(`Reloaded saved local ${latest.analysis_type || "analysis"} from ${new Date(latest.created_at).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}.`);
      const restoredCard = cardFromLocalVisionResult(restored, selectedVideo, isExploration);
      if (restoredCard) {
        setCards((current) => {
          const withoutSame = current.filter((card) => card.id !== restoredCard.id && !card.localVision);
          return [restoredCard, ...withoutSame];
        });
        setExpanded((prev) => ({ ...prev, [restoredCard.id]: true }));
      }
    } catch (err) {
      setLocalVisionError(err?.data?.error || err?.message || "Could not reload saved local vision result.");
      setLocalVisionStatus("");
    }
  };

  const localVisionRange = useCallback(() => {
    const start = Math.max(0, scanMode === "continue" ? scanCursor : 0);
    const end = Math.max(start + 1, sessionEnd || metadataDurationSeconds || start + clipSeconds);
    return {
      start,
      end,
      sourceStart: sourceTimeForSession(start, selectedVideo),
      sourceEnd: sourceTimeForSession(end, selectedVideo),
    };
  }, [clipSeconds, metadataDurationSeconds, scanCursor, scanMode, selectedVideo, sessionEnd]);

  const localVisionRecordType = useCallback(() => {
    return localAnalysisType || "general_session";
  }, [localAnalysisType]);

  const localVisionVerificationWindows = useCallback((result, limit = 6) => {
    const rows = [
      ...arrayFromMaybe(result?.actionable_findings).map((item) => ({ item, priority: 0, status: "confirmed" })),
      ...arrayFromMaybe(result?.strong_candidates).map((item) => ({ item, priority: 1, status: "candidate" })),
      ...arrayFromMaybe(result?.session_analysis_export?.confirmed_findings).map((item) => ({ item, priority: 2, status: "confirmed" })),
      ...arrayFromMaybe(result?.session_analysis_export?.strong_candidates).map((item) => ({ item, priority: 3, status: "candidate" })),
    ];
    const seen = new Set();
    return rows
      .map(({ item, priority, status }) => {
        const startMs = Number(item.start_ms ?? item.startMs ?? item.time_ms ?? item.timeMs);
        const endMs = Number(item.end_ms ?? item.endMs ?? item.start_ms ?? item.startMs ?? item.time_ms ?? item.timeMs);
        if (!Number.isFinite(startMs)) return null;
        const safeEndMs = Number.isFinite(endMs) ? Math.max(endMs, startMs + 1500) : startMs + 12000;
        const label = humanizeLocalVisionLabel(item.label || item.type || item.event_type || "local candidate");
        const startSeconds = Math.max(0, startMs / 1000 - 1.5);
        const endSeconds = Math.max(startSeconds + 3, safeEndMs / 1000 + 1.5);
        const key = `${Math.round(startSeconds / 2)}|${label.toLowerCase()}`;
        if (seen.has(key)) return null;
        seen.add(key);
        return {
          priority,
          status,
          label,
          basis: item.basis || arrayFromMaybe(item.reasons).join("; ") || "Local CV selected this as a meaningful review window.",
          confidence: item.confidence_label || confidenceWord(item.confidence ?? item.score),
          frameRefs: arrayFromMaybe(item.frame_refs || item.evidence_refs || item.frame_ref),
          sourceStart: startSeconds,
          sourceEnd: endSeconds,
          sessionStart: sessionTimeForSource(startSeconds, selectedVideo),
          sessionEnd: sessionTimeForSource(endSeconds, selectedVideo),
        };
      })
      .filter(Boolean)
      .sort((a, b) => a.priority - b.priority || a.sourceStart - b.sourceStart)
      .slice(0, limit)
      .sort((a, b) => a.sourceStart - b.sourceStart);
  }, [selectedVideo]);

  const verifyLocalWindowsWithSarah = async (result, { limit = 6 } = {}) => {
    if (!selectedVideo?.path || hybridSarahVerifying) return [];
    const windows = localVisionVerificationWindows(result, limit);
    if (!windows.length) {
      setStatus("Sarah verification skipped: local review did not produce candidate windows worth sending.");
      return [];
    }
    setHybridSarahVerifying(true);
    setError("");
    const verifiedCards = [];
    const videoContext = isExploration
      ? buildBodyExplorationVideoContext(session, selectedVideo, timelineRows)
      : buildSessionVideoContext(session, selectedVideo, timelineRows);
    const localCards = arrayFromMaybe(result?.session_analysis_export?.local_annotation_cards)
      .concat(result?.session_analysis_export?.local_annotation_cards?.length ? [] : buildSarahLocalAnnotationCards(result));
    try {
      for (let i = 0; i < windows.length; i += 1) {
        const window = windows[i];
        const label = `Sarah verify local window ${fmtMmSs(window.sessionStart)}-${fmtMmSs(window.sessionEnd)}`;
        setStatus(`Sarah verifying local candidate ${i + 1}/${windows.length}: ${fmtMmSs(window.sessionStart)}-${fmtMmSs(window.sessionEnd)}`);
        const preview = await base44.integrations.Core.ProcessLocalVideoClip({
          path: selectedVideo.path,
          startSeconds: window.sourceStart,
          endSeconds: window.sourceEnd,
          label,
          frameCount: 10,
        });
        const reviewWindow = {
          start: sessionTimeForSource(preview.startSeconds ?? window.sourceStart, selectedVideo),
          end: sessionTimeForSource(preview.endSeconds ?? window.sourceEnd, selectedVideo),
        };
        const sourceStart = preview.startSeconds ?? window.sourceStart;
        const sourceEnd = preview.endSeconds ?? window.sourceEnd;
        const telemetry = nearestTelemetrySummary(timelineRows, reviewWindow.start, reviewWindow.end);
        const frameTiming = (preview.frames || [])
          .map((frame, index) => `frame ${index + 1} = ${recordLabel} ${fmtMmSs(sessionTimeForSource(frame.frameTimeSeconds, selectedVideo))} (source ${fmtMmSs(frame.frameTimeSeconds)})`)
          .join(", ");
        const nearbyLocalCards = localCards
          .filter((card) => {
            const startMs = Number(card.start_ms ?? 0);
            const endMs = Number(card.end_ms ?? startMs);
            return endMs >= window.sourceStart * 1000 - 5000 && startMs <= window.sourceEnd * 1000 + 5000;
          })
          .slice(0, 4)
          .map((card) => `${card.timestamp_range || `${fmtMmSs((card.start_ms || 0) / 1000)}-${fmtMmSs((card.end_ms || 0) / 1000)}`}: ${card.title || "Local candidate"} | ${card.status || "candidate"} | ${card.summary || card.visible_evidence || ""}`)
          .join("\n");
        const continuityContext = compactCardContinuity(verifiedCards[verifiedCards.length - 1], isExploration)
          || "No prior Sarah verification card is available in this hybrid run. Establish the visible state for this window and carry useful continuity forward.";
        const images = (preview.frames || []).map((frame) => ({
          filename: frame.filename,
          media_type: frame.mimeType || "image/jpeg",
          data: frame.data,
        }));
        const aiPayload = {
          max_tokens: 2200,
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
          prompt: `You are Sarah verifying a local GPU-selected video window for Sarah.

This is a hybrid local-first review: local CV/Qwen selected this window as worth looking at, but the local result is only a selector. The sampled frames in this request are the visual evidence. Do not promote the local candidate into a fact unless the current sampled frames visibly support it.

Write one Sarah-style annotation card for this reviewed window:
- summary: 2 concise chronological sentences describing what is visible, what changed, and what remains uncertain.
- findings: 2-4 useful clinical finding cards when supported by visible evidence; fewer or none if the frames do not add useful evidence.
- events: 1-3 concise draft timeline events only for meaningful visible changes.

Evidence discipline:
- Separate direct visual evidence from telemetry support, user/session context, and hypothesis.
- Do not infer orgasm, climax, ejaculation, fluid release, pain, pleasure, intent, edging, or causality from movement alone.
- Use "possible" and low/moderate confidence when visibility, occlusion, blur, or camera angle limits certainty.
- If the window does not visually confirm the local candidate, say that plainly and explain what was checked.
- Do not use raw second-offset wording in prose. Use clock-style window labels or plain chronological wording.
- ${ANATOMICAL_LATERALITY_RULE}

${isExploration ? `Body exploration / procedure mode:
Use clinical procedure language. For Foley or urethral/procedure review, distinguish setup, prep, swabbing, lubrication/dilation, visible meatal contact, visible advancement, visible catheter/Foley-at-meatus state, tubing/field handling, urine return, balloon/securement, and cleanup. Do not claim advancement, insertion, urine return, balloon inflation, or securement unless that exact action/item is visible or explicitly logged. Do not claim already-in-place/dwell/post-placement merely because Foley/catheter material is first visible at the glans or meatus; first visibility at the meatus should be treated as meatal engagement or early insertion/advancement when motion supports it unless an earlier manual/corrected reviewed event confirms completed placement.` : `Session mode:
Use clinical session language. Track visible hand/body/device contact, stimulation changes, pauses/resumptions, lubrication/device handling, posture/lower-body movement, visible genital/body state, and limitations. Do not label edging unless explicitly logged or unmistakably shown by repeated intended near-climax approach-and-withdraw cycles.`}

Local selector packet for this window:
Candidate label: ${window.label}
Candidate status: ${window.status}
Candidate strength: ${window.confidence}
Local basis: ${window.basis}
Local frame references: ${window.frameRefs.join(", ") || "none"}
Nearby local annotation cards:
${nearbyLocalCards || "None. Local annotation did not produce useful cards near this window."}

Continuity from prior Sarah-verified window:
${continuityContext}

Limited ${recordLabel} context:
${videoContext || `No additional ${recordLabel} context is available.`}

Reviewed ${recordLabel} window: ${fmtMmSs(reviewWindow.start)} to ${fmtMmSs(reviewWindow.end)}.
Source video window: ${fmtMmSs(sourceStart)} to ${fmtMmSs(sourceEnd)}.
Sampled frame timing in image order: ${frameTiming || "No decoded frame timing was returned."}
Telemetry in this window: ${telemetry}

Return only the structured JSON matching the requested schema.`,
        };
        const completedJob = await runBackgroundAIVideoReview({
          aiPayload,
          cardMeta: {
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
          },
          session,
          recordType,
          label,
          onProgress: (job) => {
            const progress = job?.progress || {};
            if (progress.message) setStatus(progress.message);
          },
        });
        const normalized = normalizeAIResult(completedJob.result, reviewWindow, selectedVideoRole, isExploration);
        const verifiedCard = {
          id: `hybrid-sarah-${completedJob.id || Date.now()}-${i}`,
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
          hybridSarahVerification: true,
          localSelector: window,
          ...normalized,
        };
        verifiedCards.push(verifiedCard);
        setCards((current) => [...current.filter((card) => card.id !== verifiedCard.id), verifiedCard]);
        setExpanded((prev) => ({ ...prev, [verifiedCard.id]: true }));
      }
      setStatus(`Sarah verification complete: ${verifiedCards.length} local-selected window${verifiedCards.length === 1 ? "" : "s"} reviewed.`);
      return verifiedCards;
    } catch (err) {
      setError(err?.data?.error || err?.message || "Sarah verification of local windows failed.");
      setStatus("");
      return verifiedCards;
    } finally {
      setHybridSarahVerifying(false);
    }
  };

  const analyzeAdaptiveLocally = async (options = {}) => {
    const verifyWithSarah = options?.verifyWithSarah === true;
    if (!selectedVideo?.path || localVisionRunning || visionEngine === "cloud") return;
    const range = localVisionRange();
    const mode = localAnalysisMode || "balanced";
    const modeLabel = localAnalysisModeLabel(mode);
    const { candidatePolicy, qwenPolicy } = adaptivePolicyForMode(mode);
    setLocalVisionRunning(true);
    setLocalVisionError("");
    setLocalVisionLiveLog([]);
    updateLocalVisionProgress({
      phase: "starting",
      current: 0,
      total: mode === "fast_preview" ? 4 : 6,
      message: `Starting ${modeLabel.toLowerCase()}...`,
      recordType: localVisionRecordType(),
      mode,
      roiConfigured: localVisionRois.length > 0,
      roiLabels: localVisionRois.map((roi) => roi.label),
    });
    setLocalVisionResult(null);
    setLocalVisionQaResult(null);
    setLocalVisionStatus(`Starting ${modeLabel}: chronological CV scan first, Qwen only on selected checkpoint windows.`);
    try {
      const payload = {
        sessionId: session.id,
        recordType: localVisionRecordType(),
        videoPath: selectedVideo.path,
        startMs: Math.round(range.sourceStart * 1000),
        endMs: Math.round(range.sourceEnd * 1000),
        mode,
        engine: "local_qwen25vl",
        workflow: "local_vision_forward_review",
        candidatePolicy,
        qwenPolicy,
        forwardPolicy: {
          baselineFps: candidatePolicy.baselineFps,
          motionPeakFps: candidatePolicy.motionPeakFps,
          windowSeconds: Math.round(((candidatePolicy.candidateWindowPreMs || 3000) + (candidatePolicy.candidateWindowPostMs || 3000)) / 1000),
          stepSeconds: 10,
          maxQwenWindows: qwenPolicy.maxQwenWindows,
          maxFramesPerQwenWindow: qwenPolicy.maxFramesPerWindow,
          maintainRollingState: true,
          allowRetrospectiveRefinement: true,
        },
        regionsOfInterest: localVisionRois,
        scaleCalibration: { available: false, pixelsPerCm: null, source: null },
      };
      const startedJob = await startBackgroundJob("local_vision_analyze_forward", payload, {
        title: "Local vision annotation",
        label: "Local Vision Forward Review",
        sessionId: session.id,
        source: "AIVideoPassPanel",
        route: window.location.pathname,
        analysisType: localVisionRecordType(),
        mode,
      });
      setLocalVisionStatus(`Queued ${modeLabel.toLowerCase()} job ${startedJob.id.slice(0, 8)}...`);
      const completedJob = await waitForBackgroundJob(startedJob.id, {
        intervalMs: 1500,
        onProgress: (job) => {
          const progress = job.progress || {};
          const qwenCount = progress.qwenCallsTotal
            ? ` · Qwen ${progress.qwenCallsCompleted || 0}/${progress.qwenCallsTotal}`
            : "";
          const candidateText = progress.candidatesFound != null
            ? ` · ${progress.candidatesFound} candidate${progress.candidatesFound === 1 ? "" : "s"}`
            : "";
          const roiText = progress.roiConfigured || progress.roi_configured
            ? ` · ROI ${arrayFromMaybe(progress.roiLabels || progress.roi_labels).join(", ") || "configured"}`
            : "";
          const positionText = progress.scanPercent != null
            ? ` · ${Math.round(progress.scanPercent)}% scanned`
            : "";
          setLocalVisionStatus(`${progressText(progress.message) || "Forward local review running..."}${positionText}${candidateText}${qwenCount}${roiText}`);
          updateLocalVisionProgress(progress);
        },
      });
      const result = completedJob.result;
      setLocalVisionResult(result);
      const localCard = cardFromLocalVisionResult(result, selectedVideo, isExploration);
      if (localCard) {
        setCards([localCard]);
        setExpanded((prev) => ({ ...prev, [localCard.id]: true }));
      }
      setLocalVisionStatus(
        `${modeLabel} complete: ${result.actionable_findings?.length || 0} confirmed, ${result.strong_candidates?.length || 0} strong candidate${result.strong_candidates?.length === 1 ? "" : "s"}, ${result.not_confirmed?.length || 0} not confirmed.`,
      );
      if (verifyWithSarah) {
        await verifyLocalWindowsWithSarah(result, { limit: mode === "fast_preview" ? 4 : 6 });
      }
    } catch (err) {
      const message = err?.data?.error || err?.message || "Adaptive local vision analysis failed.";
      if (/Unknown background job type:\s*local_vision_analyze_forward/i.test(message)) {
        setLocalVisionError("Backend needs a restart: the UI has the Forward Review button, but the running Node server has not loaded the forward job handler yet.");
      } else {
        setLocalVisionError(message);
      }
      setLocalVisionStatus("");
    } finally {
      setLocalVisionRunning(false);
    }
  };

  const analyzeContinuousLocally = async () => {
    if (!selectedVideo?.path || localVisionRunning || visionEngine === "cloud") return;
    const range = localVisionRange();
    setLocalVisionRunning(true);
    setLocalVisionError("");
    setLocalVisionLiveLog([]);
    updateLocalVisionProgress({ phase: "starting", message: "Starting continuous local Qwen job..." });
    setLocalVisionResult(null);
    setLocalVisionQaResult(null);
    setLocalVisionStatus("Sampling continuous local frames for Qwen2.5-VL...");
    try {
      const payload = {
        sessionId: session.id,
        recordType: localVisionRecordType(),
        videoPath: selectedVideo.path,
        startMs: Math.round(range.sourceStart * 1000),
        endMs: Math.round(range.sourceEnd * 1000),
        engine: "local_qwen25vl",
        scanPolicy: {
          baselineFps: 1,
          maxScanFrames: 600,
          includeMotionPeaks: true,
          includeSceneChanges: true,
          dedupe: true,
          batchSize: 8,
          thumbnailWidth: 512,
        },
        refinementPolicy: {
          enabled: true,
          preMs: 5000,
          postMs: 5000,
          fps: 4,
          maxRefinementFramesPerEvent: 80,
        },
        scaleCalibration: { available: false, pixelsPerCm: null, source: null },
      };
      const startedJob = await startBackgroundJob("local_vision_analyze_continuous", payload, {
        sessionId: session.id,
        source: "AIVideoPassPanel",
        route: window.location.pathname,
      });
      setLocalVisionStatus(`Queued continuous local vision job ${startedJob.id.slice(0, 8)}...`);
      const completedJob = await waitForBackgroundJob(startedJob.id, {
        intervalMs: 1500,
        onProgress: (job) => {
          const progress = job.progress || {};
          const count = progress.total ? ` (${progress.current || 0}/${progress.total})` : "";
          setLocalVisionStatus(`${progress.message || "Local Qwen analysis running..."}${count}`);
          updateLocalVisionProgress(progress);
        },
      });
      const result = completedJob.result;
      setLocalVisionResult(result);
      const localCard = cardFromLocalVisionResult(result, selectedVideo, isExploration);
      if (localCard) {
        setCards([localCard]);
        setExpanded((prev) => ({ ...prev, [localCard.id]: true }));
      }
      setLocalVisionStatus(`Continuous local vision complete: ${result.frame_evidence?.length || 0} frame refs, ${result.timeline_events?.length || 0} timeline events, ${result.forbidden_or_not_visible?.length || 0} unsafe/not-visible claims blocked.`);
    } catch (err) {
      setLocalVisionError(err?.data?.error || err?.message || "Continuous local vision analysis failed.");
      setLocalVisionStatus("");
    } finally {
      setLocalVisionRunning(false);
    }
  };

  const analyzeWindowLocally = async () => {
    if (!selectedVideo?.path || localVisionRunning || visionEngine === "cloud") return;
    const foleyDiagnosticQuestions = [
        "foley_catheter_visible",
        "foley_tubing_visible",
        "statlock_visible",
        "adhesive_securement_device_visible",
        "gloved_hands_visible",
        "hands_touching_glans_or_meatus",
        "catheter_tip_at_or_entering_meatus",
        "visible_advancement_motion",
        "tubing_routing_or_field_handling",
        "urine_visible",
        "balloon_inflation_visible",
        "drape_applied_adjusted_or_removed",
        "swab_gauze_syringe_lubricant_visible",
        "anatomy_obscured_or_unclear",
    ];
    const bodyDiagnosticQuestions = [
        "genital_state_visible",
        "erection_state_visible",
        "genital_visibility_obscured",
        "hand_contact_with_genitals_visible",
        "pelvic_motion_visible",
        "body_tension_or_relaxation_visible",
        "leg_or_foot_position_visible",
        "toe_curling_or_foot_flexion_visible",
        "stroking_motion_visible",
        "grip_or_contact_change_visible",
        "ejaculation_or_fluid_release_visible",
        "visible_fluid_present",
        "fluid_stream_or_droplet_visible",
        "fluid_projection_distance_estimate",
        "cleanup_or_wipe_visible",
    ];
    const diagnosticQuestions = localVisionFocus === "foley"
      ? foleyDiagnosticQuestions
      : localVisionFocus === "body"
      ? bodyDiagnosticQuestions
      : [...new Set([...foleyDiagnosticQuestions, ...bodyDiagnosticQuestions])];
    const currentPreviewSource = Number(previewVideoRef.current?.currentTime);
    const previewSession = Number.isFinite(currentPreviewSource)
      ? sessionTimeForSource(currentPreviewSource, selectedVideo)
      : null;
    const currentPreviewSession = previewSession != null && currentPreviewSource > 0.25
      ? previewSession
      : scanCursor;
    const diagnosticStart = clamp(currentPreviewSession, 0, Math.max(0, sessionEnd - 0.25));
    const targetWindow = {
      start: diagnosticStart,
      end: Math.min(sessionEnd, diagnosticStart + clipSeconds),
    };
    const sourceStart = sourceTimeForSession(targetWindow.start, selectedVideo);
    const sourceEnd = sourceTimeForSession(targetWindow.end, selectedVideo);
    setLocalVisionRunning(true);
    setLocalVisionError("");
    setLocalVisionLiveLog([]);
    updateLocalVisionProgress({ phase: "starting", message: "Starting diagnostic local Qwen job..." });
    setLocalVisionResult(null);
    setLocalVisionQaResult(null);
    setLocalVisionStatus(`Sampling diagnostic local window ${fmtMmSs(targetWindow.start)}-${fmtMmSs(targetWindow.end)} for Qwen2.5-VL...`);
    try {
      const payload = {
        sessionId: session.id,
        recordType: localVisionRecordType(),
        videoPath: selectedVideo.path,
        startMs: Math.round(sourceStart * 1000),
        endMs: Math.round(sourceEnd * 1000),
        samplePolicy: {
          fps: 1,
          maxFrames: Math.min(8, Math.max(3, Math.round(clipSeconds / 4))),
          includeMotionPeaks: true,
          dedupe: true,
          thumbnailWidth: 512,
        },
        engine: "local_qwen25vl",
        questions: diagnosticQuestions,
        previousVisualState: {},
      };
      const startedJob = await startBackgroundJob("local_vision_analyze_window", payload, {
        sessionId: session.id,
        source: "AIVideoPassPanel",
        route: window.location.pathname,
      });
      setLocalVisionStatus(`Queued diagnostic local vision job ${startedJob.id.slice(0, 8)}...`);
      const completedJob = await waitForBackgroundJob(startedJob.id, {
        intervalMs: 1500,
        onProgress: (job) => {
          const progress = job.progress || {};
          const count = progress.total ? ` (${progress.current || 0}/${progress.total})` : "";
          setLocalVisionStatus(`${progress.message || "Diagnostic local Qwen analysis running..."}${count}`);
          updateLocalVisionProgress(progress);
        },
      });
      const result = completedJob.result;
      setLocalVisionResult(result);
      const localCard = cardFromLocalVisionResult(result, selectedVideo, isExploration);
      if (localCard) {
        setCards([localCard]);
        setExpanded((prev) => ({ ...prev, [localCard.id]: true }));
      }
      setLocalVisionProgress(null);
      setLocalVisionStatus(`Local vision complete: ${result.frame_evidence?.length || 0} frame${result.frame_evidence?.length === 1 ? "" : "s"} checked, ${result.forbidden_or_not_visible?.length || 0} unsafe claim${result.forbidden_or_not_visible?.length === 1 ? "" : "s"} blocked.`);
    } catch (err) {
      setLocalVisionError(err?.data?.error || err?.message || "Local vision analysis failed.");
      setLocalVisionStatus("");
    } finally {
      setLocalVisionRunning(false);
    }
  };

  const askVideoLocally = async () => {
    if (!selectedVideo?.path || localVisionRunning || visionEngine === "cloud" || !localVisionQuestion.trim()) return;
    const range = localVisionRange();
    setLocalVisionRunning(true);
    setLocalVisionError("");
    setLocalVisionLiveLog([]);
    updateLocalVisionProgress({ phase: "starting", message: "Starting local video Q&A job..." });
    setLocalVisionStatus("Sampling local evidence and asking Qwen2.5-VL...");
    try {
      const payload = {
        sessionId: session.id,
        recordType: localVisionRecordType(),
        videoPath: selectedVideo.path,
        startMs: Math.round(range.sourceStart * 1000),
        endMs: Math.round(range.sourceEnd * 1000),
        question: localVisionQuestion.trim(),
        engine: "local_qwen25vl",
        evidencePolicy: {
          baselineFps: 1,
          maxScanFrames: 300,
          includeMotionPeaks: true,
          includeSceneChanges: true,
          dedupe: true,
          batchSize: 8,
          thumbnailWidth: 512,
          refineAroundLikelyEvidence: true,
        },
        knownTimeline: localVisionResult || null,
        scaleCalibration: { available: false, pixelsPerCm: null, source: null },
      };
      const startedJob = await startBackgroundJob("local_vision_ask_video", payload, {
        sessionId: session.id,
        source: "AIVideoPassPanel",
        route: window.location.pathname,
      });
      setLocalVisionStatus(`Queued local video Q&A job ${startedJob.id.slice(0, 8)}...`);
      const completedJob = await waitForBackgroundJob(startedJob.id, {
        intervalMs: 1500,
        onProgress: (job) => {
          const progress = job.progress || {};
          const count = progress.total ? ` (${progress.current || 0}/${progress.total})` : "";
          setLocalVisionStatus(`${progress.message || "Local Qwen video Q&A running..."}${count}`);
          updateLocalVisionProgress(progress);
        },
      });
      const result = completedJob.result;
      setLocalVisionQaResult(result);
      setLocalVisionProgress(null);
      setLocalVisionStatus(`Local Q&A complete: confidence ${Math.round((result.answer?.confidence || 0) * 100)}%, frames ${result.answer?.frame_refs?.join(", ") || "not cited"}.`);
    } catch (err) {
      setLocalVisionError(err?.data?.error || err?.message || "Local video Q&A failed.");
      setLocalVisionStatus("");
    } finally {
      setLocalVisionRunning(false);
    }
  };

  const copyLocalVisionJson = async () => {
    const payload = localVisionQaResult || localVisionResult;
    if (!payload) return;
    await navigator.clipboard?.writeText(JSON.stringify(payload, null, 2));
    setLocalVisionStatus("Copied local vision JSON to clipboard.");
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

  const localVisionFluidDynamics = Array.isArray(localVisionResult?.fluid_dynamics)
    ? localVisionResult.fluid_dynamics[0]
    : localVisionResult?.fluid_dynamics;

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
            <Sparkles className="h-3.5 w-3.5" /> Claude Video Annotation
          </h4>
          <p className="mt-1 text-xs text-muted-foreground">
            Primary Sarah/Claude workflow for high-quality visual evidence cards. Accepted findings stay saved for Session Analysis until you explicitly clear them.
          </p>
        </div>
        <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
          {storedAIPassEventCount > 0 && (
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button type="button" variant="outline" className="h-8 w-full border-destructive/30 text-destructive hover:bg-destructive/10 sm:w-auto">
                  <Trash2 className="mr-2 h-3.5 w-3.5" />
                  Clear AI Events ({storedAIPassEventCount})
                </Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Clear stored AI-generated annotations?</AlertDialogTitle>
                  <AlertDialogDescription>
                    This removes {storedAIPassEventCount} accepted Sarah/Claude video/audio annotation{storedAIPassEventCount === 1 ? "" : "s"} and stored pass evidence from this {recordLabel}. Manual event notes are kept.
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
          {isExploration && (
            <Button
              type="button"
              variant="outline"
              onClick={reassessExplorationSequence}
              disabled={!cards.length || running || reassessing}
              className="h-8 w-full sm:w-auto"
              title={!cards.length ? "Run a video pass first; reassessment appears once draft cards are loaded." : "Recheck the visible Foley sequence across the loaded draft cards."}
            >
              {reassessing ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="mr-2 h-3.5 w-3.5" />}
              {cards.length ? "Reassess Foley Sequence" : "Reassess after cards load"}
            </Button>
          )}
          <Button type="button" onClick={runPass} disabled={running || reassessing || !selectedVideo || !plannedWindows.length} className="h-8 w-full sm:w-auto">
            {running ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Clapperboard className="mr-2 h-3.5 w-3.5" />}
            {scanMode === "continue" ? (scanCursor > 0 ? "Run Next Claude Pass" : "Start Claude at 0:00") : "Run Claude Window Pass"}
          </Button>
        </div>
      </div>

      <div className="mt-2 rounded-lg border border-primary/20 bg-primary/5 px-3 py-2 text-xs leading-relaxed text-muted-foreground">
        <span className="font-semibold text-foreground">Evidence-safe default:</span> starting a new Claude pass only clears the draft cards on this screen. Accepted timeline events and saved video-pass findings are preserved unless you explicitly use Clear AI Events.
      </div>

      <div className="mt-3 grid gap-2 lg:grid-cols-[minmax(16rem,1fr)_auto]">
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
      </div>
      <div className="mt-2 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <label className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
          Claude Mode
          <select
            value={scanMode}
            onChange={(event) => setScanMode(event.target.value)}
            className="min-w-0 bg-transparent text-foreground outline-none"
          >
            <option value="smart">Smart windows</option>
            <option value="continue">Continue forward</option>
          </select>
        </label>
        <label className={`flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-xs ${scanMode === "continue" ? "text-muted-foreground" : "text-muted-foreground/50"}`}>
          <input
            type="checkbox"
            checked={autoContinue}
            disabled={scanMode !== "continue"}
            onChange={(event) => setAutoContinue(event.target.checked)}
            className="h-3.5 w-3.5 accent-primary"
          />
          Auto-continue
        </label>
        <label className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
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
        <label className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
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
      <details className="mt-3 rounded-xl border border-emerald-500/20 bg-emerald-500/5">
        <summary className="cursor-pointer px-3 py-3 text-xs font-semibold uppercase tracking-wider text-emerald-200">
          Local / Qwen Experimental Tools
        </summary>
        <div className="grid gap-3 border-t border-emerald-500/15 p-3">
          <p className="text-xs text-muted-foreground">
            Local vision stays available for experiments and troubleshooting, but Claude/Sarah is the primary annotation driver again.
          </p>
          <div className="flex flex-wrap gap-2">
            <Button type="button" variant="outline" onClick={restoreLatestLocalVisionResult} disabled={!selectedVideo || localVisionRunning} className="h-8 w-full border-emerald-500/35 text-emerald-200 hover:bg-emerald-500/10 sm:w-auto">
              Review Latest Local Results
            </Button>
            <Button type="button" variant="outline" onClick={analyzeAdaptiveLocally} disabled={localVisionRunning || !selectedVideo} className="h-8 w-full border-emerald-500/35 text-emerald-200 hover:bg-emerald-500/10 sm:w-auto">
              {localVisionRunning ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Eye className="mr-2 h-3.5 w-3.5" />}
              Run Forward Local Review
            </Button>
            <Button
              type="button"
              variant="outline"
              onClick={() => analyzeAdaptiveLocally({ verifyWithSarah: true })}
              disabled={localVisionRunning || hybridSarahVerifying || !selectedVideo}
              className="h-8 w-full border-primary/40 text-primary hover:bg-primary/10 sm:w-auto"
              title="Local GPU selects candidate windows first; Sarah/Claude then reviews only sampled frames from those windows."
            >
              {(localVisionRunning || hybridSarahVerifying) ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="mr-2 h-3.5 w-3.5" />}
              Run Local + Claude Verify
            </Button>
          </div>
          <div className="grid gap-2 lg:grid-cols-2">
            <label className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
              Analysis Type
              <select
                value={localAnalysisType}
                onChange={(event) => setLocalAnalysisType(event.target.value)}
                className="min-w-0 bg-transparent text-foreground outline-none"
              >
                {LOCAL_ANALYSIS_TYPES.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
            <label className="flex items-center gap-2 rounded-lg border border-border bg-background px-3 py-2 text-xs text-muted-foreground">
              Mode
              <select
                value={localAnalysisMode}
                onChange={(event) => setLocalAnalysisMode(event.target.value)}
                className="min-w-0 bg-transparent text-foreground outline-none"
              >
                {LOCAL_ANALYSIS_MODES.map((option) => (
                  <option key={option.value} value={option.value}>{option.label}</option>
                ))}
              </select>
            </label>
          </div>
          <p className={`rounded-lg border px-3 py-2 text-xs ${localAnalysisMode === "deep_forensic" ? "border-amber-400/25 bg-amber-400/5 text-amber-100" : "border-emerald-500/15 bg-emerald-500/5 text-muted-foreground"}`}>
            <span className="font-semibold text-emerald-200">{localAnalysisTypeLabel(localAnalysisType)} · {localAnalysisModeLabel(localAnalysisMode)}:</span>{" "}
            {localAnalysisModeHelper(localAnalysisMode)}
            {localAnalysisMode === "deep_forensic" ? " This is opt-in for slow, GPU-heavy review; Balanced is the normal default." : ""}
          </p>
          <details className="rounded-lg border border-emerald-500/15 bg-background/60">
            <summary className="cursor-pointer px-3 py-2 text-xs font-semibold uppercase tracking-wider text-emerald-200">
              Optional ROI Hints {localVisionRois.length ? `(${localVisionRois.length})` : ""}
            </summary>
            <div className="grid gap-2 border-t border-emerald-500/15 p-3">
          <p className="text-xs text-muted-foreground">
            ROI hints help the cheap forward scan prioritize motion in relevant areas. They are not evidence by themselves; Qwen and the gates still need frame support.
          </p>
          <div className="flex flex-wrap gap-2">
            {(localAnalysisType === "foley_procedure"
              ? ["foley_procedure_field_roi", "tubing_bag_roi", "full_body_roi"]
              : ["genital_hand_roi", "feet_legs_roi", "full_body_roi"]
            ).map((key) => (
              <Button key={key} type="button" size="sm" variant="outline" onClick={() => addLocalVisionRoi(key)} className="h-8 border-emerald-500/35 text-emerald-100 hover:bg-emerald-500/10">
                Add {LOCAL_VISION_ROI_PRESETS[key].label}
              </Button>
            ))}
            {localVisionRois.length > 0 && (
              <Button type="button" size="sm" variant="outline" onClick={() => setLocalVisionRois([])} className="h-8">
                Clear ROI hints
              </Button>
            )}
            {localVisionRois.length > 0 && (
              <Button
                type="button"
                size="sm"
                variant={roiEditMode ? "default" : "outline"}
                onClick={() => setRoiEditMode((value) => !value)}
                className="h-8"
              >
                {roiEditMode ? "Done editing boxes" : "Edit visually on preview"}
              </Button>
            )}
          </div>
          {localVisionRois.length > 0 && (
            <p className="rounded-lg border border-emerald-500/15 bg-background/60 px-3 py-2 text-xs text-muted-foreground">
              {roiEditMode
                ? "Drag a box on the video preview to move it. Drag the blue corner handle to resize it. These boxes guide the cheap CV scan; they do not become visual claims by themselves."
                : "Tap Edit visually on preview to position these regions directly over the video."}
            </p>
          )}
          {localVisionRois.map((roi) => (
            <div
              key={roi.id}
              className={`grid gap-2 rounded-lg border bg-background/70 p-2 text-xs ${activeRoiId === roi.id ? "border-primary/60" : "border-border"}`}
            >
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={roi.label}
                  onChange={(event) => updateLocalVisionRoi(roi.id, { label: event.target.value })}
                  onFocus={() => setActiveRoiId(roi.id)}
                  className="min-w-[12rem] flex-1 rounded border border-border bg-muted/20 px-2 py-1 text-foreground"
                  aria-label="ROI label"
                />
                <span className="rounded-full border border-primary/20 bg-primary/10 px-2 py-1 font-mono text-[10px] text-primary">
                  {Math.round(roi.width * 100)}% x {Math.round(roi.height * 100)}%
                </span>
                <Button type="button" size="sm" variant="ghost" onClick={() => removeLocalVisionRoi(roi.id)} className="h-8 text-destructive hover:bg-destructive/10">
                  Remove
                </Button>
              </div>
              <details className="rounded-lg border border-border/70 bg-muted/10">
                <summary className="cursor-pointer px-2 py-1.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Exact values
                </summary>
                <div className="grid gap-2 border-t border-border/70 p-2 sm:grid-cols-4">
                  {["x", "y", "width", "height"].map((field) => (
                    <label key={field} className="grid gap-1 text-[10px] uppercase tracking-wider text-muted-foreground">
                      {field}
                      <input
                        type="number"
                        min="0"
                        max="1"
                        step="0.01"
                        value={Number(roi[field]).toFixed(2)}
                        onChange={(event) => updateLocalVisionRoi(roi.id, { [field]: Number(event.target.value) })}
                        className="rounded border border-border bg-muted/20 px-2 py-1 font-mono text-xs text-foreground"
                      />
                    </label>
                  ))}
                </div>
              </details>
            </div>
          ))}
        </div>
      </details>
        </div>
      </details>
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
          <div className="relative overflow-hidden rounded-lg bg-black">
            <video
              key={selectedVideo?.path}
              ref={previewVideoRef}
              src={selectedVideoStreamUrl}
              controls
              preload="metadata"
              className="max-h-[34rem] w-full bg-black object-contain"
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
            {localVisionRois.length > 0 && (
              <div
                ref={roiOverlayRef}
                className={`absolute inset-0 ${roiEditMode ? "pointer-events-auto cursor-crosshair touch-none" : "pointer-events-none"}`}
                aria-hidden={!roiEditMode}
              >
                {localVisionRois.map((roi, index) => {
                  const active = activeRoiId === roi.id;
                  return (
                    <div
                      key={roi.id}
                      role="button"
                      tabIndex={roiEditMode ? 0 : -1}
                      aria-label={`Move ${roi.label} ROI`}
                      onPointerDown={(event) => beginLocalVisionRoiDrag(roi, "move", event)}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        setActiveRoiId(roi.id);
                      }}
                      className={`absolute rounded-lg border-2 bg-primary/10 shadow-[0_0_0_9999px_rgba(0,0,0,0.08)] transition ${active ? "border-primary" : "border-emerald-300/80"} ${roiEditMode ? "cursor-move" : ""}`}
                      style={{
                        left: `${roi.x * 100}%`,
                        top: `${roi.y * 100}%`,
                        width: `${roi.width * 100}%`,
                        height: `${roi.height * 100}%`,
                      }}
                    >
                      <div className="absolute left-2 top-2 max-w-[calc(100%-1rem)] rounded-full border border-black/20 bg-black/75 px-2 py-1 text-[10px] font-semibold text-white shadow">
                        {index + 1}. {roi.label}
                      </div>
                      {roiEditMode && (
                        <button
                          type="button"
                          aria-label={`Resize ${roi.label} ROI`}
                          onPointerDown={(event) => beginLocalVisionRoiDrag(roi, "resize", event)}
                          className="absolute bottom-0 right-0 h-8 w-8 translate-x-1/2 translate-y-1/2 rounded-full border-2 border-white bg-primary shadow-lg"
                        />
                      )}
                    </div>
                  );
                })}
              </div>
            )}
            {localVisionRois.length > 0 && !roiEditMode && (
              <div className="pointer-events-none absolute bottom-2 left-2 rounded-full border border-emerald-300/25 bg-black/70 px-2 py-1 text-[10px] font-semibold text-emerald-100">
                {localVisionRois.length} ROI hint{localVisionRois.length === 1 ? "" : "s"} configured
              </div>
            )}
          </div>
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

      {(localVisionRunning || localVisionResult || localVisionStatus || localVisionError || localVisionQaResult) && (
      <details className="mt-3 max-w-full overflow-hidden rounded-xl border border-emerald-500/25 bg-emerald-500/5">
        <summary className="cursor-pointer px-3 py-3 text-xs font-semibold uppercase tracking-wider text-emerald-200">
          Local Results / Experimental Evidence
        </summary>
      <div className="border-t border-emerald-500/15 p-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1">
            <h5 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-emerald-300">
              <ShieldCheck className="h-3.5 w-3.5" /> Local Results
            </h5>
            <p className="mt-1 text-xs text-muted-foreground">
              Review the latest local-only visual evidence. Frame claims cite sampled evidence and local mode never falls back to cloud.
            </p>
          </div>
        </div>
        <div className="mt-2 flex flex-wrap gap-2 text-[10px]">
          <span className="max-w-full truncate rounded-full border border-emerald-500/30 bg-emerald-500/10 px-2 py-1 font-semibold text-emerald-200">
            Local-only: no cloud frame upload
          </span>
          <span className="max-w-full truncate rounded-full border border-border bg-background px-2 py-1 text-muted-foreground">
            Range {fmtMmSs(localVisionRange().start)}-{fmtMmSs(localVisionRange().end)}
          </span>
          <span className="max-w-full truncate rounded-full border border-border bg-background px-2 py-1 text-muted-foreground">
            Qwen2.5-VL service on localhost
          </span>
          <span className="max-w-full truncate rounded-full border border-border bg-background px-2 py-1 text-muted-foreground">
            Type {localAnalysisTypeLabel(localAnalysisType)}
          </span>
          <span className="max-w-full truncate rounded-full border border-border bg-background px-2 py-1 text-muted-foreground">
            Mode {localAnalysisModeLabel(localAnalysisMode)}
          </span>
          <span className={`max-w-full truncate rounded-full border px-2 py-1 ${localVisionHealth?.ok ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-200" : "border-destructive/30 bg-destructive/10 text-destructive"}`}>
            {localVisionHealth?.ok ? `Service ready · ${localVisionHealth?.model?.name || localVisionHealth?.model || "model"}` : (localVisionHealth?.error || "Service not checked")}
          </span>
        </div>
        {(localVisionStatus || localVisionError) && (
          <div className={`mt-3 rounded-lg border px-3 py-2 text-xs ${localVisionError ? "border-destructive/40 bg-destructive/10 text-destructive" : "border-emerald-500/25 bg-emerald-500/10 text-emerald-100"}`}>
            {localVisionError || localVisionStatus}
          </div>
        )}
        {localVisionRunning && localVisionProgress && (
          <div className="mt-3 rounded-lg border border-emerald-500/20 bg-background/70 p-3">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-300">
                {String(localVisionProgress.phase || "running").replace(/_/g, " ")}
              </p>
              {localVisionProgress.total > 0 && (
                <span className="font-mono text-[10px] text-muted-foreground">
                  {localVisionProgress.current || 0}/{localVisionProgress.total}
                </span>
              )}
            </div>
            {localVisionProgress.total > 0 && (
              <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-muted">
                <div
                  className="h-full rounded-full bg-emerald-400 transition-all"
                  style={{ width: `${Math.max(4, Math.min(100, ((localVisionProgress.current || 0) / localVisionProgress.total) * 100))}%` }}
                />
              </div>
            )}
            <div className="mt-3 grid gap-2 text-xs sm:grid-cols-4">
              {[
                ["Planned frames", localVisionProgress.planned_frames],
                ["Sampled", localVisionProgress.sampled_frames],
                ["CV frames scanned", localVisionProgress.framesScanned ?? localVisionProgress.scanned_frames],
                ["Scan position", localVisionProgress.current_timestamp_ms != null ? fmtMmSs((localVisionProgress.current_timestamp_ms || 0) / 1000) : null],
                ["Range scanned", localVisionProgress.percent_scanned != null ? `${Math.round(localVisionProgress.percent_scanned)}%` : (localVisionProgress.scanPercent != null ? `${Math.round(localVisionProgress.scanPercent)}%` : null)],
                ["Candidates found", localVisionProgress.candidatesFound ?? localVisionProgress.candidates_found ?? localVisionProgress.candidate_events],
                ["Qwen selected", localVisionProgress.candidatesSelectedForQwen ?? localVisionProgress.candidates_selected_for_qwen],
                ["Qwen calls", localVisionProgress.qwenCallsTotal != null ? `${localVisionProgress.qwenCallsCompleted || 0}/${localVisionProgress.qwenCallsTotal}` : null],
                ["ROI hints", (localVisionProgress.roiConfigured || localVisionProgress.roi_configured) ? arrayFromMaybe(localVisionProgress.roiLabels || localVisionProgress.roi_labels).join(", ") || `${localVisionProgress.roi_count || 0}` : null],
                ["ROI motion", localVisionProgress.latest_candidate_window?.roi?.motion_score != null ? `${Math.round(Number(localVisionProgress.latest_candidate_window.roi.motion_score || 0) * 100)}%` : null],
                ["Confirmed", localVisionProgress.confirmedFindingsCount ?? localVisionProgress.confirmed_findings_count],
                ["Strong candidates", localVisionProgress.strongCandidatesCount ?? localVisionProgress.strong_candidates_count],
                ["Not confirmed", localVisionProgress.notConfirmedCount ?? localVisionProgress.not_confirmed_count],
                ["Down/rejected", localVisionProgress.downgradedRejectedCandidatesCount ?? localVisionProgress.downgraded_rejected_candidates_count],
                ["Blocked", localVisionProgress.blocked_claims],
                ["Batch frames", localVisionProgress.frame_count],
              ].filter(([, value]) => value != null).map(([label, value]) => (
                <div key={label} className="rounded-md border border-border bg-muted/10 px-2 py-1.5">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
                  <p className="font-mono text-sm text-foreground">{value}</p>
                </div>
              ))}
            </div>
            {progressCandidate(localVisionProgress) && (
              <div className="mt-3 rounded-lg border border-primary/25 bg-primary/5 p-3 text-xs">
                {(() => {
                  const candidate = progressCandidate(localVisionProgress);
                  const reasons = arrayFromMaybe(candidate.reasons || localVisionProgress.latest_candidate_reasons);
                  const questionIds = arrayFromMaybe(candidate.selected_question_ids || localVisionProgress.selected_question_ids);
                  return (
                    <>
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-primary">Current Qwen Checkpoint</p>
                        {candidate.score != null && (
                          <span className="rounded-full border border-primary/25 bg-primary/10 px-2 py-0.5 font-mono text-[10px] text-primary">
                            score {Math.round(Number(candidate.score || 0) * 100)}%
                          </span>
                        )}
                        {candidate.roi?.label && (
                          <span className="rounded-full border border-emerald-500/25 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-200">
                            ROI {candidate.roi.label}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 font-semibold text-foreground">
                        {candidateLabel(candidate)}
                        {candidate.start_ms != null && (
                          <span className="ml-2 font-mono text-muted-foreground">
                            {fmtMmSs((candidate.start_ms || 0) / 1000)}-{fmtMmSs((candidate.end_ms || candidate.start_ms || 0) / 1000)}
                          </span>
                        )}
                      </p>
                      {reasons.length > 0 && (
                        <div className="mt-2 flex flex-wrap gap-1.5">
                          {reasons.slice(0, 4).map((reason) => (
                            <span key={reason} className="rounded-full border border-border bg-background/70 px-2 py-0.5 text-[10px] text-muted-foreground">
                              {reason}
                            </span>
                          ))}
                        </div>
                      )}
                      <div className="mt-2 grid gap-2 sm:grid-cols-3">
                        {candidate.qwen_index != null && candidate.qwen_total != null && (
                          <div className="rounded-md border border-border bg-background/70 px-2 py-1.5">
                            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Qwen Window</p>
                            <p className="font-mono text-sm text-foreground">{candidate.qwen_index}/{candidate.qwen_total}</p>
                          </div>
                        )}
                        {(candidate.qwen_sampled_frames != null || localVisionProgress.sampled_frames != null) && (
                          <div className="rounded-md border border-border bg-background/70 px-2 py-1.5">
                            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Frames To Qwen</p>
                            <p className="font-mono text-sm text-foreground">{candidate.qwen_sampled_frames ?? localVisionProgress.sampled_frames}</p>
                          </div>
                        )}
                        {questionIds.length > 0 && (
                          <div className="rounded-md border border-border bg-background/70 px-2 py-1.5">
                            <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Focused Questions</p>
                            <p className="font-mono text-sm text-foreground">{questionIds.length}</p>
                          </div>
                        )}
                      </div>
                      {candidate.qwen_result_summary && (
                        <p className="mt-2 rounded-md border border-border bg-background/70 px-2 py-1.5 text-muted-foreground">
                          Latest Qwen read: {candidate.qwen_result_summary}
                        </p>
                      )}
                    </>
                  );
                })()}
              </div>
            )}
            {localVisionProgress.top_candidates?.length > 0 && (
              <details className="mt-3 rounded-lg border border-border bg-muted/10">
                <summary className="cursor-pointer px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Top CV Candidate Windows ({localVisionProgress.top_candidates.length})
                </summary>
                <div className="space-y-1.5 border-t border-border p-2">
                  {localVisionProgress.top_candidates.map((candidate) => (
                    <button
                      type="button"
                      key={candidate.candidate_id}
                      onClick={() => seekPreviewVideo(sessionTimeForSource((candidate.start_ms || 0) / 1000, selectedVideo))}
                      className="w-full rounded-md border border-border bg-background/70 px-2 py-1.5 text-left text-xs hover:border-primary/50"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-semibold text-foreground">
                          {fmtMmSs((candidate.start_ms || 0) / 1000)}-{fmtMmSs((candidate.end_ms || candidate.start_ms || 0) / 1000)} · {candidateLabel(candidate)}
                        </span>
                        <span className="font-mono text-muted-foreground">{Math.round(Number(candidate.score || 0) * 100)}%</span>
                      </div>
                      {candidate.reasons?.length > 0 && (
                        <p className="mt-1 text-muted-foreground">{candidate.reasons.slice(0, 3).join("; ")}</p>
                      )}
                    </button>
                  ))}
                </div>
              </details>
            )}
            {localVisionProgress.latest_summary && (
              <p className="mt-2 rounded-md border border-border bg-muted/10 px-2 py-1.5 text-xs text-muted-foreground">
                Latest batch: {localVisionProgress.latest_summary}
              </p>
            )}
            {(localVisionProgress.latest_rolling_state || localVisionProgress.rolling_state) && (
              <div className="mt-2 rounded-md border border-emerald-500/20 bg-emerald-500/5 px-2 py-1.5 text-xs text-muted-foreground">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-300">Rolling State</p>
                <p className="mt-1">{formatLocalVisionRollingState(localVisionProgress.latest_rolling_state || localVisionProgress.rolling_state) || "Chronological state is updating."}</p>
              </div>
            )}
            {localVisionLiveLog.length > 0 && (
              <div className="mt-3 rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-2">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-300">Live Evidence Feed</p>
                  <span className="text-[10px] text-muted-foreground">newest first</span>
                </div>
                <div className="mt-2 space-y-1.5">
                  {localVisionLiveLog.slice(0, 6).map((entry) => (
                    <div key={entry.key} className="rounded-md border border-border bg-background/70 px-2 py-1.5 text-xs">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="rounded-full border border-emerald-500/25 bg-emerald-500/10 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-emerald-200">
                          {entry.phase}
                        </span>
                        <span className="font-mono text-[10px] text-muted-foreground">
                          {fmtClockTime(entry.at)}
                        </span>
                      </div>
                      <p className="mt-1 leading-relaxed text-foreground/85">{entry.text}</p>
                      {entry.details && (
                        <p className="mt-1 font-mono text-[10px] text-muted-foreground">{entry.details}</p>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
            {localVisionProgress.latest_frame?.image_path && (
              <button
                type="button"
                onClick={() => seekPreviewVideo(sessionTimeForSource((localVisionProgress.latest_frame.time_ms || 0) / 1000, selectedVideo))}
                className="mt-3 flex w-full items-center gap-3 rounded-md border border-border bg-muted/10 p-2 text-left hover:border-emerald-400/50"
              >
                <img
                  src={base44.integrations.Core.localVisionAssetUrl(localVisionProgress.latest_frame.image_path)}
                  alt={`Latest sampled local vision frame ${localVisionProgress.latest_frame.frame_id}`}
                  className="h-16 w-28 rounded bg-black object-cover"
                />
                <span className="min-w-0 text-xs">
                  <span className="block font-semibold text-foreground">Latest sampled frame</span>
                  <span className="block font-mono text-muted-foreground">
                    {localVisionProgress.latest_frame.frame_id} · {fmtMmSs((localVisionProgress.latest_frame.time_ms || 0) / 1000)}
                  </span>
                </span>
              </button>
            )}
          </div>
        )}
        {!localVisionRunning && !localVisionResult && !localVisionError && (
          <div className="mt-3 rounded-lg border border-border bg-background/70 p-3 text-xs text-muted-foreground">
            Run a local full-range pass or reload the latest saved local result to review timeline evidence here.
          </div>
        )}
        {localVisionResult && (
          <div className="mt-3 grid min-w-0 gap-3">
            <div className="max-w-full overflow-hidden rounded-lg border border-border bg-background/70 p-3">
              {(() => {
                const verdict = localVisionVerdict(localVisionResult);
                const counts = localVisionSummaryCounts(localVisionResult);
                return (
                  <div className="mb-3 rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-3">
                    <div className="grid gap-2 sm:flex sm:items-start sm:justify-between">
                      <div className="min-w-0">
                        <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-300">Local Vision Summary</p>
                        <p className="mt-1 text-sm font-semibold text-foreground">{verdict.label}</p>
                        <p className="mt-1 break-words text-sm leading-relaxed text-foreground/90">{verdict.text}</p>
                      </div>
                      <span className="w-fit rounded-full border border-border bg-background/80 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                        {verdict.key.replace(/_/g, " ")}
                      </span>
                    </div>
                    <div className="mt-3 grid gap-2 sm:grid-cols-3">
                      <div className="rounded-md border border-border bg-background/70 px-2 py-1.5">
                        <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Confirmed visual events</p>
                        <p className="font-mono text-base text-foreground">{counts.confirmed}</p>
                      </div>
                      <div className="rounded-md border border-border bg-background/70 px-2 py-1.5">
                        <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Strong candidate windows</p>
                        <p className="font-mono text-base text-foreground">{counts.candidates}</p>
                      </div>
                      <div className="rounded-md border border-border bg-background/70 px-2 py-1.5">
                        <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Not visually confirmed</p>
                        <p className="font-mono text-base text-foreground">{counts.notConfirmed}</p>
                      </div>
                    </div>
                    {counts.confirmed === 0 && (
                      <p className="mt-2 rounded-md border border-amber-400/25 bg-amber-400/10 px-2 py-1.5 text-xs leading-relaxed text-amber-100">
                        No confirmed local visual events were promoted. Candidate markers are review aids only, not proof that the event happened.
                      </p>
                    )}
                  </div>
                );
              })()}
              <div className="grid min-w-0 gap-2 sm:flex sm:items-start sm:justify-between">
                <div className="min-w-0">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-300">Sarah Forward Local Review</p>
                  <p className="mt-1 break-words text-sm leading-relaxed text-foreground/90">{sarahLocalVisionSummary(localVisionResult)}</p>
                </div>
                <Button type="button" size="sm" variant="outline" onClick={copyLocalVisionJson} className="h-8 w-full justify-center sm:h-7 sm:w-auto sm:shrink-0">
                  <Copy className="mr-1 h-3.5 w-3.5" /> Copy JSON
                </Button>
              </div>
              <div className="mt-3 grid min-w-0 gap-2 sm:grid-cols-3">
                <div className="min-w-0 rounded-md border border-border bg-muted/15 px-2 py-1.5">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Overall</p>
                  <p className="font-mono text-sm text-foreground">{Math.round((localVisionResult.confidence?.overall || 0) * 100)}%</p>
                </div>
                <div className="min-w-0 rounded-md border border-border bg-muted/15 px-2 py-1.5">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Visibility</p>
                  <p className="font-mono text-sm text-foreground">{Math.round((localVisionResult.confidence?.visibility_quality || 0) * 100)}%</p>
                </div>
                <div className="min-w-0 rounded-md border border-border bg-muted/15 px-2 py-1.5">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Engine</p>
                  <p className="min-w-0 break-all text-sm text-foreground sm:truncate">{localVisionResult.engine} · {localVisionResult.model?.name || localVisionResult.model}</p>
                </div>
              </div>
              <div className="mt-3 grid min-w-0 gap-2 sm:grid-cols-3">
                <div className="min-w-0 rounded-md border border-border bg-muted/15 px-2 py-1.5">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Actionable</p>
                  <p className="font-mono text-sm text-foreground">{localVisionResult.actionable_findings?.length ?? localVisionResult.timeline_events?.length ?? 0}</p>
                </div>
                <div className="min-w-0 rounded-md border border-border bg-muted/15 px-2 py-1.5">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Strong Candidates</p>
                  <p className="font-mono text-sm text-foreground">{localVisionResult.strong_candidates?.length || 0}</p>
                </div>
                <div className="min-w-0 rounded-md border border-border bg-muted/15 px-2 py-1.5">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Not Confirmed</p>
                  <p className="font-mono text-sm text-foreground">{localVisionResult.not_confirmed?.length || 0}</p>
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-primary/20 bg-primary/5 p-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-primary">Coverage / What Actually Ran</p>
              {(() => {
                const coverage = localVisionCoverageSummary(localVisionResult);
                return (
                  <div className="mt-2 grid gap-2 text-xs sm:grid-cols-2">
                    <div className="rounded-md border border-border bg-background/70 px-2 py-1.5">
                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Selected Range Scanned</p>
                      <p className="font-mono text-sm text-foreground">{coverage.rangeText}</p>
                    </div>
                    <div className="rounded-md border border-border bg-background/70 px-2 py-1.5">
                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Scan Method</p>
                      <p className="text-foreground">{coverage.scannedText} · {coverage.candidateText}</p>
                      <p className="mt-1 text-muted-foreground">{coverage.coverageText}</p>
                    </div>
                    <div className="rounded-md border border-border bg-background/70 px-2 py-1.5">
                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Local Qwen Review</p>
                      <p className="text-foreground">{coverage.qwenText}</p>
                    </div>
                    <div className="rounded-md border border-border bg-background/70 px-2 py-1.5">
                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Promoted Output</p>
                      <p className="text-foreground">{coverage.confirmedText}</p>
                      <p className="mt-1 text-muted-foreground">{coverage.candidateReviewText}</p>
                    </div>
                  </div>
                );
              })()}
              <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                Balanced local analysis scans the whole selected range cheaply, then sends coverage-aware candidate windows to Qwen. Frame IDs may restart inside targeted windows; timestamps are the source of truth.
              </p>
            </div>

            <div className="rounded-lg border border-emerald-500/20 bg-emerald-500/5 p-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-300">Session Story From Local Evidence</p>
              <div className="mt-2 space-y-1.5">
                {localVisionSessionStory(localVisionResult).map((line, index) => (
                  <p key={`${index}-${line.slice(0, 20)}`} className="rounded-md border border-border bg-background/70 px-2 py-1.5 text-xs leading-relaxed text-foreground/90">
                    {line}
                  </p>
                ))}
              </div>
              {!localVisionResult.timeline_events?.length && (
                <p className="mt-2 text-[11px] text-muted-foreground">
                  No confirmed timeline event was promoted. Candidate windows may still be useful for manual review, but they are not treated as session facts.
                </p>
              )}
            </div>

            <div className="rounded-lg border border-primary/25 bg-primary/5 p-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-primary">Sarah-Style Chronological Cards</p>
              <p className="mt-1 text-xs text-muted-foreground">
                Readable local annotation cards for Session Analysis. Confirmed findings, candidates, and limitations stay explicitly separated.
              </p>
              {(() => {
                const cards = arrayFromMaybe(localVisionResult.session_analysis_export?.local_annotation_cards)
                  .concat(localVisionResult.session_analysis_export?.local_annotation_cards?.length ? [] : buildSarahLocalAnnotationCards(localVisionResult))
                  .slice(0, 12);
                if (!cards.length) {
                  return (
                    <p className="mt-2 rounded-md border border-border bg-background/70 px-2 py-1.5 text-sm text-foreground/90">
                      Local annotation did not produce useful session events from this run.
                    </p>
                  );
                }
                return (
                  <div className="mt-2 space-y-2">
                    {cards.map((card, index) => (
                      <button
                        type="button"
                        key={card.id || `${card.timestamp_range}-${index}`}
                        onClick={() => seekPreviewVideo(sessionTimeForSource((card.start_ms || 0) / 1000, selectedVideo))}
                        className="w-full rounded-md border border-border bg-background/70 px-2 py-2 text-left text-xs hover:border-primary/50"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-semibold text-foreground">{card.timestamp_range} · {card.title}</span>
                          <span className="rounded-full border border-border bg-muted/20 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                            {String(card.status || "").replace(/_/g, " ")}
                          </span>
                        </div>
                        <p className="mt-1 text-foreground/90">{card.summary}</p>
                        {card.window_summary && <p className="mt-1 text-muted-foreground">{card.window_summary}</p>}
                        {!card.finding_rows?.length && <p className="mt-1 text-muted-foreground">{card.visible_evidence}</p>}
                        <p className="mt-1 text-muted-foreground">{card.change_from_prior}</p>
                        {card.finding_rows?.length > 0 && (
                          <div className="mt-2 space-y-1">
                            {card.finding_rows.map((row, rowIndex) => (
                              <div key={`${row.label}-${rowIndex}`} className="rounded border border-border bg-muted/15 px-2 py-1">
                                <div className="flex flex-wrap items-center gap-2">
                                  <span className="font-semibold text-primary">{row.label}</span>
                                  <span className="text-[10px] uppercase tracking-wider text-muted-foreground">{row.confidence_label}</span>
                                </div>
                                <p className="mt-0.5 text-muted-foreground">{row.detail}</p>
                              </div>
                            ))}
                          </div>
                        )}
                        {card.draft_video_sync_events?.length > 0 && (
                          <div className="mt-2 rounded border border-emerald-500/20 bg-emerald-500/5 px-2 py-1">
                            <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-300">Draft Video Sync Events</p>
                            {card.draft_video_sync_events.map((event, eventIndex) => (
                              <p key={`${event.timestamp}-${eventIndex}`} className="mt-1 text-muted-foreground">
                                <span className="font-mono text-primary">{event.timestamp}</span> {event.note}
                              </p>
                            ))}
                          </div>
                        )}
                        <p className="mt-1 text-[11px] text-muted-foreground">
                          Confidence: {card.confidence_label || "uncertain"} · Source: {String(card.evidence_type || "local_vision").replace(/_/g, " ")}
                        </p>
                        {card.limitation && <p className="mt-1 text-[11px] text-amber-100">{card.limitation}</p>}
                        {card.frame_refs_text && <p className="mt-1 text-[11px] text-primary">Evidence frames: {card.frame_refs_text}</p>}
                      </button>
                    ))}
                  </div>
                );
              })()}
            </div>

            <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-3">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-300">Confirmed by Local Visual Evidence</p>
              <p className="mt-1 text-xs text-muted-foreground">Confirmed visual events only. These are the only local video items treated as facts for AI Session Analysis.</p>
              {localVisionResult.actionable_findings?.length > 0 ? (
                <div className="mt-2 space-y-2">
                  {localVisionTierRows(localVisionResult.actionable_findings).map((finding, index) => (
                    <button
                      type="button"
                      key={finding.event_id || finding.finding_id || `${finding.label}-${index}`}
                      onClick={() => seekPreviewVideo(sessionTimeForSource((finding.start_ms || 0) / 1000, selectedVideo))}
                      className="w-full rounded-md border border-emerald-500/20 bg-background/70 px-2 py-1.5 text-left text-xs hover:border-emerald-400/50"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-semibold text-foreground">{fmtMmSs((finding.start_ms || 0) / 1000)} · {finding.label || finding.event_type || "confirmed finding"}</span>
                        <span className="font-mono text-muted-foreground">{Math.round((finding.confidence || 0) * 100)}%</span>
                      </div>
                      <p className="mt-1 text-muted-foreground">{finding.basis || finding.summary || "Confirmed by local visual evidence."}</p>
                      {finding.frame_refs?.length > 0 && <p className="mt-1 text-[11px] text-emerald-200">Evidence frames: {compactFrameRefs(finding.frame_refs, 6)}</p>}
                    </button>
                  ))}
                </div>
              ) : (
                <p className="mt-2 rounded-md border border-border bg-background/70 px-2 py-1.5 text-sm text-foreground/90">
                  No confirmed local visual events were promoted.
                </p>
              )}
            </div>

            {localVisionResult.coverage_segments?.length > 0 && (
              <details open className="rounded-lg border border-border bg-background/70">
                <summary className="cursor-pointer px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Whole-Range Coverage ({localVisionResult.coverage_segments.length})
                </summary>
                <div className="space-y-2 border-t border-border p-3">
                  {localVisionTierRows(localVisionResult.coverage_segments, 20).map((segment, index) => {
                    const range = localVisionMsRange(segment);
                    return (
                      <button
                        type="button"
                        key={segment.candidate_id || `${segment.type}-${segment.start_ms}-${index}`}
                        onClick={() => seekPreviewVideo(sessionTimeForSource((segment.start_ms || 0) / 1000, selectedVideo))}
                        className="w-full rounded-md border border-border bg-muted/15 px-2 py-1.5 text-left text-xs hover:border-primary/50"
                      >
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <span className="font-semibold text-foreground">
                            {formatLocalVisionMs(range.start)}-{formatLocalVisionMs(range.end)} · {String(segment.label || segment.type || "coverage").replace(/_/g, " ")}
                          </span>
                          <span className="rounded-full border border-border bg-background/70 px-2 py-0.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                            {segment.status || "unknown"} · {segment.reviewed_by_qwen ? "Qwen" : "CV"}
                          </span>
                        </div>
                        <p className="mt-1 text-muted-foreground">{segment.basis || "Chronological local coverage segment."}</p>
                        {segment.frame_refs?.length > 0 && <p className="mt-1 font-mono text-[10px] text-primary">{segment.frame_refs.slice(0, 12).join(", ")}</p>}
                      </button>
                    );
                  })}
                </div>
              </details>
            )}

            {localVisionResult.strong_candidates?.length > 0 && (
              <div className="rounded-lg border border-primary/25 bg-primary/5 p-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-primary">Strong Candidates</p>
                <p className="mt-1 text-xs text-muted-foreground">Likely windows worth review. These stay labeled as unconfirmed unless visual gates are met.</p>
                <div className="mt-2 space-y-2">
                  {localVisionTierRows(localVisionResult.strong_candidates).map((candidate, index) => (
                    (() => {
                      const display = displayCandidate(candidate);
                      return (
                        <button
                          type="button"
                          key={candidate.candidate_id || `${candidate.type}-${candidate.start_ms}-${index}`}
                          onClick={() => seekPreviewVideo(sessionTimeForSource((candidate.start_ms || 0) / 1000, selectedVideo))}
                          className="w-full rounded-md border border-border bg-muted/15 px-2 py-2 text-left text-xs hover:border-primary/50"
                        >
                          <div className="flex flex-wrap items-center justify-between gap-2">
                            <span className="font-semibold text-foreground">{fmtMmSs((candidate.start_ms || 0) / 1000)}-{fmtMmSs((candidate.end_ms || candidate.start_ms || 0) / 1000)} · {display.label}</span>
                            <span className="rounded-full border border-border bg-background/70 px-2 py-0.5 font-mono text-[10px] text-muted-foreground">{Math.round((display.confidence || 0) * 100)}%</span>
                          </div>
                          <p className="mt-1 font-semibold text-primary">{display.status}</p>
                          <p className="mt-1 text-muted-foreground">{display.reason}</p>
                          {display.roiText && <p className="mt-1 text-[11px] text-muted-foreground">{display.roiText}</p>}
                          {display.frameRefs && <p className="mt-1 text-[11px] text-primary">Evidence frames: {display.frameRefs}</p>}
                        </button>
                      );
                    })()
                  ))}
                </div>
              </div>
            )}

            {localVisionResult.not_confirmed?.length > 0 && (
              <div className="rounded-lg border border-destructive/20 bg-destructive/5 p-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-destructive">Not Visually Confirmed</p>
                <p className="mt-1 text-xs text-muted-foreground">Important checks that did not have enough visible evidence. This does not mean the event did not happen; it only means local vision cannot support it as a visual fact.</p>
                <div className="mt-2 space-y-1.5">
                  {arrayFromMaybe(localVisionResult.not_confirmed).slice(0, 12).map((item, index) => {
                    const display = displayNotConfirmed(item);
                    return (
                      <div key={`${display.label}-${index}`} className="rounded-md border border-destructive/15 bg-background/70 px-2 py-1.5 text-xs">
                        <div className="flex flex-wrap items-center justify-between gap-2">
                          <p className="font-semibold text-foreground">{display.label}</p>
                          <span className="rounded-full border border-destructive/20 bg-destructive/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-destructive">
                            {display.status}
                          </span>
                        </div>
                        <p className="mt-1 text-muted-foreground">{display.reason}</p>
                        {display.frameRefs && <p className="mt-1 text-[11px] text-muted-foreground">Checked frames: {display.frameRefs}</p>}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {localVisionResult.not_confirmed?.length > 0 && (
              <details className="rounded-lg border border-amber-400/25 bg-amber-400/5">
                <summary className="cursor-pointer px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-amber-200">
                  Why Confirmation Failed
                </summary>
                <div className="space-y-1.5 border-t border-border p-3">
                  {arrayFromMaybe(localVisionResult.not_confirmed).slice(0, 8).map((item, index) => {
                    const display = displayNotConfirmed(item);
                    return (
                      <p key={`${display.label}-why-${index}`} className="rounded-md border border-border bg-background/70 px-2 py-1.5 text-xs leading-relaxed text-foreground/90">
                        <span className="font-semibold">{display.label}: </span>{display.reason}
                      </p>
                    );
                  })}
                </div>
              </details>
            )}

            {localVisionResult.session_analysis_export && (
              <details open className="rounded-lg border border-emerald-500/25 bg-background/70">
                <summary className="cursor-pointer px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-emerald-300">
                  Session Analysis Export Preview
                </summary>
                <div className="space-y-2 border-t border-border p-3 text-xs">
                  <p className="text-muted-foreground">
                    This is the compact local-vision package for AI Session Analysis: confirmed findings first, labeled candidates second, and unsupported checks as not-confirmed.
                  </p>
                  <div className="grid gap-2 sm:grid-cols-3">
                    <div className="rounded-md border border-border bg-muted/15 px-2 py-1.5">
                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Confirmed</p>
                      <p className="font-mono text-sm text-foreground">{localVisionResult.session_analysis_export?.confirmed_findings?.length || 0}</p>
                    </div>
                    <div className="rounded-md border border-border bg-muted/15 px-2 py-1.5">
                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Candidates</p>
                      <p className="font-mono text-sm text-foreground">{localVisionResult.session_analysis_export?.strong_candidates?.length || 0}</p>
                    </div>
                    <div className="rounded-md border border-border bg-muted/15 px-2 py-1.5">
                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Not Confirmed</p>
                      <p className="font-mono text-sm text-foreground">{localVisionResult.session_analysis_export?.not_confirmed?.length || 0}</p>
                    </div>
                  </div>
                  {localVisionResult.session_analysis_export?.summary && (
                    <p className="rounded-md border border-border bg-muted/10 px-2 py-1.5 text-muted-foreground">
                      {localVisionResult.session_analysis_export.summary}
                    </p>
                  )}
                  <div className="rounded-md border border-primary/20 bg-primary/5 p-2">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-primary">Readable Annotation Cards</p>
                    <div className="mt-1 space-y-1">
                      {arrayFromMaybe(localVisionResult.session_analysis_export?.local_annotation_cards).slice(0, 4).length ? (
                        arrayFromMaybe(localVisionResult.session_analysis_export?.local_annotation_cards).slice(0, 4).map((card, index) => (
                          <p key={`${card.timestamp_range}-${index}`} className="text-muted-foreground">
                            {card.timestamp_range} · {card.title} · {String(card.status || "").replace(/_/g, " ")}
                          </p>
                        ))
                      ) : (
                        <p className="text-muted-foreground">Local annotation did not produce useful session events from this run.</p>
                      )}
                    </div>
                  </div>
                  <div className="grid gap-2 lg:grid-cols-3">
                    <div className="rounded-md border border-border bg-muted/10 p-2">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-300">Confirmed Facts</p>
                      <div className="mt-1 space-y-1">
                        {arrayFromMaybe(localVisionResult.session_analysis_export?.confirmed_findings).slice(0, 4).length ? (
                          arrayFromMaybe(localVisionResult.session_analysis_export?.confirmed_findings).slice(0, 4).map((item, index) => (
                            <p key={`${item.label}-${index}`} className="text-muted-foreground">{formatLocalVisionMs(item.start_ms)} · {humanizeLocalVisionLabel(item.label)}</p>
                          ))
                        ) : (
                          <p className="text-muted-foreground">No confirmed local visual facts.</p>
                        )}
                      </div>
                    </div>
                    <div className="rounded-md border border-border bg-muted/10 p-2">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-primary">Candidate Evidence</p>
                      <div className="mt-1 space-y-1">
                        {arrayFromMaybe(localVisionResult.session_analysis_export?.strong_candidates).slice(0, 4).length ? (
                          arrayFromMaybe(localVisionResult.session_analysis_export?.strong_candidates).slice(0, 4).map((item, index) => (
                            <p key={`${item.label}-${index}`} className="text-muted-foreground">{formatLocalVisionMs(item.start_ms)} · {humanizeLocalVisionLabel(item.label)} (not confirmed)</p>
                          ))
                        ) : (
                          <p className="text-muted-foreground">No strong candidates included.</p>
                        )}
                      </div>
                    </div>
                    <div className="rounded-md border border-border bg-muted/10 p-2">
                      <p className="text-[10px] font-semibold uppercase tracking-wider text-destructive">Limitations</p>
                      <div className="mt-1 space-y-1">
                        {arrayFromMaybe(localVisionResult.session_analysis_export?.not_confirmed).slice(0, 4).length ? (
                          arrayFromMaybe(localVisionResult.session_analysis_export?.not_confirmed).slice(0, 4).map((item, index) => {
                            const display = displayNotConfirmed(item);
                            return <p key={`${display.label}-${index}`} className="text-muted-foreground">{display.label}: not visually confirmed</p>;
                          })
                        ) : (
                          <p className="text-muted-foreground">No not-confirmed checks listed.</p>
                        )}
                      </div>
                    </div>
                  </div>
                </div>
              </details>
            )}

            {localVisionResult.frame_evidence?.length > 0 && (
              <details className="rounded-lg border border-border bg-background/70">
                <summary className="cursor-pointer px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Evidence Frames ({localVisionResult.frame_evidence.length}, preview first {Math.min(localVisionResult.frame_evidence.length, 24)})
                </summary>
                <div className="grid grid-cols-2 gap-2 p-2 sm:grid-cols-4 lg:grid-cols-6">
                  {localVisionResult.frame_evidence.slice(0, 24).map((frame) => (
                    <a key={frame.frame_id} href={base44.integrations.Core.localVisionAssetUrl(frame.image_path)} target="_blank" rel="noreferrer" className="overflow-hidden rounded-md border border-border bg-card">
                      <img src={base44.integrations.Core.localVisionAssetUrl(frame.image_path)} alt={`Local vision frame ${frame.frame_id}`} loading="lazy" className="aspect-video w-full object-cover" />
                      <span className="block px-1.5 py-1 text-[10px] text-muted-foreground">
                        Evidence frame at {fmtMmSs((frame.time_ms || 0) / 1000)}
                        {frame.frame_id ? <span className="block font-mono opacity-70">{frame.frame_id}</span> : null}
                      </span>
                    </a>
                  ))}
                </div>
                {localVisionResult.frame_evidence.length > 24 && (
                  <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
                    Showing twenty-four thumbnails here to keep the page usable. Full frame paths remain in Copy JSON / debug output.
                  </p>
                )}
              </details>
            )}

            {localVisionResult.timeline_events?.length > 0 && (
              <div className="rounded-lg border border-border bg-background/70 p-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-primary">Unified Timeline</p>
                <div className="mt-2 space-y-2">
                  {localVisionResult.timeline_events.slice(0, 12).map((event) => (
                    <button
                      type="button"
                      key={event.event_id || `${event.label}-${event.start_ms}`}
                      onClick={() => seekPreviewVideo(sessionTimeForSource((event.start_ms || 0) / 1000, selectedVideo))}
                      className="w-full rounded-md border border-border bg-muted/15 px-2 py-1.5 text-left text-xs hover:border-emerald-400/50"
                    >
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-foreground">{fmtMmSs((event.start_ms || 0) / 1000)} · {event.label}</span>
                        <span className="font-mono text-muted-foreground">{Math.round((event.confidence || 0) * 100)}%</span>
                      </div>
                      <p className="mt-1 text-muted-foreground">{event.basis}</p>
                      {event.frame_refs?.length > 0 && <p className="mt-1 font-mono text-[10px] text-emerald-200">{event.frame_refs.join(", ")}</p>}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {!localVisionResult.timeline_events?.length && (
              <div className="rounded-lg border border-amber-400/25 bg-amber-400/5 p-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-amber-200">Unified Timeline</p>
                <p className="mt-1 text-sm leading-relaxed text-foreground/90">
                  No confirmed timeline event was promoted. Candidate windows may still be useful for manual review, but Sarah is leaving the event timeline empty rather than converting uncertain evidence into a false event.
                </p>
              </div>
            )}

            {localVisionResult.state_segments?.length > 0 && (
              <div className="rounded-lg border border-border bg-background/70 p-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-primary">State Segments</p>
                <div className="mt-2 space-y-2">
                  {localVisionResult.state_segments.slice(0, 12).map((segment) => (
                    <button
                      type="button"
                      key={`${segment.state}-${segment.start_ms}-${segment.end_ms}`}
                      onClick={() => seekPreviewVideo(sessionTimeForSource((segment.start_ms || 0) / 1000, selectedVideo))}
                      className="w-full rounded-md border border-border bg-muted/15 px-2 py-1.5 text-left text-xs hover:border-emerald-400/50"
                    >
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="font-semibold text-foreground">
                          {fmtMmSs((segment.start_ms || 0) / 1000)}-{fmtMmSs((segment.end_ms || 0) / 1000)} · {String(segment.state || "state").replace(/_/g, " ")}
                        </span>
                        <span className="font-mono text-muted-foreground">{Math.round((segment.confidence || 0) * 100)}%</span>
                      </div>
                      {segment.frame_refs?.length > 0 && <p className="mt-1 font-mono text-[10px] text-emerald-200">{segment.frame_refs.join(", ")}</p>}
                    </button>
                  ))}
                </div>
              </div>
            )}

            <div className="grid gap-3 lg:grid-cols-2">
              <div className="rounded-lg border border-border bg-background/70 p-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-primary">Stage Candidates</p>
                <div className="mt-2 space-y-2">
                  {(localVisionResult.stage_candidates || []).filter((stage) => stage.stage && stage.stage !== "unknown").slice(0, 6).map((stage) => (
                    <div key={`${stage.stage}-${stage.basis}`} className="rounded-md border border-border bg-muted/15 px-2 py-1.5 text-xs">
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold text-foreground">{stage.stage.replace(/_/g, " ")}</span>
                        <span className="font-mono text-muted-foreground">{Math.round((stage.confidence || 0) * 100)}%</span>
                      </div>
                      <p className="mt-1 text-muted-foreground">{stage.basis}</p>
                      {stage.frame_refs?.length > 0 && <p className="mt-1 font-mono text-[10px] text-primary">{stage.frame_refs.join(", ")}</p>}
                    </div>
                  ))}
                  {!(localVisionResult.stage_candidates || []).some((stage) => stage.stage && stage.stage !== "unknown") && (
                    <div className="rounded-md border border-border bg-muted/15 px-2 py-1.5 text-xs text-muted-foreground">
                      No specific stage passed the local visibility gates.
                    </div>
                  )}
                </div>
              </div>
              <div className="rounded-lg border border-border bg-background/70 p-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-destructive">Forbidden / Not Visible</p>
                <div className="mt-2 space-y-2">
                  {(localVisionResult.forbidden_or_not_visible || []).slice(0, 8).map((item) => (
                    <div key={`${item.claim}-${item.reason}`} className="rounded-md border border-destructive/20 bg-destructive/5 px-2 py-1.5 text-xs">
                      <div className="font-semibold text-foreground">{item.claim}</div>
                      <p className="mt-1 text-muted-foreground">{item.reason}</p>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {localVisionFluidDynamics && (
              <div className="rounded-lg border border-cyan-400/25 bg-cyan-400/5 p-3">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-cyan-200">Visible Fluid Dynamics Proxy</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Clinical visual proxy only. This does not estimate true physical force.
                </p>
                <div className="mt-3 grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
                  {[
                    ["Release", localVisionFluidDynamics.release_detected],
                    ["Onset", localVisionFluidDynamics.onset_ms != null ? fmtMmSs(localVisionFluidDynamics.onset_ms / 1000) : "unavailable"],
                    ["Duration", localVisionFluidDynamics.duration_ms != null ? `${Math.round(localVisionFluidDynamics.duration_ms)} ms` : "unavailable"],
                    ["Pulses", localVisionFluidDynamics.pulse_count ?? "unavailable"],
                    ["Distance px", localVisionFluidDynamics.max_projected_distance_px ?? "unavailable"],
                    ["Distance cm", localVisionFluidDynamics.max_projected_distance_cm ?? "unavailable"],
                    ["Angle", localVisionFluidDynamics.trajectory_angle_degrees != null ? `${localVisionFluidDynamics.trajectory_angle_degrees}°` : "unavailable"],
                    ["Velocity px/s", localVisionFluidDynamics.velocity_proxy_px_per_sec ?? "unavailable"],
                    ["Velocity cm/s", localVisionFluidDynamics.velocity_proxy_cm_per_sec ?? "unavailable"],
                    ["Volume proxy", localVisionFluidDynamics.volume_proxy],
                    ["Confidence", `${Math.round((localVisionFluidDynamics.confidence || 0) * 100)}%`],
                    ["Frames", localVisionFluidDynamics.frame_refs?.join(", ") || "none"],
                  ].map(([label, value]) => (
                    <div key={label} className="rounded-md border border-border bg-background/70 px-2 py-1.5">
                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
                      <p className="truncate text-sm text-foreground">{value}</p>
                    </div>
                  ))}
                </div>
                {localVisionFluidDynamics.limitations?.length > 0 && (
                  <div className="mt-3 space-y-1">
                    {localVisionFluidDynamics.limitations.map((limitation) => (
                      <p key={limitation} className="rounded-md border border-cyan-400/20 bg-background/60 px-2 py-1 text-xs text-muted-foreground">
                        {limitation}
                      </p>
                    ))}
                  </div>
                )}
              </div>
            )}

            <details className="rounded-lg border border-border bg-background/70">
              <summary className="cursor-pointer px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                Debug / Raw Evidence Buckets
              </summary>
              <div className="grid gap-3 border-t border-border p-3 lg:grid-cols-2">
              <details className="rounded-lg border border-border bg-background/70">
                <summary className="cursor-pointer px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Object Evidence ({localVisionStatusSummary(localVisionResult.visible_objects)})
                </summary>
                <div className="space-y-1.5 p-3">
                  {localVisionEvidenceRows(localVisionResult.visible_objects).map((item, index) => (
                    <div key={`${item.label}-${item.status}-${index}`} className="flex items-start justify-between gap-2 rounded-md bg-muted/15 px-2 py-1.5 text-xs">
                      <span className="min-w-0">
                        <span className="font-semibold text-foreground">{item.label.replace(/_/g, " ")}</span>
                        <span className="ml-2 text-muted-foreground">{item.status}</span>
                      </span>
                      <span className="font-mono text-muted-foreground">{Math.round((item.confidence || 0) * 100)}%</span>
                    </div>
                  ))}
                </div>
              </details>
              <details className="rounded-lg border border-border bg-background/70">
                <summary className="cursor-pointer px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                  Action Evidence ({localVisionStatusSummary(localVisionResult.visible_actions)})
                </summary>
                <div className="space-y-1.5 p-3">
                  {localVisionEvidenceRows(localVisionResult.visible_actions).map((item, index) => (
                    <div key={`${item.label}-${item.status}-${index}`} className="flex items-start justify-between gap-2 rounded-md bg-muted/15 px-2 py-1.5 text-xs">
                      <span className="min-w-0">
                        <span className="font-semibold text-foreground">{item.label.replace(/_/g, " ")}</span>
                        <span className="ml-2 text-muted-foreground">{item.status}</span>
                      </span>
                      <span className="font-mono text-muted-foreground">{Math.round((item.confidence || 0) * 100)}%</span>
                    </div>
                  ))}
                </div>
              </details>
              </div>
            </details>

            {((localVisionResult.warnings || []).length > 0 || (localVisionResult.limitations || []).length > 0) && (
              <div className="grid gap-3 lg:grid-cols-2">
                {(localVisionResult.warnings || []).length > 0 && (
                  <div className="rounded-lg border border-amber-400/25 bg-amber-400/5 p-3">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-amber-200">Warnings</p>
                    <div className="mt-2 space-y-1">
                      {localVisionResult.warnings.map((warning) => (
                        <p key={warning} className="rounded-md border border-border bg-background/70 px-2 py-1.5 text-xs text-muted-foreground">{warning}</p>
                      ))}
                    </div>
                  </div>
                )}
                {(localVisionResult.limitations || []).length > 0 && (
                  <div className="rounded-lg border border-border bg-background/70 p-3">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Limitations</p>
                    <div className="mt-2 space-y-1">
                      {localVisionResult.limitations.map((limitation) => (
                        <p key={limitation} className="rounded-md border border-border bg-muted/15 px-2 py-1.5 text-xs text-muted-foreground">{limitation}</p>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        )}
      </div>
      </details>
      )}

      <details className="mt-3 rounded-xl border border-border bg-card/60">
        <summary className="cursor-pointer px-3 py-3 text-xs font-semibold uppercase tracking-wider text-muted-foreground">
          Advanced Local / Audio Tools
        </summary>
        <div className="grid gap-3 border-t border-border p-3">
          <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-3">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div className="min-w-0">
                <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-300">Diagnostic Current Window</p>
                <p className="mt-1 text-xs text-muted-foreground">
                  Manual single-window check around the preview cursor. This is for troubleshooting evidence, not the main full-range pass.
                </p>
              </div>
              <div className="flex w-full flex-wrap items-center gap-2 sm:w-auto">
                <label className="flex h-8 w-full items-center gap-2 rounded-lg border border-border bg-background px-3 text-xs text-muted-foreground sm:w-auto">
                  Focus
                  <select
                    value={localVisionFocus}
                    onChange={(event) => setLocalVisionFocus(event.target.value)}
                    className="bg-transparent text-foreground outline-none"
                  >
                    <option value="foley">Foley/procedure</option>
                    <option value="body">Body exploration/masturbation</option>
                    <option value="combined">Combined</option>
                  </select>
                </label>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={analyzeWindowLocally}
                  disabled={localVisionRunning || !selectedVideo || !plannedWindows.length}
                  className="h-8 w-full justify-center border-emerald-500/35 text-emerald-200 hover:bg-emerald-500/10 sm:w-auto"
                >
                  Analyze Diagnostic Window
                </Button>
              </div>
            </div>
          </div>

          <details className="rounded-lg border border-amber-400/25 bg-amber-400/5">
            <summary className="cursor-pointer px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-amber-200">
              Legacy Full-Session Qwen Scan
            </summary>
            <div className="border-t border-amber-400/15 p-3">
              <p className="text-xs text-muted-foreground">
                Old continuous scan path. It can be very slow because it sends the full sampled range through Qwen. Use the adaptive modes above for normal work.
              </p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={analyzeContinuousLocally}
                disabled={localVisionRunning || !selectedVideo}
                className="mt-3 h-8 w-full justify-center border-amber-400/35 text-amber-100 hover:bg-amber-400/10 sm:w-auto"
              >
                Run Legacy Full Qwen Scan
              </Button>
            </div>
          </details>

          <div className="rounded-lg border border-emerald-500/25 bg-emerald-500/5 p-3">
            <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-300">Ask a Targeted Question About Local Analysis</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Uses local evidence, timeline events, and frame refs when available. Best for specific follow-ups like "Was fluid release visible?" or "Was this catheter advancement or tubing handling?"
            </p>
            <div className="mt-3 grid min-w-0 gap-2 md:grid-cols-[minmax(0,1fr)_auto]">
              <input
                value={localVisionQuestion}
                onChange={(event) => setLocalVisionQuestion(event.target.value)}
                className="h-9 min-w-0 rounded-md border border-border bg-background px-3 text-sm outline-none focus:border-emerald-400"
                placeholder="Ask from visible local evidence only..."
              />
              <Button
                type="button"
                size="sm"
                variant="outline"
                onClick={askVideoLocally}
                disabled={localVisionRunning || !localVisionQuestion.trim()}
                className="h-9 justify-center border-emerald-500/35 text-emerald-200 hover:bg-emerald-500/10 max-[420px]:w-full"
              >
                Ask Targeted Question
              </Button>
            </div>
            {localVisionQaResult && (
              <div className="mt-3 rounded-lg border border-border bg-background/70 p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-emerald-300">Local Evidence Answer</p>
                    <p className="mt-1 text-sm text-foreground/90">{localVisionQaResult.answer?.short_answer}</p>
                  </div>
                  <span className="rounded-full border border-border bg-muted/15 px-2 py-1 font-mono text-[10px] text-muted-foreground">
                    {Math.round((localVisionQaResult.answer?.confidence || 0) * 100)}%
                  </span>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">{localVisionQaResult.answer?.basis}</p>
                {localVisionQaResult.answer?.frame_refs?.length > 0 && (
                  <p className="mt-2 font-mono text-[10px] text-emerald-200">
                    Frames: {localVisionQaResult.answer.frame_refs.join(", ")}
                  </p>
                )}
                {localVisionQaResult.answer?.limitations?.length > 0 && (
                  <div className="mt-2 space-y-1">
                    {localVisionQaResult.answer.limitations.map((limitation) => (
                      <p key={limitation} className="rounded-md border border-border bg-muted/10 px-2 py-1 text-xs text-muted-foreground">{limitation}</p>
                    ))}
                  </div>
                )}
              </div>
            )}
          </div>

          <details className="rounded-lg border border-border bg-background/70">
            <summary className="cursor-pointer px-3 py-2 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
              Raw JSON / Debug Output
            </summary>
            <div className="border-t border-border p-3">
              <Button type="button" size="sm" variant="outline" onClick={copyLocalVisionJson} disabled={!localVisionResult && !localVisionQaResult} className="h-8">
                <Copy className="mr-1 h-3.5 w-3.5" /> Copy Latest Local JSON
              </Button>
              {(localVisionResult || localVisionQaResult) ? (
                <pre className="mt-3 max-h-80 overflow-auto rounded-md border border-border bg-black/30 p-3 text-[10px] leading-relaxed text-muted-foreground">
                  {JSON.stringify(localVisionQaResult || localVisionResult, null, 2)}
                </pre>
              ) : (
                <p className="mt-3 text-xs text-muted-foreground">No local JSON result loaded yet.</p>
              )}
            </div>
          </details>

          <div className="rounded-xl border border-border bg-card/60 p-3">
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
        </div>
      </details>

      {cards.length > 0 && (
        <div className="mt-3 grid gap-3">
          {cards.map((card) => {
            const isExpanded = expanded[card.id];
            const accepted = isCardAccepted(card, session, acceptedIds, isExploration);
            const compactAccepted = accepted && !isExpanded;
            const showCardVideoPreview = Boolean(card.clipUrl) && !card.localVision;
            const cardFramePreview = card.thumbnailUrl || card.sampledFrames?.[0]?.url || "";
            const deviceStatus = cardDeviceEvidenceStatus(card);
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
                          {deviceStatus && (
                            <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${deviceStatus.blocked ? "border-amber-400/40 bg-amber-400/10 text-amber-300" : "border-border bg-background/70 text-muted-foreground"}`}>
                              {deviceStatus.stage}
                            </span>
                          )}
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
                    {showCardVideoPreview ? (
                      <video
                        src={card.clipUrl}
                        muted
                        playsInline
                        preload="metadata"
                        className={`w-full bg-black object-contain ${isExpanded ? "max-h-[28rem]" : "aspect-video"}`}
                        controls={isExpanded}
                      />
                    ) : cardFramePreview ? (
                      <img
                        src={cardFramePreview}
                        alt={`${card.localVision ? "Local evidence" : "Sampled"} frame preview`}
                        loading="lazy"
                        className={`w-full bg-black object-contain ${isExpanded ? "max-h-[28rem]" : "aspect-video"}`}
                      />
                    ) : (
                      <div className="flex aspect-video w-full items-center justify-center bg-black px-3 text-center text-xs text-muted-foreground">
                        Preview unavailable. Open frame evidence below.
                      </div>
                    )}
                    {!isExpanded && (
                      <div className="absolute inset-0 flex items-center justify-center bg-black/10 opacity-90 transition-opacity group-hover:opacity-100">
                        <span className="rounded-full bg-background/80 p-2 text-foreground shadow">
                          {showCardVideoPreview ? <Play className="h-5 w-5" /> : <Eye className="h-5 w-5" />}
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
                          {deviceStatus && (
                            <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${deviceStatus.blocked ? "border-amber-400/40 bg-amber-400/10 text-amber-300" : "border-border bg-background/70 text-muted-foreground"}`}>
                              {deviceStatus.stage}
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
                          {card.localVision ? "Local Frame Evidence" : "Sampled Frames Sarah Saw"} ({card.sampledFrames.length}, preview first {Math.min(card.sampledFrames.length, 18)})
                        </summary>
                        <div className="grid grid-cols-3 gap-2 p-2 sm:grid-cols-4 lg:grid-cols-6">
                          {card.sampledFrames.slice(0, 18).map((frame, index) => (
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
                        {card.sampledFrames.length > 18 && (
                          <p className="border-t border-border px-3 py-2 text-xs text-muted-foreground">
                            Showing the first eighteen frames only. Full evidence refs are saved with the card and available in JSON/debug output.
                          </p>
                        )}
                      </details>
                    )}
                    <p className="text-sm leading-relaxed text-foreground/90">{card.summary}</p>
                    <p className="rounded-md border border-primary/15 bg-primary/5 px-2 py-1 text-[10px] text-muted-foreground">
                      Accepting this card saves the summary, finding cards, clip range, and draft events into the {recordLabel} AI details.
                    </p>
                    {card.events.length === 0 && (
                      <div className="flex justify-end">
                        <Button type="button" size="sm" variant="outline" className="h-7" onClick={() => acceptEvents(card)} disabled={accepted}>
                          <Check className="mr-1 h-3.5 w-3.5" /> {accepted ? "Accepted" : "Save Findings"}
                        </Button>
                      </div>
                    )}
                    <div className="space-y-1.5">
                      {card.findings.map((finding, index) => (
                        <div key={`${finding.title}-${index}`} className="rounded-lg border border-border bg-muted/20 px-3 py-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <span className="text-xs font-semibold text-primary">{finding.title}</span>
                            <span className="rounded-full border border-border px-1.5 py-0.5 text-[10px] text-muted-foreground">{finding.confidence}</span>
                          </div>
                          <p className="mt-1 text-sm leading-relaxed text-foreground/85">{finding.text}</p>
                          {finding.evidenceRefs?.length > 0 && (
                            <div className="mt-2 flex flex-wrap gap-1">
                              {finding.evidenceRefs.slice(0, 8).map((ref) => (
                                <span key={ref} className="rounded-full border border-border bg-background/70 px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground">
                                  {ref}
                                </span>
                              ))}
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                    {card.events.length > 0 && (
                      <div className="min-w-0 rounded-lg border border-primary/20 bg-primary/5 p-2 sm:p-3">
                        <div className="mb-2 flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                          <span className="text-[10px] font-semibold uppercase tracking-wider text-primary">Draft Video Sync Events</span>
                          <Button type="button" size="sm" variant="outline" className="h-8 w-full justify-center sm:h-7 sm:w-auto" onClick={() => acceptEvents(card)} disabled={accepted}>
                            <Check className="mr-1 h-3.5 w-3.5" /> {accepted ? "Accepted" : "Save Findings + Events"}
                          </Button>
                        </div>
                        <div className="space-y-2">
                          {card.events.map((event, index) => (
                            <div key={`${event.time_s}-${index}`} className="min-w-0 rounded-md bg-background/60 px-2.5 py-2 text-xs sm:flex sm:items-start sm:gap-2">
                              <span className="mb-1.5 block shrink-0 font-mono font-bold text-primary sm:mb-0 sm:mt-2">{fmtMmSs(event.time_s)}</span>
                              <textarea
                                value={event.note || ""}
                                onChange={(changeEvent) => updateCardEventNote(card.id, index, changeEvent.target.value)}
                                disabled={accepted}
                                rows={3}
                                className="min-h-24 w-full min-w-0 resize-y rounded-md border border-border bg-background/80 px-3 py-2 leading-relaxed text-foreground/85 outline-none focus:border-primary/50 disabled:cursor-not-allowed disabled:opacity-70 sm:min-h-16 sm:flex-1"
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
            <div className="flex flex-col gap-3 rounded-xl border border-primary/25 bg-primary/5 px-3 py-2 sm:flex-row sm:items-center sm:justify-between">
              <div className="min-w-0">
                <p className="text-xs font-semibold uppercase tracking-wider text-primary">Batch Review Ready</p>
                <p className="text-xs text-muted-foreground">
                  Saves all unaccepted {cards.some((card) => card.localVision) ? "local/Qwen or Sarah" : "Sarah"} video-pass finding cards and edited timeline events in this list.
                </p>
              </div>
              <div className="flex w-full flex-col gap-2 sm:w-auto sm:flex-row sm:flex-wrap sm:items-center">
                {isExploration && (
                  <Button type="button" size="sm" variant="outline" onClick={reassessExplorationSequence} disabled={running || reassessing} className="h-9 w-full justify-center sm:h-8 sm:w-auto">
                    {reassessing ? <Loader2 className="mr-2 h-3.5 w-3.5 animate-spin" /> : <Sparkles className="mr-2 h-3.5 w-3.5" />}
                    Reassess Foley Sequence
                  </Button>
                )}
                <Button type="button" size="sm" onClick={acceptAllDraftCards} className="h-9 w-full justify-center sm:h-8 sm:w-auto">
                  <Check className="mr-2 h-3.5 w-3.5" /> Accept All Findings & Events
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
