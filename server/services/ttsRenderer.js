import fs from 'node:fs/promises';
import path from 'node:path';
import { uploadDir, ttsRenderDir } from '../config.js';
import {
  buildChunkInstructions,
  callOpenAITTS,
  clampSpeed,
  normalizeTTSExportFormat,
  normalizeTTSModel,
  q,
  runProcess,
  slugifyFilePart,
  supportsTTSInstructions,
  ttsExportMime,
} from './ttsCore.js';
import { writeChapterSidecars } from './audioChapters.js';

async function probeAudioDurationSeconds(filePath) {
  const probe = await runProcess('ffprobe', [
    '-v', 'error',
    '-show_entries', 'format=duration',
    '-of', 'default=noprint_wrappers=1:nokey=1',
    filePath,
  ]);
  return Number(probe.stdout.trim()) || 0;
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

    if (!normalizedChunks.length) {
      const error = new Error('No TTS chunks provided');
      error.status = 400;
      throw error;
    }
    if (normalizedChunks.length > 120) {
      const error = new Error(`Too many TTS chunks: ${normalizedChunks.length}`);
      error.status = 413;
      throw error;
    }

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

    const sourceFiles = [];
    const chunkSilenceTrim = [];
    for (let i = 0; i < normalizedChunks.length; i++) {
      if (options.signal?.aborted) throw new Error('Cancelled');
      const chunk = normalizedChunks[i];
      onProgress({
        phase: 'generating',
        current: i,
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
        estimatedDurationSec: Math.max(1, Math.round(chunk.text.split(/\s+/).filter(Boolean).length / 2.25)),
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
      let sourcePath = chunkPath;
      let trimMeta = { chunk: i, trimmed: false };
      try {
        const originalDuration = await probeAudioDurationSeconds(chunkPath);
        const trimmedPath = path.join(workDir, `chunk-${String(i).padStart(4, '0')}-trimmed.wav`);
        await trimTtsChunkSilence(chunkPath, trimmedPath);
        const trimmedDuration = await probeAudioDurationSeconds(trimmedPath);
        if (trimmedDuration > 0.25 && originalDuration - trimmedDuration > 0.75) {
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
      chunkSilenceTrim.push(trimMeta);
      sourceFiles.push(sourcePath);
      onProgress({
        phase: 'generating',
        current: i + 1,
        total: normalizedChunks.length,
        message: trimMeta.trimmed
          ? `Generated chunk ${i + 1} of ${normalizedChunks.length}; trimmed ${trimMeta.removed_seconds}s boundary silence`
          : `Generated chunk ${i + 1} of ${normalizedChunks.length}`,
      });
    }

    if (options.signal?.aborted) throw new Error('Cancelled');
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
    let durationSeconds = 0;
    try {
      durationSeconds = Math.round(await probeAudioDurationSeconds(finalPath));
    } catch {}

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
