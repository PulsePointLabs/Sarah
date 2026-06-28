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
