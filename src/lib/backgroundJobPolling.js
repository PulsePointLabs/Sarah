export function isTransientBackgroundJobPollError(error) {
  const status = Number(error?.status || 0);
  if (status >= 500 || status === 408 || status === 429) return true;
  return /timed out|timeout|did not respond|failed to fetch|network|connection|temporarily unreachable/i.test(
    String(error?.message || ""),
  );
}
