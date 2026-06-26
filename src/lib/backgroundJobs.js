import { apiUrl, discoverSarahApiBase, isSarahNativeShell } from "@/lib/mobileApiBase";

const START_RECOVERY_WINDOW_MS = 4 * 60 * 1000;

function nativeApiUnavailableMessage(error) {
  const tried = Array.isArray(error?.failures)
    ? error.failures.map((failure) => failure.base).filter(Boolean).join(", ")
    : "";
  return [
    "Sarah cannot reach the desktop Local API.",
    "Connect this phone to the same Wi-Fi/Tailscale path as the desktop, then try again.",
    tried ? `Tried: ${tried}` : "",
  ].filter(Boolean).join(" ");
}

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
      throw new Error(`Local background job API did not respond within ${Math.round(timeoutMs / 1000)}s`);
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

function makeClientRequestId(type) {
  const prefix = String(type || "job").replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 36) || "job";
  try {
    return `${prefix}-${crypto.randomUUID()}`;
  } catch {
    return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }
}

function getJobTimeMs(job = {}) {
  const value = job.createdAt || job.startedAt || job.updatedAt || "";
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function jobMatchesStartRequest(job, { type, meta = {}, payload = {}, requestStartedAt = 0, clientRequestId = "" } = {}) {
  if (!job || String(job.type || "") !== String(type || "")) return false;
  if (clientRequestId && job?.meta?.clientRequestId === clientRequestId) return true;
  const createdMs = getJobTimeMs(job);
  if (!Number.isFinite(createdMs) || createdMs < requestStartedAt - 5000) return false;
  if (createdMs < Date.now() - START_RECOVERY_WINDOW_MS) return false;

  const expectedReviewType = meta.reviewType || payload.reviewType || "";
  if (expectedReviewType && String(job?.meta?.reviewType || job?.payload?.reviewType || "") !== String(expectedReviewType)) return false;

  const expectedSource = meta.source || payload.source || "";
  if (expectedSource && String(job?.meta?.source || job?.payload?.source || "") !== String(expectedSource)) return false;

  const expectedSessionId = meta.sessionId || payload.sessionId || "";
  if (expectedSessionId && String(job?.meta?.sessionId || job?.payload?.sessionId || "") !== String(expectedSessionId)) return false;

  const expectedTitle = meta.title || payload.title || "";
  if (expectedTitle && String(job?.meta?.title || job?.payload?.title || "") !== String(expectedTitle)) return false;

  const expectedLabel = meta.label || payload.label || "";
  if (expectedLabel && String(job?.meta?.label || job?.payload?.label || "") !== String(expectedLabel)) return false;

  return true;
}

async function recoverStartedBackgroundJob({ type, payload, meta, requestStartedAt, clientRequestId }) {
  const params = new URLSearchParams();
  params.set("type", type);
  params.set("status", "queued,running,complete,error");
  params.set("limit", "80");
  if (meta?.source) params.set("metaSource", meta.source);
  const data = await jobRequest(`/jobs?${params.toString()}`, {
    timeoutMs: 8000,
    skipApiDiscovery: true,
  });
  const jobs = Array.isArray(data?.jobs) ? data.jobs : [];
  return jobs
    .filter((job) => jobMatchesStartRequest(job, { type, meta, payload, requestStartedAt, clientRequestId }))
    .sort((a, b) => getJobTimeMs(b) - getJobTimeMs(a))[0] || null;
}

export function startBackgroundJob(type, payload = {}, meta = {}) {
  const clientRequestId = meta?.clientRequestId || makeClientRequestId(type);
  const requestStartedAt = Date.now();
  const enrichedMeta = {
    ...meta,
    clientRequestId,
  };
  const body = JSON.stringify({ type, payload, meta: enrichedMeta });
  const largeBodyThreshold = 42 * 1024 * 1024;
  const path = body.length > largeBodyThreshold ? "/jobs/start-large" : "/jobs/start";
  const startRequest = (options = {}) => jobRequest(path, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body,
    timeoutMs: 30000,
    ...options,
  });
  const recoverAfterTimeout = async (error) => {
    if (!/timed out|timeout|did not respond/i.test(String(error?.message || ""))) throw error;
    const recovered = await recoverStartedBackgroundJob({
      type,
      payload,
      meta: enrichedMeta,
      requestStartedAt,
      clientRequestId,
    }).catch(() => null);
    if (recovered?.id) return recovered;
    throw error;
  };

  if (!isSarahNativeShell()) return startRequest().catch(recoverAfterTimeout);

  return startRequest({ skipApiDiscovery: true }).catch(async (firstError) => {
    const recovered = await recoverAfterTimeout(firstError).catch(() => null);
    if (recovered?.id) return recovered;
    try {
      await discoverSarahApiBase({ timeoutMs: 5000 });
      return await startRequest({ skipApiDiscovery: true }).catch(recoverAfterTimeout);
    } catch (error) {
      if (Array.isArray(error?.failures)) {
        const unavailable = new Error(nativeApiUnavailableMessage(error));
        unavailable.cause = firstError;
        throw unavailable;
      }
      throw error;
    }
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
