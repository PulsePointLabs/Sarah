function formatSessionClock(secondsValue) {
  const seconds = Number(secondsValue);
  if (!Number.isFinite(seconds) || seconds < 0) return String(secondsValue);
  const roundedTenths = Math.round(seconds * 10) / 10;
  const wholeMinutes = Math.floor(roundedTenths / 60);
  const secondsInMinute = roundedTenths - (wholeMinutes * 60);
  const secondsText = Number.isInteger(secondsInMinute)
    ? String(secondsInMinute).padStart(2, "0")
    : secondsInMinute.toFixed(1).padStart(4, "0");
  return `${wholeMinutes}:${secondsText}`;
}

export function formatManualAnnotationReviewText(value) {
  if (value == null) return "";
  const preserveCase = (match, replacement) => (
    /^[A-Z]/.test(match) ? replacement.charAt(0).toUpperCase() + replacement.slice(1) : replacement
  );
  return String(value)
    .replace(/\bno\s+(?:clinician|examiner|operator|caregiver)\s+contact\b/gi, (match) => preserveCase(match, "no hand contact"))
    .replace(/\bactive\s+(?:clinician|examiner|operator|caregiver)\s+repositioning\b/gi, (match) => preserveCase(match, "your active repositioning"))
    .replace(/\b(?:a|the)\s+(?:clinician|examiner|operator|caregiver)\s+(right|left)\s+(hand)\b/gi, (match, side, hand) => preserveCase(match, `your ${side.toLowerCase()} ${hand.toLowerCase()}`))
    .replace(/\b(?:clinician|examiner|operator|caregiver)\s+(right|left)\s+(hand)\b/gi, (match, side, hand) => preserveCase(match, `your ${side.toLowerCase()} ${hand.toLowerCase()}`))
    .replace(/\b(?:a|the)\s+(?:clinician|examiner|operator|caregiver)['’]s\s+(hands?)\b/gi, (match, hand) => preserveCase(match, `your ${hand.toLowerCase()}`))
    .replace(/\b(?:clinician|examiner|operator|caregiver)['’]s\s+(hands?)\b/gi, (match, hand) => preserveCase(match, `your ${hand.toLowerCase()}`))
    .replace(/\b(?:a|the)\s+(?:clinician|examiner|operator|caregiver)\s+(hands?)\b/gi, (match, hand) => preserveCase(match, `your ${hand.toLowerCase()}`))
    .replace(/\b(?:clinician|examiner|operator|caregiver)\s+(hands?)\b/gi, (match, hand) => preserveCase(match, `your ${hand.toLowerCase()}`))
    .replace(/\b(?:clinician|examiner|operator|caregiver)\s+manipulation\b/gi, (match) => preserveCase(match, "hand adjustment"))
    .replace(/\bthe\s+(?:subject|patient|client)['’]s\b/gi, (match) => preserveCase(match, "your"))
    .replace(/\b(?:subject|patient|client)['’]s\b/gi, (match) => preserveCase(match, "your"))
    .replace(/\bthe\s+(?:subject|patient|client)\b/gi, (match) => preserveCase(match, "you"))
    .replace(/\b(?:subject|patient|client)\b/gi, (match) => preserveCase(match, "you"))
    .replace(/\b(?:a|the)\s+(?:clinician|examiner|operator|caregiver)\b/gi, (match) => preserveCase(match, "you"))
    .replace(/\b(?:clinician|examiner|operator|caregiver)\b/gi, (match) => preserveCase(match, "you"))
    .replace(/\byou\s+is\b/gi, (match) => preserveCase(match, "you are"))
    .replace(/\byou\s+was\b/gi, (match) => preserveCase(match, "you were"))
    .replace(/\byou\s+lies\b/gi, (match) => preserveCase(match, "you lie"))
    .replace(/\byou\s+remains\b/gi, (match) => preserveCase(match, "you remain"))
    .replace(/\byou\s+appears\b/gi, (match) => preserveCase(match, "you appear"))
    .replace(/\byou\s+maintains\b/gi, (match) => preserveCase(match, "you maintain"))
    .replace(/\byou\s+shows\b/gi, (match) => preserveCase(match, "you show"))
    .replace(/\byou\s+has\b/gi, (match) => preserveCase(match, "you have"))
    .replace(/\byou\s+does\b/gi, (match) => preserveCase(match, "you do"))
    .replace(/\b(\d{1,3}:\d{2}(?:\.\d+)?)(?=your\b)/gi, "$1 ")
    .replace(/\b(\d{2,}(?:\.\d+)?)\s*([–—-])\s*(\d{2,}(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/gi, (match, start, dash, end) => {
      if (Number(start) < 60 && Number(end) < 60) return match;
      return `${formatSessionClock(start)}${dash}${formatSessionClock(end)}`;
    })
    .replace(/\b(\d{2,}(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/gi, (match, seconds) => (
      Number(seconds) >= 60 ? formatSessionClock(seconds) : match
    ));
}

const NON_BODY_OBJECT_CONTEXT = /\b(?:equipment|devices?|smartphone|tablets?|blood[-\s]?pressure|BP acquisition|cuffs?|side table|telemetry|troubleshooting|interfaces?)\b/i;

export function stripNonBodyObjectContext(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !NON_BODY_OBJECT_CONTEXT.test(sentence))
    .join(" ")
    .trim();
}

const STATIC_CHANGE_LANGUAGE = /\b(?:remain(?:s|ed)?|retain(?:s|ed)?|persist(?:s|ed)?|unchanged|no (?:new|further|clear|visible|appreciable) (?:change|increase|decrease|arching|tilt|elevation)|without (?:further|clear|visible) (?:change|increase|decrease|relaxation)|flat baseline|baseline finding)\b/i;
const STATIC_POSTURE = /\b(?:supine|flat (?:on|against) (?:the )?(?:table|surface)|no back arch(?:ing)?|no pelvic tilt|no postural elevation)\b/i;
const STATIC_SKIN = /\b(?:skin|mottl(?:e|ed|ing)|pink(?:ish)?|red(?:ness)?|tone|color(?:ation)?|rugae|surface finding)\b/i;

export function stripStaticManualAnnotationReviewText(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  return text
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !(STATIC_CHANGE_LANGUAGE.test(sentence) && (STATIC_POSTURE.test(sentence) || STATIC_SKIN.test(sentence))))
    .join(" ")
    .trim();
}

export { formatSessionClock };
