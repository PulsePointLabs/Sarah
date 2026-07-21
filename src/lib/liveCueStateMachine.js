import { LIVE_CUE_PRIORITY, LIVE_CUE_TYPES, pickCuePhrase } from "./liveCuePhrases.js";

export const DEFAULT_LIVE_CUE_MACHINE_OPTIONS = Object.freeze({
  enabled: true,
  captureKind: "session",
  allowSessionStyleCues: false,
  sustainedBuildThreshold: 42,
  sustainedBuildMs: 10_000,
  plateauThreshold: 62,
  plateauMs: 10_000,
  climaxPossibleThreshold: 68,
  climaxPossibleMs: 5_000,
  climaxImminentThreshold: 85,
  climaxImminentMs: 4_000,
  recoveryThreshold: 55,
  recoveryMs: 4_000,
  buildResumedThreshold: 42,
  buildResumedMs: 6_000,
  globalCooldownMs: 14_000,
  cooldowns: {
    sustained_build: 45_000,
    plateau_encouragement: 55_000,
    climax_possible: 30_000,
    climax_imminent: 20_000,
    recovery: 90_000,
    build_resumed: 45_000,
  },
  maxCuesPerMinute: 4,
  cueFreshnessMs: 2_500,
});

export function createLiveCueStateMachineState() {
  return {
    state: "baseline",
    candidateSince: {},
    lastCueAt: {},
    lastCueType: "",
    lastCuePhraseIndex: {},
    lastAnyCueAt: 0,
    cueTimes: [],
    recoveryEpisodeActive: false,
    buildBeforeRecovery: null,
    edgingCandidates: [],
    eventSequence: 0,
  };
}

function nowMs(sample) {
  return Number(sample?.atMs ?? sample?.ts ?? sample?.now ?? Date.now());
}

function hasPhrase(phrases, cueType) {
  return Boolean((phrases?.[cueType] || []).length);
}

function phaseText(prediction = {}) {
  return String(prediction.phase || prediction.label || "").toLowerCase();
}

function isRecovery(prediction = {}) {
  const text = phaseText(prediction);
  return text.includes("recovery") || Number(prediction.recovery || 0) >= 55;
}

function supportFamilies(prediction = {}, sample = {}) {
  const families = [];
  const near = Number(prediction.nearClimax || 0);
  const slope = Number(prediction.recentSlope || sample.recentSlope || 0);
  const delta = Number(sample.hrDelta ?? sample.elevatedDelta ?? 0);
  if (near >= 42 || slope >= 0.25 || delta >= 8) families.push("hr");
  if (prediction.hrvUsable && Number(prediction.hrvContribution || 0) > 0) families.push("hrv");
  if (Number(prediction.emgContribution || sample.emgContribution || 0) > 0) families.push("emg");
  return families;
}

function setCandidate(state, key, eligible, at, requiredMs) {
  if (!eligible) {
    delete state.candidateSince[key];
    return false;
  }
  if (!state.candidateSince[key]) state.candidateSince[key] = at;
  return at - state.candidateSince[key] >= requiredMs;
}

function canSpeak(state, cueType, at, options) {
  if (at - state.lastAnyCueAt < options.globalCooldownMs) return { ok: false, reason: "global_cooldown" };
  const lastTypeAt = state.lastCueAt[cueType] || 0;
  const cooldown = options.cooldowns?.[cueType] ?? 30_000;
  if (at - lastTypeAt < cooldown) return { ok: false, reason: "cue_cooldown" };
  const recent = state.cueTimes.filter((cueAt) => at - cueAt < 60_000);
  if (recent.length >= options.maxCuesPerMinute) return { ok: false, reason: "rate_limited" };
  return { ok: true, reason: "" };
}

function selectCue(candidates) {
  return candidates
    .filter(Boolean)
    .sort((a, b) => (LIVE_CUE_PRIORITY[b.type] || 0) - (LIVE_CUE_PRIORITY[a.type] || 0))[0] || null;
}

