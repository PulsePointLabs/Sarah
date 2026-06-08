import { LOCAL_VISION_STATUSES, questionsForIds } from './questionBank.js';

export const LOCAL_VISION_RECORD_TYPES = ['general_session', 'body_exploration', 'masturbation', 'foley_procedure'];
export const LOCAL_VISION_ANALYSIS_MODES = ['fast_preview', 'balanced', 'deep_forensic'];
export const LOCAL_VISION_ROI_TYPES = [
  'genital_hand_roi',
  'feet_legs_roi',
  'full_body_roi',
  'foley_procedure_field_roi',
  'tubing_bag_roi',
  'custom_roi',
];

export const DEFAULT_LOCAL_VISION_QUESTIONS = [
  'foley_catheter_visible',
  'foley_tubing_visible',
  'statlock_visible',
  'adhesive_securement_device_visible',
  'gloved_hands_visible',
  'hands_touching_glans_or_meatus',
  'catheter_tip_at_or_entering_meatus',
  'visible_advancement_motion',
  'tubing_routing_or_field_handling',
  'urine_visible',
  'balloon_inflation_visible',
  'drape_applied_adjusted_or_removed',
  'swab_gauze_syringe_lubricant_visible',
  'lubricant_or_syringe_visible',
  'gauze_or_swab_visible',
  'anatomy_obscured_or_unclear',
  'genital_state_visible',
  'erection_state_visible',
  'genital_visibility_obscured',
  'hand_contact_with_genitals_visible',
  'stroking_motion_visible',
  'stroking_rhythm_estimate',
  'grip_or_contact_change_visible',
  'pelvic_motion_visible',
  'body_tension_or_relaxation_visible',
  'leg_or_foot_position_visible',
  'toe_curling_or_foot_flexion_visible',
  'ejaculation_or_fluid_release_visible',
  'visible_fluid_release_onset',
  'fluid_release_pulse_count',
  'fluid_stream_or_droplet_visible',
  'fluid_projection_distance_estimate',
  'fluid_trajectory_angle_estimate',
  'fluid_velocity_proxy_estimate',
  'fluid_volume_proxy_estimate',
  'visible_fluid_present',
  'post_ejaculation_state_visible',
  'post_event_fluid_presence',
  'cleanup_or_wipe_visible',
  'cleanup_material_visible',
  'lubricant_visible',
  'device_or_toy_visible',
];

const RECORD_TYPE_ALIASES = {
  session: 'general_session',
  general: 'general_session',
  general_session: 'general_session',
  other: 'general_session',
  body: 'body_exploration',
  body_exploration: 'body_exploration',
  adult_body_exploration: 'body_exploration',
  exploration: 'body_exploration',
  masturbation: 'masturbation',
  masturbation_session: 'masturbation',
  foley: 'foley_procedure',
  foley_procedure: 'foley_procedure',
  procedure: 'foley_procedure',
};

const FOLEY_DIAGNOSTIC_QUESTIONS = [
  'foley_catheter_visible',
  'foley_tubing_visible',
  'statlock_visible',
  'adhesive_securement_device_visible',
  'gloved_hands_visible',
  'hands_touching_glans_or_meatus',
  'catheter_tip_at_or_entering_meatus',
  'visible_advancement_motion',
  'tubing_routing_or_field_handling',
  'urine_visible',
  'balloon_inflation_visible',
  'drape_applied_adjusted_or_removed',
  'swab_gauze_syringe_lubricant_visible',
  'anatomy_obscured_or_unclear',
];

const BODY_DIAGNOSTIC_QUESTIONS = [
  'genital_state_visible',
  'erection_state_visible',
  'genital_visibility_obscured',
  'hand_contact_with_genitals_visible',
  'stroking_motion_visible',
  'grip_or_contact_change_visible',
  'pelvic_motion_visible',
  'body_tension_or_relaxation_visible',
  'leg_or_foot_position_visible',
  'toe_curling_or_foot_flexion_visible',
  'ejaculation_or_fluid_release_visible',
  'visible_fluid_present',
  'fluid_stream_or_droplet_visible',
  'fluid_projection_distance_estimate',
  'cleanup_or_wipe_visible',
];

export function normalizeLocalVisionRecordType(value) {
  const key = String(value || 'general_session').trim().toLowerCase();
  return RECORD_TYPE_ALIASES[key] || 'general_session';
}

export function normalizeLocalVisionAnalysisMode(value, fallback = 'balanced') {
  const key = String(value || fallback).trim().toLowerCase();
  return LOCAL_VISION_ANALYSIS_MODES.includes(key) ? key : fallback;
}

