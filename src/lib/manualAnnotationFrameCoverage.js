const finite = (value) => {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : null;
};

export function manualAnnotationTargetFrameTimes(noteTimeS, { beforeS = 5, afterS = 5, stepS = 1, maxSessionTimeS = Infinity } = {}) {
  const center = Math.max(0, finite(noteTimeS) ?? 0);
  const start = Math.max(0, center - Math.max(0, finite(beforeS) ?? 5));
  const end = Math.min(maxSessionTimeS, center + Math.max(0, finite(afterS) ?? 5));
  const step = Math.max(0.25, finite(stepS) ?? 1);
  const times = [];
  for (let time = start; time <= end + 0.001; time += step) times.push(Number(time.toFixed(2)));
  if (!times.some((time) => Math.abs(time - center) < 0.01) && center <= end) times.push(Number(center.toFixed(2)));
  return [...new Set(times)].sort((left, right) => left - right);
}

export function sameVideoEvidenceSource(candidate = {}, video = {}) {
  const source = candidate?.source_video || candidate?.sourceVideo || {};
  const candidateRole = normalizeReviewCameraRole(candidate.source_video_role || source.role || candidate.camera_role);
  const videoRole = normalizeReviewCameraRole(video.role || video.camera_role || video.key);
  // A file may be assigned to more than one view. Camera identity takes
  // precedence over file identity; legacy evidence without a camera is ambiguous.
  if (!candidateRole || !videoRole || candidateRole !== videoRole) return false;
  const candidateOffset = finite(source.timelineOffsetSeconds ?? candidate.timelineOffsetSeconds) ?? 0;
  const videoOffset = finite(video.timelineOffsetSeconds) ?? 0;
  if (Math.abs(candidateOffset - videoOffset) > 0.01) return false;
  const candidatePath = String(source.path || "").replaceAll("\\", "/").toLowerCase();
  const videoPath = String(video.path || video.localPath || "").replaceAll("\\", "/").toLowerCase();
  if (candidatePath && videoPath && candidatePath !== videoPath) return false;
  const candidateFingerprint = String(source.fingerprint || candidate.source_video_fingerprint || "");
  const videoFingerprint = String(video.fingerprint || "");
  if (candidateFingerprint && videoFingerprint) return candidateFingerprint === videoFingerprint;
  if (candidatePath && videoPath) return candidatePath === videoPath;
  const candidateName = String(source.filename || source.label || candidate.source_video_filename || "").toLowerCase();
  const videoName = String(video.filename || video.label || "").toLowerCase();
  return Boolean(candidateName && videoName && candidateName === videoName);
}

export function normalizeReviewCameraRole(role) {
  const value = String(role || "").trim().toLowerCase();
  return ["lower_body", "lower-body", "foot"].includes(value) ? "feet" : value;
}

export function manualReviewEventKey(event = {}) {
  return String(event.event_id || event.id || `${event.time_s ?? event.note_time_s}:${event.note ?? event.manual_note}`);
}

export function findManualAnnotationReview(reviews = [], event = {}, video = {}) {
  return [...reviews].reverse().find((review) => (
    // Display belongs to the annotation and camera. Browser-local playback can
    // expose a filename while legacy reviews stored only a label like "Main".
    // Those labels must not hide a saved review. Coverage still uses the strict
    // file/offset matcher below before deciding whether to skip AI work.
    normalizeReviewCameraRole(review.source_video_role || review.source_video?.role) === normalizeReviewCameraRole(video.role || video.key)
    && Boolean(normalizeReviewCameraRole(video.role || video.key))
    && (!video.fingerprint || !review.source_video?.fingerprint || video.fingerprint === review.source_video.fingerprint)
    && (!event.event_id || !review.event_id || String(event.event_id) === String(review.event_id))
    && Math.abs(Number(review.note_time_s) - Number(event.time_s)) <= 0.6
    && String(review.manual_note || "").trim() === String(event.note || "").trim()
  )) || null;
}

