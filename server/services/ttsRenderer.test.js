import test from 'node:test';
import assert from 'node:assert/strict';
import { validateTTSExportChunkPayload } from './ttsRenderer.js';

test('background TTS export accepts a long technical breakdown', () => {
  const chunks = Array.from({ length: 139 }, (_, index) => ({
    text: `Technical breakdown chunk ${index + 1}.`,
  }));

  assert.deepEqual(validateTTSExportChunkPayload(chunks), {
    chunkCount: 139,
    totalCharacters: chunks.reduce((total, chunk) => total + chunk.text.length, 0),
  });
});

test('background TTS export still rejects unbounded chunk counts', () => {
  const chunks = Array.from({ length: 501 }, () => ({ text: 'Bounded export.' }));

  assert.throws(
    () => validateTTSExportChunkPayload(chunks),
    /Too many TTS chunks: 501 \(maximum 500\)/,
  );
});

test('background TTS export still rejects unbounded total text', () => {
  assert.throws(
    () => validateTTSExportChunkPayload([{ text: 'x'.repeat(500_001) }]),
    /TTS export text is too large/,
  );
});
