export const INTIMATE_REFLECTION_LEVELS = Object.freeze([
  {
    id: "warm",
    label: "Warm",
    helper: "Affectionate and reassuring, with minimal sexual language.",
  },
  {
    id: "intimate",
    label: "Intimate",
    helper: "Trusted-lover warmth with restrained, natural sexual language.",
  },
  {
    id: "erotic",
    label: "Erotic",
    helper: "A desirous feminine lover-observer: sexually direct, anatomically aware, and personal rather than clinical.",
  },
  {
    id: "custom",
    label: "Custom",
    helper: "Uses your private tone, vocabulary, boundaries, and emphasis instructions.",
  },
]);

const LEVEL_IDS = new Set(INTIMATE_REFLECTION_LEVELS.map((level) => level.id));

function cleanText(value, maxLength = 1200) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function finiteNumber(...values) {
  for (const value of values) {
    if (value == null || value === "") continue;
    const number = Number(value);
    if (Number.isFinite(number)) return number;
  }
  return null;
}

function cleanStringArray(value, limit = 8, maxLength = 1400) {
  return (Array.isArray(value) ? value : [])
    .map((item) => cleanText(item, maxLength))
    .filter(Boolean)
    .slice(0, limit);
}

const SMALL_NUMBER_WORDS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
  "seventeen", "eighteen", "nineteen",
];

function numberToWordsUnderHundred(value) {
  const number = Math.max(0, Math.min(99, Math.round(Number(value) || 0)));
  if (number < 20) return SMALL_NUMBER_WORDS[number];
  const tens = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];
  const remainder = number % 10;
  return remainder ? `${tens[Math.floor(number / 10)]}-${SMALL_NUMBER_WORDS[remainder]}` : tens[Math.floor(number / 10)];
}

export function formatReflectionTimeForSpeech(value) {
  const total = Math.max(0, Math.round(Number(value) || 0));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  const minuteLabel = minutes
    ? `${numberToWordsUnderHundred(minutes)} minute${minutes === 1 ? "" : "s"}`
    : "";
  const secondLabel = seconds
    ? `${numberToWordsUnderHundred(seconds)} second${seconds === 1 ? "" : "s"}`
    : "";
  if (minuteLabel && secondLabel) return `${minuteLabel} and ${secondLabel}`;
  return minuteLabel || secondLabel || "the session opening";
}

export function normalizeIntimateReflectionSettings(value = {}) {
  const level = LEVEL_IDS.has(value?.level) ? value.level : "intimate";
  return {
    level,
    customInstructions: cleanText(value?.customInstructions, 1200),
  };
}

export function intimateReflectionFingerprint(value = {}) {
  const settings = normalizeIntimateReflectionSettings(value);
  const source = `${settings.level}|${settings.customInstructions}`;
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `ir-${(hash >>> 0).toString(16)}`;
}

function compactAnalysis(analysis = {}) {
  return {
    summary: cleanText(analysis?.summary, 2400),
    arousal_arc: cleanStringArray(analysis?.arousal_arc, 10, 1200),
    event_analysis: cleanStringArray(analysis?.event_analysis, 8, 1200),
    notable_findings: cleanStringArray(analysis?.notable_findings, 8, 900),
  };
}

function compactEvents(events = []) {
  return (Array.isArray(events) ? events : [])
    .map((event) => ({
      time_seconds: finiteNumber(event?.time_s, event?.time_offset_s, event?.offset_s, event?.timestamp_s),
      category: Array.isArray(event?.category)
        ? event.category.map((item) => cleanText(item, 80)).filter(Boolean).slice(0, 4)
        : [cleanText(event?.category, 80)].filter(Boolean),
      note: cleanText(event?.note || event?.description || event?.label, 500),
      heart_rate: finiteNumber(event?.hr, event?.heart_rate, event?.bpm),
    }))
    .filter((event) => event.time_seconds != null || event.note)
    .sort((a, b) => (a.time_seconds ?? Number.MAX_SAFE_INTEGER) - (b.time_seconds ?? Number.MAX_SAFE_INTEGER))
    .slice(0, 80);
}

function compactTelemetry(rows = []) {
  const valid = (Array.isArray(rows) ? rows : [])
    .map((row) => ({
      time_seconds: finiteNumber(row?.time_offset_s, row?.time_s, row?.offset_s, row?.t),
      heart_rate: finiteNumber(row?.hr_smoothed, row?.hr, row?.heart_rate, row?.bpm),
      rmssd_ms: finiteNumber(row?.rmssd_ms, row?.rmssd),
    }))
    .filter((row) => row.time_seconds != null && row.heart_rate != null);
  if (!valid.length) return { sample_count: 0, trend_samples: [] };

  const heartRates = valid.map((row) => row.heart_rate);
  const stride = Math.max(1, Math.ceil(valid.length / 24));
  return {
    sample_count: valid.length,
    minimum_heart_rate: Math.round(Math.min(...heartRates)),
    maximum_heart_rate: Math.round(Math.max(...heartRates)),
    average_heart_rate: Math.round(heartRates.reduce((sum, value) => sum + value, 0) / heartRates.length),
    trend_samples: valid.filter((_, index) => index % stride === 0).slice(0, 24),
  };
}

