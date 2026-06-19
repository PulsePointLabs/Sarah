import { getEntity, listEntities, listProcessingJobSummaries, listRecoverableProcessingJobs, upsertEntity } from '../db.js';

const handlers = new Map();
const jobs = new Map();
const queue = [];
const running = new Set();
const concurrency = Math.max(1, Number(process.env.BACKGROUND_JOB_CONCURRENCY || 3));
const foregroundConcurrency = Math.max(1, Number(process.env.BACKGROUND_JOB_FOREGROUND_CONCURRENCY || 1));

function normalizeJobPriority(value) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  return Math.max(-100, Math.min(100, Math.round(numeric)));
}

function isForegroundJob(job = {}) {
  return Boolean(job?.meta?.foreground || job?.payload?.foreground || job?.payload?.interactive);
}

function jobLane(type, meta = {}, payload = {}) {
  const name = String(type || '');
  if (name === 'ai_invoke' && (meta.foreground || payload.foreground || payload.interactive)) return 'foreground_ai';
  if (name.startsWith('local_vision_')) return 'local_vision';
  if (name === 'ai_invoke' || name === 'profile_image_review_full') return 'ai';
  if (name === 'tts_export' || name === 'session_review_video') return 'tts';
  return 'general';
}

function laneConcurrency(lane) {
  if (lane === 'foreground_ai') return foregroundConcurrency;
  if (lane === 'local_vision') return Math.max(1, Number(process.env.BACKGROUND_JOB_LOCAL_VISION_CONCURRENCY || 1));
  if (lane === 'ai') return Math.max(1, Number(process.env.BACKGROUND_JOB_AI_CONCURRENCY || 2));
  if (lane === 'tts') return Math.max(1, Number(process.env.BACKGROUND_JOB_TTS_CONCURRENCY || 1));
  return Math.max(1, Number(process.env.BACKGROUND_JOB_GENERAL_CONCURRENCY || concurrency));
}

function runningLaneCount(lane) {
  let count = 0;
  for (const id of running) {
    const job = jobs.get(id);
    if (jobLane(job?.type) === lane) count += 1;
  }
  return count;
}

function canStartJob(job) {
  if (!job || job.status !== 'queued') return false;
  const lane = job.lane || jobLane(job.type, job.meta, job.payload);
  const foreground = lane === 'foreground_ai' || isForegroundJob(job);
  const globalLimit = foreground ? concurrency + foregroundConcurrency : concurrency;
  return running.size < globalLimit && runningLaneCount(lane) < laneConcurrency(lane);
}

function nowIso() {
  return new Date().toISOString();
}

function publicJob(job, { includeResult = true } = {}) {
  if (!job) return null;
  const { payload: _payload, abortController: _abortController, ...rest } = job;
  if (!includeResult) {
    const { result: _result, ...summary } = rest;
    return {
      ...summary,
      hasResult: rest.result != null,
    };
  }
  return rest;
}

function isCleared(job) {
  return Boolean(job?.meta?.clearedAt);
}

function persistedJob(job) {
  if (!job) return null;
  const { abortController: _abortController, ...rest } = job;
  return rest;
}

function saveJob(job) {
  if (!job?.id) return;
  upsertEntity('ProcessingJob', job.id, persistedJob(job));
}

function patchJob(job, patch = {}) {
  Object.assign(job, patch, { updatedAt: nowIso() });
  jobs.set(job.id, job);
  saveJob(job);
  return publicJob(job);
}

function patchProgress(job, progress = {}) {
  return patchJob(job, {
    progress: {
      ...(job.progress || {}),
      ...progress,
      updatedAt: nowIso(),
    },
  });
}

function existingAudioExportForUrl(fileUrl = '') {
  const target = String(fileUrl || '').trim();
  if (!target) return null;
  return listEntities('AudioExport').find((record) => String(record?.file_url || '').trim() === target) || null;
}

