export const LIVE_CUE_PROFILE_VERSION = "live-cue-v6";

export const LIVE_CUE_ADAPTIVE_VARIANTS_PER_STATE = 8;

export const LIVE_CUE_TYPES = Object.freeze({
  body_relaxation: "body_relaxation",
  sustained_build: "sustained_build",
  plateau_encouragement: "plateau_encouragement",
  climax_possible: "climax_possible",
  climax_imminent: "climax_imminent",
  recovery: "recovery",
  build_resumed: "build_resumed",
});

export const LIVE_CUE_PRIORITY = Object.freeze({
  body_relaxation: 6,
  climax_imminent: 5,
  climax_possible: 4,
  plateau_encouragement: 3.5,
  build_resumed: 3,
  sustained_build: 2,
  recovery: 1,
});

const LIVE_CUE_FALLBACK_VARIANTS = Object.freeze({
  sustained_build: [
    "That build is steady. Keep the pace comfortable and consistent.",
    "Your body is responding. Stay relaxed and continue what is working.",
    "The upward trend is holding. Keep your breathing easy.",
    "You are maintaining a useful rhythm. Let the build develop without rushing it.",
    "The response is still climbing. Stay with the same calm pace.",
    "Your physiology is staying engaged. Keep the pressure and breathing even.",
    "This is a sustained build. Keep doing what brought you here.",
    "The build remains stable. Stay loose and let it continue.",
  ],
  plateau_encouragement: [
    "You are holding a strong plateau. Stay relaxed and keep the stimulation steady.",
    "The plateau is holding. Do not rush it; let your body keep climbing.",
    "You are maintaining the build. Stay with the pace that brought you here.",
    "This level is staying consistent. Keep your breathing smooth and the rhythm even.",
    "Your body is holding near the same level. Give it time and keep the pattern steady.",
    "The response is sustained. Relax anything that does not need to tense.",
    "You are staying in the build. Keep the input predictable and controlled.",
    "That plateau is useful. Stay present and let the next rise happen naturally.",
  ],
  climax_possible: [
    "You are getting closer. Keep your breathing easy and continue what is working.",
    "Your body is moving closer. Stay with the same steady rhythm.",
    "Climax looks possible now. Keep the pace even and let the build continue.",
    "The signals are lining up. Stay relaxed and avoid changing too much.",
    "You may be approaching threshold. Keep doing what is working.",
    "The trend is getting stronger. Breathe and stay with the build.",
    "You are in a higher-probability window. Keep the rhythm controlled.",
    "Your physiology is moving toward threshold. Stay calm and consistent.",
  ],
  climax_imminent: [
    "You are very close now. Stay with it and let your body cross the threshold.",
    "Climax appears close. Keep going without rushing.",
    "Your body looks ready. Stay calm and continue exactly like that.",
    "This is a strong threshold window. Keep the rhythm steady.",
    "The approach signal is high. Breathe and stay with what is working.",
    "You are holding very near threshold. Keep your pace controlled.",
    "The trend remains strong. Stay relaxed and let your body respond.",
    "You are close enough that consistency matters most. Keep going steadily.",
  ],
  recovery: [
    "Let your body settle for a moment, then allow the build to return.",
    "Take the small recovery. Breathe and stay present.",
    "Your system is easing briefly. Let it recover before you climb again.",
    "This looks like a recovery window. Soften your breathing and tension.",
    "The load is coming down. Give your body a moment without losing the connection.",
    "Use this dip to reset your breathing and relax your shoulders.",
    "A brief recovery is showing. Let the next rise come naturally.",
    "Your physiology is settling. Stay comfortable and prepare for the next build.",
  ],
  build_resumed: [
    "There it is. The build is returning. Stay with it.",
    "You are rising again. Keep the pressure steady.",
    "Your body is building again. Continue what is working.",
    "The upward trend has returned. Keep the rhythm even.",
    "Your response is climbing again. Stay relaxed and consistent.",
    "The recovery window is ending and the build is back.",
    "You have regained the build. Keep your breathing smooth.",
    "The signal is rising again. Let it develop at the same steady pace.",
  ],
});

