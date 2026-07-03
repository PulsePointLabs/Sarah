import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { guardedOpenAIRequest, resetOpenAIGuardForTests } from './openaiGuard.js';

const originalEnv = { ...process.env };

function configure() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sarah-openai-guard-'));
  process.env.OPENAI_ENABLED = 'true';
  process.env.OPENAI_API_KEY = 'test-only-not-a-real-key';
  process.env.OPENAI_USAGE_FILE = path.join(dir, 'usage.jsonl');
  process.env.OPENAI_DAILY_BUDGET_USD = '100';
  process.env.OPENAI_MONTHLY_BUDGET_USD = '100';
  process.env.OPENAI_MAX_INPUT_CHARACTERS = '1000';
  resetOpenAIGuardForTests();
}

test.afterEach(() => {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) delete process.env[key];
  }
  Object.assign(process.env, originalEnv);
  resetOpenAIGuardForTests();
});

test('OpenAI is disabled unless explicitly enabled', async () => {
  configure();
  process.env.OPENAI_ENABLED = 'false';
  await assert.rejects(
    guardedOpenAIRequest({ feature: 'test', model: 'test', execute: async () => ({ ok: true }) }),
    /disabled by OPENAI_ENABLED/,
  );
});

test('concurrent duplicate submissions execute exactly once', async () => {
  configure();
  let calls = 0;
  const request = () => guardedOpenAIRequest({
    feature: 'tts_live', model: 'test', inputCharacters: 20,
    dedupeKey: 'same-payload', estimatedCostUsd: 0.001,
    execute: async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ok: true };
    },
  });
  const [first, second] = await Promise.all([request(), request()]);
  assert.equal(calls, 1);
  assert.deepEqual(first, second);
});

test('billing, quota, authentication, and 429 errors are not retried', async () => {
  configure();
  let calls = 0;
  await assert.rejects(guardedOpenAIRequest({
    feature: 'tts_live', model: 'test', dedupeKey: 'quota', maxAttempts: 3,
    execute: async () => {
      calls += 1;
      const error = new Error('insufficient_quota');
      error.status = 429;
      error.code = 'insufficient_quota';
      throw error;
    },
  }), /insufficient_quota/);
  assert.equal(calls, 1);
});

test('transient retries are capped', async () => {
  configure();
  let calls = 0;
  await assert.rejects(guardedOpenAIRequest({
    feature: 'tts_live', model: 'test', dedupeKey: 'transient', maxAttempts: 2,
    execute: async () => {
      calls += 1;
      const error = new Error('temporary');
      error.status = 503;
      error.retryable = true;
      throw error;
    },
  }), /temporary/);
  assert.equal(calls, 2);
});

test('hard input context limit rejects before execution', async () => {
  configure();
  let calls = 0;
  await assert.rejects(guardedOpenAIRequest({
    feature: 'test', model: 'test', inputCharacters: 1001,
    execute: async () => { calls += 1; return { ok: true }; },
  }), /input is too large/);
  assert.equal(calls, 0);
});

test('daily spending guard rejects before execution', async () => {
  configure();
  process.env.OPENAI_DAILY_BUDGET_USD = '0.01';
  let calls = 0;
  await assert.rejects(guardedOpenAIRequest({
    feature: 'image', model: 'test', estimatedCostUsd: 0.05,
    execute: async () => { calls += 1; return { ok: true }; },
  }), /daily spending guard reached/);
  assert.equal(calls, 0);
});
