import test from "node:test";
import assert from "node:assert/strict";
import {
  createLiveCueStateMachineState,
  stepLiveCueStateMachine,
} from "../../src/lib/liveCueStateMachine.js";
import {
  pickCuePhrase,
  resolveCuePhysiologyBucket,
} from "../../src/lib/liveCuePhrases.js";

const plateauPhrases = {
  plateau_encouragement: ["Stay calm and keep the stimulation steady."],
};

function plateauPrediction(overrides = {}) {
  return {
    nearClimax: 64,
    recovery: 0,
    plateauScore: 74,
    plateauDwell: true,
    physiologicalIntensity: "high_plateau",
    controllerConfidence: 82,
    multimodalAvailable: true,
    multimodalTrusted: true,
    hrvUsable: true,
    hrvContribution: 8,
    ...overrides,
  };
}

test("trusted sustained plateau produces one encouragement cue", () => {
  const start = Date.now();
  const first = stepLiveCueStateMachine(
    createLiveCueStateMachineState(),
    plateauPrediction(),
    { atMs: start, hr: 112 },
    {},
    plateauPhrases
  );
  assert.equal(first.cue, null);

  const second = stepLiveCueStateMachine(
    first.state,
    plateauPrediction(),
    { atMs: start + 10_500, hr: 114 },
    {},
    plateauPhrases
  );
  assert.equal(second.cue?.type, "plateau_encouragement");
  assert.equal(second.cue?.detector.plateauScore, 74);
});

test("weak multimodal evidence cannot trigger stronger plateau encouragement", () => {
  const start = Date.now();
  const weak = plateauPrediction({
    controllerConfidence: 38,
    multimodalTrusted: false,
  });
  const first = stepLiveCueStateMachine(
    createLiveCueStateMachineState(),
    weak,
    { atMs: start, hr: 112 },
    {},
    plateauPhrases
  );
  const second = stepLiveCueStateMachine(
    first.state,
    weak,
    { atMs: start + 20_000, hr: 114 },
    {},
    plateauPhrases
  );
  assert.equal(second.cue, null);
});

test("plateau encouragement respects its anti-chatter cooldown", () => {
  const start = Date.now();
  const first = stepLiveCueStateMachine(
    createLiveCueStateMachineState(),
    plateauPrediction(),
    { atMs: start, hr: 112 },
    { plateauMs: 0 },
    plateauPhrases
  );
  assert.equal(first.cue?.type, "plateau_encouragement");

  const repeated = stepLiveCueStateMachine(
    first.state,
    plateauPrediction(),
    { atMs: start + 20_000, hr: 114 },
    { plateauMs: 0 },
    plateauPhrases
  );
  assert.equal(repeated.cue, null);
  assert.equal(repeated.suppressed[0]?.reason, "cue_cooldown");
});

test("adaptive phrase selection follows current physiology and alternates within its pair", () => {
  const phrases = {
    climax_possible: [
      "rising one", "rising two",
      "steady one", "steady two",
      "intense one", "intense two",
      "autonomic one", "autonomic two",
    ],
  };
  const rising = { prediction: { nearClimax: 70, recentSlope: 0.4 }, sample: {} };
  const intense = { prediction: { nearClimax: 88 }, sample: {} };
  const autonomic = {
    prediction: {
      nearClimax: 72,
      hrvUsable: true,
      hrvSignal: "suppressed",
      hrvContribution: 9,
    },
    sample: {},
  };

  assert.equal(pickCuePhrase(phrases, "climax_possible", 0, rising), "rising one");
  assert.equal(pickCuePhrase(phrases, "climax_possible", 1, rising), "rising two");
  assert.equal(pickCuePhrase(phrases, "climax_possible", 0, intense), "intense one");
  assert.equal(pickCuePhrase(phrases, "climax_possible", 0, autonomic), "autonomic one");
});

test("physiology routing identifies recovery and steady states without inventing evidence", () => {
  assert.equal(resolveCuePhysiologyBucket("recovery", { recovery: 78 }, {}), "intense");
  assert.equal(resolveCuePhysiologyBucket("recovery", {
    recovery: 62,
    hrvUsable: true,
    hrvSignal: "opening",
  }, {}), "autonomic");
  assert.equal(resolveCuePhysiologyBucket("plateau_encouragement", {
    nearClimax: 62,
    recentSlope: 0.02,
    plateauScore: 70,
  }, {}), "steady");
});
