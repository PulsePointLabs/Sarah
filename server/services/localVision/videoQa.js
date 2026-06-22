import { normalizeVideoQaRequest } from './schema.js';
import { sampleLocalVisionFrames } from './frameSampler.js';
import { askLocalQwenVideo } from './localVisionClient.js';
import { saveLocalVisionResult } from './persistence.js';
import { getTrustedRecordAndVideo } from './analyzeWindow.js';

function normalizeAnswer(answer, frames) {
  const frameIds = new Set(frames.map((frame) => frame.frame_id));
  const frameRefs = (Array.isArray(answer?.frame_refs) ? answer.frame_refs : [])
    .map(String)
    .filter((id) => frameIds.has(id));
  const confidence = Number(answer?.confidence);
  return {
    short_answer: String(answer?.short_answer || 'The local visual evidence is insufficient to answer that confidently.').trim(),
    confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.25,
    basis: String(answer?.basis || 'Answer constrained to sampled local frames.').trim(),
    limitations: Array.isArray(answer?.limitations) ? answer.limitations.map(String) : [],
    frame_refs: frameRefs,
    timeline_event_refs: Array.isArray(answer?.timeline_event_refs) ? answer.timeline_event_refs.map(String) : [],
  };
}

function normalizeSupportingEvidence(value = {}, frames = []) {
  return {
    visible_objects: Array.isArray(value.visible_objects) ? value.visible_objects : [],
    visible_actions: Array.isArray(value.visible_actions) ? value.visible_actions : [],
    fluid_dynamics: Array.isArray(value.fluid_dynamics) ? value.fluid_dynamics : [],
    frame_evidence: Array.isArray(value.frame_evidence)
      ? value.frame_evidence
      : frames.map((frame) => ({
        frame_id: frame.frame_id,
        time_ms: frame.time_ms,
        image_path: frame.image_path,
        observations: [],
      })),
  };
}

export async function askLocalVisionVideo(body, { signal, onProgress } = {}) {
  const request = normalizeVideoQaRequest(body);
  if (!request.sessionId) {
    const error = new Error('sessionId is required for local video Q&A.');
    error.status = 400;
    throw error;
  }
  if (!request.videoPath) {
    const error = new Error('videoPath is required for local video Q&A.');
    error.status = 400;
    throw error;
  }

  onProgress?.({ phase: 'validating', current: 0, total: 4, message: 'Validating linked local video...' });
  const { video } = getTrustedRecordAndVideo(request);

  onProgress?.({ phase: 'sampling', current: 1, total: 4, message: 'Sampling local visual evidence for question...' });
  const sampled = await sampleLocalVisionFrames({
    videoPath: video.path,
    sessionId: request.sessionId,
    startMs: request.startMs,
    endMs: request.endMs,
    samplePolicy: {
      fps: request.evidencePolicy.baselineFps,
      maxFrames: request.evidencePolicy.maxScanFrames,
      dedupe: request.evidencePolicy.dedupe,
      thumbnailWidth: request.evidencePolicy.thumbnailWidth,
    },
  });
  if (signal?.aborted) throw new Error('Cancelled');

  onProgress?.({ phase: 'answering', current: 2, total: 4, message: 'Asking local Qwen using frame evidence only...' });
  const local = await askLocalQwenVideo({
    question: request.question,
    frames: sampled.frames,
    recordType: request.recordType,
    knownTimeline: request.knownTimeline,
    telemetryContext: request.telemetryContext,
    scaleCalibration: request.scaleCalibration,
    signal,
  });
  const answer = normalizeAnswer(local.answer, sampled.frames);
  if (!answer.frame_refs.length && answer.confidence > 0.4) {
    answer.confidence = 0.35;
    answer.limitations.push('The local model did not cite frame references, so confidence was capped.');
  }

  onProgress?.({ phase: 'assembling', current: 3, total: 4, message: 'Assembling local video Q&A evidence...' });
  const result = {
    ok: true,
    engine: request.engine,
    model: local.model,
    privacy: { localOnly: true, cloudUpload: false },
    range: { startMs: request.startMs, endMs: request.endMs },
    question: request.question,
    telemetry_context: request.telemetryContext || null,
    answer,
    supporting_evidence: normalizeSupportingEvidence(local.supporting_evidence, sampled.frames),
    forbidden_or_not_visible: local.forbidden_or_not_visible,
    warnings: [...sampled.warnings, ...local.warnings],
    limitations: [
      'Answer is constrained to local sampled frames and local timeline evidence.',
      'Notes/procedure text are not used as visual evidence.',
    ],
  };
  const saved = saveLocalVisionResult({
    request,
    videoPath: video.path,
    engine: request.engine,
    analysisType: 'qa',
    result,
  });
  onProgress?.({ phase: 'complete', current: 4, total: 4, message: 'Local video Q&A complete.' });
  return { ...result, id: saved.id, created_at: saved.created_at };
}
