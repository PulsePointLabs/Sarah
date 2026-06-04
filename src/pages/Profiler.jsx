import { useState, useEffect } from "react";
import { base44 } from "@/api/base44Client";
import { Brain, Activity, AlertCircle, Zap, TrendingUp, Heart, Lightbulb, User, ChevronDown, ChevronUp, RefreshCw, History, Image as ImageIcon, Upload, X } from "lucide-react";
import TTSReader from "../components/TTSReader";
import AIOutputReader from "../components/AIOutputReader";
import { normalizeJournalEntry } from "@/lib/journalEntry";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { buildAIGroundingContext, buildOptionalFirstNameToneCue, PERSONALIZED_ANATOMY_OUTPUT_RULE } from "@/lib/aiGrounding";
import { listBackgroundJobs, startBackgroundJob, waitForBackgroundJob } from "@/lib/backgroundJobs";
import { SESSION_CONTEXT_GROUNDING_RULE, sessionContextEvidenceText, sessionContextFactorLabels } from "@/lib/sessionContext";
import { getManualStimulationPauseResumeEvents, getMotionEvidenceSummary, summarizeMotionEvidenceCoverage } from "@/utils/sessionMotionEvidence";
import { buildProfileAIContentMeta, formatGeneratedAt, isProfileAIContentStale } from "@/utils/aiContentMetadata";
import { splitSentencesPreservingDecimals } from "@/utils/aiTextRepair";
import { buildLongitudinalHrvEvidence, RR_HRV_INTERPRETATION_RULES } from "@/utils/hrvEvidence";
import { buildProfileQaFindingCards, normalizeProfileQaFindings } from "@/lib/profileQa";

// ── helpers ────────────────────────────────────────────────────────────────────

function fmtSec(s) {
  if (s == null) return "—";
  const v = Math.round(Math.abs(s));
  return v >= 60 ? `${Math.floor(v / 60)}m${v % 60}s` : `${v}s`;
}

function briefText(value, max = 180) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

const PROFILE_ARCHIVE_LIMIT = 30;

function avg(values) {
  const nums = values.map(Number).filter(Number.isFinite);
  return nums.length ? nums.reduce((a, b) => a + b, 0) / nums.length : null;
}

function fmtAvg(value, digits = 1) {
  return value == null ? "—" : Number(value).toFixed(digits).replace(/\.0$/, "");
}

const SESSION_DATE_TIME_ZONE = "America/New_York";

function sessionDateKey(value) {
  if (!value) return null;
  const text = String(value).trim();
  const localCalendarMatch = text.match(/^(\d{4}-\d{2}-\d{2})(?:$|T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)$/);
  if (localCalendarMatch) return localCalendarMatch[1];

  const parsed = new Date(text);
  if (Number.isNaN(parsed.getTime())) return text.slice(0, 10) || null;
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    timeZone: SESSION_DATE_TIME_ZONE,
  }).format(parsed);
}

function fmtNarrativeDate(value) {
  const raw = sessionDateKey(value);
  if (!raw) return "unknown date";
  const [year, month, day] = raw.split("-").map(Number);
  if (!year || !month || !day) return String(value);
  return new Date(Date.UTC(year, month - 1, day)).toLocaleDateString("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  });
}

function naturalizeSpokenDates(value) {
  return String(value || "").replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (match, year, month, day) => (
    fmtNarrativeDate(`${year}-${month}-${day}`) || match
  ));
}

function calmSpokenHeading(label) {
  return `Section: ${String(label || "").replace(/&/g, "and").toLowerCase()}.`;
}

function renderSentenceHighlightedText(text, activeSentenceIdx = -1, onSentenceClick) {
  const sentences = splitSentencesPreservingDecimals(text);
  return sentences.map((sentence, index) => (
    <span
      key={`${index}-${sentence.slice(0, 24)}`}
      role="button"
      tabIndex={0}
      onClick={(event) => {
        event.stopPropagation();
        onSentenceClick?.(index);
      }}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        event.stopPropagation();
        onSentenceClick?.(index);
      }}
      className={`rounded-sm px-0.5 transition-colors ${activeSentenceIdx === index ? "bg-primary/20 text-foreground" : "hover:bg-muted/40"}`}
    >
      {sentence}{index < sentences.length - 1 ? " " : ""}
    </span>
  ));
}

const SESSION_DATE_GROUNDING_RULE = `
SESSION DATE GROUNDING RULE:
- A date attached to a session below is the recorded date that session occurred, normalized to the America/New_York local calendar date.
- When referencing a specific session, use that recorded session date only.
- Never replace a session occurrence date with the date an entry was created, updated, analyzed, regenerated, or exported.
- If a date is mentioned in prose, speak it naturally, such as "May 14, 2026", rather than reading an ISO date.
`;

const MOTION_EVIDENCE_PRECEDENCE_RULE = `
MOVEMENT EVIDENCE PRECEDENCE RULE (apply only when saved media-derived motion evidence exists):
- For visible movement interpretation, prioritize saved MediaPipe-derived motion telemetry over vague or conflicting movement-only notes.
- Media-derived evidence may support observational synthesis of lower-body movement timing, left/right activity comparison, asymmetry, forefoot or toe-region activity proxies, hand-movement cadence proxy, provisional hand-activity gap/resumption candidates, movement clustering, and confidence or reliability limitations.
- User-verified motion-derived events have been visually reviewed and may be treated as stronger observational evidence than unverified motion-derived events. They remain observational evidence only and do not establish intent, force, neurological mechanism, or physiological cause.
- For stimulation pause/resume timing and pause duration, explicit manually entered timeline events tagged stimulation_paused or stimulation_resumed take priority. Treat motion-derived hand pause/resume candidates as secondary corroboration because hand visibility and tracking may be imperfect.
- If manual stimulation pause/resume entries are absent, describe motion pause/resume evidence only as observed hand-activity gap or resumption candidates, not confirmed stimulation timing.
- Manual notes remain valuable when they contribute context that motion telemetry cannot know, including repositioning, method or grip change, breathing changes, interruption, subjective sensation, threshold behavior explicitly noted by the person, or environmental context.
- Treat older vague movement-only notes such as "feet moving," "toes twitching," "left foot active," "bilateral tremors," or "hand moving faster" as secondary when saved motion telemetry addresses the same visible behavior.
- If saved telemetry conflicts with vague manual movement notes, characterize visible movement from telemetry and preserve the manual note only as subjective or contextual history unless it adds distinct information.
- Motion evidence remains observational only. Do not infer intent, arousal phase, muscle force, neurological mechanism, autonomic cause, or physiological cause from motion alone.
- A cadence estimate is a visible hand-movement rhythm proxy, not confirmed stroke speed, technique, force, or stimulation intensity.
`;

function buildProfileEvidenceDigest(sessions) {
  const withHr = sessions.filter((s) => s.avg_hr || s.max_hr || s.hr_at_climax);
  const climaxSessions = sessions.filter((s) => !s.no_climax && s.climax_offset_s != null);
  const favorites = sessions.filter((s) => s.is_favorite).length;
  const motionCoverage = summarizeMotionEvidenceCoverage(sessions);
  const topRated = [...sessions]
    .sort((a, b) => ((b.satisfaction || 0) + (b.intensity || 0)) - ((a.satisfaction || 0) + (a.intensity || 0)))
    .slice(0, 5)
    .map((s) => `${sessionDateKey(s.date) || "unknown"} S${s.satisfaction ?? "?"}/I${s.intensity ?? "?"}, ${[...(s.methods || []), ...(s.custom_methods || [])].filter(Boolean).slice(0, 4).join("+") || "no method"}, maxHR ${s.max_hr || "?"}`)
    .join(" | ");

  const methodMap = new Map();
  for (const s of sessions) {
    const methods = [...(s.methods || []), ...(s.custom_methods || [])].filter(Boolean);
    for (const method of methods) {
      const key = String(method).toLowerCase();
      const row = methodMap.get(key) || { label: method, count: 0, satisfaction: [], intensity: [], maxHr: [] };
      row.count += 1;
      row.satisfaction.push(s.satisfaction);
      row.intensity.push(s.intensity);
      row.maxHr.push(s.max_hr);
      methodMap.set(key, row);
    }
  }
  const methodStats = [...methodMap.values()]
    .sort((a, b) => b.count - a.count || (avg(b.satisfaction) || 0) - (avg(a.satisfaction) || 0))
    .slice(0, 8)
    .map((m) => `${m.label}: n${m.count}, sat ${fmtAvg(avg(m.satisfaction))}, intensity ${fmtAvg(avg(m.intensity))}, maxHR ${fmtAvg(avg(m.maxHr), 0)}`)
    .join(" | ");

  // FULL_AI_SESSION_CONTEXT_EXPOSURE_V1
  const structuredContextLines = sessions
    .map((s) => {
      const context = sessionContextEvidenceText(s);
      return context ? `${sessionDateKey(s.date) || "unknown"}: ${context}` : null;
    })
    .filter(Boolean);

  const contextMap = new Map();
  for (const s of sessions) {
    for (const raw of [...sessionContextFactorLabels(s), s.build_type].filter(Boolean)) {
      const key = String(raw).toLowerCase();
      const row = contextMap.get(key) || { label: raw, count: 0, satisfaction: [], intensity: [] };
      row.count += 1;
      row.satisfaction.push(s.satisfaction);
      row.intensity.push(s.intensity);
      contextMap.set(key, row);
    }
  }
  const contextStats = [...contextMap.values()]
    .filter((c) => c.count >= 2)
    .sort((a, b) => (avg(b.satisfaction) || 0) - (avg(a.satisfaction) || 0))
    .slice(0, 8)
    .map((c) => `${c.label}: n${c.count}, sat ${fmtAvg(avg(c.satisfaction))}, intensity ${fmtAvg(avg(c.intensity))}`)
    .join(" | ");

  return [
    `Coverage: ${sessions.length} sessions, ${withHr.length} with HR, ${climaxSessions.length} with climax timing, ${favorites} favorites, ${sessions.filter((s) => s.no_climax).length} no-climax sessions.`,
    motionCoverage.any ? `Motion evidence is available for ${motionCoverage.any} sessions: ${motionCoverage.saved} with saved motion telemetry, ${motionCoverage.promoted} with promoted motion-derived timeline events, and ${motionCoverage.both} with both. Saved telemetry counts as motion evidence even when no reviewed finding has been promoted. Treat movement evidence as observational, not mechanism; activity scores are normalized within each analyzed window and are not absolute magnitudes across recordings.` : null,
    `HR: avg session HR ${fmtAvg(avg(sessions.map((s) => s.avg_hr)), 0)}, avg max HR ${fmtAvg(avg(sessions.map((s) => s.max_hr)), 0)}, avg HR at climax ${fmtAvg(avg(sessions.map((s) => s.hr_at_climax)), 0)}.`,
    `Ratings: avg satisfaction ${fmtAvg(avg(sessions.map((s) => s.satisfaction)))}, avg intensity ${fmtAvg(avg(sessions.map((s) => s.intensity)))}, avg build quality ${fmtAvg(avg(sessions.map((s) => s.build_quality)))}.`,
    topRated ? `Highest-rated evidence: ${topRated}` : null,
    methodStats ? `Method patterns: ${methodStats}` : null,
    contextStats ? `Context patterns: ${contextStats}` : null,
    structuredContextLines.length
      ? `Structured context evidence is available for ${structuredContextLines.length} sessions. Use it where relevant for context sensitivity, but do not treat it as causal by itself: ${structuredContextLines.slice(0, 30).join(" | ")}${structuredContextLines.length > 30 ? " | additional context-bearing sessions omitted from this compact digest but still present in the session-by-session evidence lines" : ""}`
      : null,
  ].filter(Boolean).join("\n");
}

function normalizeAIProfileResult(raw) {
  const parsed = raw?.response ?? raw;
  if (!parsed) return null;
  if (typeof parsed === "string") {
    return { profile_overview: parsed, arousal_physiology: [], stimulation_profile: [], climax_and_recovery: [], contextual_sensitivities: [], discomfort_and_edge_cases: [], behavioral_tendencies: [], optimization_recommendations: [] };
  }
  if (parsed.raw && typeof parsed.raw === "string") {
    return { profile_overview: parsed.raw, arousal_physiology: [], stimulation_profile: [], climax_and_recovery: [], contextual_sensitivities: [], discomfort_and_edge_cases: [], behavioral_tendencies: [], optimization_recommendations: [] };
  }
  return parsed;
}

function normalizeAnatomicalProfileResult(raw) {
  const parsed = raw?.response ?? raw;
  if (!parsed) return null;
  if (typeof parsed === "string") {
    return { overview: parsed };
  }
  if (parsed.raw && typeof parsed.raw === "string") {
    return { overview: parsed.raw };
  }
  return parsed;
}

function aiErrorMessage(error) {
  const raw = error?.data?.error || error?.message || String(error || "Analysis failed");
  try {
    const parsed = JSON.parse(raw);
    const nested = parsed?.error?.message || parsed?.message || parsed?.error;
    if (nested) return nested;
  } catch {
    // use raw text below
  }
  return raw;
}

async function saveClusterAnalysisPatch(patch, sessionCount) {
  const existing = await base44.entities.SessionClusterAnalysis.list("-updated_date", 1);
  if (existing[0]) {
    await base44.entities.SessionClusterAnalysis.update(existing[0].id, {
      ...patch,
      ...(sessionCount != null ? { session_count: sessionCount } : {}),
    });
    return;
  }
  await base44.entities.SessionClusterAnalysis.create({
    ...patch,
    ...(sessionCount != null ? { session_count: sessionCount } : {}),
  });
}

function profileArchiveId(kind, result) {
  const generated = result?._meta?.last_generated_at || result?._meta?.updated_at || new Date().toISOString();
  const sourceCount = result?._meta?.source_session_count ?? "unknown";
  return `${kind}-${generated}-${sourceCount}`;
}

function buildProfileArchiveEntry(kind, label, result) {
  const meta = result?._meta || {};
  const generatedAt = meta.last_generated_at || meta.updated_at || new Date().toISOString();
  return {
    id: profileArchiveId(kind, result),
    kind,
    label,
    archived_at: new Date().toISOString(),
    generated_at: generatedAt,
    source_session_count: meta.source_session_count ?? null,
    motion_evidence_session_count: meta.motion_evidence_session_count ?? null,
    source_signature: meta.source_signature || "",
    result,
  };
}

