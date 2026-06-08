import { analyzeLocalVisionAdaptive } from './adaptiveAnalyzer.js';
import { normalizeRegionsOfInterest } from './schema.js';

export function normalizeForwardMode(value = 'balanced') {
  const key = String(value || 'balanced').trim().toLowerCase();
  if (key === 'fast' || key === 'fast_preview') return 'fast';
  if (key === 'deep' || key === 'deep_forensic') return 'deep';
  return 'balanced';
}

export function adaptiveModeForForwardMode(value = 'balanced') {
  const mode = normalizeForwardMode(value);
  if (mode === 'fast') return 'fast_preview';
  if (mode === 'deep') return 'deep_forensic';
  return 'balanced';
}

function forwardPhase(phase = '') {
  const key = String(phase || '').toLowerCase();
  if (key === 'cv_prepass') return 'cv_forward_scan';
  if (key === 'candidate_ranking') return 'candidate_detection';
  if (key === 'qwen_review' || key === 'qwen_window_sampling') return 'qwen_verification';
  if (key === 'state_machine') return 'final_timeline';
  return key || 'running';
}

export function buildForwardAdaptiveRequest(body = {}) {
  const mode = normalizeForwardMode(body.mode || body.analysisMode || body.analysis_mode);
  const adaptiveMode = adaptiveModeForForwardMode(mode);
  const forwardPolicy = body.forwardPolicy || body.forward_policy || {};
  const incomingCandidatePolicy = body.candidatePolicy || body.candidate_policy || {};
  const incomingQwenPolicy = body.qwenPolicy || body.qwen_policy || {};
  const maxQwenWindows = Number(forwardPolicy.maxQwenWindows ?? incomingQwenPolicy.maxQwenWindows ?? incomingQwenPolicy.max_qwen_windows);
  const windowSeconds = Math.max(4, Math.min(90, Number(forwardPolicy.windowSeconds || forwardPolicy.window_seconds || 20)));
  const regionsOfInterest = normalizeRegionsOfInterest(body.regionsOfInterest || body.regions_of_interest || []);

  return {
    ...body,
    workflow: 'local_vision_forward_review',
    mode: adaptiveMode,
    candidatePolicy: {
      ...incomingCandidatePolicy,
      baselineFps: forwardPolicy.baselineFps ?? forwardPolicy.baseline_fps ?? incomingCandidatePolicy.baselineFps,
      motionPeakFps: forwardPolicy.motionPeakFps ?? forwardPolicy.motion_peak_fps ?? incomingCandidatePolicy.motionPeakFps,
      maxCandidateWindows: forwardPolicy.maxCandidateWindows
        ?? forwardPolicy.max_candidate_windows
        ?? incomingCandidatePolicy.maxCandidateWindows
        ?? (Number.isFinite(maxQwenWindows) ? Math.max(8, Math.round(maxQwenWindows * 1.5)) : undefined),
      candidateWindowPreMs: incomingCandidatePolicy.candidateWindowPreMs ?? Math.round((windowSeconds * 1000) / 2),
      candidateWindowPostMs: incomingCandidatePolicy.candidateWindowPostMs ?? Math.round((windowSeconds * 1000) / 2),
      dedupe: forwardPolicy.dedupe ?? incomingCandidatePolicy.dedupe,
      thumbnailWidth: forwardPolicy.thumbnailWidth ?? incomingCandidatePolicy.thumbnailWidth,
    },
    qwenPolicy: {
      ...incomingQwenPolicy,
      enabled: incomingQwenPolicy.enabled !== false,
      maxQwenWindows: Number.isFinite(maxQwenWindows) ? maxQwenWindows : incomingQwenPolicy.maxQwenWindows,
      maxFramesPerWindow: forwardPolicy.maxFramesPerQwenWindow
        ?? forwardPolicy.max_frames_per_qwen_window
        ?? incomingQwenPolicy.maxFramesPerWindow,
      splitByDomain: incomingQwenPolicy.splitByDomain !== false,
    },
    regionsOfInterest,
    forwardPolicy: {
      baselineFps: forwardPolicy.baselineFps ?? forwardPolicy.baseline_fps ?? null,
      motionPeakFps: forwardPolicy.motionPeakFps ?? forwardPolicy.motion_peak_fps ?? null,
      windowSeconds,
      stepSeconds: Number(forwardPolicy.stepSeconds || forwardPolicy.step_seconds || 10),
      maxQwenWindows: Number.isFinite(maxQwenWindows) ? maxQwenWindows : null,
      maxFramesPerQwenWindow: forwardPolicy.maxFramesPerQwenWindow ?? forwardPolicy.max_frames_per_qwen_window ?? null,
      maintainRollingState: forwardPolicy.maintainRollingState !== false,
      allowRetrospectiveRefinement: forwardPolicy.allowRetrospectiveRefinement !== false,
    },
    forwardMode: mode,
  };
}

export async function analyzeLocalVisionForward(body, { signal, onProgress } = {}) {
  const forwardRequest = buildForwardAdaptiveRequest(body || {});
  const rois = forwardRequest.regionsOfInterest || [];
  const forwardMode = forwardRequest.forwardMode || normalizeForwardMode(body?.mode);

  const result = await analyzeLocalVisionAdaptive(forwardRequest, {
    signal,
    onProgress: (progress = {}) => {
      onProgress?.({
        ...progress,
        workflow: 'local_vision_forward_review',
        phase: forwardPhase(progress.phase),
        adaptive_phase: progress.phase,
        forward_mode: forwardMode,
        mode: forwardMode,
        roiConfigured: rois.length > 0,
        roi_configured: rois.length > 0,
        roiLabels: rois.map((roi) => roi.label),
        roi_labels: rois.map((roi) => roi.label),
        roi_count: rois.length,
        message: String(progress.message || '')
          .replace(/adaptive local/gi, 'forward local')
          .replace(/Adaptive local/g, 'Forward local'),
      });
    },
  });

  const sessionExport = result.session_analysis_export || {};
  return {
    ...result,
    workflow: 'local_vision_forward_review',
    mode: forwardMode,
    adaptive_mode: result.mode,
    summary: String(result.summary || '').replace(/Adaptive local/gi, 'Forward local'),
    session_analysis_export: {
      ...sessionExport,
      mode: 'local_vision_forward_review',
      forward_mode: forwardMode,
    },
    debug: {
      ...(result.debug || {}),
      forwardReview: {
        mode: forwardMode,
        adaptive_mode: result.mode,
        roi_configured: rois.length > 0,
        roi_labels: rois.map((roi) => roi.label),
        forward_policy: forwardRequest.forwardPolicy,
      },
    },
    warnings: [
      ...(result.warnings || []),
      ...(rois.length ? ['ROI labels are focusing hints only; visible claims still require frame evidence and deterministic gates.'] : []),
    ],
  };
}
