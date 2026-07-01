import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildClinicalJsonRetryPrompt,
  isMalformedStructuredResponseError,
  isRefusalShapedStructuredResponse,
  shouldSkipPreviouslyExhaustedRefusalBatch,
} from './structuredResponseRetry.js';

test('recognizes malformed structured output and creates a clinical JSON-only retry', () => {
  const error = Object.assign(new Error('AI returned malformed JSON. Unexpected token I'), {
    code: 'AI_MALFORMED_JSON',
    rawPreview: "I'm not able to assist with that request.",
  });
  assert.equal(isMalformedStructuredResponseError(error), true);
  assert.equal(isRefusalShapedStructuredResponse(error), true);
  const prompt = buildClinicalJsonRetryPrompt('Review the supplied image.', error);
  assert.match(prompt, /neutral, non-erotic clinical documentation/i);
  assert.match(prompt, /Return ONLY valid JSON/i);
  assert.match(prompt, /limitation inside the appropriate schema field/i);
  assert.match(prompt, /saved image classification/i);
});

test('does not treat an ordinary provider outage as malformed structured output', () => {
  assert.equal(isMalformedStructuredResponseError(new Error('Provider overloaded')), false);
  assert.equal(isRefusalShapedStructuredResponse(new Error('Provider overloaded')), false);
});

test('recognizes a second refusal so the caller can stop retrying the batch', () => {
  const retryError = Object.assign(new Error('AI returned malformed JSON'), {
    code: 'AI_MALFORMED_JSON',
    rawPreview: "I'm not going to provide that response.",
  });
  assert.equal(isMalformedStructuredResponseError(retryError), true);
  assert.equal(isRefusalShapedStructuredResponse(retryError), true);
});

test('resumed job skips a batch that already exhausted its refusal retry', () => {
  assert.equal(shouldSkipPreviouslyExhaustedRefusalBatch({
    batch_current: 4,
    completed_batch_count: 3,
    batch_error_raw: `Unexpected token 'I', "I'm not go" is not valid JSON`,
  }, 4), true);
  assert.equal(shouldSkipPreviouslyExhaustedRefusalBatch({
    batch_current: 4,
    completed_batch_count: 3,
    batch_error_raw: 'Provider overloaded',
  }, 4), false);
});
