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

test('normal session and body exploration analysis digests include saved cloud evidence', () => {
  const sessionDigest = buildSessionVideoPassDigest({ ai_analysis: { cloud_multimodal_passes: [cloudPass()] } });
  const explorationDigest = buildBodyExplorationVideoPassDigest({ ai_body_exploration: { cloud_multimodal_passes: [cloudPass()] } });
  assert.match(sessionDigest, /Saved cloud multimodal evidence/);
  assert.match(explorationDigest, /Saved cloud multimodal evidence/);
});
