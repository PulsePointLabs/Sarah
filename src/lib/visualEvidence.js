import { richTextToPlainText } from "./richText.js";

export const VISUAL_REVIEW_SOURCES = [
  "profile_sarah_image_review",
  "profile_sarah_video_review",
  "profile_sarah_visual_review",
  "session_sarah_image_review",
  "session_sarah_video_review",
  "session_sarah_visual_review",
  "body_exploration_sarah_image_review",
  "body_exploration_sarah_video_review",
  "body_exploration_sarah_visual_review",
];

export function isVisualReviewSource(source) {
  return VISUAL_REVIEW_SOURCES.includes(String(source || ""));
}

function cleanText(value, maxLength = 700) {
  const text = richTextToPlainText(String(value || ""));
  return text.replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function formatTimePhrase(value) {
  const total = Math.max(0, Number(value) || 0);
  const minutes = Math.floor(total / 60);
  const seconds = Math.round((total - minutes * 60) * 10) / 10;
  const secondsText = seconds % 1 === 0 ? String(Math.round(seconds)) : seconds.toFixed(1);
  if (!minutes) return `${secondsText} second${seconds === 1 ? "" : "s"}`;
  if (!seconds) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  return `${minutes} minute${minutes === 1 ? "" : "s"} and ${secondsText} second${seconds === 1 ? "" : "s"}`;
}

function formatClockTime(value) {
  const total = Math.max(0, Number(value) || 0);
  const minutes = Math.floor(total / 60);
  const seconds = Math.round((total - minutes * 60) * 10) / 10;
  const secondsText = seconds % 1 === 0
    ? String(Math.round(seconds)).padStart(2, "0")
    : seconds.toFixed(1).padStart(4, "0");
  return `${minutes}:${secondsText}`;
}

function markerNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function currentSessionPhaseMarkers(session = {}) {
  return {
    pre_climax: markerNumber(session.pre_climax_offset_s),
    climax: markerNumber(session.climax_offset_s),
    recovery: markerNumber(session.recovery_offset_s),
  };
}

function phaseTargetFromText(text = "") {
  const value = String(text || "").toLowerCase();
  if (/\bpre[-\s]?climax\b/.test(value)) return "pre_climax";
  if (/\brecovery\b/.test(value)) return "recovery";
  if (/\bafter[-\s]?marker\b/.test(value)) return "after_climax";
  if (/\b(climax|orgasm|ejaculat|emission|expulsion|release)\b/.test(value)) return "climax";
  return null;
}

function phaseMarkerClaimFromText(text = "") {
  const value = String(text || "");
  return /\b(?:pre[-\s]?climax|climax|recovery)\s+marker\b/i.test(value)
    || /\bmarker\s+(?:logged|reached|set|saved)\b/i.test(value)
    || /^(?:pre[-\s]?climax build|climax\s*\/\s*ejaculation evidence window|after[-\s]?marker continuation|recovery shift)$/i.test(value.trim());
}

function referencedClockSeconds(text = "") {
  const times = [];
  String(text || "").replace(/\b(\d{1,2}):(\d{2}(?:\.\d+)?)\b/g, (match, minutes, seconds) => {
    times.push((Number(minutes) * 60) + Number(seconds));
    return match;
  });
  return times.filter(Number.isFinite);
}

export function buildSessionPhaseMarkerDigest(session = {}) {
  const markers = currentSessionPhaseMarkers(session);
  const parts = [
    markers.pre_climax != null ? `pre-climax ${formatClockTime(markers.pre_climax)} (${formatTimePhrase(markers.pre_climax)})` : null,
    markers.climax != null ? `climax ${formatClockTime(markers.climax)} (${formatTimePhrase(markers.climax)})` : null,
    markers.recovery != null ? `recovery ${formatClockTime(markers.recovery)} (${formatTimePhrase(markers.recovery)})` : null,
  ].filter(Boolean);
  if (!parts.length) return "";
  return `Current manually saved phase markers are the source of truth: ${parts.join(", ")}. Older imported video-pass notes or saved clips that cite different marker times should be treated as stale.`;
}

export function isStalePhaseMarkerReference(item = {}, session = {}, toleranceSeconds = 35) {
  const text = [
    item.label,
    item.reason,
    item.note,
    item.text,
    item.description,
    Array.isArray(item.category) ? item.category.join(" ") : item.category,
    Array.isArray(item.annotation_tags) ? item.annotation_tags.join(" ") : item.annotation_tags,
  ].filter(Boolean).join(" ");
  if (!phaseMarkerClaimFromText(text)) return false;

  const target = phaseTargetFromText(text);
  const markers = currentSessionPhaseMarkers(session);
  const expected = target === "pre_climax"
    ? markers.pre_climax
    : target === "recovery"
      ? markers.recovery
      : markers.climax;
  if (expected == null) return false;

  const itemTime = markerNumber(item.session_time_s ?? item.time_s ?? item.time_s_offset ?? item.offset_s);
  const expectedForItem = target === "after_climax" ? expected + 22 : expected;
  if (itemTime != null && Math.abs(itemTime - expectedForItem) > toleranceSeconds) return true;

  return referencedClockSeconds(text).some((time) => Math.abs(time - expected) > toleranceSeconds);
}

export function sessionEventsForCurrentPhaseMarkers(session = {}) {
  const events = Array.isArray(session.event_timeline) ? session.event_timeline : [];
  return events.filter((event) => !isStalePhaseMarkerReference(event, session));
}

function compactFindingText(finding) {
  if (!finding) return "";
  if (typeof finding === "string") return cleanText(finding);
  const title = finding.title ? `${finding.title}: ` : "";
  const text = finding.findingText || finding.text || finding.finding || "";
  const confidence = finding.confidence ? ` (${finding.confidence} confidence)` : "";
  return cleanText(`${title}${text}${confidence}`);
}

function parseFindingBullets(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.replace(/^[\s•*-]+/, "").trim())
    .filter(Boolean);
}

