import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildBodyExplorationVideoPassDigest,
  buildSessionVideoPassDigest,
} from '../../src/lib/visualEvidence.js';

function savedCard() {
  return {
    id: 'visual-pattern-card',
    saved_at: '2026-08-30T12:00:00.000Z',
    label: 'AI video pass 10:00-10:24',
    source_video: { label: 'Main', filename: 'main.mkv' },
    clip: { start_s: 600, end_s: 624, duration_s: 24 },
    summary: 'Your abdomen braces and your pelvis lifts before both settle, while HR rises from 94 to 108 bpm.',
    findings: [{
      title: 'Coordinated trunk and pelvic response',
      text: 'Visible abdominal bracing accompanies a brief pelvic lift, followed by release toward baseline.',
      confidence: 'high',
      body_regions: ['abdomen', 'pelvis_hips', 'whole_body'],
      response_domains: ['posture_alignment', 'muscle_tension'],
      change_pattern: 'return_toward_baseline',
      visibility: 'clear',
    }],
    telemetry: {
      requested_session_window: { label: '10:00-10:24' },
      heart_rate: { exact_window: { samples: 24, bpm_start: 94, bpm_end: 108, bpm_max: 110 } },
    },
  };
}

test('session visual digest retains pattern metadata without embedding telemetry', () => {
  const digest = buildSessionVideoPassDigest({ ai_analysis: { _video_pass_findings: [savedCard()] } });

  assert.match(digest, /regions abdomen, pelvis_hips, whole_body/i);
  assert.match(digest, /domains posture_alignment, muscle_tension/i);
  assert.match(digest, /pattern return_toward_baseline/i);
  assert.doesNotMatch(digest, /Telemetry:|HR 94|peak 110|bpm/i);
});

test('body exploration visual digest keeps the same visual-only evidence contract', () => {
  const digest = buildBodyExplorationVideoPassDigest({ ai_body_exploration: { _video_pass_findings: [savedCard()] } });

  assert.match(digest, /Coordinated trunk and pelvic response/i);
  assert.doesNotMatch(digest, /Telemetry:|HR 94|peak 110|bpm/i);
});
