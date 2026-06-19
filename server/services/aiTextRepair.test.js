import test from 'node:test';
import assert from 'node:assert/strict';
import {
  repairAITextBlocks,
  repairCharacterSplitParagraph,
  reduceConsistencyPhraseRepetition,
  repairRawSecondTimeReferences,
  repairSpokenClockTimeReferences,
} from '../../src/utils/aiTextRepair.js';

test('raw large second offsets are repaired in AI-facing/user-facing prose', () => {
  const repaired = repairRawSecondTimeReferences('candidate near 943s and at 943 seconds with [943s] evidence');
  assert.match(repaired, /15 minutes and 43 seconds|15 minute and 43 seconds/);
  assert.doesNotMatch(repaired, /\b943s\b/);
  assert.doesNotMatch(repaired, /\b943 seconds\b/);
  assert.doesNotMatch(repaired, /\[943s\]/);
});

test('spoken clock-style timestamps are repaired to explicit minutes and seconds', () => {
  const repaired = repairSpokenClockTimeReferences(
    'The shift is visible at nine twenty two, then around one oh five, and from four thirty to five ten.'
  );

  assert.match(repaired, /at nine minutes and twenty-two seconds/i);
  assert.match(repaired, /around one minute and five seconds/i);
  assert.match(repaired, /from four minutes and thirty seconds/i);
  assert.match(repaired, /to five minutes and ten seconds/i);
  assert.doesNotMatch(repaired, /\bat nine twenty two\b/i);
  assert.doesNotMatch(repaired, /\baround one oh five\b/i);
});

test('repeated consistency wording is varied after the first allowed use', () => {
  const repaired = reduceConsistencyPhraseRepetition(
    [
      'This is consistent with prior evidence.',
      'That is consistent with your notes.',
      'The next finding is consistent with baseline.',
      'You consistently show the same pattern.',
      'The profile remains consistent across sessions.',
    ].join(' '),
    1
  );

  assert.match(repaired, /This is consistent with prior evidence/);
  assert.doesNotMatch(repaired, /That is consistent with your notes/i);
  assert.doesNotMatch(repaired, /next finding is consistent with baseline/i);
  assert.doesNotMatch(repaired, /You consistently show/i);
  assert.match(repaired, /\b(fits with|aligns with|matches|supports|tracks with|echoes)\b/i);
  assert.match(repaired, /\b(repeatedly|reliably|regularly|often|steadily|again and again|throughout)\b/i);
});

test('AI text block repair limits consistency wording across nested analysis fields', () => {
  const repaired = repairAITextBlocks({
    summary: 'This is consistent with the visible pattern.',
    findings: [
      'The motion is consistent with the session notes.',
      'The response consistently builds after stimulation resumes.',
    ],
    recommendations: {
      next: 'Use a consistent setup next time.',
    },
  });

  const allText = [
    repaired.summary,
    ...repaired.findings,
    repaired.recommendations.next,
  ].join(' ');

  const remainingUses = allText.match(/\bconsistent(?:ly)?\b/gi) || [];
  assert.equal(remainingUses.length, 1);
  assert.match(allText, /\b(fits with|aligns with|matches|supports|tracks with|echoes|points toward|helps explain)\b/i);
  assert.match(allText, /\b(repeatedly|reliably|regularly|often|steadily|again and again|throughout)\b/i);
});

test('paragraph repair ignores accidental Array.map index argument', () => {
  const repaired = [
    'This is consistent with one thing.',
    'This is consistent with another thing.',
  ].map(repairCharacterSplitParagraph);

  assert.equal(repaired.length, 2);
  assert.match(repaired.join(' '), /consistent with/i);
});
