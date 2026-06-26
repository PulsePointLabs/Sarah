const DECADE_WORDS = {
  20: "twenties",
  30: "thirties",
  40: "forties",
  50: "fifties",
  60: "sixties",
  70: "seventies",
  80: "eighties",
  90: "nineties",
};

const VITAL_CONTEXT_BEFORE = /(?:\b(?:in|into|within|around|near|through|throughout|low|mid|high)(?:\s+the)?|\b(?:heart rate|hr|bpm|systolic|diastolic|blood pressure|pulse)(?:\s+(?:was|were|is|are|remained|stayed|held|ran|reached|in|into|around))?(?:\s+the)?)\s*$/i;
const VITAL_CONTEXT_AFTER = /^\s*(?:for|in|during|heart rate|hr|bpm|systolic|diastolic|blood pressure|pulse)\b/i;

export function normalizeNumericBandsForSpeech(value) {
  const text = String(value || "");
  return text.replace(/\b(\d{2,3})s\b/g, (match, digits, offset, source) => {
    const before = source.slice(Math.max(0, offset - 48), offset);
    const after = source.slice(offset + match.length, offset + match.length + 36);
    if (!VITAL_CONTEXT_BEFORE.test(before) && !VITAL_CONTEXT_AFTER.test(after)) return match;
    const numeric = Number(digits);
    return DECADE_WORDS[numeric] || `${numeric} range`;
  });
}
