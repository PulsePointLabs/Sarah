import test from 'node:test';
import assert from 'node:assert/strict';
import { fuseCloudMultimodalEvidence } from './fusion.js';

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
        description: { body_position: 'supine', actions: ['hand movement'], uncertainty: 'limited angle' },
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
});
