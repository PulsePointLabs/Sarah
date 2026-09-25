export const PHASE_PHRASES = Object.freeze({
  elevated: ['Elevated.'], sustained_build: ['Sustained build.'], plateau: ['Plateau.'],
  climax_possible: ['Climax possibility.'], recovery: ['Recovery.'], baseline: ['Back near baseline.'],
});
export const PHASE_SETTINGS_KEY = 'pulsepoint.phaseAnnouncements.v1';
export function initialPhaseAnnouncementState() {
  return { candidate: '', since: null, lastSampleAt: 0, lastPhase: '', lastSpokenAt: null };
}
export function phaseCandidate(prediction, sample) {
  if (!(Number(sample.hr) > 0) || !(Number(sample.baselineHr) > 0)) return '';
  if (Number(prediction.controllerConfidence) < 70 || !Number.isFinite(Number(prediction.controllerConfidence))) return '';
  const delta = Number(sample.hr) - Number(sample.baselineHr);
  if (Number(prediction.recovery) >= 75) return 'recovery';
  if (!sample.bodyExploration && prediction.buildEligibleForNearClimax && prediction.confirmationCount >= 2 && prediction.nearClimax >= 75) return 'climax_possible';
  if (!sample.bodyExploration && prediction.plateauScore >= 75) return 'plateau';
  if (!sample.bodyExploration && sample.buildConfidence >= 75 && prediction.buildDurationSec >= 30 && delta >= 8) return 'sustained_build';
  if (delta >= 8) return 'elevated';
  if (Number.isFinite(delta) && Math.abs(delta) <= 5) return 'baseline';
  return '';
}
export function stepPhaseAnnouncement(previous, prediction, sample, now = Date.now()) {
  const state = { ...previous };
  const age = now - Number(sample.measuredAt);
  if (!sample.active || !sample.enabled || !Number.isFinite(age) || age < -1000 || age > 5000) {
    return { state: { ...state, candidate: '', since: null, lastSampleAt: 0 }, cue: null };
  }
  if (Number(sample.measuredAt) <= state.lastSampleAt) return { state, cue: null };
  const phase = phaseCandidate(prediction, sample);
  if (phase !== state.candidate || Number(sample.measuredAt) - state.lastSampleAt > 5000) {
    state.candidate = phase;
    state.since = now;
  }
  state.lastSampleAt = Number(sample.measuredAt);
  if (!phase || state.since == null || now - state.since < 12000 || phase === state.lastPhase
    || (state.lastSpokenAt != null && now - state.lastSpokenAt < 30000)) return { state, cue: null };
  return { state, cue: { type: phase, phrase: PHASE_PHRASES[phase][0], atMs: now } };
}
