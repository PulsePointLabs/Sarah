import test from 'node:test';
import assert from 'node:assert/strict';
import {
  reduceConsistencyPhraseRepetition,
  repairRawSecondTimeReferences,
} from '../../src/utils/aiTextRepair.js';

test('raw large second offsets are repaired in AI-facing/user-facing prose', () => {
  const repaired = repairRawSecondTimeReferences('candidate near 943s and at 943 seconds with [943s] evidence');
  assert.match(repaired, /15 minutes and 43 seconds|15 minute and 43 seconds/);
  assert.doesNotMatch(repaired, /\b943s\b/);
  assert.doesNotMatch(repaired, /\b943 seconds\b/);
  assert.doesNotMatch(repaired, /\[943s\]/);
});

test('repeated consistency wording is varied after the first allowed uses', () => {
  const repaired = reduceConsistencyPhraseRepetition(
    [
      'This is consistent with prior evidence.',
      'That is consistent with your notes.',
      'The next finding is consistent with baseline.',
      'You consistently show the same pattern.',
      'The profile remains consistent across sessions.',
    ].join(' '),
    2
  );

  assert.match(repaired, /This is consistent with prior evidence/);
  assert.match(repaired, /That is consistent with your notes/);
  assert.doesNotMatch(repaired, /next finding is consistent with baseline/i);
  assert.doesNotMatch(repaired, /You consistently show/i);
  assert.match(repaired, /\b(fits with|aligns with|matches|supports|tracks with|echoes)\b/i);
  assert.match(repaired, /\b(repeatedly|reliably|regularly|often)\b/i);
});
