const WHISPER_OUTRO_PATTERNS = [
  /\bthank you for watching\b/gi,
  /\bthanks for watching\b/gi,
  /\bthank you for listening\b/gi,
  /\bthanks for listening\b/gi,
  /\bdon't forget to (?:like|subscribe|like and subscribe)\b/gi,
  /\bplease (?:like|subscribe|like and subscribe)\b/gi,
  /\blike and subscribe\b/gi,
  /\bsubscribe for more\b/gi,
  /\bsee you (?:next time|in the next video)\b/gi,
  /\bthis has been (?:a )?(?:recording|presentation|video)\b/gi,
];

const TRAILING_COMMAND_PATTERN = /(?:^|[\s.,!?;:])(stop|end)[\s.!?]*$/i;
const STANDALONE_TRAILING_COURTESY_PATTERN = /(^|[.!?]\s+)(?:thank you|thanks)[.!?]*$/i;

export function cleanWhisperTranscript(rawText) {
  let text = String(rawText || "")
    .replace(/\s+/g, " ")
    .trim();

  if (!text) return "";

  text = text.replace(TRAILING_COMMAND_PATTERN, "").trim();

  for (const pattern of WHISPER_OUTRO_PATTERNS) {
    text = text.replace(pattern, " ");
  }

  text = text.replace(STANDALONE_TRAILING_COURTESY_PATTERN, "$1").trim();

  return text
    .replace(/\s+([.,!?;:])/g, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s.,!?;:]+/g, "")
    .trim();
}

const TERMINAL_PUNCTUATION_PATTERN = /[.!?…](?:["')\]]+)?$/u;
const QUESTION_OPENING_PATTERN = /^(?:who|what|when|where|why|how|which|whose|is|are|am|was|were|do|does|did|can|could|would|should|will|have|has|had|may|might)\b/i;

export function finalizeWhisperTranscript(rawText) {
  const text = cleanWhisperTranscript(rawText);
  if (!text || TERMINAL_PUNCTUATION_PATTERN.test(text)) return text;
  return `${text}${QUESTION_OPENING_PATTERN.test(text) ? "?" : "."}`;
}

export function isOnlyWhisperHallucination(rawText) {
  const original = String(rawText || "").trim();
  if (!original) return true;
  return !cleanWhisperTranscript(original);
}
