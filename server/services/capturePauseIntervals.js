function finiteEpoch(value) {
  const number = Number(value);
  if (Number.isFinite(number) && number > 0) return number;
  const parsed = Date.parse(value || '');
  return Number.isFinite(parsed) ? parsed : null;
}

function localTimestamp(value) {
  return new Date(value).toLocaleString('en-US', {
    timeZone: 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: true,
    timeZoneName: 'short',
  });
}

export function closeCapturePauseIntervals(intervals = [], endedAtMs = Date.now()) {
  const endMs = finiteEpoch(endedAtMs) || Date.now();
  return (Array.isArray(intervals) ? intervals : []).map((interval) => {
    const pausedAtMs = finiteEpoch(interval?.pausedAtMs ?? interval?.pausedAt);
    const existingResumedAtMs = finiteEpoch(interval?.resumedAtMs ?? interval?.resumedAt);
    const resumedAtMs = existingResumedAtMs || endMs;
    if (!pausedAtMs) return interval;
    return {
      ...interval,
      pausedAtMs,
      pausedAt: new Date(pausedAtMs).toISOString(),
      pausedLocalTime: interval?.pausedLocalTime || localTimestamp(pausedAtMs),
      resumedAtMs,
      resumedAt: new Date(resumedAtMs).toISOString(),
      resumedLocalTime: interval?.resumedLocalTime || localTimestamp(resumedAtMs),
      durationMs: Math.max(0, resumedAtMs - pausedAtMs),
    };
  });
}

export function summarizeCapturePauseIntervals(intervals = [], startedAtMs, endedAtMs) {
  const startMs = finiteEpoch(startedAtMs);
  const endMs = finiteEpoch(endedAtMs);
  const closed = closeCapturePauseIntervals(intervals, endMs || Date.now());
  const pausedDurationMs = closed.reduce((total, interval) => total + Math.max(0, Number(interval?.durationMs) || 0), 0);
  const wallDurationMs = startMs && endMs ? Math.max(0, endMs - startMs) : 0;
  return {
    intervals: closed,
    pausedDurationMs,
    activeDurationMs: Math.max(0, wallDurationMs - pausedDurationMs),
    wallDurationMs,
  };
}
