import test from 'node:test';
import assert from 'node:assert/strict';
import { repairRawSecondTimeReferences } from '../../src/utils/aiTextRepair.js';

test('raw large second offsets are repaired in AI-facing/user-facing prose', () => {
  const repaired = repairRawSecondTimeReferences('candidate near 943s and at 943 seconds with [943s] evidence');
  assert.match(repaired, /15 minutes and 43 seconds|15 minute and 43 seconds/);
  assert.doesNotMatch(repaired, /\b943s\b/);
  assert.doesNotMatch(repaired, /\b943 seconds\b/);
  assert.doesNotMatch(repaired, /\[943s\]/);
});
