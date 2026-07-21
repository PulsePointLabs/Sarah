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
    charIndex: Number.isFinite(Number(meta.charIndex)) ? Number(meta.charIndex) : null,
  });
}

function isRelativeDurationReference(source = '', offset = 0, matchLength = 0) {
  const before = String(source).slice(Math.max(0, offset - 64), offset).toLowerCase();
  const after = String(source).slice(offset + matchLength, offset + matchLength + 48).toLowerCase();
  const explicitTimelineCue = /\b(?:at|around|near|by|from|between)\s+(?:(?:about|roughly|approximately)\s+)?$/.test(before);
  if (explicitTimelineCue && !/^\s*(?:before|ago|earlier|later)\b/.test(after)) return false;
  return /\b(?:prior|previous|past|last|next|within|for|over|lasting|held for|at least)\s+(?:(?:the|about|roughly|approximately)\s+)*$/.test(before)
    || /\bto\s+$/.test(before)
    || /^\s*(?:before|ago|earlier|later|long|in duration)\b/.test(after);
}

function words(value = '') {
  const stop = new Set([
    'about', 'after', 'again', 'also', 'around', 'being', 'during', 'from', 'into', 'that', 'this', 'there', 'these',
    'those', 'through', 'while', 'with', 'within', 'your', 'session', 'moment', 'window', 'evidence', 'marker',
    'saved', 'video', 'clip', 'analysis', 'section', 'body', 'physiology', 'appeared', 'suggests', 'suggested',
  ]);
  return new Set(String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .map((word) => word.replace(/^-+|-+$/g, ''))
    .filter((word) => word.length >= 4 && !stop.has(word)));
}

function hasAny(value = '', terms = []) {
  const text = String(value || '').toLowerCase();
  return terms.some((term) => term.test(text));
}

const FOLEY_PROCEDURE_CONCEPTS = [
  {
    score: 190,
    terms: [/\bmeatus\b/, /\bmeatal\b/, /\burethral opening\b/, /\bglans\b/, /\bforeskin\b/, /\bcatheter tip\b/],
    exclusions: [/\bdrainage bag\b/, /\bleg[-\s]?bag\b/, /\bambulatory\b/, /\btable vacant\b/, /\bgetting off\b/, /\bexiting the table\b/],
  },
  {
    score: 170,
    terms: [/\burethra\b/, /\burethral\b/, /\badvancement\b/, /\badvance\b/, /\binsertion\b/, /\bspongy urethra\b/, /\bprostatic urethra\b/, /\bfoley\b/, /\bcatheter\b/],
    exclusions: [/\btable vacant\b/, /\bambulatory\b/, /\bwalking\b/, /\bsecured off[-\s]?camera\b/],
  },
  {
    score: 175,
    terms: [/\bexternal sphincter\b/, /\binternal sphincter\b/, /\bsphincter\b/, /\bresistance\b/, /\bpinch\b/, /\bbladder neck\b/, /\brelaxation\b/, /\bbreathing\b/],
    exclusions: [/\bdrainage bag\b/, /\btable vacant\b/, /\bambulatory\b/],
  },
  {
    score: 165,
    terms: [/\burine return\b/, /\burine output\b/, /\bdrainage\b/, /\bdrainage bag\b/, /\bbladder entry\b/, /\bcollected\b/],
    exclusions: [/\bmeatus\b/, /\bmeatal\b/, /\bglans\b/],
  },
  {
    score: 175,
    terms: [/\bballoon\b/, /\binflat/, /\b5\s*cc\b/, /\bsterile water\b/, /\bsyringe\b/, /\bseating\b/, /\btraction\b/],
    exclusions: [/\bmeatus\b/, /\bmeatal\b/, /\bglans\b/],
  },
];

function procedureConceptScore(anchorText = '', paragraphText = '') {
  return FOLEY_PROCEDURE_CONCEPTS.reduce((sum, concept) => {
    const anchorHasConcept = hasAny(anchorText, concept.terms);
    const paragraphHasConcept = hasAny(paragraphText, concept.terms);
    if (!paragraphHasConcept) return sum;
    if (anchorHasConcept) return sum + concept.score;
    return hasAny(anchorText, concept.exclusions || []) ? sum - Math.max(120, concept.score * 0.75) : sum;
  }, 0);
}

