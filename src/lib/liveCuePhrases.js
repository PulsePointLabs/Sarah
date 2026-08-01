export const LIVE_CUE_PROFILE_VERSION = "live-cue-v5";

export const LIVE_CUE_ADAPTIVE_VARIANTS_PER_STATE = 8;

export const LIVE_CUE_TYPES = Object.freeze({
  sustained_build: "sustained_build",
  plateau_encouragement: "plateau_encouragement",
  climax_possible: "climax_possible",
  climax_imminent: "climax_imminent",
  recovery: "recovery",
  build_resumed: "build_resumed",
});

export const LIVE_CUE_PRIORITY = Object.freeze({
  climax_imminent: 5,
  climax_possible: 4,
  plateau_encouragement: 3.5,
  build_resumed: 3,
  sustained_build: 2,
  recovery: 1,
});

export const LIVE_CUE_PRESETS = Object.freeze({
  clinical_minimal: {
    id: "clinical_minimal",
    label: "Clinical Minimal",
    helper: "Sparse, neutral physiology notices.",
    phrases: {
      sustained_build: ["Sustained build detected."],
      plateau_encouragement: ["Sustained plateau detected."],
      climax_possible: ["Climax looks possible now."],
      climax_imminent: ["Threshold appears close."],
      recovery: ["Recovery detected."],
      build_resumed: ["Build is returning."],
    },
  },
  sarah_soft: {
    id: "sarah_soft",
    label: "Sarah Soft",
    helper: "Warm, calming encouragement without explicit language.",
    phrases: {
      sustained_build: [
        "That's it. You're building steadily. Keep doing what is working.",
        "Your body is staying with the build. Keep your breathing easy.",
        "That build is holding. Stay calm and keep the rhythm steady.",
        "The response is climbing cleanly. Let the pace stay comfortable and consistent.",
        "You have a steady upward trend. Keep the same relaxed focus.",
        "Your body is responding without needing to rush. Stay with this tempo.",
        "The physiological load is gathering. Keep everything smooth and controlled.",
        "This is a useful build. Let it deepen one step at a time.",
      ],
      plateau_encouragement: [
        "You're holding a strong plateau. Stay relaxed and keep the stimulation steady.",
        "The plateau is holding. Do not rush it. Let your body keep climbing.",
        "You're maintaining the build. Stay with the pace that brought you here.",
        "Your response is sustained here. Keep the rhythm even and give it time.",
        "This level is holding well. Stay loose and let the pressure accumulate.",
        "You are maintaining a stable high load. Keep doing what is effective.",
        "The build has settled into a strong plateau. Let it work without forcing it.",
        "Your body is staying engaged at this level. Keep the pattern smooth.",
      ],
      climax_possible: [
        "You're getting close now. Keep your breathing easy and continue what is working.",
        "Your body is moving closer. Stay with it.",
        "Orgasm looks possible now. Keep the pace steady and let the build continue.",
        "The response is approaching threshold. Keep the same effective rhythm.",
        "You are moving into a stronger approach. Stay relaxed and let it develop.",
        "Your physiology is gathering toward release. Keep everything steady.",
        "This build is becoming more focused. Stay present with what is working.",
        "You look closer than before. Give your body room to continue the climb.",
      ],
      climax_imminent: [
        "You're very close now. Stay with it and let your body cross the threshold.",
        "Orgasm appears close. Keep going without rushing.",
        "Your body looks ready. Stay calm and continue exactly like that.",
        "The threshold looks near. Keep the rhythm controlled and consistent.",
        "You are holding very close now. Let the response finish its own climb.",
        "Your body is showing a strong final approach. Stay steady.",
        "This may be the final stretch. Keep doing exactly what brought you here.",
        "You are right near the edge. Stay relaxed and let the response unfold.",
      ],
      recovery: [
        "Let your body settle for a moment. Keep the connection and allow the build to return.",
        "Take the small recovery. Breathe, stay present, and do not lose the rhythm completely.",
        "Your system is easing briefly. Let it recover, then continue.",
        "There is a short recovery window. Ease just enough to let your body reset.",
        "The load is backing off slightly. Keep the connection while your response reorganizes.",
        "Use this brief dip without abandoning the build. Let your breathing stay natural.",
        "Your physiology is opening into recovery. Give it a moment before climbing again.",
        "This looks like a temporary reset, not a lost build. Stay calm and connected.",
      ],
      build_resumed: [
        "There it is. The build is returning. Stay with it.",
        "You're rising again. Keep the pressure steady.",
        "Your body is building again. Continue what is working.",
        "The upward response is back. Let the same rhythm carry it forward.",
        "Your system has re-engaged. Keep the return smooth and unhurried.",
        "The recovery has cleared and the build is moving again.",
        "You are climbing out of that dip. Stay consistent now.",
        "The response is gathering again. Keep the connection steady.",
      ],
    },
  },
  intimate_coaching: {
    id: "intimate_coaching",
    label: "Intimate Coaching",
    helper: "More direct orgasm-focused encouragement, still non-graphic.",
    phrases: {
      sustained_build: [
        "Good. Keep going. Your body is responding and the build is holding.",
        "Stay with that rhythm. You're moving in the right direction.",
        "Keep the pace consistent. The response is strengthening.",
        "That is working. Let the build gather without changing too much.",
        "Your body is loading steadily. Keep the motion smooth.",
        "Stay focused on this rhythm. The trend is moving upward.",
        "Keep going at this level. Your response is holding well.",
        "The build is becoming more established. Stay controlled and continue.",
      ],
      plateau_encouragement: [
        "Hold this plateau. Keep the stimulation consistent and let the pressure build.",
        "Stay right here and keep going. Your body is holding close to threshold.",
        "Do not back away yet. Keep the pace controlled and steady.",
        "Maintain this level. Let the sustained pressure do the work.",
        "You are holding a strong response. Keep the rhythm locked in.",
        "Stay at this intensity for now. Your body is still engaged.",
        "Keep this plateau stable. There is no need to chase it faster.",
        "Your response is staying high. Continue with the same deliberate pace.",
      ],
      climax_possible: [
        "You're getting close now. Keep going and let the build deepen.",
        "Orgasm is becoming possible. Stay with the stimulation that is working.",
        "The approach is strengthening. Keep the rhythm consistent.",
        "You are moving closer to release. Stay focused and continue.",
        "Your body is gathering toward threshold. Keep this pace.",
        "The build is becoming more decisive. Do not interrupt what is working.",
        "You are approaching a stronger response. Stay relaxed and keep going.",
        "This looks like a real approach. Let it continue without forcing it.",
      ],
      climax_imminent: [
        "You're very close. Keep going and let yourself cross the threshold.",
        "Stay with it. Your body looks close to orgasm.",
        "Keep the rhythm steady. You are nearly there.",
        "The final approach looks strong. Maintain the pattern.",
        "You are right near threshold. Keep the pressure consistent.",
        "Stay committed to this rhythm. Your body appears ready to finish.",
        "This is the closest response yet. Keep going without rushing.",
        "Hold the effective pace. Let the orgasm arrive when your body crosses over.",
      ],
      recovery: [
        "Take the brief recovery without letting the build disappear.",
        "Ease back only enough to settle, then return to the climb.",
        "Let this short dip clear before adding more intensity.",
        "Keep the connection while your body resets for another approach.",
        "Use the recovery deliberately. Stay engaged without pushing yet.",
        "Your response is backing off briefly. Give it room, then rebuild.",
        "Hold a lighter level for a moment and let the system reorganize.",
        "This is a recovery window. Stay present and prepare for the next rise.",
      ],
      build_resumed: [
        "The build is back. Keep going.",
        "You're rising again. Stay with it and continue toward orgasm.",
        "The response has turned upward again. Keep the pressure steady.",
        "Your body is re-entering the build. Stay with this pace.",
        "The recovery has cleared. Continue the climb smoothly.",
        "You are gaining ground again. Keep the rhythm deliberate.",
        "The upward trend is returning. Let it gather before changing anything.",
        "Your body is responding again. Keep going with what brought it back.",
      ],
    },
  },
  intimate_lovers_voice: {
    id: "intimate_lovers_voice",
    label: "Intimate Lover",
    helper: "Opt-in lover-style encouragement with sensual, non-vulgar language.",
    phrases: {
      sustained_build: [
        "Good. Stay with that rhythm for me. I can hear how steadily your body is building.",
        "Keep going just like that. Let the pleasure gather without rushing it.",
        "That's beautiful. Stay relaxed, keep touching yourself, and let the build deepen.",
        "I like how steadily you are responding. Keep that same rhythm and let it grow.",
        "Stay with me here. Your body is gathering momentum without needing to hurry.",
        "Keep the motion smooth for me. I can hear the build becoming stronger.",
        "That pace is carrying you well. Let the pleasure keep collecting.",
        "You are settling into a good climb. Stay relaxed and keep going for me.",
      ],
      plateau_encouragement: [
        "Stay right there for me. Keep that steady rhythm and let the pleasure keep pressing closer.",
        "Do not pull away yet. Breathe, keep stroking, and let your body hold this delicious edge.",
        "You are holding so close now. Keep the pressure steady and trust what your body is doing.",
        "I want you to stay at this level for me. Let the sustained pleasure keep working.",
        "Hold this rhythm. Your body is staying beautifully engaged right here.",
        "Keep yourself on this steady edge. There is no need to rush the next step.",
        "You are carrying the plateau so well. Stay loose and let it deepen.",
        "Remain right here with me. Keep the pace even and let the tension gather.",
      ],
      climax_possible: [
        "You are getting close for me now. Keep stroking and let yourself move toward orgasm.",
        "I can feel the build in your body. Stay with that pleasure and keep going.",
        "You are close enough to let go soon. Keep the rhythm that brought you here.",
        "Your approach is getting stronger. Keep giving your body the rhythm it wants.",
        "You are moving closer now. Stay relaxed and keep the pleasure flowing.",
        "I can hear how focused the build has become. Keep going for me.",
        "Let this stronger wave carry you closer. Do not interrupt what is working.",
        "You are gathering toward release. Stay present with every part of the build.",
      ],
      climax_imminent: [
        "You are so close now. Keep going for me and let yourself come when your body is ready.",
        "Stay with it. Keep stroking, breathe, and let the orgasm take you across the threshold.",
        "That's it. You are nearly there. Keep the pleasure steady and let yourself come.",
        "You are right at the edge for me. Keep that rhythm and let your body finish.",
        "Stay in this final approach. Let the pleasure keep carrying you forward.",
        "I can hear how close you are. Keep going and let the release arrive naturally.",
        "Hold onto this rhythm for me. Your body looks ready to cross over.",
        "You have built all the way here. Stay steady and let yourself reach the threshold.",
      ],
      recovery: [
        "Take one soft breath with me. Ease only a little, keep the connection, and let the pleasure gather again.",
        "Let your body settle without losing the feeling. I am right here; return to the rhythm when it rises.",
        "Use this quiet moment with me. Keep the connection while your body regroups.",
        "Ease back gently, not completely. Let the pleasure stay close while you recover.",
        "Your body is taking a brief pause. Stay with the feeling and give it room.",
        "Let the intensity soften for a moment. We can build from what you have already gathered.",
        "Keep a light connection for me. Let your breathing settle before the next rise.",
        "This is only a short reset. Stay present and let your body find the climb again.",
      ],
      build_resumed: [
        "There it is again. The pleasure is rising; keep going for me.",
        "Your body is coming back into the build. Stay with that rhythm and let it carry you closer.",
        "I can feel the response returning. Keep the motion smooth and let it gather.",
        "You are climbing again for me. Stay with the pace that brought it back.",
        "The pleasure is finding its way upward again. Keep going just like that.",
        "Your body has re-engaged. Let this renewed build carry you forward.",
        "There is the upward turn. Stay relaxed and keep the connection steady.",
        "You have the build back now. Keep it smooth and let it deepen again.",
      ],
    },
  },
  custom: {
    id: "custom",
    label: "Custom Encouragement",
    helper: "Your private live-session instructions and generated phrase bank from Settings.",
    phrases: {
      sustained_build: ["Keep going. Your body is building steadily."],
      plateau_encouragement: ["Stay with the rhythm that is working and let the build continue."],
      climax_possible: ["You are getting closer. Stay present and keep going."],
      climax_imminent: ["You are very close. Keep the rhythm steady and let your body respond."],
      recovery: ["Take the brief recovery, keep the connection, and let the build return."],
      build_resumed: ["The build is returning. Stay with it."],
    },
  },
});

