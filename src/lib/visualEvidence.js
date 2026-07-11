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
    telemetry: cleanText(card.telemetry, 400),
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

export function buildSessionVideoPassDigest(session, { limit = 14, findingsPerCard = 4, eventsPerCard = 3 } = {}) {
  const entries = normalizeSessionVideoPassFindings(session).slice(0, limit);
  if (!entries.length) {
    const fallback = cleanText(session?.ai_analysis?._video_pass_digest || "", 6000);
    return isStalePhaseMarkerReference({ text: fallback }, session) ? "" : fallback;
  }
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
  return lines.length ? `Sarah video-pass findings applied to this session:\n${lines.join("\n")}` : "";
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

export function normalizeSessionKeyVideoClips(sessionOrClips) {
  const hasSessionContext = !Array.isArray(sessionOrClips) && sessionOrClips && typeof sessionOrClips === "object";
  const rawClips = Array.isArray(sessionOrClips)
    ? sessionOrClips
    : [
      ...(sessionOrClips?.ai_analysis?._meta?.key_video_clips || []),
      ...(sessionOrClips?.ai_session_deep_dive?._meta?.key_video_clips || []),
      ...(sessionOrClips?.ai_cascade?._meta?.key_video_clips || []),
    ];
  const sourceClips = hasSessionContext
    ? [...rawClips, ...buildSyntheticPhaseMarkerClips(sessionOrClips, rawClips)]
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
  if (!entries.length) return cleanText(exploration?.ai_body_exploration?._video_pass_digest || "", 6000);
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
  return lines.length ? `Sarah video-pass findings applied to this body exploration:\n${lines.join("\n")}` : "";
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
