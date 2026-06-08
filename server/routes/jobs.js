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

export const jobsRouter = express.Router();

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

jobsRouter.post('/start', (req, res) => {
  try {
    const { type, payload = {}, meta = {} } = req.body || {};
    if (!type) return res.status(400).json({ error: 'Job type is required' });
    const job = createJob(type, payload, meta);
    res.status(202).json(job);
  } catch (error) {
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
