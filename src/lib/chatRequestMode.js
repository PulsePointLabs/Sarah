const LONG_FORM_REQUEST_RE = /\b(?:extremely|very|really|especially)\s+long\b|\blong[\s-]?form\b|\bstep[\s-]?by[\s-]?step\b|\b(?:comprehensive|exhaustive|in-depth|deep-dive|thorough(?:ly)?|highly detailed)\b|\bas much detail as possible\b/i;

export const AI_CHAT_FOREGROUND_TIMEOUT_MS = 6 * 60 * 1000;

export function isLongFormChatRequest(text = "") {
  return LONG_FORM_REQUEST_RE.test(String(text || ""));
}

