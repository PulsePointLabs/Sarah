import fs from 'node:fs/promises';
import path from 'node:path';
import { uploadDir, ttsRenderDir } from '../config.js';
import { listEntities, upsertEntity } from '../db.js';
import { normalizeAudioChapters } from './audioChapters.js';
import { renderTTSExport } from './ttsRenderer.js';
import { q, runProcess, slugifyFilePart, synthesizeTTSChunk } from './ttsCore.js';
import { buildReviewVideoPlan, extractCitedTimesFromText } from './sessionReviewVideoPlanner.js';

const REVIEW_RENDER_VERSION = 'session_review_video_v10';
const TTS_REQUEST_TAIL = '\u200B';

function cleanParagraph(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function uploadPathFromUrl(fileUrl = '') {
  const raw = String(fileUrl || '').trim();
  if (!raw.startsWith('/uploads/')) return null;
  const filename = path.basename(decodeURIComponent(raw.replace(/^\/uploads\//, '')));
  return path.join(uploadDir, filename);
}

async function fileExists(filePath) {
  if (!filePath) return false;
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
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

function matchAudioExport(record, request) {
  if (!record?.file_url) return false;
  if (record.render_version !== 'tts_export_leading_trim_v2') return false;
  if (String(record.tts_session_key || '') !== String(request.sessionId || '')) return false;
  if (String(record.source_generated_at || '') !== String(request.sourceGeneratedAt || '')) return false;
  if (String(record.voice || 'nova') !== String(request.voice || 'nova')) return false;
  if (String(record.model || '') !== String(request.model || '')) return false;
  if (String(record.format || 'mp3') !== String(request.outputFormat || 'mp3')) return false;
  return Math.abs(Number(record.speed || 1) - Number(request.speed || 1)) < 0.005;
}

function matchCompletedTtsJob(job, request) {
  const result = job?.result || {};
  if (job?.type !== 'tts_export' || job?.status !== 'complete' || !result?.file_url) return false;
  if (result.render_version !== 'tts_export_leading_trim_v2') return false;
  if (String(job?.meta?.sessionId || '') !== String(request.sessionId || '')) return false;
  if (String(job?.meta?.sourceGeneratedAt || '') !== String(request.sourceGeneratedAt || '')) return false;
  if (String(result.voice || 'nova') !== String(request.voice || 'nova')) return false;
  if (String(result.model || '') !== String(request.model || '')) return false;
  if (String(result.format || 'mp3') !== String(request.outputFormat || 'mp3')) return false;
  return Math.abs(Number(result.speed || 1) - Number(request.speed || 1)) < 0.005;
}

async function resolveNarration(payload, { jobId, signal, onProgress }) {
  const request = {
    sessionId: payload.sessionId,
    title: payload.title || 'Session Review Video',
    sourceGeneratedAt: payload.sourceGeneratedAt || null,
    voice: payload.voice || 'nova',
    model: payload.model,
    speed: payload.speed,
    outputFormat: payload.outputFormat || 'mp3',
  };

  const existing = listEntities('AudioExport')
    .filter((record) => matchAudioExport(record, request))
    .sort((a, b) => String(b.created_date || '').localeCompare(String(a.created_date || '')))[0];
  const existingPath = uploadPathFromUrl(existing?.file_url);
  if (existing && await fileExists(existingPath)) {
    onProgress?.({
      phase: 'narration',
      current: 1,
      total: 5,
      message: 'Reusing matching TTS narration export...',
      audio_file_url: existing.file_url,
    });
    return {
      reused: true,
      audioPath: existingPath,
      audioExport: existing,
      rendered: {
        file_url: existing.file_url,
        filename: existing.filename || path.basename(existingPath),
        duration_seconds: Number(existing.duration_seconds || 0),
        format: existing.format || request.outputFormat,
        voice: existing.voice || request.voice,
        model: existing.model || request.model,
        speed: Number(existing.speed || request.speed || 1),
        render_version: existing.render_version,
        chapters: existing.chapters || [],
      },
    };
  }

  const completedJob = listEntities('ProcessingJob')
    .filter((job) => matchCompletedTtsJob(job, request))
    .sort((a, b) => String(b.finishedAt || b.updatedAt || '').localeCompare(String(a.finishedAt || a.updatedAt || '')))[0];
  const completedJobPath = uploadPathFromUrl(completedJob?.result?.file_url);
  if (completedJob && await fileExists(completedJobPath)) {
    const result = completedJob.result || {};
    onProgress?.({
      phase: 'narration',
      current: 1,
      total: 5,
      message: 'Reusing completed TTS narration job...',
      audio_file_url: result.file_url,
    });
    return {
      reused: true,
      audioPath: completedJobPath,
      audioExport: null,
      rendered: {
        ...result,
        duration_seconds: Number(result.duration_seconds || 0),
        voice: result.voice || request.voice,
        model: result.model || request.model,
        speed: Number(result.speed || request.speed || 1),
        format: result.format || request.outputFormat,
      },
    };
  }

  onProgress?.({
    phase: 'narration',
    current: 1,
    total: 5,
    message: 'Rendering TTS narration for review video...',
  });
  const rendered = await renderTTSExport({
    title: request.title,
    chunks: payload.chunks || [],
    chapters: payload.chapters || [],
    voice: request.voice,
    model: request.model,
    speed: request.speed,
    instructions: payload.instructions || '',
    outputFormat: request.outputFormat,
    normalize: Boolean(payload.normalize),
  }, {
    jobId: `${jobId}-audio`,
    signal,
    onProgress: (progress) => onProgress?.({
      ...progress,
      phase: `narration_${progress?.phase || 'rendering'}`,
      message: `Narration: ${progress?.message || 'rendering...'}`,
    }),
  });
  const audioPath = uploadPathFromUrl(rendered.file_url);
  const savedAudio = upsertEntity('AudioExport', crypto.randomUUID(), {
    title: request.title,
    file_url: rendered.file_url,
    duration_seconds: Math.round(rendered.duration_seconds || 0),
    voice: rendered.voice || request.voice,
    speed: rendered.speed || request.speed,
    model: rendered.model || request.model,
    format: rendered.format || request.outputFormat,
    render_version: rendered.render_version || 'tts_export_leading_trim_v2',
    silence_trim: rendered.silence_trim || null,
    size: rendered.size,
    filename: rendered.filename,
    tts_session_key: request.sessionId || null,
    analysis_title: request.title,
    session_date: payload.sessionDate || null,
    source_generated_at: request.sourceGeneratedAt,
    exported_at: new Date().toISOString(),
    has_chapters: Boolean(rendered.has_chapters),
    chapter_format: rendered.chapter_format || 'sidecar',
    chapter_count: Number(rendered.chapter_count || 0),
    chapter_source: rendered.chapter_source || 'tts_export',
    chapter_generated_at: rendered.chapter_generated_at || null,
    chapters_embedded: Boolean(rendered.chapters_embedded),
    sidecar_chapters_available: Boolean(rendered.sidecar_chapters_available),
    chapter_json_url: rendered.chapter_json_url || null,
    chapter_cue_url: rendered.chapter_cue_url || null,
    chapter_txt_url: rendered.chapter_txt_url || null,
    audio_content_version: request.sourceGeneratedAt,
  });
  return { reused: false, audioPath, audioExport: savedAudio, rendered };
}

async function candidateFrameBytes(videoPath, workDir, index) {
  const output = path.join(workDir, `candidate-frame-${String(index).padStart(3, '0')}.jpg`);
  await runProcess('ffmpeg', [
    '-hide_banner',
    '-y',
    '-ss', '300',
    '-i', videoPath,
    '-frames:v', '1',
    '-vf', 'scale=320:-1',
    '-q:v', '4',
    output,
  ]);
  const stat = await fs.stat(output);
  return stat.size;
}

function companionMainVideo(video = {}) {
  const rawPath = String(video?.path || '');
  const basename = path.basename(rawPath);
  if (!/^(?:feet|foot|legs?|toes?)[-_\s]/i.test(basename)) return null;
  const companionName = basename.replace(/^(?:feet|foot|legs?|toes?)[-_\s]+/i, '');
  if (!companionName || companionName === basename) return null;
  return {
    ...video,
    id: `${video.id || rawPath}:main-companion`,
    path: path.join(path.dirname(rawPath), companionName),
    filename: companionName,
    label: 'Main / composite recording',
    role: 'main',
    camera_angle: 'main',
    _derived_from: rawPath,
  };
}

function rankedVideoCandidates(session = {}) {
  const videos = Array.isArray(session.linked_local_videos) ? session.linked_local_videos : [];
  const expanded = [];
  for (const video of videos) {
    if (video?.path) expanded.push(video);
    const companion = companionMainVideo(video);
    if (companion?.path) expanded.push(companion);
  }
  const seen = new Set();
  const unique = expanded.filter((video) => {
    const key = path.resolve(String(video?.path || '')).toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
  const candidates = unique.filter((video) => video?.path && video.exists !== false);
  const pool = candidates.length ? candidates : unique.filter((video) => video?.path);
  const score = (video) => {
    const basename = path.basename(String(video?.path || video?.filename || '')).toLowerCase();
    const text = `${video?.label || ''} ${video?.role || ''} ${video?.camera_angle || ''} ${video?.filename || ''} ${basename}`.toLowerCase();
    let value = 50;
    if (/\b(composite|pip|picture[-_\s]?in[-_\s]?picture|combined|obs|program|scene)\b/.test(text)) value += 160;
    if (/\b(main|primary|master|source|session|recording)\b/.test(text)) value += 140;
    if (/\b(genital|pelvic|perineal|close)\b/.test(text)) value += 65;
    if (/\b(lateral|side|full[-_\s]?body|whole[-_\s]?body|body)\b/.test(text)) value += 45;
    if (/^(?:feet|foot|legs?|toes?)[-_\s]/.test(basename) || /\b(feet|foot|legs?|toes?|lower[-_\s]?body|footcam)\b/.test(text)) value -= 260;
    if (/\b(calibration|debug|test|roi|mask|preview)\b/.test(text)) value -= 120;
    return value;
  };
  return [...pool]
    .map((video) => ({ ...video, _review_video_score: score(video) }))
    .sort((a, b) => b._review_video_score - a._review_video_score);
}

async function choosePrimaryVideo(session = {}, { workDir, onProgress } = {}) {
  const candidates = rankedVideoCandidates(session);
  let fallback = null;
  for (const video of candidates) {
    if (!(await fileExists(video.path))) continue;
    if (!fallback) fallback = video;
    try {
      const frameBytes = await candidateFrameBytes(video.path, workDir, candidates.indexOf(video) + 1);
      if (frameBytes >= 2500) return { ...video, _review_frame_bytes: frameBytes };
      onProgress?.({
        phase: 'segments',
        current: 3,
        total: 5,
        message: `Skipping low-visual-content source: ${path.basename(video.path)}`,
      });
    } catch {
      // If ffmpeg can still normalize the source later, keep it as a last resort.
    }
  }
  return fallback;
}

function sourceTimeForSession(sessionTime, video = {}) {
  const offset = Number(video.timeline_offset_s ?? video.offset_seconds ?? video.session_time_offset_s ?? 0);
  return Math.max(0, Number(sessionTime || 0) + (Number.isFinite(offset) ? offset : 0));
}

function formatTimestamp(seconds = 0) {
  const totalSeconds = Math.max(0, Math.floor(Number(seconds || 0)));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  if (hours) return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

function drawTextSafe(value = '') {
  return String(value || '')
    .replace(/\\/g, '/')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .trim();
}

function timestampOverlayFilter({ startSeconds = 0, sessionSeconds = null, playbackRate = 1 } = {}) {
  const fontPath = process.env.REVIEW_VIDEO_FONT || 'C\\:/Windows/Fonts/arial.ttf';
  const sourceLabel = `source ${formatTimestamp(startSeconds)}`;
  const sessionLabel = Number.isFinite(Number(sessionSeconds))
    ? `session ${formatTimestamp(sessionSeconds)}`
    : '';
  const rate = Number(playbackRate);
  const slowMoLabel = Number.isFinite(rate) && rate > 0 && rate < 0.99 ? `${Math.round(rate * 100)}% speed` : '';
  const text = drawTextSafe([sessionLabel, sourceLabel, slowMoLabel].filter(Boolean).join('  |  '));
  return [
    'scale=1280:720:force_original_aspect_ratio=decrease',
    'pad=1280:720:(ow-iw)/2:(oh-ih)/2',
    'format=yuv420p',
    Number.isFinite(rate) && rate > 0 && rate < 0.99 ? `setpts=${(1 / rate).toFixed(4)}*PTS` : null,
    `drawtext=fontfile='${fontPath}':text='${text}':x=24:y=h-58:fontsize=24:fontcolor=white:box=1:boxcolor=black@0.68:boxborderw=10`,
  ].filter(Boolean).join(',');
}

async function cutReviewClip({ sourcePath, startSeconds, endSeconds, label, workDir, index, sessionSeconds = null, playbackRate = 1 }) {
  const duration = Math.max(0.25, Math.min(180, Number(endSeconds || 0) - Number(startSeconds || 0)));
  const output = path.join(workDir, `segment-source-${String(index).padStart(3, '0')}.mp4`);
  await runProcess('ffmpeg', [
    '-hide_banner',
    '-y',
    '-ss', String(Math.max(0, Number(startSeconds || 0))),
    '-t', String(duration),
    '-i', sourcePath,
    '-map', '0:v:0',
    '-an',
    '-vf', timestampOverlayFilter({ startSeconds, sessionSeconds, playbackRate }),
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    output,
  ]);
  return {
    path: output,
    label,
    durationSeconds: await mediaDurationSeconds(output).catch(() => duration),
  };
}

function wordCount(value) {
  return String(value || '').split(/\s+/).filter(Boolean).length;
}

function estimateParagraphSlots(paragraphs = [], durationSeconds = 0) {
  const safeParagraphs = Array.isArray(paragraphs) ? paragraphs : [];
  const totalDuration = Math.max(1, Number(durationSeconds || 1));
  const weights = safeParagraphs.map((paragraph) => Math.max(6, wordCount(paragraph)));
  const totalWeight = weights.reduce((sum, weight) => sum + weight, 0) || 1;
  let cursor = 0;
  return weights.map((weight, index) => {
    const startSeconds = cursor;
    const span = index === weights.length - 1
      ? Math.max(1, totalDuration - cursor)
      : Math.max(1, (weight / totalWeight) * totalDuration);
    cursor += span;
    return {
      paragraphIndex: index,
      startSeconds,
      endSeconds: Math.min(totalDuration, startSeconds + span),
      durationSeconds: Math.max(1, Math.min(totalDuration - startSeconds, span)),
    };
  });
}

function slotTitle(index, payloadTitle) {
  return index === 0 ? payloadTitle || 'Session Review' : `Analysis section ${index + 1}`;
}

function clipSessionTime(clip = {}) {
  const value = Number(clip.session_time_s ?? clip.sessionTimeSeconds ?? clip.timeline_offset_s ?? clip.startSeconds);
  return Number.isFinite(value) ? value : null;
}

async function buildNarrationAlignedSegments({
  paragraphs,
  paragraphSlots,
  plan,
  primaryVideo,
  sourceDuration,
  clipByParagraph,
  workDir,
  payloadTitle,
  onProgress,
  signal,
}) {
  const segments = [];
  const generatedClips = [];
  let visualDuration = 0;
  let segmentIndex = 1;
  let continuitySourceCursor = 0;

  for (const slot of paragraphSlots) {
    if (signal?.aborted) throw new Error('Cancelled');
    const paragraphIndex = slot.paragraphIndex;
    const generatedRequests = (plan.generatedClipRequests || [])
      .filter((request) => Number(request.paragraphIndex) === paragraphIndex);
    const fallbackExplicitTimes = !generatedRequests.length
      ? extractCitedTimesFromText(paragraphs[paragraphIndex] || '', paragraphIndex).map((time, index) => ({
        id: `paragraph-time-${paragraphIndex}-${index}`,
        paragraphIndex,
        session_time_s: time.seconds,
        cited_text: time.text,
        label: time.text ? `Referenced ${time.text}` : `Referenced moment ${index + 1}`,
        reason: time.text ? `Referenced as ${time.text}` : 'Referenced in narration text',
        startSeconds: Math.max(0, time.seconds - 2),
        endSeconds: time.seconds + Math.max(8, Math.min(24, slot.durationSeconds)),
      }))
      : [];
    const existingClips = clipByParagraph.get(paragraphIndex) || [];
    const timedExistingClips = existingClips.filter((clip) => Number.isFinite(Number(clipSessionTime(clip))));
    const playableEvents = [
      ...timedExistingClips.map((clip) => ({
        type: 'existing_clip_time',
        label: clip.label || 'Saved key clip',
        session_time_s: clipSessionTime(clip),
        source: clip,
      })),
      ...generatedRequests.map((request) => ({
        type: 'cited_time',
        label: request.label,
        session_time_s: Number(request.session_time_s),
        source: request,
      })),
      ...fallbackExplicitTimes.map((request) => ({
        type: 'paragraph_time',
        label: request.label,
        session_time_s: Number(request.session_time_s),
        source: request,
      })),
    ].filter((event) => Number.isFinite(Number(event.session_time_s)));

    if (primaryVideo?.path && playableEvents.length) {
      const sliceDuration = Math.max(4, slot.durationSeconds / playableEvents.length);
      let slotVisualDuration = 0;
      for (const event of playableEvents) {
        const center = sourceTimeForSession(event.session_time_s, primaryVideo);
        const requestedStart = Number(event.source?.startSeconds);
        const requestedEnd = Number(event.source?.endSeconds);
        const sourceOffset = center - Number(event.session_time_s);
        const start = Number.isFinite(requestedStart)
          ? Math.max(0, requestedStart + sourceOffset)
          : Math.max(0, center - Math.min(4, sliceDuration * 0.25));
        const end = Number.isFinite(requestedEnd) && requestedEnd > requestedStart
          ? Math.max(start + 1, requestedEnd + sourceOffset)
          : start + sliceDuration;
        onProgress?.({
          phase: 'segments',
          current: 3,
          total: 5,
          message: `Cutting ${safeDrawText(event.label || 'cited moment', 36)} at ${Math.round(event.session_time_s)}s...`,
        });
        try {
          const clip = await cutReviewClip({
            sourcePath: primaryVideo.path,
            startSeconds: start,
            endSeconds: end,
            label: event.label,
            workDir,
            index: segmentIndex++,
            sessionSeconds: event.session_time_s,
          });
          segments.push(clip.path);
          const actualDuration = Number(clip.durationSeconds || sliceDuration);
          visualDuration += actualDuration;
          slotVisualDuration += actualDuration;
          generatedClips.push({
            ...event.source,
            paragraphIndex,
            session_time_s: event.session_time_s,
            source_video_path: primaryVideo.path,
            aligned_narration_start_s: Math.round(slot.startSeconds * 10) / 10,
            aligned_narration_end_s: Math.round(slot.endSeconds * 10) / 10,
            durationSeconds: Number(clip.durationSeconds || sliceDuration),
          });
          continuitySourceCursor = Math.min(Math.max(0, sourceDuration || Number.POSITIVE_INFINITY), start + actualDuration);
        } catch (error) {
          generatedClips.push({
            ...event.source,
            paragraphIndex,
            session_time_s: event.session_time_s,
            source_video_path: primaryVideo.path,
            error: error?.message || 'Aligned clip cut failed',
          });
        }
      }
      if (slotVisualDuration <= 0) {
        const fallbackStart = Math.max(0, Math.min(sourceDuration || continuitySourceCursor, continuitySourceCursor));
        const fallbackEnd = fallbackStart + slot.durationSeconds;
        const clip = await cutReviewClip({
          sourcePath: primaryVideo.path,
          startSeconds: fallbackStart,
          endSeconds: fallbackEnd,
          label: slotTitle(paragraphIndex, payloadTitle),
          workDir,
          index: segmentIndex++,
          sessionSeconds: fallbackStart,
        });
        segments.push(clip.path);
        visualDuration += Number(clip.durationSeconds || slot.durationSeconds);
        continuitySourceCursor = fallbackStart + Number(clip.durationSeconds || slot.durationSeconds);
      }
      continue;
    }

    if (primaryVideo?.path) {
      const maxStart = Math.max(0, Number(sourceDuration || 0) - Math.max(1, slot.durationSeconds));
      const fallbackStart = Math.max(0, Math.min(maxStart || continuitySourceCursor, continuitySourceCursor));
      const fallbackEnd = fallbackStart + slot.durationSeconds;
      onProgress?.({
        phase: 'segments',
        current: 3,
        total: 5,
        message: `Filling narration section ${paragraphIndex + 1} with source video context...`,
      });
      const clip = await cutReviewClip({
        sourcePath: primaryVideo.path,
        startSeconds: fallbackStart,
        endSeconds: fallbackEnd,
        label: slotTitle(paragraphIndex, payloadTitle),
        workDir,
        index: segmentIndex++,
        sessionSeconds: fallbackStart,
      });
      segments.push(clip.path);
      visualDuration += Number(clip.durationSeconds || slot.durationSeconds);
      generatedClips.push({
        id: `context-${paragraphIndex}`,
        paragraphIndex,
        session_time_s: Math.round(fallbackStart * 10) / 10,
        cited_text: 'Continuous source video context',
        label: slotTitle(paragraphIndex, payloadTitle),
        reason: 'No exact logged event or explicit timestamp matched this narration slot; using source video instead of title-card filler.',
        source_video_path: primaryVideo.path,
        aligned_narration_start_s: Math.round(slot.startSeconds * 10) / 10,
        aligned_narration_end_s: Math.round(slot.endSeconds * 10) / 10,
        durationSeconds: Number(clip.durationSeconds || slot.durationSeconds),
      });
      continuitySourceCursor = fallbackStart + Number(clip.durationSeconds || slot.durationSeconds);
      continue;
    }

    const untimedExistingClip = existingClips.find((clip) => clip.path);
    if (untimedExistingClip?.path) {
      const output = path.join(workDir, `aligned-existing-${String(segmentIndex++).padStart(3, '0')}.mp4`);
      await normalizeVideoSegment({
        inputPath: untimedExistingClip.path,
        outputPath: output,
        durationSeconds: slot.durationSeconds,
      });
      segments.push(output);
      visualDuration += await mediaDurationSeconds(output).catch(() => slot.durationSeconds);
      continue;
    }

    const card = await createTitleCard({
      workDir,
      index: segmentIndex++,
      title: slotTitle(paragraphIndex, payloadTitle),
      subtitle: paragraphs[paragraphIndex],
      durationSeconds: slot.durationSeconds,
    });
    segments.push(card.path);
    visualDuration += Number(card.durationSeconds || slot.durationSeconds);
  }

  return {
    segments,
    visualDuration,
    generatedClips,
  };
}

function safeDrawText(value, limit = 70) {
  return String(value || '')
    .replace(/[\r\n]+/g, ' ')
    .replace(/[':\\]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

async function createTitleCard({ workDir, index, title, subtitle, durationSeconds }) {
  const output = path.join(workDir, `title-card-${String(index).padStart(3, '0')}.mp4`);
  const fontPath = process.env.REVIEW_VIDEO_FONT || 'C\\:/Windows/Fonts/arial.ttf';
  const heading = safeDrawText(title || 'Session Review', 48);
  const body = safeDrawText(subtitle || '', 92);
  const draw = [
    `drawtext=fontfile='${fontPath}':text='${heading}':fontcolor=white:fontsize=42:x=(w-text_w)/2:y=(h/2)-70`,
    body ? `drawtext=fontfile='${fontPath}':text='${body}':fontcolor=white@0.78:fontsize=24:x=(w-text_w)/2:y=(h/2)+8` : null,
  ].filter(Boolean).join(',');
  await runProcess('ffmpeg', [
    '-hide_banner',
    '-y',
    '-f', 'lavfi',
    '-i', `color=c=#101418:s=1280x720:d=${Math.max(2, Number(durationSeconds || 3))}`,
    '-vf', draw,
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    output,
  ]);
  return {
    path: output,
    label: title,
    durationSeconds: await mediaDurationSeconds(output).catch(() => Math.max(2, Number(durationSeconds || 3))),
  };
}

async function normalizeVideoSegment({ inputPath, outputPath, durationSeconds = null }) {
  const durationArgs = durationSeconds ? ['-t', String(Math.max(0.5, Number(durationSeconds)))] : [];
  await runProcess('ffmpeg', [
    '-hide_banner',
    '-y',
    '-i', inputPath,
    ...durationArgs,
    '-map', '0:v:0',
    '-an',
    '-vf', 'scale=1280:720:force_original_aspect_ratio=decrease,pad=1280:720:(ow-iw)/2:(oh-ih)/2,format=yuv420p',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '23',
    '-pix_fmt', 'yuv420p',
    outputPath,
  ]);
  return outputPath;
}

async function buildFullVideoSegments({ sourcePath, workDir, audioDuration = 0 }) {
  const sourceDuration = await mediaDurationSeconds(sourcePath).catch(() => 0);
  const targetDuration = Math.max(1, Number(audioDuration || sourceDuration || 1));
  const segmentDuration = sourceDuration > 0 ? Math.min(sourceDuration, targetDuration) : targetDuration;
  const normalizedPath = path.join(workDir, 'full-source-normalized.mp4');
  await normalizeVideoSegment({
    inputPath: sourcePath,
    outputPath: normalizedPath,
    durationSeconds: segmentDuration,
  });
  const normalizedDuration = await mediaDurationSeconds(normalizedPath).catch(() => segmentDuration);
  const segments = [];
  let visualDuration = 0;
  let guard = 0;
  while (visualDuration < targetDuration + 0.75 && guard < 20) {
    segments.push(normalizedPath);
    visualDuration += Math.max(0.25, normalizedDuration || segmentDuration);
    guard += 1;
  }
  return {
    segments,
    visualDuration,
    sourceDuration,
    normalizedDuration,
  };
}

function estimateChapterStarts(paragraphs, durationSeconds) {
  const weights = paragraphs.map((text) => Math.max(8, String(text || '').split(/\s+/).filter(Boolean).length));
  const total = weights.reduce((sum, value) => sum + value, 0) || 1;
  let cursor = 0;
  return weights.map((weight, index) => {
    const startMs = Math.round(cursor * 1000);
    cursor += (weight / total) * Math.max(1, Number(durationSeconds || 1));
    return {
      id: `review-${index + 1}`,
      title: index === 0 ? 'Summary' : `Analysis section ${index + 1}`,
      startMs,
      source: 'session_review_video',
      confidence: 'estimated',
    };
  });
}

async function writeManifest(outputBase, manifest) {
  const filename = `${outputBase}.review-manifest.json`;
  await fs.writeFile(path.join(uploadDir, filename), JSON.stringify(manifest, null, 2), 'utf8');
  return `/uploads/${filename}`;
}

async function concatSegments(segmentPaths, outputPath, workDir) {
  const concatPath = path.join(workDir, 'segments.txt');
  await fs.writeFile(concatPath, segmentPaths.map((file) => `file ${q(file.replace(/\\/g, '/'))}`).join('\n'), 'utf8');
  await runProcess('ffmpeg', [
    '-hide_banner',
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', concatPath,
    '-vf', 'format=yuv420p',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '22',
    '-pix_fmt', 'yuv420p',
    outputPath,
  ]);
}

async function muxAudioVideo(videoPath, audioPath, outputPath) {
  await runProcess('ffmpeg', [
    '-hide_banner',
    '-y',
    '-i', videoPath,
    '-i', audioPath,
    '-map', '0:v:0',
    '-map', '1:a:0',
    '-c:v', 'copy',
    '-c:a', 'aac',
    '-b:a', '320k',
    '-shortest',
    '-movflags', '+faststart',
    outputPath,
  ]);
}

async function concatAvSegments(segmentPaths, outputPath, workDir) {
  const concatPath = path.join(workDir, 'av-segments.txt');
  await fs.writeFile(concatPath, segmentPaths.map((file) => `file ${q(file.replace(/\\/g, '/'))}`).join('\n'), 'utf8');
  await runProcess('ffmpeg', [
    '-hide_banner',
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', concatPath,
    '-map', '0:v:0',
    '-map', '0:a:0',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '22',
    '-c:a', 'aac',
    '-b:a', '320k',
    '-movflags', '+faststart',
    outputPath,
  ]);
}

async function concatAudioSegments(audioPaths, outputPath, workDir) {
  const concatPath = path.join(workDir, 'audio-segments.txt');
  await fs.writeFile(concatPath, audioPaths.map((file) => `file ${q(file.replace(/\\/g, '/'))}`).join('\n'), 'utf8');
  await runProcess('ffmpeg', [
    '-hide_banner',
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', concatPath,
    '-vn',
    '-c:a', 'libmp3lame',
    '-b:a', '320k',
    '-compression_level', '0',
    outputPath,
  ]);
}

function splitSentences(text = '') {
  return String(text || '')
    .replace(/\s+/g, ' ')
    .trim()
    .match(/[^.!?]+[.!?]+(?:["')\]]+)?|[^.!?]+$/g)
    ?.map((sentence) => sentence.trim())
    .filter(Boolean) || [];
}

function isMomentSentence(text = '') {
  return extractCitedTimesFromText(text).length > 0 || /\b(climax|ejaculat|orgasm|recovery|pre[-\s]?climax|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|\d{1,2}:\d{2})\b/i.test(text);
}

function buildReviewNarrationSegments(paragraphs = []) {
  const output = [];
  for (const [paragraphIndex, paragraph] of paragraphs.entries()) {
    const sentences = splitSentences(paragraph);
    if (!sentences.length) continue;
    let buffer = [];
    const flush = () => {
      const text = buffer.join(' ').replace(/\s+/g, ' ').trim();
      if (text) output.push({ paragraphIndex, text });
      buffer = [];
    };
    for (const sentence of sentences) {
      const moment = isMomentSentence(sentence);
      const bufferedLength = buffer.join(' ').length;
      if (moment) flush();
      if (!moment && bufferedLength + sentence.length <= 520) {
        buffer.push(sentence);
        continue;
      }
      if (!moment) flush();
      output.push({ paragraphIndex, text: sentence });
    }
    flush();
  }
  return output;
}

function eventText(event = {}) {
  return [event.label, event.reason, event.note, event.category, event.tags, event.cited_text]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function segmentKeywordScore(event = {}, segmentText = '') {
  const source = eventText(event);
  const target = String(segmentText || '').toLowerCase();
  const pairs = [
    [/\bclimax|ejaculat|orgasm|semen|release\b/, 120],
    [/\brecovery|recovered|settled|drop\b/, 80],
    [/\bpre[-\s]?climax|build|approach|threshold\b/, 70],
    [/\blubric|lube|pause|paused|prep|preparation\b/, 110],
    [/\bheart rate|hrv|bpm|peak\b/, 35],
    [/\bperineal|pelvic|contraction|foley|catheter\b/, 35],
  ];
  return pairs.reduce((sum, [pattern, score]) => (
    pattern.test(source) && pattern.test(target) ? sum + score : sum
  ), 0);
}

function collectSegmentEvents({ segment, plan, clipByParagraph }) {
  const paragraphIndex = Number(segment.paragraphIndex);
  const explicitTimes = extractCitedTimesFromText(segment.text, paragraphIndex);
  const requests = (plan.generatedClipRequests || [])
    .filter((request) => Number(request.paragraphIndex) === paragraphIndex);
  const clips = (clipByParagraph.get(paragraphIndex) || [])
    .filter((clip) => Number.isFinite(Number(clipSessionTime(clip))));
  const synthetic = explicitTimes.map((time, index) => ({
    id: `segment-time-${paragraphIndex}-${index}-${Math.round(time.seconds)}`,
    paragraphIndex,
    session_time_s: time.seconds,
    cited_text: time.text,
    label: time.text ? `Referenced ${time.text}` : 'Referenced moment',
    reason: 'Explicitly referenced in spoken segment',
    startSeconds: Math.max(0, time.seconds - 3),
    endSeconds: time.seconds + 14,
    source: 'spoken_segment_time',
  }));
  return [...requests, ...clips, ...synthetic]
    .map((event) => ({
      ...event,
      session_time_s: Number(event.session_time_s ?? clipSessionTime(event)),
    }))
    .filter((event) => Number.isFinite(Number(event.session_time_s)));
}

function chooseSegmentEvent({ segment, plan, clipByParagraph, usedEventIds }) {
  const candidates = collectSegmentEvents({ segment, plan, clipByParagraph });
  if (!candidates.length) return null;
  const explicitTimes = extractCitedTimesFromText(segment.text, segment.paragraphIndex);
  let best = null;
  for (const event of candidates) {
    const id = String(event.id || `${event.label}:${event.session_time_s}`);
    const reusePenalty = usedEventIds.has(id) ? 45 : 0;
    const directTimeScore = explicitTimes.some((time) => Math.abs(Number(time.seconds) - Number(event.session_time_s)) <= 14)
      ? 220
      : 0;
    const score = directTimeScore + segmentKeywordScore(event, segment.text) - reusePenalty;
    if (!best || score > best.score) best = { event, score, id };
  }
  if (!best || best.score < 20) return null;
  usedEventIds.add(best.id);
  return best.event;
}

function clampClipStart(startSeconds, durationSeconds, sourceDuration) {
  const duration = Math.max(0.5, Number(durationSeconds || 0.5));
  const maxStart = Math.max(0, Number(sourceDuration || 0) - duration);
  return Math.max(0, Math.min(maxStart, Number(startSeconds || 0)));
}

function isClimaxReviewSegment(segment = {}, event = {}) {
  return /\b(climax|ejaculat|orgasm|semen|fluid release|release of semen|emission|expulsion)\b/i.test(`${segment.text || ''} ${eventText(event)}`);
}

function sourceWindowForSegment({ event, segment, audioDuration, primaryVideo, sourceDuration, fallbackCursor }) {
  const duration = Math.max(1.25, Number(audioDuration || 1) + 1.25);
  if (event) {
    const sessionTime = Number(event.session_time_s);
    const sourceCenter = sourceTimeForSession(sessionTime, primaryVideo);
    const requestedStart = Number(event.startSeconds);
    const offset = sourceCenter - sessionTime;
    const wantsClimax = isClimaxReviewSegment(segment, event);
    const playbackRate = wantsClimax ? 0.5 : 1;
    const sourceSliceDuration = playbackRate < 1 ? Math.max(2.5, duration * playbackRate) : duration;
    const preroll = wantsClimax ? Math.min(3, sourceSliceDuration * 0.4) : 2.5;
    const rawStart = wantsClimax
      ? sourceCenter - preroll
      : Number.isFinite(requestedStart)
      ? requestedStart + offset
      : sourceCenter - preroll;
    const start = clampClipStart(rawStart, sourceSliceDuration, sourceDuration);
    return {
      start,
      end: start + sourceSliceDuration,
      sessionSeconds: sessionTime,
      label: event.label || event.cited_text || 'Referenced moment',
      playbackRate,
      slowMotion: wantsClimax,
    };
  }
  const start = clampClipStart(fallbackCursor, duration, sourceDuration);
  return {
    start,
    end: start + duration,
    sessionSeconds: start,
    label: 'Source video context',
    playbackRate: 1,
    slowMotion: false,
  };
}

async function synthesizeReviewSegmentAudio({ segment, index, payload, workDir, previousText, jobId }) {
  const inputText = `${String(segment.text || '').trim()}${TTS_REQUEST_TAIL}`;
  const rendered = await synthesizeTTSChunk({
    text: inputText,
    voice: payload.voice || 'nova',
    model: payload.model,
    speed: payload.speed,
    instructions: payload.instructions || '',
    format: 'wav',
    previousContext: previousText,
    meta: {
      jobId,
      chunkIndex: index,
      source: 'session_review_video_segment',
    },
  });
  const audioPath = path.join(workDir, `segment-audio-${String(index + 1).padStart(3, '0')}.wav`);
  await fs.writeFile(audioPath, rendered.buffer);
  const duration = await mediaDurationSeconds(audioPath).catch(() => Math.max(1, wordCount(segment.text) / 2.25));
  return { ...rendered, audioPath, durationSeconds: duration };
}

async function renderSegmentedSourceReviewVideo({
  payload,
  session,
  paragraphs,
  plan,
  primaryVideo,
  workDir,
  jobId,
  onProgress,
  signal,
}) {
  const sourceDuration = await mediaDurationSeconds(primaryVideo.path).catch(() => 0);
  const existingSegmentSources = [];
  for (const clip of plan.existingClips.slice(0, 24)) {
    const clipPath = uploadPathFromUrl(clip.file_url || clip.url || clip.clip_url);
    if (await fileExists(clipPath)) {
      existingSegmentSources.push({
        ...clip,
        path: clipPath,
        label: clip.label || 'Saved key clip',
        paragraphIndex: clip.paragraphIndex,
        session_time_s: clipSessionTime(clip),
      });
    }
  }
  const clipByParagraph = new Map();
  existingSegmentSources.forEach((clip) => {
    const key = Number.isFinite(Number(clip.paragraphIndex)) ? Number(clip.paragraphIndex) : 0;
    if (!clipByParagraph.has(key)) clipByParagraph.set(key, []);
    clipByParagraph.get(key).push(clip);
  });

  const narrationSegments = buildReviewNarrationSegments(paragraphs);
  const usedEventIds = new Set();
  const avSegments = [];
  const audioSegments = [];
  const generatedClips = [];
  let previousText = '';
  let fallbackCursor = 0;
  let totalAudioDuration = 0;
  let ttsMeta = null;

  for (const [index, segment] of narrationSegments.entries()) {
    if (signal?.aborted) throw new Error('Cancelled');
    onProgress?.({
      phase: 'segmented_narration',
      current: 1,
      total: 5,
      message: `Rendering spoken segment ${index + 1} of ${narrationSegments.length}...`,
    });
    const audio = await synthesizeReviewSegmentAudio({
      segment,
      index,
      payload,
      workDir,
      previousText: previousText.slice(-320),
      jobId,
    });
    ttsMeta = ttsMeta || audio;
    audioSegments.push(audio.audioPath);
    totalAudioDuration += Number(audio.durationSeconds || 0);

    const event = chooseSegmentEvent({ segment, plan, clipByParagraph, usedEventIds });
    const window = sourceWindowForSegment({
      event,
      segment,
      audioDuration: audio.durationSeconds,
      primaryVideo,
      sourceDuration,
      fallbackCursor,
    });
    onProgress?.({
      phase: 'segments',
      current: 3,
      total: 5,
      message: `Cutting video for spoken segment ${index + 1} at ${formatTimestamp(window.sessionSeconds)}...`,
    });
    const videoClip = await cutReviewClip({
      sourcePath: primaryVideo.path,
      startSeconds: window.start,
      endSeconds: window.end,
      label: window.label,
      workDir,
      index: index + 1,
      sessionSeconds: window.sessionSeconds,
      playbackRate: window.playbackRate || 1,
    });
    const avPath = path.join(workDir, `segment-av-${String(index + 1).padStart(3, '0')}.mp4`);
    await muxAudioVideo(videoClip.path, audio.audioPath, avPath);
    avSegments.push(avPath);
    fallbackCursor = clampClipStart(window.start + Number(audio.durationSeconds || 1), Number(audio.durationSeconds || 1), sourceDuration);
    generatedClips.push({
      id: event?.id || `context-${index + 1}`,
      paragraphIndex: segment.paragraphIndex,
      session_time_s: event ? Number(event.session_time_s) : Math.round(window.sessionSeconds * 10) / 10,
      source_start_s: Math.round(window.start * 10) / 10,
      source_end_s: Math.round(window.end * 10) / 10,
      spoken_segment_index: index + 1,
      spoken_text: segment.text.slice(0, 240),
      label: window.label,
      reason: event?.reason || 'No exact event matched this spoken segment; using continuous source video context.',
      source_video_path: primaryVideo.path,
      audio_duration_seconds: Math.round(Number(audio.durationSeconds || 0) * 10) / 10,
      playback_rate: Number(window.playbackRate || 1),
      slow_motion: Boolean(window.slowMotion),
      matched_event: Boolean(event),
    });
    previousText = previousText ? `${previousText} ${segment.text}` : segment.text;
  }

  const outputBase = `${slugifyFilePart(payload.title || 'session-review-video')}-${Date.now()}`;
  const outputFilename = `${outputBase}.mp4`;
  const outputPath = path.join(uploadDir, outputFilename);
  const audioFilename = `${outputBase}.mp3`;
  const audioOutputPath = path.join(uploadDir, audioFilename);

  onProgress({ phase: 'muxing', current: 4, total: 5, message: 'Concatenating aligned spoken video segments...' });
  await concatAvSegments(avSegments, outputPath, workDir);
  await concatAudioSegments(audioSegments, audioOutputPath, workDir);

  const stat = await fs.stat(outputPath);
  const finalDuration = await mediaDurationSeconds(outputPath).catch(() => totalAudioDuration);
  const audioStat = await fs.stat(audioOutputPath).catch(() => null);
  const chapters = normalizeAudioChapters(
    narrationSegments.map((segment, index) => ({
      id: `review-segment-${index + 1}`,
      title: index === 0 ? 'Summary' : `Spoken segment ${index + 1}`,
      startMs: Math.round(generatedClips.slice(0, index).reduce((sum, clip) => sum + Number(clip.audio_duration_seconds || 0), 0) * 1000),
      source: 'session_review_video_segment',
      confidence: 'exact_segment_order',
    })),
    finalDuration
  );
  const manifest = {
    version: 1,
    render_version: REVIEW_RENDER_VERSION,
    title: payload.title || 'Session Review Video',
    session_id: payload.sessionId || session.id || null,
    generated_at: new Date().toISOString(),
    audio_reused: false,
    audio_file_url: `/uploads/${audioFilename}`,
    visual_mode: 'segmented_tts_source_video',
    visual_duration_seconds: Math.round(finalDuration || 0),
    source_video_path: primaryVideo.path,
    source_video_duration_seconds: Math.round(sourceDuration || 0),
    segment_count: narrationSegments.length,
    cited_times: plan.citedTimes,
    generated_clip_requests: plan.generatedClipRequests,
    generated_clips: generatedClips,
    existing_clip_count: existingSegmentSources.length,
    chapters,
  };
  const manifest_url = await writeManifest(outputBase, manifest);
  const record = upsertEntity('SessionReviewVideo', crypto.randomUUID(), {
    title: payload.title || 'Session Review Video',
    session_id: payload.sessionId || session.id || null,
    analysis_title: payload.title || null,
    source_generated_at: payload.sourceGeneratedAt || null,
    file_url: `/uploads/${outputFilename}`,
    filename: outputFilename,
    mimeType: 'video/mp4',
    size: stat.size,
    duration_seconds: Math.round(finalDuration || 0),
    audio_file_url: `/uploads/${audioFilename}`,
    audio_reused: false,
    audio_size: audioStat?.size || null,
    voice: ttsMeta?.voice || payload.voice || 'nova',
    model: ttsMeta?.model || payload.model || null,
    speed: Number(ttsMeta?.speed || payload.speed || 1),
    clip_count: generatedClips.filter((clip) => clip.matched_event).length,
    cited_time_count: plan.citedTimes.length,
    manifest_url,
    render_version: REVIEW_RENDER_VERSION,
    exported_at: new Date().toISOString(),
  });
  const result = {
    ok: true,
    jobId,
    file_url: record.file_url,
    filename: outputFilename,
    size: stat.size,
    duration_seconds: record.duration_seconds,
    audio_file_url: record.audio_file_url,
    audio_reused: false,
    clip_count: record.clip_count,
    cited_time_count: record.cited_time_count,
    manifest_url,
    record,
    render_version: REVIEW_RENDER_VERSION,
  };
  onProgress({
    phase: 'complete',
    current: 5,
    total: 5,
    message: `Review video ready: ${outputFilename}`,
    file_url: result.file_url,
    filename: result.filename,
  });
  return result;
}

export async function renderSessionReviewVideo(payload = {}, options = {}) {
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : () => {};
  const jobId = String(options.jobId || payload.jobId || crypto.randomUUID());
  const paragraphs = (Array.isArray(payload.paragraphs) ? payload.paragraphs : [])
    .map(cleanParagraph)
    .filter(Boolean);
  if (!paragraphs.length) {
    const error = new Error('No analysis paragraphs were provided for the review video.');
    error.status = 400;
    throw error;
  }
  const session = payload.session || {};
  const existingClips = (payload.paragraphMeta || []).flatMap((meta, paragraphIndex) => (
    Array.isArray(meta?.clips) ? meta.clips.map((clip) => ({ ...clip, paragraphIndex })) : []
  ));
  const plan = buildReviewVideoPlan({
    paragraphs,
    paragraphMeta: payload.paragraphMeta || [],
    existingClips,
    session,
  });
  const workDir = path.join(ttsRenderDir, `${Date.now()}-${jobId}-review-video`);

  await fs.mkdir(uploadDir, { recursive: true });
  await fs.mkdir(ttsRenderDir, { recursive: true });
  await fs.mkdir(workDir, { recursive: true });

  try {
    onProgress({ phase: 'planning', current: 0, total: 5, message: 'Planning cited moments and review segments...' });
    const primaryVideo = await choosePrimaryVideo(session, { workDir, onProgress });
    if (primaryVideo?.path) {
      return await renderSegmentedSourceReviewVideo({
        payload,
        session,
        paragraphs,
        plan,
        primaryVideo,
        workDir,
        jobId,
        onProgress,
        signal: options.signal,
      });
    }

    const narration = await resolveNarration(payload, { jobId, signal: options.signal, onProgress });
    if (!narration.audioPath || !(await fileExists(narration.audioPath))) throw new Error('Narration audio file is unavailable.');

    const audioDuration = Number(narration.rendered?.duration_seconds || await mediaDurationSeconds(narration.audioPath).catch(() => 0));
    const chapters = normalizeAudioChapters(
      payload.chapters?.length ? payload.chapters : estimateChapterStarts(paragraphs, audioDuration),
      audioDuration
    );
    const segments = [];
    const clipOutputs = [];

    onProgress({ phase: 'clips', current: 2, total: 5, message: 'Preparing cited moment map...' });
    const existingSegmentSources = [];
    for (const clip of plan.existingClips.slice(0, 24)) {
      const clipPath = uploadPathFromUrl(clip.file_url || clip.url || clip.clip_url);
      if (await fileExists(clipPath)) {
        const normalizedPath = path.join(workDir, `existing-normalized-${String(existingSegmentSources.length + 1).padStart(3, '0')}.mp4`);
        await normalizeVideoSegment({ inputPath: clipPath, outputPath: normalizedPath });
        existingSegmentSources.push({
          path: normalizedPath,
          label: clip.label || 'Saved key clip',
          paragraphIndex: clip.paragraphIndex,
          session_time_s: clipSessionTime(clip),
          durationSeconds: await mediaDurationSeconds(normalizedPath).catch(() => Number(clip.durationSeconds || 8)),
        });
      }
    }

    const clipSources = [...existingSegmentSources];
    clipSources.sort((a, b) => {
      const aTime = Number(a.session_time_s ?? a.startSeconds ?? 0);
      const bTime = Number(b.session_time_s ?? b.startSeconds ?? 0);
      return aTime - bTime;
    });
    const clipByParagraph = new Map();
    clipSources.forEach((clip) => {
      const key = Number.isFinite(Number(clip.paragraphIndex)) ? Number(clip.paragraphIndex) : 0;
      if (!clipByParagraph.has(key)) clipByParagraph.set(key, []);
      clipByParagraph.get(key).push(clip);
    });

    onProgress({ phase: 'segments', current: 3, total: 5, message: primaryVideo?.path ? 'Building narration-aligned cited moment video...' : 'Building review video from saved clips/title cards...' });
    let visualDuration = 0;
    let visualMode = primaryVideo?.path ? 'narration_aligned_cited_moments' : 'narration_aligned_saved_clips_and_cards';
    const paragraphSlots = estimateParagraphSlots(paragraphs, audioDuration);
    const primaryVideoDuration = primaryVideo?.path ? await mediaDurationSeconds(primaryVideo.path).catch(() => 0) : 0;
    const aligned = await buildNarrationAlignedSegments({
      paragraphs,
      paragraphSlots,
      plan,
      primaryVideo,
      sourceDuration: primaryVideoDuration,
      clipByParagraph,
      workDir,
      payloadTitle: payload.title,
      onProgress,
      signal: options.signal,
    });
    segments.push(...aligned.segments);
    clipOutputs.push(...aligned.generatedClips);
    visualDuration = aligned.visualDuration;

    if (!segments.length) {
      if (primaryVideo?.path) {
        const clip = await cutReviewClip({
          sourcePath: primaryVideo.path,
          startSeconds: 0,
          endSeconds: Math.max(6, Math.min(primaryVideoDuration || 20, audioDuration || 8)),
          label: payload.title || 'Session Review',
          workDir,
          index: 0,
          sessionSeconds: 0,
        });
        segments.push(clip.path);
        visualDuration += Number(clip.durationSeconds || 0);
      } else {
        const card = await createTitleCard({
          workDir,
          index: 0,
          title: payload.title || 'Session Review',
          subtitle: 'No cited video clips were available; narration is included.',
          durationSeconds: Math.max(6, Math.min(20, audioDuration || 8)),
        });
        segments.push(card.path);
        visualDuration += Number(card.durationSeconds || 0);
      }
    }

    if (audioDuration && visualDuration < audioDuration - 0.5) {
      const padDuration = Math.max(2, audioDuration - visualDuration + 0.5);
      if (primaryVideo?.path) {
        const sourceStart = Math.max(0, Math.min(Math.max(0, primaryVideoDuration - padDuration), visualDuration % Math.max(1, primaryVideoDuration || visualDuration || 1)));
        const pad = await cutReviewClip({
          sourcePath: primaryVideo.path,
          startSeconds: sourceStart,
          endSeconds: sourceStart + padDuration,
          label: payload.title || 'Session Review',
          workDir,
          index: segments.length + 1,
          sessionSeconds: sourceStart,
        });
        segments.push(pad.path);
        visualDuration += Number(pad.durationSeconds || 0);
      } else {
        const pad = await createTitleCard({
          workDir,
          index: segments.length + 1,
          title: payload.title || 'Session Review',
          subtitle: 'Narration continues.',
          durationSeconds: padDuration,
        });
        segments.push(pad.path);
        visualDuration += Number(pad.durationSeconds || 0);
      }
    }

    const outputBase = `${slugifyFilePart(payload.title || 'session-review-video')}-${Date.now()}`;
    const silentVideoPath = path.join(workDir, 'review-silent.mp4');
    const outputFilename = `${outputBase}.mp4`;
    const outputPath = path.join(uploadDir, outputFilename);
    await concatSegments(segments, silentVideoPath, workDir);

    onProgress({ phase: 'muxing', current: 4, total: 5, message: 'Muxing review video with narration audio...' });
    await muxAudioVideo(silentVideoPath, narration.audioPath, outputPath);
    const stat = await fs.stat(outputPath);
    const finalDuration = await mediaDurationSeconds(outputPath).catch(() => audioDuration);
    const manifest = {
      version: 1,
      render_version: REVIEW_RENDER_VERSION,
      title: payload.title || 'Session Review Video',
      session_id: payload.sessionId || session.id || null,
      generated_at: new Date().toISOString(),
      audio_reused: narration.reused,
      audio_file_url: narration.rendered.file_url,
      visual_mode: visualMode,
      visual_duration_seconds: Math.round(visualDuration),
      source_video_path: primaryVideo?.path || null,
      paragraph_slots: paragraphSlots,
      cited_times: plan.citedTimes,
      generated_clip_requests: plan.generatedClipRequests,
      generated_clips: clipOutputs.map(({ path: _path, ...clip }) => clip),
      existing_clip_count: existingSegmentSources.length,
      chapters,
    };
    const manifest_url = await writeManifest(outputBase, manifest);
    const record = upsertEntity('SessionReviewVideo', crypto.randomUUID(), {
      title: payload.title || 'Session Review Video',
      session_id: payload.sessionId || session.id || null,
      analysis_title: payload.title || null,
      source_generated_at: payload.sourceGeneratedAt || null,
      file_url: `/uploads/${outputFilename}`,
      filename: outputFilename,
      mimeType: 'video/mp4',
      size: stat.size,
      duration_seconds: Math.round(finalDuration || 0),
      audio_file_url: narration.rendered.file_url,
      audio_reused: narration.reused,
      voice: narration.rendered.voice || payload.voice || 'nova',
      model: narration.rendered.model || payload.model || null,
      speed: Number(narration.rendered.speed || payload.speed || 1),
      clip_count: clipSources.length,
      cited_time_count: plan.citedTimes.length,
      manifest_url,
      render_version: REVIEW_RENDER_VERSION,
      exported_at: new Date().toISOString(),
    });

    const result = {
      ok: true,
      jobId,
      file_url: record.file_url,
      filename: outputFilename,
      size: stat.size,
      duration_seconds: record.duration_seconds,
      audio_file_url: record.audio_file_url,
      audio_reused: narration.reused,
      clip_count: record.clip_count,
      cited_time_count: record.cited_time_count,
      manifest_url,
      record,
      render_version: REVIEW_RENDER_VERSION,
    };
    onProgress({
      phase: 'complete',
      current: 5,
      total: 5,
      message: `Review video ready: ${outputFilename}`,
      file_url: result.file_url,
      filename: result.filename,
    });
    return result;
  } finally {
    fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}
