import { getEntity, listEntitiesByExactCriteria } from '../../db.js';
import { buildCloudAnalysisPreflight } from './manifest.js';

function exactRows(entity, sessionId) {
  return listEntitiesByExactCriteria(entity, { session: sessionId }) || [];
}

function attachedRows(record, field) {
  return Array.isArray(record?.[field]) ? record[field].filter(Boolean) : [];
}

export async function prepareCloudAnalysisPreflight({ sessionId, recordType = 'session' } = {}) {
  const normalizedType = recordType === 'body_exploration' ? 'body_exploration' : 'session';
  const entity = normalizedType === 'body_exploration' ? 'BodyExploration' : 'Session';
  const record = getEntity(entity, String(sessionId || '').trim());
  if (!record) {
    const error = new Error(`${entity} record was not found.`);
    error.status = 404;
    throw error;
  }

  return buildCloudAnalysisPreflight({
    record,
    recordType: normalizedType,
    videos: record.linked_local_videos || [],
    heartRateRows: exactRows('HeartRateTimeline', record.id),
    emgRows: exactRows('EMGTimeline', record.id),
    howlCommands: exactRows('HowlControlCommand', record.id),
    bloodPressureRows: attachedRows(record, 'blood_pressure_readings'),
    pulseOxRows: attachedRows(record, 'pulse_ox_readings'),
  });
}

