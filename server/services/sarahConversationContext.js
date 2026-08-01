import crypto from 'node:crypto';
import { getEntity, listEntities, upsertEntity } from '../db.js';
import {
  buildConversationIntelligencePrompt,
  buildResponsePlan,
  extractExplicitCorrection,
  selectRelevantMemories,
  tokenizeConversationText,
  updateConversationTopicState,
} from '../../src/lib/sarahConversationIntelligence.js';
import {
  buildProcedurePhysiologyContext,
  isProcedurePhysiologyRecord,
} from '../../src/lib/procedurePhysiologyContext.js';
import { sessionContextEvidenceText } from '../../src/lib/sessionContext.js';

const PROCEDURE_QUERY = /\b(?:catheter|foley|urethr|sound(?:ing)?|dilat|hegar|enema|rectal|anal|anus|probe|insertion|depth)\b/i;
const MEDICATION_QUERY = /\b(?:medication|medicine|meds|dose|drug|thca|cannabis|nicotine|alcohol|substance)\b/i;
const VITALS_QUERY = /\b(?:vital|physiolog|blood glucose|glucose|blood sugar|glyc|spo2|sp02|oxygen saturation|pulse ox|oximetry|blood pressure|heart rate|hrv|rmssd|rr interval|respirat|breath|body composition|weight)\b/i;

