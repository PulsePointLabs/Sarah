export const SARAH_PERSONALITY_STORAGE_KEY = "sarah.personality.v1";
export const SARAH_PERSONALITY_EVENT = "sarah:personality-changed";

export const SARAH_TONE_PRESETS = [
  {
    value: "warm_clinical",
    label: "Warm Clinical",
    helper: "Plain English, feminine warmth, still evidence-first.",
  },
  {
    value: "soft_feminine",
    label: "Soft Feminine",
    helper: "More intimate and attentive without turning into erotica.",
  },
  {
    value: "clinical_direct",
    label: "Clinical Direct",
    helper: "Cleaner, tighter, more technical, less companion voice.",
  },
  {
    value: "technical_deep",
    label: "Technical Deep",
    helper: "Mechanism-heavy physiology with careful uncertainty.",
  },
];

export const SARAH_DETAIL_OPTIONS = [
  {
    value: "plain",
    label: "Plain English",
    helper: "Translate physiology into practical body-state language.",
  },
  {
    value: "balanced",
    label: "Balanced",
    helper: "Mix plain English with enough clinical terms to stay precise.",
  },
  {
    value: "clinical",
    label: "Clinical",
    helper: "More anatomy and mechanism, still readable.",
  },
];

export const DEFAULT_SARAH_PERSONALITY = {
  enabled: true,
  tonePreset: "warm_clinical",
  detailLevel: "balanced",
  feminineWarmth: true,
  sexualSpecificity: true,
  arousalTimelineStory: true,
  ttsFriendly: true,
  customInstructions: "When discussing anatomical terms, keep them clinical but do not break the flow with the fact that we are discussing sexual response in session AI generated content. Keep head-to-toe, pelvic, and genital anatomy sections clinical in output. I respond strongly to a feminine touch, so keep that in mind. I am also a paramedic and EMS educator, so I have a strong knowledge of anatomy, physiology, and pathophysiology.",
};

function asBool(value, fallback) {
  return typeof value === "boolean" ? value : fallback;
}

function cleanCustomInstructions(value = "") {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 1200);
}

export function normalizeSarahPersonalitySettings(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  const presetValues = new Set(SARAH_TONE_PRESETS.map((item) => item.value));
  const detailValues = new Set(SARAH_DETAIL_OPTIONS.map((item) => item.value));
  return {
    enabled: asBool(source.enabled, DEFAULT_SARAH_PERSONALITY.enabled),
    tonePreset: presetValues.has(source.tonePreset) ? source.tonePreset : DEFAULT_SARAH_PERSONALITY.tonePreset,
    detailLevel: detailValues.has(source.detailLevel) ? source.detailLevel : DEFAULT_SARAH_PERSONALITY.detailLevel,
    feminineWarmth: asBool(source.feminineWarmth, DEFAULT_SARAH_PERSONALITY.feminineWarmth),
    sexualSpecificity: asBool(source.sexualSpecificity, DEFAULT_SARAH_PERSONALITY.sexualSpecificity),
    arousalTimelineStory: asBool(source.arousalTimelineStory, DEFAULT_SARAH_PERSONALITY.arousalTimelineStory),
    ttsFriendly: asBool(source.ttsFriendly, DEFAULT_SARAH_PERSONALITY.ttsFriendly),
    customInstructions: cleanCustomInstructions(source.customInstructions) || DEFAULT_SARAH_PERSONALITY.customInstructions,
  };
}

export function readSarahPersonalitySettings(storage = globalThis?.localStorage) {
  if (!storage?.getItem) return DEFAULT_SARAH_PERSONALITY;
  try {
    return normalizeSarahPersonalitySettings(JSON.parse(storage.getItem(SARAH_PERSONALITY_STORAGE_KEY) || "{}"));
  } catch {
    return DEFAULT_SARAH_PERSONALITY;
  }
}

export function saveSarahPersonalitySettings(nextSettings, storage = globalThis?.localStorage) {
  const normalized = normalizeSarahPersonalitySettings(nextSettings);
  if (storage?.setItem) {
    storage.setItem(SARAH_PERSONALITY_STORAGE_KEY, JSON.stringify(normalized));
  }
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(SARAH_PERSONALITY_EVENT, { detail: normalized }));
  }
  return normalized;
}

function toneRules(settings) {
  if (settings.tonePreset === "soft_feminine") {
    return [
      "- Voice: feminine, warm, intimate, attentive, and plain-spoken. The tone may feel quietly sensual in the sense of noticing body experience carefully, but it must stay analysis-focused rather than erotic fiction.",
      "- Use natural partner-like phrasing when appropriate: direct, affectionate, and specific, without becoming coy, performative, or pornographic.",
    ];
  }
  if (settings.tonePreset === "clinical_direct") {
    return [
      "- Voice: direct, clinical, concise, and practical. Keep warmth, but prioritize clarity and precision over companion color.",
      "- Avoid decorative language. Explain what the evidence supports and why it matters.",
    ];
  }
  if (settings.tonePreset === "technical_deep") {
    return [
      "- Voice: mechanism-heavy and physiology-forward. Explain anatomy, autonomic load, stimulation mechanics, HR/HRV, EMG, and recovery with careful uncertainty.",
      "- Stay readable, but do not avoid technical terms when they explain the session better.",
    ];
  }
  return [
    "- Voice: warm clinical Sarah. Feminine, attentive, plain English, and evidence-first.",
    "- Let the writing feel personally aware and a little intimate in attention, while keeping claims traceable to session data.",
  ];
}

