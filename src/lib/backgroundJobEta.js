export function formatBackgroundJobDuration(ms) {
  const seconds = Math.max(0, Math.round(Number(ms || 0) / 1000));
  if (!seconds) return "";
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remainingSeconds = seconds % 60;
  if (minutes < 60) return remainingSeconds ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function etaProgressKey(job, progress) {
  const current = Number(progress.eta_current ?? progress.current ?? 0);
  const total = Number(progress.eta_total ?? progress.total ?? 0);
  return `${job?.status || ""}|${current}|${total}`;
}

export function estimateBackgroundJobEtaSnapshot(job, nowMs = Date.now()) {
  if (!["queued", "running"].includes(job?.status)) return null;
  const progress = job?.progress || {};
  const current = Number(progress.eta_current ?? progress.current ?? 0);
  const total = Number(progress.eta_total ?? progress.total ?? 0);
  if (!Number.isFinite(current) || !Number.isFinite(total) || current <= 0 || total <= current) return null;
  const startedAt = new Date(job.startedAt || job.createdAt || 0).getTime();
  if (!Number.isFinite(startedAt) || startedAt <= 0) return null;
  const elapsedMs = nowMs - startedAt;
  if (elapsedMs < 15000) return null;
  const msPerUnit = elapsedMs / current;
  const etaMs = (total - current) * msPerUnit;
  if (!Number.isFinite(etaMs) || etaMs < 1000) return null;
  return {
    etaMs,
    elapsedMs,
    key: etaProgressKey(job, progress),
  };
}

export function stabilizeBackgroundJobEta(job, cache, nowMs = Date.now()) {
  const raw = estimateBackgroundJobEtaSnapshot(job, nowMs);
  if (!job?.id || !raw) {
    if (job?.id) cache?.delete?.(job.id);
    return null;
  }

  const previous = cache?.get?.(job.id);
  let etaMs = raw.etaMs;
  if (previous?.key === raw.key) {
    const elapsedSinceSample = Math.max(0, nowMs - Number(previous.sampledAtMs || nowMs));
    const countedDownEta = Math.max(0, Number(previous.etaMs || 0) - elapsedSinceSample);
    etaMs = Math.min(raw.etaMs, countedDownEta || raw.etaMs);
  }

  const stabilized = {
    etaMs,
    elapsedMs: raw.elapsedMs,
    key: raw.key,
    sampledAtMs: nowMs,
    label: `ETA ~ ${formatBackgroundJobDuration(etaMs)} left`,
    elapsedLabel: `elapsed ${formatBackgroundJobDuration(raw.elapsedMs)}`,
  };
  cache?.set?.(job.id, stabilized);
  return stabilized;
}