export function savedAnnotationReview(reviews = [], event = {}) {
  const matching = reviews.filter((review) => event.event_id
    ? String(review.event_id || '') === String(event.event_id)
    : Math.abs(Number(review.note_time_s) - Number(event.time_s)) <= 0.6
      && String(review.manual_note || '').trim() === String(event.note || '').trim());
  const requestedRole = normalizeReviewCameraRole(event.annotation_camera?.role || event.annotation_camera?.key);
  // Camera selection affects a NEW review, never which existing report is shown.
  // Prefer the original Main report for legacy notes if both views were saved.
  return [...matching].reverse().find((review) => normalizeReviewCameraRole(review.source_video_role || review.source_video?.role) === (requestedRole || 'main'))
    || matching.at(-1) || null;
}

export function annotationTimelineEntries(events = []) {
  return events.map((ev, i) => ({ ev, i })).sort((a, b) => Number(a.ev.time_s) - Number(b.ev.time_s) || a.i-b.i);
}

export function filterAnnotationTimeline(entries, reviews, filter = 'both') {
  if (filter === 'both') return entries;
  return entries.filter(({ ev }) => {
    const saved = savedAnnotationReview(reviews, ev);
    const role = annotationCameraRole(ev, reviews) || normalizeReviewCameraRole(saved?.source_video_role || saved?.source_video?.role);
    // Legacy unassigned entries stay available under Both, never reclassified.
    return filter === 'main' ? ['main', 'composite'].includes(role) : role === 'feet';
  });
}

export function annotationReviewFeed(event, reviews, feeds = {}, linked = [], active = null) {
  const review = savedAnnotationReview(reviews, event);
  const owner = event.annotation_camera || review?.source_video;
  const role = normalizeReviewCameraRole(owner?.role || owner?.key || review?.source_video_role);
  const key = role === 'feet' ? 'lower_body' : role;
  const storedPath = owner?.path || review?.source_video?.path;
  if (storedPath) return { key, localPath: storedPath, fileName: owner?.filename || review?.source_video?.filename, label: owner?.label || review?.source_video?.label || role, fingerprint: owner?.fingerprint || '', timelineOffsetSeconds: Number(owner?.timelineOffsetSeconds ?? review?.source_video?.timelineOffsetSeconds) || 0 };
  // Resolve legacy reviews against the saved original link, never a proxy URL.
  const original = linked.find(v => v.path && (
    normalizeReviewCameraRole(v.role || v.key || v.label) === role
    || (review?.source_video?.fingerprint && v.fingerprint === review.source_video.fingerprint && !v.role && !v.key)
  ));
  if (original) return { ...original, key, localPath: original.path, fileName: original.filename };
  if (key && feeds[key]?.localPath) return { ...feeds[key], key };
  return !role ? active : null;
}

export function annotationCameraRole(event = {}, reviews = []) {
  if (event.annotation_camera) return normalizeReviewCameraRole(event.annotation_camera.role || event.annotation_camera.key);
  // Legacy notes did not store ownership. Only recover an unambiguous camera
  // from this exact note's saved reviews; never classify by its words or time alone.
  const roles = new Set(reviews.filter((review) => (
    event.event_id && String(review.event_id || "") === String(event.event_id)
  )).map((review) => normalizeReviewCameraRole(review.source_video_role || review.source_video?.role)).filter(Boolean));
  return roles.size === 1 ? [...roles][0] : "";
}

export function annotationCameraFromFeed(feed = {}, fallbackOffset = 0) {
  return {
    key: feed.key || "",
    role: normalizeReviewCameraRole(feed.key),
    label: feed.label || feed.key || "",
    path: feed.localPath || "",
    fingerprint: feed.fingerprint || "",
    timelineOffsetSeconds: Number(feed.timelineOffsetSeconds ?? fallbackOffset) || 0,
  };
}

export function annotationBelongsToCamera(event, reviews, video) {
  const role = annotationCameraRole(event, reviews);
  return Boolean(role && role === normalizeReviewCameraRole(video.role || video.key));
}

export function cameraAnnotationEntries(events, reviews, video, scope = "camera") {
  return events.map((ev, i) => ({ ev, i })).filter(({ ev }) => {
    const manual = ["manual", "voice"].includes(ev.source);
    if (scope === "session") return !manual;
    if (scope === "unassigned") return manual && !annotationCameraRole(ev, reviews);
    return manual && annotationBelongsToCamera(ev, reviews, video);
  });
}

