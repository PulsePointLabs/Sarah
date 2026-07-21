import { normalizeAdaptiveVisionRequest } from './schema.js';
import { sampleLocalVisionFrames } from './frameSampler.js';
import { callLocalQwenBatch } from './localVisionClient.js';
import { deriveLocalVisionResult } from './stateMachine.js';
import { saveLocalVisionResult } from './persistence.js';
import { getTrustedRecordAndVideo } from './analyzeWindow.js';
import { runCvPrepass, rankCandidateWindows } from './cvPrepass.js';
import { buildNotConfirmed, buildSessionAnalysisExport, candidateSummary, findingFromEvent } from './sessionAnalysisExport.js';

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

function frameRefs(items = []) {
  return [...new Set(items.flatMap((item) => item?.frame_refs || item?.evidence_frames || []).filter(Boolean))];
}

function eventKey(event) {
  return `${event.event_type || event.stage || event.label}:${Math.round(Number(event.start_ms ?? event.time_ms ?? 0) / 1000)}:${event.label || ''}`;
}

function promoteEvent(event, index, candidate) {
  const start = Number(event.start_ms ?? event.time_ms ?? candidate?.start_ms ?? 0);
  const end = Number(event.end_ms ?? event.time_ms ?? candidate?.end_ms ?? start);
  return {
    event_id: event.event_id || `evt_${String(index + 1).padStart(3, '0')}`,
    start_ms: Math.max(0, Math.round(start)),
    end_ms: Math.max(Math.round(start), Math.round(end)),
    event_type: event.event_type || 'stage_candidate',
    label: event.label || String(event.stage || candidate?.type || 'local visual event').replace(/_/g, ' '),
    confidence: Number(event.confidence || 0),
    source: event.source || 'adaptive_qwen_state_machine',
    frame_refs: event.frame_refs || (event.frame_ref ? [event.frame_ref] : []) || [],
    basis: event.basis || event.reason || 'Promoted from targeted local Qwen evidence and deterministic gates.',
    candidate_id: candidate?.candidate_id || null,
  };
}

function stateSegmentFromStage(stage, candidate) {
  return {
    start_ms: stage.start_ms ?? candidate?.start_ms ?? null,
    end_ms: stage.end_ms ?? candidate?.end_ms ?? null,
    state: stage.stage,
    confidence: stage.confidence,
    frame_refs: stage.frame_refs || [],
    basis: stage.basis,
    candidate_id: candidate?.candidate_id || null,
  };
}

export function questionIdsForCandidate(recordType, candidate = {}) {
  const type = String(candidate.type || '').toLowerCase();
  const record = String(recordType || '').toLowerCase();
  const general = ['anatomy_obscured_or_unclear', 'genital_state_visible', 'genital_visibility_obscured', 'leg_or_foot_position_visible'];
  const bodyMotion = ['pelvic_motion_visible', 'body_tension_or_relaxation_visible', 'chest_or_abdomen_visible_for_respiration', 'respiratory_cycles_visible', 'possible_breath_hold_visible', 'toe_curling_or_foot_flexion_visible'];
  const respiration = ['chest_or_abdomen_visible_for_respiration', 'respiratory_cycles_visible', 'possible_breath_hold_visible'];
  const masturbation = ['hand_contact_with_genitals_visible', 'stroking_motion_visible', 'grip_or_contact_change_visible', 'erection_state_visible'];
  const fluid = ['ejaculation_or_fluid_release_visible', 'visible_fluid_present', 'visible_fluid_release_onset', 'fluid_stream_or_droplet_visible', 'fluid_projection_distance_estimate', 'fluid_velocity_proxy_estimate', 'post_event_fluid_presence', 'cleanup_or_wipe_visible'];
  const foley = ['foley_catheter_visible', 'foley_tubing_visible', 'statlock_visible', 'adhesive_securement_device_visible', 'gloved_hands_visible', 'hands_touching_glans_or_meatus', 'catheter_tip_at_or_entering_meatus', 'visible_advancement_motion', 'tubing_routing_or_field_handling', 'urine_visible', 'balloon_inflation_visible'];

  if (record === 'foley_procedure' || type.includes('foley') || type.includes('procedure') || type.includes('tubing')) {
    return [...new Set([...foley, ...respiration, 'anatomy_obscured_or_unclear'])];
  }
  if (type.includes('fluid')) return [...new Set([...general, ...fluid])];
  if (record === 'masturbation' || type.includes('hand_genital') || type.includes('genital_motion')) {
    return [...new Set([...general, ...masturbation, ...bodyMotion, ...fluid])];
  }
  if (record === 'body_exploration') return [...new Set([...general, ...bodyMotion, 'cleanup_material_visible', 'lubricant_visible', 'device_or_toy_visible'])];
  return [...new Set([...general, ...respiration, 'device_or_toy_visible', 'cleanup_material_visible'])];
}

