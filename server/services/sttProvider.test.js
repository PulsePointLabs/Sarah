import test from 'node:test';
import assert from 'node:assert/strict';

import { normalizeSttTranscript } from './sttProvider.js';

test('normalizes glands to glans when grammar and anatomy make the intended term clear', () => {
  assert.equal(
    normalizeSttTranscript('The glands is fully exposed.'),
    'The glans is fully exposed.',
  );
  assert.equal(
    normalizeSttTranscript('Lubricant applied to the glands and foreskin.'),
    'Lubricant applied to the glans and foreskin.',
  );
  assert.equal(
    normalizeSttTranscript('Glands visible after retracting the foreskin.'),
    'Glans visible after retracting the foreskin.',
  );
});

test('preserves legitimate plural gland references', () => {
  assert.equal(
    normalizeSttTranscript('The sweat glands are irritated.'),
    'The sweat glands are irritated.',
  );
  assert.equal(
    normalizeSttTranscript('The glands in my neck are swollen.'),
    'The glands in my neck are swollen.',
  );
  assert.equal(
    normalizeSttTranscript('The prostate glands were discussed.'),
    'The prostate glands were discussed.',
  );
});