export function buildIntimateReflectionEvidence(session = {}, timelineRows = []) {
  return {
    session: {
      date: cleanText(session?.date, 40),
      duration_minutes: finiteNumber(session?.duration_minutes),
      methods: (Array.isArray(session?.methods) ? session.methods : []).map((item) => cleanText(item, 100)).filter(Boolean).slice(0, 20),
      intensity: finiteNumber(session?.intensity),
      satisfaction: finiteNumber(session?.satisfaction),
      build_type: cleanText(session?.build_type, 120),
      no_climax: Boolean(session?.no_climax),
      subjective_notes: cleanText(session?.subjective_notes, 1200),
      session_notes: cleanText(session?.notes, 1600),
      phase_markers_seconds: {
        pre_climax: finiteNumber(session?.pre_climax_offset_s),
        climax: finiteNumber(session?.climax_offset_s),
        recovery: finiteNumber(session?.recovery_offset_s),
      },
    },
    saved_analysis: compactAnalysis(session?.ai_analysis),
    confirmed_timeline_events: compactEvents(session?.event_timeline),
    telemetry: compactTelemetry(timelineRows),
  };
}

export function intimateReflectionEvidenceFingerprint(evidence = {}) {
  const source = JSON.stringify(evidence);
  let hash = 2166136261;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return `ire-${(hash >>> 0).toString(16)}`;
}

function levelInstruction(settings) {
  if (settings.level === "warm") {
    return "Use affectionate, reassuring partner-like warmth. Keep sexual language minimal and discuss intimate anatomy only when it is necessary to reflect a supported moment accurately.";
  }
  if (settings.level === "erotic") {
    return `EROTIC MODE IS AN ACTUAL VOICE CHANGE, NOT A CLINICAL REPORT WITH A WARM INTRODUCTION.
- Write in Sarah's first-person feminine voice as an adult lover-observer who is attracted to the user and has attentively watched the saved session evidence.
- Let Sarah say what drew her eye, what she found sexually compelling, and how the supported progression affected her as an observer. She may express attraction and desire, but must not claim physical presence, touch, dialogue, or events that are not in evidence.
- Use direct anatomical and sexual vocabulary naturally when the evidence supports it. Do not euphemize masturbation, erection, penis, glans, anus, stimulation, ejaculation, or orgasm into sterile abstractions.
- Blend anatomy and physiology into the erotic observation instead of pausing to lecture about them. Sarah understands the body, but she is speaking as a lover, not documenting a case.
- Prefer personal constructions such as "I noticed," "watching you," "what held my attention," and "I loved seeing" over detached constructions such as "the data indicates."
- Keep the voice sensual, confident, intimate, and sexually candid. Avoid vulgar degradation and porn-script commands; this remains an after-session reflection rather than live instruction.`;
  }
  if (settings.level === "custom") {
    return `Follow the user's private style instruction where it does not conflict with evidence discipline: ${settings.customInstructions || "Use a personally attentive trusted-lover voice."}`;
  }
  return "Use a trusted-lover voice: feminine, attentive, sensual, and personally warm. Sexual language may be natural and specific, but restrained rather than graphic.";
}