function candidateDomainBoost(recordType, candidate) {
  const type = String(candidate.type || '').toLowerCase();
  const record = String(recordType || '').toLowerCase();
  if (record === 'masturbation' && (type.includes('hand_genital') || type.includes('body_foot') || type.includes('fluid'))) return 0.12;
  if (record === 'foley_procedure' && (type.includes('foley') || type.includes('procedure') || type.includes('tubing'))) return 0.12;
  if (record === 'body_exploration' && (type.includes('body') || type.includes('anatomy'))) return 0.08;
  return 0;
}

function selectQwenCandidates({ candidates, request }) {
  const scored = [...candidates]
    .map((candidate) => ({
      ...candidate,
      review_score: Number(Math.min(1, Number(candidate.score || 0) + candidateDomainBoost(request.recordType, candidate)).toFixed(3)),
    }));
  const maxWindows = Math.max(0, Math.round(Number(request.qwenPolicy.maxQwenWindows || 0)));
  if (!maxWindows || !scored.length) return [];
  if (scored.length <= maxWindows) {
    return scored
      .sort((a, b) => (a.start_ms || 0) - (b.start_ms || 0))
      .map((candidate) => ({
        ...candidate,
        selection_reason: 'within_review_cap',
        lifecycle: [...new Set([...(candidate.lifecycle || []), 'selected_for_qwen'])],
      }));
  }

  const selected = new Map();
  const coverageSlots = Math.min(Math.ceil(maxWindows * 0.45), maxWindows, scored.length);
  const rangeStart = Number(request.startMs || 0);
  const rangeEnd = Math.max(rangeStart + 1, Number(request.endMs || rangeStart + 1));
  for (let slot = 0; slot < coverageSlots; slot += 1) {
    const slotStart = rangeStart + ((rangeEnd - rangeStart) * slot / coverageSlots);
    const slotEnd = rangeStart + ((rangeEnd - rangeStart) * (slot + 1) / coverageSlots);
    const inSlot = scored
      .filter((candidate) => (candidate.start_ms ?? 0) >= slotStart && (candidate.start_ms ?? 0) < slotEnd)
      .sort((a, b) => (b.review_score || 0) - (a.review_score || 0) || (a.start_ms || 0) - (b.start_ms || 0))[0];
    if (inSlot) {
      selected.set(inSlot.candidate_id, { ...inSlot, selection_reason: 'coverage_checkpoint' });
    }
  }

  for (const candidate of scored.sort((a, b) => (b.review_score || 0) - (a.review_score || 0) || (a.start_ms || 0) - (b.start_ms || 0))) {
    if (selected.size >= maxWindows) break;
    if (!selected.has(candidate.candidate_id)) {
      selected.set(candidate.candidate_id, { ...candidate, selection_reason: 'ranked_candidate' });
    }
  }

  return [...selected.values()]
    .sort((a, b) => (a.start_ms || 0) - (b.start_ms || 0))
    .map((candidate) => ({
      ...candidate,
      lifecycle: [...new Set([...(candidate.lifecycle || []), 'selected_for_qwen'])],
    }));
}

function candidateStatus(candidate, { confirmedCandidateIds, strongCandidateIds, unresolvedCandidateIds, downgradedCandidateIds, rejectedCandidateIds }) {
  const id = candidate?.candidate_id;
  if (confirmedCandidateIds.has(id)) return 'confirmed';
  if (strongCandidateIds.has(id)) return 'candidate_not_confirmed';
  if (unresolvedCandidateIds.has(id)) return 'unresolved';
  if (rejectedCandidateIds.has(id)) return 'rejected';
  if (downgradedCandidateIds.has(id)) return 'downgraded';
  return 'cv_detected';
}

function coverageLabel(type = '') {
  return String(type || 'candidate').replace(/_/g, ' ');
}

