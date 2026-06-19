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

const TIME_WORD_VALUES = new Map([
  ["zero", 0],
  ["oh", 0],
  ["o", 0],
  ["one", 1],
  ["two", 2],
  ["three", 3],
  ["four", 4],
  ["five", 5],
  ["six", 6],
  ["seven", 7],
  ["eight", 8],
  ["nine", 9],
  ["ten", 10],
  ["eleven", 11],
  ["twelve", 12],
  ["thirteen", 13],
  ["fourteen", 14],
  ["fifteen", 15],
  ["sixteen", 16],
  ["seventeen", 17],
  ["eighteen", 18],
  ["nineteen", 19],
  ["twenty", 20],
  ["thirty", 30],
  ["forty", 40],
  ["fifty", 50],
]);

const TIME_PREFIX_RE = "(at|around|near|by|before|after|from|until|through|to|between)";
const TIME_ONES_RE = "(?:one|two|three|four|five|six|seven|eight|nine)";
const TIME_TEENS_RE = "(?:ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen)";
const TIME_TENS_RE = "(?:twenty|thirty|forty|fifty)";
const TIME_NUMBER_WORD_RE = `(?:${TIME_TEENS_RE}|${TIME_TENS_RE}(?:[-\\s]+${TIME_ONES_RE})?|${TIME_ONES_RE}|zero)`;
const SPOKEN_CLOCK_TIME_RE = new RegExp(
  `\\b${TIME_PREFIX_RE}\\s+(${TIME_NUMBER_WORD_RE})[-\\s]+((?:oh|o|zero)[-\\s]+${TIME_ONES_RE}|${TIME_TEENS_RE}|${TIME_TENS_RE}(?:[-\\s]+${TIME_ONES_RE})?)\\b`,
  "gi"
);

function parseTimeWords(value) {
  const normalized = String(value || "").toLowerCase().replace(/-/g, " ").trim();
  if (!normalized) return null;
  const words = normalized.split(/\s+/).filter(Boolean);
  if (words.length === 1) return TIME_WORD_VALUES.get(words[0]) ?? null;
  if (words.length === 2 && ["oh", "o", "zero"].includes(words[0])) {
    const ones = TIME_WORD_VALUES.get(words[1]);
    return ones != null && ones > 0 && ones < 10 ? ones : null;
  }
  if (words.length === 2) {
    const tens = TIME_WORD_VALUES.get(words[0]);
    const ones = TIME_WORD_VALUES.get(words[1]);
    if (tens != null && ones != null && tens >= 20 && tens <= 50 && ones > 0 && ones < 10) {
      return tens + ones;
    }
  }
  return null;
}

function hyphenateNumberWords(value) {
  return String(value || "").toLowerCase().replace(/\s+/g, "-");
}

function displaySecondWords(value) {
  return String(value || "").toLowerCase().replace(/^(?:oh|o|zero)[-\s]+/i, "");
}

export function repairSpokenClockTimeReferences(text) {
  if (typeof text !== "string") return text;
  return text.replace(SPOKEN_CLOCK_TIME_RE, (match, prefix, minuteWords, secondWords) => {
    const minutes = parseTimeWords(minuteWords);
    const seconds = parseTimeWords(secondWords);
    if (minutes == null || seconds == null || minutes < 0 || seconds < 0 || minutes > 59 || seconds > 59) return match;
    const minuteLabel = `${minuteWords.toLowerCase().replace(/\s+/g, "-")} minute${minutes === 1 ? "" : "s"}`;
    const secondLabel = `${hyphenateNumberWords(displaySecondWords(secondWords))} second${seconds === 1 ? "" : "s"}`;
    return `${prefix} ${minuteLabel} and ${secondLabel}`;
  });
}

export function repairRawSecondTimeReferences(text) {
  if (typeof text !== "string") return text;
  return repairSpokenClockTimeReferences(text)
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
