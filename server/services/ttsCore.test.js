import assert from 'node:assert/strict';
import test from 'node:test';
import { runProcess } from './ttsCore.js';

test('runProcess terminates a stalled validation process at its deadline', async () => {
  const startedAt = Date.now();
  await assert.rejects(
    runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 150 }),
    /timed out after 150ms/,
  );
  assert.ok(Date.now() - startedAt < 3000);
});