function clean(value, max = 900) {
  return String(value || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

function dateValue(record = {}) {
  const exact = record.capture_started_at || record.created_date || record.updated_date;
  if (exact) {
    const exactValue = new Date(exact).getTime();
    if (Number.isFinite(exactValue)) return exactValue;
  }
  const date = clean(record.date, 40).slice(0, 10);
  const time = clean(record.start_time, 12);
  const local = date ? new Date(`${date}T${/^\d{1,2}:\d{2}/.test(time) ? time : '00:00'}:00`).getTime() : NaN;
  if (Number.isFinite(local)) return local;
  const value = new Date(record.date || record.start_time || 0).getTime();
  return Number.isFinite(value) ? value : 0;
}

function temporalReferenceScore(record = {}, message = '', nowInput = Date.now()) {
  const text = String(message || '').toLowerCase();
  const asksLastNight = /\b(?:last night|overnight|around midnight|near midnight|midnight)\b/.test(text);
  const asksRecent = /\b(?:latest|most recent|recent session|last session)\b/.test(text);
  if (!asksLastNight && !asksRecent) return 0;
  const timestamp = dateValue(record);
  if (!timestamp) return 0;
  const now = new Date(nowInput);
  const recorded = new Date(timestamp);
  if (asksRecent) {
    const ageHours = (now.getTime() - recorded.getTime()) / 3_600_000;
    if (ageHours >= -1 && ageHours <= 48) return Math.max(0.2, 1.2 - ageHours / 48);
  }
  if (asksLastNight) {
    const overnightStart = new Date(now);
    overnightStart.setDate(overnightStart.getDate() - 1);
    overnightStart.setHours(18, 0, 0, 0);
    const overnightEnd = new Date(now);
    overnightEnd.setHours(8, 0, 0, 0);
    if (now.getHours() < 8) overnightEnd.setDate(overnightEnd.getDate() + 1);
    if (timestamp >= overnightStart.getTime() && timestamp <= overnightEnd.getTime()) {
      const midnight = new Date(recorded);
      midnight.setHours(0, 0, 0, 0);
      const distanceHours = Math.abs(timestamp - midnight.getTime()) / 3_600_000;
      return Math.max(0.8, 1.6 - Math.min(6, distanceHours) / 10);
    }
  }
  return 0;
}

function recordText(record = {}) {
  const events = Array.isArray(record.event_timeline)
    ? record.event_timeline.map((event) => event?.note || event?.description || event?.label)
    : [];
  return [
    record.title,
    record.exploration_type,
    record.notes,
    record.summary,
    record.methods?.join?.(' '),
    record.medications,
    record.substances,
    sessionContextEvidenceText(record),
    ...events,
  ].filter(Boolean).join(' ');
}

function lexicalScore(record = {}, message = '') {
  const query = new Set(tokenizeConversationText(message));
  if (!query.size) return 0;
  const source = new Set(tokenizeConversationText(recordText(record)));
  return [...query].filter((token) => source.has(token)).length / query.size;
}

function formatEventTime(event = {}) {
  const seconds = Number(event.time_s ?? event.time_offset_s ?? event.offset_s ?? event.timestamp_s);
  if (!Number.isFinite(seconds)) return '';
  const total = Math.max(0, Math.round(seconds));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

export function findRelevantSessionEvidence(records = [], message = '', options = {}) {
  const limit = Math.max(1, Math.min(12, Number(options.limit) || 5));
  const tokens = new Set(tokenizeConversationText(message));
  return records
    .map((record) => {
      const lexical = lexicalScore(record, message);
      const temporal = temporalReferenceScore(record, message, options.now);
      return { record, score: lexical + temporal, temporal };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || dateValue(b.record) - dateValue(a.record))
    .slice(0, limit)
    .flatMap(({ record, score, temporal }) => {
      const date = clean(record.date || record.created_date, 40).slice(0, 10) || 'undated';
      const heading = clean(record.title || record.exploration_type || 'Saved session', 160);
      const methodText = Array.isArray(record.methods) ? clean(record.methods.join(', '), 180) : '';
      const eventCount = Array.isArray(record.event_timeline) ? record.event_timeline.length : 0;
      const output = [{
        evidenceClass: 'user reported',
        sourceType: record.__entity || 'session',
        sourceId: record.id,
        relevance: score,
        text: `${date}${record.start_time ? ` ${clean(record.start_time, 12)}` : ''} ${heading}: ${clean(record.notes || record.summary || 'saved record', 520)}${methodText ? ` Methods: ${methodText}.` : ''} ${eventCount} saved timeline events.${temporal > 0 ? ' Retrieved from the user’s relative time reference.' : ''}`,
      }];
      const matchingEvents = (Array.isArray(record.event_timeline) ? record.event_timeline : [])
        .map((event) => ({
          event,
          note: clean(event?.note || event?.description || event?.label, 420),
        }))
        .filter(({ note }) => {
          const eventTokens = tokenizeConversationText(note);
          return eventTokens.some((token) => tokens.has(token));
        })
        .slice(0, 4);
      for (const { event, note } of matchingEvents) {
        output.push({
          evidenceClass: event?.source === 'ai_video_pass' ? 'visually observed' : 'user reported',
          sourceType: 'timeline_event',
          sourceId: record.id,
          relevance: score + 0.25,
          text: `${date} ${heading}${formatEventTime(event) ? ` at ${formatEventTime(event)}` : ''}: ${note}`,
        });
      }
      return output;
    })
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, limit + 4);
}

function profileMemories(user = {}) {
  const memories = [];
  const add = (subject, predicate, value, tags = []) => {
    if (!value) return;
    memories.push({
      id: `profile:${subject}:${predicate}`,
      kind: 'fact',
      subject,
      predicate,
      value: clean(value, 700),
      tags,
      evidenceClass: 'user reported',
      confidence: 0.95,
      updatedAt: user.updated_date || user.created_date,
      active: true,
    });
  };
  add('Ben', 'arousal response style', user.arousal_response_style, ['arousal', 'response']);
  add('Ben', 'climax sensitivity', user.climax_sensitivity, ['climax', 'orgasm']);
  add('Ben', 'refractory pattern', user.refractory_pattern, ['recovery', 'refractory']);
  add('Ben', 'preferred stimulation', user.preferred_stimulation?.join?.(', '), ['stimulation', 'preference']);
  add('Ben', 'arousal notes', user.arousal_notes, ['arousal', 'profile']);
  for (const item of (Array.isArray(user.profile_qa_findings) ? user.profile_qa_findings : []).slice(0, 24)) {
    const value = item?.finding || item?.findings?.join?.('; ');
    add('Ben', 'verified profile finding', value, ['verified', 'profile']);
  }
  return memories;
}

function correctionMemories() {
  return listEntities('AICorrectionMemory').map((item) => ({
    id: `annotation:${item.id}`,
    kind: 'correction',
    rejected: item.before,
    accepted: item.after,
    value: item.after,
    subject: item.context || item.recordType,
    tags: [item.recordType, item.context].filter(Boolean),
    evidenceClass: 'user reported',
    confidence: 0.98,
    updatedAt: item.createdAt || item.created_date,
    active: true,
  }));
}

function procedureEvidence(message = '') {
  if (!PROCEDURE_QUERY.test(message)) return [];
  const records = [
    ...listEntities('Session'),
    ...listEntities('BodyExploration'),
  ].filter(isProcedurePhysiologyRecord);
  const ids = new Set(records.map((record) => record.id));
  const rowsBySession = {};
  for (const row of listEntities('HeartRateTimeline')) {
    if (!ids.has(row.session)) continue;
    if (!rowsBySession[row.session]) rowsBySession[row.session] = [];
    rowsBySession[row.session].push(row);
  }
  const built = buildProcedurePhysiologyContext(records, rowsBySession, {
    recordLimit: 5,
    milestoneLimit: 5,
  });
  if (!built.recordCount) return [];
  return [{
    evidenceClass: 'measured',
    sourceType: 'procedure_physiology',
    sourceId: 'procedure-physiology',
    relevance: 2,
    text: built.context,
  }];
}

function medicationEvidence(user = {}, records = [], message = '') {
  if (!MEDICATION_QUERY.test(message)) return [];
  const values = [
    user.medications,
    user.substance_notes,
    ...records.slice(0, 8).map((record) => record.medications || record.substances || record.substance_use),
  ].flat().filter(Boolean);
  return values.length ? [{
    evidenceClass: 'user reported',
    sourceType: 'profile_and_session_context',
    sourceId: 'medication-substance-context',
    relevance: 1.5,
    text: `Saved medication/substance context: ${clean(values.join(' | '), 1200)}`,
  }] : [];
}

export function findRelevantVitalEvidence(records = [], message = '', glucoseReadings = [], options = {}) {
  if (!VITALS_QUERY.test(message)) return [];
  const limit = Math.max(1, Math.min(10, Number(options.limit) || 6));
  const sessionEvidence = records
    .map((record) => ({
      record,
      text: sessionContextEvidenceText(record),
    }))
    .filter(({ text }) => text)
    .sort((a, b) => dateValue(b.record) - dateValue(a.record))
    .slice(0, limit)
    .map(({ record, text }) => ({
      evidenceClass: 'measured',
      sourceType: `${record.__entity || 'session'}_vitals`,
      sourceId: record.id,
      relevance: 1.75,
      text: `${clean(record.date || record.created_date, 40).slice(0, 10) || 'undated'} measured session-window context: ${clean(text, 1100)}`,
    }));

  const asksForGlucose = /\b(?:blood glucose|glucose|blood sugar|glyc)\b/i.test(message);
  if (!asksForGlucose) return sessionEvidence;
  const recentGlucose = (Array.isArray(glucoseReadings) ? glucoseReadings : [])
    .filter((reading) => Number.isFinite(Number(reading?.glucose_mg_dl)))
    .sort((a, b) => dateValue(b) - dateValue(a))
    .slice(0, 12);
  if (!recentGlucose.length) return sessionEvidence;
  const history = recentGlucose.map((reading) => {
    const measuredAt = clean(reading.measured_at || reading.date || reading.created_date, 40);
    const meal = clean(reading.meal_tag, 80);
    return `${measuredAt || 'time unavailable'}: ${Math.round(Number(reading.glucose_mg_dl))} mg/dL${meal ? ` (${meal})` : ''}`;
  });
  return [
    ...sessionEvidence,
    {
      evidenceClass: 'measured',
      sourceType: 'blood_glucose_history',
      sourceId: 'recent-blood-glucose',
      relevance: 1.9,
      text: `Recent imported blood glucose history: ${history.join('; ')}`,
    },
  ].slice(0, limit + 1);
}

function persistExplicitCorrection(correction, scopeId, message, now) {
  if (!correction) return null;
  const existing = listEntities('SarahMemory').find((memory) => (
    memory.kind === 'correction'
    && clean(memory.rejected).toLowerCase() === correction.rejected.toLowerCase()
    && clean(memory.accepted || memory.value).toLowerCase() === correction.accepted.toLowerCase()
  ));
  return upsertEntity('SarahMemory', existing?.id || crypto.randomUUID(), {
    kind: 'correction',
    scopeId,
    subject: 'explicit chat correction',
    predicate: 'replace rejected interpretation',
    rejected: correction.rejected,
    accepted: correction.accepted,
    value: correction.accepted,
    source: correction.source,
    sourceText: clean(message, 900),
    evidenceClass: 'user reported',
    confidence: correction.confidence,
    tags: tokenizeConversationText(`${correction.rejected} ${correction.accepted}`).slice(0, 12),
    active: true,
    updatedAt: now,
  });
}

export function prepareSarahConversationContext({
  scopeId = 'profile',
  mode = 'profile',
  message = '',
  history = [],
  hasVisualEvidence = false,
} = {}) {
  const safeScopeId = clean(scopeId, 160) || 'profile';
  const stateId = `${mode}:${safeScopeId}`;
  const now = new Date().toISOString();
  const existingState = getEntity('SarahConversationState', stateId) || {
    id: stateId,
    scopeId: safeScopeId,
    mode,
    currentTopic: '',
    previousTopics: [],
    unresolvedThreads: [],
  };
  const topicState = updateConversationTopicState(existingState, message, now);
  upsertEntity('SarahConversationState', stateId, {
    ...topicState,
    scopeId: safeScopeId,
    mode,
    historyTail: (Array.isArray(history) ? history : []).slice(-6).map((item) => ({
      role: item?.role,
      text: clean(item?.text, 420),
    })),
  });

  const correction = persistExplicitCorrection(
    extractExplicitCorrection(message),
    safeScopeId,
    message,
    now,
  );
  const user = getEntity('User', 'local-user') || {};
  const storedMemories = [
    ...listEntities('SarahMemory'),
    ...correctionMemories(),
    ...profileMemories(user),
  ];
  const memories = selectRelevantMemories(storedMemories, message, { limit: 12 });

  const records = [
    ...listEntities('Session').map((record) => ({ ...record, __entity: 'session' })),
    ...listEntities('BodyExploration').map((record) => ({ ...record, __entity: 'body_exploration' })),
  ].sort((a, b) => dateValue(b) - dateValue(a));
  const evidence = [
    ...findRelevantSessionEvidence(records, message, { limit: 5 }),
    ...procedureEvidence(message),
    ...medicationEvidence(user, records, message),
    ...findRelevantVitalEvidence(records, message, listEntities('BloodGlucoseReading'), { limit: 6 }),
  ].slice(0, 12);
  const languageProfile = getEntity('SarahLanguageProfile', 'default') || {};
  const plan = buildResponsePlan({
    message,
    topicState,
    mode,
    hasVisualEvidence,
    questionFrequency: languageProfile.questionFrequency,
  });
  const promptContext = buildConversationIntelligencePrompt({
    topicState,
    plan,
    memories,
    evidence,
    languageProfile,
  });

  return {
    topicState,
    plan,
    memories,
    evidence,
    languageProfile,
    promptContext,
    savedCorrection: correction,
  };
}

export function readSarahLanguageProfile() {
  return getEntity('SarahLanguageProfile', 'default') || {
    id: 'default',
    likedPhrases: [],
    dislikedPhrases: [],
    styleNotes: '',
    warmth: 70,
    questionFrequency: 35,
  };
}

export function saveSarahLanguageProfile(value = {}) {
  const unique = (items, limit = 16) => [...new Set(
    (Array.isArray(items) ? items : []).map((item) => clean(item, 160)).filter(Boolean),
  )].slice(0, limit);
  return upsertEntity('SarahLanguageProfile', 'default', {
    likedPhrases: unique(value.likedPhrases),
    dislikedPhrases: unique(value.dislikedPhrases),
    styleNotes: clean(value.styleNotes, 1400),
    warmth: Math.max(0, Math.min(100, Number(value.warmth) || 70)),
    questionFrequency: Math.max(0, Math.min(100, Number(value.questionFrequency) || 35)),
  });
}
