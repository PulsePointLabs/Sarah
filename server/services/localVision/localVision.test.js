import test from 'node:test';
import assert from 'node:assert/strict';
import { getQuestionBank } from './questionBank.js';
import { normalizeAdaptiveVisionRequest, normalizeLocalVisionRecordType, normalizeRegionsOfInterest, normalizeVlmAnswers } from './schema.js';
import { deriveLocalVisionResult } from './stateMachine.js';
import { rankCandidateWindows } from './cvPrepass.js';
import { questionIdsForCandidate } from './adaptiveAnalyzer.js';
import { buildSessionAnalysisExport } from './sessionAnalysisExport.js';
import { adaptiveModeForForwardMode, buildForwardAdaptiveRequest, normalizeForwardMode } from './forwardAnalyzer.js';

const frames = [
  { frame_id: 'f001', time_ms: 120000, image_path: '/api/local-vision/frame/test/window/f001.jpg' },
  { frame_id: 'f002', time_ms: 124000, image_path: '/api/local-vision/frame/test/window/f002.jpg' },
];

function resultFor(rawAnswers) {
  const questions = getQuestionBank();
  const answers = normalizeVlmAnswers(rawAnswers, questions, frames);
  return deriveLocalVisionResult({
    request: { sessionId: 'test', recordType: 'body_exploration', startMs: 120000, endMs: 150000, previousVisualState: {} },
    frames,
    questions,
    answers,
    engine: 'local_qwen25vl',
    model: 'test',
  });
}

function resultForWithState(rawAnswers, previousVisualState = {}) {
  const questions = getQuestionBank();
  const answers = normalizeVlmAnswers(rawAnswers, questions, frames);
  return deriveLocalVisionResult({
    request: { sessionId: 'test', recordType: 'body_exploration', startMs: 120000, endMs: 150000, previousVisualState },
    frames,
    questions,
    answers,
    engine: 'local_qwen25vl',
    model: 'test',
  });
}

test('question bank IDs are unique', () => {
  const ids = getQuestionBank().map((question) => question.id);
  assert.equal(new Set(ids).size, ids.length);
});

test('taxonomy normalizes supported local vision record types', () => {
  assert.equal(normalizeLocalVisionRecordType('session'), 'general_session');
  assert.equal(normalizeLocalVisionRecordType('body_exploration'), 'body_exploration');
  assert.equal(normalizeLocalVisionRecordType('adult_body_exploration'), 'body_exploration');
  assert.equal(normalizeLocalVisionRecordType('masturbation'), 'masturbation');
  assert.equal(normalizeLocalVisionRecordType('foley'), 'foley_procedure');
});

test('masturbation question routing does not collapse into body exploration', () => {
  const request = normalizeAdaptiveVisionRequest({
    sessionId: 'test',
    recordType: 'masturbation',
    videoPath: 'C:/video.mp4',
    startMs: 0,
    endMs: 10000,
  });
  assert.equal(request.recordType, 'masturbation');
  const ids = request.questions.map((question) => question.id);
  assert.ok(ids.includes('stroking_motion_visible'));
  assert.ok(ids.includes('ejaculation_or_fluid_release_visible'));
  assert.ok(!ids.includes('foley_tubing_visible'));
});

test('candidate question routing is domain-specific', () => {
  const masturbationIds = questionIdsForCandidate('masturbation', { type: 'hand_genital_motion_candidate' });
  assert.ok(masturbationIds.includes('stroking_motion_visible'));
  assert.ok(masturbationIds.includes('hand_contact_with_genitals_visible'));
  assert.ok(masturbationIds.includes('respiratory_cycles_visible'));
  assert.ok(masturbationIds.includes('possible_breath_hold_visible'));
  assert.ok(!masturbationIds.includes('statlock_visible'));
  const foleyIds = questionIdsForCandidate('foley_procedure', { type: 'foley_tool_or_tubing_activity_candidate' });
  assert.ok(foleyIds.includes('foley_tubing_visible'));
  assert.ok(foleyIds.includes('visible_advancement_motion'));
  assert.ok(foleyIds.includes('chest_or_abdomen_visible_for_respiration'));
  assert.ok(!foleyIds.includes('ejaculation_or_fluid_release_visible'));
});

