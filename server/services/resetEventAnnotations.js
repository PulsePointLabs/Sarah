import fs from 'node:fs';
import path from 'node:path';
import { db, getEntity, listEntities, upsertEntity } from '../db.js';
import { uploadDirs, dataDir } from '../config.js';
import { purgeJobsByMeta } from './jobQueue.js';

export function clearedAnnotationRecord(record, field) {
  const analysis = { ...(record[field] || {}) };
  for (const key of Object.keys(analysis)) {
    if (key.startsWith('_manual_annotation_visual_reviews') || key.startsWith('_video_pass_')
      || ['ai_audio_passes', 'cloud_multimodal_passes', 'cloud_multimodal_latest_id', 'cloud_multimodal_updated_at'].includes(key)) delete analysis[key];
  }
  return { ...record, event_timeline: [], [field]: analysis };
}

export function annotationJobForRecord(job, id, entity) {
  if (String(job.meta?.sessionId || job.payload?.recordId || '') !== String(id)) return false;
  const recordType = job.meta?.recordType || job.payload?.recordType;
  if (recordType && (recordType === 'body_exploration') !== (entity === 'BodyExploration')) return false;
  return job.type === 'manual_annotation_visual_review'
    || (job.type === 'ai_invoke' && ['ai_video_pass', 'ai_audio_pass'].includes(job.meta?.source))
    || (job.type === 'cloud_multimodal_analysis' && job.meta?.source === 'AIVideoPassPanel')
    || String(job.type).startsWith('local_vision_');
}

export function annotationMediaNames(value) {
  // Only generated annotation media, never arbitrary local source paths.
  const text = JSON.stringify(value);
  return [...new Set(text.match(/(?:annotation-evidence-[\w-]+\.jpg|clip-preview-v3-[\w.-]+\.(?:jpg|mp4|wav))/g) || [])];
}

export function resetEventAnnotations(entity, id) {
  if (!['Session', 'BodyExploration'].includes(entity)) throw Object.assign(new Error('Only session annotations can be reset.'), { status: 400 });
  const record = getEntity(entity, id);
  if (!record) throw Object.assign(new Error('Session not found.'), { status: 404 });
  const jobs = listEntities('ProcessingJob').filter(job => annotationJobForRecord(job, id, entity));
  if (jobs.some(job => ['queued', 'running'].includes(job.status))) {
    throw Object.assign(new Error('Stop the running annotation/review jobs for this session before clearing annotations, so they cannot repopulate the timeline.'), { status: 409 });
  }
  const field = entity === 'BodyExploration' ? 'ai_body_exploration' : 'ai_analysis';
  const next = clearedAnnotationRecord(record, field);
  const recordType = entity === 'BodyExploration' ? 'body_exploration' : 'session';
  const localResults = db.prepare('SELECT result_json FROM local_vision_results WHERE session_id = ? AND record_type = ?').all(id, recordType);
  const candidates = annotationMediaNames([record.event_timeline, record[field], jobs, localResults]);
  db.transaction(() => {
    upsertEntity(entity, id, { ...next, updated_date: new Date().toISOString() });
    db.prepare('DELETE FROM local_vision_results WHERE session_id = ? AND record_type = ?').run(id, recordType);
    purgeJobsByMeta({ ids: jobs.map(job => job.id) });
  })();
  let deletedFiles = 0;
  const cleanupFailures = [];
  const referenced = db.prepare('SELECT 1 FROM entities WHERE instr(data, ?) > 0 LIMIT 1');
  for (const filename of candidates) {
    if (referenced.get(filename) || db.prepare('SELECT 1 FROM local_vision_results WHERE instr(result_json, ?) > 0 LIMIT 1').get(filename)) continue;
    for (const directory of uploadDirs) {
      const target = path.resolve(directory, filename);
      if (path.dirname(target) !== path.resolve(directory)) continue;
      try { if (fs.existsSync(target)) { fs.unlinkSync(target); deletedFiles++; } }
      catch { cleanupFailures.push(filename); }
    }
  }
  for (const job of jobs) {
    const ref = job.meta?.payload_ref || job.payload?.__payloadRef;
    if (!ref || !/^[a-zA-Z0-9_-]+$/.test(ref) || referenced.get(ref)) continue;
    try { fs.rmSync(path.join(dataDir, 'job-payloads', `${ref}.json`), { force: true }); }
    catch { cleanupFailures.push(`job payload ${ref}`); }
  }
  return { record: getEntity(entity, id), removedEvents: (record.event_timeline || []).length, deletedFiles, cleanupFailures };
}
