import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  estimateTextTokens,
  estimateTtsCostUsd,
  guardedOpenAIRequest,
  makeOpenAIHttpError,
} from './openaiGuard.js';

export const TTS_CONTENT_TYPES = {
  mp3: 'audio/mpeg',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  pcm: 'application/octet-stream',
};

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchWithTimeout(url, options = {}, timeoutMs = 25000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(t);
  }
}

export function clampSpeed(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0.25 && parsed <= 4 ? parsed : 1.0;
}

export function normalizeTTSFormat(value) {
  const format = String(value || process.env.OPENAI_TTS_FORMAT || 'mp3').toLowerCase();
  return TTS_CONTENT_TYPES[format] ? format : 'mp3';
}

export function normalizeTTSModel(value) {
  const requested = String(value || process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts');
  return ['gpt-4o-mini-tts', 'tts-1-hd', 'tts-1'].includes(requested)
    ? requested
    : 'gpt-4o-mini-tts';
}

export function supportsTTSInstructions(model) {
  return !String(model || '').startsWith('tts-1');
}

export function normalizeTTSExportFormat(value) {
  const format = String(value || 'mp3').toLowerCase();
  return ['mp3', 'm4a', 'wav'].includes(format) ? format : 'mp3';
}

export function ttsExportMime(format) {
  if (format === 'wav') return 'audio/wav';
  if (format === 'm4a') return 'audio/mp4';
  return 'audio/mpeg';
}

export function slugifyFilePart(value) {
  return String(value || 'pulsepoint-tts')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80) || 'pulsepoint-tts';
}

export function q(str) {
  return `'${String(str).replace(/'/g, "'\\''")}'`;
}

export function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const { timeoutMs = 0, ...spawnOptions } = options;
    const child = spawn(command, args, { windowsHide: true, ...spawnOptions });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timedOut = false;
    const timeout = Number(timeoutMs) > 0
      ? setTimeout(() => {
          timedOut = true;
          child.kill();
        }, Number(timeoutMs))
      : null;
    const finish = (callback) => {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      callback();
    };
    child.stdout?.on('data', (data) => { stdout += data.toString(); });
    child.stderr?.on('data', (data) => { stderr += data.toString(); });
    child.on('error', (error) => finish(() => reject(error)));
    child.on('close', (code) => {
      finish(() => {
        if (timedOut) reject(new Error(`${command} timed out after ${Number(timeoutMs)}ms.`));
        else if (code === 0) resolve({ stdout, stderr });
        else reject(new Error(`${command} exited with ${code}: ${stderr || stdout}`));
      });
    });
  });
}

export function runProcessBinary(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, ...options });
    const stdout = [];
    let stderr = '';
    child.stdout?.on('data', (data) => { stdout.push(Buffer.from(data)); });
    child.stderr?.on('data', (data) => { stderr += data.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout: Buffer.concat(stdout), stderr });
      else reject(new Error(`${command} exited with ${code}: ${stderr}`));
    });
  });
}

export async function probeAudioDurationSeconds(filePath, { timeoutMs = 10000, attempts = 2 } = {}) {
  let lastError;
  for (let attempt = 0; attempt < Math.max(1, Number(attempts) || 1); attempt += 1) {
    try {
      const probe = await runProcess('ffprobe', [
        '-v', 'error',
        '-show_entries', 'format=duration',
        '-of', 'default=noprint_wrappers=1:nokey=1',
        filePath,
      ], { timeoutMs });
      return Number(probe.stdout.trim()) || 0;
    } catch (error) {
      lastError = error;
      if (!/timed out/i.test(String(error?.message || '')) || attempt >= Math.max(1, Number(attempts) || 1) - 1) throw error;
    }
  }
  throw lastError;
}

export function estimateTtsDurationSeconds(text = '') {
  const words = String(text || '').split(/\s+/).filter(Boolean).length;
  return Math.max(1, Math.round(words / 2.25));
}

export async function validateAudioFile(filePath, {
  label = 'audio',
  expectedDurationSeconds = 0,
  minDurationSeconds = 0.25,
  minBytes = 512,
} = {}) {
  const stat = await fs.stat(filePath);
  if (!stat.isFile() || stat.size < minBytes) {
    throw new Error(`${label} failed audio integrity check: file is too small (${stat.size || 0} bytes).`);
  }
  const durationSeconds = await probeAudioDurationSeconds(filePath);
  if (!Number.isFinite(durationSeconds) || durationSeconds < minDurationSeconds) {
    throw new Error(`${label} failed audio integrity check: ffprobe could not decode usable audio.`);
  }
  if (expectedDurationSeconds > 0 && durationSeconds < Math.max(0.5, expectedDurationSeconds * 0.45)) {
    throw new Error(`${label} failed audio integrity check: decoded duration ${durationSeconds.toFixed(1)}s is too short for the requested text (${expectedDurationSeconds.toFixed(1)}s expected).`);
  }
  return {
    size: stat.size,
    durationSeconds,
  };
}

