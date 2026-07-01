import { Capacitor, registerPlugin } from "@capacitor/core";
import { API_BASE } from "@/lib/mobileApiBase";
import { shouldTrackNativeBackgroundJob } from "@/lib/backgroundJobNotificationPolicy";

const SarahBackgroundJobs = registerPlugin("SarahBackgroundJobs");

function isAndroidNative() {
  try {
    return Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
  } catch {
    return false;
  }
}

export function canSubmitNativeBackgroundJob() {
  return isAndroidNative();
}

export async function submitNativeBackgroundJob({ path, body, meta = {}, type = "" } = {}) {
  if (!isAndroidNative()) return null;
  const submission = await SarahBackgroundJobs.submit({
    apiBase: API_BASE,
    path,
    body,
    title: meta.title || meta.label || "Sarah background task",
    route: meta.route || "/settings",
    headers: meta.headers || {},
  });
  const submissionId = submission?.submissionId || `native-${Date.now()}`;
  return {
    id: `native-submit-${submissionId}`,
    type,
    status: "queued",
    createdAt: new Date().toISOString(),
    meta: { ...meta, nativeSubmission: true, submissionId },
    progress: {
      phase: "native_handoff",
      current: 0,
      total: 1,
      message: "Request saved on this phone. Safe to leave Sarah while Android sends it to the desktop.",
    },
  };
}

export async function trackNativeBackgroundJob(job, meta = {}) {
  if (!isAndroidNative() || !job?.id || !shouldTrackNativeBackgroundJob(job, meta)) return false;
  await SarahBackgroundJobs.track({
    jobId: job.id,
    apiBase: API_BASE,
    title: meta.title || job?.meta?.title || "Sarah background task",
    route: meta.route || job?.meta?.route || "/settings",
    headers: meta.headers || {},
  });
  return true;
}