function buildCoverageSegments({
  request,
  rankedCandidates,
  qwenTargets,
  timelineEvents,
  strongCandidates,
  unresolvedCandidates,
  downgradedCandidates,
  rejectedCandidates,
}) {
  const confirmedCandidateIds = new Set(timelineEvents.map((event) => event.candidate_id).filter(Boolean));
  const strongCandidateIds = new Set(strongCandidates.map((candidate) => candidate.candidate_id).filter(Boolean));
  const unresolvedCandidateIds = new Set(unresolvedCandidates.map((candidate) => candidate.candidate_id).filter(Boolean));
  const downgradedCandidateIds = new Set(downgradedCandidates.map((candidate) => candidate.candidate_id).filter(Boolean));
  const rejectedCandidateIds = new Set(rejectedCandidates.map((candidate) => candidate.candidate_id).filter(Boolean));
  const qwenTargetIds = new Set(qwenTargets.map((candidate) => candidate.candidate_id).filter(Boolean));
  const segments = [];
  let cursor = Number(request.startMs || 0);
  const end = Math.max(cursor, Number(request.endMs || cursor));
  const minGapMs = 30000;

  const sorted = [...rankedCandidates].sort((a, b) => (a.start_ms || 0) - (b.start_ms || 0));
  for (const candidate of sorted) {
    const start = Math.max(Number(request.startMs || 0), Number(candidate.start_ms || 0));
    const candidateEnd = Math.max(start, Number(candidate.end_ms || start));
    if (start - cursor >= minGapMs) {
      segments.push({
        start_ms: cursor,
        end_ms: start,
        type: 'low_candidate_activity',
        status: 'no_major_cv_candidate',
        label: 'No major local CV candidate selected',
        reviewed_by_qwen: false,
        confidence: 0.35,
        basis: 'Cheap chronological CV scan did not produce a high-priority candidate window in this interval. This is not proof that nothing happened.',
        frame_refs: [],
      });
    }
    const status = candidateStatus(candidate, {
      confirmedCandidateIds,
      strongCandidateIds,
      unresolvedCandidateIds,
      downgradedCandidateIds,
      rejectedCandidateIds,
    });
    const reviewedByQwen = qwenTargetIds.has(candidate.candidate_id);
    segments.push({
      candidate_id: candidate.candidate_id,
      start_ms: start,
      end_ms: candidateEnd,
      type: candidate.type,
      status,
      label: coverageLabel(candidate.type),
      reviewed_by_qwen: reviewedByQwen,
      confidence: Number(candidate.confidence ?? candidate.review_score ?? candidate.score ?? 0),
      basis: candidate.basis || candidate.rejection_reason || (reviewedByQwen
        ? 'Targeted Qwen reviewed this candidate window.'
        : 'Candidate detected by cheap CV but not selected for targeted Qwen review.'),
      frame_refs: candidate.frame_refs || [],
      reasons: candidate.reasons || [],
      lifecycle: candidate.lifecycle || [],
      selection_reason: candidate.selection_reason || null,
    });
    cursor = Math.max(cursor, candidateEnd);
  }

  if (end - cursor >= minGapMs) {
    segments.push({
      start_ms: cursor,
      end_ms: end,
      type: 'low_candidate_activity',
      status: 'no_major_cv_candidate',
      label: 'No major local CV candidate selected',
      reviewed_by_qwen: false,
      confidence: 0.35,
      basis: 'Cheap chronological CV scan did not produce a high-priority candidate window in this interval. This is not proof that nothing happened.',
      frame_refs: [],
    });
  }

  return segments.sort((a, b) => (a.start_ms || 0) - (b.start_ms || 0));
}

function storyFromCoverageSegments({ coverageSegments, actionableFindings, strongCandidates, notConfirmed }) {
  const parts = [];
  if (coverageSegments.length) {
    parts.push(`The selected range was scanned end-to-end and summarized into ${coverageSegments.length} chronological coverage segment${coverageSegments.length === 1 ? '' : 's'}.`);
  }
  if (actionableFindings.length) {
    parts.push(`${actionableFindings.length} segment${actionableFindings.length === 1 ? '' : 's'} passed local visual gates as confirmed evidence.`);
  } else {
    parts.push('No segment passed local visual gates as a confirmed timeline event.');
  }
  if (strongCandidates.length) {
    parts.push(`${strongCandidates.length} segment${strongCandidates.length === 1 ? '' : 's'} stayed as candidate evidence for manual review.`);
  }
  if (notConfirmed.length) {
    parts.push(`${notConfirmed.length} checked item${notConfirmed.length === 1 ? '' : 's'} stayed not-confirmed instead of becoming session facts.`);
  }
  return parts.join(' ');
}

