import test from 'node:test';
import assert from 'node:assert/strict';
import { coalesceTTSExportChunks, validateTTSExportChunkPayload } from './ttsRenderer.js';

test('background TTS export merges small APK chunks into fewer requests', () => {
  const chunks = Array.from({ length: 170 }, (_, index) => ({
    text: `Segment ${index + 1}. ${'Narration text '.repeat(18)}`.trim(),
    previousContext: index ? `Segment ${index}.` : '',
  }));

  const merged = coalesceTTSExportChunks(chunks, 1000);

  assert.ok(merged.length < chunks.length / 2, `${merged.length} should be less than half of ${chunks.length}`);
  assert.equal(
    merged.map((chunk) => chunk.text).join(' '),
    chunks.map((chunk) => chunk.text).join(' '),
  );
  assert.equal(merged[0].previousContext, '');
});

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
  const chunks = Array.from({ length: 161 }, () => ({ text: 'Bounded export.' }));

  assert.throws(
    () => validateTTSExportChunkPayload(chunks),
    /Too many TTS chunks: 161 \(maximum 160\)/,
  );
});

test('background TTS export still rejects unbounded total text', () => {
  assert.throws(
    () => validateTTSExportChunkPayload([{ text: 'x'.repeat(150_001) }]),
    /TTS export text is too large/,
  );
});
