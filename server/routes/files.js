import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { uploadDir } from '../config.js';
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

function normalizeLocalVideoPath(value) {
  const raw = String(value || '').trim().replace(/^file:\/+/, '');
  if (!raw) return '';
  return process.platform === 'win32' ? decodeURIComponent(raw).replace(/\//g, '\\') : decodeURIComponent(raw);
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
  return {
    path: resolved,
    filename: path.basename(resolved),
    extension: ext,
    mimeType: LOCAL_VIDEO_MIME[ext] || 'application/octet-stream',
    sizeBytes: stat.size,
    modifiedAt: stat.mtime.toISOString(),
    fingerprint: `${stat.size}-${Math.round(stat.mtimeMs)}`,
    exists: true,
    checkedAt: new Date().toISOString(),
    stream_url: `/api/files/local-video/stream?path=${encodeURIComponent(resolved)}`,
  };
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
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  Write-Output $dialog.FileName
}
`;

  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-STA', '-Command', script], {
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

filesRouter.post('/video-clip-preview', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No video uploaded' });

  const sourcePath = req.file.path;
  const start = Math.max(0, Number(req.body?.startSeconds || 0));
  const requestedEnd = Number(req.body?.endSeconds || start + 8);
  const end = Math.max(start + 0.25, requestedEnd);
  const duration = Math.min(30, Math.max(0.25, end - start));
  const label = slugifyFilePart(req.body?.label || req.file.originalname || 'video-clip');
  const stem = `${Date.now()}-${crypto.randomUUID()}-${label}`;
  const clipFilename = `${stem}.mp4`;
  const clipPath = path.join(uploadDir, clipFilename);
  const frameCount = Math.max(1, Math.min(18, Number(req.body?.frameCount || 12)));
  const framePattern = path.join(uploadDir, `${stem}-frame-%02d.jpg`);

  try {
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
      '-ss', String(start),
      '-t', String(duration),
      '-i', sourcePath,
      '-vf', `fps=${frameCount / duration},scale=min(960\\,iw):-2`,
      '-frames:v', String(frameCount),
      '-q:v', '3',
      framePattern,
    ]);

    const files = await fsp.readdir(uploadDir);
    const frameFiles = files
      .filter((file) => file.startsWith(`${stem}-frame-`) && file.endsWith('.jpg'))
      .sort()
      .slice(0, frameCount);
    const frames = await Promise.all(frameFiles.map(async (filename, index) => {
      const framePath = path.join(uploadDir, filename);
      const bytes = await fsp.readFile(framePath);
      const time = start + (duration * (frameFiles.length <= 1 ? 0 : index / (frameFiles.length - 1)));
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
    res.json({
      ok: true,
      source_deleted: true,
      clip_url: `/uploads/${clipFilename}`,
      url: `/uploads/${clipFilename}`,
      filename: clipFilename,
      mimeType: 'video/mp4',
      size: stat.size,
      startSeconds: start,
      endSeconds: start + duration,
      durationSeconds: duration,
      motion_summary: motionSummary,
      frames,
    });
  } catch (error) {
    res.status(500).json({ error: error?.message || 'Could not generate video clip preview' });
  } finally {
    fsp.unlink(sourcePath).catch(() => {});
  }
});
