import assert from 'node:assert/strict';
import test from 'node:test';
import { detectAudioContainer, normalizeSttAudio } from './sttAudio.js';

function createWavBuffer() {
  const sampleRate = 16_000;
  const sampleCount = 1_600;
  const pcmBytes = sampleCount * 2;
  const buffer = Buffer.alloc(44 + pcmBytes);
  buffer.write('RIFF', 0);
  buffer.writeUInt32LE(36 + pcmBytes, 4);
  buffer.write('WAVEfmt ', 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(sampleRate, 24);
  buffer.writeUInt32LE(sampleRate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write('data', 36);
  buffer.writeUInt32LE(pcmBytes, 40);
  return buffer;
}

test('detectAudioContainer identifies content instead of trusting MIME labels', () => {
  assert.deepEqual(detectAudioContainer(createWavBuffer()), {
    mimeType: 'audio/wav',
    extension: 'wav',
  });
  assert.deepEqual(detectAudioContainer(Buffer.from([0x1a, 0x45, 0xdf, 0xa3, 0, 0, 0, 0])), {
    mimeType: 'audio/webm',
    extension: 'webm',
  });
  assert.equal(detectAudioContainer(Buffer.from('not audio')), null);
});

test('normalizeSttAudio emits a verified mono WAV', async () => {
  const result = await normalizeSttAudio(createWavBuffer(), 'audio/webm');
  assert.equal(result.mimeType, 'audio/wav');
  assert.equal(result.extension, 'wav');
  assert.equal(result.sourceMimeType, 'audio/webm');
  assert.equal(result.sourceContainer, 'wav');
  assert.equal(detectAudioContainer(result.audioBuffer)?.extension, 'wav');
});

test('normalizeSttAudio rejects incomplete audio', async () => {
  await assert.rejects(
    () => normalizeSttAudio(Buffer.from('tiny'), 'audio/webm'),
    (error) => error.code === 'stt_audio_incomplete' && error.status === 400,
  );
});