export function defaultQuestionsForRecordType(recordType) {
  const type = normalizeLocalVisionRecordType(recordType);
  if (type === 'foley_procedure') return FOLEY_DIAGNOSTIC_QUESTIONS;
  if (type === 'body_exploration') {
    return [
      'genital_state_visible',
      'genital_visibility_obscured',
      'pelvic_motion_visible',
      'body_tension_or_relaxation_visible',
      'leg_or_foot_position_visible',
      'toe_curling_or_foot_flexion_visible',
      'cleanup_material_visible',
      'lubricant_visible',
      'device_or_toy_visible',
    ];
  }
  if (type === 'masturbation') return BODY_DIAGNOSTIC_QUESTIONS;
  if (['adult_body_exploration'].includes(type)) {
    return [...new Set([...FOLEY_DIAGNOSTIC_QUESTIONS, ...BODY_DIAGNOSTIC_QUESTIONS])];
  }
  return [
    'anatomy_obscured_or_unclear',
    'genital_state_visible',
    'genital_visibility_obscured',
    'leg_or_foot_position_visible',
    'device_or_toy_visible',
    'cleanup_material_visible',
  ];
}

export function clamp01(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.min(1, parsed));
}

export function normalizeRegionsOfInterest(value = []) {
  if (!Array.isArray(value)) return [];
  return value
    .map((roi, index) => {
      if (!roi || typeof roi !== 'object') return null;
      const x = clamp01(roi.x ?? roi.left, 0);
      const y = clamp01(roi.y ?? roi.top, 0);
      const width = Math.max(0.01, Math.min(1 - x, clamp01(roi.width ?? roi.w, 0.2)));
      const height = Math.max(0.01, Math.min(1 - y, clamp01(roi.height ?? roi.h, 0.2)));
      const rawType = String(roi.type || 'custom_roi').trim().toLowerCase();
      const type = LOCAL_VISION_ROI_TYPES.includes(rawType) ? rawType : 'custom_roi';
      const label = String(roi.label || type.replace(/_/g, ' ')).trim().slice(0, 80);
      return {
        id: String(roi.id || `roi_${String(index + 1).padStart(3, '0')}`).trim(),
        label,
        type,
        x,
        y,
        width,
        height,
      };
    })
    .filter(Boolean);
}

export function normalizeStatus(value, fallback = 'uncertain') {
  const normalized = String(value || '').trim().toLowerCase();
  return LOCAL_VISION_STATUSES.includes(normalized) ? normalized : fallback;
}

export function normalizeLocalVisionRequest(body = {}) {
  const startMs = Math.max(0, Math.round(Number(body.startMs ?? body.start_ms ?? 0)));
  const endMs = Math.max(startMs + 250, Math.round(Number(body.endMs ?? body.end_ms ?? startMs + 30000)));
  const samplePolicy = body.samplePolicy || body.scanPolicy || body.evidencePolicy || {};
  const engine = String(body.engine || process.env.LOCAL_VISION_ENGINE || 'local_qwen25vl').trim().toLowerCase();
  if (engine !== 'local_qwen25vl') {
    const error = new Error('Local vision engine must be local_qwen25vl. Mock/rules engines are not available for production local analysis.');
    error.status = 400;
    throw error;
  }
  return {
    sessionId: String(body.sessionId || body.session_id || '').trim(),
    recordType: normalizeLocalVisionRecordType(body.recordType || body.record_type || 'general_session'),
    videoPath: String(body.videoPath || body.video_path || '').trim(),
    startMs,
    endMs,
    samplePolicy: {
      fps: Math.max(0.1, Math.min(4, Number(samplePolicy.fps || 1))),
      maxFrames: Math.max(1, Math.min(Number(process.env.LOCAL_VISION_MAX_FRAMES || 8), Math.round(Number(samplePolicy.maxFrames || samplePolicy.maxScanFrames || 8)))),
      includeMotionPeaks: samplePolicy.includeMotionPeaks !== false,
      dedupe: samplePolicy.dedupe !== false,
      thumbnailWidth: Math.max(256, Math.min(960, Math.round(Number(samplePolicy.thumbnailWidth || 512)))),
    },
    engine,
    questions: questionsForIds(body.questions?.length ? body.questions : defaultQuestionsForRecordType(body.recordType || body.record_type)),
    previousVisualState: body.previousVisualState && typeof body.previousVisualState === 'object'
      ? body.previousVisualState
      : {},
    scaleCalibration: body.scaleCalibration || body.scale_calibration || { available: false, pixelsPerCm: null, source: null },
    regionsOfInterest: normalizeRegionsOfInterest(body.regionsOfInterest || body.regions_of_interest || []),
  };
}

