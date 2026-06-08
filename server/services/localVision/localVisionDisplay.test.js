import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSarahLocalAnnotationCards,
  compactFrameRefs,
  displayCandidate,
  displayNotConfirmed,
  humanizeLocalVisionLabel,
  localVisionSummaryCounts,
  localVisionVerdict,
} from '../../../src/lib/localVisionDisplay.js';

test('raw local vision candidate enums are humanized for primary UI', () => {
  assert.equal(humanizeLocalVisionLabel('hand_genital_motion_candidate'), 'Possible hand/genital motion candidate');
  assert.equal(humanizeLocalVisionLabel('hand genital motion candidate'), 'Possible hand/genital motion candidate');
  assert.equal(humanizeLocalVisionLabel('body_foot_movement_candidate'), 'Possible body/foot movement candidate');
});

test('candidate display does not use frame IDs as the primary card title', () => {
  const candidate = displayCandidate({
    type: 'hand_genital_motion_candidate',
    score: 0.72,
    reasons: ['ROI motion was elevated', 'Qwen remained uncertain'],
    frame_refs: ['f020', 'f021', 'f022', 'f023', 'f024'],
  });
  assert.equal(candidate.label, 'Possible hand/genital motion candidate');
  assert.equal(candidate.status, 'Strong candidate, not visually confirmed');
  assert.match(candidate.reason, /ROI motion|Gate threshold|Candidate/i);
  assert.equal(candidate.frameRefs, 'f020, f021, f022, f023, plus 1 more');
  assert.doesNotMatch(candidate.label, /^f\d+/i);
});

test('no confirmed findings produce a clear insufficient evidence verdict', () => {
  const verdict = localVisionVerdict({
    actionable_findings: [],
    strong_candidates: [],
    not_confirmed: [{ label: 'stroking/manual stimulation not confirmed' }],
  });
  assert.equal(verdict.key, 'insufficient_local_visual_evidence');
  assert.match(verdict.text, /did not find enough visible evidence|checked important items/i);
});

test('not visually confirmed wording does not imply the event did not happen', () => {
  const row = displayNotConfirmed({
    label: 'ejaculation/fluid release not confirmed',
    reason: 'No visible fluid release or new visible fluid passed confirmation gates.',
  });
  assert.equal(row.label, 'Ejaculation/fluid release');
  assert.equal(row.status, 'Not visually confirmed');
  assert.doesNotMatch(row.reason, /did not happen/i);
});

test('summary counts separate confirmed, candidate, and not-confirmed evidence', () => {
  assert.deepEqual(localVisionSummaryCounts({
    actionable_findings: [{ label: 'manual_genital_contact_motion' }],
    strong_candidates: [{ type: 'body_foot_movement_candidate' }],
    not_confirmed: [{ label: 'specific erection state not confirmed' }],
  }), {
    confirmed: 1,
    candidates: 1,
    notConfirmed: 1,
  });
});

test('frame references are compact supporting text, not a title', () => {
  assert.equal(compactFrameRefs(['f001', 'f002', 'f003', 'f004', 'f005'], 3), 'f001, f002, f003, plus 2 more');
});

test('Sarah local annotation cards include range, summary, evidence, limitation, and frame refs', () => {
  const cards = buildSarahLocalAnnotationCards({
    strong_candidates: [{
      candidate_id: 'cand_001',
      type: 'hand_genital_motion_candidate',
      start_ms: 75000,
      end_ms: 85000,
      score: 0.72,
      reasons: ['ROI-weighted motion increased in the genital/hand region', 'Qwen remained uncertain'],
      frame_refs: ['f020', 'f021'],
    }],
  });

  assert.equal(cards.length, 1);
  assert.equal(cards[0].timestamp_range, '1:15-1:25');
  assert.equal(cards[0].title, 'Possible hand/genital motion candidate');
  assert.match(cards[0].summary, /Strong local-CV candidate, not visually confirmed by Qwen/i);
  assert.match(cards[0].visible_evidence, /ROI-weighted motion/i);
  assert.match(cards[0].limitation, /ROI-weighted motion|gate/i);
  assert.equal(cards[0].evidence_type, 'visual_candidate');
  assert.equal(cards[0].frame_refs_text, 'f020, f021');
  assert.ok(cards[0].event_tags.includes('candidate_not_confirmed'));
  assert.match(cards[0].window_summary, /1:15-1:25/);
  assert.equal(cards[0].finding_rows.length, 1);
  assert.equal(cards[0].finding_rows[0].label, 'Possible hand/genital motion candidate');
  assert.equal(cards[0].finding_rows[0].confidence_label, 'moderate candidate strength');
  assert.equal(cards[0].draft_video_sync_events.length, 1);
  assert.equal(cards[0].draft_video_sync_events[0].timestamp, '1:15');
});

test('empty Sarah local annotation card list means no useful local annotation events', () => {
  assert.deepEqual(buildSarahLocalAnnotationCards({}), []);
});