function acceptCue(state, cue, phrases, at, prediction, sample) {
  const nextIndex = (state.lastCuePhraseIndex[cue.type] || 0) + (state.lastCueType === cue.type ? 1 : 0);
  const phrase = pickCuePhrase(phrases, cue.type, nextIndex);
  state.lastCuePhraseIndex[cue.type] = nextIndex + 1;
  state.lastCueAt[cue.type] = at;
  state.lastAnyCueAt = at;
  state.lastCueType = cue.type;
  state.cueTimes = [...state.cueTimes.filter((cueAt) => at - cueAt < 60_000), at];
  state.eventSequence += 1;
  state.state = cue.state || cue.type;
  return {
    id: `live-cue-${state.eventSequence}`,
    type: cue.type,
    phrase,
    atMs: at,
    priority: LIVE_CUE_PRIORITY[cue.type] || 0,
    detector: {
      nearClimax: Number(prediction.nearClimax || 0),
      plateauScore: Number(prediction.plateauScore || 0),
      recovery: Number(prediction.recovery || 0),
      label: prediction.label || "",
      phase: prediction.phase || "",
      recentSlope: prediction.recentSlope ?? null,
      hrvUsable: Boolean(prediction.hrvUsable),
      hrvSignal: prediction.hrvSignal || "",
      rmssd: prediction.rmssd ?? null,
      confidenceBand: prediction.confidenceBand || "",
      controllerConfidence: prediction.controllerConfidence ?? null,
      physiologicalIntensity: prediction.physiologicalIntensity || "",
    },
    sample: {
      hr: sample.hr ?? sample.currentHr ?? null,
      baselineHr: sample.baselineHr ?? null,
      sessionTimeSec: sample.sessionTimeSec ?? null,
    },
  };
}

function maybeRecordEdgingCandidate(state, at, prediction, sample) {
  if (!state.buildBeforeRecovery) return null;
  const candidate = {
    type: "edging_pattern_candidate",
    startMs: state.buildBeforeRecovery.startMs,
    recoveryMs: at,
    peakApproachScore: state.buildBeforeRecovery.peakApproachScore,
    highestHr: state.buildBeforeRecovery.highestHr,
    hrvState: state.buildBeforeRecovery.hrvState,
    emgState: state.buildBeforeRecovery.emgState,
    resumedBuildMs: null,
    manualClimaxFollowed: false,
    confidence: Math.min(95, Math.max(35, Number(prediction.nearClimax || 0) + Number(prediction.recovery || 0) / 3)),
    sessionTimeSec: sample.sessionTimeSec ?? null,
  };
  state.edgingCandidates.push(candidate);
  return candidate;
}