export function normalizeContinuousVisionRequest(body = {}) {
  const request = normalizeLocalVisionRequest({
    ...body,
    samplePolicy: body.scanPolicy || body.scan_policy || body.samplePolicy || {},
  });
  const scanPolicy = body.scanPolicy || body.scan_policy || {};
  const refinementPolicy = body.refinementPolicy || body.refinement_policy || {};
  const maxScanFrames = Math.max(1, Math.min(
    Number(process.env.LOCAL_VISION_CONTINUOUS_MAX_SCAN_FRAMES || 600),
    Math.round(Number(scanPolicy.maxScanFrames || scanPolicy.max_frames || 600)),
  ));
  return {
    ...request,
    scanPolicy: {
      baselineFps: Math.max(0.1, Math.min(10, Number(scanPolicy.baselineFps || scanPolicy.baseline_fps || 1))),
      maxScanFrames,
      includeMotionPeaks: scanPolicy.includeMotionPeaks !== false,
      includeSceneChanges: scanPolicy.includeSceneChanges !== false,
      dedupe: scanPolicy.dedupe !== false,
      batchSize: Math.max(1, Math.min(Number(process.env.LOCAL_VISION_MAX_FRAMES || 8), Math.round(Number(scanPolicy.batchSize || 8)))),
      thumbnailWidth: Math.max(256, Math.min(960, Math.round(Number(scanPolicy.thumbnailWidth || 512)))),
    },
    refinementPolicy: {
      enabled: refinementPolicy.enabled !== false,
      preMs: Math.max(0, Math.min(30000, Math.round(Number(refinementPolicy.preMs ?? refinementPolicy.pre_ms ?? 5000)))),
      postMs: Math.max(0, Math.min(30000, Math.round(Number(refinementPolicy.postMs ?? refinementPolicy.post_ms ?? 5000)))),
      fps: Math.max(0.5, Math.min(12, Number(refinementPolicy.fps || 4))),
      maxRefinementFramesPerEvent: Math.max(1, Math.min(200, Math.round(Number(refinementPolicy.maxRefinementFramesPerEvent || 80)))),
      eventTypes: Array.isArray(refinementPolicy.eventTypes || refinementPolicy.event_types)
        ? (refinementPolicy.eventTypes || refinementPolicy.event_types).map(String)
        : [],
    },
    questions: questionsForIds(body.questions?.length ? body.questions : defaultQuestionsForRecordType(body.recordType || body.record_type)),
  };
}

export function normalizeAdaptiveVisionRequest(body = {}) {
  const request = normalizeLocalVisionRequest({
    ...body,
    recordType: body.recordType || body.record_type || 'general_session',
    samplePolicy: body.candidatePolicy || body.candidate_policy || body.scanPolicy || {},
  });
  const mode = normalizeLocalVisionAnalysisMode(body.mode || body.analysisMode || body.analysis_mode, 'balanced');
  const candidatePolicy = body.candidatePolicy || body.candidate_policy || {};
  const qwenPolicy = body.qwenPolicy || body.qwen_policy || {};
  const defaults = {
    fast_preview: { baselineFps: 0.35, maxCandidateWindows: 8, maxQwenWindows: 3, maxFramesPerWindow: 6 },
    balanced: { baselineFps: 0.5, maxCandidateWindows: 12, maxQwenWindows: 10, maxFramesPerWindow: 8 },
    deep_forensic: { baselineFps: 1, maxCandidateWindows: 40, maxQwenWindows: 30, maxFramesPerWindow: 12 },
  }[mode];
  return {
    ...request,
    mode,
    candidatePolicy: {
      baselineFps: Math.max(0.1, Math.min(4, Number(candidatePolicy.baselineFps || candidatePolicy.baseline_fps || defaults.baselineFps))),
      motionPeakFps: Math.max(0.25, Math.min(8, Number(candidatePolicy.motionPeakFps || candidatePolicy.motion_peak_fps || 2))),
      maxCandidateWindows: Math.max(1, Math.min(80, Math.round(Number(candidatePolicy.maxCandidateWindows || candidatePolicy.max_candidate_windows || defaults.maxCandidateWindows)))),
      candidateWindowPreMs: Math.max(0, Math.min(30000, Math.round(Number(candidatePolicy.candidateWindowPreMs ?? candidatePolicy.candidate_window_pre_ms ?? 3000)))),
      candidateWindowPostMs: Math.max(0, Math.min(30000, Math.round(Number(candidatePolicy.candidateWindowPostMs ?? candidatePolicy.candidate_window_post_ms ?? 3000)))),
      dedupe: candidatePolicy.dedupe !== false,
      thumbnailWidth: Math.max(256, Math.min(960, Math.round(Number(candidatePolicy.thumbnailWidth || 512)))),
    },
    qwenPolicy: {
      enabled: qwenPolicy.enabled !== false,
      maxQwenWindows: Math.max(0, Math.min(60, Math.round(Number(qwenPolicy.maxQwenWindows || qwenPolicy.max_qwen_windows || defaults.maxQwenWindows)))),
      maxFramesPerWindow: Math.max(2, Math.min(Number(process.env.LOCAL_VISION_MAX_FRAMES || 8), Math.round(Number(qwenPolicy.maxFramesPerWindow || qwenPolicy.max_frames_per_window || defaults.maxFramesPerWindow)))),
      splitByDomain: qwenPolicy.splitByDomain !== false,
    },
    scaleCalibration: body.scaleCalibration || body.scale_calibration || { available: false, pixelsPerCm: null, source: null },
  };
}

