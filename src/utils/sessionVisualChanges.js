import { isFootOfTableCamera, normalizeFootCameraLateralityText } from "./anatomicalLaterality.js";

const CHANGE_PATTERN = /\b(?:becomes?|forms?|formation|develops?|increas(?:e|es|ed|ing)|decreas(?:e|es|ed|ing)|deepens?|flush(?:es|ed|ing)?|engorg(?:es|ed|ement|ing)?|darkens?|swells?|lifts?|retract(?:s|ed|ion)?|tightens?|loosens?|shifts?|changes?|transitions?|curls?|flex(?:es|ed|ion)?|extends?|plants?|braces?|tenses?|clenches?|trembl(?:e|es|ed|ing)|shak(?:e|es|ing)|spasm(?:s|ing)?|throbs?|pulses?|accelerates?|slows?|resumes?|pauses?|stops?|starts?|contact\s+(?:begins|ends)|withdraw(?:s|al)?|insert(?:s|ion)?|leak(?:s|age)?|ejaculat(?:es|ion)|pre[-\s]?ejaculat)\b/i;
const NON_CHANGE_PATTERN = /\b(?:no\s+(?:visible\s+)?change|no\b.{0,48}\b(?:tension|tensing|bracing|curl|movement|activity|shift)|remains?\s+(?:stable|unchanged|flat|relaxed)|stays?\s+(?:stable|unchanged)|not\s+visible|cannot\s+be\s+assessed)\b/i;

function numberOrNull(value) {
  const number = Number(value);
  return value !== null && value !== "" && Number.isFinite(number) ? number : null;
}

function frameTime(frame = {}) {
  return numberOrNull(frame.recordTimeSeconds ?? frame.sessionTimeSeconds ?? frame.frameTimelineSeconds ?? frame.frameTimeSeconds);
}

function frameUrl(frame = {}) {
  return frame.original_url || frame.full_url || frame.high_resolution_url || frame.url || frame.file_url || "";
}

function sourceFrameTime(frame = {}, pass = {}, fallbackTimeS = 0) {
  const explicit = numberOrNull(frame.frameTimeSeconds ?? frame.sourceTimeSeconds ?? frame.source_time_s);
  if (explicit != null) return explicit;
  const sessionTime = frameTime(frame) ?? fallbackTimeS;
  const sourceZeroSessionMs = numberOrNull(pass.source_video?.source_zero_session_ms ?? pass.source_zero_session_ms);
  return sourceZeroSessionMs != null ? Math.max(0, sessionTime - (sourceZeroSessionMs / 1000)) : sessionTime;
}

function nativeStillUrl(pass = {}, frame = {}, fallbackTimeS = 0) {
  const filename = String(pass.source_video?.filename || "").trim();
  if (!filename) return "";
  const params = new URLSearchParams({
    filename,
    time: String(sourceFrameTime(frame, pass, fallbackTimeS)),
  });
  const fingerprint = String(pass.source_video?.fingerprint || "").trim();
  if (fingerprint) params.set("fingerprint", fingerprint);
  return `/api/files/local-video/still?${params.toString()}`;
}

export function visualChangeFocus(text = "") {
  const value = String(text || "").toLowerCase();
  if (/\b(?:scrot\w*|testic\w*|penis|shaft|glans|corona|foreskin|meatus|genital|erection|pre[-\s]?ejaculat|ejaculat)\b/.test(value)) {
    return { label: /\b(?:scrot\w*|testic\w*)/.test(value) ? "Scrotal area" : "Genital area", origin: "50% 68%", scale: 2.35 };
  }
  if (/\byour left (?:foot|sole|heel|toes?)\b/.test(value)) {
    return { label: "Your left foot", origin: "76% 60%", scale: 2.2 };
  }
  if (/\byour right (?:foot|sole|heel|toes?)\b/.test(value)) {
    return { label: "Your right foot", origin: "24% 60%", scale: 2.2 };
  }
  if (/\b(?:foot|feet|sole|heel|toe|lower body|leg|thigh|knee)\b/.test(value)) {
    return { label: "Lower body", origin: "50% 58%", scale: 2 };
  }
  if (/\b(?:abdomen|chest|torso|skin|pelvis|hip|body)\b/.test(value)) {
    return { label: "Body area", origin: "50% 50%", scale: 1.9 };
  }
  return { label: "Area of interest", origin: "50% 50%", scale: 1.8 };
}

