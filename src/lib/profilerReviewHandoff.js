const BACKEND_JOB_STATUSES = new Set(["queued", "running"]);

export function profilerReviewHandoffState({ loading = false, jobStatus = null } = {}) {
  const status = String(jobStatus?.status || "").toLowerCase();
  const phase = String(jobStatus?.progress?.phase || "").toLowerCase();
  const backendConfirmed = Boolean(jobStatus?.id && BACKEND_JOB_STATUSES.has(status));
  const uploading = !backendConfirmed && phase === "handing_off";
  const preparingLocally = !backendConfirmed && Boolean(
    loading || status === "starting" || ["preparing", "building"].includes(phase),
  );

  return {
    backendConfirmed,
    backendQueued: backendConfirmed && status === "queued",
    backendRunning: backendConfirmed && status === "running",
    preparingLocally,
    uploading,
    safeToBackground: backendConfirmed,
  };
}