function candidateFromQwen(candidate, qwenResult) {
  const confirmedEvents = (qwenResult.timeline_events || []).filter((event) => Number(event.confidence || 0) >= 0.55);
  const promotedStages = (qwenResult.stage_candidates || []).filter((stage) => stage.stage && stage.stage !== 'unknown' && Number(stage.confidence || 0) >= 0.6);
  const visibleRows = [
    ...(qwenResult.visible_objects || []),
    ...(qwenResult.visible_actions || []),
  ].filter((item) => item.status === 'visible');
  const uncertainRows = [
    ...(qwenResult.visible_objects || []),
    ...(qwenResult.visible_actions || []),
  ].filter((item) => item.status === 'uncertain' || item.status === 'not_visible');
  const qwenEvidence = {
    qwen_summary: qwenResult.summary || '',
    qwen_visible_rows: visibleRows.map((row) => ({
      label: row.label,
      status: row.status,
      confidence: row.confidence,
      reason: row.reason,
      frame_refs: row.frame_refs || [],
    })),
    qwen_uncertain_rows: uncertainRows.slice(0, 8).map((row) => ({
      label: row.label,
      status: row.status,
      confidence: row.confidence,
      reason: row.reason,
      frame_refs: row.frame_refs || [],
    })),
    qwen_stage_candidates: (qwenResult.stage_candidates || [])
      .filter((stage) => stage.stage && stage.stage !== 'unknown')
      .map((stage) => ({
        stage: stage.stage,
        confidence: stage.confidence,
        basis: stage.basis,
        frame_refs: stage.frame_refs || [],
      })),
  };
  if (confirmedEvents.length || promotedStages.length) {
    return {
      ...candidate,
      ...qwenEvidence,
      lifecycle: [...new Set([...(candidate.lifecycle || []), 'qwen_reviewed', 'promoted_confirmed'])],
      confidence: Math.max(...confirmedEvents.map((event) => Number(event.confidence || 0)), ...promotedStages.map((stage) => Number(stage.confidence || 0)), candidate.review_score || candidate.score || 0),
      basis: qwenResult.summary,
      frame_refs: [...new Set([...frameRefs(confirmedEvents), ...frameRefs(promotedStages), ...(candidate.frame_refs || [])])],
    };
  }
  if (visibleRows.length || Number(candidate.review_score || candidate.score || 0) >= 0.45) {
    return {
      ...candidate,
      ...qwenEvidence,
      lifecycle: [...new Set([...(candidate.lifecycle || []), 'qwen_reviewed', 'kept_as_strong_candidate'])],
      confidence: Math.max(Number(candidate.review_score || candidate.score || 0), Number(qwenResult.confidence?.overall || 0)),
      basis: visibleRows.length
        ? qwenResult.summary
        : 'Local CV flagged this as a plausible motion window, but Qwen did not return enough specific visible evidence to pass the confirmation gate.',
      frame_refs: [...new Set([...frameRefs(visibleRows), ...(candidate.frame_refs || [])])],
    };
  }
  return {
    ...candidate,
    ...qwenEvidence,
    lifecycle: [...new Set([...(candidate.lifecycle || []), 'qwen_reviewed', 'rejected'])],
    confidence: Number(qwenResult.confidence?.overall || candidate.score || 0),
    rejection_reason: 'Targeted Qwen review did not confirm visible evidence above gates.',
  };
}

function rollingSummary({ candidate, qwenResult, confirmedCount, strongCount }) {
  const state = {
    scan_position_ms: candidate?.end_ms ?? null,
    latest_candidate: candidate?.type || null,
    latest_candidate_score: candidate?.score ?? null,
    anatomy_visibility: (qwenResult?.visible_objects || []).find((item) => item.label === 'genital_state_visible')?.status || 'unknown',
    manual_stimulation: (qwenResult?.stage_candidates || []).some((stage) => stage.stage === 'manual_stimulation') ? 'confirmed' : 'not_confirmed',
    fluid_event: (qwenResult?.stage_candidates || []).some((stage) => stage.stage === 'ejaculation_or_fluid_event') ? 'confirmed' : 'not_confirmed',
    confirmed_findings_count: confirmedCount,
    strong_candidates_count: strongCount,
  };
  return state;
}

function candidateProgressPayload(candidate = {}, extra = {}) {
  return {
    latest_candidate_window: {
      candidate_id: candidate.candidate_id || null,
      type: candidate.type || null,
      start_ms: candidate.start_ms ?? null,
      end_ms: candidate.end_ms ?? null,
      score: candidate.review_score ?? candidate.score ?? null,
      reasons: candidate.reasons || [],
      frame_refs: candidate.frame_refs || [],
      lifecycle: candidate.lifecycle || [],
      review_score: candidate.review_score ?? null,
      ...extra,
    },
    latest_candidate_id: candidate.candidate_id || null,
    latest_candidate_type: candidate.type || null,
    latest_candidate_score: candidate.review_score ?? candidate.score ?? null,
    latest_candidate_reasons: candidate.reasons || [],
    latest_candidate_frame_refs: candidate.frame_refs || [],
  };
}

