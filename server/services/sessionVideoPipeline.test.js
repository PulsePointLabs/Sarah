import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { tmpdir } from 'node:os';
import test from 'node:test';
import {
  createRecordingRecord,
  finalizeRecordingUpload,
  getRecordingUploadStatus,
  initializeRecordingUpload,
  renderMobileSessionVideo,
  saveUploadChunk,
} from './sessionVideoPipeline.js';
import { runProcess } from './ttsCore.js';

test('session recording upload accepts chunks and finalizes with verified hash', async () => {
  const source = Buffer.alloc(300 * 1024, 'mobile-session-video-payload-for-upload-test');
  const hash = crypto.createHash('sha256').update(source).digest('hex');
  const recording = createRecordingRecord({
    id: `test-recording-${crypto.randomUUID()}`,
    session_id: `test-session-${crypto.randomUUID()}`,
    source_filename: 'test-session.mp4',
    telemetry_package: {
      hr_timeline: [{ t: 0, hr: 88 }],
      blood_pressure_snapshots: [{ systolic_mm_hg: 132, diastolic_mm_hg: 86 }],
    },
  });

  const upload = initializeRecordingUpload({
    recording_id: recording.id,
    filename: 'test-session.mp4',
    total_bytes: source.length,
    chunk_size: 128 * 1024,
    sha256: hash,
  });

  await saveUploadChunk(upload.id, 1, source.subarray(128 * 1024, 256 * 1024));
  await saveUploadChunk(upload.id, 0, source.subarray(0, 128 * 1024));
  await saveUploadChunk(upload.id, 2, source.subarray(256 * 1024));

  const status = getRecordingUploadStatus(upload.id);
  assert.equal(status.status, 'chunks_received');
  assert.deepEqual(status.missing_chunks, []);

  const finalized = await finalizeRecordingUpload(upload.id);
  assert.equal(finalized.upload.status, 'complete');
  assert.equal(finalized.upload.actual_sha256, hash);
  assert.equal(finalized.recording.upload_status, 'complete');
  assert.equal(finalized.recording.source_content_hash, hash);
  assert.equal(finalized.recording.source_size_bytes, source.length);
});

test('session recording upload reports missing chunks before finalize', async () => {
  const source = Buffer.alloc(260 * 1024, 'incomplete-video-payload');
  const recording = createRecordingRecord({
    id: `test-recording-${crypto.randomUUID()}`,
    session_id: `test-session-${crypto.randomUUID()}`,
    source_filename: 'incomplete.mp4',
  });
  const upload = initializeRecordingUpload({
    recording_id: recording.id,
    filename: 'incomplete.mp4',
    total_bytes: source.length,
    chunk_size: 128 * 1024,
  });

  await saveUploadChunk(upload.id, 0, source.subarray(0, 128 * 1024));
  const status = getRecordingUploadStatus(upload.id);
  assert.deepEqual(status.missing_chunks, [1, 2]);

  await assert.rejects(
    finalizeRecordingUpload(upload.id),
    /missing 2 chunks/,
  );
});

test('mobile session video renderer produces a streamable mp4', async (t) => {
  const workDir = await fsp.mkdtemp(path.join(tmpdir(), 'sarah-session-video-'));
  t.after(() => fsp.rm(workDir, { recursive: true, force: true }));
  const inputPath = path.join(workDir, 'source.mp4');

  try {
    await runProcess('ffmpeg', [
      '-hide_banner',
      '-y',
      '-f', 'lavfi',
      '-i', 'color=c=black:s=320x180:d=1',
      '-f', 'lavfi',
      '-i', 'anullsrc=channel_layout=stereo:sample_rate=44100',
      '-shortest',
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-c:a', 'aac',
      inputPath,
    ], { timeoutMs: 20000 });
  } catch {
    t.skip('FFmpeg is not available in this environment.');
    return;
  }

  const source = await fsp.readFile(inputPath);
  const hash = crypto.createHash('sha256').update(source).digest('hex');
  const recording = createRecordingRecord({
    id: `test-render-recording-${crypto.randomUUID()}`,
    session_id: `test-session-${crypto.randomUUID()}`,
    source_filename: 'source.mp4',
    duration_seconds: 1,
    telemetry_package: {
      hr_timeline: [{ t: 0, hr: 91 }],
      blood_pressure_snapshots: [{ systolic_mm_hg: 128, diastolic_mm_hg: 82 }],
      spo2_timeline: [{ t: 0, spo2_percent: 96 }],
    },
  });
  const upload = initializeRecordingUpload({
    recording_id: recording.id,
    filename: 'source.mp4',
    total_bytes: source.length,
    chunk_size: 128 * 1024,
    sha256: hash,
  });
  await saveUploadChunk(upload.id, 0, source);
  await finalizeRecordingUpload(upload.id);

  const progress = [];
  const rendered = await renderMobileSessionVideo(
    { recording_id: recording.id, preset_id: 'clean_clinical' },
    { jobId: `test-render-${crypto.randomUUID()}`, updateProgress: (event) => progress.push(event) },
  );

  assert.equal(rendered.recording_id, recording.id);
  assert.ok(rendered.size_bytes > 0);
  assert.ok(fs.existsSync(rendered.output_path));
  assert.ok(progress.some((event) => event.phase === 'complete'));
});
