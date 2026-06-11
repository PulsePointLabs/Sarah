import express from 'express';
import { cancelJob, clearJobs, createJob, getJob, listJobs, registerJobHandler } from '../services/jobQueue.js';
import { renderTTSExport } from '../services/ttsRenderer.js';
import { aiInvokeInternal } from './internalAi.js';
import { startAIForensicCapture } from '../services/aiForensics.js';
import { analyzeLocalVisionWindow } from '../services/localVision/analyzeWindow.js';
import { analyzeLocalVisionContinuous } from '../services/localVision/continuousAnalyzer.js';
import { analyzeLocalVisionAdaptive } from '../services/localVision/adaptiveAnalyzer.js';
import { analyzeLocalVisionForward } from '../services/localVision/forwardAnalyzer.js';
import { askLocalVisionVideo } from '../services/localVision/videoQa.js';
import { deleteJobPayload, loadJobPayload, saveJobPayload } from '../services/jobPayloadStore.js';

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

registerJobHandler('tts_export', async (payload, context) => {
  return renderTTSExport(payload, {
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
  return String(value || '')
    .replace(/\bThis batch does not include[^.]*\.?\s*/gi, '')
    .replace(/\bThis image set does not include[^.]*\.?\s*/gi, '')
    .replace(/\bNo (?:whole-body|full-body|torso|standing|posterior|anterior|lateral|upper limb|lower limb|foot|feet)[^.]*?(?:in this batch|in this image set|were included|were provided)[^.]*\.?\s*/gi, '')
    .replace(/\bnot visible in this batch\.?\s*/gi, '')
    .replace(/\bnot provided in this batch\.?\s*/gi, '')
    .replace(/\bnot included in this batch\.?\s*/gi, '')
    .replace(/\bdeferred to (?:another|subsequent|later) batch[^.]*\.?\s*/gi, '')
    .replace(/\b(?:bladder neck|prostate|internal sphincters?|urethral course|pelvic floor musculature|internal rectal structures?|internal hemorrhoids?)[^.]*?(?:not visible|not visualized|not assessable|not assessed)[^.]*\.?\s*/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
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
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (isLowValueFallbackReviewText(item)) continue;
    const text = cleanFallbackReviewText(item);
    const key = text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 180);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(text.length > 900 ? `${text.slice(0, 897).trim()}...` : text);
    if (out.length >= limit) break;
  }
  return out;
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

  result.summary_card.primary_reference_value = uniqueFallbackReviewItems(result.summary_card.primary_reference_value, 10);
  result.summary_card.key_direct_findings = uniqueFallbackReviewItems(result.summary_card.key_direct_findings, 12);
  result.summary_card.key_limitations = uniqueFallbackReviewItems(result.summary_card.key_limitations, 4);
  for (const section of sections) {
    result[section.key] = uniqueFallbackReviewItems(result[section.key], /missing|optional|request|limit/i.test(section.key) ? 5 : 14);
  }
  return result;
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
      const result = await runInternalAIRequest(payload?.singleRequest, context, label, {
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
      const result = await runInternalAIRequest(batchRequests[index], context, `${label} batch ${batchNumber}/${batchRequests.length}`, {
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
    if (type && !['profile_image_review_full', 'ai_invoke', 'tts_export'].includes(type) && !String(type).startsWith('local_vision_')) {
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
    const { type, status, limit, metaSessionId, metaSource } = req.query || {};
    const meta = {};
    if (metaSessionId) meta.sessionId = metaSessionId;
    if (metaSource) meta.source = metaSource;
    res.json({
      jobs: listJobs({
        type,
        status,
        limit,
        meta,
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