function persistTtsAudioExport(job, result = {}) {
  if (job?.type !== 'tts_export' || !result?.file_url) return result;
  const existing = existingAudioExportForUrl(result.file_url);
  if (existing?.id) {
    return {
      ...result,
      audio_export_id: existing.id,
      audio_export_recovered: false,
    };
  }

  const payload = job.payload || {};
  const meta = job.meta || {};
  const created = job.finishedAt || nowIso();
  const id = `tts-job-${job.id}`;
  const title = meta.title || payload.title || result.title || 'Completed audio render';
  const saved = upsertEntity('AudioExport', id, {
    id,
    title,
    analysis_title: title,
    file_url: result.file_url,
    duration_seconds: Math.round(Number(result.duration_seconds || 0)),
    voice: result.voice || payload.voice || null,
    speed: Number(result.speed || payload.speed || 1),
    model: result.model || payload.model || null,
    format: result.format || payload.outputFormat || 'mp3',
    render_version: result.render_version || null,
    silence_trim: result.silence_trim || null,
    size: result.size || null,
    filename: result.filename || String(result.file_url).split('/').pop(),
    tts_session_key: meta.sessionId || null,
    session_date: meta.sessionDate || payload.sessionDate || null,
    source_generated_at: meta.sourceGeneratedAt || payload.sourceGeneratedAt || null,
    exported_at: created,
    has_chapters: Boolean(result.has_chapters),
    chapter_format: result.chapter_format || 'sidecar',
    chapter_count: Number(result.chapter_count || 0),
    chapter_source: result.chapter_source || 'tts_export',
    chapter_generated_at: result.chapter_generated_at || null,
    chapters_embedded: Boolean(result.chapters_embedded),
    sidecar_chapters_available: Boolean(result.sidecar_chapters_available),
    chapter_json_url: result.chapter_json_url || null,
    chapter_cue_url: result.chapter_cue_url || null,
    chapter_txt_url: result.chapter_txt_url || null,
    audio_content_version: meta.sourceGeneratedAt || payload.sourceGeneratedAt || null,
    recovered_from_job_id: job.id,
    notes: 'Saved automatically from completed background audio render.',
    created_date: created,
  });

  return {
    ...result,
    audio_export_id: saved.id,
    audio_export_recovered: true,
  };
}

function compareQueuedJobs(a, b) {
  const priorityDelta = normalizeJobPriority(b?.priority) - normalizeJobPriority(a?.priority);
  if (priorityDelta) return priorityDelta;
  return new Date(a?.createdAt || 0) - new Date(b?.createdAt || 0);
}

function enqueueJob(job) {
  queue.push(job);
  queue.sort(compareQueuedJobs);
}

function runNext() {
  while (queue.length > 0) {
    queue.sort(compareQueuedJobs);
    const queueIndex = queue.findIndex((candidate) => canStartJob(candidate));
    if (queueIndex < 0) return;
    const [job] = queue.splice(queueIndex, 1);
    if (!job || job.status !== 'queued') continue;
    const handler = handlers.get(job.type);
    if (!handler) {
      patchJob(job, {
        status: 'error',
        error: `No background job handler registered for ${job.type}`,
        payload: null,
        finishedAt: nowIso(),
      });
      continue;
    }

    running.add(job.id);
    patchJob(job, {
      status: 'running',
      lane: job.lane || jobLane(job.type, job.meta, job.payload),
      startedAt: nowIso(),
    });
    patchProgress(job, {
      phase: 'running',
      message: job.progress?.message || 'Starting background job...',
    });

    Promise.resolve()
      .then(() => handler(job.payload, {
        jobId: job.id,
        signal: job.abortController.signal,
        updateProgress: (progress) => patchProgress(job, progress),
      }))
      .then((result) => {
        const existingProgress = job.progress || {};
        const total = Number(existingProgress.total || 0);
        const keepCompletionMessage =
          existingProgress.phase === 'complete' &&
          existingProgress.message;
        const finalResult = persistTtsAudioExport(job, result);
        patchJob(job, {
          status: 'complete',
          result: finalResult,
          error: null,
          payload: null,
          finishedAt: nowIso(),
        });
        patchProgress(job, {
          phase: 'complete',
          ...(total > 0 ? { current: total, total } : {}),
          message: keepCompletionMessage || 'Complete',
        });
      })
      .catch((error) => {
        const cancelled = job.abortController.signal.aborted;
        patchJob(job, {
          status: cancelled ? 'cancelled' : 'error',
          error: cancelled ? 'Cancelled' : (error?.message || String(error)),
          payload: null,
          finishedAt: nowIso(),
        });
        patchProgress(job, {
          phase: cancelled ? 'cancelled' : 'error',
          message: cancelled ? 'Cancelled' : (error?.message || String(error)),
        });
      })
      .finally(() => {
        running.delete(job.id);
        runNext();
      });
  }
}

