export const CLOSED_JOB_SNAPSHOT_KEY = "pulsepoint.backgroundJobs.closedSnapshot.v1";

export function backgroundJobStateToken(job) {
  const id = String(job?.id || "").trim();
  const status = String(job?.status || "").trim();
  return id && status ? `${id}:${status}` : "";
}

export function loadClosedJobSnapshot(storage = globalThis?.localStorage) {
  try {
    const parsed = JSON.parse(storage?.getItem(CLOSED_JOB_SNAPSHOT_KEY) || "[]");
    return new Set(Array.isArray(parsed) ? parsed.filter(Boolean) : []);
  } catch {
    return new Set();
  }
}

export function saveClosedJobSnapshot(jobs, storage = globalThis?.localStorage) {
  const tokens = (Array.isArray(jobs) ? jobs : []).map(backgroundJobStateToken).filter(Boolean);
  try {
    if (tokens.length) storage?.setItem(CLOSED_JOB_SNAPSHOT_KEY, JSON.stringify(tokens.slice(-100)));
    else storage?.removeItem(CLOSED_JOB_SNAPSHOT_KEY);
  } catch {
    // The tray still closes for this view when browser storage is unavailable.
  }
  return new Set(tokens);
}

export function clearClosedJobSnapshot(storage = globalThis?.localStorage) {
  try {
    storage?.removeItem(CLOSED_JOB_SNAPSHOT_KEY);
  } catch {
    // Optional persistence only.
  }
}

export function hasUnseenJobState(jobs, closedSnapshot) {
  const snapshot = closedSnapshot instanceof Set ? closedSnapshot : new Set(closedSnapshot || []);
  return (Array.isArray(jobs) ? jobs : []).some((job) => {
    const token = backgroundJobStateToken(job);
    return token && !snapshot.has(token);
  });
}