export function extractVisualMediaContextFromConversation(conversation = []) {
  const attachments = Array.isArray(conversation)
    ? conversation.flatMap((message) => Array.isArray(message?.imageAttachments) ? message.imageAttachments : [])
    : [];
  const videoFrames = attachments.filter((item) => item?.sourceVideo);
  const videoMap = new Map();

  videoFrames.forEach((item) => {
    const video = item.sourceVideo || {};
    const key = [
      video.filename || "video",
      video.label || "",
      video.startSeconds ?? "",
      video.endSeconds ?? "",
    ].join("|");
    const existing = videoMap.get(key) || {
      filename: video.filename || "",
      label: video.label || "",
      startSeconds: video.startSeconds,
      endSeconds: video.endSeconds,
      timelineStartSeconds: video.timelineStartSeconds,
      timelineEndSeconds: video.timelineEndSeconds,
      timelineLabel: video.timelineLabel || "",
      processedClipUrl: video.processedClipUrl || "",
      frameTimes: [],
      frameTimelineTimes: [],
      motionSummary: video.motionSummary || null,
    };
    if (video.frameTimeSeconds != null) existing.frameTimes.push(Number(video.frameTimeSeconds));
    if (video.frameTimelineSeconds != null) existing.frameTimelineTimes.push(Number(video.frameTimelineSeconds));
    if (!existing.motionSummary && video.motionSummary) existing.motionSummary = video.motionSummary;
    videoMap.set(key, existing);
  });

  return {
    image_count: attachments.length,
    frame_count: videoFrames.length,
    media_kind: videoFrames.length ? "video_frame_sequence" : attachments.length ? "image" : "unknown",
    videos: [...videoMap.values()].map((video) => ({
      ...video,
      frameTimes: [...new Set(video.frameTimes.filter(Number.isFinite).map((time) => Number(time.toFixed(2))))],
      frameTimelineTimes: [...new Set(video.frameTimelineTimes.filter(Number.isFinite).map((time) => Number(time.toFixed(2))))],
    })),
  };
}

function defaultVisualSource(scope, mediaContext) {
  const normalizedScope = ["profile", "session", "body_exploration"].includes(scope) ? scope : "session";
  if (mediaContext.frame_count) return `${normalizedScope}_sarah_video_review`;
  if (mediaContext.image_count) return `${normalizedScope}_sarah_image_review`;
  return `${normalizedScope}_sarah_visual_review`;
}

export function makeVisualEvidenceEntry(meta = {}, fallbackText = "", { defaultScope = "session" } = {}) {
  const now = new Date().toISOString();
  const mediaContext = meta.media_context || extractVisualMediaContextFromConversation(meta.conversation);
  const structuredFindings = Array.isArray(meta.structured_findings) ? meta.structured_findings : [];
  const findings = structuredFindings.length
    ? structuredFindings.map(compactFindingText).filter(Boolean)
    : parseFindingBullets(fallbackText).slice(-8);
  const source = isVisualReviewSource(meta.source) ? meta.source : defaultVisualSource(defaultScope, mediaContext);
  const scope = source.startsWith("profile_")
    ? "profile"
    : source.startsWith("body_exploration_") ? "body_exploration" : "session";

  return {
    id: meta.id || `${scope}-visual-${now}`,
    date: meta.date || now.slice(0, 10),
    saved_at: meta.saved_at || now,
    source,
    needs_review: Boolean(meta.needs_review),
    persistence_status: meta.persistence_status || "recommended",
    structured_findings: structuredFindings,
    findings,
    image_count: Number(meta.image_count ?? mediaContext.image_count ?? 0),
    frame_count: Number(meta.frame_count ?? mediaContext.frame_count ?? 0),
    media_context: mediaContext,
  };
}

export function makeSessionVisualEvidenceEntry(meta = {}, fallbackText = "") {
  return makeVisualEvidenceEntry(meta, fallbackText, { defaultScope: "session" });
}

export function makeBodyExplorationVisualEvidenceEntry(meta = {}, fallbackText = "") {
  return makeVisualEvidenceEntry(meta, fallbackText, { defaultScope: "body_exploration" });
}

