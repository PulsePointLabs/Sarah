import test from 'node:test';
import assert from 'node:assert/strict';
import {
  coalesceTTSExportChunks,
  isRetryableTTSChunkFailure,
  shouldPropagateTTSChunkTrimFailure,
  validateTTSExportChunkPayload,
} from './ttsRenderer.js';

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

test('silent chunk integrity failures are propagated and retried', () => {
  const error = new Error('TTS export chunk 46/56 failed audio integrity check after silence trim: decoded duration 2.0s is too short for the requested text (51.0s expected).');

  assert.equal(shouldPropagateTTSChunkTrimFailure(error), true);
  assert.equal(isRetryableTTSChunkFailure(error), true);
});

test('transient TTS fetch failures receive one bounded chunk retry', () => {
  assert.equal(isRetryableTTSChunkFailure(new TypeError('fetch failed')), true);
  assert.equal(isRetryableTTSChunkFailure(new Error('HTTP 401 authentication failed')), false);
});
