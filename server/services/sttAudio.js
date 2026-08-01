import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { runProcess } from './ttsCore.js';

const MIN_AUDIO_BYTES = 256;

function beginsWith(buffer, signature) {
  if (!Buffer.isBuffer(buffer) || buffer.length < signature.length) return false;
  return signature.every((value, index) => buffer[index] === value);
}

export function detectAudioContainer(buffer) {
  if (!Buffer.isBuffer(buffer)) return null;
  if (beginsWith(buffer, [0x52, 0x49, 0x46, 0x46]) && buffer.subarray(8, 12).toString('ascii') === 'WAVE') {
    return { mimeType: 'audio/wav', extension: 'wav' };
  }
  if (buffer.subarray(0, 4).toString('ascii') === 'OggS') {
    return { mimeType: 'audio/ogg', extension: 'ogg' };
  }
  if (beginsWith(buffer, [0x1a, 0x45, 0xdf, 0xa3])) {
    return { mimeType: 'audio/webm', extension: 'webm' };
  }
  if (buffer.length >= 12 && buffer.subarray(4, 8).toString('ascii') === 'ftyp') {
    return { mimeType: 'audio/mp4', extension: 'm4a' };
  }
  if (buffer.subarray(0, 3).toString('ascii') === 'ID3' || (buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0)) {
    return { mimeType: 'audio/mpeg', extension: 'mp3' };
  }
  return null;
}

export async function normalizeSttAudio(audioBuffer, declaredMimeType = 'application/octet-stream') {
  if (!Buffer.isBuffer(audioBuffer) || audioBuffer.length < MIN_AUDIO_BYTES) {
    const error = new Error(`The recording was empty or incomplete (${audioBuffer?.length || 0} bytes).`);
    error.status = 400;
    error.code = 'stt_audio_incomplete';
    throw error;
  }

  const detected = detectAudioContainer(audioBuffer);
  const inputExtension = detected?.extension || 'bin';
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sarah-stt-'));
  const requestId = crypto.randomUUID();
  const inputPath = path.join(workDir, `${requestId}.source.${inputExtension}`);
  const outputPath = path.join(workDir, `${requestId}.normalized.wav`);

  try {
    await fs.writeFile(inputPath, audioBuffer);
    await runProcess('ffmpeg', [
      '-hide_banner',
      '-loglevel', 'error',
      '-y',
      '-i', inputPath,
      '-vn',
      '-ac', '1',
      '-ar', '16000',
      '-c:a', 'pcm_s16le',
      outputPath,
    ], { timeoutMs: 30_000 });
    const normalized = await fs.readFile(outputPath);
    if (!detectAudioContainer(normalized) || normalized.length < MIN_AUDIO_BYTES) {
      throw new Error('FFmpeg produced an invalid WAV file.');
    }
    return {
      audioBuffer: normalized,
      mimeType: 'audio/wav',
      extension: 'wav',
      sourceMimeType: String(declaredMimeType || ''),
      sourceContainer: detected?.extension || 'unknown',
    };
  } catch (cause) {
    const error = new Error(
      `Sarah could not decode this Android recording (${detected?.extension || declaredMimeType || 'unknown format'}). ${cause?.message || cause}`,
    );
    error.status = 422;
    error.code = 'stt_audio_decode_failed';
    error.cause = cause;
    throw error;
  } finally {
    await fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
