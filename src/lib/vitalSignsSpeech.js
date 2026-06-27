const SMALL_NUMBERS = [
  "zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine",
  "ten", "eleven", "twelve", "thirteen", "fourteen", "fifteen", "sixteen",
  "seventeen", "eighteen", "nineteen",
];

const TENS = ["", "", "twenty", "thirty", "forty", "fifty", "sixty", "seventy", "eighty", "ninety"];

export function numberToSpokenWords(value) {
  const normalized = String(value ?? "").replace(/,/g, "").trim();
  if (!/^-?\d+(?:\.\d+)?$/.test(normalized)) return normalized;
  const [integerPart, decimalPart] = normalized.replace(/^-/, "").split(".");
  const integer = Number(integerPart);

  function integerWords(number) {
    if (number < 20) return SMALL_NUMBERS[number];
    if (number < 100) return `${TENS[Math.floor(number / 10)]}${number % 10 ? `-${SMALL_NUMBERS[number % 10]}` : ""}`;
    if (number < 1_000) return `${SMALL_NUMBERS[Math.floor(number / 100)]} hundred${number % 100 ? ` ${integerWords(number % 100)}` : ""}`;
    if (number < 1_000_000) return `${integerWords(Math.floor(number / 1_000))} thousand${number % 1_000 ? ` ${integerWords(number % 1_000)}` : ""}`;
    if (number < 1_000_000_000) return `${integerWords(Math.floor(number / 1_000_000))} million${number % 1_000_000 ? ` ${integerWords(number % 1_000_000)}` : ""}`;
    return String(number);
  }

  const sign = normalized.startsWith("-") ? "negative " : "";
  const whole = integerWords(integer);
  if (!decimalPart) return `${sign}${whole}`;
  return `${sign}${whole} point ${decimalPart.split("").map((digit) => SMALL_NUMBERS[Number(digit)]).join(" ")}`;
}

export function formatDurationWords(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const remainder = total % 60;
  const parts = [];
  if (hours) parts.push(`${numberToSpokenWords(hours)} hour${hours === 1 ? "" : "s"}`);
  if (minutes) parts.push(`${numberToSpokenWords(minutes)} minute${minutes === 1 ? "" : "s"}`);
  if (remainder || !parts.length) parts.push(`${numberToSpokenWords(remainder)} second${remainder === 1 ? "" : "s"}`);
  if (parts.length === 1) return parts[0];
  if (parts.length === 2) return `${parts[0]} and ${parts[1]}`;
  return `${parts[0]}, ${parts[1]}, and ${parts[2]}`;
}

function formatClockWords(hoursValue, minutesValue, zone = "") {
  const hours = Number(hoursValue);
  const minutes = Number(minutesValue);
  const meridiem = hours >= 12 ? "P M" : "A M";
  const clockHour = hours % 12 || 12;
  const minuteWords = minutes
    ? minutes < 10
      ? `oh ${numberToSpokenWords(minutes)}`
      : numberToSpokenWords(minutes)
    : "";
  const zoneWords = /ET|Eastern/i.test(zone) ? " Eastern Time" : "";
  return `${numberToSpokenWords(clockHour)}${minuteWords ? ` ${minuteWords}` : ""} ${meridiem}${zoneWords}`;
}

export function formatVitalSignsSpeech(value) {
  let text = String(value || "");
  if (!text) return text;

  text = text
    .replace(/(^|[.!?]\s+)Ben['’]s\b/g, "$1Your")
    .replace(/(^|[.!?]\s+)Ben is\b/g, "$1You are")
    .replace(/(^|[.!?]\s+)Ben was\b/g, "$1You were")
    .replace(/(^|[.!?]\s+)Ben has\b/g, "$1You have")
    .replace(/(^|[.!?]\s+)Ben had\b/g, "$1You had")
    .replace(/\bBen['’]s\b/gi, "your")
    .replace(/\bBen is\b/gi, "you are")
    .replace(/\bBen was\b/gi, "you were")
    .replace(/\bBen has\b/gi, "you have")
    .replace(/\bBen had\b/gi, "you had")
    .replace(/\bBen\b/gi, "you")
    .replace(/\bhis\b/gi, "your")
    .replace(/\b(\d{1,2}):(\d{2})\s*(ET|Eastern Time)\b/gi, (_match, hours, minutes, zone) => formatClockWords(hours, minutes, zone))
    .replace(/\b(\d{1,3})\s*\/\s*(\d{1,3})\s*(?:mm\s*Hg|mmHg)\b/gi, (_match, systolic, diastolic) => `${numberToSpokenWords(systolic)} over ${numberToSpokenWords(diastolic)} millimeters of mercury`)
    .replace(/~\s*(\d+(?:\.\d+)?)\s*(?:min|minutes?)\b/gi, (_match, amount) => `approximately ${numberToSpokenWords(amount)} minutes`)
    .replace(/\b(\d+(?:\.\d+)?)-minute\b/gi, (_match, amount) => `${numberToSpokenWords(amount)}-minute`)
    .replace(/\b(\d+)h\s*(\d+)m(?:\s*(\d+)s)?\b/gi, (_match, hours, minutes, seconds) => formatDurationWords((Number(hours) * 3600) + (Number(minutes) * 60) + Number(seconds || 0)))
    .replace(/\b(\d+)m\s*(\d+)s\b/gi, (_match, minutes, seconds) => formatDurationWords((Number(minutes) * 60) + Number(seconds)))
    .replace(/\b(\d{1,3}(?:\.\d+)?)\s*bpm\b/gi, (_match, amount) => `${numberToSpokenWords(amount)} beats per minute`)
    .replace(/\b(\d+(?:\.\d+)?)\s*ms\b/gi, (_match, amount) => `${numberToSpokenWords(amount)} milliseconds`)
    .replace(/\b(\d+(?:\.\d+)?)\s*%\b/g, (_match, amount) => `${numberToSpokenWords(amount)} percent`)
    .replace(/\b(\d{1,2}):(\d{2})\b/g, (_match, minutes, seconds) => formatDurationWords((Number(minutes) * 60) + Number(seconds)))
    .replace(/\bRMSSD\b/gi, "root mean square of successive differences")
    .replace(/\bHRV\b/gi, "heart rate variability")
    .replace(/\bHR\b/g, "heart rate")
    .replace(/\bBP\b/g, "blood pressure")
    .replace(/\bMAP\b/g, "mean arterial pressure")
    .replace(/\bPP\b/g, "pulse pressure")
    .replace(/\bECG\b/gi, "E C G")
    .replace(/\bRR\b/g, "R R")
    .replace(/\bJun\b/g, "June")
    .replace(/\b(\d{1,3}(?:,\d{3})+|\d+(?:\.\d+)?)\b/g, (match) => numberToSpokenWords(match));

  return text.replace(/\s+/g, " ").trim();
}
