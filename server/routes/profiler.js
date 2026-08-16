import express from 'express';
import { listEntityPage } from '../db.js';

export const profilerRouter = express.Router();

const SESSION_FIELDS = [
  'id', 'created_date', 'updated_date', 'date', 'start_time', 'end_time',
  'duration_minutes', 'methods', 'custom_methods', 'intensity', 'satisfaction',
  'build_quality', 'build_type', 'avg_hr', 'max_hr', 'hr_at_climax',
  'pre_climax_offset_s', 'climax_offset_s', 'recovery_offset_s', 'no_climax',
  'is_favorite', 'mood', 'environment', 'substances', 'discomfort',
  'discomfort_entries', 'unusual_sensations', 'notes', 'session_context',
  'blood_pressure_readings', 'latest_blood_pressure_reading',
  'pulse_ox_readings', 'latest_pulse_ox_reading', 'pulse_ox_source',
  'fatigue', 'hydration', 'hydration_state', 'food_state',
  'privacy_interruptibility', 'mental_state', 'environmental_preparation',
  'enema_instilled_total_ml', 'enema_instillation_count',
];

const EXPLORATION_FIELDS = [
  'id', 'created_date', 'updated_date', 'date', 'start_time', 'end_time',
  'duration_minutes', 'purpose', 'focus_areas', 'findings', 'notes',
  'comfort_notes', 'tags', 'methods', 'capture_source',
];

const EVENT_FIELDS = [
  'id', 'time_s', 'offset_s', 'timestamp_s', 'category', 'source', 'note',
  'label', 'description', 'text', 'verification_status', 'verified_at',
  'confidence',
  'blood_pressure', 'pulse_ox', 'procedure_measurement',
  'cumulative_instilled_volume_ml',
];

const MOTION_SUMMARY_FIELDS = [
  'source', 'status', 'analyzed_at', 'mode', 'lower_body_tracking_method',
  'left_right_orientation', 'forefoot_enabled', 'window_start_s', 'window_end_s',
  'sample_rate_fps', 'detection_coverage_pct', 'left_lower_body_coverage_pct',
  'right_lower_body_coverage_pct', 'hand_coverage_pct', 'quality_indicators',
  'asymmetry_summary', 'lower_body_pattern_summary', 'lower_body_posture_summary',
  'foot_geometry_tracking_summary', 'manual_foot_landmarks',
  'manual_foot_landmark_geometry', 'region_segment_summary',
  'left_lower_body_average_activity', 'right_lower_body_average_activity',
  'left_forefoot_average_activity', 'right_forefoot_average_activity',
  'hand_average_activity', 'hand_movement_summary', 'hand_behavior_summary',
  'findings', 'review_peaks', 'interpretation_guardrail', 'normalization_guardrail',
];

const FOOT_GEOMETRY_SUMMARY_FIELDS = [
  'status', 'method', 'coverage_pct', 'sample_count', 'sample_rate_fps',
  'average_fan_angle_deg', 'average_toe_gap_normalized',
  'average_heel_gap_normalized', 'fan_angle_range_deg',
  'toe_gap_range_normalized', 'heel_gap_range_normalized',
  'accepted_marker_frame_pct', 'attempted_marker_frames',
  'accepted_marker_frames', 'rejected_marker_frames', 'anchor_matched_frames',
  'vertical_sort_fallback_frames', 'confidence_frame_counts',
  'interpretation_hint', 'method_note',
];

function pick(source, fields) {
  if (!source || typeof source !== 'object') return undefined;
  const result = {};
  for (const field of fields) {
    if (source[field] !== undefined) result[field] = source[field];
  }
  return Object.keys(result).length ? result : undefined;
}

function compactText(value, maxLength = 6000) {
  const text = String(value || '').trim();
  return text ? text.slice(0, maxLength) : undefined;
}

