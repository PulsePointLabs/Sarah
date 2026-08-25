import crypto from 'node:crypto';
import path from 'node:path';
import fsp from 'node:fs/promises';

export const CLOUD_ANALYSIS_SCHEMA_VERSION = 'sarah.multimodal-evidence.v1';

const STREAM_FIELDS = {
  heart_rate: ['time_offset_s', 'time_offset_ms', 'timestamp', 'hr', 'hr_smoothed', 'baseline_hr', 'elevated_delta', 'rr_intervals_ms', 'rmssd_ms', 'sdnn_ms', 'marker', 'note'],
  emg: ['time_s', 'iso_time', 'left_raw', 'right_raw', 'left_env', 'right_env', 'left_pct', 'right_pct', 'level_pct', 'marker'],
  howl_commands: ['created_at', 'action', 'channel', 'intensity', 'frequency_hz', 'mode', 'waveform', 'enabled', 'play', 'status', 'ack_at'],
  blood_pressure: ['time_offset_s', 'measured_at', 'systolic_mm_hg', 'diastolic_mm_hg', 'pulse_bpm', 'body_position', 'source_device'],
  pulse_ox: ['time_offset_s', 'measured_at', 'spo2_percent', 'pulse_bpm', 'perfusion_index', 'source_device'],
  annotations: ['time_s', 'start_offset_s', 'end_offset_s', 'type', 'category', 'note', 'transcript', 'source', 'annotation_tags'],
};

function finiteNumber(value, fallback = null) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function compactFields(rows = [], allowedFields = []) {
  const present = new Set();
  for (const row of rows.slice(0, 500)) {
    for (const field of allowedFields) {
      if (row?.[field] !== undefined && row?.[field] !== null && row?.[field] !== '') present.add(field);
    }
  }
  return [...present];
}

function firstFinite(rows, fields) {
  for (const row of rows) {
    for (const field of fields) {
      const value = finiteNumber(row?.[field]);
      if (value !== null) return value;
    }
  }
  return null;
}

function timeRange(rows = [], fields = []) {
  let start = null;
  let end = null;
  for (const row of rows) {
    const value = firstFinite([row], fields);
    if (value === null) continue;
    start = start === null ? value : Math.min(start, value);
    end = end === null ? value : Math.max(end, value);
  }
  return start === null ? null : { start_s: start, end_s: end };
}

function streamDescriptor(name, rows = [], timeFields = []) {
  const safeRows = Array.isArray(rows) ? rows.filter(Boolean) : [];
  return {
    name,
    available: safeRows.length > 0,
    row_count: safeRows.length,
    time_range: timeRange(safeRows, timeFields),
    fields_present: compactFields(safeRows, STREAM_FIELDS[name] || []),
    encrypted_bundle_path: `evidence/${name}.jsonl`,
  };
}

function recordReference(recordType, recordId) {
  const digest = crypto.createHash('sha256').update(`${recordType}:${recordId}`).digest('hex').slice(0, 20);
  return `record_${digest}`;
}

function inferVideoRole(video = {}) {
  const value = `${video.role || ''} ${video.label || ''} ${video.filename || ''} ${video.path || ''}`.toLowerCase();
  if (/feet|foot/.test(value)) return 'feet';
  if (/lateral|side/.test(value)) return 'lateral';
  if (/close|detail|macro/.test(value)) return 'close';
  if (/wide|full/.test(value)) return 'wide';
  return 'unknown';
}

async function inspectVideo(video = {}, index = 0) {
  const localPath = String(video.path || '').trim();
  let stat = null;
  let statError = '';
  try {
    stat = localPath ? await fsp.stat(localPath) : null;
  } catch (error) {
    statError = error?.code || error?.message || 'unavailable';
  }
  const assetId = `video_${String(index + 1).padStart(2, '0')}`;
  const filename = path.basename(localPath || video.filename || video.label || assetId);
  return {
    local: {
      asset_id: assetId,
      local_path: localPath,
      exists: Boolean(stat?.isFile()),
      size_bytes: stat?.size || 0,
      error: statError || null,
    },
    cloud: {
      asset_id: assetId,
      filename,
      role: inferVideoRole(video),
      size_bytes: stat?.size || 0,
      source_zero_session_ms: Math.round((finiteNumber(video.timelineOffsetSeconds, 0) || 0) * 1000),
      duration_ms: Math.round((finiteNumber(video.durationSeconds ?? video.duration_seconds ?? video.duration_s, 0) || 0) * 1000),
      fingerprint: String(video.fingerprint || '').slice(0, 160) || null,
      encrypted_bundle_path: `media/${assetId}/${filename}`,
    },
  };
}