test('local respiration derives rate from complete cycles over the actual frame span', () => {
  const respirationFrames = [
    { frame_id: 'r001', time_ms: 120000, image_path: '/api/local-vision/frame/test/window/r001.jpg' },
    { frame_id: 'r002', time_ms: 128000, image_path: '/api/local-vision/frame/test/window/r002.jpg' },
    { frame_id: 'r003', time_ms: 136000, image_path: '/api/local-vision/frame/test/window/r003.jpg' },
  ];
  const questions = getQuestionBank();
  const answers = normalizeVlmAnswers([
    { question_id: 'chest_or_abdomen_visible_for_respiration', answer: 'visible', confidence: 0.85, evidence_frames: ['r001', 'r002', 'r003'], reason: 'Abdominal surface remains visible.' },
    { question_id: 'respiratory_cycles_visible', answer: 'visible', confidence: 0.8, evidence_frames: ['r001', 'r002', 'r003'], reason: 'Four complete rise/fall cycles.', attributes: { breaths_observed: 4, observation_seconds: 16, estimated_rate_bpm: 99 } },
    { question_id: 'possible_breath_hold_visible', answer: 'not_visible', confidence: 0.8, evidence_frames: ['r001', 'r002', 'r003'], reason: 'No sustained still interval.' },
  ], questions, respirationFrames);
  const result = deriveLocalVisionResult({
    request: { sessionId: 'test', recordType: 'masturbation', startMs: 120000, endMs: 144000, previousVisualState: {} },
    frames: respirationFrames,
    questions,
    answers,
    engine: 'local_qwen25vl',
    model: 'test',
  });

  assert.equal(result.respiration.assessable, true);
  assert.equal(result.respiration.estimated_rate_bpm, 15);
  assert.ok(result.stage_candidates.some((stage) => stage.stage === 'visible_respiratory_pattern'));
});

test('local respiration blocks rates when sampled frame coverage is under eight seconds', () => {
  const questions = getQuestionBank();
  const answers = normalizeVlmAnswers([
    { question_id: 'chest_or_abdomen_visible_for_respiration', answer: 'visible', confidence: 0.9, evidence_frames: ['f001', 'f002'], reason: 'Abdomen visible.' },
    { question_id: 'respiratory_cycles_visible', answer: 'visible', confidence: 0.9, evidence_frames: ['f001', 'f002'], reason: 'Model proposed cycles.', attributes: { breaths_observed: 4, observation_seconds: 16, estimated_rate_bpm: 15 } },
  ], questions, frames);
  const result = deriveLocalVisionResult({
    request: { sessionId: 'test', recordType: 'masturbation', startMs: 120000, endMs: 150000, previousVisualState: {} },
    frames,
    questions,
    answers,
    engine: 'local_qwen25vl',
    model: 'test',
  });

  assert.equal(result.respiration.estimated_rate_bpm, null);
});

test('candidate ranking caps selected windows and preserves chronological output', () => {
  const candidates = Array.from({ length: 8 }, (_, index) => ({
    candidate_id: `raw_${index}`,
    start_ms: index * 1000,
    end_ms: index * 1000 + 500,
    type: 'hand_genital_motion_candidate',
    score: index / 10,
    frame_refs: [`f${index}`],
    reasons: ['test'],
  }));
  const ranked = rankCandidateWindows(candidates, 3);
  assert.equal(ranked.length, 3);
  assert.deepEqual(ranked.map((item) => item.start_ms), [5000, 6000, 7000]);
});

test('adaptive fast preview is not deep forensic by default', () => {
  const request = normalizeAdaptiveVisionRequest({
    sessionId: 'test',
    recordType: 'masturbation',
    videoPath: 'C:/video.mp4',
    startMs: 0,
    endMs: 60000,
    mode: 'fast_preview',
  });
  assert.equal(request.mode, 'fast_preview');
  assert.ok(request.qwenPolicy.maxQwenWindows <= 3);
});

test('forward review modes map to adaptive engine modes without making deep the default', () => {
  assert.equal(normalizeForwardMode(), 'balanced');
  assert.equal(adaptiveModeForForwardMode('fast'), 'fast_preview');
  assert.equal(adaptiveModeForForwardMode('balanced'), 'balanced');
  assert.equal(adaptiveModeForForwardMode('deep'), 'deep_forensic');
});

test('forward review normalizes ROI hints and carries them as hints only', () => {
  const request = buildForwardAdaptiveRequest({
    sessionId: 'test',
    recordType: 'masturbation',
    videoPath: 'C:/video.mp4',
    startMs: 0,
    endMs: 60000,
    mode: 'balanced',
    regionsOfInterest: [{
      id: 'roi_test',
      label: 'Genital / hand activity',
      type: 'genital_hand_roi',
      x: -1,
      y: 0.5,
      width: 2,
      height: 0.4,
    }],
  });
  assert.equal(request.workflow, 'local_vision_forward_review');
  assert.equal(request.mode, 'balanced');
  assert.equal(request.regionsOfInterest.length, 1);
  assert.equal(request.regionsOfInterest[0].x, 0);
  assert.ok(request.regionsOfInterest[0].width <= 1);
});

