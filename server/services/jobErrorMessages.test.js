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

test('friendlyJobErrorMessage maps provider overload to a retryable user-facing status', () => {
  const raw = '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"},"request_id":"req_011CcDdXMNt1y1"}';
  assert.equal(
    friendlyJobErrorMessage(new Error(raw), { preserveContext: false }),
    'The AI provider is overloaded right now. Wait a minute, then try again.',
  );
});

test('friendlyJobStatusMessage hides provider overload JSON in background task tray', () => {
  const job = {
    status: 'error',
    error: '529 {"type":"error","error":{"type":"overloaded_error","message":"Overloaded"}}',
    progress: { phase: 'error' },
  };
  assert.match(friendlyJobStatusMessage(job), /AI provider is overloaded/);
  assert.doesNotMatch(friendlyJobStatusMessage(job), /\{"type":"error"/);
});
