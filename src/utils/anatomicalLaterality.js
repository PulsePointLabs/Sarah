const FEET_CAMERA_PATTERN = /\b(?:feet|foot|soles?|lower[-_\s]?body|foot[-_\s]?of[-_\s]?(?:the[-_\s]?)?table)\b/i;

export function isFootOfTableCamera(value = {}) {
  const text = typeof value === "string"
    ? value
    : [
        value.source_video_role,
        value.camera_angle,
        value.label,
        value.filename,
        value.source_video?.label,
        value.source_video?.filename,
      ].filter(Boolean).join(" ");
  return FEET_CAMERA_PATTERN.test(text);
}

export function normalizeFootCameraLateralityText(value = "") {
  return String(value || "")
    .replace(/\b(?:the\s+)?screen[-\s]?left\s+(foot|sole|heel|toes?|leg|knee|thigh|ankle)\b/gi, (_match, part) => `your right ${part.toLowerCase()}`)
    .replace(/\b(?:the\s+)?screen[-\s]?right\s+(foot|sole|heel|toes?|leg|knee|thigh|ankle)\b/gi, (_match, part) => `your left ${part.toLowerCase()}`)
    .replace(/\b(?:the\s+)?viewer(?:'s)?[-\s]?left\s+(foot|sole|heel|toes?|leg|knee|thigh|ankle)\b/gi, (_match, part) => `your right ${part.toLowerCase()}`)
    .replace(/\b(?:the\s+)?viewer(?:'s)?[-\s]?right\s+(foot|sole|heel|toes?|leg|knee|thigh|ankle)\b/gi, (_match, part) => `your left ${part.toLowerCase()}`)
    .replace(/\byour\s+(left|right)\s+toes\b/gi, (_match, side) => `your ${side.toLowerCase()} toes`);
}

export function sessionHasFootOfTableCamera(session = {}) {
  const sources = [
    ...(Array.isArray(session.linked_local_videos) ? session.linked_local_videos : []),
    ...(Array.isArray(session.local_videos) ? session.local_videos : []),
    ...(Array.isArray(session.ai_analysis?._video_pass_findings) ? session.ai_analysis._video_pass_findings : []),
  ];
  return sources.some(isFootOfTableCamera);
}