export async function validateAudioBuffer(buffer, {
  format = 'mp3',
  label = 'TTS response',
  expectedDurationSeconds = 0,
  minBytes = 512,
} = {}) {
  if (!Buffer.isBuffer(buffer) || buffer.length < minBytes) {
    throw new Error(`${label} failed audio integrity check: response was too small (${buffer?.length || 0} bytes).`);
  }
  const ext = normalizeTTSFormat(format);
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'sarah-tts-'));
  const tempPath = path.join(tempDir, `probe.${ext === 'pcm' ? 'bin' : ext}`);
  try {
    await fs.writeFile(tempPath, buffer);
    return await validateAudioFile(tempPath, {
      label,
      expectedDurationSeconds,
      minBytes,
    });
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

export function buildChunkInstructions(baseInstructions, previousContext, supportsInstructionsForModel) {
  const base = String(baseInstructions || '').trim().slice(0, Number(process.env.OPENAI_TTS_MAX_INSTRUCTION_CHARS || 4000));
  if (!supportsInstructionsForModel) return '';
  const maxContextChars = Number(process.env.OPENAI_TTS_MAX_PREVIOUS_CONTEXT_CHARS || 600);
  const rawContext = String(previousContext || '').trim();
  const context = rawContext.slice(Math.max(0, rawContext.length - maxContextChars));
  if (!context) return base;
  return `${base}

CONTEXT ONLY — DO NOT READ:
Previous narration:
"${context}"

Continue seamlessly from the previous narration.
This is the same continuous thought.
Do NOT restart energy, tone, pacing, or emphasis.
Read only the input text.`;
}

export async function callOpenAITTS(body, meta) {
  const inputCharacters = String(body?.input || '').length + String(body?.instructions || '').length;
  return guardedOpenAIRequest({
    feature: String(meta?.source || meta?.kind || meta?.render || 'tts_live'),
    model: body?.model,
    inputCharacters,
    estimatedInputTokens: estimateTextTokens(inputCharacters),
    estimatedCostUsd: estimateTtsCostUsd(String(body?.input || '').length),
    idempotencyKey: meta?.idempotencyKey || meta?.clientRequestId || '',
    dedupeKey: JSON.stringify({
      model: body?.model,
      input: body?.input,
      instructions: body?.instructions,
      voice: body?.voice,
      response_format: body?.response_format,
      speed: body?.speed,
    }),
    maxAttempts: Number(process.env.OPENAI_TTS_BACKEND_ATTEMPTS || process.env.OPENAI_MAX_ATTEMPTS || 2),
    execute: async ({ requestId, attempt }) => {
    const startedAt = Date.now();
    try {
      const response = await fetchWithTimeout('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
          'X-Client-Request-Id': requestId,
        },
        body: JSON.stringify(body),
      }, Number(process.env.OPENAI_TTS_TIMEOUT_MS || 45000));
      const latencyMs = Date.now() - startedAt;

      if (response.ok) {
        const buffer = Buffer.from(await response.arrayBuffer());
        const advertisedLength = Number(response.headers.get('content-length') || 0);
        if (advertisedLength > 0 && buffer.length !== advertisedLength) {
          throw new Error(`OpenAI TTS returned an incomplete response: received ${buffer.length} of ${advertisedLength} bytes.`);
        }
        const integrity = await validateAudioBuffer(buffer, {
          format: body?.response_format,
          label: `OpenAI TTS chunk ${meta?.chunkIndex != null ? Number(meta.chunkIndex) + 1 : ''}`.trim(),
          expectedDurationSeconds: meta?.estimatedDurationSec || 0,
        });
        console.info('[openaiTTS] success', { ...meta, requestId, latencyMs, retries: attempt - 1, bytes: buffer.length, durationSeconds: Math.round(integrity.durationSeconds * 10) / 10 });
        return {
          response,
          buffer,
          latencyMs,
          retries: attempt - 1,
          providerRequestId: response.headers.get('x-request-id') || null,
        };
      }
      const message = await response.text();
      const error = makeOpenAIHttpError(response, message);
      console.warn('[openaiTTS] upstream error', { ...meta, requestId, status: response.status, latencyMs, attempt, retryable: error.retryable, message: error.message.slice(0, 300) });
      throw error;
    } catch (error) {
      if (error?.name === 'AbortError') {
        const timeoutError = new Error('OpenAI TTS request timed out.');
        timeoutError.status = 408;
        timeoutError.retryable = true;
        throw timeoutError;
      }
      throw error;
    }
    },
  });
}

export async function synthesizeTTSChunk({
  text,
  voice = 'nova',
  model: requestedModel,
  speed = 1.0,
  instructions = '',
  format,
  previousContext = '',
  meta = {},
} = {}) {
  const input = String(text || '').trim();
  if (!input) {
    const error = new Error('Missing text');
    error.status = 400;
    throw error;
  }

  const maxChars = Number(process.env.OPENAI_TTS_MAX_CHARS || 2500);
  if (input.length > maxChars) {
    const error = new Error('Text chunk too large');
    error.status = 413;
    error.length = input.length;
    error.maxLength = maxChars;
    throw error;
  }

  const model = normalizeTTSModel(requestedModel);
  const finalSpeed = clampSpeed(speed);
  const responseFormat = normalizeTTSFormat(format);
  const supportsInstructionsForModel = supportsTTSInstructions(model);
  const body = {
    model,
    input,
    voice,
    response_format: responseFormat,
    speed: finalSpeed,
  };
  const chunkInstructions = buildChunkInstructions(
    String(instructions || process.env.OPENAI_TTS_INSTRUCTIONS || '').trim(),
    previousContext,
    supportsInstructionsForModel
  );
  if (chunkInstructions) body.instructions = chunkInstructions;

  const requestMeta = {
    chunkIndex: meta.chunkIndex,
    charCount: input.length,
    estimatedDurationSec: estimateTtsDurationSeconds(input),
    model,
    voice,
    speed: finalSpeed,
    format: responseFormat,
    ...meta,
  };
  const { buffer, latencyMs, retries } = await callOpenAITTS(body, requestMeta);
  return { buffer, model, voice, speed: finalSpeed, format: responseFormat, latencyMs, retries };
}