export async function buildCloudAnalysisPreflight({
  record,
  recordType,
  videos = [],
  heartRateRows = [],
  emgRows = [],
  howlCommands = [],
  bloodPressureRows = [],
  pulseOxRows = [],
} = {}) {
  if (!record?.id) throw new Error('A saved Session or Body Exploration record is required.');
  const normalizedType = recordType === 'body_exploration' ? 'body_exploration' : 'session';
  const inspectedVideos = await Promise.all((Array.isArray(videos) ? videos : []).map(inspectVideo));
  const annotationRows = Array.isArray(record.event_timeline) ? record.event_timeline.filter(Boolean) : [];
  const streams = [
    streamDescriptor('heart_rate', heartRateRows, ['time_offset_s']),
    streamDescriptor('emg', emgRows, ['time_s']),
    streamDescriptor('howl_commands', howlCommands, ['time_offset_s']),
    streamDescriptor('blood_pressure', bloodPressureRows, ['time_offset_s']),
    streamDescriptor('pulse_ox', pulseOxRows, ['time_offset_s']),
    streamDescriptor('annotations', annotationRows, ['time_s', 'start_offset_s']),
  ];
  const missingVideos = inspectedVideos.filter((item) => !item.local.exists);
  const unalignedStreams = streams.filter((stream) => stream.available && !stream.time_range && stream.name !== 'annotations');

  return {
    cloudJob: {
      schema_version: CLOUD_ANALYSIS_SCHEMA_VERSION,
      job_kind: 'full_multimodal_session_analysis',
      record_ref: recordReference(normalizedType, record.id),
      record_type: normalizedType,
      created_at: new Date().toISOString(),
      source_media: inspectedVideos.map((item) => item.cloud),
      evidence_streams: streams,
      context: {
        encrypted_bundle_path: 'context/record.json',
        has_notes: Boolean(String(record.notes || record.purpose || record.observed_findings || '').trim()),
        manual_annotation_count: annotationRows.filter((item) => !String(item?.source || '').startsWith('ai_')).length,
      },
      requested_analysis: {
        audio: ['word_timed_transcript', 'speaker_diarization', 'breathing_activity', 'gasp_sigh_candidates', 'vocalization_candidates', 'acoustic_features'],
        visual: ['multi_person_pose', 'body_region_tracks', 'hand_and_device_tracks', 'regional_motion', 'occlusion_and_reacquisition', 'semantic_event_windows'],
        fusion: ['single_session_timeline', 'physiology_corroboration', 'cross_camera_alignment', 'evidence_confidence', 'ai_annotation_packet'],
      },
      evidence_contract: {
        required_time_fields: ['source_start_ms', 'source_end_ms', 'session_start_ms', 'session_end_ms'],
        required_provenance_fields: ['modality', 'source_asset_id', 'model_name', 'model_version', 'confidence'],
        claim_states: ['observed', 'derived', 'inferred', 'user_confirmed'],
        tracking_states: ['visible', 'occluded', 'lost', 'coasting', 'reacquired'],
      },
      privacy: {
        raw_media_retention: 'none_after_job',
        encrypted_in_transit: true,
        encrypted_bundle_required: true,
        provider_logs_must_exclude_payloads: true,
        local_paths_included: false,
      },
    },
    localAssets: inspectedVideos.map((item) => item.local),
    readiness: {
      ready_to_package: inspectedVideos.length > 0 && missingVideos.length === 0,
      video_count: inspectedVideos.length,
      available_video_count: inspectedVideos.length - missingVideos.length,
      missing_video_count: missingVideos.length,
      available_evidence_streams: streams.filter((stream) => stream.available).map((stream) => stream.name),
      warnings: [
        ...(inspectedVideos.length ? [] : ['No linked local videos were found.']),
        ...missingVideos.map((item) => `Missing linked video: ${item.cloud.filename}`),
        ...(heartRateRows.length ? [] : ['No HeartRateTimeline rows are attached to this record.']),
        ...unalignedStreams.map((stream) => `${stream.name} is available but does not yet have session-relative timestamps.`),
      ],
    },
  };
}
