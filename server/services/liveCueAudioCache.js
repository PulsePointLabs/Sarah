import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { liveCueAudioDir } from '../config.js';
import { synthesizeTTSChunk } from './ttsCore.js';

const CACHE_VERSION = 'live-cue-audio-v1';
const SAFE_FORMATS = new Set(['mp3', 'wav', 'aac', 'opus', 'flac']);

function sha(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function safeFormat(value) {
  const format = String(value || 'mp3').toLowerCase();
  return SAFE_FORMATS.has(format) ? format : 'mp3';
}

export function liveCueAudioCacheKey({ text, voice = 'nova', model = 'tts-1-hd', speed = 1, format = 'mp3', profileVersion = CACHE_VERSION } = {}) {
  return sha(JSON.stringify({
    profileVersion,
    text: String(text || '').trim(),
    voice,
    model,
    speed: Number(speed || 1),
    format: safeFormat(format),
  })).slice(0, 32);
}

export function liveCueAudioFilePath(settings = {}) {
  const format = safeFormat(settings.format);
  const key = liveCueAudioCacheKey(settings);
  return {
    key,
    format,
    relativeUrl: `/live-cues/audio/${key}.${format}`,
    filePath: path.join(liveCueAudioDir, `${key}.${format}`),
    metaPath: path.join(liveCueAudioDir, `${key}.json`),
  };
}

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function prepareLiveCueAudioClip(settings = {}) {
  const text = String(settings.text || '').trim();
  if (!text) {
    const error = new Error('Missing cue text');
    error.status = 400;
    throw error;
  }
  const resolved = liveCueAudioFilePath(settings);
  await fs.mkdir(liveCueAudioDir, { recursive: true });
  const cached = await exists(resolved.filePath);
  if (!cached) {
    const rendered = await synthesizeTTSChunk({
      text,
      voice: settings.voice || 'nova',
      model: settings.model || 'tts-1-hd',
      speed: settings.speed || 1,
      format: resolved.format,
      instructions: '',
      meta: {
        kind: 'live_cue',
        cacheKey: resolved.key,
      },
    });
    await fs.writeFile(resolved.filePath, rendered.buffer);
    await fs.writeFile(resolved.metaPath, JSON.stringify({
      cacheVersion: CACHE_VERSION,
      key: resolved.key,
      textHash: sha(text),
      voice: rendered.voice,
      model: rendered.model,
      speed: rendered.speed,
      format: rendered.format,
      renderedAt: new Date().toISOString(),
      latencyMs: rendered.latencyMs,
      retries: rendered.retries,
    }, null, 2));
  }
  return {
    key: resolved.key,
    text,
    url: resolved.relativeUrl,
    format: resolved.format,
    cached,
  };
}

export async function readLiveCueAudioFile(filename) {
  const safe = path.basename(String(filename || ''));
  if (!/^[a-f0-9]{32}\.(mp3|wav|aac|opus|flac)$/i.test(safe)) {
    const error = new Error('Invalid cue audio filename');
    error.status = 400;
    throw error;
  }
  const filePath = path.join(liveCueAudioDir, safe);
  return fs.readFile(filePath);
}

export const LIVE_CUE_AUDIO_CACHE_VERSION = CACHE_VERSION;
