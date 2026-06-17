const DECIMAL_POINT_TOKEN = "__PULSEPOINT_DECIMAL_POINT__";

function protectDecimalPoints(text) {
  return String(text || "").replace(/(\d+)\.(\d+)/g, `$1${DECIMAL_POINT_TOKEN}$2`);
}

function restoreDecimalPoints(text) {
  return String(text || "").replaceAll(DECIMAL_POINT_TOKEN, ".");
}

export function formatSecondsAsWords(value) {
  const total = Math.max(0, Math.round(Number(value) || 0));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  if (!minutes) return `${seconds} second${seconds === 1 ? "" : "s"}`;
  if (!seconds) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  return `${minutes} minute${minutes === 1 ? "" : "s"} and ${seconds} second${seconds === 1 ? "" : "s"}`;
}

export function repairRawSecondTimeReferences(text) {
  if (typeof text !== "string") return text;
  return text
    .replace(/\b(at|around|near|by|before|after|from|until|through|to)\s+(\d{2,5})\s*seconds?\b/gi, (match, prefix, seconds) => {
      const value = Number(seconds);
      if (!Number.isFinite(value) || value < 60) return match;
      return `${prefix} ${formatSecondsAsWords(value)}`;
    })
    .replace(/\b(at|around|near|by|before|after|from|until|through|to)\s+(\d{2,5})\s*s\b/gi, (match, prefix, seconds) => {
      const value = Number(seconds);
      if (!Number.isFinite(value) || value < 60) return match;
      return `${prefix} ${formatSecondsAsWords(value)}`;
    })
    .replace(/\[(\d{2,5})\s*s\]/gi, (match, seconds) => {
      const value = Number(seconds);
      if (!Number.isFinite(value) || value < 60) return match;
      return `[${formatSecondsAsWords(value)}]`;
    })
    .replace(/\b(\d{3,5})\s*s\b/g, (match, seconds) => {
      const value = Number(seconds);
      if (!Number.isFinite(value) || value < 60) return match;
      return formatSecondsAsWords(value);
    })
    .replace(/\b(\d{3,5})\s+seconds?\b/gi, (match, seconds) => {
      const value = Number(seconds);
      if (!Number.isFinite(value) || value < 60) return match;
      return formatSecondsAsWords(value);
    });
}

export function repairCharacterSplitParagraph(text, consistencyContext = null) {
  if (typeof text !== "string") return text;

  const lines = text.split(/\r?\n/);
  const nonEmpty = lines.map((line) => line.trim()).filter(Boolean);
  const singleCharLines = nonEmpty.filter((line) => line.length === 1).length;
  const shortLines = nonEmpty.filter((line) => line.length <= 2).length;
  const looksCharacterSplit =
    nonEmpty.length >= 8 &&
    singleCharLines / nonEmpty.length >= 0.65 &&
    shortLines / nonEmpty.length >= 0.85;

  if (!looksCharacterSplit) {
    return reduceConsistencyPhraseRepetition(
      repairRawSecondTimeReferences(repairDecimalSpacing(text)),
      1,
      consistencyContext
    );
  }

  const rebuilt = lines.reduce((acc, line) => {
    const trimmed = line.trim();
    if (!trimmed) return acc && !acc.endsWith(" ") ? `${acc} ` : acc;
    return `${acc}${trimmed}`;
  }, "");

  return reduceConsistencyPhraseRepetition(
    repairRawSecondTimeReferences(rebuilt
      .replace(/\s+/g, " ")
      .replace(/(\d+)\.\s+(\d+)/g, "$1.$2")
      .replace(/([.!?])([A-Z])/g, "$1 $2")
      .trim()),
    1,
    consistencyContext
  );
}

export function repairDecimalSpacing(text) {
  if (typeof text !== "string") return text;
  return repairRawSecondTimeReferences(text.replace(/(\d+)\.\s+(\d+)/g, "$1.$2"));
}

const CONSISTENCY_WITH_REPLACEMENTS = [
  "fits with",
  "aligns with",
  "matches",
  "supports",
  "tracks with",
  "echoes",
  "points toward",
  "helps explain",
];

const CONSISTENT_REPLACEMENTS = [
  "stable",
  "repeated",
  "steady",
  "matching",
  "reliable",
  "unchanged",
  "regular",
];

const CONSISTENTLY_REPLACEMENTS = [
  "repeatedly",
  "reliably",
  "regularly",
  "often",
  "steadily",
  "again and again",
  "throughout",
];

function preserveInitialCapital(original, replacement) {
  if (!original || original[0] !== original[0].toUpperCase()) return replacement;
  return `${replacement.slice(0, 1).toUpperCase()}${replacement.slice(1)}`;
}

export function reduceConsistencyPhraseRepetition(text, allowedUses = 1, context = null) {
  if (typeof text !== "string" || !text) return text;

  const state = context && typeof context === "object" ? context : { count: 0, rotation: 0 };
  const keptPhrases = [];
  const keepPhrase = (match) => {
    const index = keptPhrases.push(match) - 1;
    return `__PULSEPOINT_KEEP_CONSISTENCY_${index}__`;
  };
  const shouldKeep = () => {
    state.count = (state.count || 0) + 1;
    return state.count <= allowedUses;
  };
  const nextReplacement = (options, match) => {
    const value = options[(state.rotation || 0) % options.length];
    state.rotation = (state.rotation || 0) + 1;
    return preserveInitialCapital(match.trimStart(), value);
  };

  const repaired = text
    .replace(/\b(?:(?:is|are|was|were|appears|appear|appeared|seems|seem|seemed)\s+)?consistent\s+with\b/gi, (match) => {
      if (shouldKeep()) return keepPhrase(match);
      const replacement = nextReplacement(CONSISTENCY_WITH_REPLACEMENTS, match);
      return replacement;
    })
    .replace(/\bconsistent\s+across\b/gi, (match) => {
      if (shouldKeep()) return keepPhrase(match);
      return preserveInitialCapital(match, "stable across");
    })
    .replace(/\bconsistently\b/gi, (match) => {
      if (shouldKeep()) return keepPhrase(match);
      return nextReplacement(CONSISTENTLY_REPLACEMENTS, match);
    })
    .replace(/\bconsistent\b/gi, (match) => {
      if (shouldKeep()) return keepPhrase(match);
      return nextReplacement(CONSISTENT_REPLACEMENTS, match);
    });

  return repaired.replace(/__PULSEPOINT_KEEP_CONSISTENCY_(\d+)__/g, (match, index) => (
    keptPhrases[Number(index)] ?? match
  ));
}

export function splitSentencesPreservingDecimals(text) {
  const repaired = repairDecimalSpacing(text);
  const protectedText = protectDecimalPoints(repaired);
  const sentences = protectedText
    .match(/[^.!?]+[.!?]+["')\]]*|[^.!?]+$/g)
    ?.map((sentence) => restoreDecimalPoints(sentence).trim())
    .filter(Boolean) || [];
  return sentences.length ? sentences : [repaired].filter(Boolean);
}

function repairAITextBlocksWithContext(value, consistencyContext) {
  if (typeof value === "string") return repairCharacterSplitParagraph(value, consistencyContext);

  if (Array.isArray(value)) {
    return value.map((item) => repairAITextBlocksWithContext(item, consistencyContext));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, repairAITextBlocksWithContext(item, consistencyContext)])
    );
  }

  return value;
}

export function repairAITextBlocks(value) {
  return repairAITextBlocksWithContext(value, { count: 0, rotation: 0 });
}
