import { getBackgroundJob, startBackgroundJob, waitForBackgroundJob } from "@/lib/backgroundJobs";

const STORAGE_PREFIX = "pulsepoint:ai-job:";

function storageKey(key) {
  return `${STORAGE_PREFIX}${key}`;
}

export function clearRecoverableAIJob(key) {
  if (!key) return;
  try {
    localStorage.removeItem(storageKey(key));
  } catch {
    // localStorage may be unavailable in restricted browser modes.
  }
}

export function getRecoverableAIJobRef(key) {
  if (!key) return null;
  try {
    const raw = localStorage.getItem(storageKey(key));
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}

export async function startRecoverableAIJob(key, payload, meta = {}) {
  const job = await startBackgroundJob("ai_invoke", payload, {
    source: "recoverable_ai_analysis",
    ...meta,
  });
  try {
    localStorage.setItem(storageKey(key), JSON.stringify({
      jobId: job.id,
      startedAt: new Date().toISOString(),
      meta,
    }));
  } catch {
    // The job still exists server-side; only automatic page recovery is affected.
  }
  return job;
}

export async function waitForRecoverableAIJob(key, jobId, options = {}) {
  const completed = await waitForBackgroundJob(jobId, options);
  clearRecoverableAIJob(key);
  return completed;
}

export async function recoverCompletedAIJob(key) {
  const ref = getRecoverableAIJobRef(key);
  if (!ref?.jobId) return null;
  const job = await getBackgroundJob(ref.jobId);
  if (job.status === "complete") {
    clearRecoverableAIJob(key);
    return job;
  }
  if (job.status === "error" || job.status === "cancelled") {
    clearRecoverableAIJob(key);
    const error = new Error(job.error || job.progress?.message || `AI job ${job.status}`);
    error.job = job;
    throw error;
  }
  return job;
}
