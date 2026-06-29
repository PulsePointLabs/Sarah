import fs from 'node:fs/promises';
import path from 'node:path';
import { uploadDir, ttsRenderDir } from '../config.js';
import {
  buildChunkInstructions,
  callOpenAITTS,
  clampSpeed,
  estimateTtsDurationSeconds,
  normalizeTTSExportFormat,
  normalizeTTSModel,
  probeAudioDurationSeconds,
  q,
  runProcess,
  slugifyFilePart,
  supportsTTSInstructions,
  ttsExportMime,
  validateAudioFile,
} from './ttsCore.js';
import { writeChapterSidecars } from './audioChapters.js';

const MAX_TTS_EXPORT_CHUNKS = 500;
const MAX_TTS_EXPORT_CHARACTERS = 500_000;

export function validateTTSExportChunkPayload(chunks = []) {
  if (!chunks.length) {
    const error = new Error('No TTS chunks provided');
    error.status = 400;
    throw error;
  }

  if (chunks.length > MAX_TTS_EXPORT_CHUNKS) {
    const error = new Error(`Too many TTS chunks: ${chunks.length} (maximum ${MAX_TTS_EXPORT_CHUNKS})`);
    error.status = 413;
    throw error;
  }

  const totalCharacters = chunks.reduce((total, chunk) => total + String(chunk?.text || '').length, 0);
  if (totalCharacters > MAX_TTS_EXPORT_CHARACTERS) {
    const error = new Error(`TTS export text is too large: ${totalCharacters} characters (maximum ${MAX_TTS_EXPORT_CHARACTERS})`);
    error.status = 413;
    throw error;
  }

  return { chunkCount: chunks.length, totalCharacters };
}

async function trimTtsChunkSilence(inputPath, outputPath) {
  await runProcess('ffmpeg', [
    '-hide_banner',
    '-y',
    '-i', inputPath,
    '-map', '0:a:0',
    // Only trim leading boundary silence. End-trimming can cut off speech after
    // a natural long pause inside a chunk, creating missing narration sections.
    '-af', 'silenceremove=start_periods=1:start_duration=0.20:start_threshold=-50dB:start_silence=0.05',
    '-c:a', 'pcm_s16le',
    outputPath,
  ]);
}

function ttsExportConcurrency() {
  const configured = Number(process.env.TTS_EXPORT_CHUNK_CONCURRENCY || process.env.OPENAI_TTS_EXPORT_CONCURRENCY || 2);
  if (!Number.isFinite(configured)) return 2;
  return Math.max(1, Math.min(4, Math.round(configured)));
}

function parseSilenceSpans(stderr = '') {
  const spans = [];
  let currentStart = null;
  String(stderr || '').split(/\r?\n/).forEach((line) => {
    const startMatch = line.match(/silence_start:\s*([0-9.]+)/);
    if (startMatch) {
      currentStart = Number(startMatch[1]);
      return;
    }
    const endMatch = line.match(/silence_end:\s*([0-9.]+)\s*\|\s*silence_duration:\s*([0-9.]+)/);
    if (endMatch && Number.isFinite(currentStart)) {
      const end = Number(endMatch[1]);
      const duration = Number(endMatch[2]);
      if (Number.isFinite(end) && Number.isFinite(duration)) {
        spans.push({ start: currentStart, end, duration });
      }
      currentStart = null;
    }
  });
  return spans;
}

async function validateRenderedNarration(filePath, {
  expectedDurationSeconds = 0,
  label = 'TTS export',
} = {}) {
  const integrity = await validateAudioFile(filePath, {
    label,
    expectedDurationSeconds,
    minDurationSeconds: Math.max(0.5, Math.min(8, expectedDurationSeconds * 0.25 || 0.5)),
    minBytes: 2048,
  });
  const duration = integrity.durationSeconds;
  const suspiciousSilenceSeconds = Math.max(8, Math.min(30, duration * 0.22));
  let silenceSpans = [];
  try {
    const { stderr } = await runProcess('ffmpeg', [
      '-hide_banner',
      '-nostats',
      '-i', filePath,
      '-vn',
      '-af', `silencedetect=noise=-55dB:d=${suspiciousSilenceSeconds}`,
      '-f', 'null',
      '-',
    ]);
    silenceSpans = parseSilenceSpans(stderr);
  } catch (error) {
    silenceSpans = parseSilenceSpans(error?.message || '');
    if (!silenceSpans.length) throw error;
  }

  const interiorSilence = silenceSpans.find((span) => (
    span.duration >= suspiciousSilenceSeconds
    && span.start > Math.max(3, duration * 0.08)
    && span.end < duration - Math.max(3, duration * 0.08)
  ));
  if (interiorSilence) {
    throw new Error(`${label} failed audio integrity check: detected ${interiorSilence.duration.toFixed(1)}s of interior silence starting at ${interiorSilence.start.toFixed(1)}s.`);
  }

  return {
    ...integrity,
    silenceSpans,
  };
}

