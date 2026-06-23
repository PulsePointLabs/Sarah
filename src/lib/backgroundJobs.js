import { apiUrl, discoverSarahApiBase, isSarahNativeShell } from "@/lib/mobileApiBase";

async function jobRequest(path, options = {}) {
  const timeoutMs = Number(options.timeoutMs || 15000);
  const controller = timeoutMs > 0 && !options.signal ? new AbortController() : null;
  const timeoutId = controller
    ? window.setTimeout(() => controller.abort(), timeoutMs)
    : null;
  const fetchOptions = { ...options };
  delete fetchOptions.timeoutMs;
  delete fetchOptions.skipApiDiscovery;
  if (controller) fetchOptions.signal = controller.signal;

  let response;
  try {
    response = await fetch(apiUrl(path), fetchOptions);
  } catch (error) {
    if (error?.name === "AbortError" && controller) {
      throw new Error(`Job request timed out after ${Math.round(timeoutMs / 1000)}s`);
    }
    if (isSarahNativeShell() && !options.skipApiDiscovery) {
      await discoverSarahApiBase({ timeoutMs: 2200 });
      return jobRequest(path, { ...options, skipApiDiscovery: true });
    }
    throw error;
  } finally {
    if (timeoutId) window.clearTimeout(timeoutId);
  }
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
    timeoutMs: 30000,
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

export function retryBackgroundJob(jobId, options = {}) {
  return jobRequest(`/jobs/${encodeURIComponent(jobId)}/retry`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(options || {}),
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