export function buildIntimateReflectionPrompt({
  session,
  timelineRows = [],
  settings,
  personalityPrompt = "",
} = {}) {
  const normalizedSettings = normalizeIntimateReflectionSettings(settings);
  const evidence = buildIntimateReflectionEvidence(session, timelineRows);
  return {
    evidence,
    prompt: `You are Sarah creating a private, explicitly requested Intimate Session Reflection for an adult user. This is a reflective companion output, separate from the clinical analysis.

GENERAL SARAH PERSONALITY:
${personalityPrompt || "Warm, attentive, intelligent, and personally familiar."}

NON-NEGOTIABLE EVIDENCE RULES:
- Use only the supplied session analysis, confirmed timeline events, phase markers, telemetry, and user notes.
- Do not invent touch, dialogue, feelings, consent, intent, stimulation technique, orgasm, ejaculation, or visible anatomy.
- A heart-rate change supports physiological load, not a specific sexual action by itself.
- If evidence is uncertain or unavailable, omit the claim instead of filling the gap.
- Use compact timestamps such as "8:40" only when tied to a supplied event or phase marker.
- Do not give medical advice. Do not issue live sexual commands. This is an after-session reflection.
- Keep prose natural for Sarah's text-to-speech voice: connected sentences, no markdown, no headings inside fields.
- Spell out every number, measurement, score, and duration in words inside the prose fields. Write "fifteen minutes and forty-eight seconds" rather than "15:48," and "one hundred beats per minute" rather than "100 bpm." Exact numeric timestamps belong only in each moment's time_seconds field.
- The closing should feel warm and complete without pretending Sarah was physically present.

SELECTED REFLECTION VOICE:
This selected voice controls the narration and takes priority over any more clinical or restrained tone in the general personality settings. Evidence rules still take priority over every voice choice.
${levelInstruction(normalizedSettings)}

NARRATIVE DISCIPLINE:
- Treat the evidence as a private factual boundary, not as the outline or vocabulary of the response.
- Address the user as "you." Sarah may use "I" for her own observer reaction.
- Tell the supported session chronologically from its beginning through its actual ending. This is a complete intimate retelling, not a highlight reel.
- Cover the opening state, setup and early response, the middle build and meaningful interruptions or transitions, the final approach or no-climax ending, and recovery when those phases exist in the evidence.
- Do not skip a major supported phase merely because it is less dramatic. Give quieter stretches proportionate coverage without inventing action.
- Do not summarize every score, metric, or finding. Select the evidence that best explains each part of the complete session arc.
- Never merely paste or lightly paraphrase the supplied clinical analysis.
- Keep numbers and telemetry subordinate. Mention a measurement only when it deepens a specific observation; otherwise express the supported change naturally.
- Avoid report language such as "the data agrees," "on paper," "marker," "suggests," "consistent with," "physiologically distinct," "documented library," "build quality score," and "release completeness."
- In Erotic mode, if the result could comfortably appear in a clinical chart after changing only two or three words, it is not erotic enough and must be rewritten in Sarah's lover-observer voice.

SESSION EVIDENCE:
${JSON.stringify(evidence, null, 2)}

Return a cohesive reflection with:
1. A concise opening in the selected voice, not a session abstract.
2. Six to twelve substantial chronological paragraphs that carry the session from beginning to end in the selected voice. Develop every major supported phase without padding or repeating the same conclusion.
3. Eight to fourteen timestamp-linked moments when the evidence provides enough distinct supported moments. Distribute them across the full session rather than clustering only around climax. Each must add a meaningful observation rather than merely restating an event label.
4. A developed closing paragraph that sustains the selected voice rather than switching back to clinical reassurance.`,
  };
}

export function normalizeIntimateReflectionResult(raw = {}) {
  const source = raw?.response && typeof raw.response === "object" ? raw.response : raw;
  const moments = (Array.isArray(source?.moments) ? source.moments : [])
    .map((moment) => ({
      time_seconds: finiteNumber(moment?.time_seconds),
      label: cleanText(moment?.label, 120),
      reflection: cleanText(moment?.reflection, 1200),
      evidence: cleanText(moment?.evidence, 500),
    }))
    .filter((moment) => moment.reflection)
    .slice(0, 14);
  const result = {
    summary: cleanText(source?.summary, 2400),
    reflection: cleanStringArray(source?.reflection, 12, 2600),
    moments,
    closing: cleanText(source?.closing, 1800),
  };
  if (!result.summary || !result.reflection.length || !result.closing) {
    throw new Error("Sarah returned an incomplete intimate reflection. Please try generating it again.");
  }
  return result;
}

export function intimateReflectionReaderData(result = {}) {
  const paragraphs = [];
  const paragraphMeta = [];
  if (result?.summary) {
    paragraphs.push(result.summary);
    paragraphMeta.push({ type: "summary" });
  }
  (result?.reflection || []).forEach((paragraph) => {
    paragraphs.push(paragraph);
    paragraphMeta.push({
      type: "section",
      sec: { key: "reflection", label: "Intimate Reflection", color: "hsl(var(--chart-4))" },
    });
  });
  (result?.moments || []).forEach((moment) => {
    const seconds = finiteNumber(moment?.time_seconds);
    const timestamp = seconds == null ? "" : `${formatReflectionTimeForSpeech(seconds)}. `;
    paragraphs.push(`${timestamp}${moment.label ? `${moment.label}. ` : ""}${moment.reflection}`.trim());
    paragraphMeta.push({
      type: "section",
      sec: { key: "moments", label: "Moments Sarah Noticed", color: "hsl(var(--chart-2))" },
    });
  });
  if (result?.closing) {
    paragraphs.push(result.closing);
    paragraphMeta.push({
      type: "section",
      sec: { key: "closing", label: "Closing Reflection", color: "hsl(var(--chart-3))" },
    });
  }
  return { paragraphs, paragraphMeta };
}

export function intimateReflectionNeedsRefresh(result, settings, evidence) {
  if (!result) return false;
  return result?._meta?.settings_fingerprint !== intimateReflectionFingerprint(settings)
    || result?._meta?.evidence_fingerprint !== intimateReflectionEvidenceFingerprint(evidence);
}
