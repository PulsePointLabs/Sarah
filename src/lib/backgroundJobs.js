import { apiUrl } from "@/lib/mobileApiBase";

async function jobRequest(path, options = {}) {
  const response = await fetch(apiUrl(path), options);
  const contentType = response.headers.get("content-type") || "";
  const data = contentType.includes("application/json")
    ? await response.json()
    : await response.text();

  if (!response.ok) {
    const error = new Error(data?.error || data?.message || `Job request failed: ${response.status}`);
    error.status = response.status;
    error.data = data;
    throw error;
  }

  return data;
}

export function startBackgroundJob(type, payload = {}, meta = {}) {
  const body = JSON.stringify({ type, payload, meta });
  const largeBodyThreshold = 42 * 1024 * 1024;
  const path = body.length > largeBodyThreshold ? "/jobs/start-large" : "/jobs/start";
  return jobRequest(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
  });
}

export function getBackgroundJob(jobId) {
  return jobRequest(`/jobs/${encodeURIComponent(jobId)}`);
}

export function cancelBackgroundJob(jobId) {
  return jobRequest(`/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST",
  });
}

export function clearBackgroundJobs() {
  return jobRequest("/jobs/clear", {
    method: "POST",
  });
}

export function captureAIForensicFinal(captureId, payload) {
  if (!captureId) return Promise.resolve(null);
  return jobRequest(`/ai/forensics/${encodeURIComponent(captureId)}/final`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload || {}),
  });
}

export function listBackgroundJobs(params = {}) {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value !== undefined && value !== null && value !== "") query.set(key, value);
  });
  return jobRequest(`/jobs${query.toString() ? `?${query}` : ""}`);
}

export async function waitForBackgroundJob(jobId, { onProgress, intervalMs = 1200 } = {}) {
  while (true) {
    const job = await getBackgroundJob(jobId);
    onProgress?.(job);

    if (job.status === "complete") return job;
    if (job.status === "error" || job.status === "cancelled") {
      const error = new Error(job.error || job.progress?.message || `Job ${job.status}`);
      error.job = job;
      throw error;
    }

    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}
