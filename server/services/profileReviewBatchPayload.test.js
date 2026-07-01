import test from 'node:test';
import assert from 'node:assert/strict';

import { materializeProfileReviewBatchRequest } from './profileReviewBatchPayload.js';

test('expands one shared review context inside each compact batch request', () => {
  const expanded = materializeProfileReviewBatchRequest({
    model: 'claude_sonnet_4_6',
    promptPrefix: 'Batch 1 metadata',
    promptSuffix: 'Batch 1 image references',
  }, 'Shared clinical context');

  assert.equal(expanded.prompt, 'Batch 1 metadata\n\nShared clinical context\n\nBatch 1 image references');
  assert.equal(expanded.model, 'claude_sonnet_4_6');
  assert.equal('promptPrefix' in expanded, false);
  assert.equal('promptSuffix' in expanded, false);
});

test('keeps legacy full-prompt jobs unchanged for retry compatibility', () => {
  const request = { prompt: 'Existing complete prompt', promptPrefix: 'ignored' };
  assert.equal(materializeProfileReviewBatchRequest(request, 'shared'), request);
});
