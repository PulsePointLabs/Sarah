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
  process.env.OPENAI_MAX_CONCURRENT_REQUESTS = '4';
  process.env.OPENAI_MAX_CONCURRENT_PER_FEATURE = '2';
  process.env.OPENAI_FEATURE_BURST_MAX_REQUESTS = '60';
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

test('feature circuit breaker stops a request storm without disabling other features', async () => {
  configure();
  process.env.OPENAI_BURST_MAX_STORM_TEST = '2';
  let calls = 0;
  for (const key of ['one', 'two']) {
    await guardedOpenAIRequest({
      feature: 'storm_test', model: 'test', dedupeKey: key,
      execute: async () => { calls += 1; return { ok: true, key }; },
    });
  }
  await assert.rejects(guardedOpenAIRequest({
    feature: 'storm_test', model: 'test', dedupeKey: 'three',
    execute: async () => { calls += 1; return { ok: true }; },
  }), /feature circuit is temporarily open/);
  const other = await guardedOpenAIRequest({
    feature: 'other_feature', model: 'test', dedupeKey: 'allowed',
    execute: async () => ({ ok: true }),
  });
  assert.equal(calls, 2);
  assert.equal(other.ok, true);
});

test('per-feature concurrency guard rejects accidental parallel fan-out beyond the cap', async () => {
  configure();
  process.env.OPENAI_MAX_CONCURRENT_PER_FEATURE = '1';
  let release;
  const first = guardedOpenAIRequest({
    feature: 'parallel_test', model: 'test', dedupeKey: 'first',
    execute: async () => new Promise((resolve) => { release = resolve; }),
  });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await assert.rejects(guardedOpenAIRequest({
    feature: 'parallel_test', model: 'test', dedupeKey: 'second',
    execute: async () => ({ ok: true }),
  }), /concurrency limit reached/);
  release({ ok: true });
  assert.equal((await first).ok, true);
});