export function registerJobHandler(type, handler) {
  if (!type || typeof handler !== 'function') throw new Error('registerJobHandler requires type and handler');
  handlers.set(type, handler);
}

export function createJob(type, payload = {}, meta = {}) {
  if (!handlers.has(type)) throw new Error(`Unknown background job type: ${type}`);
  const id = crypto.randomUUID();
  const now = nowIso();
  const priority = normalizeJobPriority(meta?.priority ?? payload?.priority);
  const job = {
    id,
    type,
    status: 'queued',
    progress: {
      phase: 'queued',
      current: 0,
      total: 0,
      message: 'Queued',
      updatedAt: now,
    },
    result: null,
    error: null,
    meta: {
      ...meta,
      priority,
    },
    priority,
    lane: jobLane(type, meta, payload),
    payload,
    createdAt: now,
    updatedAt: now,
    startedAt: null,
    finishedAt: null,
    abortController: new AbortController(),
  };
  jobs.set(id, job);
  saveJob(job);
  enqueueJob(job);
  queueMicrotask(runNext);
  return publicJob(job);
}

function hydratePersistedJob(record) {
  if (!record?.id) return null;
  return {
    ...record,
    priority: normalizeJobPriority(record.priority ?? record.meta?.priority),
    lane: record.lane || jobLane(record.type, record.meta, record.payload),
    payload: record.payload || null,
    abortController: new AbortController(),
  };
}

export function restorePersistedJobs() {
  const recoverable = listRecoverableProcessingJobs();

  for (const record of recoverable) {
    const handler = handlers.get(record.type);
    if (!handler) {
      upsertEntity('ProcessingJob', record.id, {
        ...record,
        status: 'error',
        error: `No background job handler registered for ${record.type}`,
        payload: null,
        progress: {
          ...(record.progress || {}),
          phase: 'error',
          message: `No background job handler registered for ${record.type}`,
          updatedAt: nowIso(),
        },
        updatedAt: nowIso(),
        finishedAt: nowIso(),
      });
      continue;
    }

    if (!record.payload) {
      upsertEntity('ProcessingJob', record.id, {
        ...record,
        status: 'error',
        error: 'Server restarted before this job could be resumed. Please start it again.',
        payload: null,
        progress: {
          ...(record.progress || {}),
          phase: 'recoverable',
          message: 'Server restarted before this job could be resumed. Please start it again.',
          updatedAt: nowIso(),
        },
        updatedAt: nowIso(),
        finishedAt: nowIso(),
      });
      continue;
    }

    const job = hydratePersistedJob({
      ...record,
      status: 'queued',
      startedAt: null,
      finishedAt: null,
      progress: {
        ...(record.progress || {}),
        phase: 'queued',
        message: 'Recovered after server restart; queued to resume...',
        updatedAt: nowIso(),
      },
      updatedAt: nowIso(),
    });
    jobs.set(job.id, job);
    enqueueJob(job);
    saveJob(job);
  }

  if (queue.length) queueMicrotask(runNext);
}