function nearestFrame(pass = {}, timeS) {
  const frames = Array.isArray(pass.sampled_frames || pass.sampledFrames) ? (pass.sampled_frames || pass.sampledFrames) : [];
  const usable = frames.filter((frame) => frameUrl(frame));
  if (!usable.length) {
    const fallback = pass.clip?.thumbnail_url || pass.thumbnailUrl || "";
    return fallback ? { url: fallback, recordTimeSeconds: timeS } : null;
  }
  return usable.reduce((best, frame) => {
    const bestDistance = Math.abs((frameTime(best) ?? timeS) - timeS);
    const distance = Math.abs((frameTime(frame) ?? timeS) - timeS);
    return distance < bestDistance ? frame : best;
  }, usable[0]);
}

function nearestTimelineRow(rows = [], timeS) {
  const usable = rows.filter((row) => numberOrNull(row.time_offset_s) != null);
  if (!usable.length) return null;
  return usable.reduce((best, row) => (
    Math.abs(Number(row.time_offset_s) - timeS) < Math.abs(Number(best.time_offset_s) - timeS) ? row : best
  ), usable[0]);
}

function telemetryForMoment(pass = {}, timelineRows = [], timeS) {
  const row = nearestTimelineRow(timelineRows, timeS);
  const saved = pass.telemetry?.nearest_sample_to_center || pass.telemetry?.nearest || {};
  return {
    hr: numberOrNull(row?.hr ?? saved.hr_bpm),
    baseline: numberOrNull(row?.baseline_hr ?? saved.baseline_hr_bpm),
    rmssd: numberOrNull(row?.hrv_rmssd_ms ?? saved.hrv_rmssd_ms),
    sdnn: numberOrNull(row?.hrv_sdnn_ms ?? saved.hrv_sdnn_ms),
    hrvQuality: row?.hrv_quality || saved.hrv_quality || "",
    respiration: numberOrNull(row?.respiration_bpm ?? saved.respiration_bpm),
    motion: row?.motion_class || saved.motion_class || "",
  };
}