function mmssFromMs(ms) {
  const totalSeconds = Math.max(0, Math.round(Number(ms || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export async function analyzeLocalVisionAdaptive(body, { signal, onProgress } = {}) {
  const request = normalizeAdaptiveVisionRequest(body);
  if (!request.sessionId) {
    const error = new Error('sessionId is required for adaptive local vision analysis.');
    error.status = 400;
    throw error;
  }
  if (!request.videoPath) {
    const error = new Error('videoPath is required for adaptive local vision analysis.');
    error.status = 400;
    throw error;
  }

  onProgress?.({
    phase: 'validating',
    current: 0,
    total: 6,
    message: 'Validating linked local video for adaptive local analysis...',
    analysis_type: request.recordType,
    mode: request.mode,
    privacy: { localOnly: true, cloudUpload: false },
  });
  const { video } = getTrustedRecordAndVideo(request);
  if (signal?.aborted) throw new Error('Cancelled');

  onProgress?.({
    phase: 'cv_prepass',
    current: 1,
    total: 6,
    message: 'Running cheap chronological CV pre-pass...',
    current_timestamp_ms: request.startMs,
    percent_scanned: 0,
  });
  const prepass = await runCvPrepass({
    request,
    videoPath: video.path,
    sessionId: request.sessionId,
    onProgress: (progress) => onProgress?.({
      ...progress,
      phase: 'cv_prepass',
      current: progress.current ?? 1,
      total: progress.total ?? 6,
      current_timestamp_ms: prepassTime(progress, request),
      percent_scanned: percentFromProgress(progress),
    }),
  });
  const rankedCandidates = rankCandidateWindows(prepass.candidate_windows, request.candidatePolicy.maxCandidateWindows);
  onProgress?.({
    phase: 'candidate_ranking',
    current: 2,
    total: 6,
    message: `Ranked ${rankedCandidates.length} candidate window${rankedCandidates.length === 1 ? '' : 's'} from cheap CV pre-pass.`,
    framesScanned: prepass.cvPrepassStats.frames_scanned,
    frames_scanned: prepass.cvPrepassStats.frames_scanned,
    candidatesFound: rankedCandidates.length,
    candidates_found: rankedCandidates.length,
    candidatesRanked: rankedCandidates.length,
    candidates_ranked: rankedCandidates.length,
    top_candidates: rankedCandidates.slice(0, 5).map((candidate) => ({
      candidate_id: candidate.candidate_id,
      type: candidate.type,
      start_ms: candidate.start_ms,
      end_ms: candidate.end_ms,
      score: candidate.score,
      reasons: candidate.reasons,
      frame_refs: candidate.frame_refs,
    })),
  });

  const qwenTargets = request.qwenPolicy.enabled
    ? selectQwenCandidates({ candidates: rankedCandidates, request })
    : [];
  const qwenResults = [];
  const confirmedEvents = [];
  const stateSegments = [];
  const strongCandidates = [];
  const unresolvedCandidates = [];
  const downgradedCandidates = [];
  const rejectedCandidates = [];
  const warnings = [...prepass.warnings];
  let model = null;
  let rollingState = {
    scan_position_ms: request.startMs,
    confirmed_findings_count: 0,
    strong_candidates_count: 0,
    unresolved_candidates_count: 0,
  };

  for (let index = 0; index < qwenTargets.length; index += 1) {
    const candidate = qwenTargets[index];
    if (signal?.aborted) throw new Error('Cancelled');
    onProgress?.({
      phase: 'qwen_review',
      current: index,
      total: Math.max(1, qwenTargets.length),
      qwenCallsCompleted: index,
      qwen_calls_completed: index,
      qwenCallsTotal: qwenTargets.length,
      qwen_calls_total: qwenTargets.length,
      candidatesSelectedForQwen: qwenTargets.length,
      candidates_selected_for_qwen: qwenTargets.length,
      current_timestamp_ms: candidate.start_ms,
      message: `Targeted Qwen review ${index + 1}/${qwenTargets.length}: ${String(candidate.type).replace(/_/g, ' ')} near ${mmssFromMs(candidate.start_ms)}...`,
      latest_rolling_state: rollingState,
      ...candidateProgressPayload(candidate, {
        qwen_index: index + 1,
        qwen_total: qwenTargets.length,
        selected_question_ids: questionIdsForCandidate(request.recordType, candidate),
      }),
    });
    const sampled = await sampleLocalVisionFrames({
      videoPath: video.path,
      sessionId: request.sessionId,
      startMs: candidate.start_ms,
      endMs: candidate.end_ms,
      samplePolicy: {
        fps: Math.max(0.5, Math.min(4, request.candidatePolicy.motionPeakFps || 2)),
        maxFrames: request.qwenPolicy.maxFramesPerWindow,
        dedupe: true,
        thumbnailWidth: request.candidatePolicy.thumbnailWidth,
      },
      onProgress: (progress) => onProgress?.({
        ...progress,
        phase: 'qwen_window_sampling',
        current: index,
        total: Math.max(1, qwenTargets.length),
        qwenCallsCompleted: index,
        qwen_calls_completed: index,
        qwenCallsTotal: qwenTargets.length,
        qwen_calls_total: qwenTargets.length,
        message: `Sampling candidate ${index + 1}/${qwenTargets.length} frames for targeted Qwen review...`,
        current_timestamp_ms: candidate.start_ms,
        latest_rolling_state: rollingState,
        ...candidateProgressPayload(candidate, {
          qwen_index: index + 1,
          qwen_total: qwenTargets.length,
        }),
      }),
    });
    const questions = request.questions.filter((question) => questionIdsForCandidate(request.recordType, candidate).includes(question.id));
    onProgress?.({
      phase: 'qwen_review',
      current: index,
      total: Math.max(1, qwenTargets.length),
      qwenCallsCompleted: index,
      qwen_calls_completed: index,
      qwenCallsTotal: qwenTargets.length,
      qwen_calls_total: qwenTargets.length,
      candidatesSelectedForQwen: qwenTargets.length,
      candidates_selected_for_qwen: qwenTargets.length,
      current_timestamp_ms: candidate.start_ms,
      message: `Sending candidate ${index + 1}/${qwenTargets.length} to Qwen: ${questions.length} focused visual question${questions.length === 1 ? '' : 's'}, ${sampled.frames.length} frame${sampled.frames.length === 1 ? '' : 's'}...`,
      latest_rolling_state: rollingState,
      ...candidateProgressPayload(candidate, {
        qwen_index: index + 1,
        qwen_total: qwenTargets.length,
        selected_question_ids: questions.map((question) => question.id),
        qwen_sampled_frames: sampled.frames.length,
      }),
    });
    let qwenResult;
    try {
      const extracted = await callLocalQwenBatch({
        questions,
        frames: sampled.frames,
        recordType: request.recordType,
        signal,
      });
      model = extracted.model || model;
      warnings.push(...extracted.warnings);
      qwenResult = deriveLocalVisionResult({
        request: {
          ...request,
          startMs: candidate.start_ms,
          endMs: candidate.end_ms,
          previousVisualState: {
            ...(request.previousVisualState || {}),
            rollingState,
            scaleCalibration: request.scaleCalibration,
          },
        },
        frames: sampled.frames,
        questions,
        answers: extracted.answers,
        engine: request.engine,
        model: extracted.model,
        warnings: [],
      });
    } catch (error) {
      warnings.push(`Targeted Qwen review failed for ${candidate.candidate_id}: ${error?.message || error}`);
      qwenResult = {
        ok: true,
        summary: 'Targeted Qwen review failed; candidate left unresolved.',
        visible_objects: [],
        visible_actions: [],
        stage_candidates: [],
        forbidden_or_not_visible: [],
        timeline_events: [],
        frame_evidence: sampled.frames.map((frame) => ({ frame_id: frame.frame_id, time_ms: frame.time_ms, image_path: frame.image_path, observations: [] })),
        confidence: { overall: 0.2, visibility_quality: 0.2 },
      };
    }
    qwenResults.push({ ...qwenResult, candidate_id: candidate.candidate_id });
    const reviewedCandidate = candidateFromQwen(candidate, qwenResult);
    const promoted = reviewedCandidate.lifecycle.includes('promoted_confirmed');
    const kept = reviewedCandidate.lifecycle.includes('kept_as_strong_candidate');
    const rejected = reviewedCandidate.lifecycle.includes('rejected');
    if (promoted) {
      for (const event of qwenResult.timeline_events || []) confirmedEvents.push({ ...event, candidate_id: candidate.candidate_id, source: 'adaptive_qwen_state_machine' });
      for (const stage of qwenResult.stage_candidates || []) {
        if (stage.stage && stage.stage !== 'unknown' && Number(stage.confidence || 0) >= 0.6) {
          confirmedEvents.push({
            event_type: 'stage_candidate',
            label: String(stage.stage).replace(/_/g, ' '),
            confidence: stage.confidence,
            start_ms: candidate.start_ms,
            end_ms: candidate.end_ms,
            frame_refs: stage.frame_refs || [],
            basis: stage.basis,
            source: 'adaptive_qwen_state_machine',
            candidate_id: candidate.candidate_id,
          });
          stateSegments.push(stateSegmentFromStage(stage, candidate));
        }
      }
    } else if (kept) {
      strongCandidates.push(reviewedCandidate);
    } else if (rejected) {
      rejectedCandidates.push(reviewedCandidate);
    } else {
      unresolvedCandidates.push(reviewedCandidate);
    }
    rollingState = rollingSummary({
      candidate: reviewedCandidate,
      qwenResult,
      confirmedCount: confirmedEvents.length,
      strongCount: strongCandidates.length,
    });
    onProgress?.({
      phase: 'qwen_review',
      current: index + 1,
      total: Math.max(1, qwenTargets.length),
      qwenCallsCompleted: index + 1,
      qwen_calls_completed: index + 1,
      qwenCallsTotal: qwenTargets.length,
      qwen_calls_total: qwenTargets.length,
      confirmedFindingsCount: confirmedEvents.length,
      confirmed_findings_count: confirmedEvents.length,
      strongCandidatesCount: strongCandidates.length,
      strong_candidates_count: strongCandidates.length,
      notConfirmedCount: buildNotConfirmed({ recordType: request.recordType, qwenResults, rejectedCandidates }).length,
      not_confirmed_count: buildNotConfirmed({ recordType: request.recordType, qwenResults, rejectedCandidates }).length,
      latest_rolling_state: rollingState,
      ...candidateProgressPayload(reviewedCandidate, {
        qwen_index: index + 1,
        qwen_total: qwenTargets.length,
        qwen_result_summary: qwenResult.summary,
        visible_object_rows: qwenResult.visible_objects?.length || 0,
        visible_action_rows: qwenResult.visible_actions?.length || 0,
        stage_candidate_rows: qwenResult.stage_candidates?.length || 0,
        forbidden_rows: qwenResult.forbidden_or_not_visible?.length || 0,
      }),
      message: `Reviewed candidate ${index + 1}/${qwenTargets.length}: ${confirmedEvents.length} confirmed, ${strongCandidates.length} candidate${strongCandidates.length === 1 ? '' : 's'} kept.`,
    });
  }

  const unreviewedCandidates = rankedCandidates
    .filter((candidate) => !qwenTargets.some((target) => target.candidate_id === candidate.candidate_id))
    .map((candidate) => ({
      ...candidate,
      lifecycle: [...new Set([...(candidate.lifecycle || []), request.qwenPolicy.enabled ? 'downgraded' : 'unresolved'])],
      basis: request.qwenPolicy.enabled ? 'Ranked below targeted Qwen review cap.' : 'Fast Preview ran without targeted Qwen review.',
    }));
  downgradedCandidates.push(...unreviewedCandidates.filter((candidate) => candidate.lifecycle.includes('downgraded')));
  unresolvedCandidates.push(...unreviewedCandidates.filter((candidate) => candidate.lifecycle.includes('unresolved')));

  onProgress?.({
    phase: 'state_machine',
    current: 5,
    total: 6,
    message: 'Assembling chronological adaptive local vision result...',
    confirmedFindingsCount: confirmedEvents.length,
    strongCandidatesCount: strongCandidates.length,
    downgradedRejectedCandidatesCount: downgradedCandidates.length + rejectedCandidates.length,
  });

  const timelineEvents = uniqueBy(confirmedEvents, eventKey)
    .map((event, index) => promoteEvent(event, index, rankedCandidates.find((candidate) => candidate.candidate_id === event.candidate_id)))
    .sort((a, b) => a.start_ms - b.start_ms);
  const notConfirmed = buildNotConfirmed({ recordType: request.recordType, qwenResults, rejectedCandidates });
  const actionableFindings = timelineEvents;
  const coverageSegments = buildCoverageSegments({
    request,
    rankedCandidates,
    qwenTargets,
    timelineEvents,
    strongCandidates,
    unresolvedCandidates,
    downgradedCandidates,
    rejectedCandidates,
  });
  const limitations = [
    'Adaptive local analysis uses cheap CV candidates plus targeted Qwen verification; it does not inspect every frame with Qwen by default.',
    'Only confirmed visible evidence is promoted into actionable findings.',
    'Subjective states such as orgasm, arousal, pain, pleasure, or intent are not inferred.',
  ];
  const sessionAnalysisExport = buildSessionAnalysisExport({
    mode: request.mode,
    recordType: request.recordType,
    actionableFindings,
    strongCandidates,
    unresolvedCandidates,
    downgradedCandidates,
    notConfirmed,
    coverageSegments,
    limitations,
  });
  const wholeVideoStory = storyFromCoverageSegments({
    coverageSegments,
    actionableFindings,
    strongCandidates,
    notConfirmed,
  });
  const evidenceFrames = uniqueBy([
    ...prepass.frames.map((frame) => ({ frame_id: frame.frame_id, time_ms: frame.time_ms, image_path: frame.image_path, source: 'cv_prepass' })),
    ...qwenResults.flatMap((result) => result.frame_evidence || []).map((frame) => ({ ...frame, source: 'qwen_target' })),
  ], (frame) => `${frame.source}:${frame.frame_id}:${frame.time_ms}`);
  const result = {
    ok: true,
    engine: request.engine,
    mode: request.mode,
    recordType: request.recordType,
    model: model || { name: 'Qwen/Qwen2.5-VL-7B-Instruct', device: 'unknown', quantization: 'unknown' },
    privacy: { localOnly: true, cloudUpload: false },
    range: { startMs: request.startMs, endMs: request.endMs },
    summary: [
      `Adaptive local ${request.mode.replace(/_/g, ' ')} reviewed ${prepass.cvPrepassStats.frames_scanned} cheap-CV frames in chronological order.`,
      `${rankedCandidates.length} candidate window${rankedCandidates.length === 1 ? '' : 's'} detected; ${qwenTargets.length} targeted Qwen review${qwenTargets.length === 1 ? '' : 's'} run.`,
      `${coverageSegments.length} chronological coverage segment${coverageSegments.length === 1 ? '' : 's'} assembled for whole-range review.`,
      actionableFindings.length ? `${actionableFindings.length} confirmed finding${actionableFindings.length === 1 ? '' : 's'} promoted.` : 'No confirmed timeline events were promoted.',
      strongCandidates.length ? `${strongCandidates.length} strong candidate${strongCandidates.length === 1 ? '' : 's'} kept for review.` : '',
    ].filter(Boolean).join(' '),
    whole_video_story: wholeVideoStory,
    coverage_segments: coverageSegments,
    actionable_findings: actionableFindings.map(findingFromEvent),
    strong_candidates: strongCandidates.map((candidate) => candidateSummary(candidate, 'candidate_not_confirmed')),
    unresolved_candidates: unresolvedCandidates.map((candidate) => candidateSummary(candidate, 'unresolved')),
    downgraded_candidates: downgradedCandidates.map((candidate) => candidateSummary(candidate, 'downgraded')),
    rejected_candidates: rejectedCandidates.map((candidate) => candidateSummary(candidate, 'rejected')),
    not_confirmed: notConfirmed,
    timeline_events: timelineEvents,
    state_segments: stateSegments.sort((a, b) => (a.start_ms || 0) - (b.start_ms || 0)),
    candidate_windows: rankedCandidates,
    evidence_frames: evidenceFrames.sort((a, b) => Number(a.time_ms || 0) - Number(b.time_ms || 0)),
    frame_evidence: evidenceFrames.sort((a, b) => Number(a.time_ms || 0) - Number(b.time_ms || 0)),
    session_analysis_export: sessionAnalysisExport,
    debug: {
      rawEvidenceCounts: {
        qwen_results: qwenResults.length,
        visible_objects: qwenResults.reduce((sum, item) => sum + (item.visible_objects?.length || 0), 0),
        visible_actions: qwenResults.reduce((sum, item) => sum + (item.visible_actions?.length || 0), 0),
        forbidden_or_not_visible: qwenResults.reduce((sum, item) => sum + (item.forbidden_or_not_visible?.length || 0), 0),
      },
      qwenCalls: qwenTargets.length,
      cvPrepassStats: prepass.cvPrepassStats,
      qwen_results: qwenResults,
      rolling_state: rollingState,
      qwen_selection: qwenTargets.map((candidate) => ({
        candidate_id: candidate.candidate_id,
        start_ms: candidate.start_ms,
        end_ms: candidate.end_ms,
        type: candidate.type,
        score: candidate.score,
        review_score: candidate.review_score,
        selection_reason: candidate.selection_reason,
      })),
    },
    confidence: {
      overall: actionableFindings.length ? 0.72 : strongCandidates.length ? 0.55 : 0.35,
      visibility_quality: prepass.frames.length ? 0.7 : 0.2,
      motion_quality: rankedCandidates.length ? 0.65 : 0.25,
    },
    warnings: uniqueBy(warnings, (text) => text),
    limitations,
  };
  const saved = saveLocalVisionResult({
    request,
    videoPath: video.path,
    engine: request.engine,
    analysisType: `adaptive_${request.mode}`,
    result,
  });
  onProgress?.({
    phase: 'done',
    current: 6,
    total: 6,
    message: 'Adaptive local vision analysis complete.',
    confirmedFindingsCount: actionableFindings.length,
    confirmed_findings_count: actionableFindings.length,
    strongCandidatesCount: strongCandidates.length,
    strong_candidates_count: strongCandidates.length,
    notConfirmedCount: notConfirmed.length,
    not_confirmed_count: notConfirmed.length,
    warningsCount: result.warnings.length,
    warnings_count: result.warnings.length,
    latest_rolling_state: rollingState,
  });
  return { ...result, id: saved.id, created_at: saved.created_at };
}

function prepassTime(progress, request) {
  const total = Number(progress.total || 0);
  const current = Number(progress.current || progress.framesScanned || progress.frames_scanned || 0);
  if (!total || !current) return request.startMs;
  return Math.round(request.startMs + ((request.endMs - request.startMs) * Math.min(1, current / total)));
}

function percentFromProgress(progress) {
  const total = Number(progress.total || 0);
  const current = Number(progress.current || progress.framesScanned || progress.frames_scanned || 0);
  if (!total || !current) return 0;
  return Math.round(Math.min(100, Math.max(0, (current / total) * 100)));
}