function conceptScore(anchorText = '', paragraphText = '') {
  const concepts = [
    { score: 110, terms: [/\bejaculat/, /\bclimax/, /\borgasm/, /\bsemen/, /\bfluid release/, /\brelease\b/] },
    { score: 70, terms: [/\bpre[-\s]?climax/, /\bbuild/, /\bapproach/] },
    { score: 65, terms: [/\brecovery/, /\bsettled/, /\bsettling/, /\brecovered/] },
    { score: 50, terms: [/\bpeak hr\b/, /\bheart[-\s]?rate/, /\bbpm\b/] },
    { score: 50, terms: [/\bleft hand/, /\bright hand/, /\bsupported/, /\bsupporting/, /\bheld\b/, /\bgrip\b/] },
    { score: 135, terms: [/\blubric/, /\blube\b/, /\bgel\b/, /\bbottle\b/, /\bpreparation\b/, /\bprep\b/] },
    { score: 70, terms: [/\bpause/, /\bpaused/, /\breduced/, /\bwithdraw/, /\bcontact withdraw/, /\bno visible hand contact/] },
    { score: 40, terms: [/\bpelvic/, /\bperineal/, /\bcontraction/, /\bemg\b/] },
  ];
  const positive = concepts.reduce((sum, concept) => (
    hasAny(anchorText, concept.terms) && hasAny(paragraphText, concept.terms) ? sum + concept.score : sum
  ), 0);
  const paragraphWantsPause = hasAny(paragraphText, [/\bpause/, /\bpaused/, /\breduced/, /\bwithdraw/, /\bstop/, /\bstopped/, /\blubric/, /\blube\b/, /\bpreparation\b/, /\bprep\b/]);
  const anchorLooksActive = hasAny(anchorText, [/\bactive/, /\bstroking/, /\bcontinues/, /\bongoing/, /\btwo-handed.*continues/, /\bcontact continues/]);
  const anchorLooksOnlyVisibleObject = hasAny(anchorText, [/\bbottle visible/, /\bvisible in background/]) && !hasAny(anchorText, [/\bapply/, /\bapplication/, /\bprep/, /\bpreparation/, /\bhandling/]);
  const penalty = (paragraphWantsPause && anchorLooksActive ? 90 : 0) + (paragraphWantsPause && anchorLooksOnlyVisibleObject ? 35 : 0);
  return positive + procedureConceptScore(anchorText, paragraphText) - penalty;
}

function anchorScore(anchor, paragraphText = '') {
  const anchorText = [anchor.label, anchor.reason, anchor.note, anchor.category, anchor.tags].filter(Boolean).join(' ');
  const anchorWords = words(anchorText);
  const paragraphWords = words(paragraphText);
  const overlap = [...anchorWords].filter((word) => paragraphWords.has(word)).length;
  const explicitTimes = extractCitedTimesFromText(paragraphText);
  const directTime = explicitTimes.some((time) => Math.abs(Number(time.seconds) - Number(anchor.session_time_s)) <= 18) ? 140 : 0;
  return directTime + conceptScore(anchorText, paragraphText) + (overlap * 12);
}

function addAnchor(anchors, time, label, reason, extra = {}) {
  if (time == null || String(time).trim() === '') return;
  const seconds = Number(time);
  const minimumSeconds = extra.allowZero === false ? Number.EPSILON : 0;
  if (!Number.isFinite(seconds) || seconds < minimumSeconds) return;
  anchors.push({
    id: extra.id || `${label}:${Math.round(seconds)}`,
    label,
    reason,
    session_time_s: Math.round(seconds * 10) / 10,
    note: extra.note || '',
    category: extra.category || '',
    tags: extra.tags || '',
    source: extra.source || 'logged_session_event',
  });
}

function eventWindowForAnchor(anchor = {}, paragraphText = '') {
  const text = [anchor.label, anchor.reason, anchor.note, anchor.category, anchor.tags, paragraphText].filter(Boolean).join(' ');
  if (hasAny(text, [/\bpause/, /\bpaused/, /\breduced/, /\bwithdraw/, /\bno visible hand contact/, /\blubric/, /\blube\b/, /\bpreparation\b/, /\bprep\b/])) {
    return { before: 1, after: 12 };
  }
  if (hasAny(text, [/\bejaculat/, /\bclimax/, /\borgasm/, /\bsemen/, /\bfluid release/])) {
    return { before: 4, after: 22 };
  }
  return { before: 3, after: 12 };
}