function cleanLaterality(text, pass) {
  const value = String(text || "");
  return isFootOfTableCamera(pass) || /\b(?:screen|viewer(?:'s)?)[-\s]?(?:left|right)\s+(?:foot|sole|heel|toes?|leg|knee|thigh|ankle)\b/i.test(value)
    ? normalizeFootCameraLateralityText(value)
    : value;
}

function isNoteworthyChange(text) {
  return CHANGE_PATTERN.test(text) && !NON_CHANGE_PATTERN.test(text);
}

export function buildHighConfidenceVisualChanges(session = {}, timelineRows = []) {
  const passes = Array.isArray(session.ai_analysis?._video_pass_findings)
    ? session.ai_analysis._video_pass_findings
    : [];
  const changes = [];
  const seen = new Set();

  passes.forEach((pass, passIndex) => {
    const clipStart = numberOrNull(pass.clip?.start_s ?? pass.window?.start) ?? 0;
    const clipEnd = numberOrNull(pass.clip?.end_s ?? pass.window?.end) ?? clipStart;
    const events = Array.isArray(pass.draft_events || pass.events) ? (pass.draft_events || pass.events) : [];
    const highEvents = events.filter((event) => String(event?.confidence || "").toLowerCase() === "high");
    const rawFindings = Array.isArray(pass.findings) ? pass.findings : [];
    const highFindings = rawFindings.filter((finding) => (
      typeof finding === "object" && String(finding?.confidence || "").toLowerCase() === "high"
    ));
    const eventCandidates = [
      ...highEvents.map((event) => ({
        timeS: numberOrNull(event.time_s) ?? ((clipStart + clipEnd) / 2),
        title: event.label || (Array.isArray(event.annotation_tags) ? event.annotation_tags[0] : "") || "Visual change",
        text: event.note || event.text || "",
        confidence: "high",
        category: Array.isArray(event.category) ? event.category.join(", ") : event.category || "visual",
      })),
    ];
    const findingCandidates = [
      ...highFindings.map((finding) => ({
        timeS: (clipStart + clipEnd) / 2,
        title: finding.title || "Visual change",
        text: finding.text || finding.findingText || finding.finding || "",
        confidence: "high",
        category: finding.category || "visual",
      })),
    ];
    const candidates = eventCandidates.length ? eventCandidates : findingCandidates.slice(0, 2);

    candidates.forEach((candidate, candidateIndex) => {
      const text = cleanLaterality(candidate.text, pass).replace(/\s+/g, " ").trim();
      const title = cleanLaterality(candidate.title, pass).replace(/_/g, " ").replace(/\s+/g, " ").trim();
      if (!text || !isNoteworthyChange(`${title} ${text}`)) return;
      const key = `${Math.round(candidate.timeS)}|${text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}`;
      if (seen.has(key)) return;
      seen.add(key);
      const frame = nearestFrame(pass, candidate.timeS);
      const focus = visualChangeFocus(`${title} ${text}`);
      changes.push({
        id: `${pass.id || `pass-${passIndex}`}-change-${candidateIndex}`,
        timeS: candidate.timeS,
        clipStart,
        clipEnd,
        title: title || focus.label,
        overview: text,
        confidence: candidate.confidence,
        category: candidate.category,
        camera: pass.source_video_role || pass.source_video?.label || pass.source_video?.filename || "",
        imageUrl: frameUrl(frame),
        highResolutionImageUrl: nativeStillUrl(pass, frame, candidate.timeS),
        frameTimeS: frameTime(frame) ?? candidate.timeS,
        sourceFrameTimeS: sourceFrameTime(frame, pass, candidate.timeS),
        focus,
        telemetry: telemetryForMoment(pass, timelineRows, candidate.timeS),
      });
    });
  });

  // The 10-second audit is a reference ledger, not an event stream. Promote
  // only its high-confidence directional moments (or a visually corroborated
  // approach flag) into Session Details, where they can be reviewed alongside
  // the accepted video-pass findings without flooding the page.
  const snapshots = Array.isArray(session.ai_analysis?._visual_snapshot_reviews)
    ? session.ai_analysis._visual_snapshot_reviews
    : [];
  snapshots.forEach((snapshot, snapshotIndex) => {
    if (snapshot?.body_visible === false) return;
    const timeS = numberOrNull(snapshot?.time_s);
    if (timeS == null) return;
    const snapshotChanges = Array.isArray(snapshot?.significant_changes) ? snapshot.significant_changes : [];
    const meaningful = snapshotChanges.filter((change) => (
      ["increasing", "decreasing", "new", "released"].includes(String(change?.direction || "").toLowerCase())
      && String(change?.confidence || "").toLowerCase() === "high"
    ));
    if (!meaningful.length && snapshot?.possible_near_climax !== true) return;
    const title = snapshot?.possible_near_climax
      ? "Visual approach pattern"
      : meaningful.map((change) => `${change.anatomical_area || "Body"}: ${change.label || "change"}`).slice(0, 2).join(" · ");
    const overview = snapshot?.possible_near_climax && snapshot?.near_climax_reason
      ? snapshot.near_climax_reason
      : [snapshot?.summary, ...meaningful.map((change) => change?.label)].filter(Boolean).join(" ");
    const text = cleanLaterality(`${title} ${overview}`, { source_video_role: snapshot?.source_video_role });
    if (!text || !isNoteworthyChange(text)) return;
    const key = `${Math.round(timeS)}|${text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim()}`;
    if (seen.has(key)) return;
    seen.add(key);
    const frame = snapshot?.sampled_frame || {};
    const imageUrl = snapshot?.thumbnail_url || frame.url || "";
    const focus = visualChangeFocus(text);
    changes.push({
      id: snapshot?.id || `audit-snapshot-${snapshotIndex}-${Math.round(timeS)}`,
      timeS,
      clipStart: Math.max(0, timeS - Number(snapshot?.comparison_lead_seconds || 1.2)),
      clipEnd: timeS,
      title: title || focus.label,
      overview,
      confidence: "high",
      category: "visual_audit",
      camera: snapshot?.source_video?.label || snapshot?.source_video_role || "Visual audit",
      imageUrl,
      highResolutionImageUrl: "",
      frameTimeS: numberOrNull(frame.recordTimeSeconds ?? frame.frameTimeSeconds) ?? timeS,
      sourceFrameTimeS: numberOrNull(frame.frameTimeSeconds) ?? timeS,
      focus,
      telemetry: telemetryForMoment({ telemetry: snapshot?.telemetry }, timelineRows, timeS),
      comparisonImageUrl: snapshot?.comparison_frame?.url || "",
      comparisonTimeS: numberOrNull(snapshot?.comparison_frame?.recordTimeSeconds),
      significantChanges: meaningful,
    });
  });

  return changes.sort((a, b) => a.timeS - b.timeS || a.title.localeCompare(b.title));
}