function mergeProfileArchive(existingArchive = [], entry) {
  const archive = Array.isArray(existingArchive) ? existingArchive : [];
  return [
    entry,
    ...archive.filter((item) => item?.id !== entry.id && item?.generated_at !== entry.generated_at),
  ].slice(0, PROFILE_ARCHIVE_LIMIT);
}

async function saveProfileResultWithArchive({
  resultKey,
  archiveKey,
  kind,
  label,
  result,
  sessionCount,
}) {
  const existing = await base44.entities.SessionClusterAnalysis.list("-updated_date", 1);
  const entry = buildProfileArchiveEntry(kind, label, result);
  const archive = mergeProfileArchive(existing[0]?.[archiveKey], entry);
  const patch = {
    [resultKey]: result,
    [archiveKey]: archive,
    ...(sessionCount != null ? { session_count: sessionCount } : {}),
  };
  if (existing[0]) {
    await base44.entities.SessionClusterAnalysis.update(existing[0].id, patch);
  } else {
    await base44.entities.SessionClusterAnalysis.create(patch);
  }
  return archive;
}

async function runProfilerAIJob(payload, label, onProgress) {
  const startedJob = await startBackgroundJob("ai_invoke", { ...payload, label }, {
    source: "Profiler",
    route: "/profiler",
    label,
  });
  onProgress?.(startedJob);
  const completedJob = await waitForBackgroundJob(startedJob.id, {
    intervalMs: 1200,
    onProgress,
  });
  return completedJob.result;
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

function ProfilerJobStatus({ job, fallback }) {
  if (!job && !fallback) return null;
  const progress = job?.progress || {};
  const total = Number(progress.total || 0);
  const current = Number(progress.current || 0);
  const pct = job?.status === "complete"
    ? 100
    : total > 0
      ? Math.max(8, Math.min(100, Math.round((current / total) * 100)))
      : 18;
  const label = progress.message || fallback || "Working in the background…";

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
            <span>You can leave this page while it finishes.</span>
          </div>
        </div>
      </div>
    </div>
  );
}

function compactSessionLine(s) {
  const methods = [...(s.methods || []), ...(s.custom_methods || [])].filter(Boolean).slice(0, 5).join(", ") || "none";
  const structuredContext = sessionContextEvidenceText(s);
  const substances = Array.isArray(s.substances) ? s.substances : [s.substances].filter(Boolean);
  const context = structuredContext || [s.mood, s.environment, s.build_type, ...substances].filter(Boolean).join(", ") || "no context";
  const markers = [
    s.pre_climax_offset_s != null ? `pre ${fmtSec(s.pre_climax_offset_s)}` : null,
    s.climax_offset_s != null ? `climax ${fmtSec(s.climax_offset_s)}` : s.no_climax ? "no climax" : null,
    s.recovery_offset_s != null ? `recovery ${fmtSec(s.recovery_offset_s)}` : null,
  ].filter(Boolean).join("; ");
  const hr = [
    s.avg_hr ? `avg ${s.avg_hr}` : null,
    s.max_hr ? `max ${s.max_hr}` : null,
    s.hr_at_climax ? `climax ${s.hr_at_climax}` : null,
  ].filter(Boolean).join("/");
  const events = (s.event_timeline || [])
    .slice(0, 4)
    .map((e) => `${fmtSec(e.time_s)}${e.source === "motion_derived" ? ` [motion-derived observation${e.verification_status === "reviewed_verified" ? ", user-verified" : e.verification_status === "reviewed_adjusted" ? ", user-reviewed and adjusted" : ", unverified"}]` : ""} ${briefText(e.note, 70)}`)
    .join(" | ");
  const manualPauseResumeEvents = getManualStimulationPauseResumeEvents(s)
    .map((event) => `${fmtSec(event.time_s)} ${(Array.isArray(event.category) ? event.category : [event.category]).includes("stimulation_paused") ? "stimulation paused" : "stimulation resumed"}`)
    .join(" | ");
  const motion = s.motion_analysis_summary;
  const motionSummary = getMotionEvidenceSummary(s);
  const motionQuality = motion?.quality_indicators
    ? [
      motion.quality_indicators.left_lower_body ? `left quality ${motion.quality_indicators.left_lower_body}` : null,
      motion.quality_indicators.right_lower_body ? `right quality ${motion.quality_indicators.right_lower_body}` : null,
      motion.quality_indicators.hands ? `hand quality ${motion.quality_indicators.hands}` : null,
    ].filter(Boolean).join(", ")
    : null;
  const motionEvidence = motionSummary.hasAnyMotionEvidence
    ? `media motion ${[
      motionSummary.hasSavedTelemetry && !motionSummary.hasPromotedEvents ? "saved telemetry available; no promoted findings yet" : null,
      !motionSummary.hasSavedTelemetry && motionSummary.hasPromotedEvents ? "promoted motion-derived findings available without saved telemetry summary" : null,
      motionSummary.hasSavedTelemetry && motionSummary.hasPromotedEvents ? "saved telemetry plus promoted findings available" : null,
      motion?.left_lower_body_average_activity != null ? `left ${motion.left_lower_body_average_activity}` : null,
      motion?.right_lower_body_average_activity != null ? `right ${motion.right_lower_body_average_activity}` : null,
      motion?.left_forefoot_average_activity != null ? `left forefoot/toe-region ${motion.left_forefoot_average_activity}` : null,
      motion?.right_forefoot_average_activity != null ? `right forefoot/toe-region ${motion.right_forefoot_average_activity}` : null,
      motion?.hand_average_activity != null ? `hands ${motion.hand_average_activity}` : null,
      motionSummary.footGeometryTrackingSummary?.status === "marker_tracking_available" || motionSummary.footGeometryTrackingSummary?.status === "limited_marker_tracking"
        ? `continuous foot geometry tracking ${motionSummary.footGeometryTrackingSummary.coverage_pct}% coverage; average fan ${motionSummary.footGeometryTrackingSummary.average_fan_angle_deg ?? "?"}°, toe gap ${motionSummary.footGeometryTrackingSummary.average_toe_gap_normalized ?? "?"}, heel gap ${motionSummary.footGeometryTrackingSummary.average_heel_gap_normalized ?? "?"}; interpret as visual trend evidence for foot spread/fanning over time, not just one saved frame`
        : null,
      motion?.asymmetry_summary
        ? `asymmetry average index ${motion.asymmetry_summary.averageIndex}, peak ${motion.asymmetry_summary.peakIndex}, ${motion.asymmetry_summary.predominantSide === "balanced" ? "no clear side predominance" : `${motion.asymmetry_summary.predominantSide} predominance in ${motion.asymmetry_summary.predominantPct}% of active paired windows`}`
        : null,
      motion?.hand_movement_summary?.reliability === "moderate" && motion.hand_movement_summary.movement_cycles_per_minute_estimate != null
        ? `estimated hand-movement cadence ${motion.hand_movement_summary.movement_cycles_per_minute_estimate} movement cycles/min with ${motion.hand_movement_summary.pause_count} pauses of at least two seconds (observational proxy, not confirmed stroke speed)`
        : null,
      motionQuality ? `confidence/reliability ${motionQuality}` : null,
      (motion?.findings || []).length
        ? briefText(motion.findings.filter((finding) => !finding.startsWith("Repeated hand-movement oscillations support")).join(" "), 140)
        : null,
      motionSummary.promotedEventCount ? `${motionSummary.promotedEventCount} promoted motion-derived events` : null,
    ].filter(Boolean).join(", ")}`
    : null;
  return [
    `${sessionDateKey(s.date) || "unknown"}: ${s.duration_minutes || "?"}m`,
    `methods ${methods}`,
    `ratings I${s.intensity ?? "?"}/S${s.satisfaction ?? "?"}/build${s.build_quality ?? "?"}`,
    `HR ${hr || "none"}`,
    `markers ${markers || "none"}`,
    `context ${context}`,
    s.discomfort ? `discomfort ${briefText(s.discomfort, 90)}` : null,
    s.unusual_sensations ? `sensations ${briefText(s.unusual_sensations, 90)}` : null,
    s.notes ? `notes ${briefText(s.notes, 120)}` : null,
    events ? `events ${events}` : null,
    manualPauseResumeEvents ? `manual stimulation pause/resume timing (primary for pause interpretation) ${manualPauseResumeEvents}` : null,
    motionEvidence,
  ].filter(Boolean).join("; ");
}

function compactAnatomicalSessionLine(s) {
  return compactSessionLine(s).replace(
    String(sessionDateKey(s.date) || "unknown"),
    fmtNarrativeDate(s.date),
  );
}

function CompactError({ message }) {
  if (!message) return null;
  return (
    <div className="flex items-start gap-2 rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
      <span>{message}</span>
    </div>
  );
}

// Import-equivalent: NCE keyword list for note corroboration (mirrored from NearClimaxEvents)
const NCE_KEYWORDS = [
  "tension", "tense", "tight", "tighten", "clench", "grip",
  "foot", "feet", "plant", "planting", "toe", "curl",
  "throb", "pulse", "pulsing", "twitch", "spasm",
  "edge", "edg", "near", "almost", "close", "threshold",
  "pressure", "build", "buildup", "surge", "wave", "rush",
  "intense", "intensity", "strong", "overwhelming",
  "breath", "breathing", "gasp", "hold",
  "shiver", "shak", "tremble",
];

function scoreEventNoteCorroboration(eventStartS, eventEndS, sessionEvents) {
  if (!sessionEvents || sessionEvents.length === 0) return 0;
  const windowS = 45;
  let score = 0;
  for (const ev of sessionEvents) {
    const t = Number(ev.time_s);
    if (t < eventStartS - windowS || t > eventEndS + windowS) continue;
    const dist = Math.max(0, Math.min(Math.abs(t - eventStartS), Math.abs(t - eventEndS)));
    const proximityWeight = dist < 15 ? 2 : 1;
    const note = (ev.note || "").toLowerCase();
    const cats = Array.isArray(ev.category) ? ev.category : [ev.category].filter(Boolean);
    if (cats.some(c => ["physical", "sensation"].includes(c))) score += 1 * proximityWeight;
    for (const kw of NCE_KEYWORDS) {
      if (note.includes(kw)) { score += 2 * proximityWeight; break; }
    }
  }
  return score;
}

// Detect near-climax events: sustained HR elevations (not brief spikes) before the pre-climax marker.
// Uses event note corroboration for confidence scoring.
function detectNearClimaxEvents(rows, climaxOffsetS, preClimaxOffsetS, sessionEvents = []) {
  if (!rows || rows.length < 10) return [];

  const smoothed = rows.map((r, i) => {
    const win = rows.slice(Math.max(0, i - 3), i + 4);
    const avg = win.reduce((a, w) => a + Number(w.hr), 0) / win.length;
    return { t: Number(r.time_offset_s), hr: avg };
  });

  const excludeStart = climaxOffsetS != null
    ? (preClimaxOffsetS != null
        ? Math.min(preClimaxOffsetS, climaxOffsetS - 60)
        : climaxOffsetS - 90)
    : Infinity;

  const allHRs = smoothed.filter(p => p.t < excludeStart).map(p => p.hr);
  if (allHRs.length < 10) return [];
  const sessionMinHR = Math.min(...allHRs);
  const sessionMaxHR = Math.max(...allHRs);
  const sessionHRRange = sessionMaxHR - sessionMinHR;

  const MIN_RISE_BPM = Math.max(7, sessionHRRange * 0.13);
  const MAX_RISE_BPM = sessionHRRange * 0.78;
  const RISE_WINDOW_S = 120;
  const SUSTAINED_THRESHOLD_S = 20;
  const SUSTAINED_TOLERANCE = 5;
  const DROP_BPM = Math.max(5, MIN_RISE_BPM * 0.55);
  const SEARCH_DROP_S = 150;
  const MIN_DURATION_S = 25;
  const MAX_DURATION_S = 300;
  const COOLDOWN_S = 30;
  const MIN_CONFIDENCE = 2;

  const events = [];
  let lastEventEnd = -Infinity;
  let i = 0;

  while (i < smoothed.length - 5) {
    const { t: t0, hr: hr0 } = smoothed[i];
    if (t0 < lastEventEnd + COOLDOWN_S) { i++; continue; }
    if (t0 >= excludeStart) break;

    let peakIdx = i;
    let peakHr = hr0;
    for (let j = i + 1; j < smoothed.length; j++) {
      if (smoothed[j].t - t0 > RISE_WINDOW_S) break;
      if (smoothed[j].t >= excludeStart) break;
      if (smoothed[j].hr > peakHr) { peakHr = smoothed[j].hr; peakIdx = j; }
    }

    const rise = peakHr - hr0;
    if (rise < MIN_RISE_BPM || rise > MAX_RISE_BPM || peakIdx === i) { i++; continue; }

    const peakTime = smoothed[peakIdx].t;

    // Require sustained elevation — not just a momentary spike
    let sustainedEndIdx = peakIdx;
    for (let j = peakIdx + 1; j < smoothed.length; j++) {
      if (smoothed[j].t - peakTime > 90) break;
      if (smoothed[j].hr >= peakHr - SUSTAINED_TOLERANCE) sustainedEndIdx = j;
    }
    const sustainedDuration = smoothed[sustainedEndIdx].t - peakTime;
    if (sustainedDuration < SUSTAINED_THRESHOLD_S) { i = peakIdx + 1; continue; }

    let dropIdx = -1;
    for (let j = sustainedEndIdx + 1; j < smoothed.length; j++) {
      if (smoothed[j].t - peakTime > SEARCH_DROP_S) break;
      if (smoothed[j].hr <= peakHr - DROP_BPM) { dropIdx = j; break; }
    }
    if (dropIdx === -1) { i = peakIdx + 1; continue; }

    const eventDuration = smoothed[dropIdx].t - t0;
    if (eventDuration < MIN_DURATION_S || eventDuration > MAX_DURATION_S) { i++; continue; }
    if (peakHr >= sessionMaxHR * 0.96) { i = dropIdx + 1; continue; }

    const noteScore = scoreEventNoteCorroboration(t0, smoothed[dropIdx].t, sessionEvents);
    const hrConfidence = Math.min(4, Math.floor((rise / MIN_RISE_BPM - 1) * 2) + Math.floor(sustainedDuration / 20));
    const totalConfidence = hrConfidence + noteScore;
    if (totalConfidence < MIN_CONFIDENCE) { i++; continue; }

    events.push({
      start_offset_s: t0,
      peak_offset_s: peakTime,
      end_offset_s: smoothed[dropIdx].t,
      base_hr: Math.round(hr0),
      peak_hr: Math.round(peakHr),
      rise_bpm: Math.round(rise),
      sustained_s: Math.round(sustainedDuration),
      duration_s: Math.round(eventDuration),
      confidence: Math.min(10, totalConfidence),
      note_corroborated: noteScore > 0,
    });

    lastEventEnd = smoothed[dropIdx].t;
    i = dropIdx + 1;
  }

  return events;
}

