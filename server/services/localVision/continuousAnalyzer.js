import { normalizeContinuousVisionRequest } from './schema.js';
import { sampleLocalVisionFrames } from './frameSampler.js';
import { callLocalQwenBatch } from './localVisionClient.js';
import { deriveLocalVisionResult } from './stateMachine.js';
import { saveLocalVisionResult } from './persistence.js';
import { getTrustedRecordAndVideo } from './analyzeWindow.js';

function chunks(items, size) {
  const out = [];
  for (let index = 0; index < items.length; index += size) out.push(items.slice(index, index + size));
  return out;
}

function uniqueBy(items, keyFn) {
  const seen = new Set();
  const out = [];
  for (const item of items || []) {
    const key = keyFn(item);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function eventKey(event) {
  return `${event.event_type || event.eventType}:${event.label}:${Math.round(Number(event.start_ms ?? event.time_ms ?? 0) / 1000)}`;
}

function mmssFromMs(ms) {
  const totalSeconds = Math.max(0, Math.round(Number(ms || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

function promoteEvent(event, index, fallbackStart, fallbackEnd) {
  const start = Number(event.start_ms ?? event.time_ms ?? fallbackStart ?? 0);
  const end = Number(event.end_ms ?? event.time_ms ?? fallbackEnd ?? start);
  return {
    event_id: event.event_id || `evt_${String(index + 1).padStart(3, '0')}`,
    start_ms: Math.max(0, Math.round(start)),
    end_ms: Math.max(Math.round(start), Math.round(end)),
    event_type: event.event_type || 'stage_candidate',
    label: event.label || event.stage || 'Visible evidence event',
    confidence: event.confidence || 0.25,
    source: event.source || 'scan',
    frame_refs: event.frame_refs || (event.frame_ref ? [event.frame_ref] : []),
    basis: event.basis || event.reason || 'Derived from local visual evidence.',
  };
}

function stateSegmentsFromStages(stageCandidates) {
  return uniqueBy(stageCandidates, (stage) => `${stage.stage}:${(stage.frame_refs || []).join(',')}`)
    .filter((stage) => stage.stage !== 'unknown')
    .map((stage) => ({
      start_ms: stage.start_ms ?? null,
      end_ms: stage.end_ms ?? null,
      state: stage.stage,
      confidence: stage.confidence,
      frame_refs: stage.frame_refs || [],
      basis: stage.basis,
    }));
}

function mergeFluidDynamics(results) {
  const confirmed = results.map((result) => result.fluid_dynamics).filter((item) => item?.release_detected === 'visible');
  if (!confirmed.length) {
    return results.find((result) => result.fluid_dynamics)?.fluid_dynamics || {
      release_detected: 'not_visible',
      onset_ms: null,
      duration_ms: null,
      pulse_count: null,
      max_projected_distance_px: null,
      max_projected_distance_cm: null,
      trajectory_angle_degrees: null,
      velocity_proxy_px_per_sec: null,
      velocity_proxy_cm_per_sec: null,
      volume_proxy: 'none',
      confidence: 0.2,
      frame_refs: [],
      limitations: ['No visible fluid event was confirmed.'],
    };
  }
  return {
    ...confirmed.sort((a, b) => (b.confidence || 0) - (a.confidence || 0))[0],
    frame_refs: uniqueBy(confirmed.flatMap((item) => item.frame_refs || []), (id) => id),
    limitations: uniqueBy(confirmed.flatMap((item) => item.limitations || []), (text) => text),
  };
}

async function analyzeFrameBatch({ request, frames, questions, modelRef, warnings, signal, source }) {
  const extracted = await callLocalQwenBatch({
    questions,
    frames,
    recordType: request.recordType,
    signal,
  });
  if (extracted.model) modelRef.current = extracted.model;
  warnings.push(...extracted.warnings);
  const startMs = frames[0]?.time_ms ?? request.startMs;
  const endMs = frames[frames.length - 1]?.time_ms ?? request.endMs;
  const batchResult = deriveLocalVisionResult({
    request: { ...request, startMs, endMs },
    frames,
    questions,
    answers: extracted.answers,
    engine: request.engine,
    model: extracted.model,
    warnings: [],
  });
  return {
    ...batchResult,
    timeline_events: (batchResult.timeline_events || []).map((event) => ({ ...event, source })),
    stage_candidates: (batchResult.stage_candidates || []).map((stage) => ({ ...stage, start_ms: startMs, end_ms: endMs, source })),
  };
}

function shouldRefineEvent(event, refinementPolicy) {
  if (!refinementPolicy.enabled) return false;
  if (!refinementPolicy.eventTypes?.length) return true;
  const text = `${event.event_type || ''} ${event.label || ''}`.toLowerCase();
  return refinementPolicy.eventTypes.some((type) => text.includes(String(type).toLowerCase()));
}

export async function analyzeLocalVisionContinuous(body, { signal, onProgress } = {}) {
  const request = normalizeContinuousVisionRequest(body);
  if (!request.sessionId) {
    const error = new Error('sessionId is required for continuous local vision analysis.');
    error.status = 400;
    throw error;
  }
  if (!request.videoPath) {
    const error = new Error('videoPath is required for continuous local vision analysis.');
    error.status = 400;
    throw error;
  }

  onProgress?.({ phase: 'validating', current: 0, total: 6, message: 'Validating linked local video...' });
  const { video } = getTrustedRecordAndVideo(request);

  onProgress?.({ phase: 'sampling', current: 1, total: 6, message: 'Sampling continuous local frame pass...' });
  const sampled = await sampleLocalVisionFrames({
    videoPath: video.path,
    sessionId: request.sessionId,
    startMs: request.startMs,
    endMs: request.endMs,
    samplePolicy: {
      fps: request.scanPolicy.baselineFps,
      maxFrames: request.scanPolicy.maxScanFrames,
      dedupe: request.scanPolicy.dedupe,
      thumbnailWidth: request.scanPolicy.thumbnailWidth,
    },
    onProgress: (progress) => onProgress?.({
      current: progress.current ?? 1,
      total: progress.total ?? 6,
      ...progress,
    }),
  });
  if (signal?.aborted) throw new Error('Cancelled');

  const warnings = [...sampled.warnings];
  if (request.scanPolicy.includeMotionPeaks) warnings.push('Motion-peak frame insertion is not enabled yet; baseline sampled frames were analyzed.');
  if (request.scanPolicy.includeSceneChanges) warnings.push('Scene-change frame insertion is not enabled yet; baseline sampled frames were analyzed.');

  const modelRef = { current: null };
  const scanResults = [];
  const batches = chunks(sampled.frames, request.scanPolicy.batchSize);
  for (let index = 0; index < batches.length; index += 1) {
    onProgress?.({
      phase: 'scanning',
      current: index + 1,
      total: batches.length,
      eta_current: index,
      eta_total: Math.max(1, batches.length),
      message: `Running local Qwen scan batch ${index + 1}/${batches.length}...`,
      frame_count: batches[index].length,
      scanned_frames: scanResults.reduce((sum, result) => sum + (result.frame_evidence?.length || 0), 0),
      candidate_events: scanResults.reduce((sum, result) => sum + (result.timeline_events?.length || 0), 0),
    });
    const batchResult = await analyzeFrameBatch({
      request,
      frames: batches[index],
      questions: request.questions,
      modelRef,
      warnings,
      signal,
      source: 'scan',
    });
    scanResults.push(batchResult);
    onProgress?.({
      phase: 'scanning',
      current: index + 1,
      total: batches.length,
      eta_current: index + 1,
      eta_total: Math.max(1, batches.length),
      message: `Scanned Qwen batch ${index + 1}/${batches.length}: ${batchResult.timeline_events?.length || 0} gated events, ${batchResult.forbidden_or_not_visible?.length || 0} blocked claims.`,
      frame_count: batches[index].length,
      scanned_frames: scanResults.reduce((sum, result) => sum + (result.frame_evidence?.length || 0), 0),
      candidate_events: scanResults.reduce((sum, result) => sum + (result.timeline_events?.length || 0), 0),
      blocked_claims: scanResults.reduce((sum, result) => sum + (result.forbidden_or_not_visible?.length || 0), 0),
      latest_summary: batchResult.summary,
    });
  }

  const candidateEvents = uniqueBy(scanResults.flatMap((result) => result.timeline_events || []), eventKey)
    .filter((event) => Number(event.confidence || 0) >= 0.55)
    .slice(0, 12);
  const refinementTargets = candidateEvents.filter((event) => shouldRefineEvent(event, request.refinementPolicy));
  const refinementResults = [];
  for (let index = 0; index < refinementTargets.length; index += 1) {
    const event = refinementTargets[index];
    const center = Number(event.time_ms ?? event.start_ms ?? request.startMs);
    const startMs = Math.max(request.startMs, center - request.refinementPolicy.preMs);
    const endMs = Math.min(request.endMs, center + request.refinementPolicy.postMs);
    const refinementStepBase = index * 2;
    const refinementEtaTotal = Math.max(1, refinementTargets.length * 2 + 1);
    onProgress?.({
      phase: 'refining',
      current: index + 1,
      total: refinementTargets.length,
      eta_current: refinementStepBase,
      eta_total: refinementEtaTotal,
      refinement_event_current: index + 1,
      refinement_event_total: refinementTargets.length,
      message: `Refining local evidence around ${mmssFromMs(center)} (${index + 1}/${refinementTargets.length})...`,
    });
    const refined = await sampleLocalVisionFrames({
      videoPath: video.path,
      sessionId: request.sessionId,
      startMs,
      endMs,
      samplePolicy: {
        fps: request.refinementPolicy.fps,
        maxFrames: request.refinementPolicy.maxRefinementFramesPerEvent,
        dedupe: true,
        thumbnailWidth: request.scanPolicy.thumbnailWidth,
      },
      onProgress: (progress) => onProgress?.({
        ...progress,
        phase: 'refining',
        eta_current: refinementStepBase,
        eta_total: refinementEtaTotal,
        refinement_event_current: index + 1,
        refinement_event_total: refinementTargets.length,
        message: progress.message?.replace('Sampling', `Refinement ${index + 1}/${refinementTargets.length} sampling`) || `Refinement ${index + 1}/${refinementTargets.length} sampling local frames...`,
      }),
    });
    const refinedBatches = chunks(refined.frames, request.scanPolicy.batchSize);
    for (let batchIndex = 0; batchIndex < refinedBatches.length; batchIndex += 1) {
      const batch = refinedBatches[batchIndex];
      onProgress?.({
        phase: 'refining',
        current: index + 1,
        total: refinementTargets.length,
        eta_current: refinementStepBase + 1 + (batchIndex / Math.max(1, refinedBatches.length)),
        eta_total: refinementEtaTotal,
        refinement_event_current: index + 1,
        refinement_event_total: refinementTargets.length,
        frame_count: batch.length,
        message: `Running local Qwen refinement ${index + 1}/${refinementTargets.length}, batch ${batchIndex + 1}/${refinedBatches.length}...`,
      });
      refinementResults.push(await analyzeFrameBatch({
        request,
        frames: batch,
        questions: request.questions,
        modelRef,
        warnings,
        signal,
        source: 'refinement',
      }));
    }
    onProgress?.({
      phase: 'refining',
      current: index + 1,
      total: refinementTargets.length,
      eta_current: refinementStepBase + 2,
      eta_total: refinementEtaTotal,
      refinement_event_current: index + 1,
      refinement_event_total: refinementTargets.length,
      message: `Refined candidate ${index + 1}/${refinementTargets.length}.`,
    });
  }

  onProgress?.({
    phase: 'assembling',
    current: 1,
    total: 1,
    eta_current: Math.max(1, refinementTargets.length * 2),
    eta_total: Math.max(1, refinementTargets.length * 2 + 1),
    message: 'Assembling unified local visual timeline...',
  });
  const allResults = [...scanResults, ...refinementResults];
  const frameEvidence = uniqueBy(allResults.flatMap((result) => result.frame_evidence || []), (frame) => frame.frame_id);
  const timelineEvents = uniqueBy(allResults.flatMap((result) => result.timeline_events || []), eventKey)
    .map((event, index) => promoteEvent(event, index, request.startMs, request.endMs))
    .sort((a, b) => a.start_ms - b.start_ms);
  const stageCandidates = uniqueBy(allResults.flatMap((result) => result.stage_candidates || []), (stage) => `${stage.stage}:${stage.start_ms}:${(stage.frame_refs || []).join(',')}`)
    .sort((a, b) => (b.confidence || 0) - (a.confidence || 0));
  const visibleObjects = uniqueBy(allResults.flatMap((result) => result.visible_objects || []), (item) => `${item.label}:${item.status}:${(item.frame_refs || []).join(',')}`);
  const visibleActions = uniqueBy(allResults.flatMap((result) => result.visible_actions || []), (item) => `${item.label}:${item.status}:${(item.frame_refs || []).join(',')}`);
  const forbidden = uniqueBy(allResults.flatMap((result) => result.forbidden_or_not_visible || []), (item) => `${item.claim}:${item.reason}`);
  const confidenceValues = allResults.map((result) => result.confidence?.overall).filter(Number.isFinite);
  const confidence = {
    overall: confidenceValues.length ? Number((confidenceValues.reduce((sum, value) => sum + value, 0) / confidenceValues.length).toFixed(2)) : 0.25,
    visibility_quality: frameEvidence.length ? 0.75 : 0.2,
    motion_quality: request.scanPolicy.baselineFps >= 1 ? 0.6 : 0.35,
  };
  const summary = [
    `Continuous local Qwen scan reviewed ${frameEvidence.length} sampled frame${frameEvidence.length === 1 ? '' : 's'} from ${mmssFromMs(request.startMs)} to ${mmssFromMs(request.endMs)}.`,
    timelineEvents.length ? `${timelineEvents.length} gated timeline event${timelineEvents.length === 1 ? '' : 's'} assembled.` : 'No gated timeline event reached confidence; uncertainty preserved.',
    forbidden.length ? `${forbidden.length} unsafe or not-visible claim${forbidden.length === 1 ? '' : 's'} blocked.` : '',
  ].filter(Boolean).join(' ');
  const result = {
    ok: true,
    engine: request.engine,
    model: modelRef.current || { name: 'Qwen/Qwen2.5-VL-7B-Instruct', device: 'unknown', quantization: 'unknown' },
    privacy: { localOnly: true, cloudUpload: false },
    range: { startMs: request.startMs, endMs: request.endMs },
    summary,
    timeline_events: timelineEvents,
    state_segments: stateSegmentsFromStages(stageCandidates),
    stage_candidates: stageCandidates,
    visible_objects: visibleObjects,
    visible_actions: visibleActions,
    forbidden_or_not_visible: forbidden,
    fluid_dynamics: [mergeFluidDynamics(allResults)],
    frame_evidence: frameEvidence.sort((a, b) => Number(a.time_ms || 0) - Number(b.time_ms || 0)),
    confidence,
    warnings: uniqueBy(warnings, (text) => text),
    limitations: [
      'Visual claims are limited to sampled frames and local VLM certainty.',
      'Subjective states such as orgasm, arousal, pain, pleasure, or intent are not inferred.',
    ],
  };
  const saved = saveLocalVisionResult({
    request,
    videoPath: video.path,
    engine: request.engine,
    analysisType: 'continuous',
    result,
  });
  onProgress?.({
    phase: 'complete',
    current: 1,
    total: 1,
    eta_current: Math.max(1, refinementTargets.length * 2 + 1),
    eta_total: Math.max(1, refinementTargets.length * 2 + 1),
    message: 'Continuous local vision analysis complete.',
  });
  return { ...result, id: saved.id, created_at: saved.created_at };
}