export function normalizeVideoQaRequest(body = {}) {
  const request = normalizeLocalVisionRequest({
    ...body,
    samplePolicy: body.evidencePolicy || body.evidence_policy || body.samplePolicy || {},
  });
  const question = String(body.question || '').trim();
  if (!question) {
    const error = new Error('question is required for local video Q&A.');
    error.status = 400;
    throw error;
  }
  const evidencePolicy = body.evidencePolicy || body.evidence_policy || {};
  return {
    ...request,
    question,
    knownTimeline: body.knownTimeline || body.known_timeline || null,
    evidencePolicy: {
      baselineFps: Math.max(0.1, Math.min(10, Number(evidencePolicy.baselineFps || evidencePolicy.baseline_fps || 1))),
      maxScanFrames: Math.max(1, Math.min(300, Math.round(Number(evidencePolicy.maxScanFrames || 300)))),
      includeMotionPeaks: evidencePolicy.includeMotionPeaks !== false,
      includeSceneChanges: evidencePolicy.includeSceneChanges !== false,
      dedupe: evidencePolicy.dedupe !== false,
      batchSize: Math.max(1, Math.min(Number(process.env.LOCAL_VISION_MAX_FRAMES || 8), Math.round(Number(evidencePolicy.batchSize || 8)))),
      thumbnailWidth: Math.max(256, Math.min(960, Math.round(Number(evidencePolicy.thumbnailWidth || 512)))),
      refineAroundLikelyEvidence: evidencePolicy.refineAroundLikelyEvidence !== false,
    },
  };
}

export function normalizeVlmAnswers(rawAnswers = [], questions = [], frames = []) {
  const questionMap = new Map(questions.map((question) => [question.id, question]));
  const frameIds = new Set(frames.map((frame) => frame.frame_id));
  const byQuestion = new Map();

  for (const raw of Array.isArray(rawAnswers) ? rawAnswers : []) {
    const questionId = String(raw?.question_id || raw?.questionId || '').trim();
    if (!questionMap.has(questionId) || byQuestion.has(questionId)) continue;
    const status = normalizeStatus(raw?.answer || raw?.status);
    const evidenceFrames = (Array.isArray(raw?.evidence_frames || raw?.frame_refs)
      ? (raw.evidence_frames || raw.frame_refs)
      : [])
      .map((id) => String(id || '').trim())
      .filter((id) => frameIds.has(id));
    byQuestion.set(questionId, {
      question_id: questionId,
      answer: status,
      confidence: clamp01(raw?.confidence, status === 'uncertain' ? 0.35 : 0.5),
      evidence_frames: status === 'visible' && !evidenceFrames.length && frames[0]?.frame_id
        ? [frames[0].frame_id]
        : evidenceFrames,
      reason: String(raw?.reason || '').trim().slice(0, 500),
      attributes: raw?.attributes && typeof raw.attributes === 'object' ? raw.attributes : {},
    });
  }

  return questions.map((question) => byQuestion.get(question.id) || ({
    question_id: question.id,
    answer: 'uncertain',
    confidence: 0.25,
    evidence_frames: [],
    reason: 'No local visual answer returned for this constrained question.',
    attributes: {},
  }));
}

export function answerMap(answers = []) {
  return new Map(answers.map((answer) => [answer.question_id, answer]));
}

export function isVisible(answer, minConfidence = 0.5) {
  return answer?.answer === 'visible' && clamp01(answer.confidence) >= minConfidence && Array.isArray(answer.evidence_frames) && answer.evidence_frames.length > 0;
}

export function isUnconfirmed(answer) {
  return !answer || answer.answer === 'not_visible' || answer.answer === 'uncertain';
}
