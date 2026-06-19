import { spawn } from 'node:child_process';

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
    const child = spawn(command, args, { windowsHide: true, ...options });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (data) => { stdout += data.toString(); });
    child.stderr?.on('data', (data) => { stderr += data.toString(); });
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`${command} exited with ${code}: ${stderr || stdout}`));
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

export function buildChunkInstructions(baseInstructions, previousContext, supportsInstructionsForModel) {
  const base = String(baseInstructions || '').trim();
  if (!supportsInstructionsForModel) return '';
  const context = String(previousContext || '').trim();
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
  const maxAttempts = Number(process.env.OPENAI_TTS_BACKEND_ATTEMPTS || 3);
  let lastStatus = 502;
  let lastMessage = 'Unknown OpenAI TTS error';

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const startedAt = Date.now();
    try {
      const response = await fetchWithTimeout('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, Number(process.env.OPENAI_TTS_TIMEOUT_MS || 45000));
      const latencyMs = Date.now() - startedAt;

      if (response.ok) {
        const buffer = Buffer.from(await response.arrayBuffer());
        console.info('[openaiTTS] success', { ...meta, latencyMs, retries: attempt });
        return { response, buffer, latencyMs, retries: attempt };
      }

      lastStatus = response.status;
      lastMessage = await response.text();
      const retryable = [408, 429, 500, 502, 503, 504].includes(response.status);
      console.warn('[openaiTTS] upstream error', { ...meta, status: response.status, latencyMs, attempt: attempt + 1, retryable, message: lastMessage.slice(0, 300) });
      if (!retryable || attempt === maxAttempts - 1) break;

      const retryAfter = response.headers.get('retry-after');
      const delay = retryAfter
        ? Math.min(Math.max(Number(retryAfter) * 1000, 1000), 8000)
        : Math.min(900 * 2 ** attempt, 8000) + Math.floor(Math.random() * 400);
      await sleep(delay);
    } catch (error) {
      lastMessage = error.message || String(error);
      console.warn('[openaiTTS] exception', { ...meta, attempt: attempt + 1, message: lastMessage });
      if (attempt === maxAttempts - 1) break;
      await sleep(Math.min(900 * 2 ** attempt, 8000));
    }
  }

  const error = new Error(lastMessage);
  error.status = lastStatus;
  throw error;
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
    estimatedDurationSec: Math.max(1, Math.round(input.split(/\s+/).filter(Boolean).length / 2.25)),
    model,
    voice,
    speed: finalSpeed,
    format: responseFormat,
    ...meta,
  };
  const { buffer, latencyMs, retries } = await callOpenAITTS(body, requestMeta);
  return { buffer, model, voice, speed: finalSpeed, format: responseFormat, latencyMs, retries };
}
