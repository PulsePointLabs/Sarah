import express from 'express';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { cancelJob, clearJobs, createJob, getJob, listJobs, registerJobHandler } from '../services/jobQueue.js';
import { renderTTSExport } from '../services/ttsRenderer.js';
import { renderSessionReviewVideo } from '../services/sessionReviewVideoRenderer.js';
import { renderProfileAnatomyVideo } from '../services/profileAnatomyVideoRenderer.js';
import { aiInvokeInternal } from './internalAi.js';
import { uploadDir } from '../config.js';
import { startAIForensicCapture } from '../services/aiForensics.js';
import { analyzeLocalVisionWindow } from '../services/localVision/analyzeWindow.js';
import { analyzeLocalVisionContinuous } from '../services/localVision/continuousAnalyzer.js';
import { analyzeLocalVisionAdaptive } from '../services/localVision/adaptiveAnalyzer.js';
import { analyzeLocalVisionForward } from '../services/localVision/forwardAnalyzer.js';
import { askLocalVisionVideo } from '../services/localVision/videoQa.js';
import { resolveCachedFramePath } from '../services/localVision/frameSampler.js';
import { deleteJobPayload, loadJobPayload, saveJobPayload } from '../services/jobPayloadStore.js';
import {
  cleanProfileImageReviewText,
  cleanupProfileImageReviewResult,
  dedupeProfileImageReviewItems,
} from '../../src/lib/profileImageReviewCleanup.js';

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
  const filename = path.basename(decodeURIComponent(pathname.replace(/^\/uploads\//, '')));
  return filename ? path.join(uploadDir, filename) : '';
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
  return result;
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
    context.updateProgress({
      phase: 'retrying',
      current: step.current ?? 0,
      total: step.total ?? 1,
      message: `${label}: response was incomplete, retrying with a larger output budget…`,
      retry_reason: message.slice(0, 240),
      max_tokens: retryMaxTokens,
    });
    return aiInvokeInternal({
      prompt,
      response_json_schema,
      model,
      max_tokens: retryMaxTokens,
      temperature,
      schema_mode,
      images,
      invocationAttempt: 2,
      signal: context.signal,
    });
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
  const label = payload?.label || 'Profile image review';
  const batchRequests = Array.isArray(payload?.batchRequests) ? payload.batchRequests : [];
  const total = Math.max(1, batchRequests.length + (payload?.synthesisRequest ? 1 : 0));

  try {
    context.updateProgress({
      phase: 'queued',
      current: 0,
      total,
      message: `${label}: running fully in the desktop background…`,
    });

    if (!batchRequests.length) {
      const singleRequest = await hydrateRequestImageRefs(payload?.singleRequest, context, label);
      const result = await runInternalAIRequest(singleRequest, context, label, {
        phase: 'single_review',
        current: 1,
        total,
        message: `${label}: running Sarah review…`,
      });
      return parseAIResult(result);
    }

    const batchResults = [];
    for (let index = 0; index < batchRequests.length; index += 1) {
      const batchNumber = index + 1;
      const batchLabel = `${label} batch ${batchNumber}/${batchRequests.length}`;
      const batchRequest = await hydrateRequestImageRefs(batchRequests[index], context, batchLabel);
      const result = await runInternalAIRequest(batchRequest, context, batchLabel, {
        phase: 'batch_review',
        current: index,
        total,
        message: `${label}: Sarah batch ${batchNumber}/${batchRequests.length} running…`,
      });
      batchResults.push(parseAIResult(result));
      context.updateProgress({
        phase: 'batch_complete',
        current: batchNumber,
        total,
        message: `${label}: completed batch ${batchNumber}/${batchRequests.length}.`,
        batch_current: batchNumber,
        batch_total: batchRequests.length,
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
        return parseAIResult(result);
      } catch (error) {
        context.updateProgress({
          phase: 'fallback_assembly',
          current: total,
          total,
          message: `${label}: final synthesis failed, preserving completed batch findings…`,
          synthesis_error: error?.message || String(error),
        });
        const assembled = fallbackAssembleProfileImageReview(payload, batchResults);
        assembled._background_attempt_status = {
          state: 'final_synthesis_failed_batch_findings_preserved',
          timestamp: new Date().toISOString(),
          error_message: error?.message || String(error),
          batch_reviews_completed: true,
          batch_count: batchResults.length,
          final_synthesis_attempted: true,
        };
        return assembled;
      }
    }

    return fallbackAssembleProfileImageReview(payload, batchResults);
  } finally {
    await cleanupPayloadRef(originalPayload);
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
