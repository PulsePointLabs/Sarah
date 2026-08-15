import assert from 'node:assert/strict';
import test from 'node:test';
import { reliableTranscriptText } from './sttProvider.js';

test('drops a low-confidence no-speech tail without losing spoken segments', () => {
  const text = reliableTranscriptText({
    text: "Both feet begin to tremble left to right. There's a lot of pressure.",
    segments: [
      { text: 'Both feet begin to tremble left to right.', no_speech_prob: 0.02, avg_logprob: -0.12, compression_ratio: 1.1 },
      { text: "There's a lot of pressure.", no_speech_prob: 0.78, avg_logprob: -1.2, compression_ratio: 1.0 },
    ],
  });
  assert.equal(text, 'Both feet begin to tremble left to right.');
});

test('keeps a confident final sentence even when it follows a pause', () => {
  const text = reliableTranscriptText({
    segments: [
      { text: 'Both feet begin to tremble left to right.', no_speech_prob: 0.02, avg_logprob: -0.12, compression_ratio: 1.1 },
      { text: 'There is pressure now.', no_speech_prob: 0.08, avg_logprob: -0.2, compression_ratio: 1.0 },
    ],
  });
  assert.equal(text, 'Both feet begin to tremble left to right. There is pressure now.');
});