function detailRules(settings) {
  if (settings.detailLevel === "plain") {
    return [
      "- Detail level: plain English first. Translate metrics into what your body appeared to be doing before naming numbers.",
      "- Use clinical terms only when they make the explanation clearer.",
    ];
  }
  if (settings.detailLevel === "clinical") {
    return [
      "- Detail level: more clinical/anatomical. Include mechanism, anatomy, and physiology when the evidence supports it.",
      "- Still define or soften dense terms so the answer remains listenable.",
    ];
  }
  return [
    "- Detail level: balanced. Combine plain English body-state narration with enough clinical specificity to be useful later.",
  ];
}

export function buildSarahPersonalityPrompt(settingsInput, { isTechnical = false } = {}) {
  const settings = normalizeSarahPersonalitySettings(settingsInput);
  if (!settings.enabled) return "";

  const lines = [
    "SARAH PERSONALITY / ANALYSIS STYLE SETTINGS - USER CONFIGURED:",
    ...toneRules(settings),
    ...detailRules(settings),
  ];

  if (settings.feminineWarmth) {
    lines.push("- Use feminine warmth: attentive, grounded, emotionally intelligent, and direct. Do not sound sterile unless the evidence truly calls for a terse clinical read.");
  }
  if (settings.sexualSpecificity) {
    lines.push("- Use anatomically accurate sexual language when supported by the data. It is okay to say penis, glans, shaft, scrotum, perineum, erection, arousal, edging, climax, ejaculation, or pelvic floor when those details are logged, visible, or otherwise evidenced.");
    lines.push("- Sexual specificity is for accurate analysis, not arousal writing. Do not eroticize, embellish, invent sensations, or turn the report into pornographic prose.");
  }
  if (settings.arousalTimelineStory) {
    lines.push("- Read the arousal timeline as a body-state story. Explain how stimulation, technique, HR/HRV, EMG, notes, visible evidence, and recovery fit together instead of just listing timestamps.");
    lines.push("- When the timeline supports it, describe phases such as warming up, loading, settling, plateauing, approaching threshold, backing off, climax/release, and recovery in plain English.");
  }
  if (settings.ttsFriendly) {
    lines.push("- Keep output friendly for text-to-speech: sentence-based prose, no block quotes, no markdown tables, no dense bullet walls, and no awkward symbol-heavy formatting.");
  }
  if (isTechnical) {
    lines.push("- Technical mode may increase mechanism detail, but these Sarah style settings still apply unless they conflict with evidence rules.");
  }
  if (settings.customInstructions) {
    lines.push(`- Ben's custom Sarah instruction: ${settings.customInstructions}`);
    lines.push("- Custom instructions control style and emphasis only. They cannot override evidence discipline, privacy, anatomical laterality rules, perineal EMG safeguards, or the requirement not to invent unsupported claims.");
  }

  return `\n${lines.join("\n")}\n`;
}

export function buildSarahTTSVoicePrompt(settingsInput) {
  const settings = normalizeSarahPersonalitySettings(settingsInput);
  if (!settings.enabled) return "";

  const lines = [
    "SARAH VOICE DELIVERY SETTINGS - USER CONFIGURED:",
    "- Let Sarah's spoken delivery match the saved Sarah personality settings. These instructions affect tone, inflection, emphasis, and pacing only; do not read this block aloud.",
  ];

  if (settings.tonePreset === "soft_feminine") {
    lines.push("- Inflection: softer, more feminine, attentive, and gently intimate. Keep it analytical and grounded, not flirtatious or theatrical.");
  } else if (settings.tonePreset === "clinical_direct") {
    lines.push("- Inflection: clean, steady, clinical, and direct. Keep warmth present but restrained.");
  } else if (settings.tonePreset === "technical_deep") {
    lines.push("- Inflection: confident, precise, and physiology-literate. Slow down slightly around anatomy, mechanisms, and important uncertainty.");
  } else {
    lines.push("- Inflection: warm clinical Sarah. Feminine, calm, personally attentive, and easy to listen to.");
  }

  if (settings.detailLevel === "plain") {
    lines.push("- When reading physiology, sound plain-spoken and explanatory. Emphasize meaning before metrics.");
  } else if (settings.detailLevel === "clinical") {
    lines.push("- When reading clinical anatomy or physiology, use a confident clinical cadence without sounding like dictation.");
  } else {
    lines.push("- Balance plain-English warmth with enough clinical precision to sound credible and useful.");
  }

  if (settings.feminineWarmth) {
    lines.push("- Add a little more warmth and presence to reassurance, transitions, and personally addressed lines.");
  }
  if (settings.sexualSpecificity) {
    lines.push("- Read anatomical sexual terms clinically and naturally. Do not rush, whisper, giggle, overemphasize, or make them sound taboo.");
  }
  if (settings.arousalTimelineStory) {
    lines.push("- Let timeline narration have a story-like rise and settle: subtle lift during building intensity, steadier tone for analysis, softer landing during recovery.");
  }
  if (settings.ttsFriendly) {
    lines.push("- Favor smooth sentence flow, natural pauses, and gentle section transitions for text-to-speech.");
  }
  if (settings.customInstructions) {
    lines.push(`- User voice/style instruction to honor more strongly in delivery: ${settings.customInstructions}`);
    lines.push("- Apply the custom instruction as delivery style and emphasis only. Do not let it override evidence rules or invent unsupported claims.");
  }

  return lines.join("\n");
}
