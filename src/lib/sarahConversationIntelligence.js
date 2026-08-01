const STOP_WORDS = new Set([
  "a", "about", "again", "all", "also", "am", "an", "and", "are", "as", "at",
  "be", "been", "but", "by", "can", "could", "did", "do", "does", "for", "from",
  "had", "has", "have", "how", "i", "if", "in", "is", "it", "just", "like", "me",
  "my", "of", "on", "or", "please", "so", "some", "that", "the", "then", "there",
  "this", "to", "was", "we", "were", "what", "when", "where", "which", "with",
  "would", "you", "your",
]);

const TOPIC_GROUPS = Object.freeze([
  ["catheter / urethral procedure", /\b(?:catheter|foley|urethr|sound(?:ing)?|dilat(?:e|ion|or)|hegar|meatus|bladder)\b/i],
  ["enema / rectal procedure", /\b(?:enema|rectal|anus|anal|probe|bowel|expel)\b/i],
  ["stimulation / arousal", /\b(?:masturbat|strok|sleeve|arousal|erect|erection|climax|orgasm|ejaculat|edging|stimulation)\b/i],
  ["physiology / telemetry", /\b(?:heart rate|hrv|rmssd|sdnn|respirat|breath|telemetry|blood pressure|spo2|motion|physiology)\b/i],
  ["relationship / dating", /\b(?:date|dating|girlfriend|partner|relationship|woman|women|sex therapist|intercourse)\b/i],
  ["app / technical", /\b(?:app|apk|exe|browser|error|timeout|bug|settings|build|release|video|sync|server)\b/i],
]);

const SUBJECT_CHANGE_PATTERN = /\b(?:anyway|different subject|change(?:ing)? (?:the )?subject|moving on|separately|new question|instead|forget that|back to)\b/i;
const DEFER_TOPIC_PATTERN = /\b(?:come back to (?:this|that) later|return to (?:this|that) later|park (?:this|that)|save (?:this|that) for later|remind me about (?:this|that))\b/i;
const RESUME_TOPIC_PATTERN = /\b(?:back to|return(?:ing)? to|resume|pick back up)\b/i;
const LONG_FORM_PATTERN = /\b(?:very long|long[- ]form|detailed|step[- ]by[- ]step|deep dive|thorough|comprehensive|everything you know|compare)\b/i;
const EVIDENCE_PATTERN = /\b(?:data|evidence|measured|timeline|timestamp|session|record|compare|heart rate|hrv|physiology|when did|what happened)\b/i;
const DIRECT_REQUEST_PATTERN = /^(?:please\s+)?(?:tell|give|show|explain|summarize|compare|write|make|find|check|look|remind|can you|could you|would you)\b/i;

function clean(value, max = 1200) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, max);
}

