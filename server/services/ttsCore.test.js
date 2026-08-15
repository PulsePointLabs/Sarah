import assert from 'node:assert/strict';
import test from 'node:test';
import { normalizeTTSProvider, runProcess, stripSarahTTSParams } from './ttsCore.js';

test('runProcess terminates a stalled validation process at its deadline', async () => {
  const startedAt = Date.now();
  await assert.rejects(
    runProcess(process.execPath, ['-e', 'setTimeout(() => {}, 10000)'], { timeoutMs: 150 }),
    /timed out after 150ms/,
  );
  assert.ok(Date.now() - startedAt < 3000);
});

test('local voice selection is a first-class per-request choice', () => {
  assert.equal(normalizeTTSProvider('local'), 'local');
  assert.equal(normalizeTTSProvider('xtts'), 'local');
  assert.equal(normalizeTTSProvider('openai'), 'openai');
});

test('OpenAI instructions do not receive local machine parameters', () => {
  const instructions = 'Speak warmly.\n<<SARAH_TTS_PARAMS>>{"ttsProvider":"local","soothing":9}<<END_SARAH_TTS_PARAMS>>';
  assert.equal(stripSarahTTSParams(instructions), 'Speak warmly.');
});