test('ROI normalization clamps coordinates and preserves allowed type labels', () => {
  const rois = normalizeRegionsOfInterest([{ type: 'feet_legs_roi', label: 'Feet / legs', x: 0.9, y: 0.9, width: 0.5, height: 0.5 }]);
  assert.equal(rois.length, 1);
  assert.equal(rois[0].type, 'feet_legs_roi');
  assert.equal(rois[0].label, 'Feet / legs');
  assert.ok(rois[0].width <= 0.1);
  assert.ok(rois[0].height <= 0.1);
});

test('session analysis export keeps uncertain raw rows out of confirmed findings', () => {
  const exportPayload = buildSessionAnalysisExport({
    mode: 'balanced',
    recordType: 'masturbation',
    actionableFindings: [],
    strongCandidates: [{ candidate_id: 'cand_001', type: 'hand_genital_motion_candidate', start_ms: 1000, end_ms: 3000, score: 0.62, frame_refs: ['f001'], reasons: ['motion'] }],
    notConfirmed: [{ label: 'ejaculation/fluid release not confirmed', reason: 'No visible fluid.' }],
    limitations: ['Limited visibility.'],
  });
  assert.equal(exportPayload.confirmed_findings.length, 0);
  assert.equal(exportPayload.strong_candidates.length, 1);
  assert.equal(exportPayload.strong_candidates[0].status, 'candidate_not_confirmed');
  assert.equal(exportPayload.local_annotation_cards.length, 2);
  assert.equal(exportPayload.local_annotation_cards[0].timestamp_range, '0:01-0:03');
  assert.match(exportPayload.local_annotation_cards[0].summary, /Strong local-CV candidate, not visually confirmed by Qwen/i);
  assert.match(exportPayload.local_annotation_cards[1].summary, /Not visually confirmed/i);
  assert.equal(exportPayload.not_confirmed.length, 1);
});

test('securement is blocked when only tubing/gloves are visible', () => {
  const result = resultFor([
    { question_id: 'foley_tubing_visible', answer: 'visible', confidence: 0.9, evidence_frames: ['f001'], reason: 'Yellow tubing visible.' },
    { question_id: 'gloved_hands_visible', answer: 'visible', confidence: 0.8, evidence_frames: ['f001'], reason: 'Hands visible.' },
    { question_id: 'statlock_visible', answer: 'not_visible', confidence: 0.9, evidence_frames: ['f001', 'f002'], reason: 'No adhesive anchor.' },
    { question_id: 'adhesive_securement_device_visible', answer: 'not_visible', confidence: 0.9, evidence_frames: ['f001', 'f002'], reason: 'No securement device.' },
  ]);
  assert.ok(result.forbidden_or_not_visible.some((item) => item.claim === 'StatLock securement'));
  assert.ok(!result.stage_candidates.some((item) => item.stage === 'securement'));
});

test('advancement is blocked without tip or motion evidence', () => {
  const result = resultFor([
    { question_id: 'foley_tubing_visible', answer: 'visible', confidence: 0.9, evidence_frames: ['f001'], reason: 'Tubing visible.' },
    { question_id: 'visible_advancement_motion', answer: 'not_visible', confidence: 0.85, evidence_frames: ['f001', 'f002'], reason: 'No motion.' },
    { question_id: 'catheter_tip_at_or_entering_meatus', answer: 'not_visible', confidence: 0.85, evidence_frames: ['f001'], reason: 'No tip at meatus.' },
  ]);
  assert.ok(result.forbidden_or_not_visible.some((item) => item.claim === 'catheter advancement'));
  assert.ok(!result.stage_candidates.some((item) => item.stage === 'possible_advancement'));
});

test('ejaculation is blocked without visible fluid evidence', () => {
  const result = resultFor([
    { question_id: 'ejaculation_or_fluid_release_visible', answer: 'not_visible', confidence: 0.9, evidence_frames: ['f001', 'f002'], reason: 'No release.' },
    { question_id: 'visible_fluid_present', answer: 'not_visible', confidence: 0.9, evidence_frames: ['f001', 'f002'], reason: 'No fluid.' },
  ]);
  assert.ok(result.forbidden_or_not_visible.some((item) => item.claim === 'ejaculation/fluid release'));
  assert.ok(!result.stage_candidates.some((item) => item.stage === 'ejaculation_or_fluid_event'));
});

test('erection state is not classified when visibility is obscured', () => {
  const result = resultFor([
    { question_id: 'genital_visibility_obscured', answer: 'visible', confidence: 0.8, evidence_frames: ['f001'], reason: 'Blocked by drape.' },
    { question_id: 'erection_state_visible', answer: 'uncertain', confidence: 0.3, evidence_frames: [], reason: 'Obscured.' },
  ]);
  assert.ok(result.forbidden_or_not_visible.some((item) => item.claim === 'specific erection state'));
  assert.ok(!result.stage_candidates.some((item) => item.stage === 'genital_state_change'));
});

