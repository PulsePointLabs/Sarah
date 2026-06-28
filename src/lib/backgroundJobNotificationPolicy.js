export const LONG_RUNNING_NOTIFICATION_THRESHOLD_MS = 2 * 60 * 1000;

const ALWAYS_LONG_RUNNING_JOB_TYPES = new Set([
  "local_vision_analyze_continuous",
  "local_vision_analyze_forward",
  "profile_anatomy_image_index",
  "profile_anatomy_video",
  "profile_image_review_full",
  "session_review_video",
  "tts_export",
]);

function timestampMs(value) {
  const parsed = Date.parse(value || "");
  return Number.isFinite(parsed) ? parsed : 0;
}

export function backgroundJobElapsedMs(job, now = Date.now()) {
  const startedAt = timestampMs(job?.startedAt || job?.createdAt);
  if (!startedAt) return 0;
  const terminalAt = timestampMs(job?.finishedAt || job?.completedAt || job?.updatedAt);
  const endAt = ["complete", "error", "cancelled"].includes(job?.status) && terminalAt
    ? terminalAt
    : now;
  return Math.max(0, endAt - startedAt);
}

export function isKnownLongRunningBackgroundJob(job) {
  return ALWAYS_LONG_RUNNING_JOB_TYPES.has(String(job?.type || ""));
}

export function shouldNotifyForJobDuration(job, { now = Date.now() } = {}) {
  if (!job || job?.meta?.quietInTray || job?.meta?.foreground || job?.meta?.notifications === false) {
    return false;
  }
  return isKnownLongRunningBackgroundJob(job)
    || backgroundJobElapsedMs(job, now) >= LONG_RUNNING_NOTIFICATION_THRESHOLD_MS;
}

export function shouldTrackNativeBackgroundJob(job, meta = {}, { now = Date.now() } = {}) {
  const candidate = { ...job, meta: { ...(job?.meta || {}), ...(meta || {}) } };
  if (!["queued", "running"].includes(candidate?.status)) return false;
  return shouldNotifyForJobDuration(candidate, { now });
}
