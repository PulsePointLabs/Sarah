import test from 'node:test';
import assert from 'node:assert/strict';
import { fuseCloudMultimodalEvidence } from './fusion.js';
import { buildCloudAnalysisRecordUpdate } from './persistence.js';

test('cloud fusion aligns overlapping evidence and does not auto-promote candidates', () => {
  const result = fuseCloudMultimodalEvidence({
    audioResult: {
      ok: true,
      job_id: 'audio-job',
      audio: { duration_seconds: 20 },
      transcription: { model: 'whisper', segments: [] },
      acoustic_events: [{ start_s: 9, end_s: 12, label: 'Sigh', confidence: 0.8, confidence_band: 'strong', model: 'ast' }],
    },
    visualResult: {
      ok: true,
      job_id: 'visual-job',
      asset_id: 'visual',
      video: { duration_seconds: 20, width: 1280, height: 720, fps: 2 },
      frame_metrics: [{ time_s: 0 }, { time_s: 10 }],
      pose_samples: [{ tracking_state: 'visible' }, { tracking_state: 'lost' }],
      semantic_windows: [{
        source_start_s: 8,
        source_end_s: 11,
        representative_time_s: 10,
        source_asset_id: 'visual',
        model_name: 'qwen',
        model_version: '7b',
        description: { body_position: 'supine', actions: ['The subject is moving their hands'], uncertainty: 'limited angle' },
      }],
    },
    preflight: { cloudJob: { evidence_streams: [{ name: 'heart_rate', available: true }] } },
    physiology: {
      heartRateRows: [{ time_offset_s: 9, hr: 100 }, { time_offset_s: 10, hr: 110 }],
      bloodPressureRows: [{ time_offset_s: 10, systolic_mm_hg: 120, diastolic_mm_hg: 80 }],
    },
  });

  assert.equal(result.ok, true);
  assert.equal(result.actionable_findings.length, 0);
  assert.equal(result.timeline_events.length, 0);
  assert.equal(result.multimodal_windows[0].audio_candidates[0].label, 'Sigh');
  assert.deepEqual(result.physiology.available_streams, ['heart_rate']);
  assert.equal(result.visual_summary.pose_visible, 1);
  assert.equal(result.visual_summary.pose_lost, 1);
  assert.equal(result.multimodal_windows[0].physiology.heart_rate_bpm.avg, 105);
  assert.equal(result.multimodal_windows[0].physiology.blood_pressure[0].systolic_mm_hg, 120);
  assert.equal(result.multimodal_windows[0].label, 'cloud_visual_review_candidate');
  assert.match(result.multimodal_windows[0].review_summary, /^You appear supine\. Visible activity: you are moving your hands\./);
  assert.doesNotMatch(result.multimodal_windows[0].review_summary, /\b(their|they|them)\b/i);
  assert.doesNotMatch(result.multimodal_windows[0].review_summary, /[,;]\s+(Your|You|The)\b/);
  assert.deepEqual(result.multimodal_windows[0].visual_evidence.actions, ['The subject is moving their hands']);
  assert.doesNotMatch(result.multimodal_windows[0].basis, /\.\.\.$/);
});

test('cloud fusion keeps malformed raw model output without dumping it into the readable note', () => {
  const result = fuseCloudMultimodalEvidence({
    audioResult: { ok: true, job_id: 'audio-job', audio: { duration_seconds: 3 }, transcription: { segments: [] }, acoustic_events: [] },
    visualResult: {
      ok: true,
      job_id: 'visual-job',
      asset_id: 'visual',
      video: { duration_seconds: 3 },
      semantic_windows: [{
        source_start_s: 0,
        source_end_s: 2,
        description: { raw_description: '{"actions":["incomplete response', parse_state: 'unstructured' },
      }],
    },
  });
  const window = result.multimodal_windows[0];
  assert.match(window.review_summary, /response ended before every requested field was complete/);
  assert.doesNotMatch(window.review_summary, /incomplete response/);
  assert.equal(window.visual_evidence.raw_model_output, '{"actions":["incomplete response');
  assert.equal(window.visual_evidence.parse_state, 'unstructured');
});

test('cloud fusion recovers complete fields from a token-truncated visual JSON response', () => {
  const raw = '{"body_position":["The subject is supine"],"actions":["hand moves';
  const result = fuseCloudMultimodalEvidence({
    audioResult: { ok: true, job_id: 'audio-job', audio: { duration_seconds: 3 }, transcription: { segments: [] }, acoustic_events: [] },
    visualResult: {
      ok: true,
      job_id: 'visual-job',
      asset_id: 'visual',
      video: { duration_seconds: 3 },
      semantic_windows: [{ source_start_s: 0, source_end_s: 2, description: { raw_description: raw, parse_state: 'unstructured' } }],
    },
  });
  const window = result.multimodal_windows[0];
  assert.match(window.review_summary, /^You are supine\./);
  assert.equal(window.visual_evidence.body_position[0], 'The subject is supine');
  assert.equal(window.visual_evidence.raw_model_output, raw);
});

test('cloud persistence keeps existing analysis and stores path-free source metadata', () => {
  const update = buildCloudAnalysisRecordUpdate({ ai_analysis: { narrative: 'keep me' } }, {
    result: { ok: true, id: 'cloud-1', summary: 'ready' },
    sourceVideo: { filename: 'wide.mkv', role: 'wide', fingerprint: 'abc', local_path: 'E:\\private.mkv' },
    savedAt: '2026-08-25T20:00:00.000Z',
  });
  assert.equal(update.analysis.narrative, 'keep me');
  assert.equal(update.analysis.cloud_multimodal_passes[0].result.id, 'cloud-1');
  assert.equal(update.analysis.cloud_multimodal_passes[0].source_video.filename, 'wide.mkv');
  assert.equal('local_path' in update.analysis.cloud_multimodal_passes[0].source_video, false);
});
