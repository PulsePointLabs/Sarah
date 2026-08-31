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
  return String(value)
    .replace(/\b(\d{2,}(?:\.\d+)?)\s*([–—-])\s*(\d{2,}(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/gi, (match, start, dash, end) => {
      if (Number(start) < 60 && Number(end) < 60) return match;
      return `${formatSessionClock(start)}${dash}${formatSessionClock(end)}`;
    })
    .replace(/\b(\d{2,}(?:\.\d+)?)\s*(?:seconds?|secs?|s)\b/gi, (match, seconds) => (
      Number(seconds) >= 60 ? formatSessionClock(seconds) : match
    ));
}

export { formatSessionClock };
