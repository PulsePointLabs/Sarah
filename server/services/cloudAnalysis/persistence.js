import { getEntity, upsertEntity } from '../../db.js';

export function buildCloudAnalysisRecordUpdate(record = {}, {
  recordType = 'session',
  result = {},
  sourceVideo = {},
  savedAt = new Date().toISOString(),
} = {}) {
  if (!result?.ok || !result?.id) throw new Error('A successful fused cloud-analysis result is required.');
  const analysisField = recordType === 'body_exploration' ? 'ai_body_exploration' : 'ai_analysis';
  const existingAnalysis = record?.[analysisField] && typeof record[analysisField] === 'object'
    ? record[analysisField]
    : {};
  const entry = {
    id: result.id,
    saved_at: savedAt,
    source_video: {
      asset_id: sourceVideo.asset_id || null,
      filename: sourceVideo.filename || null,
      role: sourceVideo.role || 'unknown',
      fingerprint: sourceVideo.fingerprint || null,
      source_zero_session_ms: Number(sourceVideo.source_zero_session_ms || 0),
    },
    result,
  };
  const prior = Array.isArray(existingAnalysis.cloud_multimodal_passes)
    ? existingAnalysis.cloud_multimodal_passes
    : [];
  const passes = [entry, ...prior.filter((item) => item?.id !== entry.id)].slice(0, 5);
  return {
    analysisField,
    analysis: {
      ...existingAnalysis,
      cloud_multimodal_passes: passes,
      cloud_multimodal_latest_id: entry.id,
      cloud_multimodal_updated_at: savedAt,
    },
    entry,
  };
}

export function persistCloudAnalysisResult({ sessionId, recordType = 'session', result, sourceVideo } = {}) {
  const normalizedType = recordType === 'body_exploration' ? 'body_exploration' : 'session';
  const entity = normalizedType === 'body_exploration' ? 'BodyExploration' : 'Session';
  const record = getEntity(entity, String(sessionId || '').trim());
  if (!record) throw new Error(`${entity} record was not found while saving cloud analysis.`);
  const update = buildCloudAnalysisRecordUpdate(record, {
    recordType: normalizedType,
    result,
    sourceVideo,
  });
  const saved = upsertEntity(entity, record.id, { [update.analysisField]: update.analysis });
  return { saved, entry: update.entry, analysisField: update.analysisField };
}
