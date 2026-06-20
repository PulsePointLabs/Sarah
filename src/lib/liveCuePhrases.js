export const LIVE_CUE_PROFILE_VERSION = "live-cue-v1";

export const LIVE_CUE_TYPES = Object.freeze({
  sustained_build: "sustained_build",
  climax_possible: "climax_possible",
  climax_imminent: "climax_imminent",
  recovery: "recovery",
  build_resumed: "build_resumed",
});

export const LIVE_CUE_PRIORITY = Object.freeze({
  climax_imminent: 5,
  climax_possible: 4,
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
      climax_possible: ["Climax looks possible now."],
      climax_imminent: ["Threshold appears close."],
      recovery: ["Recovery detected."],
      build_resumed: ["Build is returning."],
    },
  },
  sarah_soft: {
    id: "sarah_soft",
    label: "Sarah Soft",
    helper: "Warm, quiet, and lightly personal.",
    phrases: {
      sustained_build: ["You're holding a sustained build.", "Your body is staying in the build.", "That build is holding."],
      climax_possible: ["Climax looks possible now.", "You're moving closer.", "Your body may be approaching threshold."],
      climax_imminent: ["You're very close now.", "Climax appears imminent.", "Your body looks close to crossing threshold."],
      recovery: ["Recovery is settling in.", "Your system is coming down now.", "Recovery detected."],
      build_resumed: ["The build is returning.", "You're rising again.", "Your body is building again."],
    },
  },
  intimate_coaching: {
    id: "intimate_coaching",
    label: "Intimate Coaching",
    helper: "Direct threshold-focused cues, still calibrated.",
    phrases: {
      sustained_build: ["That build is holding.", "Your body is staying with it."],
      climax_possible: ["You're getting close now.", "Your body may be approaching threshold."],
      climax_imminent: ["You're very close now.", "Your body looks committed to the climb."],
      recovery: ["Recovery is settling in. Let it happen.", "Your system is coming down now."],
      build_resumed: ["The build is returning.", "You're rising again."],
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
        recovery: LIVE_CUE_PRESETS.clinical_minimal.phrases.recovery,
      },
      suppressed: true,
    };
  }
  const preset = LIVE_CUE_PRESETS[normalized.style] || LIVE_CUE_PRESETS.sarah_soft;
  const phrases = {};
  for (const cueType of Object.values(LIVE_CUE_TYPES)) {
    const custom = Array.isArray(customPhrases[cueType])
      ? customPhrases[cueType].map((value) => String(value || "").trim()).filter(Boolean)
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

export function pickCuePhrase(phrases = {}, cueType, sequence = 0) {
  const list = phrases[cueType] || [];
  if (!list.length) return "";
  return list[Math.abs(Number(sequence) || 0) % list.length];
}
