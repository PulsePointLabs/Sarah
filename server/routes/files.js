import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { liveCaptureConfig, uploadDir } from '../config.js';
import { runProcess, runProcessBinary, slugifyFilePart } from '../services/ttsCore.js';

export const filesRouter = express.Router();
fs.mkdirSync(uploadDir, { recursive: true });
const execFileAsync = promisify(execFile);

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, uploadDir),
  filename: (_req, file, cb) => {
    const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
    cb(null, `${Date.now()}-${crypto.randomUUID()}-${safe}`);
  },
});
const upload = multer({ storage });
const LOCAL_VIDEO_EXTENSIONS = new Set(['.mp4', '.webm', '.mov', '.mkv', '.m4v', '.avi', '.wmv']);
const LOCAL_VIDEO_MIME = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.wmv': 'video/x-ms-wmv',
};
const LOCAL_VIDEO_SEARCH_SKIP_DIRS = new Set([
  '$recycle.bin',
  'appdata',
  'node_modules',
  'program files',
  'program files (x86)',
  'programdata',
  'recovery',
  'system volume information',
  'windows',
]);

const AUDIO_PASS_WHISPER_PROMPT = [
  'Sarah session audio note.',
  'Common phrases include: near climax event passed, Foley near the internal sphincter, stimulation paused, stimulation resumed, perineum pressure, internal sphincter, glans, foreskin, sleeve, vibrator, TENS, e-stim, catheter, ejaculation, recovery.',
  'Transcribe short spoken session notes accurately. Preserve anatomical terms.',
].join(' ');