export function tokenizeConversationText(value = "") {
  return [...new Set(
    clean(value, 6000)
      .toLowerCase()
      .match(/[a-z0-9][a-z0-9'-]{2,}/g)
      ?.filter((token) => !STOP_WORDS.has(token)) || [],
  )];
}

export function inferConversationTopic(message = "") {
  const text = clean(message, 4000);
  for (const [label, pattern] of TOPIC_GROUPS) {
    if (pattern.test(text)) return label;
  }
  const tokens = tokenizeConversationText(text).slice(0, 4);
  return tokens.length ? tokens.join(" / ") : "general conversation";
}

function inferKnownConversationTopic(message = "") {
  const text = clean(message, 4000);
  return TOPIC_GROUPS.find(([, pattern]) => pattern.test(text))?.[0] || "";
}

function topicSimilarity(left = "", right = "") {
  const a = new Set(tokenizeConversationText(left));
  const b = new Set(tokenizeConversationText(right));
  if (!a.size || !b.size) return 0;
  const overlap = [...a].filter((token) => b.has(token)).length;
  return overlap / Math.max(a.size, b.size);
}

export function updateConversationTopicState(existing = {}, message = "", now = new Date().toISOString()) {
  let currentTopic = inferConversationTopic(message);
  const priorTopic = clean(existing.currentTopic, 160);
  const deferredThreads = Array.isArray(existing.deferredThreads) ? [...existing.deferredThreads] : [];
  const isDeferring = DEFER_TOPIC_PATTERN.test(message);
  if (isDeferring && priorTopic && !deferredThreads.includes(priorTopic)) {
    deferredThreads.unshift(priorTopic);
  }
  if (!isDeferring && RESUME_TOPIC_PATTERN.test(message) && !inferKnownConversationTopic(message) && deferredThreads.length) {
    currentTopic = deferredThreads.shift();
  }
  const explicitChange = SUBJECT_CHANGE_PATTERN.test(message);
  const changed = Boolean(priorTopic) && (explicitChange || (
    currentTopic !== "general conversation"
    && priorTopic !== currentTopic
    && topicSimilarity(priorTopic, currentTopic) < 0.35
  ));
  const previousTopics = [
    ...(changed && priorTopic ? [priorTopic] : []),
    ...(Array.isArray(existing.previousTopics) ? existing.previousTopics : []),
  ].filter((topic, index, values) => topic && values.indexOf(topic) === index).slice(0, 8);

  return {
    ...existing,
    currentTopic: currentTopic === "general conversation" && priorTopic && !explicitChange
      ? priorTopic
      : currentTopic,
    candidateTopic: currentTopic,
    topicChanged: changed,
    previousTopics,
    deferredThreads: deferredThreads.slice(0, 8),
    lastUserIntent: clean(message, 500),
    updatedAt: now,
  };
}

export function extractExplicitCorrection(message = "") {
  const text = clean(message, 1600);
  if (!text) return null;
  const patterns = [
    /\b(?:you (?:said|thought|called it)|sarah (?:said|thought|called it))\s+(.{3,180}?)\s*,?\s+but\s+(?:it (?:was|is)|that (?:was|is))\s+(.{3,220}?)(?:[.!?]|$)/i,
    /\b(?:no|actually)[,:\s]+(?:it (?:was|is)|that (?:was|is))\s+(.{3,220}?)\s*,?\s+not\s+(.{3,180}?)(?:[.!?]|$)/i,
    /\bnot\s+(.{3,160}?)\s*[,;]\s*(?:it (?:was|is)|that (?:was|is)|instead)\s+(.{3,220}?)(?:[.!?]|$)/i,
  ];
  for (let index = 0; index < patterns.length; index += 1) {
    const match = text.match(patterns[index]);
    if (!match) continue;
    const reversed = index === 1;
    const rejected = clean(reversed ? match[2] : match[1], 240);
    const accepted = clean(reversed ? match[1] : match[2], 300);
    if (!rejected || !accepted || rejected.toLowerCase() === accepted.toLowerCase()) continue;
    return { rejected, accepted, confidence: 0.98, source: "explicit_user_correction" };
  }
  return null;
}

function memoryTimestamp(memory = {}) {
  const value = new Date(memory.updatedAt || memory.updated_date || memory.createdAt || memory.created_date || 0).getTime();
  return Number.isFinite(value) ? value : 0;
}

export function scoreMemoryRelevance(memory = {}, message = "", nowMs = Date.now()) {
  if (memory.active === false) return -Infinity;
  const query = new Set(tokenizeConversationText(message));
  const memoryTokens = new Set(tokenizeConversationText([
    memory.subject,
    memory.predicate,
    memory.value,
    memory.accepted,
    memory.rejected,
    ...(Array.isArray(memory.tags) ? memory.tags : []),
  ].filter(Boolean).join(" ")));
  const overlap = [...query].filter((token) => memoryTokens.has(token)).length;
  const lexical = query.size ? overlap / query.size : 0;
  const ageDays = Math.max(0, (nowMs - memoryTimestamp(memory)) / 86_400_000);
  const recency = Math.max(0, 1 - ageDays / 180);
  const kindBoost = memory.kind === "correction" ? 1.1
    : memory.kind === "preference" || memory.kind === "language" ? 0.7
      : 0.35;
  const confidence = Math.max(0, Math.min(1, Number(memory.confidence) || 0.5));
  return lexical * 4 + recency * 0.6 + kindBoost + confidence * 0.5;
}

export function selectRelevantMemories(memories = [], message = "", options = {}) {
  const limit = Math.max(1, Math.min(30, Number(options.limit) || 12));
  const nowMs = Number(options.nowMs) || Date.now();
  return memories
    .map((memory) => ({ memory, score: scoreMemoryRelevance(memory, message, nowMs) }))
    .filter(({ score }) => Number.isFinite(score) && score >= 0.65)
    .sort((a, b) => b.score - a.score || memoryTimestamp(b.memory) - memoryTimestamp(a.memory))
    .slice(0, limit)
    .map(({ memory, score }) => ({ ...memory, relevanceScore: Math.round(score * 100) / 100 }));
}

export function normalizeEvidenceClass(value = "") {
  const normalized = clean(value, 80).toLowerCase().replace(/[_-]+/g, " ");
  if (/measured|sensor|telemetry/.test(normalized)) return "measured";
  if (/visual|observed|frame|video/.test(normalized)) return "visually observed";
  if (/reported|user|note/.test(normalized)) return "user reported";
  if (/estimate|inference|derived/.test(normalized)) return "estimated";
  return "unsupported";
}

export function buildResponsePlan({
  message = "",
  topicState = {},
  mode = "profile",
  hasVisualEvidence = false,
  questionFrequency = 35,
} = {}) {
  const text = clean(message, 6000);
  const longForm = LONG_FORM_PATTERN.test(text);
  const needsEvidence = EVIDENCE_PATTERN.test(text);
  const directRequest = DIRECT_REQUEST_PATTERN.test(text);
  const topicChanged = Boolean(topicState.topicChanged);
  const routeTier = hasVisualEvidence || longForm || needsEvidence ? "deep" : "fast";
  const questionsEnabled = Number(questionFrequency) > 0;
  return {
    routeTier,
    responseLength: longForm ? "long" : directRequest ? "focused" : "conversational",
    needsEvidence,
    topicChanged,
    allowFollowUp: questionsEnabled && !directRequest && !longForm,
    maxFollowUpQuestions: questionsEnabled && !directRequest && !longForm ? 1 : 0,
    exploreNewThread: mode !== "profile" && !topicChanged && !directRequest,
    maxTokens: longForm ? 5200 : routeTier === "deep" ? 3600 : 2200,
  };
}

export function buildConversationIntelligencePrompt({
  topicState = {},
  plan = {},
  memories = [],
  evidence = [],
  languageProfile = {},
} = {}) {
  const lines = [
    "SARAH CONVERSATION CONTROL:",
    `- Current topic: ${topicState.currentTopic || "general conversation"}.`,
    topicState.topicChanged
      ? `- The user changed subjects. Follow the new topic now; preserve "${topicState.previousTopics?.[0] || "the prior topic"}" only as a resumable thread.`
      : "- Continue the current topic only while it serves the newest message.",
    `- Response shape: ${plan.responseLength || "conversational"}; follow-up questions allowed: ${plan.maxFollowUpQuestions ?? 1}.`,
    "- Corrections outrank older observations. Never repeat a rejected interpretation as fact.",
    "- Use retrieved evidence only when relevant to the newest message. Do not dump the user's history.",
    "- Keep measured, visually observed, user-reported, estimated, and unsupported claims distinct.",
  ];

  if (memories.length) {
    lines.push("", "RELEVANT VERIFIED MEMORY:");
    for (const memory of memories) {
      if (memory.kind === "correction") {
        lines.push(`- CORRECTION: avoid "${clean(memory.rejected, 240)}"; use "${clean(memory.accepted || memory.value, 320)}".`);
      } else {
        lines.push(`- ${String(memory.kind || "fact").toUpperCase()} (${normalizeEvidenceClass(memory.evidenceClass)}; confidence ${Number(memory.confidence || 0.5).toFixed(2)}): ${clean(memory.value, 420)}`);
      }
    }
  }

  if (evidence.length) {
    lines.push("", "RETRIEVED STRUCTURED EVIDENCE:");
    for (const item of evidence) {
      lines.push(`- [${normalizeEvidenceClass(item.evidenceClass)}] ${clean(item.text, 700)}`);
    }
  }

  const liked = Array.isArray(languageProfile.likedPhrases) ? languageProfile.likedPhrases.filter(Boolean).slice(0, 10) : [];
  const disliked = Array.isArray(languageProfile.dislikedPhrases) ? languageProfile.dislikedPhrases.filter(Boolean).slice(0, 10) : [];
  if (liked.length || disliked.length || languageProfile.styleNotes) {
    lines.push("", "PERSONAL LANGUAGE PROFILE:");
    if (liked.length) lines.push(`- Natural language Ben likes: ${liked.join(" | ")}`);
    if (disliked.length) lines.push(`- Avoid these phrases or habits: ${disliked.join(" | ")}`);
    if (languageProfile.styleNotes) lines.push(`- Style note: ${clean(languageProfile.styleNotes, 800)}`);
  }
  lines.push(`- Warmth target: ${Math.max(0, Math.min(100, Number(languageProfile.warmth) || 70))}/100; do not fake enthusiasm.`);
  lines.push(`- Follow-up question frequency preference: ${Math.max(0, Math.min(100, Number(languageProfile.questionFrequency) || 35))}/100. The response plan above still takes priority.`);

  return lines.join("\n");
}
