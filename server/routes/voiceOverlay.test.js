import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeVoiceOverlayTtsRuntime } from './voiceOverlay.js';

test('voice overlay preserves the saved HD Crisp runtime', () => {
  assert.deepEqual(
    normalizeVoiceOverlayTtsRuntime({
      voice: 'nova',
      model: 'tts-1-hd',
      speed: 0.96,
      format: 'mp3',
      instructions: 'ignored by HD',
    }),
    {
      voice: 'nova',
      model: 'tts-1-hd',
      speed: 0.96,
      format: 'mp3',
      instructions: '',
    },
  );
});

test('voice overlay sanitizes unsupported TTS settings', () => {
  assert.deepEqual(
    normalizeVoiceOverlayTtsRuntime({
      voice: 'invalid',
      model: 'invalid',
      speed: 99,
      format: 'invalid',
      instructions: 'Warm and natural.',
    }),
    {
      voice: 'nova',
      model: 'gpt-4o-mini-tts',
      speed: 4,
      format: 'mp3',
      instructions: 'Warm and natural.',
    },
  );
});
