import { sessionContextEvidenceItems, sessionContextEvidenceText, structuredSessionContextForAI } from "./sessionContext.js";
import { buildSessionVideoPassDigest, buildSessionVisualEvidenceDigest, normalizeSessionVideoPassFindings } from "./visualEvidence.js";
import { getMotionEvidenceDigest, getMotionEvidenceSummary } from "../utils/sessionMotionEvidence.js";
import { formatSecondsAsWords, repairAITextBlocks, repairCharacterSplitParagraph } from "../utils/aiTextRepair.js";
import { buildSessionHrvEvidence } from "../utils/hrvEvidence.js";

export const SESSION_ANALYSIS_SECTION_KEYS = [
  "executive_summary",
  "chronological_deep_dive",
  "motion_evidence_interpretation",
  "telemetry_interpretation",
  "emg_analysis",
  "patterns_hypotheses",
  "recommendations_experiments",
  "limitations",
  "provenance_summary",
];

export const CLAIM_TYPES = [
  "user_logged_context",
  "visual_evidence",
  "telemetry_evidence",
  "hrv_interpretation",
  "emg_evidence",
  "profile_context",
  "hypothesis",
  "limitation",
];

export const SARAH_SESSION_ANALYSIS_SCHEMA = {
  type: "object",
  properties: {
    executive_summary: { type: "string" },
    chronological_deep_dive: {
      type: "array",
      items: {
        type: "object",
        properties: {
          time_range: { type: "string" },
          paragraph: { type: "string" },
          evidence_refs: { type: "array", items: { type: "string" } },
          claim_types: { type: "array", items: { type: "string", enum: CLAIM_TYPES } },
        },
        required: ["time_range", "paragraph", "evidence_refs", "claim_types"],
      },
    },
    motion_evidence_interpretation: sectionArraySchema(),
    telemetry_interpretation: sectionArraySchema(),
    emg_analysis: sectionArraySchema(),
    patterns_hypotheses: sectionArraySchema(),
    recommendations_experiments: sectionArraySchema(),
    limitations: sectionArraySchema(),
    provenance_summary: sectionArraySchema(),
  },
  required: SESSION_ANALYSIS_SECTION_KEYS,
};

function sectionArraySchema() {
  return {
    type: "array",
    items: {
      type: "object",
      properties: {
        paragraph: { type: "string" },
        evidence_refs: { type: "array", items: { type: "string" } },
        claim_types: { type: "array", items: { type: "string", enum: CLAIM_TYPES } },
      },
      required: ["paragraph", "evidence_refs", "claim_types"],
    },
  };
}

function numberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function compactText(value, max = 900) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

