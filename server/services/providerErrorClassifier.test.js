import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyProviderError, shouldRetryProviderError } from '../../src/lib/providerErrorClassifier.js';

test('classifies Anthropic low-credit failures as non-retryable', () => {
  const error = {
    status: 400,
    message: '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}',
  };
  const classified = classifyProviderError(error, { provider: 'anthropic', requestStage: 'final_synthesis' });
  assert.equal(classified.category, 'insufficient_credits');
  assert.equal(classified.retryable, false);
  assert.equal(shouldRetryProviderError(error, { provider: 'anthropic' }), false);
  assert.match(classified.user_message, /credits are unavailable/i);
});

test('classifies billing and spending limits as insufficient credits', () => {
  for (const message of [
    'billing limit reached',
    'spending limit reached',
    'usage limit reached',
    'account has no available credits',
    'insufficient credits',
  ]) {
    const classified = classifyProviderError({ message }, { provider: 'anthropic' });
    assert.equal(classified.category, 'insufficient_credits', message);
    assert.equal(classified.retryable, false);
  }
});

test('classifies invalid keys as non-retryable provider configuration failures', () => {
  const classified = classifyProviderError({ status: 401, error: { message: 'invalid api key' } }, { provider: 'anthropic' });
  assert.equal(classified.category, 'invalid_api_key');
  assert.equal(classified.retryable, false);
  assert.equal(classified.next_action, 'fix_provider_configuration');
});

test('classifies overload and rate limit as bounded retryable failures', () => {
  assert.equal(classifyProviderError({ status: 529, message: 'Overloaded' }).retryable, true);
  assert.equal(classifyProviderError({ status: 429, message: 'rate_limit_error' }).retryable, true);
});

test('does not include secrets in normalized messages', () => {
  const classified = classifyProviderError({
    message: 'Your credit balance is too low. sk-ant-api03-secret-thing should not be stored as a key.',
  }, { provider: 'anthropic' });
  assert.equal(classified.category, 'insufficient_credits');
  assert.doesNotMatch(classified.user_message, /sk-ant/i);
});