// ── Sub-components ─────────────────────────────────────────────────────────────

function SectionCard({ icon, title, color, children, defaultCollapsed = false }) {
  const [collapsed, setCollapsed] = useState(defaultCollapsed);
  return (
    <div className="bg-card rounded-xl border border-border p-4 space-y-3">
      <button
        className="w-full flex items-center justify-between gap-1.5 text-left"
        onClick={() => setCollapsed(v => !v)}
      >
        <h3 className="text-xs font-semibold uppercase tracking-wider flex items-center gap-1.5" style={{ color }}>
          {icon}{title}
        </h3>
        {collapsed
          ? <ChevronDown className="w-4 h-4 text-muted-foreground shrink-0" />
          : <ChevronUp className="w-4 h-4 text-muted-foreground shrink-0" />}
      </button>
      {!collapsed && children}
    </div>
  );
}

function profileArchivePreview(entry) {
  const result = entry?.result || {};
  const firstArrayText = [
    result.arousal_physiology,
    result.constitutional_and_systemic_context,
    result.pelvic_and_external_anatomy,
    result.stimulation_profile,
  ].find((items) => Array.isArray(items) && items.length)?.[0];
  return briefText(result.profile_overview || result.overview || firstArrayText || "No preview available for this archived run.", 320);
}

function profileArchiveGeneratedLabel(entry) {
  return entry?.generated_at ? formatGeneratedAt(entry.generated_at) : "Unknown generation time";
}

function isCurrentArchiveEntry(entry, currentResult) {
  const currentGenerated = currentResult?._meta?.last_generated_at || currentResult?._meta?.updated_at || "";
  return Boolean(currentGenerated && entry?.generated_at === currentGenerated);
}

function ProfileArchiveList({ title = "Profile Run Archive", archive = [], currentResult, onViewRun }) {
  if (!archive.length) return null;
  return (
    <div className="rounded-lg border border-border bg-muted/10 p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h4 className="flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider text-primary">
            <History className="h-3.5 w-3.5" /> {title}
          </h4>
          <p className="mt-0.5 text-[10px] text-muted-foreground">
            Saved profiler runs for longitudinal review. Latest {PROFILE_ARCHIVE_LIMIT} are retained.
          </p>
        </div>
        <Badge variant="secondary" className="text-[10px]">{archive.length} saved</Badge>
      </div>
      <div className="mt-3 space-y-2">
        {archive.map((entry) => {
          const current = isCurrentArchiveEntry(entry, currentResult);
          return (
            <details key={entry.id || entry.generated_at} className="rounded-lg border border-border bg-background/60 px-3 py-2">
              <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
                <span className="min-w-0">
                  <span className="block truncate text-xs font-semibold text-foreground">
                    {profileArchiveGeneratedLabel(entry)}
                  </span>
                  <span className="mt-0.5 block text-[10px] text-muted-foreground">
                    {entry.source_session_count ?? "?"} source sessions
                    {entry.motion_evidence_session_count != null ? ` · ${entry.motion_evidence_session_count} with motion evidence` : ""}
                  </span>
                </span>
                <span className="flex shrink-0 items-center gap-2">
                  {current && <Badge variant="outline" className="text-[10px]">Current</Badge>}
                  <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                </span>
              </summary>
              <p className="mt-2 text-xs leading-relaxed text-muted-foreground">{profileArchivePreview(entry)}</p>
              <div className="mt-2 flex justify-end">
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="h-7 text-xs"
                  onClick={() => onViewRun?.(entry.result)}
                >
                  View This Run
                </Button>
              </div>
            </details>
          );
        })}
      </div>
    </div>
  );
}

function imageFileToPayload(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const dataUrl = String(reader.result || "");
      const base64 = dataUrl.replace(/^data:[^;]+;base64,/, "");
      resolve({
        id: `${file.name}-${file.size}-${file.lastModified}`,
        filename: file.name,
        media_type: file.type || "image/jpeg",
        data: base64,
        previewUrl: dataUrl,
        size: file.size,
        lastModified: file.lastModified,
      });
    };
    reader.onerror = () => reject(reader.error || new Error(`Could not read ${file.name}`));
    reader.readAsDataURL(file);
  });
}

function compactProfileJsonValue(value) {
  if (value == null) return null;
  if (typeof value === "string") return value.trim() ? value.trim() : null;
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) {
    const items = value.map(compactProfileJsonValue).filter((item) => item != null);
    return items.length ? items : null;
  }
  if (typeof value === "object") {
    const entries = Object.entries(value)
      .map(([key, entryValue]) => [key, compactProfileJsonValue(entryValue)])
      .filter(([, entryValue]) => entryValue != null);
    return entries.length ? Object.fromEntries(entries) : null;
  }
  return null;
}

function buildProfileImageReviewContext({ userProfile, sessions = [] }) {
  const qaEntries = normalizeProfileQaFindings(userProfile?.profile_qa_findings);
  const qaCards = buildProfileQaFindingCards(userProfile?.profile_qa_findings, userProfile?.first_name).slice(0, 45);
  const compactMetrics = compactProfileJsonValue({
    anatomical_mechanical_profile: userProfile?.anatomical_mechanical_profile,
    profile_notes: userProfile?.profile_notes || userProfile?.notes,
    age: userProfile?.age,
    sex: userProfile?.sex,
    height: userProfile?.height,
    weight: userProfile?.weight,
    medications: userProfile?.medications,
    medical_context: userProfile?.medical_context,
    physiology_notes: userProfile?.physiology_notes,
  });
  const sortedSessions = [...(sessions || [])]
    .sort((a, b) => new Date(b.date || b.created_date || 0) - new Date(a.date || a.created_date || 0));
  const sessionLines = sortedSessions.slice(0, 45).map(compactAnatomicalSessionLine).filter(Boolean);
  const evidenceDigest = sortedSessions.length ? naturalizeSpokenDates(buildProfileEvidenceDigest(sortedSessions)) : "";

  return `
PROFILE IMAGE REVIEW SOURCE CONTEXT:
- Use the uploaded images as the primary source for directly visible anatomy, position, tissue state, and image-limited observations.
- Use saved Q&A findings, entered profile metrics, and session evidence as historical/mechanical context. Reconcile them with the images instead of ignoring them.
- If existing context conflicts with the image, state the mismatch and explain which source is stronger for that claim.
- Do not let profile history make you overcall something that is not visible.

SAVED PROFILE Q&A FINDINGS (${qaEntries.length} entries; showing up to ${qaCards.length} deduplicated findings):
${qaCards.length ? qaCards.map((card, index) => `${index + 1}. ${card.finding} (${card.sourceLabel}, ${card.timestamp})`).join("\n") : "- None saved."}

ENTERED PROFILE METRICS AND NOTES:
${compactMetrics ? JSON.stringify(compactMetrics, null, 2) : "- None saved."}

SESSION EVIDENCE SUMMARY (${sortedSessions.length} sessions loaded):
${evidenceDigest || "- No session evidence loaded."}

SELECTED SESSION-BY-SESSION ANATOMICAL / PHYSIOLOGICAL EVIDENCE:
${sessionLines.length ? sessionLines.join("\n") : "- No session-level anatomical evidence available."}
`;
}

function buildImageReviewMeta(images = [], sessions = [], previousMeta = null) {
  return {
    ...buildProfileAIContentMeta(sessions, previousMeta, null),
    image_count: images.length,
    image_filenames: images.map((image) => image.filename).filter(Boolean),
    source_kind: "profile_image_review",
  };
}

function profileReviewResultSections(config) {
  return config.sections || [];
}

const HEAD_TO_TOE_IMAGE_REVIEW_CONFIG = {
  title: "Head-to-Toe Image Review",
  shortTitle: "Head-to-Toe",
  kind: "profile_head_to_toe_image_review",
  resultKey: "head_to_toe_image_review_result",
  archiveKey: "head_to_toe_image_review_archive",
  ttsSessionId: "profile-head-to-toe-image-review",
  icon: <ImageIcon className="w-4 h-4" />,
  color: "hsl(var(--chart-4))",
  purpose: "Nude whole-body image review in anatomical position, standing, prone, supine, seated, or on-table positioning.",
  helper: "Upload whole-body reference images for a structured visual review of posture, alignment, body habitus, skin/surface findings, table positioning, and profile-context fit. Images are sent only for this AI review and are not stored by this panel.",
  emptyText: "Add anatomical-position or table-position whole-body images when you want Sarah to build a head-to-toe profile reference.",
  reviewInstructions: `
HEAD-TO-TOE REVIEW SCOPE:
- Focus on whole-body anatomy and physiology-relevant visual context: posture, alignment, symmetry, body habitus, soft tissue distribution, skin/surface findings, limb positioning, hands, feet, and table/standing setup.
- Include pelvic/genital visibility only as broad positioning context. Save detailed genital, meatal, scrotal, perineal, instrumentation, or pelvic-floor review for the dedicated pelvic/genital panel.
- Compare visible whole-body findings against saved Q&A findings, prior sessions, and entered metrics. Highlight useful continuity and mismatches.
- Describe image-taking limitations that would improve future reviews, such as missing anterior/posterior/lateral views, posture angle, lighting, cropping, scale reference, or supine/prone mismatch.
`,
  sections: [
    { key: "overall_body_overview", label: "Overall Body Overview", color: "hsl(var(--chart-4))" },
    { key: "posture_alignment", label: "Posture & Alignment", color: "hsl(var(--chart-2))" },
    { key: "body_habitus_soft_tissue", label: "Body Habitus & Soft Tissue", color: "hsl(var(--primary))" },
    { key: "skin_surface_findings", label: "Skin & Surface Findings", color: "hsl(var(--chart-3))" },
    { key: "musculoskeletal_and_limb_findings", label: "Musculoskeletal, Limb, Hand & Foot Findings", color: "hsl(var(--chart-5))" },
    { key: "positioning_and_table_context", label: "Positioning & Table Context", color: "hsl(var(--chart-1))" },
    { key: "profile_context_reconciliation", label: "Profile Context Reconciliation", color: "hsl(var(--chart-2))" },
    { key: "limitations_and_next_images", label: "Limitations & Next Images", color: "hsl(var(--muted-foreground))", required: false },
  ],
};

const PELVIC_GENITAL_IMAGE_REVIEW_CONFIG = {
  title: "Pelvic & Genital Image Review",
  shortTitle: "Pelvic/Genital",
  kind: "profile_pelvic_genital_image_review",
  resultKey: "pelvic_genital_image_review_result",
  archiveKey: "pelvic_genital_image_review_archive",
  ttsSessionId: "profile-pelvic-genital-image-review",
  icon: <User className="w-4 h-4" />,
  color: "hsl(var(--chart-2))",
  purpose: "Detailed pelvis, external genital, glans/meatus/foreskin, scrotal/perineal, pelvic positioning, tissue state, and visible instrumentation or device-fit context review.",
  helper: "Upload pelvic/genital reference images for a focused anatomical review tied to saved Q&A, session evidence, and entered measurements. Keep this separate from the whole-body panel so the output can go deep without muddying the head-to-toe profile.",
  emptyText: "Add focused pelvic/genital images when you want Sarah to review external anatomy, state, tissue context, meatus/glans/foreskin, scrotum/perineum, and fit/instrumentation context.",
  reviewInstructions: `
PELVIC / GENITAL REVIEW SCOPE:
- Focus on visible pelvic positioning, external genital anatomy, shaft, glans, foreskin or circumcision context, meatus, scrotum, perineum, lower abdomen/groin, tissue state, surface findings, and image-limited pelvic-floor context.
- If catheters, urethral sounds, devices, sleeves, markers, stickers, lubricant, or medical/procedural supplies are visible, describe their visible position and fit cautiously. Do not invent insertion depth, advancement, discomfort, sensation, or procedure stage unless image evidence or saved context directly supports it.
- Compare visible findings with entered measurements, Foley/sound/device profile fields, prior Q&A findings, and session/video evidence. Use this to explain continuity, mismatch, or what cannot be assessed.
- Keep the language anatomical and practical. Do not eroticize the review or write arousal-focused prose.
`,
  sections: [
    { key: "pelvic_positioning_context", label: "Pelvic Positioning Context", color: "hsl(var(--chart-2))" },
    { key: "external_genital_overview", label: "External Genital Overview", color: "hsl(var(--primary))" },
    { key: "shaft_glans_foreskin_meatus", label: "Shaft, Glans, Foreskin & Meatus", color: "hsl(var(--chart-4))" },
    { key: "scrotal_perineal_and_pelvic_floor_context", label: "Scrotal, Perineal & Pelvic-Floor Context", color: "hsl(var(--chart-5))" },
    { key: "tissue_state_surface_findings", label: "Tissue State & Surface Findings", color: "hsl(var(--chart-3))" },
    { key: "instrumentation_fit_and_device_context", label: "Instrumentation, Fit & Device Context", color: "hsl(var(--chart-1))" },
    { key: "profile_context_reconciliation", label: "Profile Context Reconciliation", color: "hsl(var(--chart-2))" },
    { key: "limitations_and_next_images", label: "Limitations & Next Images", color: "hsl(var(--muted-foreground))", required: false },
  ],
};

