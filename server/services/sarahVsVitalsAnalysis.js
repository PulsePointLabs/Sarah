const ANALYSIS_SCHEMA_VERSION = 'sarah.vitals.analysis.v2';

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function compactTrend(rows = [], maxPoints = 240) {
  const source = Array.isArray(rows) ? rows : [];
  if (source.length <= maxPoints) return source;
  const step = (source.length - 1) / (maxPoints - 1);
  return Array.from({ length: maxPoints }, (_value, index) => source[Math.round(index * step)]);
}

function cleanEvent(event = {}) {
  return {
    timestampUtc: event.timestampUtc || null,
    elapsedSeconds: finite(event.elapsedSeconds),
    label: event.label || event.type || 'Event',
    type: event.type || null,
    note: event.note || '',
    heartRateAtEvent: {
      currentBpm: finite(event.heartRateAtEvent?.currentBpm),
      averageBpmSoFar: finite(event.heartRateAtEvent?.averageBpmSoFar),
      maxBpmSoFar: finite(event.heartRateAtEvent?.maxBpmSoFar),
    },
    linkedBloodPressure: event.linkedBloodPressure ? cleanBloodPressure(event.linkedBloodPressure) : null,
  };
}

function cleanBloodPressure(reading = {}) {
  const systolic = finite(reading.systolic);
  const diastolic = finite(reading.diastolic);
  return {
    timestampUtc: reading.timestampUtc || null,
    systolic,
    diastolic,
    meanArterialPressure: finite(reading.meanArterialPressure),
    pulsePressure: systolic != null && diastolic != null ? systolic - diastolic : null,
    pulse: finite(reading.pulse),
    bodyPosition: reading.bodyPosition || null,
    notes: reading.notes || '',
  };
}

export function buildVitalsAnalysisInput(transfer = {}) {
  const payload = transfer.payload || {};
  const session = payload.session || payload.latestWindow || {};
  const events = Array.isArray(payload.events)
    ? payload.events
    : Array.isArray(session.events) ? session.events : [];
  const bloodPressure = Array.isArray(payload.bloodPressureReadings)
    ? payload.bloodPressureReadings
    : Array.isArray(session.bloodPressureReadings) ? session.bloodPressureReadings : [];
  const trend = compactTrend(payload.heartRateTrend).map((row) => ({
    timestampUtc: row.timestampUtc || null,
    elapsedSeconds: finite(row.elapsedSeconds),
    heartRateBpm: finite(row.heartRateBpm),
    smoothedBpm: finite(row.smoothedBpm),
    connectionStatus: row.connectionStatus || null,
  }));

  return {
    source: 'SarahVS',
    transferId: transfer.id,
    importedAt: transfer.imported_at || null,
    exportedAtUtc: transfer.exported_at_utc || payload.exportedAtUtc || null,
    timezone: payload.deviceTimezone || null,
    scope: payload.scope || transfer.scope || null,
    session: {
      sessionId: session.sessionId || null,
      title: session.title || transfer.latest_session_title || 'SarahVS session',
      status: session.status || null,
      startedAtUtc: session.startedAtUtc || null,
      durationSeconds: finite(session.durationSeconds),
      notes: session.notes || '',
      heartRate: session.heartRate || {},
      hrv: session.hrv || {},
      rawStreams: session.rawStreams || {},
    },
    events: events.map(cleanEvent),
    bloodPressureReadings: bloodPressure.map(cleanBloodPressure),
    connectionGaps: Array.isArray(payload.connectionGaps) ? payload.connectionGaps : [],
    heartRateTrend: trend,
    trendSummary: payload.trendSummary || null,
    humanSummary: payload.humanSummary || transfer.summary || '',
  };
}

export function buildVitalsAnalysisPrompt(transfer = {}) {
  const input = buildVitalsAnalysisInput(transfer);
  return `You are Sarah, reviewing one imported SarahVS physiological session for Ben.

Write a clinically literate but personal interpretation. Sound like a trusted, candid companion who understands physiology, not a generic report generator. Lead with what the data directly show, then clearly label plausible interpretations. Correlate event notes with the vital signs at those moments and with the later trend. Discuss HRV only to the degree supported by its quality and available metrics. Treat symptoms, nicotine, caffeine, cannabis, medication, exertion, position, and blood pressure as context when documented, never as proven causes.

Provenance boundary:
- This record is a SarahVS vital-sign recording or transfer. It is not evidence that a PulsePoint sexual, masturbation, arousal, or observed behavioral session occurred.
- Imported session notes and event notes are user-entered context only. Never describe them as observed actions and never infer sexual activity from medication, symptoms, timing, heart rate, or a note.
- Mention sexual activity only when an event note explicitly says it occurred, and then attribute it to the user's note rather than to observation.

Requirements:
- Explain the overall cardiovascular arc in plain English.
- Call out notable peaks, recoveries, sustained changes, and event-linked changes using timestamps or elapsed times.
- Include blood-pressure context with MAP and pulse pressure when present.
- Explain signal quality, gaps, and important limitations briefly and specifically.
- Do not invent ECG findings, diagnoses, arrhythmias, respiratory measurements, or causal certainty.
- Keep the personal_read warm and direct, while clinical_summary remains concise and clinically organized.
- Write narration-ready prose: spell out numbers and durations, use natural clock times, and expand abbreviations such as HR, HRV, BP, RR, MAP, PP, bpm, mmHg, min, and sec.
- Return useful prose, not a metric dump.

SESSION DATA:
${JSON.stringify(input)}`;
}

export const VITALS_ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    headline: { type: 'string' },
    clinical_summary: { type: 'string' },
    personal_read: { type: 'string' },
    cardiovascular_arc: { type: 'string' },
    hrv_read: { type: 'string' },
    blood_pressure_read: { type: 'string' },
    recovery_read: { type: 'string' },
    data_quality: { type: 'string' },
    notable_findings: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          detail: { type: 'string' },
          evidence: { type: 'string' },
        },
        required: ['title', 'detail', 'evidence'],
      },
    },
    event_correlations: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          time: { type: 'string' },
          event: { type: 'string' },
          physiology: { type: 'string' },
          interpretation: { type: 'string' },
        },
        required: ['time', 'event', 'physiology', 'interpretation'],
      },
    },
    takeaways: { type: 'array', items: { type: 'string' } },
  },
  required: [
    'headline',
    'clinical_summary',
    'personal_read',
    'cardiovascular_arc',
    'hrv_read',
    'blood_pressure_read',
    'recovery_read',
    'data_quality',
    'notable_findings',
    'event_correlations',
    'takeaways',
  ],
};

export function wrapVitalsAnalysis(result, { model = 'claude-sonnet-4-6', generatedAt = new Date().toISOString(), transfer } = {}) {
  return {
    schema_version: ANALYSIS_SCHEMA_VERSION,
    generated_at: generatedAt,
    model,
    source_exported_at_utc: transfer?.exported_at_utc || transfer?.payload?.exportedAtUtc || null,
    ...result,
  };
}

export function isCurrentVitalsAnalysis(analysis) {
  return analysis?.schema_version === ANALYSIS_SCHEMA_VERSION;
}
