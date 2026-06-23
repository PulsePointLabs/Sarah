import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { dataDir } from '../config.js';
import { getEntity, listEntities, upsertEntity } from '../db.js';
import { runProcess } from './ttsCore.js';

export const sessionVideoDir = path.join(dataDir, 'session-video');
const recordingsDir = path.join(sessionVideoDir, 'recordings');
const uploadDir = path.join(sessionVideoDir, 'uploads');
const renderDir = path.join(sessionVideoDir, 'renders');
const thumbDir = path.join(sessionVideoDir, 'thumbnails');

for (const dir of [sessionVideoDir, recordingsDir, uploadDir, renderDir, thumbDir]) {
  fs.mkdirSync(dir, { recursive: true });
}

export const BUILT_IN_RENDER_PRESETS = [
  {
    id: 'clean_clinical',
    name: 'Clean Clinical',
    description: 'Clean source video with compact ClinicalClimax/Sarah branding and vitals context.',
    overlayMode: 'compact',
    branding: 'ClinicalClimax',
    includeHr: true,
    includeSpo2: true,
    includeBp: true,
    includeEmg: false,
    outputResolution: 'source',
    outputQuality: 'balanced',
  },
  {
    id: 'telemetry_cockpit',
    name: 'Telemetry Cockpit',
    description: 'Richer telemetry layout for review exports.',
    overlayMode: 'expanded',
    branding: 'Sarah',
    includeHr: true,
    includeSpo2: true,
    includeBp: true,
    includeEmg: true,
    outputResolution: 'source',
    outputQuality: 'balanced',
  },
  {
    id: 'minimal_branding',
    name: 'Minimal Branding',
    description: 'Small logo and heart-rate-first telemetry with low obstruction.',
    overlayMode: 'minimal',
    branding: 'Sarah',
    includeHr: true,
    includeSpo2: false,
    includeBp: false,
    includeEmg: false,
    outputResolution: 'source',
    outputQuality: 'balanced',
  },
];

function nowIso() {
  return new Date().toISOString();
}

function sanitizeFilename(value = 'recording.mp4') {
  const base = path.basename(String(value || 'recording.mp4')).replace(/[^a-zA-Z0-9._-]/g, '_');
  return base || 'recording.mp4';
}

function safeId(value, fallback = '') {
  const raw = String(value || fallback || '').trim();
  return raw.replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 96);
}

function recordingStoragePath(recordingId, filename) {
  const dir = path.join(recordingsDir, safeId(recordingId, crypto.randomUUID()));
  return { dir, filePath: path.join(dir, sanitizeFilename(filename)) };
}

function uploadStoragePath(uploadId) {
  return path.join(uploadDir, safeId(uploadId, crypto.randomUUID()));
}

async function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  await new Promise((resolve, reject) => {
    const stream = fs.createReadStream(filePath);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', reject);
    stream.on('end', resolve);
  });
  return hash.digest('hex');
}

async function statOrNull(filePath) {
  try {
    return await fsp.stat(filePath);
  } catch {
    return null;
  }
}

export function defaultTelemetryPackage(input = {}) {
  return {
    schema_version: 1,
    session_id: input.session_id || input.sessionId || null,
    recording_id: input.recording_id || input.recordingId || null,
    video_start_timestamp: input.video_start_timestamp || input.videoStartTimestamp || null,
    video_stop_timestamp: input.video_stop_timestamp || input.videoStopTimestamp || null,
    monotonic_start_ms: input.monotonic_start_ms ?? input.monotonicStartMs ?? null,
    duration_seconds: input.duration_seconds ?? input.durationSeconds ?? null,
    channels: input.channels || {},
    samples: Array.isArray(input.samples) ? input.samples : [],
    annotations: Array.isArray(input.annotations) ? input.annotations : [],
    blood_pressure_snapshots: Array.isArray(input.blood_pressure_snapshots) ? input.blood_pressure_snapshots : [],
    spo2_timeline: Array.isArray(input.spo2_timeline) ? input.spo2_timeline : [],
    hr_timeline: Array.isArray(input.hr_timeline) ? input.hr_timeline : [],
    hrv_timeline: Array.isArray(input.hrv_timeline) ? input.hrv_timeline : [],
    emg_timeline: Array.isArray(input.emg_timeline) ? input.emg_timeline : [],
    connection_gaps: Array.isArray(input.connection_gaps) ? input.connection_gaps : [],
  };
}