export async function renderTTSExport(payload = {}, options = {}) {
  let workDir = null;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const jobId = String(options.jobId || payload.jobId || crypto.randomUUID());

  if (!process.env.OPENAI_API_KEY) {
    const error = new Error('Missing OPENAI_API_KEY');
    error.status = 500;
    throw error;
  }

  try {
    const {
      chunks = [],
      title = 'Sarah TTS Export',
      voice = 'nova',
      model: requestedModel,
      speed = 1.0,
      instructions = '',
      outputFormat: requestedOutputFormat = 'mp3',
      normalize = false,
      chapters = [],
    } = payload || {};

    const model = normalizeTTSModel(requestedModel);
    const finalSpeed = clampSpeed(speed);
    const outputFormat = normalizeTTSExportFormat(requestedOutputFormat);
    const supportsInstructionsForModel = supportsTTSInstructions(model);
    const normalizedChunks = (Array.isArray(chunks) ? chunks : [])
      .map((chunk) => ({
        text: String(chunk?.text || '').trim(),
        previousContext: String(chunk?.previousContext || '').trim(),
      }))
      .filter((chunk) => chunk.text);

    validateTTSExportChunkPayload(normalizedChunks);

    onProgress({
      phase: 'starting',
      current: 0,
      total: normalizedChunks.length,
      message: `Preparing ${normalizedChunks.length} chunks...`,
      model,
      voice,
      format: outputFormat,
    });

    await fs.mkdir(uploadDir, { recursive: true });
    await fs.mkdir(ttsRenderDir, { recursive: true });
    workDir = path.join(ttsRenderDir, `${Date.now()}-${crypto.randomUUID()}`);
    await fs.mkdir(workDir, { recursive: true });

    const sourceFiles = new Array(normalizedChunks.length);
    const chunkSilenceTrim = [];
    let completedChunks = 0;
    let nextChunkIndex = 0;
    const renderChunk = async (i, integrityAttempt = 0) => {
      try {
      if (options.signal?.aborted) throw new Error('Cancelled');
      const chunk = normalizedChunks[i];
      onProgress({
        phase: 'generating',
        current: completedChunks,
        total: normalizedChunks.length,
        message: `Generating chunk ${i + 1} of ${normalizedChunks.length}...`,
      });
      const body = {
        model,
        input: chunk.text,
        voice,
        response_format: 'wav',
        speed: finalSpeed,
      };
      const chunkInstructions = buildChunkInstructions(instructions, chunk.previousContext, supportsInstructionsForModel);
      if (chunkInstructions) body.instructions = chunkInstructions;
      const meta = {
        chunkIndex: i,
        charCount: chunk.text.length,
        estimatedDurationSec: estimateTtsDurationSeconds(chunk.text),
        model,
        voice,
        speed: finalSpeed,
        format: 'wav',
        render: 'server',
        jobId,
      };
      const { buffer } = await callOpenAITTS(body, meta);
      const chunkPath = path.join(workDir, `chunk-${String(i).padStart(4, '0')}.wav`);
      await fs.writeFile(chunkPath, buffer);
      const expectedDurationSeconds = estimateTtsDurationSeconds(chunk.text);
      await validateAudioFile(chunkPath, {
        label: `TTS export chunk ${i + 1}/${normalizedChunks.length}`,
        expectedDurationSeconds,
        minBytes: 2048,
      });
      let sourcePath = chunkPath;
      let trimMeta = { chunk: i, trimmed: false };
      try {
        const originalDuration = await probeAudioDurationSeconds(chunkPath);
        const trimmedPath = path.join(workDir, `chunk-${String(i).padStart(4, '0')}-trimmed.wav`);
        await trimTtsChunkSilence(chunkPath, trimmedPath);
        const trimmedDuration = await probeAudioDurationSeconds(trimmedPath);
        if (trimmedDuration > 0.25 && originalDuration - trimmedDuration > 0.75) {
          if (trimmedDuration < Math.max(0.5, expectedDurationSeconds * 0.45)) {
            throw new Error(`TTS export chunk ${i + 1}/${normalizedChunks.length} failed audio integrity check after silence trim: decoded duration ${trimmedDuration.toFixed(1)}s is too short for the requested text (${expectedDurationSeconds.toFixed(1)}s expected).`);
          }
          sourcePath = trimmedPath;
          trimMeta = {
            chunk: i,
            trimmed: true,
            original_duration_seconds: Math.round(originalDuration * 10) / 10,
            trimmed_duration_seconds: Math.round(trimmedDuration * 10) / 10,
            removed_seconds: Math.round((originalDuration - trimmedDuration) * 10) / 10,
          };
        } else {
          trimMeta = {
            chunk: i,
            trimmed: false,
            original_duration_seconds: Math.round(originalDuration * 10) / 10,
            trimmed_duration_seconds: Math.round(trimmedDuration * 10) / 10,
          };
        }
      } catch (error) {
        trimMeta = { chunk: i, trimmed: false, warning: error?.message || 'chunk silence trim failed' };
        console.warn('[renderTTSExport] chunk silence trim skipped', trimMeta);
      }
      chunkSilenceTrim[i] = trimMeta;
      sourceFiles[i] = sourcePath;
      completedChunks += 1;
      onProgress({
        phase: 'generating',
        current: completedChunks,
        total: normalizedChunks.length,
        message: trimMeta.trimmed
          ? `Generated chunk ${i + 1} of ${normalizedChunks.length}; trimmed ${trimMeta.removed_seconds}s boundary silence`
          : `Generated chunk ${i + 1} of ${normalizedChunks.length}`,
      });
      } catch (error) {
        const retryableIntegrityFailure = /failed audio integrity check|too short for the requested text/i.test(String(error?.message || ''));
        if (retryableIntegrityFailure && integrityAttempt < 1 && !options.signal?.aborted) {
          onProgress({
            phase: 'generating',
            current: completedChunks,
            total: normalizedChunks.length,
            message: `Regenerating incomplete chunk ${i + 1} of ${normalizedChunks.length}...`,
          });
          return renderChunk(i, integrityAttempt + 1);
        }
        throw error;
      }
    };

    const workerCount = Math.min(ttsExportConcurrency(), normalizedChunks.length);
    await Promise.all(Array.from({ length: workerCount }, async () => {
      while (nextChunkIndex < normalizedChunks.length) {
        if (options.signal?.aborted) throw new Error('Cancelled');
        const i = nextChunkIndex;
        nextChunkIndex += 1;
        await renderChunk(i);
      }
    }));

    if (options.signal?.aborted) throw new Error('Cancelled');
    const missingChunk = sourceFiles.findIndex((file) => !file);
    if (missingChunk >= 0) {
      throw new Error(`TTS export stopped before chunk ${missingChunk + 1}/${normalizedChunks.length} was ready.`);
    }
    onProgress({
      phase: 'encoding',
      current: normalizedChunks.length,
      total: normalizedChunks.length,
      message: `Encoding final ${outputFormat.toUpperCase()} with ffmpeg...`,
    });

    const concatPath = path.join(workDir, 'concat.txt');
    await fs.writeFile(concatPath, sourceFiles.map((file) => `file ${q(file.replace(/\\/g, '/'))}`).join('\n'), 'utf8');

    const outputBase = `${slugifyFilePart(title)}-${Date.now()}`;
    const finalFilename = `${outputBase}.${outputFormat}`;
    const finalPath = path.join(uploadDir, finalFilename);
    const filterArgs = normalize
      ? ['-af', 'loudnorm=I=-18:TP=-1.5:LRA=11']
      : [];
    const encodeArgs = outputFormat === 'wav'
      ? (normalize ? ['-c:a', 'pcm_s16le'] : ['-c:a', 'copy'])
      : outputFormat === 'm4a'
        ? ['-c:a', 'aac', '-b:a', '320k', '-movflags', '+faststart']
        : ['-c:a', 'libmp3lame', '-b:a', '320k', '-compression_level', '0'];

    await runProcess('ffmpeg', [
      '-hide_banner',
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', concatPath,
      ...filterArgs,
      ...encodeArgs,
      finalPath,
    ]);

    const stat = await fs.stat(finalPath);
    const expectedDurationSeconds = normalizedChunks.reduce((sum, chunk) => sum + estimateTtsDurationSeconds(chunk.text), 0);
    const renderIntegrity = await validateRenderedNarration(finalPath, {
      expectedDurationSeconds,
      label: `TTS export ${finalFilename}`,
    });
    let durationSeconds = Math.round(renderIntegrity.durationSeconds);

    const trimmedChunks = chunkSilenceTrim.filter((item) => item.trimmed);
    const removedSilenceSeconds = Math.round(trimmedChunks.reduce((sum, item) => sum + Number(item.removed_seconds || 0), 0) * 10) / 10;

    let chapterMeta = null;
    try {
      chapterMeta = await writeChapterSidecars({
        uploadDir,
        outputBase,
        audioFilename: finalFilename,
        title,
        chapters,
        durationSeconds,
      });
    } catch (error) {
      console.warn('[renderTTSExport] chapter sidecars failed', error);
    }

    const result = {
      ok: true,
      jobId,
      file_url: `/uploads/${finalFilename}`,
      filename: finalFilename,
      size: stat.size,
      format: outputFormat,
      mime: ttsExportMime(outputFormat),
      render_version: 'tts_export_leading_trim_v2',
      duration_seconds: durationSeconds,
      model,
      voice,
      speed: finalSpeed,
      chunks: normalizedChunks.length,
      normalized: Boolean(normalize),
      silence_trim: {
        enabled: true,
        trimmed_chunks: trimmedChunks.length,
        removed_seconds: removedSilenceSeconds,
        chunks: chunkSilenceTrim,
      },
      ...(chapterMeta || {
        has_chapters: false,
        chapter_format: 'unavailable',
        chapter_count: 0,
        chapters_embedded: false,
        sidecar_chapters_available: false,
      }),
    };

    onProgress({
      phase: 'complete',
      current: normalizedChunks.length,
      total: normalizedChunks.length,
      message: `Complete: ${finalFilename}`,
      file_url: result.file_url,
      filename: result.filename,
      format: outputFormat,
      size: stat.size,
      duration_seconds: durationSeconds,
    });

    return result;
  } finally {
    if (workDir) {
      fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}
