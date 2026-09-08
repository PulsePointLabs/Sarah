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
    sameVideoEvidenceSource(review, video)
    && (!event.event_id || !review.event_id || String(event.event_id) === String(review.event_id))
    && Math.abs(Number(review.note_time_s) - Number(event.time_s)) <= 0.6
    && String(review.manual_note || "").trim() === String(event.note || "").trim()
  )) || null;
}

export function mergeManualAnnotationReview(reviews = [], review) {
  const key = review.event_id || `${review.note_time_s}:${review.manual_note}`;
  return [...reviews.filter((item) => (
    (item.event_id || `${item.note_time_s}:${item.manual_note}`) !== key
    || !sameVideoEvidenceSource(item, review.source_video)
  )), review].sort((a, b) => Number(a.note_time_s) - Number(b.note_time_s)).slice(-500);
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