export function createRecordingRecord(input = {}) {
  const id = safeId(input.id || input.recording_id, crypto.randomUUID());
  const now = nowIso();
  const telemetryPackage = defaultTelemetryPackage({
    ...input.telemetry_package,
    session_id: input.session_id || input.sessionId,
    recording_id: id,
    video_start_timestamp: input.video_start_timestamp || input.videoStartTimestamp,
    video_stop_timestamp: input.video_stop_timestamp || input.videoStopTimestamp,
    duration_seconds: input.duration_seconds || input.durationSeconds,
  });
  return upsertEntity('SessionRecording', id, {
    id,
    session_id: input.session_id || input.sessionId || null,
    source_device_id: input.source_device_id || input.sourceDeviceId || null,
    source_filename: sanitizeFilename(input.source_filename || input.sourceFilename || 'sarah-session.mp4'),
    source_content_hash: input.source_content_hash || input.sourceContentHash || null,
    source_path: input.source_path || input.sourcePath || null,
    video_start_timestamp: telemetryPackage.video_start_timestamp,
    video_stop_timestamp: telemetryPackage.video_stop_timestamp,
    monotonic_start_ms: telemetryPackage.monotonic_start_ms,
    duration_seconds: Number(input.duration_seconds ?? input.durationSeconds ?? telemetryPackage.duration_seconds ?? 0) || null,
    video_orientation: input.video_orientation || input.videoOrientation || null,
    video_dimensions: input.video_dimensions || input.videoDimensions || null,
    frame_rate: input.frame_rate || input.frameRate || null,
    audio_included: Boolean(input.audio_included ?? input.audioIncluded ?? true),
    camera_facing: input.camera_facing || input.cameraFacing || null,
    telemetry_package: telemetryPackage,
    upload_status: input.upload_status || 'metadata_created',
    render_job_id: input.render_job_id || null,
    app_build: input.app_build || input.appBuild || null,
    android_build: input.android_build || input.androidBuild || null,
    created_date: input.created_date || now,
    updated_date: now,
  });
}

export function initializeRecordingUpload(input = {}) {
  const recording = getEntity('SessionRecording', input.recording_id || input.recordingId);
  if (!recording?.id) {
    const error = new Error('Recording metadata must be created before upload.');
    error.status = 404;
    throw error;
  }
  const id = safeId(input.id || input.upload_id, crypto.randomUUID());
  const chunkSize = Math.max(128 * 1024, Math.min(16 * 1024 * 1024, Number(input.chunk_size || input.chunkSize || 4 * 1024 * 1024)));
  const totalBytes = Number(input.total_bytes || input.totalBytes || input.size_bytes || input.sizeBytes || 0);
  if (!Number.isFinite(totalBytes) || totalBytes <= 0) {
    const error = new Error('Upload requires total_bytes.');
    error.status = 400;
    throw error;
  }
  const dir = uploadStoragePath(id);
  fs.mkdirSync(dir, { recursive: true });
  const totalChunks = Math.ceil(totalBytes / chunkSize);
  const now = nowIso();
  return upsertEntity('RecordingUpload', id, {
    id,
    recording_id: recording.id,
    session_id: recording.session_id,
    filename: sanitizeFilename(input.filename || recording.source_filename),
    expected_sha256: String(input.sha256 || input.expected_sha256 || '').toLowerCase() || null,
    total_bytes: totalBytes,
    chunk_size: chunkSize,
    total_chunks: totalChunks,
    received_chunks: [],
    received_bytes: 0,
    status: 'initialized',
    upload_dir: dir,
    created_date: now,
    updated_date: now,
  });
}

