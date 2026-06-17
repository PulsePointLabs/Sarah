import fs from 'node:fs/promises';
import path from 'node:path';
import { uploadDir, ttsRenderDir } from '../config.js';
import { listEntities, upsertEntity } from '../db.js';
import { normalizeAudioChapters } from './audioChapters.js';
import { renderTTSExport } from './ttsRenderer.js';
import { q, runProcess, slugifyFilePart, synthesizeTTSChunk } from './ttsCore.js';
import { buildReviewVideoPlan, extractCitedTimesFromText } from './sessionReviewVideoPlanner.js';

const REVIEW_RENDER_VERSION = 'session_review_video_v11_hd';
const TTS_REQUEST_TAIL = '\u200B';
const REVIEW_VIDEO_WIDTH = Number(process.env.REVIEW_VIDEO_WIDTH || 1920);
const REVIEW_VIDEO_HEIGHT = Number(process.env.REVIEW_VIDEO_HEIGHT || 1080);
const REVIEW_VIDEO_PRESET = process.env.REVIEW_VIDEO_PRESET || 'slow';
const REVIEW_VIDEO_INTERMEDIATE_CRF = String(process.env.REVIEW_VIDEO_INTERMEDIATE_CRF || 14);
const REVIEW_VIDEO_FINAL_CRF = String(process.env.REVIEW_VIDEO_FINAL_CRF || 17);
const REVIEW_VIDEO_CARD_CRF = String(process.env.REVIEW_VIDEO_CARD_CRF || 17);
const REVIEW_VIDEO_TRANSITION_SECONDS = Math.max(0, Math.min(0.6, Number(process.env.REVIEW_VIDEO_TRANSITION_SECONDS || 0.22)));
const REVIEW_VIDEO_SPOKEN_TIME_LEAD_SECONDS = Math.max(0, Math.min(1.5, Number(process.env.REVIEW_VIDEO_SPOKEN_TIME_LEAD_SECONDS || 0.25)));
const REVIEW_VIDEO_TIME_TOLERANCE_SECONDS = Math.max(0, Math.min(30, Number(process.env.REVIEW_VIDEO_TIME_TOLERANCE_SECONDS || 8)));

function reviewVideoFitFilter() {
  return [
    `scale=${REVIEW_VIDEO_WIDTH}:${REVIEW_VIDEO_HEIGHT}:force_original_aspect_ratio=decrease:flags=lanczos`,
    `pad=${REVIEW_VIDEO_WIDTH}:${REVIEW_VIDEO_HEIGHT}:(ow-iw)/2:(oh-ih)/2`,
  ].join(',');
}

function segmentFadeFilters(durationSeconds = 0, { fadeIn = true, fadeOut = true } = {}) {
  const duration = Number(durationSeconds || 0);
  const fade = Math.min(REVIEW_VIDEO_TRANSITION_SECONDS, Math.max(0, (duration - 0.35) / 2));
  if (!fade) return [];
  return [
    fadeIn ? `fade=t=in:st=0:d=${fade.toFixed(3)}` : null,
    fadeOut ? `fade=t=out:st=${Math.max(0, duration - fade).toFixed(3)}:d=${fade.toFixed(3)}` : null,
  ].filter(Boolean);
}

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
  const offset = Number(video.timelineOffsetSeconds ?? video.timeline_offset_s ?? video.offset_seconds ?? video.session_time_offset_s ?? 0);
  return Math.max(0, Number(sessionTime || 0) - (Number.isFinite(offset) ? offset : 0));
}

