const SMALL_NUMBERS = {
  zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9,
  ten: 10, eleven: 11, twelve: 12, thirteen: 13, fourteen: 14, fifteen: 15, sixteen: 16,
  seventeen: 17, eighteen: 18, nineteen: 19,
};

const TENS = {
  twenty: 20, thirty: 30, forty: 40, fifty: 50, sixty: 60, seventy: 70, eighty: 80, ninety: 90,
};

function wordsToNumber(value = "") {
  const tokens = String(value).toLowerCase().replace(/-/g, " ").split(/\s+/).filter(Boolean);
  if (!tokens.length) return null;
  let total = 0;
  let current = 0;
  let recognized = 0;
  for (const token of tokens) {
    if (Object.hasOwn(SMALL_NUMBERS, token)) {
      current += SMALL_NUMBERS[token];
      recognized += 1;
    } else if (Object.hasOwn(TENS, token)) {
      current += TENS[token];
      recognized += 1;
    } else if (token === "hundred") {
      current = Math.max(1, current) * 100;
      recognized += 1;
    } else if (token === "thousand") {
      total += Math.max(1, current) * 1000;
      current = 0;
      recognized += 1;
    } else if (token !== "and") {
      return null;
    }
  }
  return recognized ? total + current : null;
}

function numericAmount(value = "") {
  const direct = Number(String(value).replace(/,/g, ""));
  return Number.isFinite(direct) ? direct : wordsToNumber(value);
}

export function parseEnemaVolumeEntry(text = "") {
  const normalized = String(text).toLowerCase().replace(/[–—]/g, "-").replace(/\s+/g, " ").trim();
  if (!normalized) return null;
  const actionPresent = /\b(instill(?:ed|ing|ation)?|infus(?:ed|ing|ion)?|put in|added|add|went in|fluid in|another)\b/.test(normalized);
  if (!actionPresent) return null;

  const numberToken = "(?:\\d+(?:\\.\\d+)?|(?:(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|and)[ -]?)+)";
  const match = normalized.match(new RegExp(`\\b(${numberToken})\\s*(millilit(?:er|re)s?|ml|mils?|ccs?|cubic centimeters?|lit(?:er|re)s?|l)\\b`, "i"));
  if (!match) return null;

  const amount = numericAmount(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return null;
  const unit = match[2].toLowerCase();
  const amountMl = /^(?:l|lit)/.test(unit) ? amount * 1000 : amount;
  if (!Number.isFinite(amountMl) || amountMl <= 0 || amountMl > 10000) return null;
  return {
    amountMl: Math.round(amountMl * 10) / 10,
    sourceText: String(text).trim(),
  };
}

export function enemaInstilledAmountFromEvent(event = {}) {
  const structured = Number(event?.procedure_measurement?.amount_ml ?? event?.instilled_volume_ml);
  return Number.isFinite(structured) && structured > 0 ? structured : 0;
}

export function sumEnemaInstilledVolume(events = []) {
  return Math.round((events || []).reduce((sum, event) => sum + enemaInstilledAmountFromEvent(event), 0) * 10) / 10;
}

export function formatMilliliters(value) {
  const amount = Number(value);
  if (!Number.isFinite(amount)) return "0 mL";
  return `${Number.isInteger(amount) ? amount : amount.toFixed(1)} mL`;
}
