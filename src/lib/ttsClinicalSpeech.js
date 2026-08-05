export function normalizeClinicalUnitsForSpeech(text = "") {
  const normalized = String(text)
    .replace(
      /\b(\d{2,3})\s*\/\s*(\d{2,3})\s*(?:mm\s*hg|mmhg)\b/gi,
      "$1 over $2 millimeters of mercury",
    )
    .replace(/\b(\d{2,3})\s*\/\s*(\d{2,3})\b/g, "$1 over $2")
    .replace(/\bmm\s*hg\b/gi, "millimeters of mercury")
    .replace(/\bmg\s*\/\s*d[lL]\b/g, "milligrams per deciliter");

  // Motion exports use mg to mean milli-g acceleration, not milligrams.
  // Keep this contextual so glucose and medication doses retain their units.
  return normalized.replace(
    /\b((?:dynamic\s+RMS|motion(?:\s+dynamic)?(?:\s+RMS)?)[^.\n]*?)\b(?:milligrams?|mg)\b/gi,
    "$1milli-g",
  );
}
