export const LIVE_CUE_DISPLAY_LABELS = Object.freeze({
  sustained_build: "Sustained build observed",
  plateau_encouragement: "Sustained plateau observed",
  climax_possible: "Climax approach detected",
  climax_imminent: "Near-climax probability high",
  recovery: "Recovery detected",
  build_resumed: "Build resumed",
});

export function toLiveTelemetryNotice(cue) {
  if (!cue) return null;
  return {
    id: cue.id,
    label: LIVE_CUE_DISPLAY_LABELS[cue.type] || String(cue.type || "Live telemetry update").replace(/_/g, " "),
    message: cue.phrase || "Meaningful live telemetry pattern detected.",
    confidence: cue.type === "recovery" ? cue.detector?.recovery : cue.detector?.nearClimax,
    sessionTimeSec: cue.sessionTimeSec,
    spoken: Boolean(cue.playback?.ok),
  };
}
