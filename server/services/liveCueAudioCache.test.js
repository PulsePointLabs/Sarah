import test from 'node:test';
import assert from 'node:assert/strict';
import { liveCueAudioCacheKey } from './liveCueAudioCache.js';

const cue = {
  text: 'Take one slow breath and let your shoulders soften.',
  voice: 'nova',
  model: 'tts-1-hd',
  speed: 0.96,
  format: 'mp3',
  profileVersion: 'test-profile',
};

test('live cue cache separates local and OpenAI voice renders', () => {
  const localKey = liveCueAudioCacheKey({ ...cue, ttsProvider: 'local' });
  const openAIKey = liveCueAudioCacheKey({ ...cue, ttsProvider: 'openai' });
  assert.notEqual(localKey, openAIKey);
});

test('live cue cache defaults to the local voice provider', () => {
  assert.equal(
    liveCueAudioCacheKey(cue),
    liveCueAudioCacheKey({ ...cue, ttsProvider: 'local' }),
  );
});