export function getJob(id) {
  const job = jobs.get(id);
  if (job) return publicJob(job);
  return publicJob(getEntity('ProcessingJob', id));
}

export function listJobs({ type, status, limit = 20, meta = {}, includeCleared = false } = {}) {
  const merged = new Map();
  const statuses = String(status || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
  const metaEntries = Object.entries(meta || {}).filter(([, value]) => value !== undefined && value !== null && value !== '');
  const queryLimit = Math.max(50, Math.min(500, Number(limit || 20) * 4));

  for (const job of listProcessingJobSummaries({ type, statuses, meta, includeCleared, limit: queryLimit })) {
    const pub = publicJob(job, { includeResult: false });
    if (pub?.id) merged.set(pub.id, pub);
  }
  for (const job of jobs.values()) {
    const pub = publicJob(job, { includeResult: false });
    if (pub?.id) merged.set(pub.id, pub);
  }

  return [...merged.values()]
    .filter((job) => includeCleared || !isCleared(job))
    .filter((job) => !type || job.type === type)
    .filter((job) => statuses.length === 0 || statuses.includes(job.status))
    .filter((job) => metaEntries.every(([key, value]) => String(job.meta?.[key] ?? '') === String(value)))
    .sort((a, b) => new Date(b.updatedAt || b.createdAt || 0) - new Date(a.updatedAt || a.createdAt || 0))
    .slice(0, Math.max(1, Math.min(100, Number(limit) || 20)));
}

export function cancelJob(id) {
  const job = jobs.get(id);
  if (!job) {
    const persisted = getEntity('ProcessingJob', id);
    if (!persisted) return null;
    if (['queued', 'running'].includes(persisted.status)) {
      const updated = upsertEntity('ProcessingJob', id, {
        ...persisted,
        status: 'cancelled',
        error: 'Cancelled',
        payload: null,
        progress: {
          ...(persisted.progress || {}),
          phase: 'cancelled',
          message: 'Cancelled',
          updatedAt: nowIso(),
        },
        updatedAt: nowIso(),
        finishedAt: nowIso(),
      });
      return publicJob(updated);
    }
    return publicJob(persisted);
  }
  if (job.status === 'queued') {
    const index = queue.findIndex((queued) => queued.id === id);
    if (index >= 0) queue.splice(index, 1);
  }
  if (['queued', 'running'].includes(job.status)) {
    job.abortController.abort();
    patchJob(job, {
      status: 'cancelled',
      error: 'Cancelled',
      payload: null,
      finishedAt: nowIso(),
    });
    patchProgress(job, {
      phase: 'cancelled',
      message: 'Cancelled',
    });
  }
  return publicJob(job);
}

function clearPersistedJob(record, clearedAt) {
  if (!record?.id) return null;
  return upsertEntity('ProcessingJob', record.id, {
    ...record,
    meta: {
      ...(record.meta || {}),
      clearedAt,
    },
  });
}

export function clearJobs() {
  const clearedAt = nowIso();
  const merged = new Map();

  for (const record of listEntities('ProcessingJob')) {
    if (record?.id) merged.set(record.id, record);
  }
  for (const job of jobs.values()) {
    if (job?.id) merged.set(job.id, job);
  }

  let cancelled = 0;
  let cleared = 0;
  for (const job of merged.values()) {
    if (!job?.id || isCleared(job)) continue;
    if (['queued', 'running'].includes(job.status)) {
      cancelJob(job.id);
      cancelled += 1;
    }

    const runtimeJob = jobs.get(job.id);
    if (runtimeJob) {
      patchJob(runtimeJob, {
        meta: {
          ...(runtimeJob.meta || {}),
          clearedAt,
        },
      });
    } else {
      clearPersistedJob(job, clearedAt);
    }
    cleared += 1;
  }

  return { ok: true, cleared, cancelled, clearedAt };
}
