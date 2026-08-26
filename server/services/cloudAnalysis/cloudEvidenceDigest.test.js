import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildBodyExplorationVideoPassDigest,
  buildCloudMultimodalEvidenceDigest,
  buildSessionVideoPassDigest,
} from '../../../src/lib/visualEvidence.js';

function cloudPass() {
  return {
    saved_at: '2026-08-25T20:00:00.000Z',
    source_video: { filename: 'wide.mkv', source_zero_session_ms: 5000 },
    result: {
      ok: true,
      summary: 'Cloud review covered the complete video.',
      strong_candidates: [{
        start_ms: 10000,
        end_ms: 12000,
        label: 'cloud_visual_review_candidate',
        review_summary: 'Actions: hands reposition on the device. Change: grip shifts between frames.',
        provenance: { modality: 'multimodal' },
        physiology: { heart_rate_bpm: { min: 96, max: 104, avg: 100, samples: 3 } },
      }, {
        start_ms: 20000,
        end_ms: 21000,
        label: 'audio_sigh',
        basis: 'Sigh candidate from the acoustic classifier.',
        provenance: { modality: 'audio' },
      }],
    },
  };
}

test('cloud evidence digest is readable, timestamped, and explicitly unconfirmed', () => {
  const record = { ai_analysis: { cloud_multimodal_passes: [cloudPass()] } };
  const digest = buildCloudMultimodalEvidenceDigest(record);
  assert.match(digest, /wide\.mkv/);
  assert.match(digest, /\[0:15; multimodal candidate; visual review\]/);
  assert.match(digest, /hands reposition on the device/);
  assert.match(digest, /HR 100 avg \(96-104\)/);
  assert.match(digest, /supporting candidates, not accepted facts/);
  assert.doesNotMatch(digest, /Cloud Multimodal Visual Window/);
});

test('cloud evidence digest humanizes structured model language before downstream synthesis', () => {
  const pass = cloudPass();
  pass.result.strong_candidates[0].visual_evidence = {
    actions: ["The subject is moving their hands.", "The subject is moving their hands."],
    body_position: ["Subject's knees are bent."],
    change_across_frames: ["No significant changes observed.", "The subject's grip shifts."],
  };
  pass.result.strong_candidates[0].audio_candidates = [{ label: "Sigh", confidence_band: "moderate" }];
  const digest = buildCloudMultimodalEvidenceDigest({ ai_analysis: { cloud_multimodal_passes: [pass] } });
  assert.match(digest, /Your grip shifts\./);
  assert.match(digest, /You are moving your hands\./);
  assert.match(digest, /Audio cues in this window: Sigh \(moderate\)\./);
  assert.doesNotMatch(digest, /\bsubject\b/i);
  assert.doesNotMatch(digest, /No significant changes observed/);
  assert.match(digest, /Do not quote this evidence block/);
});

test('normal session and body exploration analysis digests include saved cloud evidence', () => {
  const sessionDigest = buildSessionVideoPassDigest({ ai_analysis: { cloud_multimodal_passes: [cloudPass()] } });
  const explorationDigest = buildBodyExplorationVideoPassDigest({ ai_body_exploration: { cloud_multimodal_passes: [cloudPass()] } });
  assert.match(sessionDigest, /Saved cloud multimodal evidence/);
  assert.match(explorationDigest, /Saved cloud multimodal evidence/);
});
