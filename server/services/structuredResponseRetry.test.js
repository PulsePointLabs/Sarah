import test from 'node:test';
import assert from 'node:assert/strict';
import { buildClinicalJsonRetryPrompt, isMalformedStructuredResponseError } from './structuredResponseRetry.js';

test('recognizes malformed structured output and creates a clinical JSON-only retry', () => {
  const error = Object.assign(new Error('AI returned malformed JSON. Unexpected token I'), {
    code: 'AI_MALFORMED_JSON',
    rawPreview: "I'm not able to assist with that request.",
  });
  assert.equal(isMalformedStructuredResponseError(error), true);
  const prompt = buildClinicalJsonRetryPrompt('Review the supplied image.', error);
  assert.match(prompt, /neutral, non-erotic clinical documentation/i);
  assert.match(prompt, /Return ONLY valid JSON/i);
  assert.match(prompt, /limitation inside the appropriate schema field/i);
});

test('does not treat an ordinary provider outage as malformed structured output', () => {
  assert.equal(isMalformedStructuredResponseError(new Error('Provider overloaded')), false);
});
