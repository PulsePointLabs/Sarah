import { getEntity, listEntities, listProcessingJobSummaries, listRecoverableProcessingJobs, upsertEntity } from '../db.js';
import { friendlyJobErrorMessage } from '../../src/lib/jobErrorMessages.js';
import { classifyProviderError } from '../../src/lib/providerErrorClassifier.js';

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

function hasExplicitPriority(meta = {}, payload = {}) {
  return meta?.priority !== undefined && meta?.priority !== null
    ? true
    : payload?.priority !== undefined && payload?.priority !== null;
}

function defaultJobPriority(type, meta = {}, payload = {}) {
  if (hasExplicitPriority(meta, payload)) return normalizeJobPriority(meta?.priority ?? payload?.priority);
  const name = String(type || '');
  if (name === 'tts_export') return 75;
  if (name === 'ai_invoke' && (meta.foreground || payload.foreground || payload.interactive)) return 70;
  if (name === 'ai_invoke') return 55;
  if (name === 'profile_image_review_full') return 50;
  if (name.startsWith('local_vision_')) return 35;
  if (name === 'session_review_video' || name === 'profile_anatomy_video' || name === 'mobile_session_video_render') return 10;
  return 0;
}

function isForegroundJob(job = {}) {
  return Boolean(job?.meta?.foreground || job?.payload?.foreground || job?.payload?.interactive);
}

function jobLane(type, meta = {}, payload = {}) {
  const name = String(type || '');
  if (name === 'ai_invoke' && (meta.foreground || payload.foreground || payload.interactive)) return 'foreground_ai';
  if (name.startsWith('local_vision_')) return 'local_vision';
  if (name === 'ai_invoke' || name === 'profile_image_review_full') return 'ai';
  if (name === 'tts_export') return 'tts';
  if (name === 'session_review_video' || name === 'profile_anatomy_video' || name === 'mobile_session_video_render') return 'video';
  return 'general';
}

function laneConcurrency(lane) {
  if (lane === 'foreground_ai') return foregroundConcurrency;
  if (lane === 'local_vision') return Math.max(1, Number(process.env.BACKGROUND_JOB_LOCAL_VISION_CONCURRENCY || 1));
  if (lane === 'ai') return Math.max(1, Number(process.env.BACKGROUND_JOB_AI_CONCURRENCY || 2));
  if (lane === 'tts') return Math.max(1, Number(process.env.BACKGROUND_JOB_TTS_CONCURRENCY || 1));
  if (lane === 'video') return Math.max(1, Number(process.env.BACKGROUND_JOB_VIDEO_CONCURRENCY || 1));
  return Math.max(1, Number(process.env.BACKGROUND_JOB_GENERAL_CONCURRENCY || concurrency));
}