function compactVideoPassCard(card) {
  if (!card || typeof card !== 'object') return undefined;
  const frames = Array.isArray(card.sampled_frames) ? card.sampled_frames : [];
  const representativeFrame = frames.length ? frames[Math.floor(frames.length / 2)] : null;
  const clip = pick(card.clip, ['url', 'thumbnail_url', 'start_s', 'end_s', 'duration_s']);
  const result = pick(card, ['id', 'saved_at', 'label']) || {};
  const summary = compactText(card.summary, 900);
  const telemetry = compactText(card.telemetry, 400);
  const findings = (Array.isArray(card.findings) ? card.findings : [card.findings])
    .flatMap((finding) => typeof finding === 'string' ? [finding] : [finding?.findingText, finding?.text, finding?.finding])
    .map((finding) => compactText(finding, 700))
    .filter(Boolean)
    .slice(0, 12);
  const sourceVideo = pick(card.source_video || card.sourceVideo, ['id', 'label', 'filename']);
  const draftEvents = compactEvents(card.draft_events || card.events);
  if (clip) result.clip = clip;
  if (sourceVideo) result.source_video = sourceVideo;
  if (summary) result.summary = summary;
  if (telemetry) result.telemetry = telemetry;
  if (findings.length) result.findings = findings;
  if (draftEvents.length) result.draft_events = draftEvents.slice(0, 10);
  if (representativeFrame) {
    const frame = pick(representativeFrame, ['url', 'recordTimeSeconds', 'time_s', 'timestamp_s']);
    if (frame) result.sampled_frames = [frame];
  }
  return Object.keys(result).length ? result : undefined;
}

function compactAiEvidence(value) {
  if (!value || typeof value !== 'object') return undefined;
  const result = {};
  if (Array.isArray(value._visual_findings)) result._visual_findings = value._visual_findings;
  if (Array.isArray(value._video_pass_findings)) {
    result._video_pass_findings = value._video_pass_findings.map(compactVideoPassCard).filter(Boolean);
  }
  const digest = compactText(value._video_pass_digest);
  if (digest) result._video_pass_digest = digest;
  return Object.keys(result).length ? result : undefined;
}

function compactEvents(events) {
  if (!Array.isArray(events)) return [];
  return events.map((event) => {
    const compact = pick(event, EVENT_FIELDS);
    if (!compact) return undefined;
    for (const field of ['note', 'label', 'description', 'text']) {
      if (compact[field] !== undefined) compact[field] = compactText(compact[field], 600);
    }
    return compact;
  }).filter(Boolean);
}

export function compactProfilerSession(session) {
  const result = pick(session, SESSION_FIELDS) || {};
  const events = compactEvents(session?.event_timeline);
  const motion = pick(session?.motion_analysis_summary, MOTION_SUMMARY_FIELDS);
  const aiAnalysis = compactAiEvidence(session?.ai_analysis);
  if (motion?.foot_geometry_tracking_summary) {
    motion.foot_geometry_tracking_summary = pick(
      motion.foot_geometry_tracking_summary,
      FOOT_GEOMETRY_SUMMARY_FIELDS,
    );
  }
  if (events.length) result.event_timeline = events;
  if (motion) result.motion_analysis_summary = motion;
  if (aiAnalysis) result.ai_analysis = aiAnalysis;
  return result;
}

export function compactProfilerBodyExploration(exploration) {
  const result = pick(exploration, EXPLORATION_FIELDS) || {};
  const aiEvidence = compactAiEvidence(exploration?.ai_body_exploration);
  if (aiEvidence) result.ai_body_exploration = aiEvidence;
  return result;
}

function safeLimit(value, fallback, maximum) {
  const parsed = Math.round(Number(value));
  return Number.isFinite(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

profilerRouter.get('/evidence', (req, res) => {
  try {
    const sessionLimit = safeLimit(req.query.sessionLimit, 300, 500);
    const explorationLimit = safeLimit(req.query.explorationLimit, 150, 300);
    const sessions = listEntityPage('Session', {
      fields: [...SESSION_FIELDS, 'event_timeline', 'motion_analysis_summary', 'ai_analysis'],
      sort: '-date',
      limit: sessionLimit,
    })
      .map(compactProfilerSession);
    const bodyExplorations = listEntityPage('BodyExploration', {
      fields: [...EXPLORATION_FIELDS, 'ai_body_exploration'],
      sort: '-date',
      limit: explorationLimit,
    })
      .map(compactProfilerBodyExploration);
    res.setHeader('Cache-Control', 'no-store');
    res.json({
      sessions,
      bodyExplorations,
      meta: {
        compact: true,
        sessionCount: sessions.length,
        bodyExplorationCount: bodyExplorations.length,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error?.message || String(error) });
  }
});
