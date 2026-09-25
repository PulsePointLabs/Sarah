import test from 'node:test';
import assert from 'node:assert/strict';
import { initialPhaseAnnouncementState, phaseCandidate, stepPhaseAnnouncement } from './phaseAnnouncements.js';
const prediction = { controllerConfidence: 80, buildDurationSec: 60, confirmationCount: 2 };
const sample = { enabled: true, active: true, hr: 100, baselineHr: 75, buildConfidence: 80 };
function run(overrides = {}, sampleOverrides = {}, seconds = 12, initial = initialPhaseAnnouncementState(), start = 100000) {
  let result = { state: initial };
  for (let i = 0; i <= seconds; i++) result = stepPhaseAnnouncement(result.state, { ...prediction, ...overrides }, { ...sample, measuredAt: start + i * 1000, ...sampleOverrides }, start + i * 1000);
  return result;
}
test('only sustained high-confidence evidence yields a phase announcement', () => {
  assert.equal(run({}, {}, 11).cue, null);
  assert.equal(run().cue.type, 'sustained_build');
  assert.equal(run({ controllerConfidence: 69 }).cue, null);
  assert.equal(run({}, { enabled: false }).cue, null);
  assert.equal(run({}, { active: false }).cue, null);
  assert.equal(run({}, { hr: null }).cue, null);
});
test('each requested phase uses its own evidence, and climax remains qualified', () => {
  assert.equal(phaseCandidate(prediction, { ...sample, buildConfidence: 20 }), 'elevated');
  assert.equal(run({ plateauScore: 80 }).cue.type, 'plateau');
  const climax = { nearClimax: 90, buildEligibleForNearClimax: true };
  assert.equal(run(climax).cue.phrase, 'Climax possibility.');
  assert.notEqual(run({ ...climax, confirmationCount: 1 }).cue.type, 'climax_possible');
  assert.equal(run({ recovery: 90 }).cue.type, 'recovery');
  assert.equal(run(climax, { bodyExploration: true }).cue.type, 'elevated');
});
test('stale packets, duplicate samples and interrupted evidence never satisfy dwell', () => {
  assert.equal(run({}, { measuredAt: 100000 }).cue, null);
  let result = run({}, {}, 10);
  result = stepPhaseAnnouncement(result.state, prediction, { ...sample, measuredAt: 110000 }, 120000);
  assert.equal(result.state.since, null);
  assert.equal(run({}, {}, 3, result.state, 121000).cue, null);
  const interrupted = run({ controllerConfidence: 20 }, {}, 1, run({}, {}, 10).state, 111000);
  assert.equal(run({}, {}, 3, interrupted.state, 113000).cue, null);
});
test('successful speech is transition-only and cooldown survives changes', () => {
  const result = run();
  const accepted = { ...result.state, lastPhase: result.cue.type, lastSpokenAt: result.cue.atMs };
  assert.equal(run({}, {}, 60, accepted, 113000).cue, null);
  assert.equal(run({ plateauScore: 80 }, {}, 12, accepted, 113000).cue, null);
  assert.equal(run({ plateauScore: 80 }, {}, 30, accepted, 113000).cue.type, 'plateau');
});
