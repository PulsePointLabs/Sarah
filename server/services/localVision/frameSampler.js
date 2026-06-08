import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { dataDir } from '../../config.js';
import { runProcess } from '../ttsCore.js';

const VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.mkv', '.m4v', '.avi', '.wmv']);
export const localVisionDataDir = path.join(dataDir, 'local_vision');

function mmssFromMs(ms) {
  const totalSeconds = Math.max(0, Math.round(Number(ms || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, '0')}`;
}

export function normalizeLocalVideoPath(value) {
  const raw = String(value || '').trim().replace(/^file:\/+/, '');
  if (!raw) return '';
  return process.platform === 'win32' ? decodeURIComponent(raw).replace(/\//g, '\\') : decodeURIComponent(raw);
}

export async function assertReadableVideoPath(filePath) {
  const resolved = path.resolve(normalizeLocalVideoPath(filePath));
  const ext = path.extname(resolved).toLowerCase();
  if (!VIDEO_EXTENSIONS.has(ext)) {
    const error = new Error('Local vision can only analyze linked MP4, WebM, MOV, MKV, M4V, AVI, or WMV files.');
    error.status = 400;
    throw error;
  }
  const stat = await fsp.stat(resolved);
  if (!stat.isFile()) {
    const error = new Error('The selected local video path is not a file.');
    error.status = 400;
    throw error;
  }
  return resolved;
}

export function safeCachePart(value, fallback = 'item') {
  return String(value || fallback)
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || fallback;
}

function plannedFrameTimes(startMs, endMs, maxFrames, fps = null) {
  const start = Math.max(0, Number(startMs || 0));
  const end = Math.max(start + 250, Number(endMs || start + 30000));
  const fpsCount = fps ? Math.ceil(((end - start) / 1000) * Number(fps)) : 0;
  const count = Math.max(1, Math.min(Number(maxFrames || 8), fpsCount || Number(maxFrames || 8)));
  if (count === 1) return [Math.round((start + end) / 2)];
  const span = end - start;
  return Array.from({ length: count }, (_, index) => Math.round(start + ((index + 0.5) * span / count)));
}

async function hashFile(filePath) {
  const hash = crypto.createHash('sha1');
  hash.update(await fsp.readFile(filePath));
  return hash.digest('hex');
}

async function imageDimensions(filePath) {
  try {
    const { stdout } = await runProcess('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'csv=s=x:p=0',
      filePath,
    ]);
    const [width, height] = String(stdout || '').trim().split('x').map(Number);
    return {
      width: Number.isFinite(width) ? width : null,
      height: Number.isFinite(height) ? height : null,
    };
  } catch {
    return { width: null, height: null };
  }
}

export async function sampleLocalVisionFrames({ videoPath, sessionId, startMs, endMs, samplePolicy = {}, onProgress } = {}) {
  const sourcePath = await assertReadableVideoPath(videoPath);
  const maxFrames = Math.max(1, Math.min(
    Number(process.env.LOCAL_VISION_CONTINUOUS_MAX_SCAN_FRAMES || 600),
    Math.round(Number(samplePolicy.maxFrames || samplePolicy.maxScanFrames || 8)),
  ));
  const thumbnailWidth = Math.max(256, Math.min(960, Math.round(Number(samplePolicy.thumbnailWidth || 512))));
  const windowId = `${Math.round(Number(startMs || 0))}-${Math.round(Number(endMs || 0))}-${crypto.createHash('sha1').update(sourcePath).digest('hex').slice(0, 8)}`;
  const cacheDir = path.join(localVisionDataDir, safeCachePart(sessionId, 'session'), safeCachePart(windowId, 'window'));
  fs.mkdirSync(cacheDir, { recursive: true });

  const rawTimes = plannedFrameTimes(startMs, endMs, maxFrames, samplePolicy.fps || samplePolicy.baselineFps);
  onProgress?.({
    phase: 'sampling',
    planned_frames: rawTimes.length,
    sampled_frames: 0,
    message: `Sampling 0/${rawTimes.length} local video frames...`,
  });
  const frames = [];
  const seenHashes = new Set();
  const warnings = [];

  for (let index = 0; index < rawTimes.length; index += 1) {
    const frameId = `f${String(frames.length + 1).padStart(3, '0')}`;
    const timeMs = rawTimes[index];
    const outputName = `${frameId}-${timeMs}.jpg`;
    const outputPath = path.join(cacheDir, outputName);
    try {
      await runProcess('ffmpeg', [
        '-hide_banner',
        '-loglevel', 'error',
        '-y',
        '-ss', String(Math.max(0, timeMs / 1000)),
        '-i', sourcePath,
        '-frames:v', '1',
        '-vf', `scale='min(${thumbnailWidth},iw)':-2`,
        '-q:v', '3',
        outputPath,
      ]);
      const fileHash = await hashFile(outputPath);
      if (samplePolicy.dedupe !== false && seenHashes.has(fileHash)) {
        await fsp.unlink(outputPath).catch(() => {});
        continue;
      }
      seenHashes.add(fileHash);
      const dims = await imageDimensions(outputPath);
      frames.push({
        frame_id: frameId,
        time_ms: timeMs,
        file_path: outputPath,
        image_path: `/api/local-vision/frame/${encodeURIComponent(safeCachePart(sessionId, 'session'))}/${encodeURIComponent(safeCachePart(windowId, 'window'))}/${encodeURIComponent(outputName)}`,
        width: dims.width,
        height: dims.height,
        hash: fileHash,
      });
      if (index === 0 || (index + 1) % 5 === 0 || index === rawTimes.length - 1) {
        onProgress?.({
          phase: 'sampling',
          planned_frames: rawTimes.length,
          sampled_frames: frames.length,
          latest_frame: frames[frames.length - 1]
            ? {
              frame_id: frames[frames.length - 1].frame_id,
              time_ms: frames[frames.length - 1].time_ms,
              image_path: frames[frames.length - 1].image_path,
            }
            : null,
          current: frames.length,
          total: rawTimes.length,
          message: `Sampling local video frames ${frames.length}/${rawTimes.length}...`,
        });
      }
    } catch (error) {
      warnings.push(`Could not sample frame near ${mmssFromMs(timeMs)}: ${error?.message || error}`);
      onProgress?.({
        phase: 'sampling',
        planned_frames: rawTimes.length,
        sampled_frames: frames.length,
        current: Math.min(index + 1, rawTimes.length),
        total: rawTimes.length,
        message: `Sampling local video frames ${Math.min(index + 1, rawTimes.length)}/${rawTimes.length}; ${warnings.length} warning${warnings.length === 1 ? '' : 's'}...`,
      });
    }
  }

  if (!frames.length) {
    const error = new Error('No local vision frames could be sampled. Check that ffmpeg can read this linked video.');
    error.status = 500;
    error.warnings = warnings;
    throw error;
  }

  return {
    sourcePath,
    windowId,
    cacheDir,
    frames,
    warnings,
  };
}

export function resolveCachedFramePath(sessionPart, windowPart, filename) {
  const resolved = path.resolve(localVisionDataDir, safeCachePart(sessionPart), safeCachePart(windowPart), path.basename(String(filename || '')));
  const root = path.resolve(localVisionDataDir);
  if (!resolved.startsWith(root + path.sep)) {
    const error = new Error('Invalid local vision frame path.');
    error.status = 400;
    throw error;
  }
  return resolved;
}
