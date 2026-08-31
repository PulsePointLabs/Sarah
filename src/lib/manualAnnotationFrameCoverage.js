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
  const candidateFingerprint = String(source.fingerprint || candidate.source_video_fingerprint || "");
  const videoFingerprint = String(video.fingerprint || "");
  if (candidateFingerprint && videoFingerprint) return candidateFingerprint === videoFingerprint;
  const candidateRole = String(candidate.source_video_role || source.role || candidate.camera_role || "");
  const videoRole = String(video.role || video.camera_role || "");
  const candidateName = String(source.filename || source.label || candidate.source_video_filename || "").toLowerCase();
  const videoName = String(video.filename || video.label || "").toLowerCase();
  if (candidateName && videoName) return candidateName === videoName && (!candidateRole || !videoRole || candidateRole === videoRole);
  return Boolean(candidateRole && videoRole && candidateRole === videoRole);
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

