function normalizedVideoIdentity(video = {}) {
  return [
    video.role,
    video.source_role,
    video.video_role,
    video.camera_angle,
    video.label,
    video.filename,
    video.path,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

export function inferSessionVideoPriority(video = {}) {
  const text = normalizedVideoIdentity(video);
  if (/\b(composite|pip|picture in picture|obs|program)\b/.test(text)) return 0;
  if (/\b(main|primary|focus|close|genital|shaft|glans)\b/.test(text)) return 1;
  if (/\b(side|lateral|angle)\b/.test(text)) return 8;
  if (/\b(feet|foot|toe|toes|heel|heels|lower body|leg|legs|pelvis)\b/.test(text)) return 9;
  return 3;
}

export function sortSessionVideosPrimaryFirst(videos = []) {
  return [...videos].sort((a, b) => inferSessionVideoPriority(a) - inferSessionVideoPriority(b));
}
