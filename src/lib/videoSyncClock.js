export const VIDEO_SYNC_SOFT_DRIFT_S = 0.06;
export const VIDEO_SYNC_HARD_DRIFT_S = 0.35;

export function clampMediaTime(timeS, durationS = Infinity) {
  const finiteTime = Number.isFinite(Number(timeS)) ? Number(timeS) : 0;
  const finiteDuration = Number.isFinite(Number(durationS)) && Number(durationS) > 0
    ? Number(durationS)
    : Infinity;
  return Math.max(0, Math.min(finiteDuration, finiteTime));
}

export function sessionTimeToMediaTime(sessionTimeS, timelineOffsetS = 0, durationS = Infinity) {
  return clampMediaTime(Number(sessionTimeS) - (Number(timelineOffsetS) || 0), durationS);
}

export function mediaTimeToSessionTime(mediaTimeS, timelineOffsetS = 0) {
  return Math.max(0, (Number(mediaTimeS) || 0) + (Number(timelineOffsetS) || 0));
}

export function getVideoSyncCorrection(currentTimeS, targetTimeS, basePlaybackRate = 1) {
  const driftS = (Number(targetTimeS) || 0) - (Number(currentTimeS) || 0);
  const baseRate = Math.max(0.25, Number(basePlaybackRate) || 1);
  const absDriftS = Math.abs(driftS);

  if (absDriftS >= VIDEO_SYNC_HARD_DRIFT_S) {
    return { driftS, seek: true, playbackRate: baseRate };
  }
  if (absDriftS <= VIDEO_SYNC_SOFT_DRIFT_S) {
    return { driftS, seek: false, playbackRate: baseRate };
  }

  const correction = Math.max(-0.08, Math.min(0.08, driftS * 0.2));
  return {
    driftS,
    seek: false,
    playbackRate: baseRate * (1 + correction),
  };
}
