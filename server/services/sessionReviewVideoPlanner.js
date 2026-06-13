const NUMBER_WORDS = new Map([
  ['zero', 0], ['one', 1], ['two', 2], ['three', 3], ['four', 4], ['five', 5],
  ['six', 6], ['seven', 7], ['eight', 8], ['nine', 9], ['ten', 10],
  ['eleven', 11], ['twelve', 12], ['thirteen', 13], ['fourteen', 14], ['fifteen', 15],
  ['sixteen', 16], ['seventeen', 17], ['eighteen', 18], ['nineteen', 19],
  ['twenty', 20], ['thirty', 30], ['forty', 40], ['fifty', 50], ['sixty', 60],
  ['seventy', 70], ['eighty', 80], ['ninety', 90],
]);

function wordNumber(value) {
  const text = String(value || '').toLowerCase().replace(/-/g, ' ').replace(/\band\b/g, ' ').trim();
  if (!text) return null;
  if (/^\d+$/.test(text)) return Number(text);
  let total = 0;
  let found = false;
  text.split(/\s+/).forEach((part) => {
    if (NUMBER_WORDS.has(part)) {
      total += NUMBER_WORDS.get(part);
      found = true;
    }
  });
  return found ? total : null;
}

function pushTime(times, seconds, meta = {}) {
  const numeric = Number(seconds);
  if (!Number.isFinite(numeric) || numeric < 0) return;
  times.push({
    seconds: Math.round(numeric * 10) / 10,
    source: meta.source || 'analysis_text',
    text: String(meta.text || '').trim().slice(0, 160),
    paragraphIndex: Number.isFinite(Number(meta.paragraphIndex)) ? Number(meta.paragraphIndex) : null,
  });
}

export function extractCitedTimesFromText(text, paragraphIndex = null) {
  const source = String(text || '');
  const times = [];

  source.replace(/\b(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\b/g, (match, hours, minutes, seconds) => {
    const total = (Number(hours || 0) * 3600) + (Number(minutes) * 60) + Number(seconds);
    pushTime(times, total, { text: match, paragraphIndex, source: 'clock_time' });
    return match;
  });

  source.replace(/\b(\d{1,3}):(\d{2})\b/g, (match, minutes, seconds) => {
    const total = (Number(minutes) * 60) + Number(seconds);
    pushTime(times, total, { text: match, paragraphIndex, source: 'minute_second_time' });
    return match;
  });

  source.replace(/\b(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds)\b/gi, (match, seconds) => {
    pushTime(times, Number(seconds), { text: match, paragraphIndex, source: 'seconds_text' });
    return match;
  });

  source.replace(/\b(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes)\s*(?:and\s*)?(?:(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds))?\b/gi, (match, minutes, seconds) => {
    pushTime(times, (Number(minutes) * 60) + Number(seconds || 0), { text: match, paragraphIndex, source: 'numeric_minute_text' });
    return match;
  });

  const numberWord = '(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[-\\s](?:one|two|three|four|five|six|seven|eight|nine))?';
  const wordTime = new RegExp(`\\b(${numberWord}|\\d+)\\s+(?:minute|minutes)\\s*(?:and\\s*)?(?:(${numberWord}|\\d+)\\s+(?:second|seconds))?\\b`, 'gi');
  source.replace(wordTime, (match, minuteText, secondText) => {
    const minutes = wordNumber(minuteText);
    const seconds = secondText ? wordNumber(secondText) : 0;
    if (minutes != null && seconds != null) {
      pushTime(times, (minutes * 60) + seconds, { text: match, paragraphIndex, source: 'word_minute_text' });
    }
    return match;
  });

  return dedupeTimes(times, 2);
}

export function extractCitedTimesFromParagraphs(paragraphs = []) {
  const all = [];
  (Array.isArray(paragraphs) ? paragraphs : []).forEach((paragraph, index) => {
    all.push(...extractCitedTimesFromText(paragraph, index));
  });
  return dedupeTimes(all, 12);
}

export function dedupeTimes(times = [], thresholdSeconds = 12) {
  const sorted = (Array.isArray(times) ? times : [])
    .filter((item) => Number.isFinite(Number(item?.seconds)))
    .sort((a, b) => Number(a.seconds) - Number(b.seconds));
  const deduped = [];
  for (const item of sorted) {
    const previous = deduped[deduped.length - 1];
    if (previous && Math.abs(Number(item.seconds) - Number(previous.seconds)) <= thresholdSeconds) {
      if (previous.paragraphIndex == null && item.paragraphIndex != null) previous.paragraphIndex = item.paragraphIndex;
      continue;
    }
    deduped.push({ ...item, seconds: Number(item.seconds) });
  }
  return deduped;
}

export function buildReviewVideoPlan({
  paragraphs = [],
  paragraphMeta = [],
  existingClips = [],
  clipPreSeconds = 6,
  clipPostSeconds = 10,
} = {}) {
  const citedTimes = extractCitedTimesFromParagraphs(paragraphs);
  const clips = (Array.isArray(existingClips) ? existingClips : [])
    .map((clip, index) => ({
      ...clip,
      reviewClipId: clip.id || `existing-${index + 1}`,
      paragraphIndex: Number.isFinite(Number(clip.paragraphIndex)) ? Number(clip.paragraphIndex) : null,
      session_time_s: Number(clip.session_time_s ?? clip.sessionTimeSeconds ?? clip.timeline_offset_s),
      source: 'existing_key_clip',
    }))
    .filter((clip) => Number.isFinite(Number(clip.session_time_s)) || clip.file_url || clip.url || clip.clip_url);

  const missingTimes = citedTimes.filter((time) => !clips.some((clip) => (
    Number.isFinite(Number(clip.session_time_s)) &&
    Math.abs(Number(clip.session_time_s) - Number(time.seconds)) <= 12
  )));

  const generatedClipRequests = missingTimes.map((time, index) => ({
    id: `cited-${index + 1}`,
    paragraphIndex: time.paragraphIndex,
    session_time_s: time.seconds,
    cited_text: time.text,
    label: `Cited moment ${index + 1}`,
    reason: time.text ? `Referenced as ${time.text}` : 'Referenced in analysis',
    startSeconds: Math.max(0, time.seconds - clipPreSeconds),
    endSeconds: Math.max(time.seconds + 0.25, time.seconds + clipPostSeconds),
  }));

  const paragraphPlans = (Array.isArray(paragraphs) ? paragraphs : []).map((text, index) => {
    const meta = paragraphMeta[index] || {};
    const paragraphClips = clips.filter((clip) => Number(clip.paragraphIndex) === index);
    const paragraphRequests = generatedClipRequests.filter((request) => Number(request.paragraphIndex) === index);
    return {
      index,
      text: String(text || ''),
      label: meta?.sec?.label || meta?.type || (index === 0 ? 'Summary' : `Section ${index + 1}`),
      clips: paragraphClips,
      generatedClipRequests: paragraphRequests,
    };
  });

  return {
    version: 1,
    citedTimes,
    existingClips: clips,
    generatedClipRequests,
    paragraphPlans,
  };
}