export async function saveUploadChunk(uploadId, chunkIndex, bytes) {
  const upload = getEntity('RecordingUpload', uploadId);
  if (!upload?.id) {
    const error = new Error('Upload not found.');
    error.status = 404;
    throw error;
  }
  const index = Number(chunkIndex);
  if (!Number.isInteger(index) || index < 0 || index >= Number(upload.total_chunks)) {
    const error = new Error('Invalid chunk index.');
    error.status = 400;
    throw error;
  }
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes || []);
  if (!buffer.length) {
    const error = new Error('Chunk body is empty.');
    error.status = 400;
    throw error;
  }
  await fsp.mkdir(upload.upload_dir, { recursive: true });
  const chunkPath = path.join(upload.upload_dir, `${String(index).padStart(8, '0')}.part`);
  await fsp.writeFile(chunkPath, buffer);

  const receivedSet = new Set(upload.received_chunks || []);
  receivedSet.add(index);
  let receivedBytes = 0;
  for (const receivedIndex of receivedSet) {
    const stat = await statOrNull(path.join(upload.upload_dir, `${String(receivedIndex).padStart(8, '0')}.part`));
    receivedBytes += stat?.size || 0;
  }
  return upsertEntity('RecordingUpload', upload.id, {
    ...upload,
    received_chunks: [...receivedSet].sort((a, b) => a - b),
    received_bytes: receivedBytes,
    status: receivedSet.size >= Number(upload.total_chunks) ? 'chunks_received' : 'uploading',
    updated_date: nowIso(),
  });
}

export async function finalizeRecordingUpload(uploadId) {
  const upload = getEntity('RecordingUpload', uploadId);
  if (!upload?.id) {
    const error = new Error('Upload not found.');
    error.status = 404;
    throw error;
  }
  const recording = getEntity('SessionRecording', upload.recording_id);
  if (!recording?.id) {
    const error = new Error('Recording not found for upload.');
    error.status = 404;
    throw error;
  }
  const missing = [];
  for (let i = 0; i < Number(upload.total_chunks); i += 1) {
    const chunkPath = path.join(upload.upload_dir, `${String(i).padStart(8, '0')}.part`);
    if (!fs.existsSync(chunkPath)) missing.push(i);
  }
  if (missing.length) {
    const error = new Error(`Upload is missing ${missing.length} chunk${missing.length === 1 ? '' : 's'}.`);
    error.status = 409;
    error.missing_chunks = missing.slice(0, 100);
    throw error;
  }

  const { dir, filePath } = recordingStoragePath(recording.id, upload.filename);
  await fsp.mkdir(dir, { recursive: true });
  const out = fs.createWriteStream(filePath);
  for (let i = 0; i < Number(upload.total_chunks); i += 1) {
    const chunkPath = path.join(upload.upload_dir, `${String(i).padStart(8, '0')}.part`);
    await new Promise((resolve, reject) => {
      const input = fs.createReadStream(chunkPath);
      input.on('error', reject);
      input.on('end', resolve);
      input.pipe(out, { end: false });
    });
  }
  await new Promise((resolve, reject) => {
    out.end(resolve);
    out.on('error', reject);
  });

  const stat = await fsp.stat(filePath);
  const actualHash = await sha256File(filePath);
  if (upload.expected_sha256 && actualHash.toLowerCase() !== upload.expected_sha256.toLowerCase()) {
    const error = new Error('Upload hash verification failed.');
    error.status = 409;
    error.expected_sha256 = upload.expected_sha256;
    error.actual_sha256 = actualHash;
    throw error;
  }

  const finalizedUpload = upsertEntity('RecordingUpload', upload.id, {
    ...upload,
    status: 'complete',
    finalized_at: nowIso(),
    output_path: filePath,
    actual_sha256: actualHash,
    received_bytes: stat.size,
    updated_date: nowIso(),
  });
  const finalizedRecording = upsertEntity('SessionRecording', recording.id, {
    ...recording,
    source_path: filePath,
    source_content_hash: actualHash,
    source_size_bytes: stat.size,
    upload_status: 'complete',
    updated_date: nowIso(),
  });
  return { upload: finalizedUpload, recording: finalizedRecording };
}

export function getRecordingUploadStatus(uploadId) {
  const upload = getEntity('RecordingUpload', uploadId);
  if (!upload?.id) return null;
  const received = new Set(upload.received_chunks || []);
  const missing_chunks = [];
  for (let i = 0; i < Number(upload.total_chunks || 0); i += 1) {
    if (!received.has(i)) missing_chunks.push(i);
  }
  return { ...upload, missing_chunks };
}

function drawTextEscape(value = '') {
  return String(value || '')
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]');
}

function drawTextFontOption() {
  const candidates = [
    process.env.SESSION_VIDEO_FONT_FILE,
    'C:/Windows/Fonts/arial.ttf',
    'C:/Windows/Fonts/segoeui.ttf',
  ].filter(Boolean);
  const fontFile = candidates.find((candidate) => fs.existsSync(candidate));
  if (!fontFile) return '';
  return `:fontfile='${String(fontFile).replace(/\\/g, '/').replace(/:/g, '\\:').replace(/'/g, "\\'")}'`;
}

