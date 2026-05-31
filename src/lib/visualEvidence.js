import { richTextToPlainText } from "@/lib/richText";

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
        ? `${Number(video.startSeconds).toFixed(1)}-${Number(video.endSeconds).toFixed(1)}s`
        : "";
      const timelineRange = video.timelineStartSeconds != null && video.timelineEndSeconds != null
        ? `, ${video.timelineLabel || "session timeline"} ${Number(video.timelineStartSeconds).toFixed(1)}-${Number(video.timelineEndSeconds).toFixed(1)}s`
        : "";
      const label = video.label || video.filename || "video clip";
      const frames = video.frameTimes?.length ? ` frames at ${video.frameTimes.join(", ")}s` : "";
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
