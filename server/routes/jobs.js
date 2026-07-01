import express from 'express';
import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { cancelJob, clearJobs, createJob, getJob, listJobs, registerJobHandler, retryJob } from '../services/jobQueue.js';
import { renderTTSExport } from '../services/ttsRenderer.js';
import { renderSessionReviewVideo } from '../services/sessionReviewVideoRenderer.js';
import { renderProfileAnatomyVideo } from '../services/profileAnatomyVideoRenderer.js';
import { renderMobileSessionVideo } from '../services/sessionVideoPipeline.js';
import { aiInvokeInternal } from './internalAi.js';
import { resolveUploadPath } from '../config.js';
import { startAIForensicCapture } from '../services/aiForensics.js';
import { analyzeLocalVisionWindow } from '../services/localVision/analyzeWindow.js';
import { analyzeLocalVisionContinuous } from '../services/localVision/continuousAnalyzer.js';
import { analyzeLocalVisionAdaptive } from '../services/localVision/adaptiveAnalyzer.js';
import { analyzeLocalVisionForward } from '../services/localVision/forwardAnalyzer.js';
import { askLocalVisionVideo } from '../services/localVision/videoQa.js';
import { resolveCachedFramePath } from '../services/localVision/frameSampler.js';
import { deleteJobPayload, loadJobPayload, saveJobPayload } from '../services/jobPayloadStore.js';
import { getEntity, listEntities, upsertEntity } from '../db.js';
import {
  buildClinicalJsonRetryPrompt,
  isMalformedStructuredResponseError,
  isRefusalShapedStructuredResponse,
  shouldSkipPreviouslyExhaustedRefusalBatch,
} from '../services/structuredResponseRetry.js';
import {
  cleanProfileImageReviewText,
  cleanupProfileImageReviewResult,
  dedupeProfileImageReviewItems,
  mergeCumulativeProfileVisualEvidence,
  selectLongitudinalProfileReviewImages,
  updateLongitudinalProfileChart,
} from '../../src/lib/profileImageReviewCleanup.js';
import { friendlyJobErrorMessage } from '../../src/lib/jobErrorMessages.js';
import { classifyProviderError } from '../../src/lib/providerErrorClassifier.js';
import { runProfileAnatomyImageIndex } from '../services/profileAnatomyImageIndex.js';
import { materializeProfileReviewBatchRequest } from '../services/profileReviewBatchPayload.js';

export const jobsRouter = express.Router();
export const largeJobsRouter = express.Router();

async function resolvePayload(payload = {}) {
  if (payload?.__payloadRef) {
    return loadJobPayload(payload.__payloadRef);
  }
  return payload || {};
}

async function cleanupPayloadRef(payload = {}) {
  if (payload?.__payloadRef) {
    await deleteJobPayload(payload.__payloadRef);
  }
}

function stripDataUrl(value = '') {
  return String(value || '').replace(/^data:[^;]+;base64,/, '');
}

const PROFILE_REVIEW_RESULT_FIELDS = {
  profile_head_to_toe_image_review: {
    resultKey: 'head_to_toe_image_review_result',
    archiveKey: 'head_to_toe_image_review_archive',
    label: 'Head-to-Toe Image Review',
  },
  profile_pelvic_genital_image_review: {
    resultKey: 'pelvic_genital_image_review_result',
    archiveKey: 'pelvic_genital_image_review_archive',
    label: 'Pelvic & Genital Image Review',
  },
};

