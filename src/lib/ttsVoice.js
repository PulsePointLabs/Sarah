/**
 * Voice selection utility for Web Speech API.
 * Prefers high-quality neural/enhanced voices over system defaults.
 */

const PREFERRED_VOICE_PATTERNS = [
  // Google neural voices (Chrome)
  /google\s+(uk\s+english|us\s+english)/i,
  /google\s+english/i,
  // Microsoft neural voices (Edge/Windows)
  /microsoft\s+(jenny|aria|guy|natasha|ryan|libby|sonia)/i,
  /microsoft.*natural/i,
  /microsoft.*neural/i,
  // Apple enhanced voices (macOS/iOS)
  /samantha(\s+\(enhanced\))?/i,
  /karen(\s+\(enhanced\))?/i,
  /daniel(\s+\(enhanced\))?/i,
  /moira(\s+\(enhanced\))?/i,
  /tessa(\s+\(enhanced\))?/i,
  // Any "enhanced" or "premium" voice
  /enhanced/i,
  /premium/i,
  /neural/i,
  /natural/i,
];

let _cachedVoice = undefined; // undefined = not yet resolved, null = none found

export function getBestVoice() {
  if (_cachedVoice !== undefined) return _cachedVoice;

  const voices = window.speechSynthesis?.getVoices() || [];
  const enVoices = voices.filter(v => v.lang.startsWith("en"));

  for (const pattern of PREFERRED_VOICE_PATTERNS) {
    const match = enVoices.find(v => pattern.test(v.name));
    if (match) {
      _cachedVoice = match;
      return match;
    }
  }

  // Fall back to any English voice, preferring non-network voices last
  _cachedVoice = enVoices[0] || voices[0] || null;
  return _cachedVoice;
}

export function resetVoiceCache() {
  _cachedVoice = undefined;
}

export function getEnglishVoices() {
  const voices = window.speechSynthesis?.getVoices() || [];
  return voices.filter(v => v.lang.startsWith("en"));
}