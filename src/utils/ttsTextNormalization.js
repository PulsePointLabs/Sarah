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

const VITAL_CONTEXT_BEFORE = /\b(?:the|low|mid|high)\s*$/i;
const VITAL_CONTEXT_AFTER = /^\s*(?:heart rate|hr|bpm|systolic|diastolic|blood pressure|pulse)\b/i;

export function normalizeNumericBandsForSpeech(value) {
  const text = String(value || "");
  return text.replace(/\b(\d{2,3})s\b/g, (match, digits, offset, source) => {
    const numeric = Number(digits);
    if (numeric % 10 !== 0) return match;
    const before = source.slice(Math.max(0, offset - 100), offset);
    const after = source.slice(offset + match.length, offset + match.length + 36);
    const bandPrefix = before.replace(/[-–—]\s*$/, " ");
    const vitalClause = /\b(?:heart[ -]rate|HR|bpm|systolic|diastolic|blood pressure|pulse)\b[^.!?;\n]*$/i.test(before);
    const explicitOffset = /\b(?:at|after|before|for|lasting|duration|pause|wait|offset)\s*$/i.test(before);
    const rangeContinuation = /\b\d{2,3}s\s*(?:[-–—]|to|and)\s*$/i.test(before);
    if (!VITAL_CONTEXT_BEFORE.test(bandPrefix) && !VITAL_CONTEXT_AFTER.test(after)
      && !(vitalClause && !explicitOffset) && !rangeContinuation) return match;
    return DECADE_WORDS[numeric] || `${numeric} range`;
  });
}