function clockTime(value) {
  const total = Math.max(0, Math.round(Number(value) || 0));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function sentenceJoin(parts = []) {
  return parts.filter(Boolean).join(" ");
}

function cleanSentence(text) {
  return String(text || "").replace(/\s+/g, " ").trim().replace(/[.。]+$/, "");
}

function repairEventNotePersona(text) {
  return repairSarahDirectAddress(cleanSentence(text))
    .replace(/^Subject visibly begins\b/i, "You visibly begin")
    .replace(/^Subject fully exits\b/i, "You fully exit")
    .replace(/^Subject exits\b/i, "You exit")
    .replace(/^Subject supine\b/i, "You are supine")
    .replace(/^Subject\b/i, "You");
}

function repairSarahDirectAddress(text) {
  if (typeof text !== "string") return text;
  return text
    .replace(/\b[Tt]he user's\b/g, (match) => match[0] === "T" ? "Your" : "your")
    .replace(/\b[Tt]he user\b/g, (match) => match[0] === "T" ? "You" : "you")
    .replace(/\b[Tt]his user's\b/g, (match) => match[0] === "T" ? "Your" : "your")
    .replace(/\b[Tt]his user\b/g, (match) => match[0] === "T" ? "You" : "you")
    .replace(/\b[Tt]he subject'?s\b/g, (match) => match[0] === "T" ? "Your" : "your")
    .replace(/\b[Tt]he subject\b/g, (match) => match[0] === "T" ? "You" : "you")
    .replace(/\b[Tt]he individual'?s\b/g, (match) => match[0] === "T" ? "Your" : "your")
    .replace(/\b[Tt]he individual\b/g, (match) => match[0] === "T" ? "You" : "you")
    .replace(/\b[Tt]he patient'?s\b/g, (match) => match[0] === "T" ? "Your" : "your")
    .replace(/\b[Tt]he patient\b/g, (match) => match[0] === "T" ? "You" : "you")
    .replace(/\byou is\b/g, "you are")
    .replace(/\bYou is\b/g, "You are")
    .replace(/\byou was\b/g, "you were")
    .replace(/\bYou was\b/g, "You were")
    .replace(/\byou has\b/g, "you have")
    .replace(/\bYou has\b/g, "You have");
}

function repairSarahParagraph(text, { repairDetachedPersona = false } = {}) {
  const repaired = repairCharacterSplitParagraph(String(text || "").trim());
  return repairDetachedPersona ? repairSarahDirectAddress(repaired) : repaired;
}

function packetEvidenceText(packet) {
  return JSON.stringify(packet || {}).toLowerCase();
}

function hasAcceptedVideoPassEventNotes(packet = null) {
  const count = Number(packet?.counts?.ai_video_pass_event_notes || 0);
  if (count > 0) return true;
  return Array.isArray(packet?.session_timeline) && packet.session_timeline.some((event) => (
    event?.source === "ai_video_pass" || event?.ai_annotation?.source
  ));
}

function unsupportedClaimReason(paragraph, evidenceText, packet = null) {
  const text = String(paragraph || "").toLowerCase();
  if (!text) return "";
  const evidence = String(evidenceText || "");
  const sessionHasClimax = packet?.session_metadata?.phase_markers_s?.climax != null;
  const hasVisualCards = Boolean(packet?.visual_evidence?.saved_sarah_video_cards_count || packet?.visual_evidence?.local_annotation_cards_count);
  const hasVisualEventNotes = hasAcceptedVideoPassEventNotes(packet);
  const hasVisualGrounding = hasVisualCards || hasVisualEventNotes;

  const guardedClaims = [
    { pattern: /\bprostate massage\b|\bperineum pressure\b/i, terms: ["prostate", "perineum"], reason: "prostate or perineal technique was not present in the evidence packet" },
    { pattern: /\bcircular pattern\b/i, terms: ["circular"], reason: "circular hand motion was not present in the evidence packet" },
    { pattern: /\bnear[- ]climax\b/i, terms: ["near-climax", "near climax", "approach-and-withdraw", "approach and withdraw"], reason: "near-climax cycling was not present in the evidence packet" },
    { pattern: /\bbody relaxation\b/i, terms: ["relaxation", "relaxed", "return to neutral", "resting state"], reason: "body relaxation was not present in the evidence packet" },
  ];

  for (const claim of guardedClaims) {
    if (claim.pattern.test(text) && !claim.terms.some((term) => evidence.includes(term))) {
      return claim.reason;
    }
  }

  if (/\b(full )?climax\b|\borgasm\b/i.test(text) && !sessionHasClimax && !evidence.includes("climax") && !evidence.includes("orgasm")) {
    return "climax was not present in the evidence packet";
  }

  if (/\bvisual evidence\b/i.test(text) && !hasVisualGrounding && !evidence.includes("visual_evidence")) {
    return "direct visual evidence was not present in the evidence packet";
  }

  if (/\b(seen|visible|visually|hands?\s+(?:are\s+)?(?:seen|moving|moved)|manual stimulation|rhythmic(?:ally)?\s+mov)/i.test(text) && !hasVisualGrounding) {
    return "direct visual evidence was not present in the evidence packet";
  }

  if (/\bhrv\b.*\b(indicates|shows|proves|demonstrates)\b.*\b(arousal|pleasure|climax|orgasm|intent|tension)\b/i.test(text) ||
      /\b(indicating|showing|proving|demonstrating)\s+(?:increased\s+)?(?:arousal|pleasure|climax|orgasm|intent|tension)\b/i.test(text)) {
    return "HRV can support cautious autonomic interpretation but cannot prove arousal, climax, pleasure, intent, or tension by itself";
  }

  return "";
}

function unsupportedClaimLimitation(reason) {
  return `A specific claim was removed because ${reason}. Treat that gap as a limitation rather than a confirmed session finding.`;
}

function evidenceLimitedExecutiveSummary(packet = null, reason = "") {
  const pieces = [];
  const metadata = packet?.session_metadata || {};
  if (metadata.duration_minutes != null) pieces.push(`duration ${metadata.duration_minutes} minutes`);
  if (metadata.intensity != null) pieces.push(`intensity ${metadata.intensity}`);
  if (metadata.satisfaction != null) pieces.push(`satisfaction ${metadata.satisfaction}`);
  const contextText = packet?.user_logged_context?.text;
  const contextNote = contextText ? "Logged context is available and should be interpreted separately from telemetry and visual evidence." : "No structured logged context was available.";
  const telemetryNote = packet?.telemetry_findings?.heart_rate?.present
    ? "Heart-rate telemetry is available for cautious autonomic interpretation."
    : "Heart-rate telemetry was not available.";
  const visualNote = packet?.visual_evidence?.present
    ? "Visual/event evidence is present in the packet and should be limited to the saved cards and event notes."
    : hasAcceptedVideoPassEventNotes(packet)
      ? `${packet?.counts?.ai_video_pass_event_notes || "Accepted"} video-pass event notes are present and can be used as visual/event grounding.`
    : "No saved visual evidence cards were available for direct visual grounding.";
  const reasonNote = reason ? ` The local model tried to exceed the evidence packet, so unsupported claims were removed (${reason}).` : "";
  return `This local Sarah analysis is evidence-limited${pieces.length ? ` (${pieces.join(", ")})` : ""}. ${contextNote} ${telemetryNote} ${visualNote}${reasonNote}`;
}

function eventClaimTypes(event) {
  const source = String(event?.source || "");
  const tags = Array.isArray(event?.annotation_tags) ? event.annotation_tags.join(" ") : "";
  if (/ai_video_pass|visual|video/i.test(`${source} ${tags}`)) return ["visual_evidence"];
  if (/manual|user/i.test(source)) return ["user_logged_context"];
  return ["user_logged_context"];
}

function eventRef(event, index) {
  return event?.id || `session_timeline.${index}`;
}

function importantTimelineEvents(packet, limit = 28) {
  const events = Array.isArray(packet?.session_timeline) ? packet.session_timeline : [];
  const useful = events
    .map((event, index) => ({ event, index }))
    .filter(({ event }) => compactText(event?.note, 9999).length >= 20);
  if (useful.length <= limit) return useful;

  const keep = new Map();
  const add = (item) => keep.set(item.index, item);
  useful.slice(0, 6).forEach(add);
  useful.slice(-6).forEach(add);

  const middle = useful.slice(6, -6);
  const step = Math.max(1, Math.floor(middle.length / Math.max(1, limit - keep.size)));
  for (let i = 0; i < middle.length && keep.size < limit; i += step) add(middle[i]);
  return [...keep.values()].sort((a, b) => a.index - b.index);
}

function hasPhaseMarker(packet, key) {
  return packet?.session_metadata?.phase_markers_s?.[key] != null;
}

export function buildLocalEvidencePacketSessionAnalysis(packet = {}) {
  const metadata = packet.session_metadata || {};
  const counts = packet.counts || {};
  const hr = packet.telemetry_findings?.heart_rate;
  const hrv = packet.hrv_findings;
  const contextText = packet.user_logged_context?.text || "";
  const visualCount = Number(packet.visual_evidence?.saved_sarah_video_cards_count || 0);
  const localCardCount = Number(packet.visual_evidence?.local_annotation_cards_count || 0);
  const aiVideoPassEventCount = Number(counts.ai_video_pass_event_notes || 0);
  const usefulEventCount = Number(counts.useful_event_notes || 0);
  const eventItems = importantTimelineEvents(packet);
  const methods = Array.isArray(metadata.methods) && metadata.methods.length ? metadata.methods.join(", ") : "";
  const sessionFacts = [
    metadata.date ? `date ${metadata.date}` : null,
    metadata.duration_minutes != null ? `duration ${metadata.duration_minutes} minutes` : null,
    methods ? `methods logged as ${methods}` : null,
    metadata.intensity != null ? `intensity ${metadata.intensity}` : null,
    metadata.satisfaction != null ? `satisfaction ${metadata.satisfaction}` : null,
    metadata.build_quality != null ? `build quality ${metadata.build_quality}` : null,
    metadata.build_type ? `build type ${metadata.build_type}` : null,
    hasPhaseMarker(packet, "climax") ? `a logged climax marker at ${clockTime(metadata.phase_markers_s.climax)}` : null,
  ].filter(Boolean);

  const executive = sentenceJoin([
    `This local Sarah report is assembled directly from the evidence packet without a local text-model synthesis pass.`,
    sessionFacts.length ? `Your session packet includes ${sessionFacts.join(", ")}.` : "Session metadata is limited.",
    contextText ? `Your logged context is present: ${contextText}.` : "No structured logged context was available.",
    hr ? `Heart-rate telemetry is present (${hr.total_points} points; ${hr.min_bpm}-${hr.max_bpm} bpm, average ${hr.avg_bpm} bpm).` : "Heart-rate telemetry was not available.",
    hrv ? `RR-derived HRV evidence is present and should be interpreted cautiously (${hrv.interpretation_status}).` : "RR-derived HRV evidence was not available.",
    visualCount || localCardCount
      ? `${visualCount} saved Sarah video card${visualCount === 1 ? "" : "s"} and ${localCardCount} local annotation card${localCardCount === 1 ? "" : "s"} are available.`
      : aiVideoPassEventCount
        ? `${aiVideoPassEventCount} accepted Claude/Sarah video-pass event note${aiVideoPassEventCount === 1 ? "" : "s"} are available. No saved video cards are attached, so visual claims should stay tied to those accepted event notes.`
        : "No saved Sarah video/local annotation cards were available, so motion and visual claims are limited to accepted timeline notes rather than direct card evidence.",
  ]);

  const chronological = eventItems.length
    ? eventItems.map(({ event, index }) => ({
      time_range: event.time_s != null ? clockTime(event.time_s) : event.time_label || "Time not recorded",
      paragraph: sentenceJoin([
        `At ${event.time_s != null ? clockTime(event.time_s) : event.time_label || "an unrecorded time"}, ${repairEventNotePersona(event.note)}.`,
        event.hr_bpm_nearest != null ? `Nearest recorded heart rate was about ${event.hr_bpm_nearest} bpm.` : null,
        event.source ? `Source: ${event.source}.` : null,
      ]),
      evidence_refs: [eventRef(event, index)],
      claim_types: eventClaimTypes(event),
    }))
    : [{
      time_range: "Timeline unavailable",
      paragraph: "No useful timestamped event notes were available for a chronological local assembly.",
      evidence_refs: ["session_timeline"],
      claim_types: ["limitation"],
    }];

  const motionParagraph = visualCount || localCardCount
    ? `Motion interpretation should prioritize the ${visualCount} saved Sarah video card${visualCount === 1 ? "" : "s"} and ${localCardCount} local annotation card${localCardCount === 1 ? "" : "s"} in the packet.`
    : aiVideoPassEventCount
      ? `No saved video/local annotation cards are attached, but ${aiVideoPassEventCount} accepted Claude/Sarah video-pass event note${aiVideoPassEventCount === 1 ? "" : "s"} are present. Motion and technique interpretation can use those accepted notes as visual/event evidence, but this local report should not add new visual claims beyond them.`
      : `No saved video/local annotation cards are available in this packet. Motion and technique interpretation is therefore limited to ${usefulEventCount} accepted timeline note${usefulEventCount === 1 ? "" : "s"}; this local report should not add new visual claims beyond those notes.`;

  const telemetryParagraph = hr
    ? sentenceJoin([
      `Your heart-rate timeline contains ${hr.total_points} recorded points over about ${formatSecondsAsWords(hr.duration_s)}.`,
      `The recorded range was ${hr.min_bpm}-${hr.max_bpm} bpm with an average of ${hr.avg_bpm} bpm.`,
      hr.hr_at_climax != null ? `The stored heart rate at climax is ${hr.hr_at_climax} bpm.` : null,
      hrv ? `RR-derived HRV is available with ${hrv.overall?.usable_row_count ?? 0} usable rows; median RMSSD is ${hrv.overall?.median_rmssd_ms ?? "not available"} ms and median SDNN is ${hrv.overall?.median_sdnn_ms ?? "not available"} ms. These values support cautious within-session autonomic interpretation only.` : "RR-derived HRV was not available.",
    ])
    : "No heart-rate timeline was available for this local report.";

  const emgParagraph = packet.emg_findings?.present
    ? `EMG data is present (${packet.emg_findings.total_samples} samples, ${packet.emg_findings.channel_mode} channel mode). Interpret EMG timing only against the stored EMG summary and timeline.`
    : packet.emg_findings?.missing_statement || "No EMG data was logged or captured in this session.";

  return {
    executive_summary: executive,
    chronological_deep_dive: chronological,
    motion_evidence_interpretation: [{
      paragraph: motionParagraph,
      evidence_refs: visualCount || localCardCount ? ["visual_evidence"] : ["session_timeline"],
      claim_types: visualCount || localCardCount ? ["visual_evidence"] : ["limitation"],
    }],
    telemetry_interpretation: [{
      paragraph: telemetryParagraph,
      evidence_refs: hrv ? ["telemetry_findings.heart_rate", "hrv_findings"] : ["telemetry_findings.heart_rate"],
      claim_types: hrv ? ["telemetry_evidence", "hrv_interpretation"] : ["telemetry_evidence"],
    }],
    emg_analysis: [{
      paragraph: emgParagraph,
      evidence_refs: ["emg_findings"],
      claim_types: packet.emg_findings?.present ? ["emg_evidence"] : ["limitation"],
    }],
    patterns_hypotheses: [{
      paragraph: contextText || hrv || hr
        ? "Patterns should be treated as provisional: logged context, event timing, HR/HRV, and accepted notes can be compared across sessions, but this local assembly does not infer intent, arousal, pleasure, or visual events beyond the packet."
        : "No reliable pattern should be inferred from this packet alone.",
      evidence_refs: ["user_logged_context", "telemetry_findings", "session_timeline"],
      claim_types: ["hypothesis", "limitation"],
    }],
    recommendations_experiments: [{
      paragraph: visualCount || localCardCount
        ? "For the next local run, keep saving accepted video/local annotation cards so the local report can distinguish direct visual evidence from timeline notes and telemetry."
        : "For a stronger local report, accept or regenerate Sarah video/local annotation cards for key windows. The current local report can use context, HR/HRV, and event notes, but it cannot replace direct visual cards.",
      evidence_refs: ["visual_evidence", "session_timeline"],
      claim_types: ["limitation"],
    }],
    limitations: (packet.limitations?.length ? packet.limitations : ["Evidence packet limitations were not listed."]).map((item) => ({
      paragraph: item,
      evidence_refs: ["session_evidence_packet"],
      claim_types: ["limitation"],
    })),
    provenance_summary: [{
      paragraph: `This local report was assembled deterministically from the shared Sarah evidence packet: ${usefulEventCount} useful event notes, ${aiVideoPassEventCount} accepted Claude/Sarah video-pass event notes, ${visualCount} saved video cards, ${localCardCount} local annotation cards, ${counts.context_fields || 0} logged context fields, HR ${hr ? "present" : "missing"}, HRV ${hrv ? "present" : "missing"}, and EMG ${packet.emg_findings?.present ? "present" : "missing"}. No cloud call and no local text-model synthesis were used for this assembly.`,
      evidence_refs: ["session_evidence_packet"],
      claim_types: ["limitation"],
    }],
  };
}

function eventCategories(event) {
  if (Array.isArray(event?.category)) return event.category.filter(Boolean);
  return [event?.category].filter(Boolean);
}

function nearestTimelineRow(timelineRows = [], timeSeconds) {
  if (!timelineRows.length || !Number.isFinite(Number(timeSeconds))) return null;
  let best = timelineRows[0];
  let bestDistance = Math.abs(Number(timelineRows[0].time_offset_s) - Number(timeSeconds));
  for (const row of timelineRows) {
    const distance = Math.abs(Number(row.time_offset_s) - Number(timeSeconds));
    if (distance < bestDistance) {
      best = row;
      bestDistance = distance;
    }
    if (Number(row.time_offset_s) > Number(timeSeconds) + 10) break;
  }
  return best || null;
}

export function buildSessionHrSummary(timelineRows = [], session = {}) {
  const rows = timelineRows
    .map((row) => ({
      time_s: numberOrNull(row.time_offset_s),
      hr: numberOrNull(row.hr),
    }))
    .filter((row) => row.time_s != null && row.hr != null);
  if (!rows.length) return null;
  const hrs = rows.map((row) => row.hr);
  const duration = Math.max(...rows.map((row) => row.time_s));
  return {
    present: true,
    total_points: rows.length,
    duration_s: Math.round(duration),
    min_bpm: Math.round(Math.min(...hrs)),
    avg_bpm: Math.round(hrs.reduce((sum, value) => sum + value, 0) / hrs.length),
    max_bpm: Math.round(Math.max(...hrs)),
    hr_at_climax: session.hr_at_climax ?? null,
    stored_avg_bpm: session.avg_hr ?? null,
    stored_max_bpm: session.max_hr ?? null,
  };
}

export function buildSessionHrTrajectory(timelineRows = []) {
  if (!timelineRows.length) return [];
  const step = Math.max(1, Math.floor(timelineRows.length / 60));
  return timelineRows
    .filter((_, index) => index % step === 0)
    .map((row) => ({
      time_s: numberOrNull(row.time_offset_s),
      time_label: formatSecondsAsWords(row.time_offset_s),
      hr_bpm: row.hr != null ? Math.round(Number(row.hr)) : null,
    }))
    .filter((row) => row.time_s != null && row.hr_bpm != null);
}

export function buildSessionEmgSummary(emgRows = [], session = {}) {
  if (!Array.isArray(emgRows) || !emgRows.length) {
    return {
      present: false,
      missing_statement: "No EMG data was logged or captured in this session.",
    };
  }
  const isDual = emgRows.some((row) => row.left_pct != null || row.right_pct != null);
  const step = Math.max(1, Math.floor(emgRows.length / 200));
  const sampled = emgRows.filter((_, index) => index % step === 0);
  const summarize = (values) => {
    const clean = values.map(Number).filter(Number.isFinite);
    return {
      avg_pct: clean.length ? Math.round(clean.reduce((sum, value) => sum + value, 0) / clean.length) : null,
      max_pct: clean.length ? Math.round(Math.max(...clean)) : null,
      clip_percent_of_time: clean.length ? Math.round((clean.filter((value) => value >= 99).length / clean.length) * 100) : 0,
    };
  };
  const trajectory = (field) => sampled
    .filter((row) => row[field] != null)
    .map((row) => ({
      time_s: numberOrNull(row.time_s),
      time_label: formatSecondsAsWords(row.time_s),
      pct: Math.round(Number(row[field])),
    }))
    .filter((row) => row.time_s != null && row.pct != null);

  if (isDual) {
    return {
      present: true,
      channel_mode: "dual",
      total_samples: emgRows.length,
      target_area: session.emg_target_area || null,
      sensor_type: session.emg_sensor_type || null,
      left: summarize(sampled.map((row) => row.left_pct)),
      right: summarize(sampled.map((row) => row.right_pct)),
      left_trajectory: trajectory("left_pct"),
      right_trajectory: trajectory("right_pct"),
      calibration: {
        rest_l: session.emg_rest_left ?? null,
        max_l: session.emg_max_left ?? null,
        rest_r: session.emg_rest_right ?? null,
        max_r: session.emg_max_right ?? null,
        lr_flipped: Boolean(session.emg_left_right_flipped),
      },
      placement_notes: {
        left: session.emg_left_placement_notes || "",
        right: session.emg_right_placement_notes || "",
        calibration: session.emg_calibration_notes || "",
        general: session.emg_general_notes || "",
      },
    };
  }

  return {
    present: true,
    channel_mode: "single",
    total_samples: emgRows.length,
    target_area: session.emg_target_area || null,
    sensor_type: session.emg_sensor_type || null,
    signal: summarize(sampled.map((row) => row.level_pct)),
    trajectory: trajectory("level_pct"),
    calibration: {
      rest: session.emg_rest_left ?? null,
      max: session.emg_max_left ?? null,
      calibration_notes: session.emg_calibration_notes || "",
    },
    placement_notes: session.emg_left_placement_notes || "",
    general_notes: session.emg_general_notes || "",
  };
}

export function buildSessionAnalysisEvidencePacket({
  session = {},
  timelineRows = [],
  emgRows = [],
  userProfile = null,
  sessionJournal = null,
  mode = "companion",
} = {}) {
  const sortedRows = [...(timelineRows || [])].sort((a, b) => Number(a.time_offset_s) - Number(b.time_offset_s));
  const events = Array.isArray(session.event_timeline) ? session.event_timeline : [];
  const usefulEvents = events.filter((event) => compactText(event?.note, 9999).length >= 20);
  const aiVideoPassEvents = events.filter((event) => event?.source === "ai_video_pass" || event?.ai_annotation?.source);
  const videoCards = normalizeSessionVideoPassFindings(session);
  const videoDraftEventCount = videoCards.reduce((sum, card) => sum + (card.draft_events?.length || 0), 0);
  const videoFindingCount = videoCards.reduce((sum, card) => sum + (card.findings?.length || 0), 0);
  const localAnnotationCards = videoCards.filter((card) => /local_qwen|local vision|local/i.test(`${card.label} ${card.source_video?.label || ""}`));
  const contextItems = sessionContextEvidenceItems(session);
  const hrSummary = buildSessionHrSummary(sortedRows, session);
  const hrvEvidence = buildSessionHrvEvidence(sortedRows, session);
  const emgSummary = buildSessionEmgSummary(emgRows, session);
  const visualEvidenceDigest = buildSessionVisualEvidenceDigest(session);
  const videoPassDigest = buildSessionVideoPassDigest(session);
  const motionSummary = getMotionEvidenceSummary(session);
  const motionDigest = motionSummary.hasAnyMotionEvidence ? getMotionEvidenceDigest(session) : "";
  const limitations = [
    !videoCards.length ? "No saved Sarah video-pass cards are available for direct visual grounding." : null,
    !localAnnotationCards.length ? "No accepted local annotation cards are available." : null,
    !hrSummary ? "No heart-rate timeline was available." : null,
    !hrvEvidence ? "No RR-derived HRV evidence was available." : null,
    !emgSummary.present ? emgSummary.missing_statement : null,
    !contextItems.length ? "No structured session context/influences were logged." : null,
  ].filter(Boolean);
  const readiness = (() => {
    const hasVisual = videoCards.length > 0 || visualEvidenceDigest;
    const hasEvents = usefulEvents.length >= 3 || videoDraftEventCount >= 2;
    if (hasVisual && hasEvents && hrSummary) return "ready_for_full_sarah_synthesis";
    if (hasVisual || hasEvents || hrSummary) return "partial_evidence_only";
    return "not_ready_insufficient_visual_or_event_evidence";
  })();

  return {
    packet_version: "sarah_session_evidence_v1",
    mode,
    generated_at: new Date().toISOString(),
    readiness,
    readiness_label: {
      ready_for_full_sarah_synthesis: "Ready for full Sarah synthesis",
      partial_evidence_only: "Partial evidence only - synthesis may be limited",
      not_ready_insufficient_visual_or_event_evidence: "Not ready - insufficient visual/event evidence",
    }[readiness],
    session_metadata: {
      id: session.id || null,
      date: session.date?.slice?.(0, 10) || session.date || null,
      duration_minutes: session.duration_minutes ?? null,
      intensity: session.intensity ?? null,
      satisfaction: session.satisfaction ?? null,
      build_quality: session.build_quality ?? null,
      build_type: session.build_type || null,
      methods: session.methods || [],
      phase_markers_s: {
        pre_climax: session.pre_climax_offset_s ?? null,
        climax: session.climax_offset_s ?? null,
        recovery: session.recovery_offset_s ?? null,
      },
      notes: compactText(session.notes, 1200),
      subjective_notes: compactText(session.subjective_notes, 1200),
    },
    user_logged_context: {
      present: contextItems.length > 0,
      items: contextItems,
      text: sessionContextEvidenceText(session),
      structured: structuredSessionContextForAI(session) || null,
    },
    session_timeline: events.map((event, index) => {
      const row = nearestTimelineRow(sortedRows, Number(event.time_s));
      return {
        id: event.id || `event-${index}`,
        time_s: numberOrNull(event.time_s),
        time_label: formatSecondsAsWords(event.time_s),
        note: compactText(event.note, 900),
        categories: eventCategories(event),
        source: event.source || "manual",
        annotation_tags: event.annotation_tags || [],
        hr_bpm_nearest: row?.hr != null ? Math.round(Number(row.hr)) : null,
      };
    }),
    visual_evidence: {
      present: Boolean(videoCards.length || visualEvidenceDigest),
      saved_sarah_video_cards_count: videoCards.length,
      saved_sarah_video_findings_count: videoFindingCount,
      saved_sarah_video_draft_events_count: videoDraftEventCount,
      local_annotation_cards_count: localAnnotationCards.length,
      digest: [visualEvidenceDigest, videoPassDigest].filter(Boolean).join("\n\n"),
      cards: videoCards.map((card) => ({
        id: card.id,
        label: card.label,
        time_range: card.clip?.start_s != null && card.clip?.end_s != null
          ? `${formatSecondsAsWords(card.clip.start_s)} to ${formatSecondsAsWords(card.clip.end_s)}`
          : "time range unavailable",
        summary: compactText(card.summary, 1000),
        findings: (card.findings || []).slice(0, 6),
        draft_events: (card.draft_events || []).slice(0, 5),
        telemetry: compactText(card.telemetry, 500),
      })),
    },
    telemetry_findings: {
      heart_rate: hrSummary,
      hr_trajectory: buildSessionHrTrajectory(sortedRows),
      motion_summary: motionSummary,
      motion_digest: motionDigest,
    },
    hrv_findings: hrvEvidence,
    emg_findings: emgSummary,
    profile_context: {
      present: Boolean(userProfile && (userProfile.arousal_response_style || userProfile.arousal_notes || userProfile.climax_sensitivity || userProfile.preferred_stimulation)),
      arousal_response_style: userProfile?.arousal_response_style || null,
      typical_build_duration: userProfile?.typical_build_duration || null,
      climax_sensitivity: userProfile?.climax_sensitivity || null,
      preferred_stimulation: userProfile?.preferred_stimulation || null,
      refractory_pattern: userProfile?.refractory_pattern || null,
      arousal_notes: userProfile?.arousal_notes || null,
    },
    journal_context: {
      present: Boolean(sessionJournal),
      emotional_reflection: compactText(sessionJournal?.emotional_reflection, 900),
      physiological_observations: compactText(sessionJournal?.physiological_observations, 900),
      experience_narrative: compactText(sessionJournal?.experience_narrative, 900),
      insights: compactText(sessionJournal?.insights, 900),
      next_session_intentions: compactText(sessionJournal?.next_session_intentions, 900),
      key_moments: sessionJournal?.key_moments || [],
    },
    limitations,
    counts: {
      event_notes: events.length,
      useful_event_notes: usefulEvents.length,
      ai_video_pass_event_notes: aiVideoPassEvents.length,
      saved_sarah_video_cards: videoCards.length,
      saved_sarah_video_draft_events: videoDraftEventCount,
      local_annotation_cards: localAnnotationCards.length,
      context_fields: contextItems.length,
      hr_rows: sortedRows.length,
      hrv_present: Boolean(hrvEvidence),
      emg_present: Boolean(emgSummary.present),
      profile_context_present: Boolean(userProfile),
      journal_context_present: Boolean(sessionJournal),
      limitations: limitations.length,
    },
  };
}

export function evidencePacketPreview(packet) {
  const counts = packet?.counts || {};
  return {
    readiness: packet?.readiness,
    readinessLabel: packet?.readiness_label || "Evidence readiness unknown",
    contextItems: packet?.user_logged_context?.items || [],
    contextPresent: Boolean(packet?.user_logged_context?.present),
    eventNotesCount: counts.event_notes || 0,
    usefulEventNotesCount: counts.useful_event_notes || 0,
    aiVideoPassEventNotesCount: counts.ai_video_pass_event_notes || 0,
    savedSarahVideoCardsCount: counts.saved_sarah_video_cards || 0,
    localAnnotationCardsCount: counts.local_annotation_cards || 0,
    hrvPresent: Boolean(counts.hrv_present),
    hrPresent: Boolean(packet?.telemetry_findings?.heart_rate),
    emgPresent: Boolean(counts.emg_present),
    profileContextPresent: Boolean(counts.profile_context_present),
    journalContextPresent: Boolean(counts.journal_context_present),
    limitationsPresent: Boolean(counts.limitations),
    limitations: packet?.limitations || [],
  };
}

export function localSessionAnalysisNeedsPacketFallback(result = {}, packet = {}) {
  const counts = packet?.counts || {};
  const usefulEventCount = Number(counts.useful_event_notes || 0);
  const aiVideoPassEventCount = Number(counts.ai_video_pass_event_notes || 0);
  const hasHr = Boolean(packet?.telemetry_findings?.heart_rate);
  const hasHrv = Boolean(packet?.hrv_findings);
  const hasContext = Boolean(packet?.user_logged_context?.present);
  const hasSavedCards = Boolean(packet?.visual_evidence?.saved_sarah_video_cards_count || packet?.visual_evidence?.local_annotation_cards_count);
  const hasAcceptedEvents = usefulEventCount >= 3 || aiVideoPassEventCount >= 2;
  const hasHardPacketEvidence = hasContext || hasHr || hasHrv || hasSavedCards || hasAcceptedEvents;
  if (!hasHardPacketEvidence) return false;

  const rendered = JSON.stringify(result || {}).toLowerCase();
  const chronological = Array.isArray(result?.chronological_deep_dive) ? result.chronological_deep_dive : [];
  const eventGroundedChronology = chronological.filter((item) => (
    Array.isArray(item?.evidence_refs) && item.evidence_refs.some((ref) => /event|timeline|visual_evidence/i.test(String(ref || "")))
  ));

  if (hasContext && /no structured logged context was available|no structured session context/i.test(rendered)) return true;
  if (hasHr && /heart-rate telemetry was not available|no heart-rate timeline was available/i.test(rendered)) return true;
  if (hasHrv && /no rr-derived hrv evidence was available|no hrv evidence was available/i.test(rendered)) return true;
  if ((hasSavedCards || hasAcceptedEvents) && /no saved visual evidence cards were available, so specific movement|specific movement or technique findings cannot be confirmed/i.test(rendered)) return true;
  if (hasAcceptedEvents && chronological.length <= 1 && eventGroundedChronology.length === 0) return true;
  if (hasAcceptedEvents && /during this period, you reported|they approached a state|heightened arousal/i.test(rendered)) return true;
  if (usefulEventCount >= 8 && chronological.length < 3) return true;

  return false;
}

function normalizeSectionItem(item, fallbackClaimTypes = [], options = {}) {
  if (!item) return null;
  if (typeof item === "string") {
    const paragraph = repairSarahParagraph(item, options);
    return paragraph ? { paragraph, evidence_refs: [], claim_types: fallbackClaimTypes } : null;
  }
  const paragraph = repairSarahParagraph(item.paragraph || item.text || item.summary || "", options);
  if (!paragraph) return null;
  return {
    ...item,
    paragraph,
    evidence_refs: Array.isArray(item.evidence_refs) ? item.evidence_refs.map(String).filter(Boolean) : [],
    claim_types: Array.isArray(item.claim_types) ? item.claim_types.filter(Boolean) : fallbackClaimTypes,
  };
}

function normalizeChronologicalItem(item, packet = null, evidenceText = "", options = {}) {
  const normalized = normalizeSectionItem(item, ["visual_evidence", "telemetry_evidence"], options);
  if (!normalized) return null;
  const unsupportedReason = unsupportedClaimReason(normalized.paragraph, evidenceText, packet);
  if (unsupportedReason) {
    return null;
  }
  return {
    time_range: item?.time_range || "",
    ...normalized,
  };
}

function normalizeGuardedSectionItem(item, fallbackClaimTypes = [], packet = null, evidenceText = "", options = {}) {
  const normalized = normalizeSectionItem(item, fallbackClaimTypes, options);
  if (!normalized) return null;
  const unsupportedReason = unsupportedClaimReason(normalized.paragraph, evidenceText, packet);
  if (!unsupportedReason) return normalized;
  if (fallbackClaimTypes.includes("limitation")) {
    return {
      paragraph: unsupportedClaimLimitation(unsupportedReason),
      evidence_refs: ["session_evidence_packet"],
      claim_types: ["limitation"],
    };
  }
  return null;
}

export function normalizeGoldStandardSessionAnalysis(value, packet = null, options = {}) {
  const repaired = repairAITextBlocks(value?.response ?? value);
  const source = repaired && typeof repaired === "object" ? repaired : {};
  const missingEmg = packet?.emg_findings?.missing_statement || "No EMG data was logged or captured in this session.";
  const evidenceText = packetEvidenceText(packet);
  const executiveSummary = repairSarahParagraph(source.executive_summary || source.summary || "", options);
  const executiveUnsupportedReason = unsupportedClaimReason(executiveSummary, evidenceText, packet);
  const normalized = {
    ...source,
    executive_summary: executiveUnsupportedReason ? evidenceLimitedExecutiveSummary(packet, executiveUnsupportedReason) : executiveSummary,
    chronological_deep_dive: (source.chronological_deep_dive || source.arousal_arc || source.phase_analysis || []).map((item) => normalizeChronologicalItem(item, packet, evidenceText, options)).filter(Boolean),
    motion_evidence_interpretation: (source.motion_evidence_interpretation || source.event_analysis || source.hr_analysis || []).map((item) => normalizeGuardedSectionItem(item, ["visual_evidence", "telemetry_evidence"], packet, evidenceText, options)).filter(Boolean),
    telemetry_interpretation: (source.telemetry_interpretation || []).map((item) => normalizeGuardedSectionItem(item, ["telemetry_evidence", "hrv_interpretation"], packet, evidenceText, options)).filter(Boolean),
    emg_analysis: (source.emg_analysis?.length ? source.emg_analysis : [{ paragraph: missingEmg, evidence_refs: ["emg_findings"], claim_types: ["limitation"] }]).map((item) => normalizeGuardedSectionItem(item, packet?.emg_findings?.present ? ["emg_evidence"] : ["limitation"], packet, evidenceText, options)).filter(Boolean),
    patterns_hypotheses: (source.patterns_hypotheses || source.notable_findings || []).map((item) => normalizeGuardedSectionItem(item, ["hypothesis"], packet, evidenceText, options)).filter(Boolean),
    recommendations_experiments: (source.recommendations_experiments || source.recommendations || []).map((item) => normalizeGuardedSectionItem(item, ["hypothesis"], packet, evidenceText, options)).filter(Boolean),
    limitations: [
      ...(source.limitations?.length ? source.limitations : (packet?.limitations || [])),
      ...(executiveUnsupportedReason ? [{ paragraph: unsupportedClaimLimitation(executiveUnsupportedReason), evidence_refs: ["session_evidence_packet"], claim_types: ["limitation"] }] : []),
    ].map((item) => normalizeGuardedSectionItem(item, ["limitation"], packet, evidenceText, options)).filter(Boolean),
    provenance_summary: (source.provenance_summary?.length ? source.provenance_summary : [
      { paragraph: "This analysis was synthesized from the shared Sarah evidence packet, including user-logged context, event notes, saved visual evidence, telemetry, HRV when present, EMG status, profile context, and stated limitations.", evidence_refs: ["session_evidence_packet"], claim_types: ["limitation"] },
    ]).map((item) => normalizeGuardedSectionItem(item, ["limitation"], packet, evidenceText, options)).filter(Boolean),
  };
  if (!normalized.chronological_deep_dive.length) {
    normalized.chronological_deep_dive = [{
      time_range: "Evidence-limited",
      paragraph: "The shared evidence packet did not contain enough supported timestamped visual or event evidence for a reliable chronological deep dive. Local Sarah should not invent a session sequence from profile context or telemetry alone.",
      evidence_refs: ["session_evidence_packet"],
      claim_types: ["limitation"],
    }];
  }
  if (!normalized.motion_evidence_interpretation.length) {
    normalized.motion_evidence_interpretation = [{
      paragraph: packet?.visual_evidence?.present
        ? "Motion and visual interpretation should be limited to the saved evidence cards and accepted event notes in the packet."
        : "No saved visual evidence cards were available, so specific movement or technique findings cannot be confirmed from this local synthesis.",
      evidence_refs: ["visual_evidence"],
      claim_types: ["limitation"],
    }];
  }
  if (!normalized.telemetry_interpretation.length) {
    normalized.telemetry_interpretation = [{
      paragraph: packet?.hrv_findings
        ? "HRV can support cautious autonomic interpretation, but it cannot prove arousal, climax, pleasure, intent, or specific movement by itself."
        : "No RR-derived HRV evidence was available for telemetry interpretation.",
      evidence_refs: packet?.hrv_findings ? ["hrv_findings"] : ["telemetry_findings"],
      claim_types: packet?.hrv_findings ? ["hrv_interpretation", "limitation"] : ["limitation"],
    }];
  }
  if (!normalized.patterns_hypotheses.length) {
    normalized.patterns_hypotheses = [{
      paragraph: "No reliable pattern or hypothesis should be promoted from this local output beyond the evidence streams present in the packet.",
      evidence_refs: ["session_evidence_packet"],
      claim_types: ["limitation"],
    }];
  }
  if (!normalized.recommendations_experiments.length) {
    normalized.recommendations_experiments = [{
      paragraph: "The useful next step is to improve the underlying evidence packet, especially timestamped event notes or accepted visual annotation cards, before asking local synthesis for a richer Sarah-style interpretation.",
      evidence_refs: ["session_evidence_packet"],
      claim_types: ["limitation"],
    }];
  }
  const seenLimitations = new Set();
  normalized.limitations = normalized.limitations.filter((item) => {
    const key = String(item.paragraph || "").toLowerCase().replace(/\s+/g, " ").trim();
    if (!key || seenLimitations.has(key)) return false;
    seenLimitations.add(key);
    return true;
  });
  return normalized;
}

export function requiredAnalysisSectionsPresent(result) {
  return Object.fromEntries(SESSION_ANALYSIS_SECTION_KEYS.map((key) => {
    const value = result?.[key];
    return [key, key === "executive_summary" ? Boolean(String(value || "").trim()) : Array.isArray(value) && value.length > 0];
  }));
}

export function buildSarahSessionSynthesisPrompt({ packet, mode = "companion", local = false } = {}) {
  return `You are Sarah, PulsePoint's clinical physiology companion and session interpreter.

Your job is to synthesize the provided shared evidence packet into the gold-standard Sarah Session Analysis structure. ${local ? "You are running as a local text synthesizer. You are not a visual model." : "You are the Claude/Sarah reference analysis path."}

Required sections:
1. executive_summary
2. chronological_deep_dive
3. motion_evidence_interpretation
4. telemetry_interpretation
5. emg_analysis
6. patterns_hypotheses
7. recommendations_experiments
8. limitations
9. provenance_summary

Evidence rules:
- Use only evidence in the packet. Do not invent new visual findings.
- New visual claims must come from saved Sarah video cards, accepted local annotation cards, accepted ai_video_pass event notes, explicit user/event notes, or visual evidence with frame references.
- The local text LLM is a synthesizer only. It cannot see the video and cannot create new observations from imagination.
- Do not write a chronological visual narrative unless the packet contains timestamped event notes or video/annotation cards for those windows.
- If a section lacks enough evidence, write the limitation directly, but do not lead with boilerplate limitations when the packet contains useful accepted event notes, HR/HRV, logged context, or profile context.
- Separate user-logged context, visual evidence, telemetry evidence, HRV interpretation, EMG evidence, profile context, hypotheses, and limitations.
- If evidence is weak, say so plainly. Do not fill gaps with confident prose.
- If EMG is missing, explicitly say no EMG data was logged or captured.
- Do not label edging unless explicitly logged or clearly supported by repeated intended near-climax approach-and-withdraw cycles.
- Keep alcohol/cannabis wording neutral and clinical; frame influence as possible, not causal proof.
- Never output raw second offsets. Use readable time language or clock-style ranges.
- Address Ben directly as "you" and "your"; never write detached labels like "the user," "this user," "the subject," "the individual," or "the patient."
- Preferred phrasing: "you," "your body," "your session," "your telemetry," "your lower body," "your heart rate," and "your logged context." Use "Ben" sparingly, usually only in the opening if needed.
- Keep the tone clinical, practical, evidence-based, and warm without erotic prose.

Narrative quality target:
- Write like Sarah, not like a validator log. The user should hear a grounded session read, not a packet inventory.
- Start with the strongest actual session story: baseline/entry state, first visible changes, technique or contact changes, HR/HRV movement, lower-body motion, pauses/resumes, and the most important uncertainty.
- Group dense timestamped notes into coherent phases. Do not mechanically list every event as one sentence unless the event sequence itself is the useful finding.
- Use accepted ai_video_pass event notes as visual/event evidence, but phrase them as "the accepted event notes show/describe..." when there is no saved video card.
- Make telemetry useful: identify rises, dips, plateaus, peaks, and HRV outliers when present. Keep causality cautious.
- Limitations belong at the end unless a limitation directly changes the interpretation of a specific paragraph.
- Avoid repetitive lines such as "No structured logged context was available" or "No saved visual evidence cards were available" when other usable evidence is present.

Claims that are forbidden unless explicitly present in the packet:
- prostate massage, perineum pressure technique, circular hand motion, first contact, technique shift, lubrication break, fluid/ejaculate, near-climax cycling, climax, orgasm, body relaxation, or arousal intent.
- HRV proving arousal, climax, orgasm, pleasure, pain, or intent. HRV may only support cautious autonomic interpretation.

Bad output pattern:
"The session involved a detailed analysis of visual and telemetry data. The user engaged in prostate massage. Multiple near-climax events were observed."

Required alternative when evidence is thin:
"The packet does not contain enough timestamped visual/event evidence to support a detailed chronological visual narrative. The available telemetry/context can be summarized cautiously, but unsupported technique or climax claims should remain limitations."

Output shape:
- Return only JSON matching the schema.
- chronological_deep_dive entries must include time_range, paragraph, evidence_refs, and claim_types.
- Other section entries must include paragraph, evidence_refs, and claim_types.
- claim_types may include: ${CLAIM_TYPES.join(", ")}.

Shared evidence packet:
${JSON.stringify(packet, null, 2)}`;
}
