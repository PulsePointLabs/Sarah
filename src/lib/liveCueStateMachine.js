import { LIVE_CUE_PRIORITY, LIVE_CUE_TYPES, pickCuePhrase } from "./liveCuePhrases.js";

export const DEFAULT_LIVE_CUE_MACHINE_OPTIONS = Object.freeze({
  enabled: true,
  captureKind: "session",
  allowSessionStyleCues: false,
  sustainedBuildThreshold: 42,
  sustainedBuildMs: 10_000,
  activityEvidenceMs: 20_000,
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
  bodyStressMs: 12_000,
  globalCooldownMs: 14_000,
  cooldowns: {
    body_relaxation: 75_000,
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
    recoveryTransitions: 0,
    activityEstablished: false,
    activityEstablishedAtMs: null,
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
  const nextIndex = state.lastCuePhraseIndex[cue.type] || 0;
  const phrase = pickCuePhrase(phrases, cue.type, nextIndex, { prediction, sample });
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
      bodyStressScore: cue.bodyStressScore ?? null,
      hrDelta: cue.hrDelta ?? null,
      respiratoryStrain: Boolean(prediction.respiratoryStrain),
      possibleBreathHold: Boolean(prediction.possibleBreathHold),
    },
    sample: {
      hr: sample.hr ?? sample.currentHr ?? null,
      baselineHr: sample.baselineHr ?? null,
      sessionTimeSec: sample.sessionTimeSec ?? null,
    },
  };
}

export function stepLiveCueStateMachine(previousState, prediction = {}, sample = {}, optionsInput = {}, phrases = {}) {
  const options = { ...DEFAULT_LIVE_CUE_MACHINE_OPTIONS, ...(optionsInput || {}) };
  const state = previousState ? structuredClone(previousState) : createLiveCueStateMachineState();
  const at = nowMs(sample);
  const suppressed = [];

  if (!options.enabled) return { state, cue: null, suppressed: [{ type: "all", reason: "disabled" }] };
  if (options.captureKind === "body_exploration" && !options.allowSessionStyleCues) {
    const hr = Number(sample.hr ?? sample.currentHr);
    const baselineHr = Number(sample.baselineHr);
    const hrDelta = Number.isFinite(hr) && Number.isFinite(baselineHr) ? hr - baselineHr : 0;
    const hrvStrain = Boolean(prediction.hrvUsable && ["compressed", "tightening"].includes(String(prediction.hrvSignal || "").toLowerCase()));
    const respiratoryStrain = Boolean(prediction.respiratoryStrain || prediction.possibleBreathHold);
    const markedHrLoad = hrDelta >= 15 && Number(prediction.recentSlope ?? sample.recentSlope ?? 0) >= -0.5;
    const bodyStressScore = Math.min(100, Math.round(
      Math.max(0, hrDelta - 6) * 4
      + (hrvStrain ? 30 : 0)
      + (respiratoryStrain ? 25 : 0),
    ));
    const relaxationReady = setCandidate(
      state,
      LIVE_CUE_TYPES.body_relaxation,
      (hrDelta >= 10 && (hrvStrain || respiratoryStrain)) || markedHrLoad,
      at,
      options.bodyStressMs,
    );
    if (!relaxationReady || !hasPhrase(phrases, LIVE_CUE_TYPES.body_relaxation)) {
      return { state, cue: null, suppressed: [] };
    }
    const gate = canSpeak(state, LIVE_CUE_TYPES.body_relaxation, at, {
      ...options,
      globalCooldownMs: Math.max(20_000, options.globalCooldownMs),
      maxCuesPerMinute: Math.min(2, options.maxCuesPerMinute),
    });
    if (!gate.ok) return { state, cue: null, suppressed: [{ type: LIVE_CUE_TYPES.body_relaxation, reason: gate.reason }] };
    return {
      state,
      cue: acceptCue(state, {
        type: LIVE_CUE_TYPES.body_relaxation,
        state: "body_relaxation",
        bodyStressScore,
        hrDelta: Math.round(hrDelta),
      }, phrases, at, prediction, sample),
      suppressed: [],
    };
  }

  const near = Number(prediction.nearClimax || 0);
  const recovery = Number(prediction.recovery || 0);
  const plateau = Number(prediction.plateauScore || 0);
  const rawRecovering = isRecovery(prediction);
  const multimodalTrusted = prediction.multimodalAvailable ? prediction.multimodalTrusted === true : true;
  const controllerTrusted = Number(prediction.controllerConfidence || 0) >= 50 || !prediction.multimodalAvailable;
  const families = supportFamilies(prediction, sample);
  const usefulFamilyCount = families.length;
  const hrvOnly = families.length === 1 && families[0] === "hrv";
  const activityReady = setCandidate(
    state,
    "activity_evidence",
    !rawRecovering
      && near >= options.sustainedBuildThreshold
      && usefulFamilyCount >= 1
      && multimodalTrusted
      && controllerTrusted,
    at,
    options.activityEvidenceMs,
  );
  if (activityReady && !state.activityEstablished) {
    state.activityEstablished = true;
    state.activityEstablishedAtMs = at;
  }
  const recovering = Boolean(state.activityEstablished && rawRecovering);

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

  if (recovering && !state.recoveryEpisodeActive) {
    state.recoveryEpisodeActive = true;
    state.recoveryTransitions += 1;
  }
  if (!recovering && state.recoveryEpisodeActive && near >= options.buildResumedThreshold) {
    state.recoveryEpisodeActive = false;
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
    state.activityEstablished && (recovering || recovery >= options.recoveryThreshold) && near < options.climaxImminentThreshold,
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
    state.activityEstablished && !recovering && state.recoveryEpisodeActive === false && state.recoveryTransitions > 0 && near >= options.buildResumedThreshold,
    at,
    options.buildResumedMs
  );

  const candidates = [
    state.activityEstablished && imminentReady && hasPhrase(phrases, LIVE_CUE_TYPES.climax_imminent) ? { type: LIVE_CUE_TYPES.climax_imminent, state: "climax_imminent" } : null,
    state.activityEstablished && possibleReady && hasPhrase(phrases, LIVE_CUE_TYPES.climax_possible) ? { type: LIVE_CUE_TYPES.climax_possible, state: "climax_possible" } : null,
    state.activityEstablished && plateauReady && hasPhrase(phrases, LIVE_CUE_TYPES.plateau_encouragement) ? { type: LIVE_CUE_TYPES.plateau_encouragement, state: "plateau_encouragement" } : null,
    state.activityEstablished && resumedReady && hasPhrase(phrases, LIVE_CUE_TYPES.build_resumed) ? { type: LIVE_CUE_TYPES.build_resumed, state: "build_resumed" } : null,
    state.activityEstablished && sustainedReady && hasPhrase(phrases, LIVE_CUE_TYPES.sustained_build) ? { type: LIVE_CUE_TYPES.sustained_build, state: "sustained_build" } : null,
    recoveryReady && hasPhrase(phrases, LIVE_CUE_TYPES.recovery) ? { type: LIVE_CUE_TYPES.recovery, state: "recovery" } : null,
  ];

  const selected = selectCue(candidates);
  if (!selected) return { state, cue: null, suppressed };

  const gate = canSpeak(state, selected.type, at, options);
  if (!gate.ok) {
    return { state, cue: null, suppressed: [{ type: selected.type, reason: gate.reason }] };
  }

  return {
    state,
    cue: acceptCue(state, selected, phrases, at, prediction, sample),
    suppressed,
  };
}
