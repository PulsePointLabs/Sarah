import express from 'express';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { cancelJob, createJob, getJob } from '../services/jobQueue.js';
import {
  BUILT_IN_RENDER_PRESETS,
  createRecordingRecord,
  finalizeRecordingUpload,
  getRecordingUploadStatus,
  initializeRecordingUpload,
  listRecordingsForSession,
  renderedVideoFile,
  saveUploadChunk,
} from '../services/sessionVideoPipeline.js';
import { runProcess } from '../services/ttsCore.js';

export const sessionVideoRouter = express.Router();

function publicRecording(recording = {}) {
  if (!recording) return null;
  const { source_path: _sourcePath, ...rest } = recording;
  return {
    ...rest,
    source_uploaded: Boolean(recording.source_path),
  };
}

function publicUpload(upload = {}) {
  if (!upload) return null;
  const { upload_dir: _uploadDir, output_path: _outputPath, ...rest } = upload;
  return rest;
}

function publicRenderedVideo(rendered = {}) {
  if (!rendered) return null;
  const { output_path: _outputPath, thumbnail_path: _thumbnailPath, ...rest } = rendered;
  return rest;
}

async function ffmpegAvailable() {
  try {
    await runProcess('ffmpeg', ['-version'], { timeoutMs: 5000 });
    await runProcess('ffprobe', ['-version'], { timeoutMs: 5000 });
    return true;
  } catch {
    return false;
  }
}

function sendVideoFile(req, res, filePath, { downloadName = null } = {}) {
  const stat = fs.statSync(filePath);
  const range = req.headers.range;
  const contentType = 'video/mp4';
  if (downloadName) {
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(downloadName).replace(/"/g, '')}"`);
  }
  if (!range) {
    res.setHeader('Content-Type', contentType);
    res.setHeader('Content-Length', stat.size);
    res.setHeader('Accept-Ranges', 'bytes');
    fs.createReadStream(filePath).pipe(res);
    return;
  }
  const [startRaw, endRaw] = String(range).replace(/bytes=/, '').split('-');
  const start = Math.max(0, Number.parseInt(startRaw, 10) || 0);
  const end = Math.min(stat.size - 1, endRaw ? Number.parseInt(endRaw, 10) : start + 1024 * 1024 * 4);
  if (start >= stat.size || end < start) {
    res.writeHead(416, { 'Content-Range': `bytes */${stat.size}` });
    res.end();
    return;
  }
  res.writeHead(206, {
    'Content-Range': `bytes ${start}-${end}/${stat.size}`,
    'Accept-Ranges': 'bytes',
    'Content-Length': end - start + 1,
    'Content-Type': contentType,
    ...(downloadName ? { 'Content-Disposition': `attachment; filename="${path.basename(downloadName).replace(/"/g, '')}"` } : {}),
  });
  fs.createReadStream(filePath, { start, end }).pipe(res);
}

function handleError(res, error) {
  res.status(error.status || 500).json({
    error: error.message || String(error),
    ...(error.missing_chunks ? { missing_chunks: error.missing_chunks } : {}),
    ...(error.expected_sha256 ? { expected_sha256: error.expected_sha256, actual_sha256: error.actual_sha256 } : {}),
  });
}

sessionVideoRouter.get('/capabilities', async (_req, res) => {
  res.json({
    ok: true,
    ffmpeg_available: await ffmpegAvailable(),
    upload: {
      resumable_chunks: true,
      max_chunk_bytes: 16 * 1024 * 1024,
      recommended_chunk_bytes: 4 * 1024 * 1024,
    },
    render_job_type: 'mobile_session_video_render',
    presets: BUILT_IN_RENDER_PRESETS,
  });
});

sessionVideoRouter.get('/presets', (_req, res) => {
  res.json(BUILT_IN_RENDER_PRESETS);
});

sessionVideoRouter.post('/recordings', (req, res) => {
  try {
    const recording = createRecordingRecord(req.body || {});
    res.status(201).json(publicRecording(recording));
  } catch (error) {
    handleError(res, error);
  }
});

sessionVideoRouter.get('/recordings', (req, res) => {
  try {
    const recordings = listRecordingsForSession(req.query.sessionId || req.query.session_id)
      .map(publicRecording);
    res.json(recordings);
  } catch (error) {
    handleError(res, error);
  }
});

sessionVideoRouter.get('/uploads/:uploadId', (req, res) => {
  const upload = getRecordingUploadStatus(req.params.uploadId);
  if (!upload) return res.status(404).json({ error: 'Upload not found.' });
  res.json(publicUpload(upload));
});

sessionVideoRouter.post('/uploads/init', (req, res) => {
  try {
    const upload = initializeRecordingUpload(req.body || {});
    res.status(201).json(publicUpload(upload));
  } catch (error) {
    handleError(res, error);
  }
});

sessionVideoRouter.put('/uploads/:uploadId/chunks/:chunkIndex', express.raw({ type: '*/*', limit: '32mb' }), async (req, res) => {
  try {
    const upload = await saveUploadChunk(req.params.uploadId, req.params.chunkIndex, req.body);
    res.json(publicUpload(getRecordingUploadStatus(upload.id)));
  } catch (error) {
    handleError(res, error);
  }
});

sessionVideoRouter.post('/uploads/:uploadId/finalize', async (req, res) => {
  try {
    const result = await finalizeRecordingUpload(req.params.uploadId);
    res.json({
      upload: publicUpload(result.upload),
      recording: publicRecording(result.recording),
    });
  } catch (error) {
    handleError(res, error);
  }
});

sessionVideoRouter.post('/render-jobs', (req, res) => {
  try {
    const payload = req.body || {};
    const recordingId = payload.recording_id || payload.recordingId;
    if (!recordingId) return res.status(400).json({ error: 'recording_id is required.' });
    const job = createJob('mobile_session_video_render', payload, {
      source: 'session-video',
      sessionId: payload.session_id || payload.sessionId || null,
      recordingId,
      priority: payload.priority ?? 15,
    });
    res.status(202).json(job);
  } catch (error) {
    handleError(res, error);
  }
});

sessionVideoRouter.get('/render-jobs/:jobId', (req, res) => {
  const job = getJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  res.json(job);
});

sessionVideoRouter.post('/render-jobs/:jobId/cancel', (req, res) => {
  const job = cancelJob(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found.' });
  res.json(job);
});

sessionVideoRouter.get('/rendered/:renderedId', (req, res) => {
  const rendered = renderedVideoFile(req.params.renderedId);
  if (!rendered) return res.status(404).json({ error: 'Rendered video not found.' });
  res.json(publicRenderedVideo(rendered));
});

sessionVideoRouter.get('/rendered/:renderedId/stream', async (req, res) => {
  try {
    const rendered = renderedVideoFile(req.params.renderedId);
    if (!rendered?.output_path) return res.status(404).json({ error: 'Rendered video not found.' });
    await fsp.access(rendered.output_path, fs.constants.R_OK);
    sendVideoFile(req, res, rendered.output_path);
  } catch (error) {
    if (!res.headersSent) handleError(res, error);
  }
});

sessionVideoRouter.get('/rendered/:renderedId/download', async (req, res) => {
  try {
    const rendered = renderedVideoFile(req.params.renderedId);
    if (!rendered?.output_path) return res.status(404).json({ error: 'Rendered video not found.' });
    await fsp.access(rendered.output_path, fs.constants.R_OK);
    sendVideoFile(req, res, rendered.output_path, { downloadName: rendered.filename || `${rendered.id}.mp4` });
  } catch (error) {
    if (!res.headersSent) handleError(res, error);
  }
});