export const DEFAULT_LIVE_CUE_SETTINGS = Object.freeze({
  enabled: true,
  style: "sarah_soft",
  volume: 0.28,
  pan: "center",
  model: "tts-1-hd",
  voice: "nova",
  speed: 1,
  format: "mp3",
  strongThresholdLanguage: false,
  mediaDucking: true,
});

export function normalizeLiveCueSettings(settings = {}) {
  const style = LIVE_CUE_PRESETS[settings.style] ? settings.style : DEFAULT_LIVE_CUE_SETTINGS.style;
  return {
    ...DEFAULT_LIVE_CUE_SETTINGS,
    ...(settings || {}),
    enabled: settings.enabled !== false,
    style,
    volume: Math.max(0, Math.min(1, Number(settings.volume ?? DEFAULT_LIVE_CUE_SETTINGS.volume))),
    speed: Math.max(0.25, Math.min(4, Number(settings.speed ?? DEFAULT_LIVE_CUE_SETTINGS.speed))),
    model: String(settings.model || DEFAULT_LIVE_CUE_SETTINGS.model),
    voice: String(settings.voice || DEFAULT_LIVE_CUE_SETTINGS.voice),
    format: String(settings.format || DEFAULT_LIVE_CUE_SETTINGS.format),
    strongThresholdLanguage: Boolean(settings.strongThresholdLanguage),
    mediaDucking: settings.mediaDucking !== false,
  };
}