function formatTimestamp(seconds = 0) {
  const totalSeconds = Math.max(0, Math.floor(Number(seconds || 0)));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const secs = totalSeconds % 60;
  if (hours) return `${hours}:${String(minutes).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  return `${minutes}:${String(secs).padStart(2, '0')}`;
}

function roundedSeconds(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(number * 10) / 10 : null;
}

function timestampRequirementForSegment(segment = {}) {
  const times = extractCitedTimesFromText(segment?.text || '', segment?.paragraphIndex)
    .filter((time) => Number.isFinite(Number(time.seconds)))
    .sort((a, b) => Number(a.charIndex ?? 0) - Number(b.charIndex ?? 0));
  return {
    required: times.length > 0,
    times,
    primary: times[0] || null,
  };
}

function nearestNarratedTime(segment = {}, selectedSessionSeconds = null) {
  const requirement = timestampRequirementForSegment(segment);
  if (!requirement.times.length) return null;
  const selected = Number(selectedSessionSeconds);
  if (!Number.isFinite(selected)) return requirement.primary;
  return requirement.times
    .map((time) => ({
      ...time,
      distance: Math.abs(Number(time.seconds) - selected),
    }))
    .sort((a, b) => a.distance - b.distance)[0] || requirement.primary;
}

function canRenderSessionTimeFromPrimary({ sessionSeconds, primaryVideo, sourceDuration }) {
  const sessionTime = Number(sessionSeconds);
  if (!Number.isFinite(sessionTime) || !primaryVideo?.path) return false;
  const sourceTime = sourceTimeForSession(sessionTime, primaryVideo);
  const duration = Number(sourceDuration || 0);
  return duration <= 0 || sourceTime <= duration + REVIEW_VIDEO_TIME_TOLERANCE_SECONDS;
}

function buildTimelineTrace({
  segment,
  event = null,
  window = null,
  audio = null,
  selectionReason = '',
  fallbackUsed = false,
  fallbackType = null,
  visualSource = 'unknown',
  violation = null,
} = {}) {
  const narrated = nearestNarratedTime(segment, event?.session_time_s ?? window?.sessionSeconds);
  const selectedSessionSeconds = Number(event?.session_time_s ?? window?.sessionSeconds);
  const narratedSeconds = Number(narrated?.seconds);
  const hasNarrated = Number.isFinite(narratedSeconds);
  const hasSelected = Number.isFinite(selectedSessionSeconds);
  const delta = hasNarrated && hasSelected ? Math.abs(narratedSeconds - selectedSessionSeconds) : null;
  return {
    narration_section: Number.isFinite(Number(segment?.paragraphIndex)) ? Number(segment.paragraphIndex) : null,
    spoken_segment_index: null,
    narrated_timestamp_s: hasNarrated ? roundedSeconds(narratedSeconds) : null,
    narrated_timestamp: hasNarrated ? formatTimestamp(narratedSeconds) : null,
    narrated_text: narrated?.text || null,
    selected_visual_timestamp_s: hasSelected ? roundedSeconds(selectedSessionSeconds) : null,
    selected_visual_timestamp: hasSelected ? formatTimestamp(selectedSessionSeconds) : null,
    delta_seconds: delta === null ? null : roundedSeconds(delta),
    selection_reason: selectionReason,
    fallback_used: Boolean(fallbackUsed),
    fallback_type: fallbackType,
    visual_source: visualSource,
    timestamp_required: hasNarrated,
    within_tolerance: delta === null ? null : delta <= REVIEW_VIDEO_TIME_TOLERANCE_SECONDS,
    tolerance_seconds: REVIEW_VIDEO_TIME_TOLERANCE_SECONDS,
    source_start_s: roundedSeconds(window?.start),
    source_end_s: roundedSeconds(window?.end),
    audio_duration_seconds: roundedSeconds(audio?.durationSeconds),
    violation,
  };
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

function timestampOverlayFilter({ startSeconds = 0, sessionSeconds = null, playbackRate = 1, outputDurationSeconds = 0 } = {}) {
  const fontPath = process.env.REVIEW_VIDEO_FONT || 'C\\:/Windows/Fonts/arial.ttf';
  const sourceLabel = `source ${formatTimestamp(startSeconds)}`;
  const sessionLabel = Number.isFinite(Number(sessionSeconds))
    ? `session ${formatTimestamp(sessionSeconds)}`
    : '';
  const rate = Number(playbackRate);
  const slowMoLabel = Number.isFinite(rate) && rate > 0 && rate < 0.99 ? `${Math.round(rate * 100)}% speed` : '';
  const text = drawTextSafe([sessionLabel, sourceLabel, slowMoLabel].filter(Boolean).join('  |  '));
  return [
    reviewVideoFitFilter(),
    'format=yuv420p',
    Number.isFinite(rate) && rate > 0 && rate < 0.99 ? `setpts=${(1 / rate).toFixed(4)}*PTS` : null,
    `drawtext=fontfile='${fontPath}':text='${text}':x=36:y=h-78:fontsize=34:fontcolor=white:box=1:boxcolor=black@0.68:boxborderw=12`,
    ...segmentFadeFilters(outputDurationSeconds),
  ].filter(Boolean).join(',');
}

async function cutReviewClip({ sourcePath, startSeconds, endSeconds, label, workDir, index, sessionSeconds = null, playbackRate = 1 }) {
  const duration = Math.max(0.25, Math.min(180, Number(endSeconds || 0) - Number(startSeconds || 0)));
  const rate = Number(playbackRate);
  const outputDuration = Number.isFinite(rate) && rate > 0 && rate < 0.99 ? duration / rate : duration;
  const output = path.join(workDir, `segment-source-${String(index).padStart(3, '0')}.mp4`);
  await runProcess('ffmpeg', [
    '-hide_banner',
    '-y',
    '-ss', String(Math.max(0, Number(startSeconds || 0))),
    '-t', String(duration),
    '-i', sourcePath,
    '-map', '0:v:0',
    '-an',
    '-vf', timestampOverlayFilter({ startSeconds, sessionSeconds, playbackRate, outputDurationSeconds: outputDuration }),
    '-c:v', 'libx264',
    '-preset', REVIEW_VIDEO_PRESET,
    '-crf', REVIEW_VIDEO_INTERMEDIATE_CRF,
    '-profile:v', 'high',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
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
  const duration = Math.max(2, Number(durationSeconds || 3));
  const draw = [
    `drawtext=fontfile='${fontPath}':text='${heading}':fontcolor=white:fontsize=42:x=(w-text_w)/2:y=(h/2)-70`,
    body ? `drawtext=fontfile='${fontPath}':text='${body}':fontcolor=white@0.78:fontsize=24:x=(w-text_w)/2:y=(h/2)+8` : null,
    ...segmentFadeFilters(duration),
  ].filter(Boolean).join(',');
  await runProcess('ffmpeg', [
    '-hide_banner',
    '-y',
    '-f', 'lavfi',
    '-i', `color=c=#101418:s=${REVIEW_VIDEO_WIDTH}x${REVIEW_VIDEO_HEIGHT}:d=${duration}`,
    '-vf', draw,
    '-c:v', 'libx264',
    '-preset', REVIEW_VIDEO_PRESET,
    '-crf', REVIEW_VIDEO_CARD_CRF,
    '-profile:v', 'high',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
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
  const sourceDuration = Number(durationSeconds || await mediaDurationSeconds(inputPath).catch(() => 0));
  const fadeFilters = segmentFadeFilters(sourceDuration);
  await runProcess('ffmpeg', [
    '-hide_banner',
    '-y',
    '-i', inputPath,
    ...durationArgs,
    '-map', '0:v:0',
    '-an',
    '-vf', [reviewVideoFitFilter(), 'format=yuv420p', ...fadeFilters].join(','),
    '-c:v', 'libx264',
    '-preset', REVIEW_VIDEO_PRESET,
    '-crf', REVIEW_VIDEO_INTERMEDIATE_CRF,
    '-profile:v', 'high',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
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
    '-preset', REVIEW_VIDEO_PRESET,
    '-crf', REVIEW_VIDEO_FINAL_CRF,
    '-profile:v', 'high',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
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
    '-preset', REVIEW_VIDEO_PRESET,
    '-crf', REVIEW_VIDEO_FINAL_CRF,
    '-profile:v', 'high',
    '-pix_fmt', 'yuv420p',
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

async function concatWavSegments(audioPaths, outputPath, workDir) {
  const concatPath = path.join(workDir, 'audio-wav-segments.txt');
  await fs.writeFile(concatPath, audioPaths.map((file) => `file ${q(file.replace(/\\/g, '/'))}`).join('\n'), 'utf8');
  await runProcess('ffmpeg', [
    '-hide_banner',
    '-y',
    '-f', 'concat',
    '-safe', '0',
    '-i', concatPath,
    '-vn',
    '-af', 'aresample=48000:async=1:first_pts=0,aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=stereo',
    '-c:a', 'pcm_s16le',
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
    spoken_char_index: time.charIndex,
    spoken_time_source: time.source,
    label: time.text ? `Referenced ${time.text}` : 'Referenced moment',
    reason: 'Explicitly referenced in spoken segment',
    startSeconds: Math.max(0, time.seconds - 3),
    endSeconds: time.seconds + 14,
    source: 'spoken_segment_time',
    direct_spoken_time: true,
    force_direct_cut: true,
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
  if (explicitTimes.length) {
    const explicitCandidate = candidates
      .filter((event) => event.source === 'spoken_segment_time')
      .map((event) => {
        const sessionTime = Number(event.session_time_s);
        const closest = explicitTimes.reduce((best, time) => {
          const distance = Math.abs(Number(time.seconds) - sessionTime);
          return !best || distance < best.distance ? { distance } : best;
        }, null);
        return {
          event,
          id: String(event.id || `${event.label}:${event.session_time_s}`),
          distance: closest?.distance ?? Number.POSITIVE_INFINITY,
        };
      })
      .sort((a, b) => a.distance - b.distance)[0];
    if (explicitCandidate) {
      usedEventIds.add(explicitCandidate.id);
      return explicitCandidate.event;
    }
  }
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

function closestSpokenTimeInSegment(segment = {}, event = {}) {
  const eventTime = Number(event?.session_time_s);
  if (!Number.isFinite(eventTime)) return null;
  const times = extractCitedTimesFromText(segment?.text || '', segment?.paragraphIndex);
  if (!times.length) return null;
  return times
    .map((time) => ({
      ...time,
      distance: Math.abs(Number(time.seconds) - eventTime),
    }))
    .filter((time) => Number.isFinite(time.distance))
    .sort((a, b) => a.distance - b.distance)[0] || null;
}

function estimateSpokenAnchorOffsetSeconds({ segment, event, audioDuration }) {
  const duration = Math.max(0, Number(audioDuration || 0));
  if (!duration) return 0;
  const text = String(segment?.text || '');
  const directIndex = Number(event?.spoken_char_index);
  const nearest = closestSpokenTimeInSegment(segment, event);
  const charIndex = Number.isFinite(directIndex) ? directIndex : Number(nearest?.charIndex);
  if (!Number.isFinite(charIndex) || charIndex <= 0 || !text.trim()) return 0;
  const beforeWords = wordCount(text.slice(0, Math.max(0, Math.min(text.length, charIndex))));
  const totalWords = Math.max(1, wordCount(text));
  const ratio = Math.max(0, Math.min(0.92, beforeWords / totalWords));
  return Math.max(0, Math.min(Math.max(0, duration - 0.35), duration * ratio));
}

function isClimaxReviewSegment(segment = {}, event = {}) {
  return /\b(climax|ejaculat|orgasm|semen|fluid release|release of semen|emission|expulsion)\b/i.test(`${segment.text || ''} ${eventText(event)}`);
}

function isBodyExplorationReview(payload = {}, session = {}) {
  const text = [
    payload.recordType,
    payload.record_type,
    payload.source,
    payload.title,
    session.recordType,
    session.record_type,
    session.exploration_type,
    session.devices,
  ].filter(Boolean).join(' ').toLowerCase();
  return /\b(body[_\s-]?exploration|foley|catheter|instrumentation|urethral|sounding|dilation)\b/.test(text);
}

function procedureBrollScore(event = {}, segmentText = '') {
  const text = eventText(event);
  const segment = String(segmentText || '').toLowerCase();
  let score = 0;
  const positive = [
    [/\b(table|supine|positioning|setup|tray|field|drape|underpad)\b/, 34],
    [/\b(glove|gloved|sterile|prep|swab|swabbing|iodine|povidone|antiseptic|gauze|wipe|applicator)\b/, 58],
    [/\b(lubric|lube|gel|syringe|instill|dilat|dilation)\b/, 62],
    [/\b(foley|catheter|urethral|meatus|meatal|glans|penis|foreskin|shaft|scrotum)\b/, 72],
    [/\b(advance|advancement|insert|insertion|sphincter|prostatic|bladder|urine|balloon|traction|seat|seated|drainage|bag|tubing)\b/, 82],
    [/\b(comfort|discomfort|resistance|relax|relaxed|tension|bracing|leg|foot|toe)\b/, 24],
  ];
  const negative = [
    [/\b(walk|walking|wander|wandering|around the room|room walk|butt|ass|rear|standing up|stood up|exit|exited|leaving|left the table)\b/, 160],
    [/\boff[-\s]?camera\b/, 120],
    [/\bstatlock\b.*\boff[-\s]?camera\b/, 180],
    [/\bcamera (?:moved|shifted|repositioned)\b|\bcleanup only\b/, 65],
  ];
  for (const [pattern, value] of positive) {
    if (pattern.test(text)) score += value;
    if (pattern.test(text) && pattern.test(segment)) score += Math.round(value * 0.8);
  }
  for (const [pattern, value] of negative) {
    if (pattern.test(text)) score -= value;
  }
  const eventTime = Number(event.session_time_s ?? event.time_s);
  if (Number.isFinite(eventTime) && eventTime < 20) score += 10;
  return score;
}

function procedureBrollTopic(event = {}) {
  const text = eventText(event);
  if (/\b(balloon|inflation|inflate|syringe|port|bypass|leak|escaped|escaping|troubleshoot|issue|problem|fumble)\b/.test(text)) return 'balloon_troubleshooting';
  if (/\b(swab|swabbing|iodine|povidone|antiseptic|prep|gauze|wipe|applicator)\b/.test(text)) return 'prep_swab';
  if (/\b(lubric|lube|gel)\b/.test(text)) return 'lubrication';
  if (/\b(meatus|meatal|insert|insertion|advance|advancement|urethral|sphincter|prostatic|bladder entry)\b/.test(text)) return 'insertion_passage';
  if (/\b(drape|field|table|supine|position|setup|tray|underpad)\b/.test(text)) return 'setup_positioning';
  if (/\b(traction|seat|seated|drainage|bag|urine|tubing)\b/.test(text)) return 'drainage_seating';
  if (/\b(remove|cleanup|clean up|glove removal|exit|statlock)\b/.test(text)) return 'cleanup';
  return 'general';
}

function segmentWantsBrollTopic(segmentText = '', topic = '') {
  const segment = String(segmentText || '').toLowerCase();
  if (topic === 'balloon_troubleshooting') return /\b(balloon|inflation|inflate|syringe|port|bypass|leak|escaped|escaping|troubleshoot|issue|problem)\b/.test(segment);
  if (topic === 'prep_swab') return /\b(swab|swabbing|iodine|povidone|antiseptic|prep|gauze|wipe|applicator)\b/.test(segment);
  if (topic === 'lubrication') return /\b(lubric|lube|gel)\b/.test(segment);
  if (topic === 'insertion_passage') return /\b(meatus|meatal|insert|insertion|advance|advancement|urethral|sphincter|prostatic|bladder)\b/.test(segment);
  if (topic === 'setup_positioning') return /\b(drape|field|table|supine|position|setup|tray|underpad)\b/.test(segment);
  if (topic === 'drainage_seating') return /\b(traction|seat|seated|drainage|bag|urine|tubing)\b/.test(segment);
  if (topic === 'cleanup') return /\b(remove|cleanup|clean up|exit|statlock|securement)\b/.test(segment);
  return false;
}

function procedureBrollRepetitionPenalty(event = {}, segmentText = '', usage = {}) {
  const time = Number(event.session_time_s ?? event.time_s);
  const topic = procedureBrollTopic(event);
  let penalty = 0;
  const usedTimes = Array.isArray(usage.usedTimes) ? usage.usedTimes : [];
  const closeUses = usedTimes.filter((usedTime) => Number.isFinite(time) && Math.abs(Number(usedTime) - time) <= 22).length;
  if (closeUses) penalty += 95 * closeUses;
  const veryCloseUses = usedTimes.filter((usedTime) => Number.isFinite(time) && Math.abs(Number(usedTime) - time) <= 8).length;
  if (veryCloseUses) penalty += 180 * veryCloseUses;
  const topicCount = Number(usage.topicCounts?.[topic] || 0);
  if (topicCount) penalty += topicCount * (topic === 'balloon_troubleshooting' ? 150 : 58);
  if (topic === 'balloon_troubleshooting' && !segmentWantsBrollTopic(segmentText, topic)) penalty += 170;
  if (topic === 'cleanup' && !segmentWantsBrollTopic(segmentText, topic)) penalty += 95;
  return penalty;
}

function markProcedureBrollUsed(event = {}, usage = {}) {
  const time = Number(event.session_time_s ?? event.time_s);
  if (!Array.isArray(usage.usedTimes)) usage.usedTimes = [];
  if (!usage.topicCounts || typeof usage.topicCounts !== 'object') usage.topicCounts = {};
  if (Number.isFinite(time)) usage.usedTimes.push(time);
  const topic = procedureBrollTopic(event);
  usage.topicCounts[topic] = Number(usage.topicCounts[topic] || 0) + 1;
  return usage;
}

function bodyExplorationBrollEvents(session = {}) {
  const events = Array.isArray(session.event_timeline) ? session.event_timeline : [];
  return events
    .map((event, index) => ({
      id: event?.id || `procedure-broll-${index + 1}`,
      label: event?.note || `Procedure context ${index + 1}`,
      reason: 'Procedure-safe B-roll from timestamped body exploration notes',
      note: event?.note || '',
      category: Array.isArray(event?.category) ? event.category.join(' ') : event?.category || '',
      tags: Array.isArray(event?.annotation_tags) ? event.annotation_tags.join(' ') : event?.annotation_tags || '',
      source: 'procedure_broll_event',
      session_time_s: Number(event?.time_s),
    }))
    .filter((event) => Number.isFinite(Number(event.session_time_s)));
}

function chooseProcedureBrollEvent({ segment, session, usedEventIds, usage }) {
  const candidates = bodyExplorationBrollEvents(session)
    .map((event) => {
      const id = String(event.id || `${event.label}:${event.session_time_s}`);
      const reusePenalty = usedEventIds.has(id) ? 220 : 0;
      const repetitionPenalty = procedureBrollRepetitionPenalty(event, segment?.text, usage);
      return {
        event,
        id,
        score: procedureBrollScore(event, segment?.text) - reusePenalty - repetitionPenalty,
      };
    })
    .filter(({ score }) => score >= 35)
    .sort((a, b) => b.score - a.score || Number(a.event.session_time_s) - Number(b.event.session_time_s));
  if (!candidates.length) return null;
  const chosen = candidates[0];
  usedEventIds.add(chosen.id);
  markProcedureBrollUsed(chosen.event, usage);
  return {
    ...chosen.event,
    label: chosen.event.label || 'Procedure context',
    reason: chosen.event.reason,
    _broll_score: chosen.score,
  };
}

function sourceWindowForSegment({ event, segment, audioDuration, primaryVideo, sourceDuration, fallbackCursor }) {
  const duration = Math.max(1.25, Number(audioDuration || 1) + 1.25);
  if (event) {
    const sessionTime = Number(event.session_time_s);
    const directSpokenTime = event.source === 'spoken_segment_time' || event.force_direct_cut || event.direct_spoken_time;
    const sourceCenter = sourceTimeForSession(sessionTime, primaryVideo);
    const requestedStart = Number(event.startSeconds);
    const offset = sourceCenter - sessionTime;
    const wantsClimax = isClimaxReviewSegment(segment, event);
    const playbackRate = wantsClimax ? 0.5 : 1;
    const sourceSliceDuration = playbackRate < 1 ? Math.max(2.5, duration * playbackRate) : duration;
    const spokenAnchorOffset = directSpokenTime
      ? estimateSpokenAnchorOffsetSeconds({ segment, event, audioDuration })
      : 0;
    const preroll = directSpokenTime
      ? (spokenAnchorOffset + REVIEW_VIDEO_SPOKEN_TIME_LEAD_SECONDS) * playbackRate
      : wantsClimax
      ? Math.min(3, sourceSliceDuration * 0.4)
      : 2.5;
    const rawStart = directSpokenTime
      ? sourceCenter - preroll
      : wantsClimax
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
      directSpokenTime,
      spokenAnchorOffset,
      spokenTimeLeadSeconds: REVIEW_VIDEO_SPOKEN_TIME_LEAD_SECONDS,
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
  const rawAudioPath = path.join(workDir, `segment-audio-${String(index + 1).padStart(3, '0')}-raw.wav`);
  await fs.writeFile(rawAudioPath, rendered.buffer);
  const rawDuration = await mediaDurationSeconds(rawAudioPath).catch(() => Math.max(1, wordCount(segment.text) / 2.25));
  const audioPath = path.join(workDir, `segment-audio-${String(index + 1).padStart(3, '0')}.wav`);
  const fade = Math.min(0.018, Math.max(0, (Number(rawDuration || 0) - 0.12) / 2));
  const filters = [
    'aresample=48000:async=1:first_pts=0',
    'aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=stereo',
    fade ? `afade=t=in:st=0:d=${fade.toFixed(3)}` : null,
    fade ? `afade=t=out:st=${Math.max(0, rawDuration - fade).toFixed(3)}:d=${fade.toFixed(3)}` : null,
  ].filter(Boolean).join(',');
  await runProcess('ffmpeg', [
    '-hide_banner',
    '-y',
    '-i', rawAudioPath,
    '-af', filters,
    '-c:a', 'pcm_s16le',
    audioPath,
  ]);
  const duration = await mediaDurationSeconds(audioPath).catch(() => rawDuration);
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
  const procedureBrollUsage = { usedTimes: [], topicCounts: {} };
  const avSegments = [];
  const videoSegments = [];
  const audioSegments = [];
  const generatedClips = [];
  const bodyExplorationMode = isBodyExplorationReview(payload, session);
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

    const timestampRequirement = timestampRequirementForSegment(segment);
    const matchedEvent = chooseSegmentEvent({ segment, plan, clipByParagraph, usedEventIds });
    const event = matchedEvent || (!timestampRequirement.required && bodyExplorationMode
      ? chooseProcedureBrollEvent({ segment, session, usedEventIds, usage: procedureBrollUsage })
      : null);
    const eventRenderable = event
      ? canRenderSessionTimeFromPrimary({
        sessionSeconds: event.session_time_s,
        primaryVideo,
        sourceDuration,
      })
      : false;
    const nearestTime = nearestNarratedTime(segment, event?.session_time_s);
    const narratedDelta = nearestTime && event
      ? Math.abs(Number(nearestTime.seconds) - Number(event.session_time_s))
      : null;
    const timestampViolation = timestampRequirement.required && (
      !event
      || !eventRenderable
      || (Number.isFinite(narratedDelta) && narratedDelta > REVIEW_VIDEO_TIME_TOLERANCE_SECONDS)
    );

    if (timestampViolation) {
      const narratedLabel = timestampRequirement.primary
        ? formatTimestamp(timestampRequirement.primary.seconds)
        : 'the referenced moment';
      const reason = !event
        ? 'No time-matched event or source frame was available for this timed narration segment.'
        : !eventRenderable
        ? `Referenced ${narratedLabel}, but that moment is outside the available source video range.`
        : `Referenced ${narratedLabel}, but the nearest selected visual was ${formatTimestamp(event.session_time_s)}.`;
      onProgress?.({
        phase: 'segments',
        current: 3,
        total: 5,
        message: `No aligned visual for ${narratedLabel}; using a neutral card...`,
      });
      const card = await createTitleCard({
        workDir,
        index: index + 1,
        title: 'No Time-Matched Visual',
        subtitle: reason,
        durationSeconds: audio.durationSeconds,
      });
      videoSegments.push(card.path);
      const trace = buildTimelineTrace({
        segment,
        event: event || null,
        window: null,
        audio,
        selectionReason: reason,
        fallbackUsed: true,
        fallbackType: 'neutral_card_no_time_match',
        visualSource: 'neutral_card',
        violation: 'TIMESTAMP_VISUAL_MISMATCH_PREVENTED',
      });
      generatedClips.push({
        id: event?.id || `neutral-card-${index + 1}`,
        paragraphIndex: segment.paragraphIndex,
        session_time_s: event ? roundedSeconds(event.session_time_s) : null,
        spoken_segment_index: index + 1,
        spoken_text: segment.text.slice(0, 240),
        label: 'No time-matched visual',
        reason,
        source_video_path: primaryVideo.path,
        audio_duration_seconds: roundedSeconds(audio.durationSeconds),
        playback_rate: 1,
        slow_motion: false,
        direct_spoken_time: false,
        source_time_strategy: 'neutral_card_required_by_timeline_validation',
        matched_event: Boolean(matchedEvent),
        procedural_broll: false,
        timeline_trace: { ...trace, spoken_segment_index: index + 1 },
      });
      previousText = previousText ? `${previousText} ${segment.text}` : segment.text;
      continue;
    }

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
    videoSegments.push(videoClip.path);
    const avPath = path.join(workDir, `segment-av-${String(index + 1).padStart(3, '0')}.mp4`);
    await muxAudioVideo(videoClip.path, audio.audioPath, avPath);
    avSegments.push(avPath);
    fallbackCursor = clampClipStart(window.start + Number(audio.durationSeconds || 1), Number(audio.durationSeconds || 1), sourceDuration);
    const selectionReason = event?.reason || (bodyExplorationMode && !matchedEvent && event
      ? 'No exact event matched this untimed spoken segment; using procedure-safe timestamped B-roll.'
      : !matchedEvent && !event
      ? 'No exact event matched this untimed spoken segment; using continuous source video context.'
      : 'Matched narration segment to timestamped source video.');
    const timelineTrace = buildTimelineTrace({
      segment,
      event,
      window,
      audio,
      selectionReason,
      fallbackUsed: !matchedEvent,
      fallbackType: !matchedEvent
        ? event
          ? 'procedure_broll'
          : 'continuous_source_context'
        : null,
      visualSource: matchedEvent
        ? event?.source === 'spoken_segment_time'
          ? 'explicit_spoken_timestamp'
          : 'matched_event'
        : event
        ? 'procedure_broll'
        : 'continuous_source_context',
    });
    generatedClips.push({
      id: event?.id || `context-${index + 1}`,
      paragraphIndex: segment.paragraphIndex,
      session_time_s: event ? Number(event.session_time_s) : Math.round(window.sessionSeconds * 10) / 10,
      source_start_s: Math.round(window.start * 10) / 10,
      source_end_s: Math.round(window.end * 10) / 10,
      spoken_segment_index: index + 1,
      spoken_text: segment.text.slice(0, 240),
      label: window.label,
      reason: selectionReason,
      source_video_path: primaryVideo.path,
      audio_duration_seconds: Math.round(Number(audio.durationSeconds || 0) * 10) / 10,
      playback_rate: Number(window.playbackRate || 1),
      slow_motion: Boolean(window.slowMotion),
      direct_spoken_time: Boolean(window.directSpokenTime),
      spoken_anchor_offset_seconds: Math.round(Number(window.spokenAnchorOffset || 0) * 10) / 10,
      spoken_time_lead_seconds: Math.round(Number(window.spokenTimeLeadSeconds || 0) * 10) / 10,
      source_time_strategy: window.directSpokenTime ? 'spoken_time_phrase_aligned_to_source' : 'session_offset_or_event',
      matched_event: Boolean(matchedEvent),
      procedural_broll: Boolean(!matchedEvent && event),
      procedural_broll_score: event?._broll_score ?? null,
      timeline_trace: { ...timelineTrace, spoken_segment_index: index + 1 },
    });
    previousText = previousText ? `${previousText} ${segment.text}` : segment.text;
  }

  const outputBase = `${slugifyFilePart(payload.title || 'session-review-video')}-${Date.now()}`;
  const outputFilename = `${outputBase}.mp4`;
  const outputPath = path.join(uploadDir, outputFilename);
  const audioFilename = `${outputBase}.mp3`;
  const audioOutputPath = path.join(uploadDir, audioFilename);
  const silentVideoPath = path.join(workDir, 'review-video-continuous-video.mp4');
  const continuousWavPath = path.join(workDir, 'review-video-continuous-audio.wav');

  onProgress({ phase: 'muxing', current: 4, total: 5, message: 'Concatenating aligned video and smoothing narration audio...' });
  await concatSegments(videoSegments.length ? videoSegments : avSegments, silentVideoPath, workDir);
  await concatWavSegments(audioSegments, continuousWavPath, workDir);
  await muxAudioVideo(silentVideoPath, continuousWavPath, outputPath);
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
    timeline_trace: generatedClips.map((clip) => clip.timeline_trace || null).filter(Boolean),
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
    timeline_trace: generatedClips.map((clip) => clip.timeline_trace || null).filter(Boolean),
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
      timeline_trace: clipOutputs
        .map((clip) => clip.timeline_trace || null)
        .filter(Boolean),
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
      timeline_trace: clipOutputs
        .map((clip) => clip.timeline_trace || null)
        .filter(Boolean),
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
