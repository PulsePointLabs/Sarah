function listText(value) {
  if (Array.isArray(value)) return value.filter(Boolean).join(" ");
  return String(value || "");
}

export function bodyExplorationContextText(exploration = {}) {
  const timelineNotes = (exploration.event_timeline || [])
    .map((event) => event?.note)
    .filter(Boolean)
    .join(" ");
  return [
    exploration.title,
    exploration.exploration_type,
    exploration.focus_areas,
    exploration.purpose,
    exploration.devices,
    exploration.notes,
    exploration.findings,
    exploration.comfort_notes,
    exploration.unusual_sensations,
    exploration.sounding_notes,
    exploration.foley_type,
    exploration.foley_size,
    listText(exploration.methods),
    listText(exploration.tags),
    timelineNotes,
  ].filter(Boolean).join(" ").toLowerCase();
}

export function detectBodyExplorationAnnotationMode(exploration = {}) {
  const contextText = bodyExplorationContextText(exploration);
  const enemaKnown = /\b(enema|rectal irrigation|rectal instillation|rectal infusion|anorectal|anal irrigation|enema (?:bag|tube|nozzle)|rectal (?:tube|nozzle|catheter)|fluid retention|expulsion)\b/.test(contextText);
  const urethralKnown = Boolean(
    exploration.foley_type
    || exploration.foley_size
    || /\b(foley|urinary catheter|urethral sounding|hegar(?: dilator)?|urethral dilat(?:ion|or)|urethral dilator|sound(?:ing)? (?:the )?urethra|urethral (?:insertion|instrumentation|procedure))\b/.test(contextText),
  );

  return {
    contextText,
    enemaKnown,
    urethralKnown,
    mode: enemaKnown && !urethralKnown ? "enema" : urethralKnown ? "urethral" : "generic",
  };
}

export function isUnsupportedUrethralClaimForMode(value, annotationMode = {}) {
  if (!annotationMode.enemaKnown || annotationMode.urethralKnown) return false;
  const text = String(value || "").toLowerCase();
  return /\b(foley|urinary catheter|urethral|urethra|hegar|sounding|meatus|meatal|urethral dilat(?:ion|or)|urethral dilator)\b/.test(text);
}

export function removeUnsupportedUrethralSentences(value, annotationMode = {}) {
  const text = String(value || "").trim();
  if (!isUnsupportedUrethralClaimForMode(text, annotationMode)) return text;
  return text
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !isUnsupportedUrethralClaimForMode(sentence, annotationMode))
    .join(" ")
    .trim();
}