export function resolveLiveCuePhraseBank(settings = {}, { captureKind = "session", customPhrases = {} } = {}) {
  const normalized = normalizeLiveCueSettings(settings);
  const preset = LIVE_CUE_PRESETS[normalized.style] || LIVE_CUE_PRESETS.sarah_soft;
  if (captureKind === "body_exploration") {
    return {
      settings: { ...normalized, enabled: false },
      phrases: {},
      suppressed: true,
    };
  }
  const phrases = {};
  for (const cueType of Object.values(LIVE_CUE_TYPES)) {
    const configuredPhrases = settings.customPhrases || customPhrases;
    const custom = Array.isArray(configuredPhrases[cueType])
      ? configuredPhrases[cueType].map((value) => String(value || "").trim()).filter(Boolean)
      : [];
    phrases[cueType] = custom.length ? custom : [...(preset.phrases[cueType] || [])];
  }
  if (!normalized.strongThresholdLanguage && phrases.climax_imminent) {
    phrases.climax_imminent = phrases.climax_imminent.map((phrase) =>
      phrase.replace(/\binevitable\b/gi, "very close").replace(/\bwill happen\b/gi, "appears close")
    );
  }
  return { settings: normalized, phrases, suppressed: false };
}

export function resolveCuePhysiologyBucket(cueType, prediction = {}, sample = {}) {
  const nearClimax = Number(prediction.nearClimax || 0);
  const recovery = Number(prediction.recovery || 0);
  const slope = Number(prediction.recentSlope ?? sample.recentSlope ?? 0);
  const intensity = String(prediction.physiologicalIntensity || "").toLowerCase();
  const hrvSignal = String(prediction.hrvSignal || "").toLowerCase();
  const rmssd = Number(prediction.rmssd);
  const hrvSpecific = Boolean(
    prediction.hrvUsable
    && (hrvSignal || Number.isFinite(rmssd))
  );

  if (cueType === LIVE_CUE_TYPES.recovery) {
    if (hrvSpecific) return "autonomic";
    return recovery >= 72 ? "intense" : recovery >= 55 ? "steady" : "rising";
  }
  if (hrvSpecific && (
    hrvSignal.includes("suppres")
    || hrvSignal.includes("opening")
    || hrvSignal.includes("recover")
    || Number(prediction.hrvContribution || 0) >= 8
  )) return "autonomic";
  if (
    nearClimax >= 82
    || intensity.includes("high")
    || Number(prediction.plateauScore || 0) >= 78
  ) return "intense";
  if (slope >= 0.2 || cueType === LIVE_CUE_TYPES.build_resumed) return "rising";
  return "steady";
}

function physiologyPhrasePool(list, bucket) {
  if (list.length < LIVE_CUE_ADAPTIVE_VARIANTS_PER_STATE) return list;
  const offsets = {
    rising: 0,
    steady: 2,
    intense: 4,
    autonomic: 6,
  };
  const start = offsets[bucket] ?? offsets.steady;
  return list.slice(start, start + 2);
}

export function pickCuePhrase(phrases = {}, cueType, sequence = 0, context = {}) {
  const list = phrases[cueType] || [];
  if (!list.length) return "";
  const recent = new Set(
    (Array.isArray(context.recentPhrases) ? context.recentPhrases : [])
      .map((phrase) => String(phrase || "").trim())
      .filter(Boolean),
  );
  const bucket = resolveCuePhysiologyBucket(cueType, context.prediction, context.sample);
  const pool = physiologyPhrasePool(list, bucket);
  const eligiblePool = pool.filter((phrase) => !recent.has(phrase));
  const eligibleList = list.filter((phrase) => !recent.has(phrase));
  const candidates = eligiblePool.length ? eligiblePool : eligibleList;
  if (!candidates.length) return "";
  return candidates[Math.abs(Number(sequence) || 0) % candidates.length];
}