export function missingManualAnnotationEvents(events = [], reviews = [], video = {}) {
  const seen = new Set();
  return events.filter((event) => {
    if (!String(event?.note || "").trim() || !["manual", "voice"].includes(event.source)) return false;
    if (!annotationBelongsToCamera(event, reviews, video)) return false;
    const key = `${Number(event.time_s).toFixed(1)}:${String(event.note).trim().toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    const review = findManualAnnotationReview(reviews, event, video);
    // A skipped frame-reuse placeholder never assessed this annotation.
    // A completed review with no new changes IS complete and must not loop.
    return !review || review.coverage_status === "fully_reused";
  });
}

export function buildManualReviewBackfillPlan(events, reviews, feed, fallbackOffset = 0) {
  if (!feed?.localPath) return { feed: null, events: [] };
  const camera = {
    ...feed,
    role: normalizeReviewCameraRole(feed.key),
    filename: feed.fileName || feed.label || feed.key,
    timelineOffsetSeconds: Number(feed.timelineOffsetSeconds ?? fallbackOffset) || 0,
  };
  return {
    feed: camera,
    events: missingManualAnnotationEvents(events, reviews, camera).map((event) => ({ ...event })),
  };
}

export function mergeManualAnnotationReview(reviews = [], review) {
  const key = review.event_id || `${review.note_time_s}:${review.manual_note}`;
  return [...reviews.filter((item) => (
    (item.event_id || `${item.note_time_s}:${item.manual_note}`) !== key
    || normalizeReviewCameraRole(item.source_video_role || item.source_video?.role) !== normalizeReviewCameraRole(review.source_video_role || review.source_video?.role)
  )), review].sort((a, b) => Number(a.note_time_s) - Number(b.note_time_s));
}

export function reusedManualAnnotationEvidence(analysis = {}, video = {}, times = []) {
  const matchingTime = (value) => value != null && Number.isFinite(Number(value))
    && times.some((time) => Math.abs(time - Number(value)) <= 0.35);
  const frames = new Map();
  const findings = new Map();
  for (const review of [...(analysis._video_pass_findings || []), ...(analysis._manual_annotation_visual_reviews || [])]) {
    if (!sameVideoEvidenceSource(review, video)) continue;
    for (const frame of review.sampled_frames || review.sampledFrames || []) {
      const time = frame.recordTimeSeconds ?? frame.record_time_s ?? frame.session_time_s;
      if (matchingTime(time)) frames.set(Number(time), frame);
    }
    for (const finding of [...(review.findings || []), ...(review.reused_findings || [])]) {
      if (!matchingTime(finding.evidence_time_s)) continue;
      const observation = finding.observation || finding.text;
      if (!observation) continue;
      const item = { ...finding, anatomical_area: finding.anatomical_area || finding.title, observation };
      findings.set(`${item.evidence_time_s}:${item.anatomical_area}:${observation}`, item);
    }
  }
  return { sampled_frames: [...frames.values()], findings: [...findings.values()] };
}

export function reviewedFrameTimesForVideo(analysis = {}, video = {}) {
  const reviews = [
    ...(Array.isArray(analysis?._video_pass_findings) ? analysis._video_pass_findings : []),
    ...(Array.isArray(analysis?._manual_annotation_visual_reviews) ? analysis._manual_annotation_visual_reviews : []),
  ];
  return reviews
    .filter((review) => sameVideoEvidenceSource(review, video))
    .flatMap((review) => review.sampled_frames || review.sampledFrames || [])
    .map((frame) => finite(frame.recordTimeSeconds ?? frame.record_time_s ?? frame.session_time_s))
    .filter((time) => time != null)
    .sort((left, right) => left - right);
}

export function uncoveredFrameTimes(targetTimes = [], reviewedTimes = [], toleranceS = 0.35) {
  const tolerance = Math.max(0, finite(toleranceS) ?? 0.35);
  const reviewed = reviewedTimes.map(finite).filter((time) => time != null);
  return targetTimes
    .map(finite)
    .filter((time) => time != null && !reviewed.some((prior) => Math.abs(prior - time) <= tolerance));
}