export function normalizeVisualEvidenceEntries(entries, { fallbackSource = "session_sarah_visual_review" } = {}) {
  if (!Array.isArray(entries)) return [];
  const seen = new Set();
  return entries
    .map((entry, index) => ({
      id: entry.id || `session-visual-${entry.saved_at || entry.date || index}`,
      date: entry.date || entry.saved_at?.slice?.(0, 10) || "Undated",
      saved_at: entry.saved_at || entry.created_at || null,
      source: entry.source || fallbackSource,
      needs_review: Boolean(entry.needs_review),
      persistence_status: entry.persistence_status || "recommended",
      structured_findings: Array.isArray(entry.structured_findings) ? entry.structured_findings : [],
      findings: Array.isArray(entry.findings) ? entry.findings.map(compactFindingText).filter(Boolean) : parseFindingBullets(entry.findings),
      image_count: Number(entry.image_count || 0),
      frame_count: Number(entry.frame_count || 0),
      media_context: entry.media_context || null,
    }))
    .filter((entry) => isVisualReviewSource(entry.source) && entry.findings.length)
    .filter((entry) => {
      const key = `${entry.source}|${entry.date}|${entry.findings.join("|").toLowerCase()}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => (Date.parse(b.saved_at || b.date) || 0) - (Date.parse(a.saved_at || a.date) || 0));
}

export function normalizeSessionVisualEvidence(sessionOrEntries) {
  const entries = Array.isArray(sessionOrEntries)
    ? sessionOrEntries
    : sessionOrEntries?.ai_analysis?._visual_findings;
  return normalizeVisualEvidenceEntries(entries, { fallbackSource: "session_sarah_visual_review" });
}

export function normalizeBodyExplorationVisualEvidence(explorationOrEntries) {
  const entries = Array.isArray(explorationOrEntries)
    ? explorationOrEntries
    : explorationOrEntries?.ai_body_exploration?._visual_findings;
  return normalizeVisualEvidenceEntries(entries, { fallbackSource: "body_exploration_sarah_visual_review" });
}

function formatMediaContext(entry) {
  const media = entry.media_context;
  if (!media) return "";
  const parts = [];
  if (entry.frame_count) parts.push(`${entry.frame_count} sampled video frames`);
  else if (entry.image_count) parts.push(`${entry.image_count} reviewed image${entry.image_count === 1 ? "" : "s"}`);
  if (Array.isArray(media.videos) && media.videos.length) {
    const videos = media.videos.map((video) => {
      const range = video.startSeconds != null && video.endSeconds != null
        ? `${formatTimePhrase(video.startSeconds)} to ${formatTimePhrase(video.endSeconds)}`
        : "";
      const timelineRange = video.timelineStartSeconds != null && video.timelineEndSeconds != null
        ? `, ${video.timelineLabel || "session timeline"} ${formatTimePhrase(video.timelineStartSeconds)} to ${formatTimePhrase(video.timelineEndSeconds)}`
        : "";
      const label = video.label || video.filename || "video clip";
      const frames = video.frameTimes?.length ? ` frames at ${video.frameTimes.map(formatTimePhrase).join(", ")}` : "";
      return `${label}${range ? ` (${range}${timelineRange})` : timelineRange ? ` (${timelineRange.replace(/^, /, "")})` : ""}${frames}`;
    });
    parts.push(videos.join("; "));
  }
  return parts.length ? ` Media context: ${parts.join("; ")}.` : "";
}

export function buildSessionVisualEvidenceDigest(session, { limit = 12 } = {}) {
  const entries = normalizeSessionVisualEvidence(session).slice(0, limit);
  if (!entries.length) return "";
  const lines = entries.flatMap((entry) => {
    const sourceLabel = entry.source.includes("video") ? "video/frame sequence" : entry.source.includes("image") ? "image" : "visual review";
    const status = entry.needs_review ? "review candidate" : entry.persistence_status || "recommended";
    const mediaContext = formatMediaContext(entry);
    return entry.findings.slice(0, 6).map((finding) => (
      `- [${entry.date}; Sarah ${sourceLabel}; ${status}] ${finding}${mediaContext}`
    ));
  });
  return lines.length ? `Reviewed Sarah visual evidence for this session:\n${lines.join("\n")}` : "";
}

function compactTelemetryText(value) {
  if (!value) return "";
  if (typeof value === "string") return cleanText(value, 500);
  if (typeof value !== "object") return cleanText(value, 500);
  const range = value.requested_session_window?.label;
  const hr = value.heart_rate?.exact_window;
  const hrv = value.rr_hrv?.exact_window;
  const motion = value.multimodal?.exact_window?.motion;
  const states = value.multimodal?.exact_window?.multimodal_states;
  const motionClasses = motion?.classes ? Object.keys(motion.classes).map((key) => key.replace(/_/g, " ")) : [];
  const stateLabels = states ? Object.keys(states).map((key) => key.replace(/_/g, " ")) : [];
  return [
    range ? `Window ${range}` : null,
    hr?.samples ? `HR ${hr.bpm_start ?? "?"} to ${hr.bpm_end ?? "?"} bpm, peak ${hr.bpm_max ?? "?"} (${hr.samples} samples)` : null,
    hrv?.rmssd_ms?.count ? `RMSSD ${hrv.rmssd_ms.avg} ms avg` : null,
    hrv?.sdnn_ms?.count ? `SDNN ${hrv.sdnn_ms.avg} ms avg` : null,
    motionClasses.length ? `motion ${motionClasses.join("/")}` : null,
    stateLabels.length ? `body-state signals ${stateLabels.join("/")}` : null,
    Array.isArray(value.nearby_events) && value.nearby_events.length ? `${value.nearby_events.length} nearby timeline events` : null,
  ].filter(Boolean).join("; ");
}

function normalizeVideoPassFindingCard(card, index = 0) {
  if (!card) return null;
  const clip = card.clip || {};
  const sourceVideo = card.source_video || card.sourceVideo || {};
  const findings = Array.isArray(card.findings)
    ? card.findings.map(compactFindingText).filter(Boolean)
    : parseFindingBullets(card.findings);
  const events = Array.isArray(card.draft_events || card.events)
    ? (card.draft_events || card.events)
      .map((event) => ({
        time_s: Number(event?.time_s),
        note: cleanText(event?.note || event?.text || "", 500),
        confidence: event?.confidence || "",
      }))
      .filter((event) => Number.isFinite(event.time_s) && event.note)
    : [];
  const start = Number(clip.start_s ?? card.window?.start);
  const end = Number(clip.end_s ?? card.window?.end);

  return {
    id: card.id || `video-pass-${card.saved_at || index}`,
    saved_at: card.saved_at || null,
    label: card.label || "AI video pass",
    source_video: {
      label: sourceVideo.label || "",
      filename: sourceVideo.filename || "",
    },
    clip: {
      url: clip.url || card.clipUrl || "",
      start_s: Number.isFinite(start) ? start : null,
      end_s: Number.isFinite(end) ? end : null,
      duration_s: Number(clip.duration_s || (Number.isFinite(start) && Number.isFinite(end) ? end - start : 0)) || null,
    },
    summary: cleanText(card.summary, 900),
    findings,
    draft_events: events,
    telemetry: compactTelemetryText(card.telemetry),
    motion_summary: card.motion_summary || card.motionSummary || null,
  };
}

export function normalizeSessionVideoPassFindings(sessionOrEntries) {
  const hasSessionContext = !Array.isArray(sessionOrEntries) && sessionOrEntries && typeof sessionOrEntries === "object";
  const entries = Array.isArray(sessionOrEntries)
    ? sessionOrEntries
    : sessionOrEntries?.ai_analysis?._video_pass_findings;
  if (!Array.isArray(entries)) return [];
  const seen = new Set();
  return entries
    .map(normalizeVideoPassFindingCard)
    .map((entry) => {
      if (!entry || !hasSessionContext) return entry;
      return {
        ...entry,
        findings: entry.findings.filter((finding) => !isStalePhaseMarkerReference({ text: finding, time_s: entry.clip.start_s }, sessionOrEntries)),
        draft_events: entry.draft_events.filter((event) => !isStalePhaseMarkerReference(event, sessionOrEntries)),
      };
    })
    .filter((entry) => !hasSessionContext || !isStalePhaseMarkerReference({
      label: entry?.label,
      text: entry?.summary,
      time_s: entry?.clip?.start_s,
    }, sessionOrEntries))
    .filter((entry) => entry && (entry.summary || entry.findings.length || entry.draft_events.length))
    .filter((entry) => {
      const key = [
        entry.source_video.filename || entry.source_video.label || "video",
        entry.clip.start_s ?? "",
        entry.clip.end_s ?? "",
        entry.summary.toLowerCase(),
        entry.findings.join("|").toLowerCase(),
      ].join("|");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => {
      const aStart = a.clip.start_s ?? Number.POSITIVE_INFINITY;
      const bStart = b.clip.start_s ?? Number.POSITIVE_INFINITY;
      if (aStart !== bStart) return aStart - bStart;
      return (Date.parse(a.saved_at || "") || 0) - (Date.parse(b.saved_at || "") || 0);
    });
}

export function normalizeBodyExplorationVideoPassFindings(explorationOrEntries) {
  const entries = Array.isArray(explorationOrEntries)
    ? explorationOrEntries
    : explorationOrEntries?.ai_body_exploration?._video_pass_findings;
  return normalizeSessionVideoPassFindings(entries);
}

function formatVideoPassRange(entry) {
  const start = entry.clip.start_s;
  const end = entry.clip.end_s;
  if (start != null && end != null) return `${formatTimePhrase(start)} to ${formatTimePhrase(end)}`;
  if (start != null) return `starting at ${formatTimePhrase(start)}`;
  return "time range not specified";
}

function cloudArray(value) {
  return Array.isArray(value) ? value.filter(Boolean) : [];
}

function compactCloudEvidenceText(value, maxLength = 560) {
  const text = cleanText(value, Math.max(maxLength * 2, 1200))
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/([,.;:])\1+/g, "$1");
  if (text.length <= maxLength) return text;
  const candidate = text.slice(0, maxLength);
  const sentenceEnd = Math.max(candidate.lastIndexOf(". "), candidate.lastIndexOf("; "));
  const wordEnd = candidate.lastIndexOf(" ");
  const end = sentenceEnd >= Math.floor(maxLength * 0.58) ? sentenceEnd + 1 : wordEnd;
  return `${candidate.slice(0, Math.max(1, end)).trim()}…`;
}

function humanizeCloudEvidenceSentence(value) {
  const text = cleanText(value, 700)
    .replace(/\b(?:the\s+)?subject\s+[a-z]'s\b/gi, "your")
    .replace(/\b(?:the\s+)?subject\s+[a-z]\b/gi, "you")
    .replace(/\b(?:the\s+)?subject's\b/gi, "your")
    .replace(/\b(?:the\s+)?subject\s+is\b/gi, "you are")
    .replace(/\b(?:the\s+)?subject\s+has\b/gi, "you have")
    .replace(/\b(?:the\s+)?subject\b/gi, "you")
    .replace(/\btheir\b/gi, "your")
    .replace(/\bthey\s+are\b/gi, "you are")
    .replace(/\bthey\b/gi, "you")
    .replace(/\byou\s+interacts\b/gi, "you interact")
    .replace(/\byou\s+continues\b/gi, "you continue")
    .replace(/\byou\s+remains\b/gi, "you remain")
    .replace(/\byou\s+holds\b/gi, "you hold")
    .replace(/\byou\s+moves\b/gi, "you move")
    .replace(/\byou\s+rests\b/gi, "you rest")
    .replace(/\byou\s+uses\b/gi, "you use")
    .replace(/\byou\s+adjusts\b/gi, "you adjust")
    .replace(/\byou\s+engages\b/gi, "you engage")
    .replace(/\byou\s+appears\b/gi, "you appear")
    .replace(/\byou\s+appear\s+you\s+are\b/gi, "you appear to be")
    .replace(/\s+([,.;:])/g, "$1")
    .replace(/([,.;:])\1+/g, "$1")
    .trim();
  return text ? `${text.charAt(0).toUpperCase()}${text.slice(1)}` : "";
}

function usefulCloudEvidenceItems(values = [], { keepStable = false } = {}) {
  const seen = new Set();
  return cloudArray(values)
    .filter((value) => !/\b(?:the\s+)?subject\s+[a-z](?:'s)?\b/i.test(String(value || "")))
    .map(humanizeCloudEvidenceSentence)
    .filter(Boolean)
    .filter((text) => keepStable || !/\b(?:continue|continues|remain|remains|no significant (?:change|changes)|no other significant changes?|no other changes? observed)\b/i.test(text))
    .filter((text) => !/\bheart rate\b/i.test(text))
    .filter((text) => {
      const key = text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
      if (!key || seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .map((text) => /[.!?]$/.test(text) ? text : `${text}.`);
}

function cloudCandidateEvidenceText(item = {}) {
  if (String(item?.provenance?.modality || "").toLowerCase() === "audio") {
    return humanizeCloudEvidenceSentence(item.basis || item.summary || item.label);
  }

  const visual = item.visual_evidence || {};
  const changes = usefulCloudEvidenceItems(visual.change_across_frames);
  const actions = usefulCloudEvidenceItems(visual.actions);
  const direct = [...changes, ...actions].slice(0, 4);
  const audio = cloudArray(item.audio_candidates)
    .filter((candidate) => candidate?.label)
    .slice(0, 3)
    .map((candidate) => `${candidate.label}${candidate.confidence_band ? ` (${candidate.confidence_band})` : ""}`);

  const parts = [];
  if (direct.length) parts.push(direct.join(" "));
  else if (Object.keys(visual).length) parts.push("No reliable visual change was extracted for synthesis in this window.");
  else parts.push(humanizeCloudEvidenceSentence(item.review_summary || item.basis || item.summary || item.label));
  if (audio.length) parts.push(`Audio cues in this window: ${audio.join(", ")}.`);
  return compactCloudEvidenceText(parts.filter(Boolean).join(" "), 620);
}

function cloudCandidatePhysiology(item = {}) {
  const physiology = item.physiology || {};
  const heartRate = physiology.heart_rate_bpm;
  const rmssd = physiology.rmssd_ms;
  const bloodPressure = cloudArray(physiology.blood_pressure)[0];
  const pulseOx = cloudArray(physiology.pulse_ox)[0];
  const parts = [
    heartRate?.samples ? `HR ${heartRate.avg} avg (${heartRate.min}-${heartRate.max})` : null,
    rmssd?.samples ? `RMSSD ${rmssd.avg} ms avg` : null,
    bloodPressure?.systolic_mm_hg && bloodPressure?.diastolic_mm_hg
      ? `BP ${bloodPressure.systolic_mm_hg}/${bloodPressure.diastolic_mm_hg}`
      : null,
    pulseOx?.spo2_percent ? `SpO2 ${pulseOx.spo2_percent}%` : null,
    cloudArray(physiology.howl_changes).length ? `${physiology.howl_changes.length} Howl change${physiology.howl_changes.length === 1 ? "" : "s"}` : null,
  ].filter(Boolean);
  return parts.join(", ");
}

function selectCloudCandidates(result = {}, limit = 18) {
  const candidates = cloudArray(result.strong_candidates)
    .slice()
    .sort((a, b) => Number(a?.start_ms || 0) - Number(b?.start_ms || 0));
  if (candidates.length <= limit) return candidates;
  const audio = candidates.filter((item) => String(item?.provenance?.modality || "").toLowerCase() === "audio");
  const visual = candidates.filter((item) => String(item?.provenance?.modality || "").toLowerCase() !== "audio");
  const visualSlots = Math.max(1, limit - Math.min(audio.length, Math.ceil(limit / 3)));
  const selectedVisual = Array.from({ length: Math.min(visualSlots, visual.length) }, (_, index) => {
    const position = visualSlots === 1 ? 0 : Math.round((index * (visual.length - 1)) / (visualSlots - 1));
    return visual[position];
  });
  return [...selectedVisual, ...audio.slice(0, Math.max(0, limit - selectedVisual.length))]
    .sort((a, b) => Number(a?.start_ms || 0) - Number(b?.start_ms || 0));
}

export function buildCloudMultimodalEvidenceDigest(record, { analysisField = "ai_analysis", limit = 18 } = {}) {
  const passes = cloudArray(record?.[analysisField]?.cloud_multimodal_passes);
  if (!passes.length) return "";
  const pass = passes[0];
  const result = pass?.result || {};
  if (!result.ok) return "";
  const offsetSeconds = Number(pass?.source_video?.source_zero_session_ms || 0) / 1000;
  const sourceName = pass?.source_video?.filename || "linked session video";
  const candidates = selectCloudCandidates(result, limit);
  const seenEvidence = new Set();
  const lines = candidates.map((item) => {
    const time = Math.max(0, Number(item.start_ms || 0) / 1000 + offsetSeconds);
    const modality = String(item?.provenance?.modality || "visual").toLowerCase();
    const label = modality === "audio"
      ? String(item.label || "audio activity").replace(/^audio_/, "").replace(/_/g, " ")
      : "visual review";
    const evidence = cloudCandidateEvidenceText(item);
    const evidenceKey = `${modality}|${evidence.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}`;
    if (seenEvidence.has(evidenceKey)) return null;
    seenEvidence.add(evidenceKey);
    const physiology = cloudCandidatePhysiology(item);
    return `- [${formatClockTime(time)}; ${modality} candidate; ${label}] ${evidence}${physiology ? ` Locally aligned physiology: ${physiology}.` : ""}`;
  }).filter(Boolean);
  const omitted = Math.max(0, cloudArray(result.strong_candidates).length - lines.length);
  return [
    `Saved cloud multimodal evidence from ${sourceName}: ${compactCloudEvidenceText(result.summary, 500)}`,
    "Synthesis rule: these are supporting candidates, not accepted facts. Use them quietly to strengthen the normal Sarah interpretation. Do not quote this evidence block or copy its labels into the report. Prefer accepted Sarah cards and manual notes, cross-check against telemetry, preserve uncertainty, and write the final result in natural human language.",
    ...lines,
    omitted ? `- ${omitted} additional lower-priority cloud candidates remain saved on the record and were omitted from this prompt digest.` : null,
  ].filter(Boolean).join("\n");
}

export function buildSessionVideoPassDigest(session, { limit = 14, findingsPerCard = 4, eventsPerCard = 3 } = {}) {
  const entries = normalizeSessionVideoPassFindings(session).slice(0, limit);
  const lines = entries.map((entry) => {
    const videoLabel = entry.source_video.label || entry.source_video.filename || "linked local video";
    const findings = entry.findings.slice(0, findingsPerCard);
    const events = entry.draft_events.slice(0, eventsPerCard);
    const parts = [
      `- [${formatVideoPassRange(entry)}; ${videoLabel}] ${entry.summary}`,
    ];
    if (findings.length) parts.push(`Findings: ${findings.join(" | ")}`);
    if (events.length) {
      parts.push(`Draft Video Sync events: ${events.map((event) => `${formatTimePhrase(event.time_s)} - ${event.note}${event.confidence ? ` (${event.confidence} confidence)` : ""}`).join(" | ")}`);
    }
    if (entry.telemetry) parts.push(`Telemetry: ${entry.telemetry}`);
    return parts.filter(Boolean).join(" ");
  });
  const fallback = !lines.length ? cleanText(session?.ai_analysis?._video_pass_digest || "", 6000) : "";
  const reviewed = lines.length
    ? `Sarah video-pass findings applied to this session:\n${lines.join("\n")}`
    : isStalePhaseMarkerReference({ text: fallback }, session) ? "" : fallback;
  const cloud = buildCloudMultimodalEvidenceDigest(session, { analysisField: "ai_analysis" });
  return [reviewed, cloud].filter(Boolean).join("\n\n");
}

const LOWER_BODY_CLIP_SOURCE_RE = /(?:^|[^a-z0-9])(feet|foot|toe|toes|heel|heels|sole|soles|lower[-_\s]?body|lower[-_\s]?cam|legs?)(?:$|[^a-z0-9])/i;

function clipSourceLooksLowerBody(clip) {
  const text = [
    clip?.source_video_label,
    clip?.sourceVideoLabel,
    clip?.filename,
    clip?.url,
    clip?.clip_url,
    clip?.file_url,
  ].filter(Boolean).join(" ").toLowerCase();
  return LOWER_BODY_CLIP_SOURCE_RE.test(text);
}

function cameraAngleRank(cameraAngle) {
  const angle = String(cameraAngle || "").toLowerCase();
  if (angle === "composite" || angle === "main" || angle === "primary") return 0;
  if (angle === "lower_body" || angle === "feet" || angle === "foot") return 2;
  return 1;
}

function normalizeKeyVideoClip(clip, sourceLabel = "", index = 0) {
  if (!clip) return null;
  const start = Number(clip.startSeconds ?? clip.start_s);
  const end = Number(clip.endSeconds ?? clip.end_s);
  const sessionTime = Number(clip.session_time_s ?? clip.time_s);
  const url = clip.url || clip.clip_url || clip.file_url || "";
  const rawCameraAngle = clip.camera_angle || "";
  const cameraAngle = rawCameraAngle === "primary" && clipSourceLooksLowerBody(clip)
    ? "lower_body"
    : rawCameraAngle;
  return {
    id: clip.id || `${sourceLabel || "key-clip"}-${index}`,
    label: cleanText(clip.label || "Saved key video moment", 160),
    reason: cleanText(clip.reason || "", 500),
    session_time_s: Number.isFinite(sessionTime) ? sessionTime : null,
    camera_angle: cameraAngle,
    source_video_label: clip.source_video_label || clip.sourceVideoLabel || "",
    source_video_fingerprint: clip.source_video_fingerprint || clip.sourceVideoFingerprint || "",
    timeline_offset_s: Number(clip.timeline_offset_s || 0),
    url,
    clip_url: clip.clip_url || url,
    file_url: clip.file_url || url,
    filename: clip.filename || "",
    startSeconds: Number.isFinite(start) ? start : null,
    endSeconds: Number.isFinite(end) ? end : null,
    durationSeconds: Number(clip.durationSeconds || clip.duration_s || (Number.isFinite(start) && Number.isFinite(end) ? end - start : 0)) || null,
    motion_summary: clip.motion_summary || clip.motionSummary || null,
    frames: Array.isArray(clip.frames) ? clip.frames : [],
    source_panel: sourceLabel,
  };
}

function clipMatchesExplicitPhaseMarker(clip, target) {
  if (!clip) return false;
  const text = [
    clip.label,
    clip.reason,
    clip.note,
    clip.text,
    clip.description,
  ].filter(Boolean).join(" ");
  return phaseTargetFromText(text) === target && /\bmarker\b/i.test(text);
}

function buildSyntheticPhaseMarkerClips(session = {}, rawClips = []) {
  const markers = currentSessionPhaseMarkers(session);
  const specs = [
    {
      target: "pre_climax",
      time: markers.pre_climax,
      label: "Pre-climax marker",
      reason: "Saved pre-climax marker from this session timeline.",
    },
    {
      target: "climax",
      time: markers.climax,
      label: "Climax / orgasm marker",
      reason: "Saved climax or orgasm marker from this session timeline.",
    },
    {
      target: "recovery",
      time: markers.recovery,
      label: "Recovery marker",
      reason: "Saved recovery marker from this session timeline.",
    },
  ];
  return specs
    .filter((spec) => spec.time != null)
    .filter((spec) => !rawClips.some((clip) => clipMatchesExplicitPhaseMarker(clip, spec.target)))
    .map((spec) => ({
      id: `session-phase-marker-${spec.target}`,
      label: spec.label,
      reason: spec.reason,
      session_time_s: spec.time,
      camera_angle: "primary",
      source_panel: "session_phase_markers",
      synthetic_phase_marker: true,
      frames: [],
      url: "",
      clip_url: "",
      file_url: "",
      filename: "",
    }));
}

function eventTextMatchesKeyMoment(event = {}) {
  const categories = Array.isArray(event.category) ? event.category : [event.category].filter(Boolean);
  const categoryText = categories.join(" ").toLowerCase();
  const text = [
    event.note,
    event.label,
    event.description,
    event.text,
    categoryText,
  ].filter(Boolean).join(" ").toLowerCase();
  if (categories.some((category) => ["pre_climax", "climax", "recovery"].includes(String(category)))) return true;
  return /\b(pre[-\s]?climax|near[-\s]?orgasm|near[-\s]?climax|orgasm|ejaculat|emission|expulsion|release|climax|recovery)\b/i.test(text);
}

function labelForSyntheticEventMoment(event = {}) {
  const text = cleanText(event.note || event.label || event.description || event.text || "Saved session moment", 90);
  if (text) return text;
  const categories = Array.isArray(event.category) ? event.category : [event.category].filter(Boolean);
  if (categories.includes("pre_climax")) return "Pre-climax event";
  if (categories.includes("climax")) return "Climax / orgasm event";
  if (categories.includes("recovery")) return "Recovery event";
  return "Saved session moment";
}

function buildSyntheticEventMomentClips(session = {}, rawClips = []) {
  const clips = [];
  const events = sessionEventsForCurrentPhaseMarkers(session);
  for (const event of events) {
    const time = markerNumber(event.time_s ?? event.offset_s ?? event.timestamp_s);
    if (time == null || !eventTextMatchesKeyMoment(event)) continue;
    const text = [
      event.note,
      event.label,
      event.description,
      event.text,
    ].filter(Boolean).join(" ");
    const alreadyCovered = rawClips.some((clip) => {
      const clipTime = markerNumber(clip.session_time_s ?? clip.time_s ?? clip.startSeconds ?? clip.start_s ?? clip.offset_s);
      if (clipTime == null || Math.abs(clipTime - time) > 8) return false;
      const clipText = [clip.label, clip.reason, clip.note, clip.text, clip.description].filter(Boolean).join(" ");
      return clipText && text && clipText.toLowerCase().includes(text.toLowerCase().slice(0, 24));
    });
    if (alreadyCovered) continue;
    clips.push({
      id: `session-event-marker-${time}-${clips.length}`,
      label: labelForSyntheticEventMoment(event),
      reason: cleanText(event.note || event.description || "Saved event timeline moment from this session.", 220),
      session_time_s: time,
      camera_angle: "primary",
      source_panel: "session_event_timeline",
      synthetic_phase_marker: true,
      frames: [],
      url: "",
      clip_url: "",
      file_url: "",
      filename: "",
    });
  }
  return clips;
}

export function normalizeSessionKeyVideoClips(sessionOrClips) {
  const hasSessionContext = !Array.isArray(sessionOrClips) && sessionOrClips && typeof sessionOrClips === "object";
  const rawClips = Array.isArray(sessionOrClips)
    ? sessionOrClips
    : [
      ...(sessionOrClips?.ai_analysis?._meta?.key_video_clips || []),
      ...(sessionOrClips?.ai_session_deep_dive?._meta?.key_video_clips || []),
      ...(sessionOrClips?.ai_cascade?._meta?.key_video_clips || []),
      ...(sessionOrClips?.ai_body_exploration?._meta?.key_video_clips || []),
    ];
  const sourceClips = hasSessionContext
    ? [
      ...rawClips,
      ...buildSyntheticPhaseMarkerClips(sessionOrClips, rawClips),
      ...buildSyntheticEventMomentClips(sessionOrClips, rawClips),
    ]
    : rawClips;
  const seen = new Set();
  return sourceClips
    .map((clip, index) => normalizeKeyVideoClip(clip, clip?.source_panel || "", index))
    .filter((clip) => clip && (clip.url || clip.frames.length || clip.label))
    .filter((clip) => !hasSessionContext || !isStalePhaseMarkerReference(clip, sessionOrClips))
    .filter((clip) => {
      const key = [
        clip.url || clip.filename || clip.id,
        clip.session_time_s ?? "",
        clip.camera_angle || "",
        clip.label.toLowerCase(),
      ].join("|");
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => {
      const at = a.session_time_s ?? Number.POSITIVE_INFINITY;
      const bt = b.session_time_s ?? Number.POSITIVE_INFINITY;
      if (at !== bt) return at - bt;
      const ar = cameraAngleRank(a.camera_angle);
      const br = cameraAngleRank(b.camera_angle);
      if (ar !== br) return ar - br;
      return String(a.label).localeCompare(String(b.label));
    });
}

export function buildSessionKeyVideoClipDigest(session, { limit = 12 } = {}) {
  const clips = normalizeSessionKeyVideoClips(session).slice(0, limit);
  if (!clips.length) return "";
  const lines = clips.map((clip) => {
    const sessionTime = clip.session_time_s != null ? `session moment ${formatTimePhrase(clip.session_time_s)}` : "session moment not specified";
    const source = [clip.source_video_label, clip.camera_angle].filter(Boolean).join(", ");
    const range = clip.startSeconds != null && clip.endSeconds != null
      ? `source clip ${formatTimePhrase(clip.startSeconds)} to ${formatTimePhrase(clip.endSeconds)}`
      : "source clip range not specified";
    const frames = clip.frames.length ? `${clip.frames.length} sampled frames available for direct visual Q&A` : "playable clip available; sampled frames may require regenerating the analysis";
    return `- [${clip.label}; ${sessionTime}; ${source || "linked local video"}; ${range}] ${clip.reason || "Saved as a key session moment."} ${frames}.`;
  });
  return `Saved key video clips for this session:\n${lines.join("\n")}`;
}

export function buildBodyExplorationVideoPassDigest(exploration, { limit = 28, findingsPerCard = 4, eventsPerCard = 3 } = {}) {
  const entries = normalizeBodyExplorationVideoPassFindings(exploration).slice(0, limit);
  const lines = entries.map((entry) => {
    const videoLabel = entry.source_video.label || entry.source_video.filename || "linked local video";
    const findings = entry.findings.slice(0, findingsPerCard);
    const events = entry.draft_events.slice(0, eventsPerCard);
    const parts = [
      `- [${formatVideoPassRange(entry)}; ${videoLabel}] ${entry.summary}`,
    ];
    if (findings.length) parts.push(`Findings: ${findings.join(" | ")}`);
    if (events.length) {
      parts.push(`Draft exploration timeline events: ${events.map((event) => `${formatTimePhrase(event.time_s)} - ${event.note}${event.confidence ? ` (${event.confidence} confidence)` : ""}`).join(" | ")}`);
    }
    if (entry.telemetry) parts.push(`Telemetry: ${entry.telemetry}`);
    return parts.filter(Boolean).join(" ");
  });
  const reviewed = lines.length
    ? `Sarah video-pass findings applied to this body exploration:\n${lines.join("\n")}`
    : cleanText(exploration?.ai_body_exploration?._video_pass_digest || "", 6000);
  const cloud = buildCloudMultimodalEvidenceDigest(exploration, { analysisField: "ai_body_exploration" });
  return [reviewed, cloud].filter(Boolean).join("\n\n");
}

export function buildBodyExplorationVisualEvidenceDigest(exploration, { limit = 12 } = {}) {
  const entries = normalizeBodyExplorationVisualEvidence(exploration).slice(0, limit);
  if (!entries.length) return "";
  const lines = entries.flatMap((entry) => {
    const sourceLabel = entry.source.includes("video") ? "video/frame sequence" : entry.source.includes("image") ? "image" : "visual review";
    const status = entry.needs_review ? "review candidate" : entry.persistence_status || "recommended";
    const mediaContext = formatMediaContext(entry);
    return entry.findings.slice(0, 6).map((finding) => (
      `- [${entry.date}; Sarah ${sourceLabel}; ${status}] ${finding}${mediaContext}`
    ));
  });
  return lines.length ? `Reviewed Sarah visual evidence for this body exploration:\n${lines.join("\n")}` : "";
}

export function getReviewedVisualClips(entries = []) {
  const seen = new Set();
  return normalizeVisualEvidenceEntries(entries, { fallbackSource: "session_sarah_visual_review" })
    .flatMap((entry) => Array.isArray(entry.media_context?.videos) ? entry.media_context.videos.map((video) => ({ ...video, evidenceDate: entry.date, evidenceSource: entry.source })) : [])
    .filter((video) => video.processedClipUrl)
    .filter((video) => {
      const key = `${video.processedClipUrl}|${video.startSeconds}|${video.endSeconds}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}