function compactProfileArchive(archive = [], limit = 30) {
  const seen = new Set();
  return (Array.isArray(archive) ? archive : [])
    .filter((entry) => entry?.id || entry?.generated_at || entry?.result)
    .filter((entry) => {
      const key = entry.id || entry.generated_at || JSON.stringify(entry.result?._meta || {});
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .slice(0, limit);
}

function persistCompletedProfileImageReviewResult(result, payload = {}, context = {}) {
  if (!result || typeof result !== 'object') return result;
  const reviewType = String(payload?.reviewType || payload?.kind || result?._meta?.reviewType || '');
  const fields = PROFILE_REVIEW_RESULT_FIELDS[reviewType];
  if (!fields) return result;

  const generatedAt = new Date().toISOString();
  const existing = listEntities('SessionClusterAnalysis')
    .sort((a, b) => new Date(b?.updated_date || b?.created_date || 0) - new Date(a?.updated_date || a?.created_date || 0))[0];
  const sourceSessionCount = Number(payload?.source_session_count || payload?.session_count || 0) || undefined;
  const sourceMotionCount = Number(payload?.motion_evidence_session_count || 0) || undefined;
  const currentMeta = result._meta && typeof result._meta === 'object' ? result._meta : {};
  const reviewedImages = Array.isArray(payload?.reviewed_images) && payload.reviewed_images.length
    ? payload.reviewed_images
    : Array.isArray(context?.meta?.reviewed_images) && context.meta.reviewed_images.length
      ? context.meta.reviewed_images
      : Array.isArray(currentMeta.reviewed_images)
        ? currentMeta.reviewed_images
        : [];
  const mergedResult = mergeCumulativeProfileVisualEvidence(result, existing?.[fields.archiveKey] || [], {
    sections: payload?.sections || [],
    reviewedImages,
  });
  const chartResult = updateLongitudinalProfileChart(existing?.[fields.resultKey] || {}, mergedResult, {
    sections: payload?.sections || [],
    generatedAt,
  });
  const storedResult = {
    ...chartResult,
    _meta: {
      ...(chartResult._meta || currentMeta),
      reviewType,
      last_generated_at: currentMeta.last_generated_at || generatedAt,
      updated_at: generatedAt,
      source_job_id: context.jobId || currentMeta.source_job_id || null,
      source_job_completed_at: generatedAt,
      ...(sourceSessionCount != null ? { source_session_count: sourceSessionCount } : {}),
      ...(sourceMotionCount != null ? { motion_evidence_session_count: sourceMotionCount } : {}),
      image_count: Number(payload?.image_count || payload?.full_review_image_count || context?.meta?.image_count || currentMeta.image_count || reviewedImages.length || 0) || currentMeta.image_count,
      fresh_image_count: Number(payload?.fresh_image_count || context?.meta?.fresh_image_count || currentMeta.fresh_image_count || 0) || 0,
      reused_saved_image_count: Number(payload?.reused_saved_image_count || context?.meta?.reused_saved_image_count || currentMeta.reused_saved_image_count || 0) || 0,
      reviewed_images: chartResult?._meta?.reviewed_images || reviewedImages,
    },
  };
  const archiveEntry = {
    id: `${reviewType}-${storedResult._meta.last_generated_at}-${storedResult._meta.source_job_id || 'job'}`.replace(/[^a-zA-Z0-9_.:-]+/g, '-'),
    kind: reviewType,
    label: fields.label,
    generated_at: storedResult._meta.last_generated_at,
    source_session_count: storedResult._meta.source_session_count,
    result: storedResult,
  };
  const nextArchive = compactProfileArchive([archiveEntry, ...(existing?.[fields.archiveKey] || [])]);
  upsertEntity('SessionClusterAnalysis', existing?.id || crypto.randomUUID(), {
    ...(existing || {}),
    [fields.resultKey]: storedResult,
    [fields.archiveKey]: nextArchive,
    ...(sourceSessionCount != null ? { session_count: sourceSessionCount } : {}),
  });
  return storedResult;
}

const LONGITUDINAL_PROFILE_REVIEW_DIRECTIVE = `LONGITUDINAL FOLLOW-UP CHART MODE - HIGHEST PRIORITY:
- Treat the existing structured profile as the established chart and the attached evidence as the current examination/update layer.
- Update each anatomical section rather than rediscovering the patient from scratch.
- State meaningful new, changed, stable, resolved, or follow-up findings when supported. Do not manufacture change language when the current evidence only confirms the chart.
- Directly review only the attached current or validated structure-specific references. Do not imply that the complete historical media archive was reopened.
- Keep catheter and device history in the device/contact lane unless it materially changes tissue visibility, tissue health, or the current anatomical finding.
- In head-to-toe review, include pelvic and genital findings normally and briefly when relevant; do not suppress them merely because they are genital anatomy.`;

function profileRequestImageId(image = {}) {
  if (image.image_id) return String(image.image_id);
  const filename = String(image.filename || '').split(/[\\/]/).pop() || '';
  return filename.replace(/\.[^.]+$/, '');
}

function filterProfileRequestImages(request = {}, selectedIds = new Set(), knownIds = new Set()) {
  if (!request || !selectedIds.size) return request;
  const filter = (images) => (Array.isArray(images)
    ? images.filter((image) => selectedIds.has(profileRequestImageId(image)))
    : images);
  const prompt = String(request.prompt || '')
    .split('\n')
    .filter((line) => {
      const id = [...knownIds].find((candidate) => line.includes(candidate));
      return !id || selectedIds.has(id);
    })
    .join('\n');
  return {
    ...request,
    prompt: `${LONGITUDINAL_PROFILE_REVIEW_DIRECTIVE}\n\n${prompt}`,
    imageRefs: filter(request.imageRefs),
    images: filter(request.images),
  };
}

function prepareLongitudinalProfileReviewPayload(payload = {}, context = {}) {
  const reviewedImages = Array.isArray(context?.meta?.reviewed_images)
    ? context.meta.reviewed_images
    : Array.isArray(payload?.reviewed_images)
      ? payload.reviewed_images
      : [];
  if (!reviewedImages.length) return payload;
  const pelvic = /pelvic|genital/i.test(String(payload.reviewType || payload.reviewTitle || ''));
  const selectedImages = selectLongitudinalProfileReviewImages(reviewedImages, [], {
    freshImageCount: Number(context?.meta?.fresh_image_count || payload?.fresh_image_count || 0),
    maxImages: pelvic ? 20 : 30,
  });
  if (!selectedImages.length) return payload;
  const knownIds = new Set(reviewedImages.map((image) => String(image.image_id || '')).filter(Boolean));
  const selectedIds = new Set(selectedImages.map((image) => String(image.image_id || '')).filter(Boolean));
  const batchRequests = (Array.isArray(payload.batchRequests) ? payload.batchRequests : [])
    .map((request) => filterProfileRequestImages(request, selectedIds, knownIds))
    .filter((request) => (
      (Array.isArray(request.imageRefs) && request.imageRefs.length)
      || (Array.isArray(request.images) && request.images.length)
    ));
  return {
    ...payload,
    reviewed_images: selectedImages,
    image_count: selectedImages.length,
    batchRequests,
    singleRequest: filterProfileRequestImages(payload.singleRequest, selectedIds, knownIds),
    synthesisRequest: payload.synthesisRequest ? {
      ...payload.synthesisRequest,
      promptPrefix: `${LONGITUDINAL_PROFILE_REVIEW_DIRECTIVE}\n\n${payload.synthesisRequest.promptPrefix || ''}`,
    } : payload.synthesisRequest,
  };
}

function sessionDirectEvidenceCorpus(session = {}) {
  return [
    session.notes,
    session.subjective_notes,
    session.unusual_sensations,
    session.discomfort_notes,
    ...(Array.isArray(session.discomfort_entries) ? session.discomfort_entries.map((entry) => `${entry?.description || ''} ${entry?.notes || ''}`) : []),
    ...(Array.isArray(session.event_timeline) ? session.event_timeline.map((event) => event?.note) : []),
  ].filter(Boolean).join(' ').toLowerCase();
}

function removeUnsupportedSessionTangents(text = '', directCorpus = '', section = '') {
  const value = String(text || '');
  if (!value) return value;
  const hasDirectLowerExtremityHealthEvidence = /\b(pitted\s+keratolysis|plantar\s+(?:skin|surface|maceration)|footwear|shoe|shoes|topical\s+antibacterial|vascular\s+specialist|edema|oedema|lower\s+extremity|lower-extremity|venous|arterial|perfusion|podiatry|podiatrist)\b/i.test(directCorpus);
  const shouldRemoveSentence = (sentence) => {
    const lower = String(sentence || '').toLowerCase();
    if (/\b(feet|foot|toe|toes|sole|soles)\b/.test(lower) && /\b(smell|smelled|smelling|odor|odour|malodor|scent)\b/.test(lower)) return true;
    if (/\b(vascular|circulation|circulatory|perfusion|cyanosis|pallor|edema|oedema|venous|arterial|capillary refill)\b/.test(lower) && !hasDirectLowerExtremityHealthEvidence) return true;
    if (
      !hasDirectLowerExtremityHealthEvidence
      && (section === 'recommendations' || section === 'notable_findings' || section === 'summary')
      && /\b(pitted\s+keratolysis|plantar\s+(?:skin|surface|maceration)|footwear|shoe|shoes|topical\s+antibacterial|vascular\s+specialist|lower\s+extremity|lower-extremity|podiatry|podiatrist|right-worse-than-left\s+edema)\b/.test(lower)
    ) return true;
    return false;
  };
  return value
    .split(/(?<=[.!?])\s+/)
    .filter((sentence) => !shouldRemoveSentence(sentence))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeSessionAIResultForCurrentSession(result = {}, session = {}) {
  if (!result || typeof result !== 'object') return result;
  const directCorpus = sessionDirectEvidenceCorpus(session);
  const cleanArray = (rows, section) => (Array.isArray(rows)
    ? rows.map((row) => removeUnsupportedSessionTangents(row, directCorpus, section)).filter(Boolean)
    : rows);
  return {
    ...result,
    summary: removeUnsupportedSessionTangents(result.summary, directCorpus, 'summary'),
    arousal_arc: cleanArray(result.arousal_arc, 'arousal_arc'),
    phase_analysis: cleanArray(result.phase_analysis, 'phase_analysis'),
    event_analysis: cleanArray(result.event_analysis, 'event_analysis'),
    hr_analysis: cleanArray(result.hr_analysis, 'hr_analysis'),
    emg_analysis: cleanArray(result.emg_analysis, 'emg_analysis'),
    notable_findings: cleanArray(result.notable_findings, 'notable_findings'),
    recommendations: cleanArray(result.recommendations, 'recommendations'),
  };
}

function persistCompletedSessionAIInvokeResult(result, _payload = {}, context = {}) {
  if (!result || typeof result !== 'object') return result;
  const meta = context?.meta || {};
  const sessionId = String(meta.sessionId || '');
  const analysisField = String(meta.analysisField || '');
  if (!sessionId || !['ai_analysis', 'ai_session_deep_dive', 'ai_body_exploration'].includes(analysisField)) return result;
  const session = getEntity('Session', sessionId) || getEntity('BodyExploration', sessionId);
  if (!session) return result;

  const generatedAt = new Date().toISOString();
  const previousMeta = session?.[analysisField]?._meta || {};
  const sanitizedResult = sanitizeSessionAIResultForCurrentSession(result, session);
  const storedResult = {
    ...sanitizedResult,
    _meta: {
      ...previousMeta,
      ...(sanitizedResult._meta && typeof sanitizedResult._meta === 'object' ? sanitizedResult._meta : {}),
      created_at: previousMeta.created_at || generatedAt,
      updated_at: generatedAt,
      last_generated_at: generatedAt,
      source_job_id: context.jobId || null,
      source_job_completed_at: generatedAt,
      ...(meta.phaseMarkerFreshnessKey ? { phase_marker_freshness_key: meta.phaseMarkerFreshnessKey } : {}),
      ...(meta.phaseMarkers ? { source_phase_markers_s: {
        pre_climax: meta.phaseMarkers.pre_climax_offset_s ?? null,
        climax: meta.phaseMarkers.climax_offset_s ?? null,
        recovery: meta.phaseMarkers.recovery_offset_s ?? null,
      } } : {}),
    },
  };
  const entity = getEntity('Session', sessionId) ? 'Session' : 'BodyExploration';
  upsertEntity(entity, sessionId, {
    ...session,
    [analysisField]: storedResult,
  });
  return storedResult;
}

function imageMediaTypeFromName(value = '') {
  const ext = path.extname(String(value || '').toLowerCase());
  if (ext === '.png') return 'image/png';
  if (ext === '.webp') return 'image/webp';
  if (ext === '.gif') return 'image/gif';
  return 'image/jpeg';
}

function normalizeImageMediaType(value = '', fallbackName = '') {
  const mediaType = String(value || '').trim().toLowerCase();
  if (mediaType.startsWith('image/')) return mediaType;
  return imageMediaTypeFromName(fallbackName);
}

function candidateImageRefUrl(ref = {}) {
  return String(ref.url || ref.file_url || ref.preview_url || ref.previewUrl || ref.storagePath || ref.path || '').trim();
}

function localUploadPathFromRefUrl(rawUrl = '') {
  if (!rawUrl) return '';
  let pathname = rawUrl;
  try {
    if (/^https?:\/\//i.test(rawUrl)) {
      pathname = new URL(rawUrl).pathname;
    }
  } catch {
    pathname = rawUrl;
  }
  if (!pathname.startsWith('/uploads/')) return '';
  const filename = decodeURIComponent(pathname.replace(/^\/uploads\//, ''));
  return filename ? resolveUploadPath(filename) : '';
}

function pathnameFromRefUrl(rawUrl = '') {
  let pathname = String(rawUrl || '').trim();
  try {
    if (/^https?:\/\//i.test(pathname)) {
      pathname = new URL(pathname).pathname;
    }
  } catch {
    pathname = String(rawUrl || '').trim();
  }
  return pathname;
}

function localVisionFramePathFromRefUrl(rawUrl = '') {
  const pathname = pathnameFromRefUrl(rawUrl);
  if (!pathname.startsWith('/api/local-vision/frame/')) return '';
  const parts = pathname
    .replace(/^\/api\/local-vision\/frame\//, '')
    .split('/')
    .map((part) => {
      try {
        return decodeURIComponent(part);
      } catch {
        return part;
      }
    });
  if (parts.length !== 3 || parts.some((part) => !part)) return '';
  return resolveCachedFramePath(parts[0], parts[1], parts[2]);
}

async function readImageRefViaHttp(rawUrl, ref = {}, signal) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.PROFILE_IMAGE_REF_FETCH_TIMEOUT_MS || 30000));
  const abortHandler = () => controller.abort();
  try {
    signal?.addEventListener?.('abort', abortHandler, { once: true });
    const response = await fetch(rawUrl, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const bytes = Buffer.from(await response.arrayBuffer());
    return {
      filename: ref.filename || path.basename(new URL(rawUrl).pathname) || 'profile-reference.jpg',
      media_type: normalizeImageMediaType(response.headers.get('content-type') || ref.media_type, rawUrl),
      data: bytes.toString('base64'),
    };
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener?.('abort', abortHandler);
  }
}

async function resolveImageRefForAI(ref = {}, context) {
  if (ref.data) {
    return {
      filename: ref.filename || `${ref.image_id || 'profile-reference'}.jpg`,
      media_type: normalizeImageMediaType(ref.media_type, ref.filename),
      data: stripDataUrl(ref.data),
    };
  }

  const rawUrl = candidateImageRefUrl(ref);
  if (!rawUrl) throw new Error(`Saved image reference ${ref.image_id || ref.filename || ''} has no URL.`);

  const uploadPath = localUploadPathFromRefUrl(rawUrl);
  if (uploadPath) {
    const bytes = await fsp.readFile(uploadPath);
    return {
      filename: ref.filename || path.basename(uploadPath),
      media_type: normalizeImageMediaType(ref.media_type, uploadPath),
      data: bytes.toString('base64'),
    };
  }

  const localVisionFramePath = localVisionFramePathFromRefUrl(rawUrl);
  if (localVisionFramePath) {
    const bytes = await fsp.readFile(localVisionFramePath);
    return {
      filename: ref.filename || path.basename(localVisionFramePath),
      media_type: normalizeImageMediaType(ref.media_type, localVisionFramePath),
      data: bytes.toString('base64'),
    };
  }

  if (path.isAbsolute(rawUrl)) {
    const bytes = await fsp.readFile(rawUrl);
    return {
      filename: ref.filename || path.basename(rawUrl),
      media_type: normalizeImageMediaType(ref.media_type, rawUrl),
      data: bytes.toString('base64'),
    };
  }

  if (/^https?:\/\//i.test(rawUrl)) {
    return readImageRefViaHttp(rawUrl, ref, context.signal);
  }

  throw new Error(`Saved image reference ${ref.image_id || ref.filename || rawUrl} is not a local upload or readable URL.`);
}

async function hydrateRequestImageRefs(request = {}, context, label = 'Profile image review') {
  const imageRefs = Array.isArray(request?.imageRefs) ? request.imageRefs : [];
  if (!imageRefs.length) return request || {};

  context.updateProgress({
    phase: 'loading_saved_images',
    current: 0,
    total: imageRefs.length,
    message: `${label}: loading ${imageRefs.length} saved image reference${imageRefs.length === 1 ? '' : 's'} in the backend…`,
  });

  const resolvedImages = [];
  const skippedImageRefs = [];
  for (let index = 0; index < imageRefs.length; index += 1) {
    if (context.signal?.aborted) throw new Error('Cancelled');
    try {
      resolvedImages.push(await resolveImageRefForAI(imageRefs[index], context));
    } catch (error) {
      const imageRef = imageRefs[index] || {};
      const labelName = imageRef.filename || imageRef.image_id || candidateImageRefUrl(imageRef) || `image ${index + 1}`;
      const message = `${label}: skipped saved image ${index + 1}/${imageRefs.length} (${labelName}): ${error?.message || error}`;
      skippedImageRefs.push({
        index,
        image_id: imageRef.image_id || null,
        filename: imageRef.filename || null,
        url: candidateImageRefUrl(imageRef) || null,
        error: error?.message || String(error),
      });
      console.warn(message);
      context.updateProgress({
        phase: 'loading_saved_images',
        current: index + 1,
        total: imageRefs.length,
        warning: true,
        skipped_image_refs: skippedImageRefs.length,
        message,
      });
      continue;
    }
    context.updateProgress({
      phase: 'loading_saved_images',
      current: index + 1,
      total: imageRefs.length,
      message: `${label}: loaded saved image ${index + 1}/${imageRefs.length}.`,
    });
  }

  const { imageRefs: _imageRefs, ...rest } = request || {};
  return {
    ...rest,
    ...(skippedImageRefs.length ? { skippedImageRefs } : {}),
    images: [
      ...(Array.isArray(request.images) ? request.images : []),
      ...resolvedImages,
    ],
  };
}

registerJobHandler('tts_export', async (payload, context) => {
  return renderTTSExport(payload, {
    jobId: context.jobId,
    signal: context.signal,
    onProgress: context.updateProgress,
  });
});

registerJobHandler('session_review_video', async (payload, context) => {
  return renderSessionReviewVideo(payload, {
    jobId: context.jobId,
    signal: context.signal,
    onProgress: context.updateProgress,
  });
});

registerJobHandler('profile_anatomy_video', async (payload, context) => {
  return renderProfileAnatomyVideo(payload, {
    jobId: context.jobId,
    signal: context.signal,
    onProgress: context.updateProgress,
  });
});

registerJobHandler('profile_anatomy_image_index', async (payload, context) => {
  return runProfileAnatomyImageIndex(payload, context);
});

registerJobHandler('mobile_session_video_render', async (payload, context) => {
  return renderMobileSessionVideo(payload, {
    jobId: context.jobId,
    signal: context.signal,
    updateProgress: context.updateProgress,
  });
});

registerJobHandler('ai_invoke', async (payload, context) => {
  const {
    prompt,
    response_json_schema,
    model,
    max_tokens,
    temperature,
    schema_mode,
    images = [],
    forensic_capture,
    forensic_session_id,
    experiment,
    label = 'AI analysis',
  } = payload || {};
  if (!prompt) throw new Error('AI job is missing a prompt');
  const forensicCaptureId = forensic_capture ? startAIForensicCapture({
    jobId: context.jobId,
    label,
    experiment,
    sessionId: forensic_session_id,
    requestedModelAlias: model,
    schemaMode: schema_mode || 'strict',
  }) : null;
  context.updateProgress({
    phase: 'preparing',
    current: 0,
    total: 3,
    message: `${label}: preparing prompt (${String(prompt).length.toLocaleString()} characters)…`,
    model: model || process.env.ANTHROPIC_MODEL || 'claude_sonnet_4_6',
    image_count: Array.isArray(images) ? images.length : 0,
    ...(forensicCaptureId ? { forensic_capture_id: forensicCaptureId } : {}),
  });
  if (context.signal?.aborted) throw new Error('Cancelled');

  context.updateProgress({
    phase: 'requesting',
    current: 1,
    total: 3,
    message: `${label}: waiting for Claude to finish the full response…`,
  });
  let result;
  try {
    result = await aiInvokeInternal({
      prompt,
      response_json_schema,
      model,
      max_tokens,
      temperature,
      schema_mode,
      images,
      forensicCaptureId,
      invocationAttempt: 1,
      signal: context.signal,
    });
  } catch (error) {
    const message = error?.message || String(error);
    const canRetryForLength = response_json_schema && /cut off|max_tokens|malformed JSON/i.test(message);
    if (!canRetryForLength) throw error;
    const retryMaxTokens = Math.max(Number(max_tokens || 0), Number(process.env.ANTHROPIC_LONG_MAX_TOKENS || 20000));
    context.updateProgress({
      phase: 'retrying',
      current: 1,
      total: 3,
      message: `${label}: response was incomplete, retrying with a larger output budget…`,
      retry_reason: message.slice(0, 240),
      max_tokens: retryMaxTokens,
    });
    result = await aiInvokeInternal({
      prompt,
      response_json_schema,
      model,
      max_tokens: retryMaxTokens,
      temperature,
      schema_mode,
      images,
      forensicCaptureId,
      invocationAttempt: 2,
      signal: context.signal,
    });
  }
  if (context.signal?.aborted) throw new Error('Cancelled');

  context.updateProgress({
    phase: 'saving',
    current: 2,
    total: 3,
    message: `${label}: validating structured output…`,
  });
  return persistCompletedSessionAIInvokeResult(result, payload, context);
});

async function runInternalAIRequest(request = {}, context, label = 'AI analysis', step = {}) {
  const {
    prompt,
    response_json_schema,
    model,
    max_tokens,
    temperature,
    schema_mode,
    images = [],
  } = request || {};
  if (!prompt) throw new Error(`${label} is missing a prompt`);
  if (context.signal?.aborted) throw new Error('Cancelled');

  context.updateProgress({
    phase: step.phase || 'requesting',
    current: step.current ?? 0,
    total: step.total ?? 1,
    message: step.message || `${label}: waiting for Claude…`,
    model: model || process.env.ANTHROPIC_MODEL || 'claude_sonnet_4_6',
    image_count: Array.isArray(images) ? images.length : 0,
  });

  try {
    return await aiInvokeInternal({
      prompt,
      response_json_schema,
      model,
      max_tokens,
      temperature,
      schema_mode,
      images,
      invocationAttempt: 1,
      signal: context.signal,
    });
  } catch (error) {
    const message = error?.message || String(error);
    const canRetryForLength = response_json_schema && /cut off|max_tokens|malformed JSON/i.test(message);
    if (!canRetryForLength) throw error;
    const retryMaxTokens = Math.max(Number(max_tokens || 0), Number(process.env.ANTHROPIC_LONG_MAX_TOKENS || 20000));
    const malformedStructuredResponse = isMalformedStructuredResponseError(error);
    const refusalShapedResponse = malformedStructuredResponse && isRefusalShapedStructuredResponse(error);
    context.updateProgress({
      phase: 'retrying',
      current: step.current ?? 0,
      total: step.total ?? 1,
      message: malformedStructuredResponse
        ? `${label}: provider returned non-JSON text; correcting and retrying this batch automatically${refusalShapedResponse ? ' from the saved anatomy index' : ''}…`
        : `${label}: response was incomplete, retrying with a larger output budget…`,
      retry_reason: message.slice(0, 240),
      max_tokens: retryMaxTokens,
    });
    try {
      return await aiInvokeInternal({
        prompt: malformedStructuredResponse ? buildClinicalJsonRetryPrompt(prompt, error) : prompt,
        response_json_schema,
        model,
        max_tokens: retryMaxTokens,
        temperature,
        schema_mode,
        images: refusalShapedResponse ? [] : images,
        invocationAttempt: 2,
        signal: context.signal,
      });
    } catch (retryError) {
      if (
        refusalShapedResponse
        && isMalformedStructuredResponseError(retryError)
        && isRefusalShapedStructuredResponse(retryError)
      ) {
        retryError.clinicalMetadataRetryRefused = true;
      }
      throw retryError;
    }
  }
}

function parseAIResult(value) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return { overview: value };
  }
}

function parseProfileImageReviewAIResult(value, { label = 'Profile image review', stage = 'review' } = {}) {
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch (error) {
    const reviewError = new Error(`${label}: ${stage} returned malformed JSON and was not saved as complete.`);
    reviewError.status = 502;
    reviewError.cause = error;
    reviewError.rawPreview = value.slice(0, 500);
    throw reviewError;
  }
}

function validateProfileImageReviewResult(result, payload = {}, { label = 'Profile image review', stage = 'review' } = {}) {
  if (!result || typeof result !== 'object' || Array.isArray(result)) {
    const error = new Error(`${label}: ${stage} returned no structured review object.`);
    error.status = 502;
    throw error;
  }
  const overview = String(result.overview || '').trim();
  const sections = Array.isArray(payload.sections) ? payload.sections : [];
  const sectionItemCount = sections.reduce((count, section) => (
    count + (Array.isArray(result?.[section.key]) ? result[section.key].filter(Boolean).length : 0)
  ), 0);
  const summaryCount = [
    result?.summary_card?.primary_reference_value,
    result?.summary_card?.key_direct_findings,
    result?.summary_card?.key_limitations,
  ].reduce((count, items) => count + (Array.isArray(items) ? items.filter(Boolean).length : 0), 0);
  const annotatedCount = Array.isArray(result.annotated_images) ? result.annotated_images.length : 0;
  const findingCount = Array.isArray(result.image_region_findings) ? result.image_region_findings.length : 0;
  const usefulCount = sectionItemCount + summaryCount + annotatedCount + findingCount;
  const refusalOrErrorText = /\b(?:i cannot|i can'?t|unable to|as an ai|policy|malformed json|error|failed|insufficient credits)\b/i.test(overview);
  if (!overview || overview.length < 24 || usefulCount < 1 || refusalOrErrorText) {
    const error = new Error(`${label}: ${stage} did not return enough usable structured review content, so it was not marked complete.`);
    error.status = 502;
    error.validation = {
      overviewLength: overview.length,
      usefulCount,
      sectionItemCount,
      summaryCount,
      annotatedCount,
      findingCount,
      refusalOrErrorText,
    };
    throw error;
  }
  return result;
}

function safeProviderError(error, options = {}) {
  return classifyProviderError(error, {
    defaultProvider: 'anthropic',
    ...options,
  });
}

function shouldRetainJobPayloadForRetry(error) {
  const category = safeProviderError(error)?.category;
  return [
    'insufficient_credits',
    'rate_limit',
    'provider_unavailable',
    'timeout',
    'output_truncation',
  ].includes(category);
}

function cleanFallbackReviewText(value = '') {
  return cleanProfileImageReviewText(String(value || '')
    .replace(/\bThis batch does not include[^.]*\.?\s*/gi, '')
    .replace(/\bThis image set does not include[^.]*\.?\s*/gi, '')
    .replace(/\bNo (?:whole-body|full-body|torso|standing|posterior|anterior|lateral|upper limb|lower limb|foot|feet)[^.]*?(?:in this batch|in this image set|were included|were provided)[^.]*\.?\s*/gi, '')
    .replace(/\bnot visible in this batch\.?\s*/gi, '')
    .replace(/\bnot provided in this batch\.?\s*/gi, '')
    .replace(/\bnot included in this batch\.?\s*/gi, '')
    .replace(/\bdeferred to (?:another|subsequent|later) batch[^.]*\.?\s*/gi, '')
    .replace(/\b(?:bladder neck|prostate|internal sphincters?|urethral course|pelvic floor musculature|internal rectal structures?|internal hemorrhoids?)[^.]*?(?:not visible|not visualized|not assessable|not assessed)[^.]*\.?\s*/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim());
}

function isLowValueFallbackReviewText(value = '') {
  const raw = String(value || '').replace(/\s+/g, ' ').trim();
  const text = cleanFallbackReviewText(raw);
  if (!text) return true;
  if (/^batch\s+\d+\s+of\s+\d+/i.test(raw) || /^this is batch\s+\d+/i.test(raw)) return true;
  if (/\bthis\s+batch\s+does\s+not\s+include\b/i.test(raw)) return true;
  if (/\bthis\s+image\s+set\s+does\s+not\s+include\b/i.test(raw)) return true;
  if (/\b(?:not\s+provided|not\s+included|not\s+attached)\s+in\s+this\s+batch\b/i.test(raw)) return true;
  const absenceLanguage = /\b(?:not visible|not assessable|cannot be assessed|deferred to|not available|not present in this batch|not provided in this batch|not included in this batch|missing .*views?)\b/i.test(raw);
  const usefulVisibleClaim = /\b(?:is visible|are visible|appears|show|shows|clearly visible|consistent with|scattered|level|symmetric|flat on floor|projects|flaccid|foreskin|raphe|perineal|scrot|abdomen|feet|shoulders|spine|skin)\b/i.test(raw);
  return absenceLanguage && !usefulVisibleClaim;
}

function uniqueFallbackReviewItems(items = [], limit = 14) {
  return dedupeProfileImageReviewItems(
    items.filter((item) => !isLowValueFallbackReviewText(item)).map(cleanFallbackReviewText),
    { limit },
  );
}

function fallbackAssembleProfileImageReview(payload = {}, batchResults = []) {
  const sections = Array.isArray(payload.sections) ? payload.sections : [];
  const result = {
    overview: payload.fallbackOverview || `${payload.reviewTitle || 'Profile image review'} visible anatomy review.`,
    summary_card: {
      baseline_quality: '',
      coverage: '',
      primary_reference_value: [],
      key_direct_findings: [],
      key_limitations: [],
      evidence_note: '',
    },
    annotated_images: [],
    image_region_findings: [],
  };
  for (const section of sections) result[section.key] = [];

  const seenImages = new Set();
  const seenFindings = new Set();
  for (const batch of batchResults) {
    const parsed = parseAIResult(batch) || {};
    const card = parsed.summary_card || {};
    for (const key of ['primary_reference_value', 'key_direct_findings', 'key_limitations']) {
      if (Array.isArray(card[key])) {
        result.summary_card[key].push(...card[key].filter(Boolean));
      }
    }
    for (const section of sections) {
      if (Array.isArray(parsed[section.key])) {
        result[section.key].push(...parsed[section.key].filter(Boolean));
      }
    }
    if (Array.isArray(parsed.annotated_images)) {
      for (const image of parsed.annotated_images) {
        const id = image?.image_id || JSON.stringify(image);
        if (seenImages.has(id)) continue;
        seenImages.add(id);
        result.annotated_images.push(image);
      }
    }
    if (Array.isArray(parsed.image_region_findings)) {
      for (const finding of parsed.image_region_findings) {
        const id = finding?.finding_id || `${finding?.image_id || ''}:${finding?.label || ''}:${finding?.finding || ''}`;
        if (seenFindings.has(id)) continue;
        seenFindings.add(id);
        result.image_region_findings.push(finding);
      }
    }
  }

  result.summary_card.primary_reference_value = uniqueFallbackReviewItems(result.summary_card.primary_reference_value, 12);
  result.summary_card.key_direct_findings = uniqueFallbackReviewItems(result.summary_card.key_direct_findings, 16);
  result.summary_card.key_limitations = uniqueFallbackReviewItems(result.summary_card.key_limitations, 6);
  for (const section of sections) {
    result[section.key] = uniqueFallbackReviewItems(result[section.key], /missing|optional|request|limit/i.test(section.key) ? 6 : 18);
  }
  return cleanupProfileImageReviewResult(result, { sections });
}

registerJobHandler('profile_image_review_full', async (payload, context) => {
  const originalPayload = payload || {};
  payload = await resolvePayload(originalPayload);
  payload = prepareLongitudinalProfileReviewPayload(payload, context);
  const label = payload?.label || 'Profile image review';
  const batchRequests = Array.isArray(payload?.batchRequests) ? payload.batchRequests : [];
  const total = Math.max(1, batchRequests.length + (payload?.synthesisRequest ? 1 : 0));
  let cleanupPayload = true;

  try {
    context.updateProgress({
      phase: 'queued',
      current: 0,
      total,
      message: `${label}: running fully in the desktop background…`,
    });

    if (!batchRequests.length) {
      const singleRequest = await hydrateRequestImageRefs(payload?.singleRequest, context, label);
      try {
        const result = await runInternalAIRequest(singleRequest, context, label, {
          phase: 'single_review',
          current: 1,
          total,
          message: `${label}: running Sarah review…`,
        });
        const parsed = validateProfileImageReviewResult(
          parseProfileImageReviewAIResult(result, { label, stage: 'single review' }),
          payload,
          { label, stage: 'single review' },
        );
        return persistCompletedProfileImageReviewResult(parsed, payload, context);
      } catch (error) {
        const cleanErrorMessage = friendlyJobErrorMessage(error);
        const providerError = safeProviderError(error, { requestStage: 'single_review', jobId: context.jobId });
        context.updateProgress({
          phase: 'error',
          current: 1,
          total,
          message: cleanErrorMessage,
          provider_error: providerError,
          error_raw: error?.message || String(error),
        });
        const cleanError = new Error(cleanErrorMessage);
        cleanError.cause = error;
        throw cleanError;
      }
    }

    const preservedBatchResults = Array.isArray(context.getProgress?.().completed_batch_results)
      ? context.getProgress().completed_batch_results
      : [];
    const batchResults = preservedBatchResults
      .map((result) => validateProfileImageReviewResult(
        parseProfileImageReviewAIResult(result, { label, stage: 'preserved batch review' }),
        payload,
        { label, stage: 'preserved batch review' },
      ))
      .slice(0, batchRequests.length);
    if (batchResults.length) {
      context.updateProgress({
        phase: 'resume_preserved_batches',
        current: batchResults.length,
        total,
        message: `${label}: resuming with ${batchResults.length} preserved batch${batchResults.length === 1 ? '' : 'es'} already complete.`,
        batch_current: batchResults.length,
        batch_total: batchRequests.length,
        completed_batch_count: batchResults.length,
        completed_batch_results: batchResults,
      });
    }
    for (let index = batchResults.length; index < batchRequests.length; index += 1) {
      const batchNumber = index + 1;
      const batchLabel = `${label} batch ${batchNumber}/${batchRequests.length}`;
      if (shouldSkipPreviouslyExhaustedRefusalBatch(context.getProgress?.(), batchNumber)) {
        context.updateProgress({
          phase: 'batch_provider_refusal_skipped',
          current: batchNumber,
          total,
          message: `${label}: batch ${batchNumber}/${batchRequests.length} already exhausted its clinical metadata retry; continuing with preserved findings and the longitudinal chart.`,
          batch_current: batchNumber,
          batch_total: batchRequests.length,
          completed_batch_count: batchResults.length,
          completed_batch_results: batchResults,
          provider_skipped_batch_numbers: [batchNumber],
          provider_skipped_batch_count: 1,
        });
        continue;
      }
      const expandedBatchRequest = materializeProfileReviewBatchRequest(
        batchRequests[index],
        payload?.sharedBatchPromptContext,
      );
      const batchRequest = await hydrateRequestImageRefs(expandedBatchRequest, context, batchLabel);
      let result;
      try {
        result = await runInternalAIRequest(batchRequest, context, batchLabel, {
          phase: 'batch_review',
          current: index,
          total,
          message: `${label}: Sarah batch ${batchNumber}/${batchRequests.length} running…`,
        });
      } catch (error) {
        if (error?.clinicalMetadataRetryRefused) {
          const skippedBatchNumbers = [
            ...(Array.isArray(context.getProgress?.().provider_skipped_batch_numbers)
              ? context.getProgress().provider_skipped_batch_numbers
              : []),
            batchNumber,
          ].filter((value, position, values) => values.indexOf(value) === position);
          context.updateProgress({
            phase: 'batch_provider_refusal_skipped',
            current: batchNumber,
            total,
            message: `${label}: provider refused batch ${batchNumber}/${batchRequests.length} after one clinical metadata retry; continuing with preserved findings and the longitudinal chart.`,
            batch_current: batchNumber,
            batch_total: batchRequests.length,
            completed_batch_count: batchResults.length,
            completed_batch_results: batchResults,
            provider_skipped_batch_numbers: skippedBatchNumbers,
            provider_skipped_batch_count: skippedBatchNumbers.length,
          });
          continue;
        }
        const cleanErrorMessage = friendlyJobErrorMessage(error);
        const providerError = safeProviderError(error, { requestStage: 'batch_review', jobId: context.jobId });
        if (batchResults.length) {
          context.updateProgress({
            phase: 'batch_failed_partial_preserved',
            current: batchNumber,
            total,
            message: `${label}: stopped at batch ${batchNumber}/${batchRequests.length}; ${batchResults.length} completed batch${batchResults.length === 1 ? '' : 'es'} preserved for local recovery.`,
            batch_current: batchNumber,
            batch_total: batchRequests.length,
            completed_batch_count: batchResults.length,
            completed_batch_results: batchResults,
            batch_error_message: cleanErrorMessage,
            provider_error: providerError,
            batch_error_raw: error?.message || String(error),
          });
        }
        const cleanError = new Error(cleanErrorMessage);
        cleanError.cause = error;
        throw cleanError;
      }
      batchResults.push(validateProfileImageReviewResult(
        parseProfileImageReviewAIResult(result, { label: batchLabel, stage: 'batch review' }),
        payload,
        { label: batchLabel, stage: 'batch review' },
      ));
      context.updateProgress({
        phase: 'batch_complete',
        current: batchNumber,
        total,
        message: `${label}: completed batch ${batchNumber}/${batchRequests.length}.`,
        batch_current: batchNumber,
        batch_total: batchRequests.length,
        completed_batch_count: batchResults.length,
        completed_batch_results: batchResults,
      });
    }

    if (payload?.synthesisRequest) {
      try {
        const synthesisPrompt = `${payload.synthesisRequest.promptPrefix || ''}\n${JSON.stringify(batchResults, null, 2)}\n${payload.synthesisRequest.promptSuffix || ''}`;
        const result = await runInternalAIRequest({
          ...payload.synthesisRequest,
          prompt: synthesisPrompt,
          images: [],
        }, context, `${label} final synthesis`, {
          phase: 'final_synthesis',
          current: batchRequests.length,
          total,
          message: `${label}: synthesizing final review from completed batches…`,
        });
        const parsed = validateProfileImageReviewResult(
          parseProfileImageReviewAIResult(result, { label, stage: 'final synthesis' }),
          payload,
          { label, stage: 'final synthesis' },
        );
        return persistCompletedProfileImageReviewResult(parsed, payload, context);
      } catch (error) {
        const providerError = safeProviderError(error, {
          requestStage: 'final_synthesis',
          jobId: context.jobId,
          preservedArtifacts: ['completed_image_review_batches'],
        });
        context.updateProgress({
          phase: 'fallback_assembly',
          current: total,
          total,
          message: providerError.category === 'insufficient_credits'
            ? `${label}: Anthropic credits are unavailable; completed image-review batches were preserved.`
            : `${label}: final synthesis failed, preserving completed batch findings…`,
          provider_error: providerError,
          synthesis_error: error?.message || String(error),
        });
        const assembled = fallbackAssembleProfileImageReview(payload, batchResults);
        assembled._background_attempt_status = {
          state: 'final_synthesis_failed_batch_findings_preserved',
          timestamp: new Date().toISOString(),
          error_message: error?.message || String(error),
          provider_error: providerError,
          batch_reviews_completed: true,
          batch_count: batchResults.length,
          final_synthesis_attempted: true,
        };
        return persistCompletedProfileImageReviewResult(assembled, payload, context);
      }
    }

    return persistCompletedProfileImageReviewResult(fallbackAssembleProfileImageReview(payload, batchResults), payload, context);
  } catch (error) {
    cleanupPayload = !shouldRetainJobPayloadForRetry(error);
    if (!cleanupPayload) {
      const providerError = safeProviderError(error, { requestStage: 'profile_image_review_full', jobId: context.jobId });
      context.updateProgress({
        retryable: true,
        payload_ref_retained: Boolean(originalPayload?.__payloadRef),
        provider_error: providerError,
        message: `${providerError.userMessage || friendlyJobErrorMessage(error)} Saved payload retained for retry.`,
      });
    }
    throw error;
  } finally {
    if (cleanupPayload) await cleanupPayloadRef(originalPayload);
  }
});

registerJobHandler('local_vision_analyze_window', async (payload, context) => {
  context.updateProgress({
    phase: 'preparing',
    current: 0,
    total: 4,
    message: 'Preparing local-only visual analysis...',
    privacy: { localOnly: true, cloudUpload: false },
  });
  return analyzeLocalVisionWindow(payload, {
    signal: context.signal,
    onProgress: context.updateProgress,
  });
});

registerJobHandler('local_vision_analyze_continuous', async (payload, context) => {
  context.updateProgress({
    phase: 'preparing',
    current: 0,
    total: 6,
    message: 'Preparing continuous local Qwen visual analysis...',
    privacy: { localOnly: true, cloudUpload: false },
  });
  return analyzeLocalVisionContinuous(payload, {
    signal: context.signal,
    onProgress: context.updateProgress,
  });
});

registerJobHandler('local_vision_analyze_adaptive', async (payload, context) => {
  context.updateProgress({
    phase: 'preparing',
    current: 0,
    total: 6,
    message: 'Preparing adaptive local vision analysis...',
    privacy: { localOnly: true, cloudUpload: false },
  });
  return analyzeLocalVisionAdaptive(payload, {
    signal: context.signal,
    onProgress: context.updateProgress,
  });
});

registerJobHandler('local_vision_analyze_forward', async (payload, context) => {
  context.updateProgress({
    phase: 'preparing',
    current: 0,
    total: 6,
    message: 'Preparing forward local vision review...',
    privacy: { localOnly: true, cloudUpload: false },
    workflow: 'local_vision_forward_review',
  });
  return analyzeLocalVisionForward(payload, {
    signal: context.signal,
    onProgress: context.updateProgress,
  });
});

registerJobHandler('local_vision_ask_video', async (payload, context) => {
  context.updateProgress({
    phase: 'preparing',
    current: 0,
    total: 4,
    message: 'Preparing local Qwen video Q&A...',
    privacy: { localOnly: true, cloudUpload: false },
  });
  return askLocalVisionVideo(payload, {
    signal: context.signal,
    onProgress: context.updateProgress,
  });
});

function startJobFromBody(body, res) {
  try {
    const { type, payload = {}, meta = {} } = body || {};
    if (!type) return res.status(400).json({ error: 'Job type is required' });
    const job = createJob(type, payload, meta);
    res.status(202).json(job);
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message || String(error) });
  }
}

jobsRouter.post('/start', (req, res) => {
  startJobFromBody(req.body, res);
});

largeJobsRouter.post('/', express.raw({ type: 'application/json', limit: process.env.BACKGROUND_JOB_LARGE_BODY_LIMIT || '250mb' }), async (req, res) => {
  let saved = null;
  try {
    const body = JSON.parse(req.body?.toString('utf8') || '{}');
    const { type, payload = {}, meta = {} } = body || {};
    if (!type) return res.status(400).json({ error: 'Job type is required' });
    saved = await saveJobPayload(payload);
    if (!type || !payload || !saved?.id) throw new Error('Invalid large job payload');
    if (type && !['profile_image_review_full', 'ai_invoke', 'tts_export', 'session_review_video', 'profile_anatomy_video'].includes(type) && !String(type).startsWith('local_vision_')) {
      throw new Error(`Unknown background job type: ${type}`);
    }
    startJobFromBody({
      type,
      payload: { __payloadRef: saved.id },
      meta: {
        ...meta,
        payload_ref: saved.id,
        payload_handoff: 'file',
      },
    }, res);
  } catch (error) {
    await deleteJobPayload(saved?.id);
    res.status(error.status || 400).json({ error: error.message || String(error) });
  }
});

jobsRouter.get('/', (req, res) => {
  try {
    const { type, status, limit, metaSessionId, metaSource, includeCleared } = req.query || {};
    const meta = {};
    if (metaSessionId) meta.sessionId = metaSessionId;
    if (metaSource) meta.source = metaSource;
    res.json({
      jobs: listJobs({
        type,
        status,
        limit,
        meta,
        includeCleared: includeCleared === 'true',
      }),
    });
  } catch (error) {
    res.status(400).json({ error: error.message || String(error) });
  }
});

jobsRouter.post('/clear', (_req, res) => {
  res.json(clearJobs());
});

jobsRouter.post('/:jobId/retry', (req, res) => {
  try {
    const job = retryJob(req.params.jobId, req.body || {});
    if (!job) return res.status(404).json({ error: 'Job not found' });
    res.status(202).json(job);
  } catch (error) {
    res.status(error.status || 400).json({ error: error.message || String(error) });
  }
});

jobsRouter.get('/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});

jobsRouter.post('/:jobId/cancel', (req, res) => {
  const job = cancelJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  res.json(job);
});