function runningLaneCount(lane) {
  let count = 0;
  for (const id of running) {
    const job = jobs.get(id);
    if ((job?.lane || jobLane(job?.type, job?.meta, job?.payload)) === lane) count += 1;
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

function sanitizePublicJob(job = {}) {
  if (!job || job.status !== 'error') return job;
  const defaultProvider = defaultProviderForJobType(job.type);
  const rawError = [
    job.error,
    job.progress?.message,
    job.progress?.error_raw,
    job.progress?.provider_error?.technical_message,
  ].filter(Boolean).join(' ');
  const classified = classifyProviderError({ message: rawError }, { defaultProvider });
  if (classified.category === 'unknown_provider_error') return job;
  const cleanMessage = friendlyJobErrorMessage({ message: rawError }, { defaultProvider });
  return {
    ...job,
    error: cleanMessage,
    meta: {
      ...(job.meta || {}),
      retry_category: job.meta?.retry_category || classified.category,
    },
    progress: {
      ...(job.progress || {}),
      message: cleanMessage,
      provider_error: job.progress?.provider_error || classified,
      error_raw: classified.technical_message || cleanMessage,
    },
  };
}

function publicJob(job, { includeResult = true } = {}) {
  if (!job) return null;
  const safeJob = sanitizePublicJob(job);
  const hasPayload = safeJob.payload != null;
  const { payload: _payload, abortController: _abortController, ...rest } = safeJob;
  if (!includeResult) {
    const { result: _result, ...summary } = rest;
    const resultSummary = summarizeJobResult(rest.result);
    const progress = summary.progress ? { ...summary.progress } : summary.progress;
    if (progress && Array.isArray(progress.completed_batch_results)) {
      progress.completed_batch_results = undefined;
      progress.completed_batch_results_omitted = true;
    }
    const meta = summary.meta ? { ...summary.meta } : summary.meta;
    if (meta && Array.isArray(meta.reviewed_images)) {
      meta.reviewed_image_count = meta.reviewed_images.length;
      meta.reviewed_images = undefined;
    }
    return {
      ...summary,
      meta,
      progress,
      result_summary: resultSummary,
      hasResult: rest.result != null || Boolean(summary.hasResult),
      hasPayload,
      retryable: Boolean(meta?.retryable || progress?.retryable) && hasPayload,
    };
  }
  return {
    ...rest,
    hasPayload,
    retryable: Boolean(rest.meta?.retryable || rest.progress?.retryable) && hasPayload,
  };
}

function summarizeJobResult(result) {
  if (!result || typeof result !== 'object') return null;
  const record = result.record && typeof result.record === 'object' ? result.record : {};
  const candidate = {
    file_url: result.file_url || result.url || result.audio_file_url || record.file_url || record.url || null,
    stream_url: result.stream_url || record.stream_url || null,
    download_url: result.download_url || record.download_url || null,
    manifest_url: result.manifest_url || record.manifest_url || null,
    filename: result.filename || record.filename || null,
    size: result.size || result.size_bytes || record.size || record.size_bytes || null,
    duration_seconds: result.duration_seconds || record.duration_seconds || null,
    created_at: result.created_at || result.exported_at || result.finished_at || record.created_at || record.exported_at || record.finished_at || null,
    mime_type: result.mime_type || result.content_type || record.mime_type || record.content_type || null,
    render_version: result.render_version || record.render_version || null,
    watermark_enabled: result.watermark_enabled ?? record.watermark_enabled ?? null,
    audio_reused: result.audio_reused ?? record.audio_reused ?? null,
  };
  const summary = Object.fromEntries(
    Object.entries(candidate).filter(([, value]) => value !== undefined && value !== null && value !== '')
  );
  if (!Object.keys(summary).length) return null;
  const url = String(summary.file_url || summary.download_url || summary.stream_url || '');
  if (!summary.mime_type && /\.mp4(?:$|[?#])/i.test(url)) summary.mime_type = 'video/mp4';
  if (!summary.mime_type && /\.(?:mp3|wav|m4a|aac)(?:$|[?#])/i.test(url)) summary.mime_type = 'audio/*';
  return summary;
}

function shouldRetainPayloadForRetry(error) {
  const category = classifyProviderError(error, { defaultProvider: 'anthropic' })?.category;
  return [
    'insufficient_credits',
    'rate_limit',
    'provider_unavailable',
    'timeout',
    'output_truncation',
  ].includes(category);
}

function defaultProviderForJobType(type = '') {
  const name = String(type || '');
  if (name === 'tts_export' || name === 'profile_anatomy_video' || name === 'session_review_video') return 'openai';
  return 'anthropic';
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
        meta: { ...(job.meta || {}) },
        signal: job.abortController.signal,
        updateProgress: (progress) => patchProgress(job, progress),
        getProgress: () => ({ ...(job.progress || {}) }),
      }))
      .then((result) => {
        const existingProgress = job.progress || {};
        const total = Number(existingProgress.total || 0);
        const keepCompletionMessage =
          existingProgress.phase === 'complete' &&
          existingProgress.message;
        const finalResult = persistTtsAudioExport(job, result);
        const resultSummary = summarizeJobResult(finalResult);
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
          ...(resultSummary?.file_url ? { file_url: resultSummary.file_url, result_file_url: resultSummary.file_url } : {}),
          ...(resultSummary?.filename ? { filename: resultSummary.filename, result_filename: resultSummary.filename } : {}),
          ...(resultSummary?.duration_seconds ? { result_duration_seconds: resultSummary.duration_seconds } : {}),
          ...(resultSummary?.size ? { result_size: resultSummary.size } : {}),
          ...(resultSummary?.created_at ? { result_created_at: resultSummary.created_at } : {}),
        });
      })
      .catch((error) => {
        const cancelled = job.abortController.signal.aborted;
        const defaultProvider = defaultProviderForJobType(job?.type);
        const cleanErrorMessage = cancelled ? 'Cancelled' : friendlyJobErrorMessage(error, { defaultProvider });
        const providerError = cancelled ? null : classifyProviderError(error, { defaultProvider });
        const providerRetryable = !cancelled && shouldRetainPayloadForRetry(error);
        const retainPayloadForRetry = !cancelled && Boolean(providerRetryable || job.progress?.retryable || job.progress?.payload_ref_retained);
        patchJob(job, {
          status: cancelled ? 'cancelled' : 'error',
          error: cleanErrorMessage,
          payload: retainPayloadForRetry ? job.payload : null,
          meta: {
            ...(job.meta || {}),
            retryable: retainPayloadForRetry || Boolean(job.meta?.retryable),
          retry_category: retainPayloadForRetry
              ? (job.progress?.provider_error?.category || providerError?.category || null)
              : job.meta?.retry_category,
          },
          finishedAt: nowIso(),
        });
        patchProgress(job, {
          phase: cancelled ? 'cancelled' : 'error',
          message: cleanErrorMessage,
          ...(cancelled ? {} : {
            provider_error: providerError,
            error_raw: providerError?.technical_message || cleanErrorMessage,
          }),
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
  const priority = defaultJobPriority(type, meta, payload);
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

export function retryJob(id, { priority } = {}) {
  const existing = jobs.get(id) || getEntity('ProcessingJob', id);
  if (!existing?.id) return null;
  if (!['error', 'cancelled'].includes(existing.status)) {
    const error = new Error('Only failed or cancelled jobs can be retried.');
    error.status = 400;
    throw error;
  }
  if (!existing.payload) {
    const error = new Error('This job no longer has a saved payload, so it must be started again.');
    error.status = 409;
    throw error;
  }
  const now = nowIso();
  const nextPriority = priority !== undefined && priority !== null
    ? normalizeJobPriority(priority)
    : normalizeJobPriority(existing.priority ?? existing.meta?.priority ?? defaultJobPriority(existing.type, existing.meta, existing.payload));
  const job = hydratePersistedJob({
    ...existing,
    status: 'queued',
    error: null,
    result: null,
    priority: nextPriority,
    lane: existing.lane || jobLane(existing.type, existing.meta, existing.payload),
    meta: {
      ...(existing.meta || {}),
      priority: nextPriority,
      retriedAt: now,
      retryOfJobId: existing.meta?.retryOfJobId || existing.id,
    },
    progress: {
      ...(existing.progress || {}),
      phase: 'queued',
      message: 'Queued to resume from saved job payload...',
      retrying: true,
      updatedAt: now,
    },
    startedAt: null,
    finishedAt: null,
    updatedAt: now,
  });
  jobs.set(job.id, job);
  enqueueJob(job);
  saveJob(job);
  queueMicrotask(runNext);
  return publicJob(job);
}

function hydratePersistedJob(record) {
  if (!record?.id) return null;
  const lane = jobLane(record.type, record.meta, record.payload);
  const storedPriority = normalizeJobPriority(record.priority ?? record.meta?.priority);
  const priority = storedPriority === 0 && ['tts_export', 'ai_invoke', 'profile_image_review_full', 'session_review_video', 'profile_anatomy_video', 'mobile_session_video_render'].includes(String(record.type || ''))
    ? defaultJobPriority(record.type, {}, record.payload)
    : storedPriority;
  return {
    ...record,
    priority,
    lane,
    meta: {
      ...(record.meta || {}),
      priority,
    },
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
    let pub = publicJob(job, { includeResult: false });
    if (pub?.hasResult && !pub.result_summary && pub.id) {
      const hydrated = publicJob(getEntity('ProcessingJob', pub.id), { includeResult: false });
      if (hydrated?.result_summary) {
        pub = {
          ...pub,
          result_summary: hydrated.result_summary,
          progress: {
            ...(pub.progress || {}),
            ...(hydrated.progress?.result_file_url ? { result_file_url: hydrated.progress.result_file_url } : {}),
            ...(hydrated.progress?.result_filename ? { result_filename: hydrated.progress.result_filename } : {}),
            ...(hydrated.progress?.result_duration_seconds ? { result_duration_seconds: hydrated.progress.result_duration_seconds } : {}),
            ...(hydrated.progress?.result_size ? { result_size: hydrated.progress.result_size } : {}),
            ...(hydrated.progress?.result_created_at ? { result_created_at: hydrated.progress.result_created_at } : {}),
          },
        };
      }
    }
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