export function stepLiveCueStateMachine(previousState, prediction = {}, sample = {}, optionsInput = {}, phrases = {}) {
  const options = { ...DEFAULT_LIVE_CUE_MACHINE_OPTIONS, ...(optionsInput || {}) };
  const state = previousState ? structuredClone(previousState) : createLiveCueStateMachineState();
  const at = nowMs(sample);
  const suppressed = [];

  if (!options.enabled) return { state, cue: null, suppressed: [{ type: "all", reason: "disabled" }], edgingCandidate: null };
  if (options.captureKind === "body_exploration" && !options.allowSessionStyleCues) {
    return { state, cue: null, suppressed: [{ type: "all", reason: "body_exploration_suppressed" }], edgingCandidate: null };
  }

  const near = Number(prediction.nearClimax || 0);
  const recovery = Number(prediction.recovery || 0);
  const plateau = Number(prediction.plateauScore || 0);
  const recovering = isRecovery(prediction);
  const multimodalTrusted = prediction.multimodalAvailable ? prediction.multimodalTrusted === true : true;
  const controllerTrusted = Number(prediction.controllerConfidence || 0) >= 50 || !prediction.multimodalAvailable;
  const families = supportFamilies(prediction, sample);
  const usefulFamilyCount = families.length;
  const hrvOnly = families.length === 1 && families[0] === "hrv";

  if (near >= options.sustainedBuildThreshold && !recovering) {
    const currentBuild = state.buildBeforeRecovery || {
      startMs: at,
      peakApproachScore: near,
      highestHr: sample.hr ?? sample.currentHr ?? null,
      hrvState: prediction.hrvSignal || "",
      emgState: sample.emgContribution ?? prediction.emgContribution ?? null,
    };
    currentBuild.peakApproachScore = Math.max(currentBuild.peakApproachScore || 0, near);
    currentBuild.highestHr = Math.max(Number(currentBuild.highestHr || 0), Number(sample.hr ?? sample.currentHr ?? 0)) || currentBuild.highestHr;
    state.buildBeforeRecovery = currentBuild;
  }

  let edgingCandidate = null;
  if (recovering && !state.recoveryEpisodeActive) {
    state.recoveryEpisodeActive = true;
    edgingCandidate = maybeRecordEdgingCandidate(state, at, prediction, sample);
  }
  if (!recovering && state.recoveryEpisodeActive && near >= options.buildResumedThreshold) {
    state.recoveryEpisodeActive = false;
    const last = state.edgingCandidates[state.edgingCandidates.length - 1];
    if (last && !last.resumedBuildMs) last.resumedBuildMs = at;
  }
  if (!recovering && near < 25) {
    state.buildBeforeRecovery = null;
    state.recoveryEpisodeActive = false;
  }

  const sustainedReady = setCandidate(
    state,
    LIVE_CUE_TYPES.sustained_build,
    near >= options.sustainedBuildThreshold && !recovering,
    at,
    options.sustainedBuildMs
  );
  const possibleReady = setCandidate(
    state,
    LIVE_CUE_TYPES.climax_possible,
    near >= options.climaxPossibleThreshold && !recovering && !hrvOnly && usefulFamilyCount >= 1 && multimodalTrusted && controllerTrusted,
    at,
    options.climaxPossibleMs
  );
  const imminentReady = setCandidate(
    state,
    LIVE_CUE_TYPES.climax_imminent,
    near >= options.climaxImminentThreshold && !recovering && !hrvOnly && usefulFamilyCount >= (sample.hasMultipleSignalFamilies ? 2 : 1) && multimodalTrusted && controllerTrusted,
    at,
    options.climaxImminentMs
  );
  const recoveryReady = setCandidate(
    state,
    LIVE_CUE_TYPES.recovery,
    (recovering || recovery >= options.recoveryThreshold) && near < options.climaxImminentThreshold,
    at,
    options.recoveryMs
  );
  const plateauReady = setCandidate(
    state,
    LIVE_CUE_TYPES.plateau_encouragement,
    plateau >= options.plateauThreshold
      && Boolean(prediction.plateauDwell || prediction.physiologicalIntensity === "high_plateau")
      && !recovering
      && usefulFamilyCount >= 1
      && multimodalTrusted
      && controllerTrusted,
    at,
    options.plateauMs
  );
  const resumedReady = setCandidate(
    state,
    LIVE_CUE_TYPES.build_resumed,
    !recovering && state.recoveryEpisodeActive === false && Boolean(state.edgingCandidates.length) && near >= options.buildResumedThreshold,
    at,
    options.buildResumedMs
  );

  const candidates = [
    imminentReady && hasPhrase(phrases, LIVE_CUE_TYPES.climax_imminent) ? { type: LIVE_CUE_TYPES.climax_imminent, state: "climax_imminent" } : null,
    possibleReady && hasPhrase(phrases, LIVE_CUE_TYPES.climax_possible) ? { type: LIVE_CUE_TYPES.climax_possible, state: "climax_possible" } : null,
    plateauReady && hasPhrase(phrases, LIVE_CUE_TYPES.plateau_encouragement) ? { type: LIVE_CUE_TYPES.plateau_encouragement, state: "plateau_encouragement" } : null,
    resumedReady && hasPhrase(phrases, LIVE_CUE_TYPES.build_resumed) ? { type: LIVE_CUE_TYPES.build_resumed, state: "build_resumed" } : null,
    sustainedReady && hasPhrase(phrases, LIVE_CUE_TYPES.sustained_build) ? { type: LIVE_CUE_TYPES.sustained_build, state: "sustained_build" } : null,
    recoveryReady && hasPhrase(phrases, LIVE_CUE_TYPES.recovery) ? { type: LIVE_CUE_TYPES.recovery, state: "recovery" } : null,
  ];

  const selected = selectCue(candidates);
  if (!selected) return { state, cue: null, suppressed, edgingCandidate };

  const gate = canSpeak(state, selected.type, at, options);
  if (!gate.ok) {
    return { state, cue: null, suppressed: [{ type: selected.type, reason: gate.reason }], edgingCandidate };
  }

  return {
    state,
    cue: acceptCue(state, selected, phrases, at, prediction, sample),
    suppressed,
    edgingCandidate,
  };
}