test('manual stimulation is not generated from hand proximity alone', () => {
  const result = resultFor([
    { question_id: 'hand_contact_with_genitals_visible', answer: 'visible', confidence: 0.75, evidence_frames: ['f001'], reason: 'Hand contact visible.' },
    { question_id: 'stroking_motion_visible', answer: 'not_visible', confidence: 0.8, evidence_frames: ['f001', 'f002'], reason: 'No repeated motion.' },
    { question_id: 'grip_or_contact_change_visible', answer: 'not_visible', confidence: 0.7, evidence_frames: ['f001', 'f002'], reason: 'No grip change.' },
  ]);
  assert.ok(result.forbidden_or_not_visible.some((item) => item.claim === 'stroking/manual stimulation'));
  assert.ok(!result.stage_candidates.some((item) => item.stage === 'manual_stimulation'));
});

test('fluid dynamics does not report release metrics without visible fluid release', () => {
  const result = resultFor([
    { question_id: 'ejaculation_or_fluid_release_visible', answer: 'not_visible', confidence: 0.9, evidence_frames: ['f001', 'f002'], reason: 'No release.' },
    { question_id: 'visible_fluid_release_onset', answer: 'not_visible', confidence: 0.9, evidence_frames: ['f001'], reason: 'No onset.' },
    { question_id: 'fluid_stream_or_droplet_visible', answer: 'not_visible', confidence: 0.9, evidence_frames: ['f001'], reason: 'No stream.' },
  ]);
  assert.equal(result.fluid_dynamics.release_detected, 'not_visible');
  assert.equal(result.fluid_dynamics.onset_ms, null);
  assert.equal(result.fluid_dynamics.velocity_proxy_px_per_sec, null);
  assert.equal(result.fluid_dynamics.velocity_proxy_cm_per_sec, null);
});

test('fluid dynamics reports pixel proxy but no cm/sec without scale calibration', () => {
  const result = resultFor([
    { question_id: 'ejaculation_or_fluid_release_visible', answer: 'visible', confidence: 0.8, evidence_frames: ['f001'], reason: 'Release visible.' },
    { question_id: 'fluid_stream_or_droplet_visible', answer: 'visible', confidence: 0.75, evidence_frames: ['f001'], reason: 'Droplet path visible.' },
    { question_id: 'fluid_projection_distance_estimate', answer: 'visible', confidence: 0.75, evidence_frames: ['f001'], reason: 'Path visible.', attributes: { distance_px: 120 } },
    { question_id: 'fluid_velocity_proxy_estimate', answer: 'visible', confidence: 0.7, evidence_frames: ['f001', 'f002'], reason: 'Motion visible.', attributes: { velocity_px_per_sec: 240 } },
  ]);
  assert.equal(result.fluid_dynamics.release_detected, 'visible');
  assert.equal(result.fluid_dynamics.max_projected_distance_px, 120);
  assert.equal(result.fluid_dynamics.max_projected_distance_cm, null);
  assert.equal(result.fluid_dynamics.velocity_proxy_px_per_sec, 240);
  assert.equal(result.fluid_dynamics.velocity_proxy_cm_per_sec, null);
  assert.ok(result.forbidden_or_not_visible.some((item) => item.claim === 'real-world fluid distance/velocity'));
});

test('fluid dynamics reports cm proxies only with scale calibration', () => {
  const result = resultForWithState([
    { question_id: 'ejaculation_or_fluid_release_visible', answer: 'visible', confidence: 0.8, evidence_frames: ['f001'], reason: 'Release visible.' },
    { question_id: 'fluid_stream_or_droplet_visible', answer: 'visible', confidence: 0.75, evidence_frames: ['f001'], reason: 'Droplet path visible.' },
    { question_id: 'fluid_projection_distance_estimate', answer: 'visible', confidence: 0.75, evidence_frames: ['f001'], reason: 'Path visible.', attributes: { distance_px: 100 } },
    { question_id: 'fluid_velocity_proxy_estimate', answer: 'visible', confidence: 0.7, evidence_frames: ['f001', 'f002'], reason: 'Motion visible.', attributes: { velocity_px_per_sec: 200 } },
  ], { scaleCalibration: { cmPerPixel: 0.2 } });
  assert.equal(result.fluid_dynamics.max_projected_distance_cm, 20);
  assert.equal(result.fluid_dynamics.velocity_proxy_cm_per_sec, 40);
});