function ProfileImageReviewPanel({
  config,
  sessions = [],
  userProfile,
  profileLoading = false,
  evidenceLoading = false,
}) {
  const [images, setImages] = useState([]);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [archive, setArchive] = useState([]);
  const [error, setError] = useState("");

  useEffect(() => {
    base44.entities.SessionClusterAnalysis.list("-updated_date", 1).then((rows) => {
      if (rows[0]?.[config.resultKey]) setResult(rows[0][config.resultKey]);
      if (Array.isArray(rows[0]?.[config.archiveKey])) setArchive(rows[0][config.archiveKey]);
    });
  }, [config.archiveKey, config.resultKey]);

  const handleImageFiles = async (event) => {
    const files = Array.from(event.target.files || []).filter((file) => file.type?.startsWith("image/"));
    event.target.value = "";
    if (!files.length) return;
    setError("");
    try {
      const loaded = await Promise.all(files.map(imageFileToPayload));
      setImages((current) => [...current, ...loaded].slice(0, config.maxImages || 8));
    } catch (err) {
      setError(err?.message || "Could not read one of the selected images.");
    }
  };

  const removeImage = (id) => {
    setImages((current) => current.filter((image) => image.id !== id));
  };

  const analyze = async () => {
    if (!images.length) return;
    setLoading(true);
    setError("");
    try {
      const groundingContext = buildAIGroundingContext(userProfile);
      const imageReviewContext = buildProfileImageReviewContext({ userProfile, sessions });
      const firstNameToneCue = buildOptionalFirstNameToneCue(userProfile, { prioritizeProfileTone: true });
      const imagePayload = images.map((image) => ({
        filename: image.filename,
        media_type: image.media_type,
        data: image.data,
      }));
      const raw = await base44.integrations.Core.InvokeLLM({
        model: "claude_sonnet_4_6",
        max_tokens: 7000,
        images: imagePayload,
        prompt: `You are Sarah, performing a dedicated profile image review for PulsePoint.

Review type: ${config.title}
Review purpose: ${config.purpose}

${groundingContext}
${imageReviewContext}
${PERSONALIZED_ANATOMY_OUTPUT_RULE}
${firstNameToneCue}
${SESSION_CONTEXT_GROUNDING_RULE}

IMAGE REVIEW RULES:
- Treat these as consensual private profile-reference images for anatomical and physiological review.
- Analyze only what is visible in the images and supported by saved profile context.
- Use existing Q&A findings, entered profile metrics, and session/video evidence as context, not as permission to invent visible findings.
- Do not eroticize the image or write arousal-focused prose.
- Do not infer identity, diagnosis, pathology, intent, pain, force, or sexual activity.
- If image quality, angle, lighting, posture, tissue state, cropping, or camera distortion limits confidence, say so clearly.
- Use anatomical terminology naturally and clinically.
- Write directly to the person using "you" and "your".
- Separate direct visual observations from cautious profile implications.
- Prefer specific observations over generic filler.
- Preserve uncertainty. Use "appears", "is visible", "may reflect", or "cannot be assessed from this image" where appropriate.

${config.reviewInstructions}

Return a detailed structured review. Keep each paragraph TTS-ready: complete sentences, no markdown bullets, no clipped fragments.

Uploaded image filenames:
${images.map((image, index) => `${index + 1}. ${image.filename}`).join("\n")}`,
        response_json_schema: {
          type: "object",
          properties: {
            overview: { type: "string" },
            ...Object.fromEntries(profileReviewResultSections(config).map((section) => [section.key, { type: "array", items: { type: "string" } }])),
          },
          required: ["overview", ...profileReviewResultSections(config).filter((section) => section.required !== false).map((section) => section.key)],
        },
      });
      const parsed = normalizeAnatomicalProfileResult(typeof raw === "string" ? JSON.parse(raw) : raw);
      if (!parsed?.overview) throw new Error("Sarah returned an empty image review.");
      const storedResult = {
        ...parsed,
        _meta: buildImageReviewMeta(images, sessions, result?._meta),
      };
      setResult(storedResult);
      const nextArchive = await saveProfileResultWithArchive({
        resultKey: config.resultKey,
        archiveKey: config.archiveKey,
        kind: config.kind,
        label: config.title,
        result: storedResult,
        sessionCount: sessions.length,
      });
      setArchive(nextArchive);
    } catch (err) {
      console.error(`${config.title} failed:`, err);
      setError(aiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const sections = profileReviewResultSections(config);
  const paragraphs = [];
  const paragraphMeta = [];
  if (result) {
    paragraphs.push(calmSpokenHeading(config.title));
    paragraphMeta.push({ type: "title", color: config.color, displayLabel: config.title });
    if (result.overview) {
      paragraphs.push(naturalizeSpokenDates(result.overview));
      paragraphMeta.push({ type: "overview" });
    }
    for (const section of sections) {
      if ((result[section.key] || []).length) {
        paragraphs.push(calmSpokenHeading(section.label));
        paragraphMeta.push({ type: "section-title", section, displayLabel: section.label });
      }
      for (const finding of (result[section.key] || [])) {
        paragraphs.push(naturalizeSpokenDates(finding));
        paragraphMeta.push({ type: "section", section });
      }
    }
  }

  return (
    <SectionCard icon={config.icon} title={config.title} color={config.color} defaultCollapsed={true}>
      <div className="space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <p className="max-w-3xl text-xs leading-relaxed text-muted-foreground">{config.helper}</p>
          <div className="flex shrink-0 flex-wrap gap-2">
            <label className="inline-flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-border bg-background px-3 text-xs font-medium text-foreground hover:bg-muted/60">
              <Upload className="h-3.5 w-3.5" /> Add Images
              <input type="file" accept="image/*" multiple className="hidden" onChange={handleImageFiles} />
            </label>
            <Button size="sm" onClick={analyze} disabled={loading || profileLoading || evidenceLoading || !userProfile || !images.length} className="h-8 gap-1.5 text-xs">
              {loading
                ? <><span className="h-3 w-3 animate-spin rounded-full border-2 border-white border-t-transparent" />Reviewing...</>
                : <><ImageIcon className="h-3.5 w-3.5" />{result ? "Re-review" : "Review Images"}</>}
            </Button>
          </div>
        </div>

        {result && (
          <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
            <span>{result?._meta?.last_generated_at ? `Generated ${formatGeneratedAt(result._meta.last_generated_at)}` : "Generated time unavailable"}</span>
            <span>Images reviewed: {result?._meta?.image_count ?? "?"}</span>
            {Array.isArray(result?._meta?.image_filenames) && result._meta.image_filenames.length > 0 && (
              <span className="max-w-full truncate">Files: {result._meta.image_filenames.join(", ")}</span>
            )}
          </div>
        )}

        {profileLoading && !result && (
          <p className="text-xs text-muted-foreground">Loading saved profile context...</p>
        )}

        {evidenceLoading && !result && (
          <p className="text-xs text-muted-foreground">Loading saved session evidence...</p>
        )}

        {!profileLoading && !images.length && (
          <p className="text-xs text-muted-foreground">{config.emptyText}</p>
        )}

        {images.length > 0 && (
          <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
            {images.map((image) => (
              <div key={image.id} className="overflow-hidden rounded-lg border border-border bg-muted/20">
                <div className="relative aspect-[4/3] bg-black">
                  <img src={image.previewUrl} alt={image.filename} className="h-full w-full object-contain" />
                  <button
                    type="button"
                    onClick={() => removeImage(image.id)}
                    className="absolute right-1 top-1 rounded-full bg-background/85 p-1 text-muted-foreground hover:text-destructive"
                    aria-label={`Remove ${image.filename}`}
                  >
                    <X className="h-3.5 w-3.5" />
                  </button>
                </div>
                <p className="truncate px-2 py-1.5 text-[10px] text-muted-foreground">{image.filename}</p>
              </div>
            ))}
          </div>
        )}

        <CompactError message={error} />

        {result && (
          <TTSReader
            sessionId={config.ttsSessionId}
            title={config.title}
            sourceGeneratedAt={result?._meta?.last_generated_at}
            paragraphs={paragraphs}
            renderParagraph={(text, idx, isActive, _isBuffering, activeSentenceIdx, startFromSentence) => {
              const meta = paragraphMeta[idx];
              if (!meta) return null;
              if (meta.type === "title" || meta.type === "section-title") {
                const color = meta.section?.color || meta.color || config.color;
                return (
                  <p
                    className="mt-4 border-t border-border pt-3 text-xs font-semibold transition-colors"
                    style={{ color, background: isActive ? `${color}18` : "transparent" }}
                  >
                    {meta.displayLabel || text}
                  </p>
                );
              }
              if (meta.type === "overview") {
                return (
                  <p
                    className="text-base font-medium leading-relaxed border-l-2 pl-3 py-1 transition-all duration-200 rounded-r-md text-foreground"
                    style={{
                      borderColor: isActive ? config.color : `${config.color}99`,
                      background: isActive ? `${config.color}18` : "transparent",
                    }}
                  >
                    {renderSentenceHighlightedText(text, activeSentenceIdx, startFromSentence)}
                  </p>
                );
              }
              const { section } = meta;
              return (
                <p
                  className="border-l-2 pl-3 py-1 text-sm leading-relaxed transition-all duration-200 rounded-r-md"
                  style={{
                    borderColor: isActive ? section.color : `${section.color}66`,
                    background: isActive ? `${section.color}18` : "transparent",
                  }}
                >
                  {renderSentenceHighlightedText(text, activeSentenceIdx, startFromSentence)}
                </p>
              );
            }}
          />
        )}

        <ProfileArchiveList
          title={`${config.shortTitle} Run Archive`}
          archive={archive}
          currentResult={result}
          onViewRun={(archivedResult) => archivedResult && setResult(archivedResult)}
        />
      </div>
    </SectionCard>
  );
}

function AIProfilePanel({ sessions, userProfile, journals, evidenceLoading = false }) {
  const [loading, setLoading] = useState(false);
  const [jobStatus, setJobStatus] = useState(null);
  const [result, setResult] = useState(null);
  const [archive, setArchive] = useState([]);
  const [error, setError] = useState("");
  const profileStale = isProfileAIContentStale(result, sessions);

  useEffect(() => {
    base44.entities.SessionClusterAnalysis.list("-updated_date", 1).then((rows) => {
      if (rows[0]?.result) setResult(rows[0].result);
      if (Array.isArray(rows[0]?.profile_result_archive)) setArchive(rows[0].profile_result_archive);
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (evidenceLoading) return undefined;

    const reconnect = async () => {
      try {
        const activeData = await listBackgroundJobs({
          type: "ai_invoke",
          status: "queued,running",
          metaSource: "Profiler",
          limit: 12,
        });
        if (cancelled) return;
        let job = (activeData.jobs || []).find((item) => item.meta?.label === "AI Profiler: Comprehensive Profile");
        if (!job) {
          const completedData = await listBackgroundJobs({
            type: "ai_invoke",
            status: "complete",
            metaSource: "Profiler",
            limit: 12,
          });
          if (cancelled) return;
          job = (completedData.jobs || []).find((item) => item.meta?.label === "AI Profiler: Comprehensive Profile");
        }
        if (!job) return;
        if (job.status === "complete" && !isNewerCompletedJob(job, result)) return;

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
        if (!isNewerCompletedJob(completedJob, result)) return;

        const parsed = normalizeAIProfileResult(completedJob.result);
        if (!parsed?.profile_overview && !parsed?.arousal_physiology?.length) return;
        const storedResult = {
          ...parsed,
          _meta: buildProfileAIContentMeta(sessions, result?._meta, completedAt(completedJob)),
        };
        setResult(storedResult);
        const nextArchive = await saveProfileResultWithArchive({
          resultKey: "result",
          archiveKey: "profile_result_archive",
          kind: "comprehensive_profile",
          label: "Comprehensive Physiological Profile",
          result: storedResult,
          sessionCount: sessions.length,
        });
        if (!cancelled) setArchive(nextArchive);
      } catch (err) {
        if (!cancelled) console.warn("AI profile reconnect skipped:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    reconnect();
    return () => {
      cancelled = true;
    };
  }, [evidenceLoading, result, sessions.length]);

  const analyze = async () => {
    setLoading(true);
    setJobStatus({
      status: "starting",
      progress: {
        phase: "building",
        current: 0,
        total: 3,
        message: "Preparing the cross-session profile for background analysis…",
      },
    });
    setResult(null);
    setError("");

    try {
    const sortedSessions = [...sessions].sort((a, b) => new Date(b.date) - new Date(a.date));
    const sessionSummaries = sortedSessions.map(compactSessionLine).join("\n");
    const evidenceDigest = buildProfileEvidenceDigest(sortedSessions);
    const groundingContext = buildAIGroundingContext(userProfile);
    const firstNameToneCue = buildOptionalFirstNameToneCue(userProfile, { prioritizeProfileTone: true });

    const profileContext = userProfile ? `
USER PROFILE & NOTES:
Age: ${userProfile.age || "—"} | Fitness: ${userProfile.fitness_level || "—"} | Resting HR: ${userProfile.resting_hr || "—"} bpm | Max HR: ${userProfile.max_hr || "—"} bpm
Arousal style: ${userProfile.arousal_response_style || "—"} | Build duration: ${userProfile.typical_build_duration || "—"} | Climax sensitivity: ${userProfile.climax_sensitivity || "—"}
Preferred stimulation: ${(userProfile.preferred_stimulation || []).join(", ") || "—"}
Refractory pattern: ${userProfile.refractory_pattern || "—"}
Medications/conditions: ${userProfile.medications || "none noted"}
Arousal notes: ${userProfile.arousal_notes || "none"}
` : "";

    // Build journal context from all available journal entries
  const normalizedJournals = (journals || []).map((j) => ({ ...j, ai_journal: normalizeJournalEntry(j.ai_journal) }));
  const journalContext = normalizedJournals.length > 0 ? `

SESSION JOURNALS (${Math.min(normalizedJournals.length, 8)} recent entries — subjective post-session reflections):
${normalizedJournals.slice(0, 8).map((j) => {
  const ai = j.ai_journal;
  const date = fmtNarrativeDate(j.session_date);
  if (!ai && !j.voice_transcript) return null;
  return `[Session ${date}]:
${ai?.emotional_reflection ? `  Emotional: ${briefText(ai.emotional_reflection, 220)}` : ""}
${ai?.physiological_observations ? `  Physiological: ${briefText(ai.physiological_observations, 220)}` : ""}
${ai?.insights ? `  Insights: ${briefText(ai.insights, 220)}` : ""}
${ai?.next_session_intentions ? `  Intentions: ${briefText(ai.next_session_intentions, 180)}` : ""}
${j.voice_transcript && !ai ? `  Notes: ${briefText(j.voice_transcript, 220)}` : ""}`.trim();
}).filter(Boolean).join("\n\n")}

Use the journals to surface recurring emotional themes, evolving insights, and subjective experiences that the raw session metrics alone cannot reveal. Note where the person's own reflections align with or diverge from the physiological data.` : "";

    const res = await runProfilerAIJob({
      model: "claude_sonnet_4_6",
      temperature: 0.5,
      prompt: `You are an expert physiological and sexual response analyst. Based on ${sessions.length} recorded sessions and profile notes, generate a comprehensive, deeply personal physiological and arousal profile. Write directly to the person — use "you" and "your" throughout, as if speaking to them personally.

${groundingContext}
${SESSION_CONTEXT_GROUNDING_RULE}
SESSION CONTEXT PROFILE RULE:
- Structured session context is longitudinal evidence. Use it in the AI Profiler wherever it helps explain recurring contextual sensitivities, session clusters, outliers, recovery differences, build quality differences, or preparation effects.
- Context should qualify, explain, or contextualize the core findings. Do not let hydration, fatigue, food state, cannabis, alcohol, privacy/interruption risk, mental state, environment, or preparation replace the central analysis of observable arousal physiology, stimulation response, anatomy or device interaction, motion evidence, climax mechanics, and recovery behavior.
- Integrate context outside the contextual_sensitivities section only when it clearly modifies one of those core body/mechanics observations.
- Distinguish repeated association, plausible modifier, single-session anecdote, and unproven causal explanation. Do not rank a contextual factor as important unless repeated session evidence supports that weighting.
- Never upgrade logged context into proof of causation. Use language like "appears associated with", "may have shaped", or "is repeatedly present in sessions where..." unless the evidence is direct and repeated.

AI PROFILER PRIORITY RULE:
- Prioritize directly observed sexual and physiological mechanics first: arousal build shape, stimulation method response, erection quality, glans/shaft/foreskin dynamics, urethral or device-fit observations, prostatic/perineal involvement, ejaculatory characteristics, foot/lower-body motion telemetry, climax timing, and recovery pattern.
- Structured context such as hydration, fatigue, cannabis, alcohol, food state, preparation, privacy/interruption risk, mental state, and environment should qualify, explain, or contextualize those observations. Do not let context replace the core body/mechanics analysis.
- Do not lead recommendations with contextual variables unless repeated session evidence clearly shows they outweigh method response, anatomy, telemetry, climax/recovery mechanics, or direct session observations.
- Avoid overstating context as causal. Prefer "appears associated with", "may have shaped", "is repeatedly present in sessions where", or "could help explain this pattern".
- Be especially careful with alcohol: do not frame alcohol as beneficial, neutral, or performance-enhancing unless the evidence directly and repeatedly supports that narrow claim. If alcohol is present but hard to isolate from fatigue, cannabis, mood, or environment, say that clearly.
- Hydration, THC/cannabis, fatigue, preparation, and environment are important modifiers, but they are seasoning, not the steak. The profile should still primarily be about the person's observable arousal physiology, stimulation response, anatomy/device interaction, motion evidence, climax mechanics, and recovery behavior.
${SESSION_DATE_GROUNDING_RULE}
${MOTION_EVIDENCE_PRECEDENCE_RULE}
${PERSONALIZED_ANATOMY_OUTPUT_RULE}
${firstNameToneCue}

CRITICAL FOR TEXT-TO-SPEECH QUALITY:
- Write all times as words: "ten minutes and thirty seconds" not "10:30"
- Spell out all numbers as words (e.g., "ten beats per minute" not "10 bpm")
- Write in conversational, sentence-based prose with natural pauses
- Use short sentences and simple grammar optimized for audio readability
- Avoid jargon—explain concepts clearly as if speaking aloud
- Use commas and periods to create natural speech cadence
${profileContext}${journalContext}
SESSION DATA SUMMARY (${sessions.length} total sessions; compacted to preserve full coverage without exceeding rate limits):
${evidenceDigest}

SESSION-BY-SESSION EVIDENCE:
${sessionSummaries}

Generate a rich, holistic profile. Your job is NOT to restate what was already logged — the person already knows what they did. Instead, offer your own interpretations, inferences, hypotheses, and conclusions drawn FROM the data. Go beyond the surface. Make observations they may not have noticed themselves. Point out cross-session patterns, contradictions, and surprising findings. Be willing to form opinions when the evidence supports them, and calibrate certainty using the evidence rules above.

For this longitudinal profile, preserve the warm, personalized interpretive voice while keeping certainty honest:
- Repeated response patterns may be described with strong narrative confidence when telemetry, session behavior, and the person's notes point the same way.
- Mechanism-level explanations about nerves, hormones, tissue adaptation, anatomy, or psychology must stay qualified unless directly supported by the available evidence.
- When the person's own hypothesis appears in notes, identify it as their hypothesis or a plausible interpretation rather than silently upgrading it into fact.
- Recommendations should follow demonstrated session patterns first; avoid turning a single evocative session or an attractive theory into a firm protocol.
- When populated structured anatomical or functional mechanical profile fields are relevant, incorporate erect dimensions, glans or foreskin context, meatal or urethral dimensions, accommodation or device-fit observations, and functional response observations into the synthesis. Use them to deepen interpretation of supported session findings involving stimulation mechanics, fit, pressure distribution, sensitivity, device interaction, or repeated response patterns; do not force mention of measurements where unrelated or use them to invent causal mechanisms.

MECHANISTIC DISCIPLINE:
Describing repeated patterns is preferred over inventing internal mechanisms.
Allowed phrasing includes "your body repeatedly shows", "this pattern appears consistent with", and "your data suggests".
Use caution with autonomic nervous system explanations, cardiovascular gating claims, endocrine explanations, neurological localization, and muscle imbalance claims.
Mechanistic explanations should only be used when directly supported by strong repeated evidence or clearly framed as exploratory hypotheses.
Prefer pattern description over mechanistic storytelling.

PERSONALITY PROTECTION:
Do NOT flatten the narrative voice into sterile clinical reporting.
The person values emotionally resonant interpretation and psychologically meaningful synthesis.
The profiler should feel intelligent, warm, highly familiar, insightful, and human.
Avoid robotic medical documentation tone.
Strong interpretive phrasing is welcome when supported by repeated evidence.

PATTERN VS EXPLANATION CHECK:
Before presenting a conclusion, ask whether it describes what repeatedly happens or why you think it happens.
Descriptions of repeated patterns are preferred.
Explanations of why require caution and evidence-calibrated language.

SUBSTANCE INTERPRETATION:
User-reported effects of THC, alcohol, nicotine, or other modifiers should be treated as individualized observations unless objectively confirmed.
Do not convert the person's beliefs into universal physiological facts.
Prefer wording like "you consistently report improved recovery with THC" over "THC improves parasympathetic recovery".

CONFIDENT INTERPRETATION:
When a pattern is strongly repeated across telemetry, notes, interviews, and journal entries, confident narrative interpretation is appropriate.
Examples include "your body repeatedly builds in waves", "this has become a recognizable signature", and "your left foot serves as a reliable escalation marker" when the evidence supports them.
Do not weaken clearly supported repeated observations with excessive hedging.

Cover these areas:

1. AROUSAL PHYSIOLOGY: Interpret the shape and character of their arousal response — don't just describe the HR numbers. Prioritize repeated patterns in acceleration, plateau behavior, peaks, and recovery slope, then explain what those patterns may suggest only where the evidence earns it. Form a view on what type of physiological responder they appear to be without inventing hidden autonomic or cardiovascular mechanisms.

2. STIMULATION PROFILE: Don't list what methods they used — interpret what the outcomes reveal about their body's actual preferences. Which method combinations appear to produce synergistic effects vs. diminishing returns? What does the pattern of their best vs. worst sessions suggest about their sensitivity and saturation points?

3. CLIMAX & RECOVERY PATTERNS: Go beyond describing duration and volume — interpret the repeated shape of their climax and recovery data, the cues that reliably accompany release, and what recovery slope contributes to the pattern. Discuss neuromuscular, ejaculatory-threshold, autonomic, or refractory explanations only when directly supported or clearly framed as exploratory hypotheses.

4. CONTEXTUAL SENSITIVITIES: Identify contextual factors that repeatedly appear to modify the person's core physiology or session mechanics. Don't just list factors. Separate repeated associations from plausible modifiers, single-session anecdotes, and unproven causal explanations. Keep this section subordinate to the primary body/mechanics profile unless the repeated evidence clearly shows context is the dominant driver.

5. DISCOMFORT & PHYSIOLOGICAL EDGE CASES: Interpret what recurring discomfort or unusual sensations may suggest anatomically — consider urethral, prostatic, pelvic floor, and neurovascular context given their specific methods. Discuss tissue adaptation, nerve sensitization, or structural factors only as evidence-linked possibilities when the data supports that level of interpretation. Be specific, not generic.

6. BEHAVIORAL & AROUSAL TENDENCIES: Look for observable patterns in build style, pause/resume moments, event timelines, and the person's own subjective notes. Do not infer motives, anxiety, control strategies, or intentional edging unless explicitly logged. Focus on how observable behavior and physiology relate to outcomes.

7. PERSONAL OPTIMIZATION RECOMMENDATIONS: Give specific, useful recommendations — not generic advice. Lead with method, anatomy/device interaction, telemetry, climax/recovery mechanics, and direct session observations. Use contextual variables as supporting modifiers unless repeated evidence clearly shows they outweigh the body/mechanics pattern. Reference their actual data patterns and explain the physiological or behavioral reasoning behind each suggestion. Make the boldest recommendations only where repeated evidence earns them.

Be warm, direct, insightful, and willing to state conclusions when the evidence earns them. Ground everything in their data but go well beyond restating it.`,
      response_json_schema: {
        type: "object",
        properties: {
          profile_overview: { type: "string" },
          arousal_physiology: { type: "array", items: { type: "string" } },
          stimulation_profile: { type: "array", items: { type: "string" } },
          climax_and_recovery: { type: "array", items: { type: "string" } },
          contextual_sensitivities: { type: "array", items: { type: "string" } },
          discomfort_and_edge_cases: { type: "array", items: { type: "string" } },
          behavioral_tendencies: { type: "array", items: { type: "string" } },
          optimization_recommendations: { type: "array", items: { type: "string" } },
        },
        required: ["profile_overview", "arousal_physiology", "stimulation_profile", "climax_and_recovery", "contextual_sensitivities", "behavioral_tendencies", "optimization_recommendations"],
      },
      max_tokens: 8192,
    }, "AI Profiler: Comprehensive Profile", setJobStatus);

    const raw = typeof res === "string" ? JSON.parse(res) : res;
    const parsed = normalizeAIProfileResult(raw);
    if (!parsed?.profile_overview && !parsed?.arousal_physiology?.length) {
      throw new Error("Claude returned an empty profile response. Try again in a minute; the rate limit may still be cooling down.");
    }
    const storedResult = {
      ...parsed,
      _meta: buildProfileAIContentMeta(sessions, result?._meta),
    };
    setResult(storedResult);

    const nextArchive = await saveProfileResultWithArchive({
      resultKey: "result",
      archiveKey: "profile_result_archive",
      kind: "comprehensive_profile",
      label: "Comprehensive Physiological Profile",
      result: storedResult,
      sessionCount: sessions.length,
    });
    setArchive(nextArchive);
    } catch (err) {
      console.error("AI profile generation failed:", err);
      setError(aiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const SECTIONS = [
    { key: "arousal_physiology", label: "Arousal Physiology", icon: <Heart className="w-3.5 h-3.5" />, color: "hsl(var(--chart-3))" },
    { key: "stimulation_profile", label: "Stimulation Profile", icon: <Zap className="w-3.5 h-3.5" />, color: "hsl(var(--primary))" },
    { key: "climax_and_recovery", label: "Climax & Recovery", icon: <TrendingUp className="w-3.5 h-3.5" />, color: "hsl(var(--chart-2))" },
    { key: "contextual_sensitivities", label: "Contextual Sensitivities", icon: <Activity className="w-3.5 h-3.5" />, color: "hsl(var(--chart-4))" },
    { key: "discomfort_and_edge_cases", label: "Discomfort & Edge Cases", icon: <AlertCircle className="w-3.5 h-3.5" />, color: "hsl(var(--destructive))" },
    { key: "behavioral_tendencies", label: "Behavioral Tendencies", icon: <User className="w-3.5 h-3.5" />, color: "hsl(var(--accent))" },
    { key: "optimization_recommendations", label: "Optimization Recommendations", icon: <Lightbulb className="w-3.5 h-3.5" />, color: "hsl(var(--chart-1))" },
  ];

  // Build flat paragraph list for TTSReader
  const paras = [];
  const paraMeta = [];
  if (result) {
    if (result.profile_overview) { paras.push(result.profile_overview); paraMeta.push({ type: "overview" }); }
    for (const sec of SECTIONS) {
      for (const item of (result[sec.key] || [])) {
        paras.push(item);
        paraMeta.push({ type: "section", sec });
      }
    }
  }

  return (
    <SectionCard icon={<Brain className="w-4 h-4" />} title="Comprehensive Physiological Profile" color="hsl(var(--primary))" defaultCollapsed={true}>
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          AI-generated personal physiological & arousal profile based on all sessions, event timelines, and profile notes.
        </p>
        <Button size="sm" onClick={analyze} disabled={loading || evidenceLoading || sessions.length < 2} className="h-7 text-xs gap-1.5 shrink-0 ml-2">
          {loading
            ? <><span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />Profiling…</>
            : <><Brain className="w-3 h-3" />{result ? "Re-generate" : "Generate Profile"}</>}
        </Button>
      </div>

      {result && (
        <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
          <span>{result?._meta?.last_generated_at ? `Generated ${formatGeneratedAt(result._meta.last_generated_at)}` : "Generated time unavailable"}</span>
          <span>Source sessions: {result?._meta?.source_session_count ?? sessions.length}</span>
          <span>Motion evidence sessions: {result?._meta?.motion_evidence_session_count ?? summarizeMotionEvidenceCoverage(sessions).any}</span>
          {profileStale && (
            <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 font-semibold text-amber-300">
              May be stale - newer saved evidence exists
            </span>
          )}
        </div>
      )}

      {evidenceLoading && !result && (
        <p className="text-xs text-muted-foreground flex items-center gap-1.5">
          <span className="w-3 h-3 border-2 border-primary border-t-transparent rounded-full animate-spin" /> Loading session evidence in the background...
        </p>
      )}

      {!evidenceLoading && sessions.length < 2 && (
        <p className="text-xs text-muted-foreground flex items-center gap-1.5">
          <AlertCircle className="w-3.5 h-3.5" /> Need at least 2 sessions to generate a profile.
        </p>
      )}

      <CompactError message={error} />

      {loading && (
        <ProfilerJobStatus
          job={jobStatus}
          fallback="The full profile is running in the background…"
        />
      )}

      {!result && !loading && !evidenceLoading && sessions.length >= 2 && (
        <p className="text-xs text-muted-foreground">
          Click Generate Profile to create your comprehensive physiological and arousal profile. Uses Claude Sonnet.
        </p>
      )}

      {result && (
        <TTSReader
          sessionId="profiler_ai_profile"
          title="AI Physiological Profile"
          sourceGeneratedAt={result?._meta?.last_generated_at}
          paragraphs={paras}
          renderParagraph={(text, idx, isActive, _isBuffering, activeSentenceIdx, startFromSentence) => {
            const meta = paraMeta[idx];
            if (!meta) return null;

            if (meta.type === "overview") {
              return (
                <p className={`text-base font-medium leading-relaxed border-l-2 pl-3 py-1 transition-all duration-200 rounded-r-md ${isActive ? "border-primary bg-primary/10 text-foreground" : "border-primary/50 text-foreground"}`}>
                  {meta.displayLabel || text}
                </p>
              );
            }

            const { sec } = meta;
            // Check if first item in section → render section header
            const firstInSection = paras.findIndex((_, i) => paraMeta[i]?.type === "section" && paraMeta[i]?.sec?.key === sec.key) === idx;

            return (
              <div>
                {firstInSection && (
                  <p className="text-xs font-semibold flex items-center gap-1.5 mt-4 mb-1.5 pt-3 border-t border-border" style={{ color: sec.color }}>
                    {sec.icon}{sec.label}
                  </p>
                )}
                <li
                  className="text-sm pl-3 border-l-2 py-1 leading-relaxed list-none transition-all duration-200 rounded-r-md"
                  style={{
                    borderColor: isActive ? sec.color : sec.color + "55",
                    background: isActive ? sec.color + "18" : "transparent",
                    color: "hsl(var(--foreground))",
                  }}
                >
                  {renderSentenceHighlightedText(text, activeSentenceIdx, startFromSentence)}
                </li>
              </div>
            );
          }}
        />
      )}

      <ProfileArchiveList
        title="Comprehensive Profile Run Archive"
        archive={archive}
        currentResult={result}
        onViewRun={(archivedResult) => archivedResult && setResult(archivedResult)}
      />
    </SectionCard>
  );
}

function AnatomicalPhysiologicalProfilePanel({
  sessions,
  allTimelines = {},
  userProfile,
  profileLoading = false,
  evidenceLoading = false,
  timelineLoading = false,
}) {
  const [loading, setLoading] = useState(false);
  const [jobStatus, setJobStatus] = useState(null);
  const [result, setResult] = useState(null);
  const [archive, setArchive] = useState([]);
  const [error, setError] = useState("");
  const profileStale = isProfileAIContentStale(result, sessions);

  useEffect(() => {
    base44.entities.SessionClusterAnalysis.list("-updated_date", 1).then((rows) => {
      if (rows[0]?.anatomical_physiological_profile_result) {
        setResult(rows[0].anatomical_physiological_profile_result);
      }
      if (Array.isArray(rows[0]?.anatomical_physiological_profile_archive)) {
        setArchive(rows[0].anatomical_physiological_profile_archive);
      }
    });
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (evidenceLoading) return undefined;

    const reconnect = async () => {
      try {
        const activeData = await listBackgroundJobs({
          type: "ai_invoke",
          status: "queued,running",
          metaSource: "Profiler",
          limit: 12,
        });
        if (cancelled) return;
        let job = (activeData.jobs || []).find((item) => item.meta?.label === "AI Profiler: Anatomical & Physiological Profile");
        if (!job) {
          const completedData = await listBackgroundJobs({
            type: "ai_invoke",
            status: "complete",
            metaSource: "Profiler",
            limit: 12,
          });
          if (cancelled) return;
          job = (completedData.jobs || []).find((item) => item.meta?.label === "AI Profiler: Anatomical & Physiological Profile");
        }
        if (!job) return;
        if (job.status === "complete" && !isNewerCompletedJob(job, result)) return;

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
        if (!isNewerCompletedJob(completedJob, result)) return;

        const parsed = normalizeAnatomicalProfileResult(completedJob.result);
        if (!parsed?.overview) return;
        const storedResult = {
          ...parsed,
          _meta: buildProfileAIContentMeta(sessions, result?._meta, completedAt(completedJob)),
        };
        setResult(storedResult);
        const nextArchive = await saveProfileResultWithArchive({
          resultKey: "anatomical_physiological_profile_result",
          archiveKey: "anatomical_physiological_profile_archive",
          kind: "anatomical_physiological_profile",
          label: "Anatomical & Physiological Profile",
          result: storedResult,
          sessionCount: sessions.length,
        });
        if (!cancelled) setArchive(nextArchive);
      } catch (err) {
        if (!cancelled) console.warn("Anatomical physiological profile reconnect skipped:", err);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    reconnect();
    return () => {
      cancelled = true;
    };
  }, [evidenceLoading, result, sessions.length]);

  const analyze = async () => {
    setLoading(true);
    setResult(null);
    setError("");
    setJobStatus({
      status: "starting",
      progress: {
        phase: "building",
        current: 0,
        total: 3,
        message: "Preparing anatomical and physiological context for background synthesis...",
      },
    });

    try {
      const sortedSessions = [...sessions].sort((a, b) => new Date(b.date) - new Date(a.date));
      const evidenceDigest = naturalizeSpokenDates(buildProfileEvidenceDigest(sortedSessions));
      const sessionSummaries = sortedSessions.slice(0, 80).map(compactAnatomicalSessionLine).join("\n");
      const longitudinalHrvEvidence = buildLongitudinalHrvEvidence(sortedSessions, allTimelines);
      const groundingContext = buildAIGroundingContext(userProfile);
      const firstNameToneCue = buildOptionalFirstNameToneCue(userProfile, { prioritizeProfileTone: true });

      const raw = await runProfilerAIJob({
        model: "claude_sonnet_4_6",
        prompt: `You are producing an Anatomical & Physiological Profile for one person. Create a detailed, evidence-grounded synthesis using only populated saved profile fields and supported patterns in the session data. This is distinct from a narrative arousal profile: its purpose is to explain relevant constitutional, anatomical, functional-mechanical, and instrumentation context.

${groundingContext}
${SESSION_CONTEXT_GROUNDING_RULE}
${SESSION_DATE_GROUNDING_RULE}
${MOTION_EVIDENCE_PRECEDENCE_RULE}
${PERSONALIZED_ANATOMY_OUTPUT_RULE}
${firstNameToneCue}
${longitudinalHrvEvidence ? RR_HRV_INTERPRETATION_RULES : ""}

SYNTHESIS REQUIREMENTS:
- Begin with a compact whole-body overview, then expand only where the provided evidence supports detail.
- Write every part of the response directly to the person in second person, including the opening overview. Do not open with "Ben is," "the person is," "the user is," or any other third-person framing.
- Separate directly entered anatomical observations from repeated session-linked findings and from cautious interpretations.
- Consider constitutional/body habitus, cardiovascular/autonomic, respiratory, neurological/sensory, musculoskeletal/biomechanical, and endocrine/metabolic context only when those data were provided.
- When usable RR-derived HRV exists, use repeated within-session build, climax, or recovery changes to deepen the cardiovascular and autonomic context without treating session HRV as a resting baseline or diagnostic measure.
- When populated, integrate static resting or flaccid anatomy, static erect anatomy, dynamic transition findings, glans or foreskin context, meatal structure, urethral accommodation, fit or tolerance, pressure distribution, device interaction, instrumentation compatibility or limitations, and repeated functional response observations.
- Use anatomical dimensions analytically, such as when dynamic expansion, fit variability, accommodation, pressure distribution, stimulation mechanics, or session findings make them relevant. Do not recite measurements without purpose.
- Genital or pelvic detail is optional and must be proportional to its relevance in the entered data and session evidence.
- Do not invent unsupported anatomy or physiology, infer diagnoses, make deterministic mechanism claims, or produce erotic commentary.
- Explicitly identify limitations and missing data where they constrain interpretation.
- Write for natural spoken delivery as well as reading: use flowing complete sentences, avoid clipped data-dump phrasing, and retain all meaningful supported findings.
- Whenever referencing a session date, spell it out in natural narration (for example, "May 4, 2026"), never use ISO formatting such as "2026-05-04".

SESSION EVIDENCE SUMMARY (${sessions.length} sessions):
${evidenceDigest}

${longitudinalHrvEvidence ? `RR-DERIVED HRV EVIDENCE:
${JSON.stringify(longitudinalHrvEvidence, null, 2)}

Use this evidence in the cardiovascular and autonomic context only where it adds a supported within-session or repeated cross-session pattern. Do not force HRV into the synthesis when the quality, coverage, or number of sessions is insufficient.

` : ""}
SELECTED SESSION-BY-SESSION EVIDENCE:
${sessionSummaries || "No session evidence is available; rely only on populated profile entries."}

Write directly to the person in clear, clinically grounded language. Favor meaningful synthesis over measurement recital. Before returning, check the overview and every section for third-person references and rewrite them into natural "you" and "your" language.`,
        response_json_schema: {
          type: "object",
          properties: {
            overview: { type: "string" },
            constitutional_and_systemic_context: { type: "array", items: { type: "string" } },
            cardiovascular_and_autonomic_context: { type: "array", items: { type: "string" } },
            sensory_and_biomechanical_context: { type: "array", items: { type: "string" } },
            pelvic_and_external_anatomy: { type: "array", items: { type: "string" } },
            dynamic_anatomical_function: { type: "array", items: { type: "string" } },
            instrumentation_and_fit_findings: { type: "array", items: { type: "string" } },
            session_linked_interpretations: { type: "array", items: { type: "string" } },
            limitations_and_data_gaps: { type: "array", items: { type: "string" } },
          },
          required: ["overview", "limitations_and_data_gaps"],
        },
      }, "AI Profiler: Anatomical & Physiological Profile", setJobStatus);

      const parsed = normalizeAnatomicalProfileResult(typeof raw === "string" ? JSON.parse(raw) : raw);
      if (!parsed?.overview) throw new Error("Claude returned an empty anatomical and physiological profile.");
      const storedResult = {
        ...parsed,
        _meta: buildProfileAIContentMeta(sessions, result?._meta),
      };
      setResult(storedResult);
      const nextArchive = await saveProfileResultWithArchive({
        resultKey: "anatomical_physiological_profile_result",
        archiveKey: "anatomical_physiological_profile_archive",
        kind: "anatomical_physiological_profile",
        label: "Anatomical & Physiological Profile",
        result: storedResult,
        sessionCount: sessions.length,
      });
      setArchive(nextArchive);
    } catch (err) {
      console.error("Anatomical physiological profile generation failed:", err);
      setError(aiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const sections = [
    { key: "constitutional_and_systemic_context", label: "Constitutional & Systemic Context", color: "hsl(var(--primary))" },
    { key: "cardiovascular_and_autonomic_context", label: "Cardiovascular & Autonomic Context", color: "hsl(var(--chart-3))" },
    { key: "sensory_and_biomechanical_context", label: "Sensory & Biomechanical Context", color: "hsl(var(--chart-2))" },
    { key: "pelvic_and_external_anatomy", label: "Pelvic & External Anatomy", color: "hsl(var(--accent))" },
    { key: "dynamic_anatomical_function", label: "Dynamic Anatomical Function", color: "hsl(var(--chart-4))" },
    { key: "instrumentation_and_fit_findings", label: "Instrumentation & Fit", color: "hsl(var(--primary))" },
    { key: "session_linked_interpretations", label: "Session-Linked Interpretations", color: "hsl(var(--chart-3))" },
    { key: "limitations_and_data_gaps", label: "Limitations & Data Gaps", color: "hsl(var(--muted-foreground))" },
  ];

  const paragraphs = [];
  const paragraphMeta = [];
  if (result) {
    paragraphs.push(calmSpokenHeading("Anatomical and Physiological Profile"));
    paragraphMeta.push({ type: "title", color: "hsl(var(--chart-2))", displayLabel: "Anatomical and Physiological Profile" });
    if (result.overview) {
      paragraphs.push(naturalizeSpokenDates(result.overview));
      paragraphMeta.push({ type: "overview" });
    }
    for (const section of sections) {
      if ((result[section.key] || []).length) {
        paragraphs.push(calmSpokenHeading(section.label));
        paragraphMeta.push({ type: "section-title", section, displayLabel: section.label });
      }
      for (const finding of (result[section.key] || [])) {
        paragraphs.push(naturalizeSpokenDates(finding));
        paragraphMeta.push({ type: "section", section });
      }
    }
  }

  return (
    <SectionCard icon={<Activity className="w-4 h-4" />} title="Anatomical & Physiological Profile" color="hsl(var(--chart-2))" defaultCollapsed={true}>
      <div className="flex items-center justify-between gap-3">
        <p className="text-xs text-muted-foreground">
          Evidence-grounded anatomy, dynamic function, fit, and instrumentation synthesis from your optional profile data and supported session findings.
        </p>
        <Button size="sm" onClick={analyze} disabled={loading || profileLoading || evidenceLoading || timelineLoading || !userProfile} className="h-7 text-xs gap-1.5 shrink-0">
          {loading
            ? <><span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />Synthesizing...</>
            : <><Activity className="w-3 h-3" />{result ? "Re-generate" : "Generate A&P"}</>}
        </Button>
      </div>

      {result && (
        <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
          <span>{result?._meta?.last_generated_at ? `Generated ${formatGeneratedAt(result._meta.last_generated_at)}` : "Generated time unavailable"}</span>
          <span>Source sessions: {result?._meta?.source_session_count ?? sessions.length}</span>
          <span>Motion evidence sessions: {result?._meta?.motion_evidence_session_count ?? summarizeMotionEvidenceCoverage(sessions).any}</span>
          {profileStale && (
            <span className="rounded-full border border-amber-400/30 bg-amber-400/10 px-2 py-0.5 font-semibold text-amber-300">
              May be stale - newer saved evidence exists
            </span>
          )}
        </div>
      )}

      <CompactError message={error} />
      {loading && <ProfilerJobStatus job={jobStatus} fallback="The anatomical and physiological profile is running in the background..." />}
      {!result && !loading && profileLoading && (
        <p className="text-xs text-muted-foreground">Loading your saved profile context...</p>
      )}
      {!result && !loading && !profileLoading && (
        <p className="text-xs text-muted-foreground">
          Populate any relevant optional Profile fields, then generate this dedicated A&P synthesis. Unpopulated details will not be inferred.
        </p>
      )}
      {result && (
        <TTSReader
          sessionId="profiler_anatomical_physiological_profile"
          title="Anatomical and Physiological Profile"
          sourceGeneratedAt={result?._meta?.last_generated_at}
          paragraphs={paragraphs}
          renderParagraph={(text, idx, isActive, isBuffering, activeSentenceIdx, startFromSentence) => {
            const meta = paragraphMeta[idx];
            if (!meta) return null;

            if (meta.type === "title" || meta.type === "section-title") {
              const color = meta.section?.color || meta.color || "hsl(var(--chart-2))";
              return (
                <p
                  className="mt-4 border-t border-border pt-3 text-xs font-semibold transition-colors"
                  style={{
                    color,
                    background: isActive ? `${color}18` : "transparent",
                  }}
                >
                  {meta.displayLabel || text}
                </p>
              );
            }

            if (meta.type === "overview") {
              return (
                <p
                  className="text-base font-medium leading-relaxed border-l-2 pl-3 py-1 transition-all duration-200 rounded-r-md text-foreground"
                  style={{
                    borderColor: isActive ? "hsl(var(--chart-2))" : "hsl(var(--chart-2) / 0.6)",
                    background: isActive ? "hsl(var(--chart-2) / 0.1)" : "transparent",
                  }}
                >
                  {renderSentenceHighlightedText(text, activeSentenceIdx, startFromSentence)}
                </p>
              );
            }

            const { section } = meta;

            return (
              <div>
                <p
                  className="border-l-2 pl-3 py-1 text-sm leading-relaxed transition-all duration-200 rounded-r-md"
                  style={{
                    borderColor: isActive ? section.color : section.color + "66",
                    background: isActive ? section.color + "18" : "transparent",
                  }}
                >
                  {renderSentenceHighlightedText(text, activeSentenceIdx, startFromSentence)}
                </p>
              </div>
            );
          }}
        />
      )}

      <ProfileArchiveList
        title="A&P Profile Run Archive"
        archive={archive}
        currentResult={result}
        onViewRun={(archivedResult) => archivedResult && setResult(archivedResult)}
      />
    </SectionCard>
  );
}

function NearClimaxPanel({ sessions, allTimelines, userProfile, timelineLoading = false }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [eventStats, setEventStats] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    base44.entities.SessionClusterAnalysis.list("-updated_date", 1).then((rows) => {
      if (rows[0]?.near_climax_result) {
        setResult(rows[0].near_climax_result);
      }
    });
  }, []);

  const analyze = async () => {
    setLoading(true);
    setResult(null);
    setError("");

    try {
    // Detect events across all sessions with HR data
    const sessionEvents = [];
    for (const session of sessions) {
      const rows = allTimelines[session.id] || [];
      if (rows.length < 10) continue;
      const events = detectNearClimaxEvents(rows, session.climax_offset_s, session.pre_climax_offset_s, session.event_timeline || []);
      if (events.length > 0) {
        sessionEvents.push({
          date: sessionDateKey(session.date),
          session_duration_s: Math.round(Math.max(...rows.map((r) => Number(r.time_offset_s)))),
          climax_offset_s: session.climax_offset_s,
          methods: session.methods,
          intensity: session.intensity,
          near_climax_events: events.slice(0, 4),
          event_count: events.length,
          total_time_in_events_s: Math.round(events.reduce((a, e) => a + e.duration_s, 0)),
          avg_rise_bpm: Math.round(events.reduce((a, e) => a + e.rise_bpm, 0) / events.length),
          max_peak_hr: Math.max(...events.map((e) => e.peak_hr))
        });
      }
    }

    const totalEvents = sessionEvents.reduce((a, s) => a + s.event_count, 0);
    const stats = {
      sessions_with_events: sessionEvents.length,
      total_events: totalEvents,
      avg_events_per_session: sessionEvents.length ? (totalEvents / sessionEvents.length).toFixed(1) : 0
    };
    setEventStats(stats);
    const groundingContext = buildAIGroundingContext(userProfile);

    const res = await base44.integrations.Core.InvokeLLM({
      model: "claude_sonnet_4_6",
      prompt: `You are a physiological research assistant analyzing near-climax events detected in heart rate data from sexual response sessions. Write directly to the person — use "you" and "your" throughout, as if speaking to them personally.

${groundingContext}
${SESSION_DATE_GROUNDING_RULE}

CRITICAL FOR TEXT-TO-SPEECH QUALITY:
- Write all times as words: "ten minutes and thirty seconds" not "10:30"
- Spell out all numbers as words (e.g., "ten beats per minute" not "10 bpm")
- Write in conversational, sentence-based prose with natural pauses
- Use short sentences and simple grammar optimized for audio readability

A "near-climax event" is defined as: an erratic yet somewhat sustained climb in heart rate (eight or more beats per minute rise within forty-five seconds), followed by a notable drop — similar in shape to the climax cascade (ever-increasing HR with an apex and fall) but not as sustained. These events occur outside of the actual climax window.

Detected event data across ${sessionEvents.length} sessions (out of ${sessions.length} total):
${sessionEvents.slice(0, 12).map((s) => `${fmtNarrativeDate(s.date)}: ${s.event_count} events, ${fmtSec(s.total_time_in_events_s)} total, avg rise ${s.avg_rise_bpm} bpm, max peak ${s.max_peak_hr} bpm, methods ${(s.methods || []).join(", ") || "none"}, climax ${fmtSec(s.climax_offset_s)}. Events: ${s.near_climax_events.map((e) => `${fmtSec(e.start_offset_s)}-${fmtSec(e.end_offset_s)}, peak ${e.peak_hr}, rise ${e.rise_bpm}, confidence ${e.confidence}`).join(" | ")}`).join("\n")}

Provide a rich, interpretive narrative analysis. Focus on:
1. What these events physiologically represent for you — are they arousal plateaus, stimulation intensity peaks, parasympathetic interruptions, explicitly logged arousal control, or something else?
2. How frequently they occur and what that suggests about your physiological response pattern.
3. Which session contexts (methods, duration, time-in-session) seem to trigger more of these events for you.
4. What role they likely play in your overall arousal arc — do they precede stronger or weaker climax events for you?
5. Recommendations for how you can leverage or manage these events to optimize your session outcomes.

Be interpretive, insightful, and speak directly to the person. Reference specific sessions where notable.`,
      response_json_schema: {
        type: "object",
        properties: {
          summary: { type: "string" },
          physiological_interpretation: { type: "string" },
          pattern_analysis: { type: "array", items: { type: "string" } },
          contextual_triggers: { type: "array", items: { type: "string" } },
          role_in_arousal_arc: { type: "string" },
          recommendations: { type: "array", items: { type: "string" } }
        },
        required: ["summary", "physiological_interpretation", "pattern_analysis", "contextual_triggers", "role_in_arousal_arc", "recommendations"]
      }
    });

    const raw = typeof res === "string" ? JSON.parse(res) : res;
    const parsed = raw?.response ?? raw;
    setResult(parsed);

    // Save to entity
    const existing = await base44.entities.SessionClusterAnalysis.list("-updated_date", 1);
    if (existing[0]) {
      await base44.entities.SessionClusterAnalysis.update(existing[0].id, { near_climax_result: { ...parsed, _stats: stats, _session_events: sessionEvents } });
    } else {
      await base44.entities.SessionClusterAnalysis.create({ near_climax_result: { ...parsed, _stats: stats, _session_events: sessionEvents } });
    }
    } catch (err) {
      console.error("Near-climax analysis failed:", err);
      setError(aiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const savedStats = result?._stats;
  const savedSessionEvents = result?._session_events;
  const displayStats = eventStats || savedStats;
  const displaySessionEvents = savedSessionEvents;

  return (
    <SectionCard icon={<Zap className="w-4 h-4" />} title="Near-Climax Event Analysis" color="hsl(var(--chart-3))" defaultCollapsed={true}>
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">Detects erratic HR spikes & reversals that resemble — but don't complete — a climax cascade.</p>
        <Button size="sm" onClick={analyze} disabled={loading || timelineLoading} className="h-7 text-xs gap-1.5 shrink-0">
          {loading ?
            <><span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />Analyzing…</> :
            <><Brain className="w-3 h-3" />{result ? "Re-run" : "Analyze"}</>}
        </Button>
      </div>

      {timelineLoading && !result && (
        <p className="text-xs text-muted-foreground">Loading heart-rate timelines for event analysis...</p>
      )}

      <CompactError message={error} />

      {displayStats &&
      <div className="grid grid-cols-3 gap-2">
          {[
        ["Sessions w/ Events", displayStats.sessions_with_events],
        ["Total Events", displayStats.total_events],
        ["Avg per Session", displayStats.avg_events_per_session]].
        map(([l, v]) =>
        <div key={l} className="bg-muted/50 rounded-lg p-2 text-center">
              <p className="text-lg font-bold font-mono">{v}</p>
              <p className="text-[9px] text-muted-foreground">{l}</p>
            </div>
        )}
        </div>
      }

      {displaySessionEvents?.length > 0 &&
      <div className="space-y-1.5">
          <p className="text-[10px] text-muted-foreground uppercase font-semibold">Per Session</p>
          {displaySessionEvents.map((s, i) =>
        <div key={i} className="flex flex-wrap items-center gap-2 text-[10px]">
              <span className="font-mono text-muted-foreground w-14 shrink-0">{s.date}</span>
              <Badge variant="outline" className="text-[9px] h-4 px-1">{s.event_count} events</Badge>
              <Badge variant="outline" className="text-[9px] h-4 px-1">{fmtSec(s.total_time_in_events_s)} total</Badge>
              <Badge variant="outline" className="text-[9px] h-4 px-1">+{s.avg_rise_bpm} bpm avg rise</Badge>
            </div>
        )}
        </div>
      }

      {result && (() => {
        const SECTIONS = [
          { key: "physiological_interpretation", label: "Physiological Interpretation", single: true, color: "hsl(var(--chart-3))" },
          { key: "pattern_analysis", label: "Pattern Analysis", color: "hsl(var(--primary))" },
          { key: "contextual_triggers", label: "Contextual Triggers", color: "hsl(var(--chart-4))" },
          { key: "role_in_arousal_arc", label: "Role in Arousal Arc", single: true, color: "hsl(var(--chart-2))" },
          { key: "recommendations", label: "Recommendations", color: "hsl(var(--accent))" },
        ];

        const paras = [];
        const paraMeta = [];
        if (result.summary) { paras.push(result.summary); paraMeta.push({ type: "summary" }); }
        for (const sec of SECTIONS) {
          if (sec.single) {
            if (result[sec.key]) { paras.push(result[sec.key]); paraMeta.push({ type: "section", sec, first: true }); }
          } else {
            (result[sec.key] || []).forEach((item, itemIdx) => {
              paras.push(item);
              paraMeta.push({ type: "section", sec, first: itemIdx === 0 });
            });
          }
        }

        return (
          <AIOutputReader
            sessionId="profiler_near_climax"
            title="Near-Climax Event Analysis"
            paragraphs={paras}
            summaryColor="hsl(var(--chart-3))"
            paragraphMeta={paraMeta}
          />
        );
      })()}
    </SectionCard>);

}

function StimulationMethodsPanel({ sessions, userProfile, evidenceLoading = false }) {
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [error, setError] = useState("");

  useEffect(() => {
    base44.entities.SessionClusterAnalysis.list("-updated_date", 1).then((rows) => {
      if (rows[0]?.stimulation_methods_result) setResult(rows[0].stimulation_methods_result);
    });
  }, []);

  const analyze = async () => {
    setLoading(true);
    setResult(null);
    setError("");

    try {
    // Build per-method aggregates
    const methodMap = {};
    for (const s of sessions) {
      const methods = [...(s.methods || []), ...(s.custom_methods || [])];
      for (const m of methods) {
        if (!methodMap[m]) methodMap[m] = [];
        methodMap[m].push(s);
      }
    }

    // Compute quick stats per method
    const methodStats = Object.entries(methodMap).map(([method, sessionList]) => {
      const withClimax = sessionList.filter(s => !s.no_climax);
      const avg = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length * 10) / 10 : null;
      const examples = [...sessionList]
        .sort((a, b) => ((b.satisfaction || 0) - (a.satisfaction || 0)) || ((b.intensity || 0) - (a.intensity || 0)))
        .slice(0, 4)
        .map(compactSessionLine);
      return {
        method,
        session_count: sessionList.length,
        climax_rate_pct: sessionList.length ? Math.round((withClimax.length / sessionList.length) * 100) : 0,
        avg_intensity: avg(sessionList.map(s => s.intensity).filter(Boolean)),
        avg_satisfaction: avg(sessionList.map(s => s.satisfaction).filter(Boolean)),
        avg_build_quality: avg(sessionList.map(s => s.build_quality).filter(Boolean)),
        avg_max_hr: avg(sessionList.map(s => s.max_hr).filter(Boolean)),
        avg_hr_at_climax: avg(withClimax.map(s => s.hr_at_climax).filter(Boolean)),
        discomfort_rate_pct: Math.round((sessionList.filter(s => s.discomfort_entries?.length).length / sessionList.length) * 100),
        common_combos: [...new Set(sessionList.flatMap(s => [...(s.methods || []), ...(s.custom_methods || [])].filter(x => x !== method)))].slice(0, 5),
        examples,
      };
    }).sort((a, b) => b.session_count - a.session_count);

    const profileContext = userProfile ? `USER PROFILE: Arousal style: ${userProfile.arousal_response_style || "—"} | Preferred stimulation: ${(userProfile.preferred_stimulation || []).join(", ") || "—"} | Climax sensitivity: ${userProfile.climax_sensitivity || "—"} | Arousal notes: ${userProfile.arousal_notes || "none"}` : "";
    const groundingContext = buildAIGroundingContext(userProfile);

    const res = await base44.integrations.Core.InvokeLLM({
      model: "claude_sonnet_4_6",
      prompt: `You are a physiological research analyst specializing in sexual response and stimulation science. Analyze how different stimulation methods affect this person's sensations and physiology based on their session data. Write directly to the person — use "you" and "your" throughout.

${groundingContext}

CRITICAL FOR TEXT-TO-SPEECH QUALITY:
- Write all times as words: "ten minutes" not "10m"
- Spell out all numbers as words (e.g., "eight out of ten" not "8/10", "seventy-two beats per minute" not "72 bpm")
- Write in conversational prose with natural pauses — no bullet points or markdown
- Short sentences optimized for audio readability
${profileContext}

METHOD PERFORMANCE DATA (${sessions.length} sessions across ${methodStats.length} methods):
${methodStats.map((m) => [
  `${m.method}: ${m.session_count} sessions, ${m.climax_rate_pct}% climax, avg intensity ${m.avg_intensity ?? "?"}, avg satisfaction ${m.avg_satisfaction ?? "?"}, avg build ${m.avg_build_quality ?? "?"}, avg max HR ${m.avg_max_hr ?? "?"}, discomfort ${m.discomfort_rate_pct}%, common combos ${m.common_combos.join(", ") || "none"}.`,
  `Best examples: ${m.examples.join(" || ")}`,
].join("\n")).join("\n\n")}

Provide a deep, interpretive analysis. Do NOT simply restate the numbers — interpret what they reveal about this person's physiology, nerve response, and arousal dynamics. Be direct, opinionated, and specific.

Cover these areas:
1. METHOD EFFECTIVENESS PROFILE: For each method with meaningful data, form a clear opinion on its role — primary driver, arousal amplifier, or plateau extender? Rank them by their apparent physiological impact, not just by session count.
2. PHYSIOLOGICAL EFFECTS BY METHOD: How does each method seem to engage different physiological pathways? Reference HR patterns, build quality, and climax metrics. Which methods drive the strongest autonomic activation? Which tend toward sensory saturation?
3. COMBINATION EFFECTS: What method combinations appear in the best sessions vs. worst? Are there synergistic pairings you can identify from the data? Are any combinations associated with discomfort or diminishing returns?
4. AROUSAL & CLIMAX FINDINGS: Across all methods, what patterns emerge about how this person's body responds? Note anything surprising — unexpected correlations, methods that seem to punch above their weight, or methods associated with no-climax sessions.
5. DISCOMFORT & SENSITIVITY PATTERNS: Which methods correlate with discomfort entries and unusual sensations? What does this suggest about tissue sensitivity, nerve thresholds, or technique factors?
6. PERSONALIZED RECOMMENDATIONS: Give specific, actionable suggestions based on this exact data. Be bold and direct.

Each section should be 2-4 sentences of flowing, TTS-ready prose.`,
      response_json_schema: {
        type: "object",
        properties: {
          overview: { type: "string" },
          method_effectiveness: { type: "array", items: { type: "string" } },
          physiological_effects: { type: "array", items: { type: "string" } },
          combination_effects: { type: "array", items: { type: "string" } },
          arousal_and_climax_findings: { type: "array", items: { type: "string" } },
          discomfort_and_sensitivity: { type: "array", items: { type: "string" } },
          recommendations: { type: "array", items: { type: "string" } },
        },
        required: ["overview", "method_effectiveness", "physiological_effects", "combination_effects", "arousal_and_climax_findings", "recommendations"],
      },
    });

    const raw = typeof res === "string" ? JSON.parse(res) : res;
    const parsed = { ...raw?.response ?? raw, _method_stats: methodStats.map(m => ({ method: m.method, session_count: m.session_count, climax_rate_pct: m.climax_rate_pct, avg_satisfaction: m.avg_satisfaction, avg_intensity: m.avg_intensity, discomfort_rate_pct: m.discomfort_rate_pct })) };
    setResult(parsed);

    const existing = await base44.entities.SessionClusterAnalysis.list("-updated_date", 1);
    if (existing[0]) {
      await base44.entities.SessionClusterAnalysis.update(existing[0].id, { stimulation_methods_result: parsed });
    } else {
      await base44.entities.SessionClusterAnalysis.create({ stimulation_methods_result: parsed });
    }
    } catch (err) {
      console.error("Stimulation methods analysis failed:", err);
      setError(aiErrorMessage(err));
    } finally {
      setLoading(false);
    }
  };

  const SECTIONS = [
    { key: "method_effectiveness", label: "Method Effectiveness", color: "hsl(var(--primary))" },
    { key: "physiological_effects", label: "Physiological Effects", color: "hsl(var(--chart-3))" },
    { key: "combination_effects", label: "Combination Effects", color: "hsl(var(--chart-2))" },
    { key: "arousal_and_climax_findings", label: "Arousal & Climax Findings", color: "hsl(var(--chart-4))" },
    { key: "discomfort_and_sensitivity", label: "Discomfort & Sensitivity", color: "hsl(var(--destructive))" },
    { key: "recommendations", label: "Recommendations", color: "hsl(var(--accent))" },
  ];

  const methodStats = result?._method_stats || [];

  const paras = [];
  const paraMeta = [];
  if (result) {
    if (result.overview) { paras.push(result.overview); paraMeta.push({ type: "overview" }); }
    for (const sec of SECTIONS) {
      (result[sec.key] || []).forEach((item, itemIdx) => {
        paras.push(item);
        paraMeta.push({ type: "section", sec, first: itemIdx === 0 });
      });
    }
  }

  return (
    <SectionCard icon={<Zap className="w-4 h-4" />} title="Stimulation Methods Analysis" color="hsl(var(--primary))" defaultCollapsed={true}>
      <div className="flex items-center justify-between">
        <p className="text-xs text-muted-foreground">
          How each stimulation method affects your physiology, arousal, and climax outcomes across sessions.
        </p>
        <Button size="sm" onClick={analyze} disabled={loading || evidenceLoading || sessions.length < 2} className="h-7 text-xs gap-1.5 shrink-0 ml-2">
          {loading
            ? <><span className="w-3 h-3 border-2 border-white border-t-transparent rounded-full animate-spin" />Analyzing…</>
            : <><Brain className="w-3 h-3" />{result ? "Re-generate" : "Analyze Methods"}</>}
        </Button>
      </div>

      {evidenceLoading && !result && (
        <p className="text-xs text-muted-foreground">Loading session evidence for method comparison...</p>
      )}

      {!evidenceLoading && sessions.length < 2 && (
        <p className="text-xs text-muted-foreground flex items-center gap-1.5">
          <AlertCircle className="w-3.5 h-3.5" /> Need at least 2 sessions to analyze.
        </p>
      )}

      {/* Method stats grid */}
      {methodStats.length > 0 && (
        <div className="space-y-2">
          <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Method Overview</p>
          <div className="grid gap-2">
            {methodStats.map((m) => (
              <div key={m.method} className="flex flex-wrap items-center gap-2 bg-muted/40 rounded-lg px-3 py-2">
                <span className="text-xs font-semibold text-foreground min-w-[120px]">{m.method}</span>
                <Badge variant="outline" className="text-[9px] h-4 px-1">{m.session_count} sessions</Badge>
                <Badge variant="outline" className="text-[9px] h-4 px-1">{m.climax_rate_pct}% climax</Badge>
                {m.avg_satisfaction != null && <Badge variant="outline" className="text-[9px] h-4 px-1">sat {m.avg_satisfaction}/10</Badge>}
                {m.avg_intensity != null && <Badge variant="outline" className="text-[9px] h-4 px-1">int {m.avg_intensity}/10</Badge>}
                {m.discomfort_rate_pct > 0 && <Badge variant="outline" className="text-[9px] h-4 px-1 text-destructive border-destructive/40">{m.discomfort_rate_pct}% discomfort</Badge>}
              </div>
            ))}
          </div>
        </div>
      )}

      {!result && !loading && !evidenceLoading && sessions.length >= 2 && (
        <p className="text-xs text-muted-foreground">Click Analyze Methods to generate a deep physiological interpretation of each stimulation method. Uses Claude Sonnet.</p>
      )}

      <CompactError message={error} />

      {result && (
        <AIOutputReader
          sessionId="profiler_stim_methods"
          title="Stimulation Methods Analysis"
          paragraphs={paras}
          paragraphMeta={paraMeta}
        />
      )}
    </SectionCard>
  );
}

// ── Main Page ──────────────────────────────────────────────────────────────────

export default function Profiler() {
  const [sessions, setSessions] = useState([]);
  const [allTimelines, setAllTimelines] = useState({});
  const [userProfile, setUserProfile] = useState(null);
  const [journals, setJournals] = useState([]);
  const [sessionEvidenceLoading, setSessionEvidenceLoading] = useState(true);
  const [timelineLoading, setTimelineLoading] = useState(true);
  const [profileContextLoading, setProfileContextLoading] = useState(true);
  const [loadError, setLoadError] = useState("");
  const [refreshingEvidence, setRefreshingEvidence] = useState(false);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setSessionEvidenceLoading(true);
    setTimelineLoading(true);
    setLoadError("");
    setAllTimelines({});

    const loadSessionsAndTimelines = async () => {
      try {
        const all = await base44.entities.Session.list("-date", 300);
        if (cancelled) return;
        setSessions(all);
        setSessionEvidenceLoading(false);

        // HR timelines are useful for secondary analysis, but should never block the saved profile UI.
        const withData = all.filter((session) => session.climax_offset_s != null || session.avg_hr != null);
        const BATCH = 5;
        for (let i = 0; i < withData.length; i += BATCH) {
          const chunk = withData.slice(i, i + BATCH);
          const results = await Promise.all(
            chunk.map((session) =>
              base44.entities.HeartRateTimeline.filter({ session: session.id }, "time_offset_s", 5000).then((rows) => [session.id, rows])
            )
          );
          if (cancelled) return;
          setAllTimelines((current) => {
            const next = { ...current };
            results.forEach(([sessionId, rows]) => {
              if (rows.length > 0) next[sessionId] = rows;
            });
            return next;
          });
        }
      } catch (error) {
        if (!cancelled) {
          setLoadError(error?.message || "Could not load current profiler evidence.");
          setSessionEvidenceLoading(false);
        }
      } finally {
        if (!cancelled) setTimelineLoading(false);
      }
    };

    loadSessionsAndTimelines();
    return () => {
      cancelled = true;
    };
  }, [loadAttempt]);

  useEffect(() => {
    let cancelled = false;
    setProfileContextLoading(true);
    base44.auth.me()
      .then((me) => {
        if (!cancelled) setUserProfile(me);
      })
      .catch(() => {
        if (!cancelled) setUserProfile(null);
      })
      .finally(() => {
        if (!cancelled) setProfileContextLoading(false);
      });
    base44.entities.Journal.list("-session_date", 300)
      .then((rows) => {
        if (!cancelled) setJournals(rows);
      })
      .catch(() => {
        if (!cancelled) setJournals([]);
      });
    return () => {
      cancelled = true;
    };
  }, [loadAttempt]);

  const refreshEvidence = async () => {
    setRefreshingEvidence(true);
    setLoadError("");
    try {
      const all = await base44.entities.Session.list("-date", 300);
      setSessions(all);
    } catch (error) {
      setLoadError(error?.message || "Could not refresh current profiler evidence.");
    } finally {
      setRefreshingEvidence(false);
    }
  };

  return (
    <div className="px-4 py-6 pb-24 space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">AI Profiler</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            {sessionEvidenceLoading
              ? "Loading saved session evidence..."
              : `${sessions.length} sessions · ${timelineLoading ? "loading HR timelines" : `${Object.keys(allTimelines).length} with HR data`} · ${summarizeMotionEvidenceCoverage(sessions).any} with motion evidence`}
          </p>
        </div>
        <Button size="sm" variant="outline" onClick={refreshEvidence} disabled={refreshingEvidence} className="gap-1.5 text-xs">
          <RefreshCw className={`h-3.5 w-3.5 ${refreshingEvidence ? "animate-spin" : ""}`} />
          {refreshingEvidence ? "Refreshing evidence..." : "Refresh evidence"}
        </Button>
      </div>

      {loadError && (
        <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3">
          <p className="text-sm text-destructive">{loadError}</p>
          <Button size="sm" variant="outline" onClick={() => setLoadAttempt((attempt) => attempt + 1)} className="h-8 text-xs">
            Retry loading evidence
          </Button>
        </div>
      )}

      <AIProfilePanel sessions={sessions} userProfile={userProfile} journals={journals} evidenceLoading={sessionEvidenceLoading} />
      <AnatomicalPhysiologicalProfilePanel
        sessions={sessions}
        allTimelines={allTimelines}
        userProfile={userProfile}
        profileLoading={profileContextLoading}
        evidenceLoading={sessionEvidenceLoading}
        timelineLoading={timelineLoading}
      />
      <ProfileImageReviewPanel
        config={HEAD_TO_TOE_IMAGE_REVIEW_CONFIG}
        sessions={sessions}
        userProfile={userProfile}
        profileLoading={profileContextLoading}
        evidenceLoading={sessionEvidenceLoading}
      />
      <ProfileImageReviewPanel
        config={PELVIC_GENITAL_IMAGE_REVIEW_CONFIG}
        sessions={sessions}
        userProfile={userProfile}
        profileLoading={profileContextLoading}
        evidenceLoading={sessionEvidenceLoading}
      />
      <StimulationMethodsPanel sessions={sessions} userProfile={userProfile} evidenceLoading={sessionEvidenceLoading} />
      <NearClimaxPanel sessions={sessions} allTimelines={allTimelines} userProfile={userProfile} timelineLoading={timelineLoading} />
    </div>
  );
}