function ensureCueVariantCount(cueType, values = []) {
  const combined = [...values, ...(LIVE_CUE_FALLBACK_VARIANTS[cueType] || [])]
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  return [...new Set(combined)].slice(0, LIVE_CUE_ADAPTIVE_VARIANTS_PER_STATE);
}

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
      sustained_build: ["That's it. You're building steadily. Keep doing what is working.", "Your body is staying with the build. Keep your breathing easy.", "That build is holding. Stay calm and keep the rhythm steady."],
      plateau_encouragement: ["You're holding a strong plateau. Stay relaxed and keep the stimulation steady.", "The plateau is holding. Do not rush it. Let your body keep climbing.", "You're maintaining the build. Stay with the pace that brought you here."],
      climax_possible: ["You're getting close now. Keep your breathing easy and continue what is working.", "Your body is moving closer. Stay with it.", "Orgasm looks possible now. Keep the pace steady and let the build continue."],
      climax_imminent: ["You're very close now. Stay with it and let your body cross the threshold.", "Orgasm appears close. Keep going without rushing.", "Your body looks ready. Stay calm and continue exactly like that."],
      recovery: ["Let your body settle for a moment. Keep the connection and allow the build to return.", "Take the small recovery. Breathe, stay present, and do not lose the rhythm completely.", "Your system is easing briefly. Let it recover, then continue."],
      build_resumed: ["There it is. The build is returning. Stay with it.", "You're rising again. Keep the pressure steady.", "Your body is building again. Continue what is working."],
    },
  },
  intimate_coaching: {
    id: "intimate_coaching",
    label: "Intimate Coaching",
    helper: "More direct orgasm-focused encouragement, still non-graphic.",
    phrases: {
      sustained_build: ["Good. Keep going. Your body is responding and the build is holding.", "Stay with that rhythm. You're moving in the right direction."],
      plateau_encouragement: ["Hold this plateau. Keep the stimulation consistent and let the pressure build.", "Stay right here and keep going. Your body is holding close to threshold.", "Do not back away yet. Keep the pace controlled and steady."],
      climax_possible: ["You're getting close now. Keep going and let the build deepen.", "Orgasm is becoming possible. Stay with the stimulation that is working."],
      climax_imminent: ["You're very close. Keep going and let yourself cross the threshold.", "Stay with it. Your body looks close to orgasm.", "Keep the rhythm steady. You are nearly there."],
      recovery: ["Take the brief recovery without letting the build disappear.", "Ease back only enough to settle, then return to the climb."],
      build_resumed: ["The build is back. Keep going.", "You're rising again. Stay with it and continue toward orgasm."],
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
      ],
      plateau_encouragement: [
        "Stay right there for me. Keep that steady rhythm and let the pleasure keep pressing closer.",
        "Do not pull away yet. Breathe, keep stroking, and let your body hold this delicious edge.",
        "You are holding so close now. Keep the pressure steady and trust what your body is doing.",
      ],
      climax_possible: [
        "You are getting close for me now. Keep stroking and let yourself move toward orgasm.",
        "I can feel the build in your body. Stay with that pleasure and keep going.",
        "You are close enough to let go soon. Keep the rhythm that brought you here.",
      ],
      climax_imminent: [
        "You are so close now. Keep going for me and let yourself come when your body is ready.",
        "Stay with it. Keep stroking, breathe, and let the orgasm take you across the threshold.",
        "That's it. You are nearly there. Keep the pleasure steady and let yourself come.",
      ],
      recovery: [
        "Take one soft breath with me. Ease only a little, keep the connection, and let the pleasure gather again.",
        "Let your body settle without losing the feeling. I am right here; return to the rhythm when it rises.",
      ],
      build_resumed: [
        "There it is again. The pleasure is rising; keep going for me.",
        "Your body is coming back into the build. Stay with that rhythm and let it carry you closer.",
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
  if (captureKind === "body_exploration" && !settings.allowSessionStyleCues) {
    return {
      settings: normalized,
      phrases: {
        body_relaxation: [
          "Your physiology is showing some strain. Unclench your jaw and pelvic floor, then take one slow breath.",
          "Ease your shoulders and abdomen. Slow inhale, longer exhale, and let the table carry your weight.",
          "Soften your legs and pelvic floor. Breathe low and slow, and let the tension come down.",
          "Take a small pause if you need it. Relax your belly and make the next exhale longer than the inhale.",
          "Let your hands and shoulders soften. Take one quiet breath before continuing.",
          "Release any unnecessary tension through your abdomen, thighs, and pelvic floor.",
          "Slow the pace for one breath. Let the exhale carry some of the strain away.",
          "Check your jaw and shoulders, then loosen both while keeping your breathing smooth.",
        ],
      },
      suppressed: true,
    };
  }
  const preset = LIVE_CUE_PRESETS[normalized.style] || LIVE_CUE_PRESETS.sarah_soft;
  const phrases = {};
  for (const cueType of Object.values(LIVE_CUE_TYPES)) {
    const configuredPhrases = settings.customPhrases || customPhrases;
    const custom = Array.isArray(configuredPhrases[cueType])
      ? configuredPhrases[cueType].map((value) => String(value || "").trim()).filter(Boolean)
      : [];
    phrases[cueType] = ensureCueVariantCount(cueType, custom.length ? custom : preset.phrases[cueType]);
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

function physiologyPhraseOffset(list, bucket) {
  if (list.length < LIVE_CUE_ADAPTIVE_VARIANTS_PER_STATE) return 0;
  const offsets = {
    rising: 0,
    steady: 2,
    intense: 4,
    autonomic: 6,
  };
  return offsets[bucket] ?? offsets.steady;
}

export function pickCuePhrase(phrases = {}, cueType, sequence = 0, context = {}) {
  const list = phrases[cueType] || [];
  if (!list.length) return "";
  const bucket = resolveCuePhysiologyBucket(cueType, context.prediction, context.sample);
  const offset = physiologyPhraseOffset(list, bucket);
  return list[(Math.abs(Number(sequence) || 0) + offset) % list.length];
}