function presetById(id = 'clean_clinical') {
  return BUILT_IN_RENDER_PRESETS.find((preset) => preset.id === id) || BUILT_IN_RENDER_PRESETS[0];
}

function latestVitalsText(recording = {}, settings = {}) {
  const telemetry = recording.telemetry_package || {};
  const bp = [...(telemetry.blood_pressure_snapshots || [])].pop();
  const spo2 = [...(telemetry.spo2_timeline || [])].pop();
  const hr = [...(telemetry.hr_timeline || [])].pop();
  const parts = [];
  if (settings.includeHr !== false && (hr?.hr || hr?.heart_rate_bpm || hr?.value)) parts.push(`HR ${Math.round(Number(hr.hr || hr.heart_rate_bpm || hr.value))}`);
  if (settings.includeSpo2 !== false && (spo2?.spo2_percent || spo2?.spo2 || spo2?.value)) parts.push(`SpO2 ${Math.round(Number(spo2.spo2_percent || spo2.spo2 || spo2.value))}%`);
  if (settings.includeBp !== false && bp?.systolic_mm_hg && bp?.diastolic_mm_hg) parts.push(`BP ${bp.systolic_mm_hg}/${bp.diastolic_mm_hg}`);
  return parts.join('   ');
}

async function mediaDurationSeconds(filePath) {
  const { stdout } = await runProcess('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ]);
  const value = Number.parseFloat(String(stdout || '').trim());
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function parseProgressLine(line = '') {
  const [key, value] = String(line).trim().split('=');
  if (!key) return null;
  return { key, value };
}

function timeStringToSeconds(value = '') {
  const match = String(value || '').match(/(\d+):(\d+):(\d+(?:\.\d+)?)/);
  if (!match) return 0;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

async function runFfmpegWithProgress(args, { durationSeconds, signal, onProgress }) {
  return new Promise((resolve, reject) => {
    const child = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    const progress = {};
    const abort = () => {
      child.kill('SIGTERM');
      reject(new Error('Cancelled'));
    };
    signal?.addEventListener?.('abort', abort, { once: true });
    child.stdout.on('data', (chunk) => {
      stdout += chunk.toString();
      chunk.toString().split(/\r?\n/).forEach((line) => {
        const parsed = parseProgressLine(line);
        if (!parsed) return;
        progress[parsed.key] = parsed.value;
        if (['out_time', 'out_time_ms', 'frame', 'speed'].includes(parsed.key)) {
          const outSeconds = progress.out_time ? timeStringToSeconds(progress.out_time) : Number(progress.out_time_ms || 0) / 1_000_000;
          const pct = durationSeconds > 0 ? Math.min(94, Math.max(0, Math.round((outSeconds / durationSeconds) * 88))) : 0;
          onProgress?.({
            phase: 'encoding',
            current: pct,
            total: 100,
            percent: pct,
            rendered_seconds: Number(outSeconds.toFixed(2)),
            total_seconds: durationSeconds,
            frame: Number(progress.frame || 0),
            speed: progress.speed || '',
            message: `Rendering video${durationSeconds ? ` (${Math.round(outSeconds)}s/${Math.round(durationSeconds)}s)` : ''}...`,
          });
        }
      });
    });
    child.stderr.on('data', (chunk) => {
      stderr += chunk.toString();
    });
    child.on('error', reject);
    child.on('close', (code) => {
      signal?.removeEventListener?.('abort', abort);
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`FFmpeg exited with code ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

export async function renderMobileSessionVideo(payload = {}, context = {}) {
  const recording = getEntity('SessionRecording', payload.recording_id || payload.recordingId);
  if (!recording?.id) throw new Error('Recording not found.');
  if (!recording.source_path || !fs.existsSync(recording.source_path)) throw new Error('Recording source file is not uploaded or no longer exists.');

  const preset = presetById(payload.preset_id || payload.presetId);
  const settings = { ...preset, ...(payload.settings || {}) };
  const jobId = context.jobId || crypto.randomUUID();
  const outputFilename = `ClinicalClimax_${recording.session_id || 'session'}_${recording.id}_${settings.id || preset.id}.mp4`.replace(/[^a-zA-Z0-9._-]/g, '_');
  const outputPath = path.join(renderDir, `${jobId}-${outputFilename}`);
  const thumbnailPath = path.join(thumbDir, `${jobId}.jpg`);

  context.updateProgress?.({
    phase: 'validating',
    current: 2,
    total: 100,
    percent: 2,
    message: 'Validating source recording and render settings...',
  });
  const durationSeconds = await mediaDurationSeconds(recording.source_path).catch(() => Number(recording.duration_seconds || 0));
  if (!durationSeconds) throw new Error('Could not determine source video duration.');

  const title = drawTextEscape(settings.title || 'ClinicalClimax');
  const subtitle = drawTextEscape(settings.subtitle || latestVitalsText(recording, settings) || 'Sarah telemetry render');
  const fontOption = drawTextFontOption();
  const overlay = [
    `drawbox=x=24:y=24:w=620:h=104:color=black@0.48:t=fill`,
    `drawtext=text='${title}':x=48:y=42:fontsize=30:fontcolor=white${fontOption}`,
    `drawtext=text='${subtitle}':x=48:y=82:fontsize=22:fontcolor=white${fontOption}`,
  ].join(',');
  const encoder = String(settings.encoder || process.env.SESSION_VIDEO_ENCODER || 'libx264');
  const args = [
    '-hide_banner',
    '-y',
    '-i', recording.source_path,
    '-vf', overlay,
    '-c:v', encoder,
    '-preset', settings.outputQuality === 'fast' ? 'veryfast' : 'medium',
    '-crf', settings.outputQuality === 'high' ? '18' : '22',
    '-c:a', 'aac',
    '-b:a', '160k',
    '-movflags', '+faststart',
    '-progress', 'pipe:1',
    '-nostats',
    outputPath,
  ];

  context.updateProgress?.({
    phase: 'rendering_main_video',
    current: 6,
    total: 100,
    percent: 6,
    encoder,
    output_path: outputPath,
    message: 'Starting FFmpeg render...',
  });
  await runFfmpegWithProgress(args, { durationSeconds, signal: context.signal, onProgress: context.updateProgress });

  context.updateProgress?.({
    phase: 'generating_thumbnail',
    current: 95,
    total: 100,
    percent: 95,
    message: 'Generating thumbnail...',
  });
  await runProcess('ffmpeg', ['-hide_banner', '-y', '-ss', '1', '-i', outputPath, '-frames:v', '1', '-q:v', '3', thumbnailPath]).catch(() => null);
  const stat = await fsp.stat(outputPath);
  const checksum = await sha256File(outputPath);
  const outputDuration = await mediaDurationSeconds(outputPath).catch(() => durationSeconds);
  if (Math.abs(outputDuration - durationSeconds) > Math.max(1.5, durationSeconds * 0.03)) {
    throw new Error(`Rendered output duration mismatch: source ${durationSeconds}s, output ${outputDuration}s.`);
  }

  const rendered = upsertEntity('RenderedVideo', `render-${jobId}`, {
    id: `render-${jobId}`,
    session_id: recording.session_id,
    recording_id: recording.id,
    render_job_id: jobId,
    preset_id: settings.id || preset.id,
    output_path: outputPath,
    thumbnail_path: fs.existsSync(thumbnailPath) ? thumbnailPath : null,
    duration_seconds: outputDuration,
    size_bytes: stat.size,
    sha256: checksum,
    filename: path.basename(outputPath),
    stream_url: `/api/session-video/rendered/render-${jobId}/stream`,
    download_url: `/api/session-video/rendered/render-${jobId}/download`,
    settings_snapshot: settings,
    created_date: nowIso(),
  });
  upsertEntity('SessionRecording', recording.id, {
    ...recording,
    render_job_id: jobId,
    latest_rendered_video_id: rendered.id,
    updated_date: nowIso(),
  });

  context.updateProgress?.({
    phase: 'complete',
    current: 100,
    total: 100,
    percent: 100,
    rendered_video_id: rendered.id,
    message: 'Rendered video complete.',
  });
  return rendered;
}

export function renderedVideoFile(renderedId) {
  const rendered = getEntity('RenderedVideo', renderedId);
  if (!rendered?.id || !rendered.output_path) return null;
  return rendered;
}

export function listRecordingsForSession(sessionId) {
  return listEntities('SessionRecording')
    .filter((recording) => !sessionId || recording.session_id === sessionId)
    .sort((a, b) => new Date(b.updated_date || b.created_date || 0) - new Date(a.updated_date || a.created_date || 0));
}
