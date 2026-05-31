const DECIMAL_POINT_TOKEN = "__PULSEPOINT_DECIMAL_POINT__";

function protectDecimalPoints(text) {
  return String(text || "").replace(/(\d+)\.(\d+)/g, `$1${DECIMAL_POINT_TOKEN}$2`);
}

function restoreDecimalPoints(text) {
  return String(text || "").replaceAll(DECIMAL_POINT_TOKEN, ".");
}

export function repairCharacterSplitParagraph(text) {
  if (typeof text !== "string") return text;

  const lines = text.split(/\r?\n/);
  const nonEmpty = lines.map((line) => line.trim()).filter(Boolean);
  const singleCharLines = nonEmpty.filter((line) => line.length === 1).length;
  const shortLines = nonEmpty.filter((line) => line.length <= 2).length;
  const looksCharacterSplit =
    nonEmpty.length >= 40 &&
    singleCharLines / nonEmpty.length >= 0.65 &&
    shortLines / nonEmpty.length >= 0.85;

  if (!looksCharacterSplit) return repairDecimalSpacing(text);

  return nonEmpty
    .join("")
    .replace(/\s+/g, " ")
    .replace(/(\d+)\.\s+(\d+)/g, "$1.$2")
    .replace(/([.!?])([A-Z])/g, "$1 $2")
    .trim();
}

export function repairDecimalSpacing(text) {
  if (typeof text !== "string") return text;
  return text.replace(/(\d+)\.\s+(\d+)/g, "$1.$2");
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

export function repairAITextBlocks(value) {
  if (typeof value === "string") return repairCharacterSplitParagraph(value);

  if (Array.isArray(value)) {
    return value.map((item) => repairAITextBlocks(item));
  }

  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, repairAITextBlocks(item)])
    );
  }

  return value;
}
