import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractProviderErrorMessage,
  friendlyJobErrorMessage,
  friendlyJobStatusMessage,
} from '../../src/lib/jobErrorMessages.js';

test('extractProviderErrorMessage unwraps provider JSON after HTTP status text', () => {
  const raw = '400 {"type":"error","error":{"type":"invalid_request_error","message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."},"request_id":"req_123"}';
  assert.equal(
    extractProviderErrorMessage(raw),
    'Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits.',
  );
});

test('friendlyJobErrorMessage maps Anthropic credit exhaustion to a concise user-facing status', () => {
  const raw = '400 {"type":"error","error":{"message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}';
  assert.equal(
    friendlyJobErrorMessage(new Error(raw)),
    'Anthropic credits are exhausted. Any completed checkpoints were kept; add credits, then retry or recover the saved findings.',
  );
});

test('friendlyJobStatusMessage cleans failed job progress messages', () => {
  const job = {
    status: 'error',
    error: '400 {"type":"error","error":{"message":"Your credit balance is too low to access the Anthropic API. Please go to Plans & Billing to upgrade or purchase credits."}}',
    progress: { phase: 'error' },
  };
  assert.match(friendlyJobStatusMessage(job), /Anthropic credits are exhausted/);
  assert.doesNotMatch(friendlyJobStatusMessage(job), /\{"type":"error"/);
});