function normalizeLocalVideoPath(value) {
  const raw = String(value || '').trim().replace(/^file:\/+/, '');
  if (!raw) return '';
  return process.platform === 'win32' ? decodeURIComponent(raw).replace(/\//g, '\\') : decodeURIComponent(raw);
}

function splitPathList(value) {
  return String(value || '')
    .split(/[;,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function likelyLocalVideoSearchRoots() {
  const roots = [];
  const add = (value) => {
    if (!value) return;
    const resolved = path.resolve(String(value));
    if (!roots.some((item) => item.toLowerCase() === resolved.toLowerCase())) roots.push(resolved);
  };

  splitPathList(process.env.SARAH_VIDEO_DIRS || process.env.PULSEPOINT_VIDEO_DIRS || process.env.OBS_RECORDINGS_DIR).forEach(add);

  const home = process.env.USERPROFILE || process.env.HOME || '';
  [
    home && path.join(home, 'Videos'),
    home && path.join(home, 'Videos', 'Captures'),
    home && path.join(home, 'Desktop'),
    home && path.join(home, 'Documents'),
    home && path.join(home, 'Downloads'),
    home && path.join(home, 'OneDrive', 'Videos'),
    home && path.join(home, 'OneDrive', 'Documents'),
    path.resolve(liveCaptureConfig.hrRecordingsDir, '..'),
    path.resolve(process.cwd(), '..'),
  ].forEach(add);

  if (process.platform === 'win32') {
    ['D:\\OBS', 'D:\\OBS\\Sessions', 'D:\\Videos', 'E:\\OBS', 'E:\\Videos'].forEach(add);
  }

  return roots;
}

async function existingDirectories(paths) {
  const results = [];
  for (const candidate of paths) {
    try {
      const stat = await fsp.stat(candidate);
      if (stat.isDirectory()) results.push(candidate);
    } catch {
      // Ignore missing common folders.
    }
  }
  return results;
}

async function findLocalVideoCandidates({ filename, sizeBytes, modifiedAtMs }) {
  const targetName = String(filename || '').trim();
  if (!targetName || targetName.includes('/') || targetName.includes('\\')) return [];
  const ext = path.extname(targetName).toLowerCase();
  if (!LOCAL_VIDEO_EXTENSIONS.has(ext)) return [];

  const roots = await existingDirectories(likelyLocalVideoSearchRoots());
  const matches = [];
  const startedAt = Date.now();
  const maxDirs = Number(process.env.PULSEPOINT_VIDEO_SEARCH_MAX_DIRS || 3500);
  const maxMs = Number(process.env.PULSEPOINT_VIDEO_SEARCH_TIMEOUT_MS || 8000);
  const size = Number(sizeBytes) || 0;
  const modified = Number(modifiedAtMs) || 0;
  let visited = 0;

  async function walk(dir, depth = 0) {
    if (matches.length >= 8 || visited >= maxDirs || Date.now() - startedAt > maxMs || depth > 5) return;
    visited += 1;
    let entries;
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      if (matches.length >= 8 || Date.now() - startedAt > maxMs) return;
      const entryName = entry.name || '';
      const fullPath = path.join(dir, entryName);
      if (entry.isFile() && entryName.toLowerCase() === targetName.toLowerCase()) {
        try {
          const stat = await fsp.stat(fullPath);
          const sizeMatches = !size || Math.abs(stat.size - size) <= 16;
          const modifiedMatches = !modified || Math.abs(stat.mtimeMs - modified) < 5000;
          if (sizeMatches && modifiedMatches) matches.push(fullPath);
        } catch {
          // Ignore files that disappear while scanning.
        }
      } else if (entry.isDirectory()) {
        const lower = entryName.toLowerCase();
        if (!LOCAL_VIDEO_SEARCH_SKIP_DIRS.has(lower) && !lower.startsWith('.')) {
          await walk(fullPath, depth + 1);
        }
      }
    }
  }

  for (const root of roots) {
    await walk(root, 0);
    if (matches.length >= 8 || Date.now() - startedAt > maxMs) break;
  }

  return [...new Set(matches)];
}

function assertLocalVideoPath(filePath) {
  const resolved = path.resolve(filePath);
  const ext = path.extname(resolved).toLowerCase();
  if (!LOCAL_VIDEO_EXTENSIONS.has(ext)) {
    const error = new Error('Linked local videos must be MP4, WebM, MOV, MKV, M4V, AVI, or WMV files.');
    error.status = 400;
    throw error;
  }
  return { resolved, ext };
}

async function localVideoMetadata(filePath) {
  const { resolved, ext } = assertLocalVideoPath(filePath);
  const stat = await fsp.stat(resolved);
  if (!stat.isFile()) {
    const error = new Error('The selected local video path is not a file.');
    error.status = 400;
    throw error;
  }
  const durationSeconds = await getMediaDurationSeconds(resolved).catch(() => 0);
  return {
    path: resolved,
    filename: path.basename(resolved),
    extension: ext,
    mimeType: LOCAL_VIDEO_MIME[ext] || 'application/octet-stream',
    sizeBytes: stat.size,
    durationSeconds,
    modifiedAt: stat.mtime.toISOString(),
    fingerprint: `${stat.size}-${Math.round(stat.mtimeMs)}`,
    exists: true,
    checkedAt: new Date().toISOString(),
    stream_url: `/api/files/local-video/stream?path=${encodeURIComponent(resolved)}`,
  };
}

async function getMediaDurationSeconds(filePath) {
  const { stdout } = await runProcess('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ]);
  const value = Number.parseFloat(String(stdout || '').trim());
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function parseSilenceDetect(stderr, start, end) {
  const silenceEvents = [];
  String(stderr || '').split(/\r?\n/).forEach((line) => {
    const startMatch = line.match(/silence_start:\s*([0-9.]+)/);
    if (startMatch) {
      silenceEvents.push({ type: 'start', time: Number(startMatch[1]) });
      return;
    }
    const endMatch = line.match(/silence_end:\s*([0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)/);
    if (endMatch) {
      silenceEvents.push({ type: 'end', time: Number(endMatch[1]), duration: Number(endMatch[2]) });
    }
  });

  const active = [];
  let cursor = start;
  let silenceStart = null;
  silenceEvents
    .filter((event) => Number.isFinite(event.time))
    .sort((a, b) => a.time - b.time)
    .forEach((event) => {
      const absolute = start + event.time;
      if (event.type === 'start') {
        if (absolute > cursor + 0.35) active.push({ start: cursor, end: Math.min(absolute, end) });
        silenceStart = absolute;
      } else if (event.type === 'end') {
        cursor = Math.min(Math.max(absolute, silenceStart || cursor), end);
        silenceStart = null;
      }
    });
  if (cursor < end - 0.35) active.push({ start: cursor, end });

  return active
    .map((segment) => ({
      start: Math.max(start, segment.start),
      end: Math.min(end, segment.end),
      duration: Math.max(0, Math.min(end, segment.end) - Math.max(start, segment.start)),
    }))
    .filter((segment) => segment.duration >= 0.75);
}

function mergeAudioSegments(segments, maxGapSeconds = 0.55, maxDurationSeconds = 12) {
  const merged = [];
  segments.forEach((segment) => {
    const last = merged[merged.length - 1];
    if (last && segment.start - last.end <= maxGapSeconds && segment.end - last.start <= maxDurationSeconds) {
      last.end = segment.end;
      last.duration = last.end - last.start;
      return;
    }
    merged.push({ ...segment });
  });
  return merged;
}

async function detectAudioActivity(sourcePath, start, duration) {
  try {
    const { stderr } = await runProcess('ffmpeg', [
      '-hide_banner',
      '-nostats',
      '-ss', String(start),
      '-t', String(duration),
      '-i', sourcePath,
      '-vn',
      '-af', 'silencedetect=noise=-38dB:d=0.45',
      '-f', 'null',
      '-',
    ]);
    return mergeAudioSegments(parseSilenceDetect(stderr, start, start + duration));
  } catch (error) {
    const fallback = mergeAudioSegments(parseSilenceDetect(error?.message || '', start, start + duration));
    if (fallback.length) return fallback;
    throw error;
  }
}

async function extractAudioSnippet(sourcePath, segment, filename) {
  const outputPath = path.join(uploadDir, filename);
  await runProcess('ffmpeg', [
    '-hide_banner',
    '-y',
    '-ss', String(Math.max(0, segment.start - 0.15)),
    '-t', String(Math.min(14, segment.duration + 0.3)),
    '-i', sourcePath,
    '-vn',
    '-ac', '1',
    '-ar', '16000',
    '-c:a', 'libmp3lame',
    '-b:a', '48k',
    outputPath,
  ]);
  return outputPath;
}

async function transcribeAudioSnippet(filePath) {
  if (!process.env.OPENAI_API_KEY) {
    const error = new Error('Missing OPENAI_API_KEY for speech transcription.');
    error.status = 500;
    throw error;
  }
  const bytes = await fsp.readFile(filePath);
  const form = new FormData();
  form.append('file', new Blob([bytes], { type: 'audio/mpeg' }), path.basename(filePath));
  form.append('model', 'whisper-1');
  form.append('language', 'en');
  form.append('prompt', AUDIO_PASS_WHISPER_PROMPT);
  const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
    method: 'POST',
    headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
    body: form,
  });
  if (!response.ok) {
    const error = new Error(await response.text());
    error.status = response.status;
    throw error;
  }
  const data = await response.json();
  return String(data?.text || '').trim();
}

function audioEventFromTranscript(segment, transcript) {
  const text = String(transcript || '').trim();
  if (text) return `Spoken note/audio: "${text}"`;
  if (segment.duration >= 3) return 'Sustained audible breathing, sigh, or vocalization candidate detected.';
  return 'Brief audio activity detected.';
}

async function handleLocalVideoError(res, error) {
  const status = error?.code === 'ENOENT' ? 404 : error?.status || 500;
  res.status(status).json({
    error: status === 404 ? 'Local video not found. The file may have moved, been renamed, or be on a disconnected drive.' : error?.message || 'Could not inspect local video.',
    exists: false,
    checkedAt: new Date().toISOString(),
  });
}

function summarizeMotion(samples, fps) {
  if (samples.length < 2) {
    return {
      method: 'local_frame_difference',
      frame_count: samples.length,
      motion_level: 'unknown',
      average_motion: null,
      peak_motion: null,
      active_motion_pct: null,
      pause_candidates: [],
      note: 'Not enough decoded frames to estimate motion.',
    };
  }
  const diffs = [];
  for (let i = 1; i < samples.length; i += 1) {
    const prev = samples[i - 1];
    const current = samples[i];
    let total = 0;
    const len = Math.min(prev.length, current.length);
    for (let j = 0; j < len; j += 1) total += Math.abs(current[j] - prev[j]);
    diffs.push(total / (len * 255));
  }
  const average = diffs.reduce((sum, value) => sum + value, 0) / diffs.length;
  const peak = Math.max(...diffs);
  const threshold = Math.max(0.018, average * 0.7);
  const active = diffs.filter((value) => value >= threshold).length;
  const pauseCandidates = [];
  let runStart = null;
  diffs.forEach((value, index) => {
    const isQuiet = value < threshold * 0.55;
    if (isQuiet && runStart == null) runStart = index;
    if ((!isQuiet || index === diffs.length - 1) && runStart != null) {
      const runEnd = isQuiet && index === diffs.length - 1 ? index : index - 1;
      const duration = (runEnd - runStart + 1) / fps;
      if (duration >= 0.8) {
        pauseCandidates.push({
          startSeconds: Number((runStart / fps).toFixed(2)),
          endSeconds: Number(((runEnd + 1) / fps).toFixed(2)),
          durationSeconds: Number(duration.toFixed(2)),
        });
      }
      runStart = null;
    }
  });
  const activePct = Math.round((active / diffs.length) * 100);
  const motionLevel = average < 0.018 ? 'low' : average < 0.05 ? 'moderate' : 'high';
  return {
    method: 'local_frame_difference',
    frame_count: samples.length,
    sample_rate_fps: fps,
    motion_level: motionLevel,
    average_motion: Number(average.toFixed(4)),
    peak_motion: Number(peak.toFixed(4)),
    active_motion_pct: activePct,
    pause_candidates: pauseCandidates.slice(0, 6),
    note: 'Motion is estimated locally from downscaled grayscale frame differences. It is useful for relative speed, pause, and intensity changes, not for confirming technique or intent by itself.',
  };
}

async function buildMotionSummary(sourcePath, start, duration) {
  const width = 160;
  const height = 90;
  const fps = Math.max(2, Math.min(6, Math.round(18 / Math.max(duration, 1))));
  const frameSize = width * height;
  const { stdout } = await runProcessBinary('ffmpeg', [
    '-hide_banner',
    '-loglevel', 'error',
    '-ss', String(start),
    '-t', String(duration),
    '-i', sourcePath,
    '-map', '0:v:0',
    '-an',
    '-vf', `fps=${fps},scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2,format=gray`,
    '-f', 'rawvideo',
    'pipe:1',
  ]);
  const samples = [];
  for (let offset = 0; offset + frameSize <= stdout.length; offset += frameSize) {
    samples.push(stdout.subarray(offset, offset + frameSize));
  }
  return summarizeMotion(samples, fps);
}

filesRouter.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const fileUrl = `/uploads/${req.file.filename}`;
  res.json({ file_url: fileUrl, url: fileUrl, filename: req.file.originalname, size: req.file.size });
});

filesRouter.post('/local-video/metadata', async (req, res) => {
  try {
    const requestedPath = normalizeLocalVideoPath(req.body?.path);
    if (!requestedPath) return res.status(400).json({ error: 'Paste the full local video path first.' });
    res.json(await localVideoMetadata(requestedPath));
  } catch (error) {
    await handleLocalVideoError(res, error);
  }
});

filesRouter.post('/local-video/resolve-drop', async (req, res) => {
  try {
    const filename = String(req.body?.filename || '').trim();
    if (!filename) return res.status(400).json({ error: 'The browser did not provide a video filename to resolve.' });
    const matches = await findLocalVideoCandidates({
      filename,
      sizeBytes: req.body?.sizeBytes,
      modifiedAtMs: req.body?.modifiedAtMs,
    });
    if (matches.length === 1) {
      return res.json(await localVideoMetadata(matches[0]));
    }
    if (matches.length > 1) {
      return res.status(409).json({
        error: `Found ${matches.length} possible local videos named ${filename}. Paste the full path or set SARAH_VIDEO_DIRS to the folder that contains the recording.`,
        candidates: matches,
      });
    }
    return res.status(404).json({
      error: `Chrome hid the full Windows path, and Sarah could not find ${filename} in the usual video folders. Use Browse, paste the full path, or set SARAH_VIDEO_DIRS to your recording folder.`,
      exists: false,
      checkedAt: new Date().toISOString(),
    });
  } catch (error) {
    await handleLocalVideoError(res, error);
  }
});

filesRouter.post('/video-playback-preview', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video uploaded' });

  const sourcePath = req.file.path;
  const label = slugifyFilePart(req.body?.label || req.file.originalname || 'video-preview');
  const filename = `${Date.now()}-${crypto.randomUUID()}-${label}.mp4`;
  const outputPath = path.join(uploadDir, filename);

  try {
    await runProcess('ffmpeg', [
      '-hide_banner',
      '-y',
      '-i', sourcePath,
      '-map', '0:v:0',
      '-map', '0:a?',
      '-vf', 'scale=min(1280\\,iw):-2',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '24',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      outputPath,
    ]);

    const stat = await fsp.stat(outputPath);
    res.json({
      ok: true,
      source_deleted: true,
      url: `/uploads/${filename}`,
      file_url: `/uploads/${filename}`,
      filename,
      mimeType: 'video/mp4',
      size: stat.size,
    });
  } catch (error) {
    res.status(500).json({ error: error?.message || 'Could not convert video for browser playback' });
  } finally {
    fsp.unlink(sourcePath).catch(() => {});
  }
});

filesRouter.post('/local-video/playback-preview', async (req, res) => {
  try {
    const requestedPath = normalizeLocalVideoPath(req.body?.path);
    if (!requestedPath) return res.status(400).json({ error: 'Missing local video path.' });
    const meta = await localVideoMetadata(requestedPath);
    const label = slugifyFilePart(req.body?.label || meta.filename || 'local-video-preview');
    const cacheKey = slugifyFilePart(`${meta.fingerprint}-${label}`);
    const filename = `local-playback-${cacheKey}.mp4`;
    const outputPath = path.join(uploadDir, filename);

    try {
      const existing = await fsp.stat(outputPath);
      if (existing.isFile() && existing.size > 0) {
        return res.json({
          ok: true,
          cached: true,
          url: `/uploads/${filename}`,
          file_url: `/uploads/${filename}`,
          filename,
          mimeType: 'video/mp4',
          size: existing.size,
          source_filename: meta.filename,
          source_fingerprint: meta.fingerprint,
        });
      }
    } catch {
      // Cache miss, convert below.
    }

    await runProcess('ffmpeg', [
      '-hide_banner',
      '-y',
      '-i', meta.path,
      '-map', '0:v:0',
      '-map', '0:a?',
      '-vf', 'scale=min(1280\\,iw):-2',
      '-c:v', 'libx264',
      '-preset', 'veryfast',
      '-crf', '24',
      '-c:a', 'aac',
      '-b:a', '128k',
      '-pix_fmt', 'yuv420p',
      '-movflags', '+faststart',
      outputPath,
    ]);

    const stat = await fsp.stat(outputPath);
    res.json({
      ok: true,
      cached: false,
      url: `/uploads/${filename}`,
      file_url: `/uploads/${filename}`,
      filename,
      mimeType: 'video/mp4',
      size: stat.size,
      source_filename: meta.filename,
      source_fingerprint: meta.fingerprint,
    });
  } catch (error) {
    res.status(error?.status || 500).json({ error: error?.message || 'Could not convert local video for browser playback' });
  }
});

filesRouter.post('/local-video/browse', async (_req, res) => {
  if (process.platform !== 'win32') {
    return res.status(400).json({ error: 'The local video picker is currently available on Windows only.' });
  }

  const script = `
Add-Type -AssemblyName System.Windows.Forms
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = 'Select local session video'
$dialog.Filter = 'Video files (*.mp4;*.webm;*.mov;*.mkv;*.m4v;*.avi;*.wmv)|*.mp4;*.webm;*.mov;*.mkv;*.m4v;*.avi;*.wmv|All files (*.*)|*.*'
$dialog.Multiselect = $false
$dialog.RestoreDirectory = $true
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$owner.WindowState = [System.Windows.Forms.FormWindowState]::Minimized
$owner.Show()
$owner.Activate()
if ($dialog.ShowDialog($owner) -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dialog.FileName
}
$owner.Dispose()
`;

  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-STA', '-Command', script], {
      timeout: 120000,
      windowsHide: false,
    });
    const selectedPath = normalizeLocalVideoPath(stdout);
    if (!selectedPath) return res.json({ cancelled: true });
    res.json(await localVideoMetadata(selectedPath));
  } catch (error) {
    const message = error?.killed
      ? 'The local video picker timed out before a file was selected.'
      : error?.message || 'Could not open the local video picker.';
    res.status(500).json({ error: message });
  }
});