export function buildLoggedEventAnchors(session = {}) {
  const anchors = [];
  addAnchor(anchors, session.pre_climax_offset_s, 'Pre-climax build', 'Logged pre-climax phase marker', { source: 'phase_marker', allowZero: false });
  addAnchor(anchors, session.climax_offset_s, 'Climax / ejaculation', 'Logged climax or ejaculation phase marker', { source: 'phase_marker', allowZero: false });
  addAnchor(anchors, session.recovery_offset_s, 'Recovery shift', 'Logged recovery phase marker', { source: 'phase_marker', allowZero: false });

  (Array.isArray(session.event_timeline) ? session.event_timeline : []).forEach((event, index) => {
    const category = Array.isArray(event?.category) ? event.category.join(' ') : event?.category || '';
    const tags = Array.isArray(event?.annotation_tags) ? event.annotation_tags.join(' ') : event?.annotation_tags || '';
    const note = String(event?.note || '').trim();
    addAnchor(
      anchors,
      event?.time_s,
      note || `Logged event ${index + 1}`,
      'Timestamped session event',
      {
        id: event?.id || `logged-event-${index + 1}`,
        note,
        category,
        tags,
        source: 'event_timeline',
      }
    );
  });

  const seen = new Set();
  return anchors.filter((anchor) => {
    const key = `${Math.round(Number(anchor.session_time_s) || 0)}:${anchor.label.toLowerCase()}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function buildLoggedEventRequests(paragraphs = [], session = {}, existingClips = []) {
  const anchors = buildLoggedEventAnchors(session);
  const requests = [];
  const usedAnchors = new Set();

  (Array.isArray(paragraphs) ? paragraphs : []).forEach((paragraph, paragraphIndex) => {
    const explicitTimes = extractCitedTimesFromText(paragraph);
    const maxAnchors = explicitTimes.length > 1 ? 2 : 1;
    const candidates = anchors
      .map((anchor) => ({ anchor, score: anchorScore(anchor, paragraph) }))
      .filter(({ anchor, score }) => score >= 55 && !usedAnchors.has(anchor.id))
      .sort((a, b) => b.score - a.score)
      .slice(0, maxAnchors);

    candidates.forEach(({ anchor }) => {
      const duplicateExisting = existingClips.some((clip) => (
        Number.isFinite(Number(clip.session_time_s)) &&
        Math.abs(Number(clip.session_time_s) - Number(anchor.session_time_s)) <= 12 &&
        Number(clip.paragraphIndex) === paragraphIndex
      ));
      if (duplicateExisting) return;
      usedAnchors.add(anchor.id);
      const window = eventWindowForAnchor(anchor, paragraph);
      requests.push({
        id: `logged-${anchor.id}`,
        paragraphIndex,
        session_time_s: anchor.session_time_s,
        cited_text: anchor.label,
        label: anchor.label,
        reason: anchor.reason,
        source: anchor.source,
        startSeconds: Math.max(0, anchor.session_time_s - window.before),
        endSeconds: anchor.session_time_s + window.after,
      });
    });
  });

  return requests;
}

export function extractCitedTimesFromText(text, paragraphIndex = null) {
  const source = String(text || '');
  const times = [];

  source.replace(/\b(?:(\d{1,2}):)?(\d{1,2}):(\d{2})\b/g, (match, hours, minutes, seconds, offset) => {
    const total = (Number(hours || 0) * 3600) + (Number(minutes) * 60) + Number(seconds);
    pushTime(times, total, { text: match, paragraphIndex, source: 'clock_time', charIndex: offset });
    return match;
  });

  source.replace(/\b(\d{1,3}):(\d{2})\b/g, (match, minutes, seconds, offset) => {
    const total = (Number(minutes) * 60) + Number(seconds);
    pushTime(times, total, { text: match, paragraphIndex, source: 'minute_second_time', charIndex: offset });
    return match;
  });

  source.replace(/\b(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds)\b/gi, (match, seconds, offset) => {
    if (!isRelativeDurationReference(source, offset, match.length)) {
      pushTime(times, Number(seconds), { text: match, paragraphIndex, source: 'seconds_text', charIndex: offset });
    }
    return match;
  });

  source.replace(/\b(\d+(?:\.\d+)?)\s*(?:m|min|mins|minute|minutes)\s*(?:and\s*)?(?:(\d+(?:\.\d+)?)\s*(?:s|sec|secs|second|seconds))?\b/gi, (match, minutes, seconds, offset) => {
    if (!isRelativeDurationReference(source, offset, match.length)) {
      pushTime(times, (Number(minutes) * 60) + Number(seconds || 0), { text: match, paragraphIndex, source: 'numeric_minute_text', charIndex: offset });
    }
    return match;
  });

  const numberWord = '(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety)(?:[-\\s](?:one|two|three|four|five|six|seven|eight|nine))?';
  const wordTime = new RegExp(`\\b(${numberWord}|\\d+)\\s+(?:minute|minutes)\\s*(?:and\\s*)?(?:(${numberWord}|\\d+)\\s+(?:second|seconds))?\\b`, 'gi');
  source.replace(wordTime, (match, minuteText, secondText, offset) => {
    const minutes = wordNumber(minuteText);
    const seconds = secondText ? wordNumber(secondText) : 0;
    if (minutes != null && seconds != null && !isRelativeDurationReference(source, offset, match.length)) {
      pushTime(times, (minutes * 60) + seconds, { text: match, paragraphIndex, source: 'word_minute_text', charIndex: offset });
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
      if (previous.charIndex == null && item.charIndex != null) previous.charIndex = item.charIndex;
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
  session = {},
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

  const loggedEventRequests = buildLoggedEventRequests(paragraphs, session, clips);

  const missingTimes = citedTimes.filter((time) => ![...clips, ...loggedEventRequests].some((clip) => (
    Number.isFinite(Number(clip.session_time_s)) &&
    Math.abs(Number(clip.session_time_s) - Number(time.seconds)) <= 12
  )));

  const generatedClipRequests = [
    ...loggedEventRequests,
    ...missingTimes.map((time, index) => ({
    id: `cited-${index + 1}`,
    paragraphIndex: time.paragraphIndex,
    session_time_s: time.seconds,
    cited_text: time.text,
    label: `Cited moment ${index + 1}`,
    reason: time.text ? `Referenced as ${time.text}` : 'Referenced in analysis',
    startSeconds: Math.max(0, time.seconds - clipPreSeconds),
    endSeconds: Math.max(time.seconds + 0.25, time.seconds + clipPostSeconds),
    })),
  ];

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