filesRouter.get('/local-video/stream', async (req, res) => {
  try {
    const requestedPath = normalizeLocalVideoPath(req.query?.path);
    if (!requestedPath) return res.status(400).json({ error: 'Missing local video path.' });
    const meta = await localVideoMetadata(requestedPath);
    const range = req.headers.range;
    if (!range) {
      res.setHeader('Content-Type', meta.mimeType);
      res.setHeader('Content-Length', meta.sizeBytes);
      fs.createReadStream(meta.path).pipe(res);
      return;
    }
    const [startRaw, endRaw] = String(range).replace(/bytes=/, '').split('-');
    const start = Math.max(0, Number.parseInt(startRaw, 10) || 0);
    const end = Math.min(meta.sizeBytes - 1, endRaw ? Number.parseInt(endRaw, 10) : start + 1024 * 1024 * 4);
    if (start >= meta.sizeBytes || end < start) {
      res.writeHead(416, { 'Content-Range': `bytes */${meta.sizeBytes}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${meta.sizeBytes}`,
      'Accept-Ranges': 'bytes',
      'Content-Length': end - start + 1,
      'Content-Type': meta.mimeType,
    });
    fs.createReadStream(meta.path, { start, end }).pipe(res);
  } catch (error) {
    if (!res.headersSent) await handleLocalVideoError(res, error);
  }
});

async function generateVideoClipPreview({
  sourcePath,
  startSeconds = 0,
  endSeconds,
  label = 'video-clip',
  frameCount = 12,
  maxDurationSeconds = 30,
  sourceDeleted = false,
  sourceType = 'upload',
}) {
  const mediaDuration = await getMediaDurationSeconds(sourcePath).catch(() => 0);
  const maxStart = mediaDuration ? Math.max(0, mediaDuration - 0.25) : Number.POSITIVE_INFINITY;
  const start = Math.min(Math.max(0, Number(startSeconds || 0)), maxStart);
  const requestedEnd = Number(endSeconds || start + 8);
  const unclampedEnd = Math.max(start + 0.25, requestedEnd);
  const end = mediaDuration ? Math.min(mediaDuration, unclampedEnd) : unclampedEnd;
  const maxDuration = Math.max(1, Math.min(90, Number(maxDurationSeconds || 30)));
  const duration = Math.min(maxDuration, Math.max(0.25, end - start));
  const safeLabel = slugifyFilePart(label || 'video-clip');
  const stem = `${Date.now()}-${crypto.randomUUID()}-${safeLabel}`;
  const clipFilename = `${stem}.mp4`;
  const clipPath = path.join(uploadDir, clipFilename);
  const requestedFrameCount = Math.max(1, Math.min(18, Number(frameCount || 12)));
  const framePattern = path.join(uploadDir, `${stem}-frame-%02d.jpg`);

  await runProcess('ffmpeg', [
    '-hide_banner',
    '-y',
    '-ss', String(start),
    '-t', String(duration),
    '-i', sourcePath,
    '-map', '0:v:0',
    '-map', '0:a?',
    '-vf', 'scale=min(960\\,iw):-2',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    clipPath,
  ]);

  await runProcess('ffmpeg', [
    '-hide_banner',
    '-y',
    '-i', clipPath,
    '-an',
    '-vf', `fps=${requestedFrameCount / duration}:start_time=0,scale=960:-2:force_original_aspect_ratio=decrease`,
    '-frames:v', String(requestedFrameCount),
    '-q:v', '3',
    framePattern,
  ]);

  const files = await fsp.readdir(uploadDir);
  const frameFiles = files
    .filter((file) => file.startsWith(`${stem}-frame-`) && file.endsWith('.jpg'))
    .sort()
    .slice(0, requestedFrameCount);
  const frames = await Promise.all(frameFiles.map(async (filename, index) => {
    const framePath = path.join(uploadDir, filename);
    const bytes = await fsp.readFile(framePath);
    const time = start + (index * (duration / requestedFrameCount));
    return {
      filename,
      file_url: `/uploads/${filename}`,
      url: `/uploads/${filename}`,
      mimeType: 'image/jpeg',
      data: bytes.toString('base64'),
      frameTimeSeconds: Number(time.toFixed(2)),
      frameIndex: index + 1,
    };
  }));

  const motionSummary = await buildMotionSummary(sourcePath, start, duration).catch((error) => ({
    method: 'local_frame_difference',
    motion_level: 'unknown',
    error: error?.message || 'Could not estimate motion',
    note: 'Motion summary was unavailable for this clip; use the sampled frames only.',
  }));

  const stat = await fsp.stat(clipPath);
  return {
    ok: true,
    source_deleted: sourceDeleted,
    source_type: sourceType,
    clip_url: `/uploads/${clipFilename}`,
    url: `/uploads/${clipFilename}`,
    file_url: `/uploads/${clipFilename}`,
    filename: clipFilename,
    mimeType: 'video/mp4',
    size: stat.size,
    startSeconds: start,
    endSeconds: start + duration,
    durationSeconds: duration,
    motion_summary: motionSummary,
    frames,
  };
}

filesRouter.post('/local-video/clip-preview', async (req, res) => {
  try {
    const requestedPath = normalizeLocalVideoPath(req.body?.path);
    if (!requestedPath) return res.status(400).json({ error: 'Missing local video path.' });
    const meta = await localVideoMetadata(requestedPath);
    const result = await generateVideoClipPreview({
      sourcePath: meta.path,
      startSeconds: req.body?.startSeconds,
      endSeconds: req.body?.endSeconds,
      label: req.body?.label || meta.filename || 'local-video-clip',
      frameCount: req.body?.frameCount,
      maxDurationSeconds: req.body?.maxDurationSeconds,
      sourceDeleted: false,
      sourceType: 'linked_local_video',
    });
    res.json({ ...result, source_filename: meta.filename, source_fingerprint: meta.fingerprint });
  } catch (error) {
    const status = error?.status || (error?.code === 'ENOENT' ? 404 : 500);
    res.status(status).json({ error: error?.message || 'Could not generate local video clip preview' });
  }
});

filesRouter.post('/uploaded-video/clip-preview', async (req, res) => {
  try {
    const rawUrl = String(req.body?.file_url || req.body?.url || '').trim();
    if (!rawUrl) return res.status(400).json({ error: 'Missing uploaded video URL.' });
    if (!rawUrl.startsWith('/uploads/')) return res.status(400).json({ error: 'Only /uploads video URLs can be clipped.' });
    const filename = path.basename(decodeURIComponent(rawUrl.replace(/^\/uploads\//, '')));
    const sourcePath = path.join(uploadDir, filename);
    const ext = path.extname(filename).toLowerCase();
    if (!LOCAL_VIDEO_EXTENSIONS.has(ext)) return res.status(400).json({ error: 'Uploaded file is not a supported video type.' });
    await fsp.access(sourcePath, fs.constants.R_OK);
    const result = await generateVideoClipPreview({
      sourcePath,
      startSeconds: req.body?.startSeconds,
      endSeconds: req.body?.endSeconds,
      label: req.body?.label || filename || 'uploaded-video-clip',
      frameCount: req.body?.frameCount,
      maxDurationSeconds: req.body?.maxDurationSeconds,
      sourceDeleted: false,
      sourceType: 'uploaded_review_video',
    });
    res.json({ ...result, source_filename: filename, source_url: rawUrl });
  } catch (error) {
    const status = error?.code === 'ENOENT' ? 404 : 500;
    res.status(status).json({ error: error?.message || 'Could not generate uploaded video clip preview' });
  }
});

filesRouter.post('/local-video/audio-pass', async (req, res) => {
  const tempFiles = [];
  try {
    const requestedPath = normalizeLocalVideoPath(req.body?.path);
    if (!requestedPath) return res.status(400).json({ error: 'Missing local video path.' });
    const meta = await localVideoMetadata(requestedPath);
    const duration = await getMediaDurationSeconds(meta.path).catch(() => 0);
    const start = Math.max(0, Number(req.body?.startSeconds || 0));
    const requestedWindow = Math.max(15, Math.min(900, Number(req.body?.windowSeconds || 300)));
    const end = duration ? Math.min(duration, start + requestedWindow) : start + requestedWindow;
    const windowDuration = Math.max(0.25, end - start);
    const maxSnippets = Math.max(1, Math.min(20, Number(req.body?.maxSnippets || 10)));
    const transcribe = req.body?.transcribe !== false;
    const rawSegments = await detectAudioActivity(meta.path, start, windowDuration);
    const segments = rawSegments
      .filter((segment) => segment.duration >= 0.9)
      .sort((a, b) => b.duration - a.duration)
      .slice(0, maxSnippets)
      .sort((a, b) => a.start - b.start);

    const events = [];
    for (let i = 0; i < segments.length; i += 1) {
      const segment = segments[i];
      let transcript = '';
      let transcriptionError = '';
      if (transcribe) {
        const snippetFilename = `${Date.now()}-${crypto.randomUUID()}-audio-pass-${i + 1}.mp3`;
        const snippetPath = await extractAudioSnippet(meta.path, segment, snippetFilename);
        tempFiles.push(snippetPath);
        try {
          transcript = await transcribeAudioSnippet(snippetPath);
        } catch (error) {
          transcriptionError = error?.message || 'Could not transcribe this snippet.';
        }
      }
      events.push({
        startSeconds: Number(segment.start.toFixed(2)),
        endSeconds: Number(segment.end.toFixed(2)),
        durationSeconds: Number(segment.duration.toFixed(2)),
        transcript,
        transcriptionError,
        note: audioEventFromTranscript(segment, transcript),
        category: transcript ? ['audio_note', 'spoken_note'] : ['audio_activity'],
        annotation_tags: transcript ? ['spoken_note', 'audio_evidence'] : ['audio_evidence'],
        confidence: transcript ? 'high' : 'moderate',
      });
    }

    res.json({
      ok: true,
      source_filename: meta.filename,
      source_fingerprint: meta.fingerprint,
      startSeconds: start,
      endSeconds: end,
      durationSeconds: windowDuration,
      detectedSegments: rawSegments.length,
      transcribedSegments: events.filter((event) => event.transcript).length,
      events,
      summary: events.length
        ? `${events.length} audio activity segment${events.length === 1 ? '' : 's'} found; ${events.filter((event) => event.transcript).length} contained recognized speech.`
        : 'No clear audio activity segments were detected in this window.',
    });
  } catch (error) {
    const status = error?.status || (error?.code === 'ENOENT' ? 404 : 500);
    res.status(status).json({ error: error?.message || 'Could not analyze local video audio.' });
  } finally {
    await Promise.all(tempFiles.map((file) => fsp.unlink(file).catch(() => {})));
  }
});

filesRouter.post('/video-clip-preview', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video uploaded' });

  const sourcePath = req.file.path;
  try {
    const result = await generateVideoClipPreview({
      sourcePath,
      startSeconds: req.body?.startSeconds,
      endSeconds: req.body?.endSeconds,
      label: req.body?.label || req.file.originalname || 'video-clip',
      frameCount: req.body?.frameCount,
      sourceDeleted: true,
      sourceType: 'upload',
    });
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error?.message || 'Could not generate video clip preview' });
  } finally {
    fsp.unlink(sourcePath).catch(() => {});
  }
});
