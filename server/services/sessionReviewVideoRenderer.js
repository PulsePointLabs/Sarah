import fs from 'node:fs/promises';
import path from 'node:path';
import { resolveUploadPath, uploadDir, ttsRenderDir } from '../config.js';
import { listEntities, upsertEntity } from '../db.js';
import { normalizeAudioChapters } from './audioChapters.js';
import { renderTTSExport } from './ttsRenderer.js';
import { q, runProcess, slugifyFilePart } from './ttsCore.js';
import { buildLoggedEventAnchors, buildReviewVideoPlan, extractCitedTimesFromText } from './sessionReviewVideoPlanner.js';
import { normalizeWatermarkSettings, replaceVideoWithWatermarkedExport } from './watermark.js';

const REVIEW_RENDER_VERSION = 'session_review_video_v16_semantic_bounded_motion';
const REVIEW_VIDEO_WIDTH = Number(process.env.REVIEW_VIDEO_WIDTH || 1920);
const REVIEW_VIDEO_HEIGHT = Number(process.env.REVIEW_VIDEO_HEIGHT || 1080);
const REVIEW_VIDEO_PRESET = process.env.REVIEW_VIDEO_PRESET || 'slow';
const REVIEW_VIDEO_INTERMEDIATE_CRF = String(process.env.REVIEW_VIDEO_INTERMEDIATE_CRF || 14);
const REVIEW_VIDEO_FINAL_CRF = String(process.env.REVIEW_VIDEO_FINAL_CRF || 17);
const REVIEW_VIDEO_FINAL_THREADS = Math.max(1, Math.min(16, Number(process.env.REVIEW_VIDEO_FINAL_THREADS || 4)));
const REVIEW_VIDEO_CARD_CRF = String(process.env.REVIEW_VIDEO_CARD_CRF || 17);
const REVIEW_VIDEO_TRANSITION_SECONDS = Math.max(0, Math.min(0.6, Number(process.env.REVIEW_VIDEO_TRANSITION_SECONDS || 0.22)));
const REVIEW_VIDEO_SPOKEN_TIME_LEAD_SECONDS = Math.max(0, Math.min(1.5, Number(process.env.REVIEW_VIDEO_SPOKEN_TIME_LEAD_SECONDS || 0.25)));
const REVIEW_VIDEO_TIME_TOLERANCE_SECONDS = Math.max(0, Math.min(30, Number(process.env.REVIEW_VIDEO_TIME_TOLERANCE_SECONDS || 8)));
const REVIEW_VIDEO_MIN_GENERIC_BROLL_GAP_SECONDS = Math.max(6, Number(process.env.REVIEW_VIDEO_MIN_GENERIC_BROLL_GAP_SECONDS || 18));
const REVIEW_VIDEO_GENERIC_BROLL_SEARCH_STEPS = Math.max(3, Number(process.env.REVIEW_VIDEO_GENERIC_BROLL_SEARCH_STEPS || 8));
const REVIEW_VIDEO_MIN_ACTIVITY_FRAMES = Math.max(4, Number(process.env.REVIEW_VIDEO_MIN_ACTIVITY_FRAMES || 20));

function friendlyReviewVideoRenderError(error) {
  const message = String(error?.message || error || '');
  if (/no space left on device/i.test(message)) {
    return new Error('Sarah ran out of free disk space while building temporary review-video segments in data/tts-render-work. Free up space on drive C, then try the produced video again.');
  }
  return error instanceof Error ? error : new Error(message || 'Review video render failed.');
}

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
  const filename = decodeURIComponent(raw.replace(/^\/uploads\//, ''));
  return resolveUploadPath(filename);
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

export function matchAudioExport(record, request) {
  if (!record?.file_url) return false;
  if (record.render_version !== 'tts_export_leading_trim_v2') return false;
  if (String(record.tts_session_key || '') !== String(request.sessionId || '')) return false;
  if (String(record.source_generated_at || '') !== String(request.sourceGeneratedAt || '')) return false;
  if (String(record.review_type || '') && String(record.review_type || '') !== String(request.reviewType || '')) return false;
  // Older exports predate review_type. Exact session + source timestamp is the stable identity;
  // display-title punctuation and date formatting are not.
  if (!String(record.review_type || '') && !String(request.sourceGeneratedAt || '')
    && String(record.analysis_title || record.title || '') !== String(request.title || '')) return false;
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
  if (String(job?.meta?.reviewType || '') && String(job?.meta?.reviewType || '') !== String(request.reviewType || '')) return false;
  if (!String(job?.meta?.reviewType || '') && !String(request.sourceGeneratedAt || '')
    && String(job?.meta?.title || result.analysis_title || result.title || '') !== String(request.title || '')) return false;
  if (String(result.voice || 'nova') !== String(request.voice || 'nova')) return false;
  if (String(result.model || '') !== String(request.model || '')) return false;
  if (String(result.format || 'mp3') !== String(request.outputFormat || 'mp3')) return false;
  return Math.abs(Number(result.speed || 1) - Number(request.speed || 1)) < 0.005;
}

async function resolveNarration(payload, { jobId, signal, onProgress }) {
  const request = {
    sessionId: payload.sessionId,
    title: payload.title || 'Session Review Video',
    reviewType: payload.reviewType || null,
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
    feature: 'session_review_video_narration',
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
    review_type: request.reviewType || null,
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

export async function chooseFeetVideo(session = {}, primaryVideo = {}) {
  const primaryPath = path.resolve(String(primaryVideo?.path || '')).toLowerCase();
  for (const video of rankedVideoCandidates(session)) {
    const videoPath = path.resolve(String(video?.path || '')).toLowerCase();
    const text = `${video?.label || ''} ${video?.role || ''} ${video?.camera_angle || ''} ${video?.filename || ''} ${path.basename(videoPath)}`.toLowerCase();
    if (!videoPath || videoPath === primaryPath) continue;
    if (!/(?:feet|foot|toe|heel|sole|ankle|leg|lower[-_\s]?body|footcam)/.test(text)) continue;
    if (!(await fileExists(video.path))) continue;
    return {
      ...video,
      role: 'feet',
      _review_duration: await mediaDurationSeconds(video.path).catch(() => Number(video.durationSeconds || 0)),
    };
  }
  return null;
}

function sourceTimeForSession(sessionTime, video = {}) {
  const offset = Number(video.timelineOffsetSeconds ?? video.timeline_offset_s ?? video.offset_seconds ?? video.session_time_offset_s ?? 0);
  return Math.max(0, Number(sessionTime || 0) - (Number.isFinite(offset) ? offset : 0));
}

function sessionTimeForSource(sourceTime, video = {}) {
  const offset = Number(video.timelineOffsetSeconds ?? video.timeline_offset_s ?? video.offset_seconds ?? video.session_time_offset_s ?? 0);
  return Math.max(0, Number(sourceTime || 0) + (Number.isFinite(offset) ? offset : 0));
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
  const maxSessionSeconds = Number(segment?.maxSessionSeconds);
  const times = extractCitedTimesFromText(segment?.text || '', segment?.paragraphIndex)
    .filter((time) => Number.isFinite(Number(time.seconds)))
    .filter((time) => !Number.isFinite(maxSessionSeconds) || Number(time.seconds) <= maxSessionSeconds + REVIEW_VIDEO_TIME_TOLERANCE_SECONDS)
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

export function inferReviewVisualFocus(value = '') {
  const text = String(value || '').toLowerCase();
  const focus = (target, x, y, zoom, preferredRole = 'main') => ({ target, x, y, zoom, preferredRole });
  const footAction = '(?:plantar(?: |-)flexion|dorsiflexion|toe curl|toe spread|foot inversion|foot eversion)';
  if (new RegExp(`\\bright[^.]{0,32}${footAction}|${footAction}[^.]{0,32}\\bright`).test(text)) {
    return focus('right_foot', 0.20, 0.25, 1.22, 'feet');
  }
  if (new RegExp(`\\bleft[^.]{0,32}${footAction}|${footAction}[^.]{0,32}\\bleft`).test(text)) {
    return focus('left_foot', 0.34, 0.25, 1.22, 'feet');
  }
  if (/\b(right (?:foot|toes?|heel|sole|ankle)|(?:foot|toe|heel|sole|ankle)s?[^.]{0,24}\bright)\b/.test(text)) {
    return focus('right_foot', 0.20, 0.25, 1.22, 'feet');
  }
  if (/\b(left (?:foot|toes?|heel|sole|ankle)|(?:foot|toe|heel|sole|ankle)s?[^.]{0,24}\bleft)\b/.test(text)) {
    return focus('left_foot', 0.34, 0.25, 1.22, 'feet');
  }
  if (/\b(feet|foot|toes?|heels?|soles?|ankles?|lower bod(?:y|ies)|plantar(?: |-)flexion|dorsiflexion|toe curl|toe spread|foot inversion|foot eversion)\b/.test(text)) {
    return focus('lower_body', 0.27, 0.28, 1.17, 'feet');
  }
  if (/\b(glans|meatus|corona|foreskin|frenulum)\b/.test(text)) {
    return focus('glans', 0.62, 0.61, 1.24);
  }
  if (/\b(penis|penile|shaft|stroking|masturbat|erection|engorgement)\b/.test(text)) {
    return focus('penis', 0.60, 0.61, 1.18);
  }
  if (/\b(scrotum|testi(?:cle|cular)|perine(?:um|al)|pelvic|catheter|foley)\b/.test(text)) {
    return focus('pelvis', 0.58, 0.62, 1.14);
  }
  return null;
}

export function reviewVisualFocusForClip(focusText = '', label = '') {
  return inferReviewVisualFocus(focusText || label || '');
}

function reviewVisualFocusFilter(visualFocus) {
  if (!visualFocus) return null;
  const zoom = Math.max(1.05, Math.min(1.3, Number(visualFocus.zoom || 1.15)));
  const x = Math.max(0.08, Math.min(0.92, Number(visualFocus.x || 0.5)));
  const y = Math.max(0.08, Math.min(0.92, Number(visualFocus.y || 0.5)));
  const step = ((zoom - 1) / 75).toFixed(6);
  return `zoompan=z='min(max(zoom\,pzoom)+${step}\,${zoom.toFixed(3)})':x='max(0\,min(iw-iw/zoom\,iw*${x.toFixed(3)}-iw/zoom/2))':y='max(0\,min(ih-ih/zoom\,ih*${y.toFixed(3)}-ih/zoom/2))':d=1:s=${REVIEW_VIDEO_WIDTH}x${REVIEW_VIDEO_HEIGHT}:fps=30`;
}

function focusForReviewSource(visualFocus, sourceRole = 'main') {
  if (!visualFocus || sourceRole !== 'feet') return visualFocus;
  if (visualFocus.target === 'right_foot') return { ...visualFocus, x: 0.28, y: 0.58, zoom: 1.24 };
  if (visualFocus.target === 'left_foot') return { ...visualFocus, x: 0.72, y: 0.58, zoom: 1.24 };
  return { ...visualFocus, x: 0.5, y: 0.55, zoom: 1.16 };
}

function reviewAnchorText(event = {}) {
  return [
    event?.label,
    event?.reason,
    event?.note,
    Array.isArray(event?.category) ? event.category.join(' ') : event?.category,
    Array.isArray(event?.annotation_tags) ? event.annotation_tags.join(' ') : event?.annotation_tags,
    event?.tags,
    event?.cited_text,
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
}

function activeStimulationAnchorScore(event = {}) {
  const text = reviewAnchorText(event);
  if (!text.trim()) return -200;
  const positivePatterns = [
    [/\b(active stimulation|stimulation continues|contact continues|ongoing contact|ongoing stimulation)\b/, 170],
    [/\b(masturbat|stroking|stroke speed|stroke|hand contact|grip|touching|touch|jerk(?:ing)?|pump(?:ing)?)\b/, 155],
    [/\b(penis|shaft|glans|foreskin)\b/, 85],
    [/\b(arousal|build|edging|near[-\s]?climax|pre[-\s]?climax|climax|orgasm|ejaculat)\b/, 80],
    [/\b(foley evidence|catheter in place|with foley in place|catheter remains|catheter still in)\b/, 55],
    [/\b(on table|supine|lying back|laid back|on the exam table)\b/, 45],
  ];
  const negativePatterns = [
    [/\b(table vacant|empty table|vacant table|table only|room only)\b/, 260],
    [/\b(ambulatory|walking|standing|getting off|off the table|exiting the table|away from the table)\b/, 240],
    [/\b(no visible hand contact|contact withdraw|withdrawn contact|paused|pause|prep|preparation|lubric|lube)\b/, 180],
    [/\b(drainage bag|leg[-\s]?bag|secured off[-\s]?camera|device only|background object)\b/, 160],
  ];
  const positive = positivePatterns.reduce((sum, [pattern, score]) => (pattern.test(text) ? sum + score : sum), 0);
  const negative = negativePatterns.reduce((sum, [pattern, score]) => (pattern.test(text) ? sum + score : sum), 0);
  return positive - negative;
}

function isKnownInactiveReviewAnchor(event = {}) {
  const text = reviewAnchorText(event);
  return [
    /\b(table vacant|vacant table|empty table|empty exam table|empty room|room only|table only)\b/,
    /\bpre[-\s]?session\b/,
    /\bno (?:body|person|subject)(?: [^.]{0,24})? visible\b/,
    /\bno (?:active )?(?:stimulation|contact)(?: [^.]{0,24})? visible\b/,
    /\bno stimulation contact\b/,
    /\b(ambulatory|walking|standing beside|getting off|off the table|exiting the table|away from the table)\b/,
  ].some((pattern) => pattern.test(text));
}

function segmentPhasePositionScore(event = {}, segmentText = '', primaryVideo = {}, sourceDuration = 0) {
  const target = String(segmentText || '').toLowerCase();
  const wantsLatePeak = /\b(final build|late[-\s]?session|terminal build|culminat|climax|orgasm|ejaculat|peak state|peak response)\b/.test(target);
  if (!wantsLatePeak) return 0;
  const eventTime = Number(event?.session_time_s);
  const sessionEnd = sessionTimeForSource(Number(sourceDuration || 0), primaryVideo);
  if (!Number.isFinite(eventTime) || !Number.isFinite(sessionEnd) || sessionEnd <= 0) return 0;
  const ratio = Math.max(0, Math.min(1, eventTime / sessionEnd));
  return Math.round(Math.max(0, (ratio - 0.35) / 0.65) * 260);
}

function activeAnchorReusePenalty(event = {}, primaryVideo = {}, usedSourceWindows = []) {
  const sourceTime = sourceTimeForSession(event?.session_time_s, primaryVideo);
  if (!Number.isFinite(sourceTime)) return 0;
  const nearbyUses = (Array.isArray(usedSourceWindows) ? usedSourceWindows : []).filter((window) => {
    const start = Number(window?.start);
    const end = Number(window?.end);
    return Number.isFinite(start) && Number.isFinite(end) && sourceTime >= start - 8 && sourceTime <= end + 8;
  }).length;
  return Math.min(480, nearbyUses * 180);
}

export function buildActiveStimulationFallbackEvent({
  session = {},
  segment = {},
  primaryVideo = {},
  sourceDuration = 0,
  fallbackCursor = 0,
  usedSourceWindows = [],
} = {}) {
  const anchors = buildLoggedEventAnchors(session)
    .map((anchor) => {
      if (isKnownInactiveReviewAnchor(anchor)) return null;
      const score = activeStimulationAnchorScore(anchor);
      if (score < 70) return null;
      const sessionCursor = sessionTimeForSource(fallbackCursor, primaryVideo);
      const distance = Number.isFinite(sessionCursor)
        ? Math.abs(Number(anchor.session_time_s) - sessionCursor)
        : 0;
      const relevance = segmentKeywordScore(anchor, segment.text || '');
      const phasePosition = segmentPhasePositionScore(anchor, segment.text || '', primaryVideo, sourceDuration);
      const reusePenalty = activeAnchorReusePenalty(anchor, primaryVideo, usedSourceWindows);
      return {
        ...anchor,
        _active_score: score,
        _distance_score: Math.max(0, 90 - Math.min(90, distance / 3)),
        _relevance_score: relevance,
        _phase_position_score: phasePosition,
        _reuse_penalty: reusePenalty,
      };
    })
    .filter(Boolean)
    .filter((anchor) => canRenderSessionTimeFromPrimary({
      sessionSeconds: anchor.session_time_s,
      primaryVideo,
      sourceDuration,
    }))
    .sort((a, b) => (
      b._active_score + b._distance_score + b._relevance_score + b._phase_position_score - b._reuse_penalty
    ) - (
      a._active_score + a._distance_score + a._relevance_score + a._phase_position_score - a._reuse_penalty
    ));

  const selected = anchors[0];
  if (!selected) return null;
  const text = reviewAnchorText(selected);
  const before = /\b(climax|orgasm|ejaculat)\b/.test(text) ? 4 : 2.5;
  const after = /\b(climax|orgasm|ejaculat)\b/.test(text) ? 18 : 12;
  return {
    ...selected,
    label: selected.label || 'Active stimulation context',
    reason: selected.reason || 'Timestamped active-stimulation event selected for review-video context.',
    startSeconds: Math.max(0, Number(selected.session_time_s) - before),
    endSeconds: Number(selected.session_time_s) + after,
    source: selected.source || 'event_timeline',
  };
}

function fallbackEventFromTimestampRequirement(segment = {}, timestampRequirement = {}) {
  const primary = timestampRequirement?.primary;
  const seconds = Number(primary?.seconds);
  if (!Number.isFinite(seconds)) return null;
  return {
    id: `clamped-spoken-time-${Number(segment?.paragraphIndex ?? 0)}-${Math.round(seconds)}`,
    paragraphIndex: segment?.paragraphIndex,
    session_time_s: seconds,
    cited_text: primary?.text || formatTimestamp(seconds),
    spoken_char_index: primary?.charIndex,
    spoken_time_source: primary?.source,
    label: primary?.text ? `Referenced ${primary.text}` : `Referenced ${formatTimestamp(seconds)}`,
    reason: 'Explicit narration timestamp; clamped to the nearest available source video when needed.',
    startSeconds: Math.max(0, seconds - 3),
    endSeconds: seconds + 14,
    source: 'spoken_segment_time',
    direct_spoken_time: true,
    force_direct_cut: true,
    clamped_to_available_source: true,
  };
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
    .replace(/%/g, '\\%')
    .replace(/\[/g, '\\[')
    .replace(/\]/g, '\\]')
    .trim();
}

function parseCsvLine(line = '') {
  const values = [];
  let current = '';
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"') {
      if (quoted && line[index + 1] === '"') {
        current += '"';
        index += 1;
      } else quoted = !quoted;
    } else if (char === ',' && !quoted) {
      values.push(current);
      current = '';
    } else current += char;
  }
  values.push(current);
  return values;
}

async function loadReviewHrTelemetry(session = {}) {
  const csvPath = uploadPathFromUrl(session.hr_data_file || '');
  const digest = session.capture_digest || {};
  const summary = {
    avg: Number(session.avg_hr ?? digest.avg_hr),
    max: Number(session.max_hr ?? digest.peak_hr),
    baseline: Number(digest.baseline_hr),
    rows: [],
  };
  if (!csvPath || !(await fileExists(csvPath))) return summary;
  const lines = (await fs.readFile(csvPath, 'utf8')).split(/\r?\n/).filter(Boolean);
  const headers = parseCsvLine(lines.shift() || '');
  const timeIndex = headers.indexOf('time_offset_s');
  const hrIndex = headers.indexOf('hr');
  const smoothedIndex = headers.indexOf('hr_smoothed');
  const baselineIndex = headers.indexOf('baseline_hr');
  summary.rows = lines.map((line) => {
    const values = parseCsvLine(line);
    return {
      time: Number(values[timeIndex]),
      hr: Number(values[hrIndex]) || Number(values[smoothedIndex]),
      baseline: Number(values[baselineIndex]),
    };
  }).filter((row) => Number.isFinite(row.time) && Number.isFinite(row.hr) && row.hr > 0);
  return summary;
}

export function telemetryAtSessionTime(telemetry = {}, sessionSeconds = 0) {
  const rows = Array.isArray(telemetry.rows) ? telemetry.rows : [];
  const target = Number(sessionSeconds || 0);
  let nearest = null;
  for (const row of rows) {
    if (!nearest || Math.abs(row.time - target) < Math.abs(nearest.time - target)) nearest = row;
    if (row.time > target && nearest) break;
  }
  const hr = Math.round(Number(nearest?.hr || telemetry.avg || 0));
  const avg = Math.round(Number(telemetry.avg || 0));
  const max = Math.round(Number(telemetry.max || 0));
  const baseline = Number(nearest?.baseline || telemetry.baseline || avg || hr);
  const load = max > baseline ? Math.round(Math.max(0, Math.min(100, ((hr - baseline) / (max - baseline)) * 100))) : 0;
  return hr > 0 ? { hr, avg, max, load } : null;
}

function telemetryOverlayFilters(telemetry) {
  if (!telemetry?.hr) return [];
  const fontPath = process.env.REVIEW_VIDEO_FONT || 'C\\:/Windows/Fonts/arial.ttf';
  return [
    'drawbox=x=iw-520:y=28:w=490:h=92:color=0x160f27@0.92:t=fill',
    'drawbox=x=iw-520:y=28:w=490:h=92:color=0xec4899@0.45:t=2',
    `drawtext=fontfile='${fontPath}':text='♥':x=w-494:y=43:fontsize=48:fontcolor=0xff176d@1.0`,
    `drawtext=fontfile='${fontPath}':text='${telemetry.hr}':x=w-430:y=34:fontsize=56:fontcolor=white@1.0`,
    `drawtext=fontfile='${fontPath}':text='BPM':x=w-320:y=82:fontsize=15:fontcolor=0xcbd5e1@0.95`,
    `drawtext=fontfile='${fontPath}':text='AVG ${telemetry.avg || '--'}':x=w-245:y=43:fontsize=20:fontcolor=0xf9a8d4@1.0`,
    `drawtext=fontfile='${fontPath}':text='MAX ${telemetry.max || '--'}':x=w-245:y=69:fontsize=20:fontcolor=0xf9a8d4@1.0`,
    `drawtext=fontfile='${fontPath}':text='LOAD ${telemetry.load}':x=w-115:y=56:fontsize=18:fontcolor=0x86efac@1.0`,
  ];
}

function timestampOverlayFilter({ startSeconds = 0, sessionSeconds = null, playbackRate = 1, outputDurationSeconds = 0, visualFocus = null, telemetry = null } = {}) {
  const fontPath = process.env.REVIEW_VIDEO_FONT || 'C\\:/Windows/Fonts/arial.ttf';
  const rate = Number(playbackRate);
  const slowMoLabel = Number.isFinite(rate) && rate > 0 && rate < 0.99 ? `${Math.round(rate * 100)}% speed` : '';
  const timelineStart = Number.isFinite(Number(sessionSeconds)) ? Number(sessionSeconds) : Number(startSeconds || 0);
  const timelineRate = Number.isFinite(rate) && rate > 0 ? rate : 1;
  const timelineCounter = [
    `%{eif\\:floor((${timelineStart.toFixed(3)}+t*${timelineRate.toFixed(4)})/60)\\:d}`,
    '\\:',
    `%{eif\\:mod(floor(${timelineStart.toFixed(3)}+t*${timelineRate.toFixed(4)})\\,60)\\:d\\:2}`,
  ].join('');
  const slowMoText = slowMoLabel ? drawTextSafe(slowMoLabel.toUpperCase()) : '';
  const badgeX = 34;
  const badgeY = 'h-104';
  const badgeWidth = slowMoText ? 352 : 208;
  const badgeHeight = 58;
  return [
    reviewVideoFitFilter(),
    reviewVisualFocusFilter(visualFocus),
    'format=yuv420p',
    Number.isFinite(rate) && rate > 0 && rate < 0.99 ? `setpts=${(1 / rate).toFixed(4)}*PTS` : null,
    `drawbox=x=${badgeX}:y=${badgeY}:w=${badgeWidth}:h=${badgeHeight}:color=0x04060b@0.72:t=fill`,
    `drawbox=x=${badgeX}:y=${badgeY}:w=${badgeWidth}:h=${badgeHeight}:color=0xffffff@0.08:t=2`,
    `drawbox=x=${badgeX + 12}:y=h-82:w=4:h=14:color=0xa855f7@0.96:t=fill`,
    `drawtext=fontfile='${fontPath}':text='${timelineCounter}':x=${badgeX + 28}:y=h-64:fontsize=34:fontcolor=0xf8fafc@0.99:shadowcolor=0x000000@0.92:shadowx=2:shadowy=2`,
    slowMoText
      ? `drawtext=fontfile='${fontPath}':text='${slowMoText}':x=${badgeX + 150}:y=h-61:fontsize=17:fontcolor=0xf5d0fe@0.95:box=1:boxcolor=0x7e22ce@0.30:boxborderw=6:shadowcolor=0x000000@0.75:shadowx=1:shadowy=1`
      : null,
    ...telemetryOverlayFilters(telemetry),
    ...segmentFadeFilters(outputDurationSeconds),
  ].filter(Boolean).join(',');
}

export async function cutReviewClip({ sourcePath, startSeconds, endSeconds, label, workDir, index, sessionSeconds = null, playbackRate = 1, focusText = '', onPreview = null, sourceDuration = 0, usedSourceWindows = [], activeCandidateStarts = [], alternateVideo = null, lockTimestamp = false, maxMotionDriftSeconds = Number.POSITIVE_INFINITY, telemetryData = null }) {
  const duration = Math.max(0.25, Math.min(180, Number(endSeconds || 0) - Number(startSeconds || 0)));
  const requestedFocus = reviewVisualFocusForClip(focusText, label);
  const useAlternate = requestedFocus?.preferredRole === 'feet' && alternateVideo?.path;
  const selectedVideo = useAlternate ? alternateVideo : { path: sourcePath, role: 'main' };
  const selectedSourcePath = selectedVideo.path;
  const selectedSourceDuration = useAlternate ? Number(selectedVideo._review_duration || selectedVideo.durationSeconds || 0) : sourceDuration;
  const requestedStartSeconds = useAlternate && Number.isFinite(Number(sessionSeconds))
    ? sourceTimeForSession(sessionSeconds, selectedVideo)
    : Number(startSeconds || 0);
  const visualSelection = lockTimestamp
    ? {
      start: clampClipStart(requestedStartSeconds, duration, selectedSourceDuration),
      motionFrames: await reviewWindowMotionFrames(selectedSourcePath, requestedStartSeconds, duration).catch(() => null),
      replaced: false,
    }
    : !useAlternate && selectedSourceDuration > 0
    ? await resolveVisuallyActiveReviewStart({ sourcePath: selectedSourcePath, preferredStart: requestedStartSeconds, durationSeconds: duration, sourceDuration: selectedSourceDuration, usedWindows: usedSourceWindows, activeCandidateStarts, maxDriftSeconds: maxMotionDriftSeconds })
    : { start: clampClipStart(requestedStartSeconds, duration, selectedSourceDuration), motionFrames: null, replaced: false };
  const effectiveStartSeconds = Number(visualSelection.start || 0);
  const effectiveSessionSeconds = Number.isFinite(Number(sessionSeconds))
    ? Number(sessionSeconds) + effectiveStartSeconds - requestedStartSeconds
    : sessionSeconds;
  const visualFocus = focusForReviewSource(requestedFocus, selectedVideo.role);
  const telemetry = telemetryAtSessionTime(telemetryData || {}, effectiveSessionSeconds);
  const rate = Number(playbackRate);
  const outputDuration = Number.isFinite(rate) && rate > 0 && rate < 0.99 ? duration / rate : duration;
  const output = path.join(workDir, `segment-source-${String(index).padStart(3, '0')}.mp4`);
  await runProcess('ffmpeg', [
    '-hide_banner',
    '-y',
    '-ss', String(Math.max(0, effectiveStartSeconds)),
    '-t', String(duration),
    '-i', selectedSourcePath,
    '-map', '0:v:0',
    '-an',
    '-vf', timestampOverlayFilter({
      startSeconds: effectiveStartSeconds,
      sessionSeconds: effectiveSessionSeconds,
      playbackRate,
      outputDurationSeconds: outputDuration,
      visualFocus,
      telemetry,
    }),
    '-c:v', 'libx264',
    '-preset', REVIEW_VIDEO_PRESET,
    '-crf', REVIEW_VIDEO_INTERMEDIATE_CRF,
    '-profile:v', 'high',
    '-pix_fmt', 'yuv420p',
    '-movflags', '+faststart',
    output,
  ]);
  if (typeof onPreview === 'function') {
    try {
      const previewFilename = `review-video-preview-${path.basename(workDir)}-${String(index).padStart(3, '0')}.jpg`;
      const previewPath = path.join(uploadDir, previewFilename);
      await runProcess('ffmpeg', [
        '-hide_banner', '-y',
        '-ss', String(Math.max(0.1, outputDuration * 0.52)),
        '-i', output,
        '-frames:v', '1',
        '-vf', 'scale=960:-2:flags=lanczos',
        '-q:v', '3',
        previewPath,
      ]);
      await onPreview({
        url: `/uploads/${encodeURIComponent(previewFilename)}`,
        segmentIndex: Number(index),
        label: label || 'Production segment',
        sourceSessionSeconds: Number(effectiveSessionSeconds),
        requestedSessionSeconds: Number(sessionSeconds),
        visualDriftSeconds: Number.isFinite(Number(sessionSeconds)) ? roundedSeconds(Number(effectiveSessionSeconds) - Number(sessionSeconds)) : null,
        maxMotionDriftSeconds: Number.isFinite(Number(maxMotionDriftSeconds)) ? Number(maxMotionDriftSeconds) : null,
        motionFrames: visualSelection.motionFrames,
        replacedStaticWindow: Boolean(visualSelection.replaced),
        focus: visualFocus,
        sourceRole: selectedVideo.role || 'main',
        sourceLabel: selectedVideo.label || selectedVideo.filename || path.basename(selectedSourcePath),
        narration: String(focusText || '').slice(0, 280),
      });
    } catch {
      // A diagnostic preview must never fail the production render.
    }
  }
  if (selectedSourceDuration > 0) {
    rememberSourceWindow(usedSourceWindows, {
      start: effectiveStartSeconds,
      end: effectiveStartSeconds + duration,
      label,
    });
  }
  return {
    path: output,
    label,
    sourceStartSeconds: effectiveStartSeconds,
    sourceEndSeconds: effectiveStartSeconds + duration,
    sourceSessionSeconds: effectiveSessionSeconds,
    motionFrames: visualSelection.motionFrames,
    replacedStaticWindow: Boolean(visualSelection.replaced),
    sourcePath: selectedSourcePath,
    sourceRole: selectedVideo.role || 'main',
    durationSeconds: await mediaDurationSeconds(output).catch(() => duration),
  };
}

function syncWindowToRenderedClip(window, videoClip) {
  if (!window || !videoClip) return window;
  window.start = Number(videoClip.sourceStartSeconds ?? window.start);
  window.end = Number(videoClip.sourceEndSeconds ?? window.end);
  window.sessionStartSeconds = Number(videoClip.sourceSessionSeconds ?? window.sessionStartSeconds);
  window.sourcePath = videoClip.sourcePath || window.sourcePath || null;
  window.sourceRole = videoClip.sourceRole || window.sourceRole || 'main';
  return window;
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
  session,
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
  const usedSourceWindows = [];

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
        const alignedEvent = {
          ...event.source,
          session_time_s: Number(event.session_time_s),
          label: event.label || event.source?.label || 'Referenced moment',
        };
        const window = sourceWindowForSegment({
          event: alignedEvent,
          segment: {
            paragraphIndex,
            text: paragraphs[paragraphIndex] || '',
          },
          audioDuration: sliceDuration,
          primaryVideo,
          sourceDuration,
          fallbackCursor: continuitySourceCursor,
        });
        onProgress?.({
          phase: 'segments',
          current: 3,
          total: 5,
          message: `Cutting ${safeDrawText(event.label || 'cited moment', 36)} at ${Math.round(event.session_time_s)}s...`,
        });
        try {
          const clip = await cutReviewClip({
            sourcePath: primaryVideo.path,
            startSeconds: window.start,
            endSeconds: window.end,
            label: window.label,
            workDir,
            index: segmentIndex++,
            sessionSeconds: window.sessionStartSeconds,
            playbackRate: window.playbackRate || 1,
          });
          segments.push(clip.path);
          const actualDuration = Number(clip.durationSeconds || sliceDuration);
          visualDuration += actualDuration;
          slotVisualDuration += actualDuration;
          rememberSourceWindow(usedSourceWindows, { start: window.start, end: window.start + actualDuration, label: window.label });
          generatedClips.push({
            ...event.source,
            paragraphIndex,
            session_time_s: event.session_time_s,
            source_video_path: primaryVideo.path,
            visual_session_start_s: roundedSeconds(window.sessionStartSeconds),
            source_start_s: roundedSeconds(window.start),
            source_end_s: roundedSeconds(window.end),
            aligned_narration_start_s: Math.round(slot.startSeconds * 10) / 10,
            aligned_narration_end_s: Math.round(slot.endSeconds * 10) / 10,
            durationSeconds: Number(clip.durationSeconds || sliceDuration),
            playback_rate: Number(window.playbackRate || 1),
            slow_motion: Boolean(window.slowMotion),
            direct_spoken_time: Boolean(window.directSpokenTime),
            spoken_anchor_offset_seconds: roundedSeconds(window.spokenAnchorOffset || 0),
            spoken_time_lead_seconds: roundedSeconds(window.spokenTimeLeadSeconds || 0),
          });
          continuitySourceCursor = Math.min(Math.max(0, sourceDuration || Number.POSITIVE_INFINITY), window.start + actualDuration);
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
        const fallbackEvent = buildActiveStimulationFallbackEvent({
          session,
          segment: {
            paragraphIndex,
            text: paragraphs[paragraphIndex] || '',
          },
          primaryVideo,
          sourceDuration,
          fallbackCursor: continuitySourceCursor,
        });
        const fallbackWindow = fallbackEvent
          ? sourceWindowForSegment({
            event: fallbackEvent,
            segment: {
              paragraphIndex,
              text: paragraphs[paragraphIndex] || '',
            },
            audioDuration: slot.durationSeconds,
            primaryVideo,
            sourceDuration,
            fallbackCursor: continuitySourceCursor,
          })
          : null;
        const fallbackStart = !fallbackWindow ? selectDistinctReviewSourceStart({
          preferredStart: continuitySourceCursor,
          durationSeconds: slot.durationSeconds,
          sourceDuration,
          usedWindows: usedSourceWindows,
        }) : null;
        const sourceStart = fallbackWindow
          ? fallbackWindow.start
          : fallbackStart == null
          ? clampClipStart(continuitySourceCursor, slot.durationSeconds, sourceDuration)
          : fallbackStart;
        const fallbackEnd = fallbackWindow ? fallbackWindow.end : sourceStart + slot.durationSeconds;
        const clip = await cutReviewClip({
          sourcePath: primaryVideo.path,
          startSeconds: sourceStart,
          endSeconds: fallbackEnd,
          label: fallbackEvent?.label || slotTitle(paragraphIndex, payloadTitle),
          workDir,
          index: segmentIndex++,
          sessionSeconds: fallbackWindow?.sessionStartSeconds ?? sessionTimeForSource(sourceStart, primaryVideo),
          playbackRate: fallbackWindow?.playbackRate || 1,
        });
        segments.push(clip.path);
        const actualDuration = Number(clip.durationSeconds || slot.durationSeconds);
        visualDuration += actualDuration;
        rememberSourceWindow(usedSourceWindows, { start: sourceStart, end: sourceStart + actualDuration, label: fallbackEvent?.label || slotTitle(paragraphIndex, payloadTitle) });
        continuitySourceCursor = sourceStart + actualDuration;
      }
      continue;
    }

    if (primaryVideo?.path) {
      const fallbackEvent = buildActiveStimulationFallbackEvent({
        session,
        segment: {
          paragraphIndex,
          text: paragraphs[paragraphIndex] || '',
        },
        primaryVideo,
        sourceDuration,
        fallbackCursor: continuitySourceCursor,
      });
      const fallbackWindow = fallbackEvent
        ? sourceWindowForSegment({
          event: fallbackEvent,
          segment: {
            paragraphIndex,
            text: paragraphs[paragraphIndex] || '',
          },
          audioDuration: slot.durationSeconds,
          primaryVideo,
          sourceDuration,
          fallbackCursor: continuitySourceCursor,
        })
        : null;
      const fallbackStart = !fallbackWindow ? selectDistinctReviewSourceStart({
        preferredStart: continuitySourceCursor,
        durationSeconds: slot.durationSeconds,
        sourceDuration,
        usedWindows: usedSourceWindows,
      }) : null;
      const sourceStart = fallbackWindow
        ? fallbackWindow.start
        : fallbackStart == null
        ? clampClipStart(continuitySourceCursor, slot.durationSeconds, sourceDuration)
        : fallbackStart;
      const fallbackEnd = fallbackWindow ? fallbackWindow.end : sourceStart + slot.durationSeconds;
      onProgress?.({
        phase: 'segments',
        current: 3,
        total: 5,
        message: fallbackEvent
          ? `Filling narration section ${paragraphIndex + 1} with active stimulation context...`
          : `Filling narration section ${paragraphIndex + 1} with source video context...`,
      });
      const clip = await cutReviewClip({
        sourcePath: primaryVideo.path,
        startSeconds: sourceStart,
        endSeconds: fallbackEnd,
        label: fallbackEvent?.label || slotTitle(paragraphIndex, payloadTitle),
        workDir,
        index: segmentIndex++,
        sessionSeconds: fallbackWindow?.sessionStartSeconds ?? sessionTimeForSource(sourceStart, primaryVideo),
        playbackRate: fallbackWindow?.playbackRate || 1,
      });
      segments.push(clip.path);
      const actualDuration = Number(clip.durationSeconds || slot.durationSeconds);
      visualDuration += actualDuration;
      rememberSourceWindow(usedSourceWindows, { start: sourceStart, end: sourceStart + actualDuration, label: fallbackEvent?.label || slotTitle(paragraphIndex, payloadTitle) });
      generatedClips.push({
        id: fallbackEvent?.id || `context-${paragraphIndex}`,
        paragraphIndex,
        session_time_s: fallbackEvent ? roundedSeconds(fallbackEvent.session_time_s) : Math.round(sourceStart * 10) / 10,
        cited_text: fallbackEvent?.cited_text || (fallbackEvent ? fallbackEvent.label : 'Continuous source video context'),
        label: fallbackEvent?.label || slotTitle(paragraphIndex, payloadTitle),
        reason: fallbackEvent
          ? 'No exact logged event or explicit timestamp matched this narration slot; using active stimulation context instead of empty-room filler.'
          : 'No exact logged event or explicit timestamp matched this narration slot; using source video instead of title-card filler.',
        source_video_path: primaryVideo.path,
        visual_session_start_s: roundedSeconds(fallbackWindow?.sessionStartSeconds ?? sessionTimeForSource(sourceStart, primaryVideo)),
        source_start_s: roundedSeconds(sourceStart),
        source_end_s: roundedSeconds(fallbackEnd),
        aligned_narration_start_s: Math.round(slot.startSeconds * 10) / 10,
        aligned_narration_end_s: Math.round(slot.endSeconds * 10) / 10,
        durationSeconds: actualDuration,
        playback_rate: Number(fallbackWindow?.playbackRate || 1),
        slow_motion: Boolean(fallbackWindow?.slowMotion),
        direct_spoken_time: Boolean(fallbackWindow?.directSpokenTime),
      });
      continuitySourceCursor = sourceStart + actualDuration;
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
  const body = safeDrawText(subtitle || 'No source media was available for this section.', 96);
  const duration = Math.max(2, Number(durationSeconds || 3));
  const draw = [
    `drawbox=x=0:y=0:w=iw:h=ih:color=0x090b10@1:t=fill`,
    `drawbox=x=110:y=100:w=1700:h=880:color=0x0f1117@0.94:t=fill`,
    `drawbox=x=110:y=100:w=1700:h=880:color=0xff2d55@0.82:t=4`,
    `drawbox=x=154:y=146:w=84:h=84:color=0xff2d55@0.95:t=8`,
    `drawtext=fontfile='${fontPath}':text='SARAH':fontcolor=white@0.96:fontsize=30:x=270:y=148`,
    `drawtext=fontfile='${fontPath}':text='PulsePoint Production Review':fontcolor=white@0.62:fontsize=24:x=270:y=192`,
    `drawtext=fontfile='${fontPath}':text='${heading}':fontcolor=white:fontsize=54:x=154:y=430`,
    body ? `drawtext=fontfile='${fontPath}':text='${body}':fontcolor=white@0.76:fontsize=26:x=154:y=520` : null,
    `drawtext=fontfile='${fontPath}':text='No verified source visual available for this segment':fontcolor=white@0.48:fontsize=22:x=154:y=870`,
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
    '-threads', String(REVIEW_VIDEO_FINAL_THREADS),
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

function narrationChunkText(chunk) {
  if (typeof chunk === 'string') return cleanParagraph(chunk);
  return cleanParagraph(chunk?.text || chunk?.content || chunk?.input || '');
}

export function buildReusedNarrationSegmentPlan({
  narrationSegments = [],
  sourceChunks = [],
  trimChunks = [],
  durationSeconds = 0,
} = {}) {
  const segments = narrationSegments.map((segment) => ({
    ...segment,
    text: cleanParagraph(segment?.text),
  })).filter((segment) => segment.text);
  if (!segments.length) return [];

  const source = sourceChunks.map(narrationChunkText);
  const trims = Array.isArray(trimChunks) ? trimChunks : [];
  const hasExactChunkTiming = source.length > 0
    && source.length === trims.length
    && trims.every((chunk) => Number(chunk?.trimmed_duration_seconds) > 0);
  const totalDuration = hasExactChunkTiming
    ? trims.reduce((sum, chunk) => sum + Number(chunk.trimmed_duration_seconds || 0), 0)
    : Number(durationSeconds || 0);
  if (!(totalDuration > 0)) throw new Error('Reusable narration duration is unavailable.');

  const sourceLengths = hasExactChunkTiming
    ? source.map((text) => Math.max(1, text.length))
    : [Math.max(1, segments.reduce((sum, segment) => sum + segment.text.length, 0))];
  const sourceDurations = hasExactChunkTiming
    ? trims.map((chunk) => Number(chunk.trimmed_duration_seconds || 0))
    : [totalDuration];
  const sourceTotalCharacters = sourceLengths.reduce((sum, length) => sum + length, 0);
  const segmentTotalCharacters = segments.reduce((sum, segment) => sum + segment.text.length, 0);

  const timeAtSourceCharacter = (sourceCharacter) => {
    let remaining = Math.max(0, Math.min(sourceTotalCharacters, sourceCharacter));
    let elapsed = 0;
    for (let index = 0; index < sourceLengths.length; index += 1) {
      const length = sourceLengths[index];
      const duration = sourceDurations[index];
      if (remaining <= length) return elapsed + (remaining / length) * duration;
      remaining -= length;
      elapsed += duration;
    }
    return totalDuration;
  };

  let consumedCharacters = 0;
  return segments.map((segment, index) => {
    const startCharacter = consumedCharacters;
    consumedCharacters += segment.text.length;
    const endCharacter = index === segments.length - 1 ? segmentTotalCharacters : consumedCharacters;
    const scaledStart = (startCharacter / segmentTotalCharacters) * sourceTotalCharacters;
    const scaledEnd = (endCharacter / segmentTotalCharacters) * sourceTotalCharacters;
    const startSeconds = timeAtSourceCharacter(scaledStart);
    const endSeconds = index === segments.length - 1
      ? totalDuration
      : timeAtSourceCharacter(scaledEnd);
    return {
      ...segment,
      startSeconds,
      durationSeconds: Math.max(0.05, endSeconds - startSeconds),
      timingSource: hasExactChunkTiming ? 'saved_export_chunk_durations' : 'saved_export_character_ratio',
    };
  });
}

export async function sliceReusableNarrationAudio({ sourcePath, outputPath, startSeconds, durationSeconds }) {
  await runProcess('ffmpeg', [
    '-hide_banner',
    '-y',
    '-ss', Number(startSeconds || 0).toFixed(6),
    '-i', sourcePath,
    '-t', Number(durationSeconds || 0).toFixed(6),
    '-vn',
    '-af', 'aresample=48000:async=1:first_pts=0,aformat=sample_fmts=s16:sample_rates=48000:channel_layouts=stereo',
    '-c:a', 'pcm_s16le',
    outputPath,
  ]);
  return outputPath;
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
    [/\bmeatus|meatal|urethral opening|glans|foreskin|catheter tip\b/, 210],
    [/\burethra|urethral|advancement|advance|insertion|spongy urethra|prostatic urethra\b/, 185],
    [/\bexternal sphincter|internal sphincter|sphincter|resistance|pinch|bladder neck|relaxation|breathing\b/, 175],
    [/\burine return|urine output|drainage bag|bladder entry|collected\b/, 165],
    [/\bballoon|inflate|inflation|5\s*cc|sterile water|syringe|seating|traction\b/, 175],
  ];
  const positive = pairs.reduce((sum, [pattern, score]) => (
    pattern.test(source) && pattern.test(target) ? sum + score : sum
  ), 0);
  const wantsMeatusOrUrethra = /\b(meatus|meatal|urethral opening|glans|foreskin|catheter tip|urethra|urethral|advancement|advance|insertion|spongy urethra|prostatic urethra)\b/i.test(target);
  const sourceLooksPostProcedureBroll = /\b(drainage bag|leg[-\s]?bag|ambulatory|table vacant|getting off|exiting the table|secured off[-\s]?camera|walking)\b/i.test(source);
  const sourceHasMatchingProcedure = /\b(meatus|meatal|urethral opening|glans|foreskin|catheter tip|urethra|urethral|advancement|advance|insertion|spongy urethra|prostatic urethra)\b/i.test(source);
  return positive - (wantsMeatusOrUrethra && sourceLooksPostProcedureBroll && !sourceHasMatchingProcedure ? 180 : 0);
}

function segmentEventCompatibilityScore(event = {}, segment = {}) {
  const source = eventText(event);
  const target = String(segment?.text || '').toLowerCase();
  const sourceFoot = /\b(feet|foot|toes?|heels?|soles?|ankles?|plantar(?: |-)flexion|dorsiflexion|toe curl|lower[-\s]?body)\b/.test(source);
  const targetFoot = /\b(feet|foot|toes?|heels?|soles?|ankles?|plantar(?: |-)flexion|dorsiflexion|toe curl|lower[-\s]?body)\b/.test(target);
  const targetSetup = /\b(mount(?:ing|ed)? the table|settling|settled|session opens|session begins|baseline|pre[-\s]?session|low nineties)\b/.test(target);
  const sourceSetup = /\b(mount(?:ing|ed)? the table|settling|settled on the table|session recording begins|session start|baseline|pre[-\s]?stimulation|early stimulation)\b/.test(source);
  const targetMassagerPlacement = /\b(?:prostate\s+)?massager\b|\b(?:device|massager)\s+(?:placement|positioning|insertion|seating)\b|\b(?:placed|positioned|inserted|seated)\s+(?:the\s+)?(?:device|massager)\b/.test(target);
  const sourceHasMassagerPlacementEvidence = /\bmassager\b/.test(source)
    && /\b(actively handled|handling|guided|guidance|insert(?:ed|ion)?|position(?:ed|ing)?|seated|remains? in place|perineal|anal)\b/.test(source);
  const sourceLooksObjectOnly = /\b(table (?:is |visible )?empty|empty (?:exam )?table|table vacant|side table|pre[-\s]?session setup|setup baseline|supplies|visible in background)\b/.test(source);
  const maxSessionSeconds = Number(segment?.maxSessionSeconds);
  const eventTime = Number(event?.session_time_s);
  let score = 0;
  if (sourceFoot && !targetFoot) score -= 180;
  if (targetFoot && !sourceFoot) score -= 120;
  if (targetMassagerPlacement) {
    score += sourceHasMassagerPlacementEvidence ? 360 : -220;
    if (sourceLooksObjectOnly && !sourceHasMassagerPlacementEvidence) score -= 220;
  }
  if (targetSetup && !targetMassagerPlacement) score += sourceSetup ? 220 : -160;
  if (targetSetup && !targetMassagerPlacement && Number.isFinite(maxSessionSeconds) && maxSessionSeconds > 0 && Number.isFinite(eventTime) && eventTime > maxSessionSeconds * 0.3) {
    score -= 140;
  }
  return score;
}

function collectSegmentEvents({ segment, plan, clipByParagraph, session = {} }) {
  const paragraphIndex = Number(segment.paragraphIndex);
  const maxSessionSeconds = Number(segment?.maxSessionSeconds);
  const explicitTimes = timestampRequirementForSegment(segment).times;
  const requests = (plan.generatedClipRequests || [])
    .filter((request) => Number(request.paragraphIndex) === paragraphIndex);
  const clips = (clipByParagraph.get(paragraphIndex) || [])
    .filter((clip) => Number.isFinite(Number(clipSessionTime(clip))));
  const sessionEvents = buildLoggedEventAnchors(session);
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
  const seen = new Set();
  return [...requests, ...clips, ...synthetic, ...sessionEvents]
    .map((event) => ({
      ...event,
      session_time_s: Number(event.session_time_s ?? clipSessionTime(event)),
    }))
    .filter((event) => Number.isFinite(Number(event.session_time_s)))
    .filter((event) => !Number.isFinite(maxSessionSeconds) || Number(event.session_time_s) <= maxSessionSeconds + REVIEW_VIDEO_TIME_TOLERANCE_SECONDS)
    .filter((event) => {
      const key = String(event.id || `${Math.round(Number(event.session_time_s))}:${event.label || event.note || ''}`);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function chooseSegmentEvent({ segment, plan, clipByParagraph, usedEventIds, session = {} }) {
  const candidates = collectSegmentEvents({ segment, plan, clipByParagraph, session });
  if (!candidates.length) return null;
  const explicitTimes = timestampRequirementForSegment(segment).times;
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
    const reusePenalty = usedEventIds.has(id) ? 140 : 0;
    const directTimeScore = explicitTimes.some((time) => Math.abs(Number(time.seconds) - Number(event.session_time_s)) <= 14)
      ? 220
      : 0;
    const score = directTimeScore
      + segmentKeywordScore(event, segment.text)
      + segmentEventCompatibilityScore(event, segment)
      - reusePenalty;
    if (!best || score > best.score) best = { event, score, id };
  }
  if (!best || best.score < 20) return null;
  usedEventIds.add(best.id);
  return best.event;
}

export function selectReviewVideoEventForSegment({ segment, plan, clipByParagraph = new Map(), usedEventIds = new Set(), session = {} } = {}) {
  return chooseSegmentEvent({ segment, plan: plan || {}, clipByParagraph, usedEventIds, session });
}

function clampClipStart(startSeconds, durationSeconds, sourceDuration) {
  const duration = Math.max(0.5, Number(durationSeconds || 0.5));
  const maxStart = Math.max(0, Number(sourceDuration || 0) - duration);
  return Math.max(0, Math.min(maxStart, Number(startSeconds || 0)));
}

function sourceWindowConflicts(startSeconds, durationSeconds, usedWindows = [], minGapSeconds = REVIEW_VIDEO_MIN_GENERIC_BROLL_GAP_SECONDS) {
  const start = Number(startSeconds);
  const duration = Math.max(0.5, Number(durationSeconds || 0.5));
  const minGap = Math.max(0, Number(minGapSeconds || 0));
  if (!Number.isFinite(start)) return true;
  const end = start + duration;
  return usedWindows.some((used) => {
    const usedStart = Number(used?.start);
    const usedEnd = Number(used?.end);
    if (!Number.isFinite(usedStart) || !Number.isFinite(usedEnd)) return false;
    if (Math.abs(start - usedStart) < minGap) return true;
    return end > usedStart - minGap && start < usedEnd + minGap;
  });
}

function rememberSourceWindow(usedWindows = [], window = {}) {
  const start = Number(window.start);
  const end = Number(window.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return;
  usedWindows.push({
    start,
    end,
    label: window.label || null,
  });
}

export function selectDistinctReviewSourceStart({
  preferredStart = 0,
  durationSeconds = 1,
  sourceDuration = 0,
  usedWindows = [],
  minGapSeconds = REVIEW_VIDEO_MIN_GENERIC_BROLL_GAP_SECONDS,
  allowNearRepeat = false,
  preventRewind = false,
} = {}) {
  const duration = Math.max(0.5, Number(durationSeconds || 0.5));
  const availableDuration = Number(sourceDuration || 0);
  const maxStart = Math.max(0, availableDuration - duration);
  const preferred = clampClipStart(preferredStart, duration, availableDuration);
  if (allowNearRepeat || !usedWindows.length) return preferred;

  const addCandidate = (list, value) => {
    const candidate = clampClipStart(value, duration, availableDuration);
    if (!list.some((existing) => Math.abs(existing - candidate) < 0.25)) list.push(candidate);
  };

  const candidates = [];
  addCandidate(candidates, preferred);
  const stride = Math.max(duration + minGapSeconds, minGapSeconds);
  for (let step = 1; step <= REVIEW_VIDEO_GENERIC_BROLL_SEARCH_STEPS; step += 1) {
    addCandidate(candidates, preferred + stride * step);
    addCandidate(candidates, preferred - stride * step);
  }
  for (const ratio of [0, 0.18, 0.36, 0.54, 0.72, 0.9, 1]) {
    addCandidate(candidates, maxStart * ratio);
  }

  const sorted = candidates.sort((a, b) => Math.abs(a - preferred) - Math.abs(b - preferred));
  for (const candidate of sorted) {
    if (preventRewind && candidate < preferred - 0.25) continue;
    if (!sourceWindowConflicts(candidate, duration, usedWindows, minGapSeconds)) return candidate;
  }
  return null;
}

function isPhaseAnchorEvent(event = {}) {
  return event?.source === 'phase_marker'
    || /\b(pre[-\s]?climax|climax|ejaculat|recovery|recovered|post[-\s]?(?:climax|orgasm))\b/i.test(eventText(event));
}

function phaseAnchorMatchesNarration(event = {}, narrationText = '') {
  const source = eventText(event);
  const target = String(narrationText || '');
  if (/\b(recovery|recovered|post[-\s]?(?:climax|orgasm))\b/i.test(source)) {
    return /\b(recovery|recovered|recovering|post[-\s]?(?:climax|orgasm)|after (?:climax|orgasm|ejaculation))\b/i.test(target);
  }
  if (/\bpre[-\s]?climax\b/i.test(source)) return /\bpre[-\s]?climax\b/i.test(target);
  if (/\b(climax|ejaculat|orgasm)\b/i.test(source)) return /\b(climax|ejaculat|orgasm)\b/i.test(target);
  return false;
}

export function canonicalPhaseAnchorForNarration({ session = {}, narrationText = '' } = {}) {
  const text = String(narrationText || '');
  const phase = (seconds, label, reason) => {
    if (seconds == null || String(seconds).trim() === '') return null;
    const value = Number(seconds);
    return Number.isFinite(value) && value > 0 ? {
      id: `canonical-phase-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`,
      session_time_s: value,
      label,
      reason,
      source: 'phase_marker',
    } : null;
  };
  if (/\b(post[-\s]?(?:climax|orgasm)|climax[-\s]?to[-\s]?recovery|after (?:climax|orgasm|ejaculation)|recovery phase|recovery itself|cardiovascular recovery)\b/i.test(text)) {
    return phase(session?.recovery_offset_s, 'Recovery shift', 'Logged post-climax recovery phase marker');
  }
  if (/\bpre[-\s]?climax\b/i.test(text)) {
    return phase(session?.pre_climax_offset_s, 'Pre-climax build', 'Logged pre-climax phase marker');
  }
  if (/\b(climax|ejaculation|orgasm)\b/i.test(text) && !/\bnear[-\s]?climax\b/i.test(text)) {
    return phase(session?.climax_offset_s, 'Climax / ejaculation', 'Logged climax or ejaculation phase marker');
  }
  return null;
}

export function resolveReviewSegmentPhaseCarryover({
  segment = {},
  directEvent = null,
  phaseAnchorEvent = null,
  paragraphText = '',
} = {}) {
  const paragraphIndex = Number(segment?.paragraphIndex);
  const sameParagraph = phaseAnchorEvent
    && Number(phaseAnchorEvent?.paragraphIndex) === paragraphIndex;
  const nextPhaseAnchor = directEvent
    && isPhaseAnchorEvent(directEvent)
    && phaseAnchorMatchesNarration(directEvent, paragraphText || segment?.text)
    ? directEvent
    : sameParagraph
    ? phaseAnchorEvent
    : null;
  if (directEvent) return { event: directEvent, carried: false, nextPhaseAnchor };
  if (!sameParagraph) return { event: null, carried: false, nextPhaseAnchor: null };
  return {
    event: {
      ...phaseAnchorEvent,
      reason: `${phaseAnchorEvent.reason || phaseAnchorEvent.label || 'Saved phase marker'}; retained for the rest of this narration paragraph.`,
    },
    carried: true,
    nextPhaseAnchor,
  };
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

function sourceWindowForSegment({ event, segment, audioDuration, primaryVideo, sourceDuration, fallbackCursor }) {
  const duration = Math.max(1.25, Number(audioDuration || 1));
  if (event) {
    const sessionTime = Number(event.session_time_s);
    const directSpokenTime = event.source === 'spoken_segment_time' || event.force_direct_cut || event.direct_spoken_time;
    const sourceCenter = sourceTimeForSession(sessionTime, primaryVideo);
    const requestedStart = Number(event.startSeconds);
    const offset = sourceCenter - sessionTime;
    const wantsClimax = isClimaxReviewSegment(segment, event);
    const playbackRate = wantsClimax ? 0.5 : 1;
    const sourceSliceDuration = playbackRate < 1 ? Math.max(0.75, duration * playbackRate) : duration;
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
      sessionStartSeconds: sessionTimeForSource(start, primaryVideo),
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
    sessionSeconds: sessionTimeForSource(start, primaryVideo),
    sessionStartSeconds: sessionTimeForSource(start, primaryVideo),
    label: 'Source video context',
    playbackRate: 1,
    slowMotion: false,
  };
}

async function renderSourceContextSegment({
  session,
  primaryVideo,
  sourceDuration,
  workDir,
  index,
  segment,
  audio,
  fallbackCursor = 0,
  usedSourceWindows = [],
  label = 'Source video context',
  selectionReason = 'No exact event matched this spoken segment; using source video context instead of a title card.',
  fallbackType = 'continuous_source_context',
  visualSource = 'continuous_source_context',
  onPreview = null,
  activeCandidateStarts = [],
  alternateVideo = null,
  telemetryData = null,
}) {
  const duration = Number(audio?.durationSeconds || 1);
  const activeFallbackEvent = buildActiveStimulationFallbackEvent({
    session,
    segment,
    primaryVideo,
    sourceDuration,
    fallbackCursor,
    usedSourceWindows,
  });
  if (activeFallbackEvent) {
    const window = sourceWindowForSegment({
      event: activeFallbackEvent,
      segment,
      audioDuration: duration,
      primaryVideo,
      sourceDuration,
      fallbackCursor,
    });
    window.label = activeFallbackEvent.label || label || 'Active stimulation context';
    const videoClip = await cutReviewClip({
      sourcePath: primaryVideo.path,
      startSeconds: window.start,
      endSeconds: window.end,
      label: window.label,
      workDir,
      index,
      sessionSeconds: window.sessionStartSeconds,
      playbackRate: window.playbackRate || 1,
      focusText: segment.text,
      onPreview,
      sourceDuration,
      usedSourceWindows,
      activeCandidateStarts,
      alternateVideo,
      lockTimestamp: Boolean(window.directSpokenTime),
      maxMotionDriftSeconds: 24,
      telemetryData,
    });
    syncWindowToRenderedClip(window, videoClip);
    return {
      videoClip,
      window,
      generatedClip: {
        id: activeFallbackEvent.id || `active-source-context-${index}`,
        paragraphIndex: segment.paragraphIndex,
        session_time_s: roundedSeconds(activeFallbackEvent.session_time_s),
        visual_session_start_s: roundedSeconds(window.sessionStartSeconds),
        source_start_s: roundedSeconds(window.start),
        source_end_s: roundedSeconds(window.end),
        spoken_segment_index: index,
        spoken_text: segment.text.slice(0, 240),
        label: window.label,
        reason: selectionReason,
        source_video_path: videoClip.sourcePath || primaryVideo.path,
        source_camera_role: videoClip.sourceRole || 'main',
        audio_duration_seconds: roundedSeconds(duration),
        playback_rate: Number(window.playbackRate || 1),
        slow_motion: Boolean(window.slowMotion),
        direct_spoken_time: false,
        source_time_strategy: 'active_stimulation_context',
        matched_event: true,
        procedural_broll: false,
        procedural_broll_score: roundedSeconds(activeFallbackEvent._active_score),
        timeline_trace: {
          ...buildTimelineTrace({
            segment,
            event: activeFallbackEvent,
            window,
            audio,
            selectionReason,
            fallbackUsed: true,
            fallbackType,
            visualSource: 'active_stimulation_context',
          }),
          spoken_segment_index: index,
        },
      },
    };
  }
  const distinctStart = selectDistinctReviewSourceStart({
    preferredStart: fallbackCursor,
    durationSeconds: duration,
    sourceDuration,
    usedWindows: usedSourceWindows,
    preventRewind: true,
  });
  const start = Number.isFinite(Number(distinctStart))
    ? Number(distinctStart)
    : clampClipStart(fallbackCursor, duration, sourceDuration);
  const window = sourceWindowForSegment({
    event: null,
    segment,
    audioDuration: duration,
    primaryVideo,
    sourceDuration,
    fallbackCursor: start,
  });
  window.label = label || window.label;
  const videoClip = await cutReviewClip({
    sourcePath: primaryVideo.path,
    startSeconds: window.start,
    endSeconds: window.end,
    label: window.label,
    workDir,
    index,
    sessionSeconds: window.sessionStartSeconds,
    focusText: segment.text,
    onPreview,
    sourceDuration,
    usedSourceWindows,
    activeCandidateStarts,
    alternateVideo,
    lockTimestamp: Boolean(window.directSpokenTime),
    maxMotionDriftSeconds: 36,
    telemetryData,
  });
  syncWindowToRenderedClip(window, videoClip);
  return {
    videoClip,
    window,
    generatedClip: {
      id: `source-context-${index}`,
      paragraphIndex: segment.paragraphIndex,
      session_time_s: roundedSeconds(window.sessionSeconds),
      visual_session_start_s: roundedSeconds(window.sessionStartSeconds),
      source_start_s: roundedSeconds(window.start),
      source_end_s: roundedSeconds(window.end),
      spoken_segment_index: index,
      spoken_text: segment.text.slice(0, 240),
      label: window.label,
      reason: selectionReason,
      source_video_path: videoClip.sourcePath || primaryVideo.path,
      source_camera_role: videoClip.sourceRole || 'main',
      audio_duration_seconds: roundedSeconds(duration),
      playback_rate: 1,
      slow_motion: false,
      direct_spoken_time: false,
      source_time_strategy: 'continuous_source_video_context',
      matched_event: false,
      procedural_broll: false,
      procedural_broll_score: null,
      timeline_trace: {
        ...buildTimelineTrace({
          segment,
          event: null,
          window,
          audio,
          selectionReason,
          fallbackUsed: true,
          fallbackType,
          visualSource,
        }),
        spoken_segment_index: index,
      },
    },
  };
}

export function resolveTimestampViolationVisualFallback({
  segment,
  event = null,
  timestampRequirement = null,
  audioDuration = 1,
  primaryVideo = {},
  sourceDuration = 0,
  fallbackCursor = 0,
} = {}) {
  if (!primaryVideo?.path) return null;
  const fallbackEvent = event || fallbackEventFromTimestampRequirement(segment, timestampRequirement);
  const window = sourceWindowForSegment({
    event: fallbackEvent,
    segment,
    audioDuration,
    primaryVideo,
    sourceDuration,
    fallbackCursor,
  });
  return {
    event: fallbackEvent,
    window,
    fallbackType: 'nearest_available_source_video',
    visualSource: 'clamped_source_video',
    sourceTimeStrategy: 'clamped_to_nearest_available_source_video',
  };
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
  narration,
}) {
  const sourceDuration = await mediaDurationSeconds(primaryVideo.path).catch(() => 0);
  const feetVideo = await chooseFeetVideo(session, primaryVideo);
  const telemetryData = await loadReviewHrTelemetry(session);
  const activeCandidateStarts = buildLoggedEventAnchors(session)
    .filter((anchor) => activeStimulationAnchorScore(anchor) >= 70)
    .map((anchor) => sourceTimeForSession(anchor.session_time_s, primaryVideo))
    .filter((start) => Number.isFinite(start) && start >= 0 && start < sourceDuration);
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
  if (!narration?.audioPath || !(await fileExists(narration.audioPath))) {
    throw new Error('Narration audio file is unavailable.');
  }
  const narrationDuration = Number(
    narration.rendered?.duration_seconds
    || await mediaDurationSeconds(narration.audioPath).catch(() => 0)
  );
  const reusedSegmentPlan = buildReusedNarrationSegmentPlan({
    narrationSegments,
    sourceChunks: payload.chunks || [],
    trimChunks: narration.audioExport?.silence_trim?.chunks || narration.rendered?.silence_trim?.chunks || [],
    durationSeconds: narrationDuration,
  });
  const usedEventIds = new Set();
  const avSegments = [];
  const videoSegments = [];
  const audioSegments = [];
  const segmentDurations = [];
  const generatedClips = [];
  let fallbackCursor = 0;
  const usedSourceWindows = [];
  let totalAudioDuration = 0;
  let ttsMeta = null;
  let phaseAnchorEvent = null;
  let phaseAnchorParagraph = null;
  const previewFrames = [];
  const publishPreview = async (preview) => {
    previewFrames.push(preview);
    if (previewFrames.length > 4) previewFrames.shift();
    onProgress?.({
      phase: 'segmented_narration',
      current: 3,
      total: 5,
      message: `Produced preview frame ${preview.segmentIndex} of ${narrationSegments.length}.`,
      preview_frame: preview,
      preview_frames: [...previewFrames],
      preview_segment_current: preview.segmentIndex,
      preview_segment_total: narrationSegments.length,
    });
  };

  for (const [index, segment] of narrationSegments.entries()) {
    if (signal?.aborted) throw new Error('Cancelled');
    segment.maxSessionSeconds = sessionTimeForSource(sourceDuration, primaryVideo);
    onProgress?.({
      phase: 'segmented_narration',
      current: 1,
      total: 5,
      message: `Aligning saved narration segment ${index + 1} of ${narrationSegments.length}...`,
    });
    const plannedAudio = reusedSegmentPlan[index];
    const segmentAudioPath = path.join(workDir, `saved-narration-${String(index + 1).padStart(3, '0')}.wav`);
    await sliceReusableNarrationAudio({
      sourcePath: narration.audioPath,
      outputPath: segmentAudioPath,
      startSeconds: plannedAudio.startSeconds,
      durationSeconds: plannedAudio.durationSeconds,
    });
    const audio = {
      audioPath: segmentAudioPath,
      durationSeconds: await mediaDurationSeconds(segmentAudioPath).catch(() => plannedAudio.durationSeconds),
      voice: narration.rendered?.voice || payload.voice || 'nova',
      model: narration.rendered?.model || payload.model || null,
      speed: Number(narration.rendered?.speed || payload.speed || 1),
      reused: true,
      timingSource: plannedAudio.timingSource,
    };
    ttsMeta = ttsMeta || audio;
    audioSegments.push(audio.audioPath);
    const audioDurationSeconds = Number(audio.durationSeconds || 0);
    segmentDurations.push(audioDurationSeconds);
    totalAudioDuration += audioDurationSeconds;

    const timestampRequirement = timestampRequirementForSegment(segment);
    if (phaseAnchorParagraph !== Number(segment.paragraphIndex)) {
      phaseAnchorEvent = null;
      phaseAnchorParagraph = Number(segment.paragraphIndex);
    }
    const matchedEvent = chooseSegmentEvent({ segment, plan, clipByParagraph, usedEventIds, session });
    const canonicalPhaseAnchor = canonicalPhaseAnchorForNarration({
      session,
      narrationText: paragraphs[Number(segment.paragraphIndex)] || segment.text,
    });
    const exactNarratedEvent = timestampRequirement.required && timestampRequirement.primary
      ? {
        ...(matchedEvent || {}),
        id: matchedEvent?.id || `spoken-${index + 1}-${Math.round(timestampRequirement.primary.seconds)}`,
        session_time_s: Number(timestampRequirement.primary.seconds),
        label: `Referenced ${formatTimestamp(timestampRequirement.primary.seconds)}`,
        source: 'spoken_segment_time',
        direct_spoken_time: true,
        force_direct_cut: true,
        spoken_char_index: Number(timestampRequirement.primary.charIndex || 0),
      }
      : null;
    const directEvent = exactNarratedEvent || canonicalPhaseAnchor || matchedEvent;
    const phaseResolution = resolveReviewSegmentPhaseCarryover({
      segment,
      directEvent,
      phaseAnchorEvent,
      paragraphText: paragraphs[Number(segment.paragraphIndex)] || segment.text,
    });
    phaseAnchorEvent = phaseResolution.nextPhaseAnchor;
    const event = phaseResolution.event;
    const eventCarriedFromPhase = phaseResolution.carried;
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
      if (!event) {
        onProgress?.({
          phase: 'segments',
          current: 3,
          total: 5,
          message: `No exact visual for ${narratedLabel}; clamping to the referenced source-video time...`,
        });
        const fallback = resolveTimestampViolationVisualFallback({
          segment,
          timestampRequirement,
          audioDuration: audio.durationSeconds,
          primaryVideo,
          sourceDuration,
          fallbackCursor,
        });
        const fallbackEvent = fallback?.event || null;
        const window = fallback?.window;
        const videoClip = await cutReviewClip({
          sourcePath: primaryVideo.path,
          startSeconds: window.start,
          endSeconds: window.end,
          label: window.label,
          workDir,
          index: index + 1,
          sessionSeconds: window.sessionStartSeconds,
          playbackRate: window.playbackRate || 1,
          focusText: segment.text,
          onPreview: publishPreview,
          sourceDuration,
          usedSourceWindows,
          activeCandidateStarts,
          alternateVideo: feetVideo,
          lockTimestamp: true,
          telemetryData,
        });
        syncWindowToRenderedClip(window, videoClip);
        const avPath = path.join(workDir, `segment-av-${String(index + 1).padStart(3, '0')}.mp4`);
        await muxAudioVideo(videoClip.path, audio.audioPath, avPath);
        avSegments.push(avPath);
        videoSegments.push(videoClip.path);
        rememberSourceWindow(usedSourceWindows, window);
        fallbackCursor = clampClipStart(window.start + Number(audio.durationSeconds || 1), Number(audio.durationSeconds || 1), sourceDuration);
        generatedClips.push({
          id: fallbackEvent?.id || `spoken-clamped-source-${index + 1}`,
          paragraphIndex: segment.paragraphIndex,
          session_time_s: fallbackEvent ? roundedSeconds(fallbackEvent.session_time_s) : null,
          visual_session_start_s: roundedSeconds(window.sessionStartSeconds),
          source_start_s: roundedSeconds(window.start),
          source_end_s: roundedSeconds(window.end),
          spoken_segment_index: index + 1,
          spoken_text: segment.text.slice(0, 240),
          label: window.label || `Referenced ${narratedLabel}`,
          reason: `${reason} The renderer clamped directly to the spoken timestamp in the source video instead of drifting to generic context.`,
          source_video_path: videoClip.sourcePath || primaryVideo.path,
          source_camera_role: videoClip.sourceRole || 'main',
          audio_duration_seconds: roundedSeconds(audio.durationSeconds),
          playback_rate: Number(window.playbackRate || 1),
          slow_motion: Boolean(window.slowMotion),
          direct_spoken_time: Boolean(window.directSpokenTime),
          spoken_anchor_offset_seconds: roundedSeconds(window.spokenAnchorOffset || 0),
          spoken_time_lead_seconds: roundedSeconds(window.spokenTimeLeadSeconds || 0),
          source_time_strategy: fallback?.sourceTimeStrategy || 'clamped_to_nearest_available_source_video',
          matched_event: false,
          procedural_broll: false,
          timeline_trace: {
            ...buildTimelineTrace({
              segment,
              event: fallbackEvent,
              window,
              audio,
              selectionReason: `${reason} The renderer clamped directly to the spoken timestamp in the source video instead of drifting to generic context.`,
              fallbackUsed: true,
              fallbackType: fallback?.fallbackType || 'nearest_available_source_video',
              visualSource: fallback?.visualSource || 'clamped_source_video',
              violation: 'TIMESTAMP_VISUAL_CLAMPED_TO_SPOKEN_TIME_WITHOUT_MATCHING_EVENT',
            }),
            spoken_segment_index: index + 1,
          },
        });
        continue;
      }
      onProgress?.({
        phase: 'segments',
        current: 3,
        total: 5,
        message: `No exact visual for ${narratedLabel}; using nearest source video instead of a title card...`,
      });
      const fallback = resolveTimestampViolationVisualFallback({
        segment,
        event,
        timestampRequirement,
        audioDuration: audio.durationSeconds,
        primaryVideo,
        sourceDuration,
        fallbackCursor,
      });
      const fallbackEvent = fallback?.event || null;
      const window = fallback?.window || sourceWindowForSegment({
        event: null,
        segment,
        audioDuration: audio.durationSeconds,
        primaryVideo,
        sourceDuration,
        fallbackCursor,
      });
      if (sourceWindowConflicts(window.start, Number(audio.durationSeconds || 1), usedSourceWindows)) {
        const videoClip = await cutReviewClip({
          sourcePath: primaryVideo.path,
          startSeconds: window.start,
          endSeconds: window.end,
          label: window.label,
          workDir,
          index: index + 1,
          sessionSeconds: window.sessionStartSeconds,
          playbackRate: window.playbackRate || 1,
          focusText: segment.text,
          onPreview: publishPreview,
          sourceDuration,
          usedSourceWindows,
          activeCandidateStarts,
          alternateVideo: feetVideo,
          lockTimestamp: true,
          telemetryData,
        });
        syncWindowToRenderedClip(window, videoClip);
        videoSegments.push(videoClip.path);
        const avPath = path.join(workDir, `segment-av-${String(index + 1).padStart(3, '0')}.mp4`);
        await muxAudioVideo(videoClip.path, audio.audioPath, avPath);
        avSegments.push(avPath);
        rememberSourceWindow(usedSourceWindows, window);
        fallbackCursor = clampClipStart(window.start + Number(audio.durationSeconds || 1), Number(audio.durationSeconds || 1), sourceDuration);
        const trace = buildTimelineTrace({
          segment,
          event: fallbackEvent || null,
          window,
          audio,
          selectionReason: `${reason} The nearest source-video window was already used nearby, but source video was still used to avoid title-card filler.`,
          fallbackUsed: true,
          fallbackType: 'repeated_nearest_available_source_video',
          visualSource: 'clamped_source_video',
          violation: 'TIMESTAMP_VISUAL_CLAMPED_REPEAT_SOURCE_VIDEO',
        });
        generatedClips.push({
          id: fallbackEvent?.id || `repeated-clamped-source-${index + 1}`,
          paragraphIndex: segment.paragraphIndex,
          session_time_s: fallbackEvent ? roundedSeconds(fallbackEvent.session_time_s) : null,
          visual_session_start_s: roundedSeconds(window.sessionStartSeconds),
          source_start_s: roundedSeconds(window.start),
          source_end_s: roundedSeconds(window.end),
          spoken_segment_index: index + 1,
          spoken_text: segment.text.slice(0, 240),
          label: window.label || 'Nearest available source video',
          reason: 'Narration referenced a time whose nearest source-video window was already used nearby; repeated source video was used instead of a title card.',
          source_video_path: videoClip.sourcePath || primaryVideo.path,
          source_camera_role: videoClip.sourceRole || 'main',
          audio_duration_seconds: roundedSeconds(audio.durationSeconds),
          playback_rate: Number(window.playbackRate || 1),
          slow_motion: Boolean(window.slowMotion),
          direct_spoken_time: Boolean(window.directSpokenTime),
          source_time_strategy: 'repeated_clamped_source_video',
          matched_event: Boolean(matchedEvent),
          procedural_broll: false,
          timeline_trace: { ...trace, spoken_segment_index: index + 1 },
        });
        continue;
      }
      const videoClip = await cutReviewClip({
        sourcePath: primaryVideo.path,
        startSeconds: window.start,
        endSeconds: window.end,
        label: window.label,
        workDir,
        index: index + 1,
        sessionSeconds: window.sessionStartSeconds,
        playbackRate: window.playbackRate || 1,
        focusText: segment.text,
        onPreview: publishPreview,
        sourceDuration,
        usedSourceWindows,
        activeCandidateStarts,
        alternateVideo: feetVideo,
        lockTimestamp: true,
        telemetryData,
      });
      syncWindowToRenderedClip(window, videoClip);
      videoSegments.push(videoClip.path);
      const avPath = path.join(workDir, `segment-av-${String(index + 1).padStart(3, '0')}.mp4`);
      await muxAudioVideo(videoClip.path, audio.audioPath, avPath);
      avSegments.push(avPath);
      rememberSourceWindow(usedSourceWindows, window);
      fallbackCursor = clampClipStart(window.start + Number(audio.durationSeconds || 1), Number(audio.durationSeconds || 1), sourceDuration);
      const trace = buildTimelineTrace({
        segment,
        event: fallbackEvent || null,
        window,
        audio,
        selectionReason: reason,
        fallbackUsed: true,
        fallbackType: fallback?.fallbackType || 'nearest_available_source_video',
        visualSource: fallback?.visualSource || 'clamped_source_video',
        violation: 'TIMESTAMP_VISUAL_CLAMPED_TO_SOURCE',
      });
      generatedClips.push({
        id: fallbackEvent?.id || `clamped-source-${index + 1}`,
        paragraphIndex: segment.paragraphIndex,
        session_time_s: fallbackEvent ? roundedSeconds(fallbackEvent.session_time_s) : roundedSeconds(window.sessionSeconds),
        visual_session_start_s: roundedSeconds(window.sessionStartSeconds),
        source_start_s: roundedSeconds(window.start),
        source_end_s: roundedSeconds(window.end),
        spoken_segment_index: index + 1,
        spoken_text: segment.text.slice(0, 240),
        label: window.label || 'Nearest available source video',
        reason,
        source_video_path: videoClip.sourcePath || primaryVideo.path,
        source_camera_role: videoClip.sourceRole || 'main',
        audio_duration_seconds: roundedSeconds(audio.durationSeconds),
        playback_rate: Number(window.playbackRate || 1),
        slow_motion: Boolean(window.slowMotion),
        direct_spoken_time: Boolean(window.directSpokenTime),
        spoken_anchor_offset_seconds: roundedSeconds(window.spokenAnchorOffset || 0),
        spoken_time_lead_seconds: roundedSeconds(window.spokenTimeLeadSeconds || 0),
        source_time_strategy: fallback?.sourceTimeStrategy || 'clamped_to_nearest_available_source_video',
        matched_event: Boolean(matchedEvent),
        procedural_broll: false,
        timeline_trace: { ...trace, spoken_segment_index: index + 1 },
      });
      continue;
    }

    if (!event) {
      onProgress?.({
        phase: 'segments',
        current: 3,
        total: 5,
        message: `No exact visual for spoken segment ${index + 1}; using source video context instead of a title card...`,
      });
      const sourceContext = await renderSourceContextSegment({
        session,
        primaryVideo,
        sourceDuration,
        workDir,
        index: index + 1,
        segment,
        audio,
        fallbackCursor,
        usedSourceWindows,
        label: 'Active stimulation context',
        selectionReason: 'No exact event matched this untimed spoken segment; using active stimulation context instead of empty-room or off-table filler.',
        fallbackType: 'active_stimulation_context_for_untimed_narration',
        visualSource: 'active_stimulation_context',
        onPreview: publishPreview,
        activeCandidateStarts,
        alternateVideo: feetVideo,
        telemetryData,
      });
      const { videoClip, window } = sourceContext;
      videoSegments.push(videoClip.path);
      const avPath = path.join(workDir, `segment-av-${String(index + 1).padStart(3, '0')}.mp4`);
      await muxAudioVideo(videoClip.path, audio.audioPath, avPath);
      avSegments.push(avPath);
      rememberSourceWindow(usedSourceWindows, window);
      fallbackCursor = clampClipStart(window.start + Number(audio.durationSeconds || 1), Number(audio.durationSeconds || 1), sourceDuration);
      generatedClips.push(sourceContext.generatedClip);
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
      sessionSeconds: window.sessionStartSeconds,
      playbackRate: window.playbackRate || 1,
      focusText: segment.text,
      onPreview: publishPreview,
      sourceDuration,
      usedSourceWindows,
      activeCandidateStarts,
      alternateVideo: feetVideo,
      lockTimestamp: timestampRequirement.required || Boolean(window.directSpokenTime),
      maxMotionDriftSeconds: eventCarriedFromPhase ? 8 : 12,
      telemetryData,
    });
    syncWindowToRenderedClip(window, videoClip);
    videoSegments.push(videoClip.path);
    const avPath = path.join(workDir, `segment-av-${String(index + 1).padStart(3, '0')}.mp4`);
    await muxAudioVideo(videoClip.path, audio.audioPath, avPath);
    avSegments.push(avPath);
    rememberSourceWindow(usedSourceWindows, window);
    fallbackCursor = clampClipStart(window.start + Number(audio.durationSeconds || 1), Number(audio.durationSeconds || 1), sourceDuration);
    const selectionReason = event?.reason || (!event
      ? 'No exact event matched this untimed spoken segment; using continuous source video context.'
      : 'Matched narration segment to timestamped source video.');
    const timelineTrace = buildTimelineTrace({
      segment,
      event,
      window,
      audio,
      selectionReason,
      fallbackUsed: !event,
      fallbackType: !event
        ? 'continuous_source_context'
        : eventCarriedFromPhase
        ? 'paragraph_phase_marker_carryover'
        : null,
      visualSource: !event
        ? 'continuous_source_context'
        : eventCarriedFromPhase
        ? 'paragraph_phase_marker'
        : event?.source === 'spoken_segment_time'
        ? 'explicit_spoken_timestamp'
        : 'matched_event',
    });
    generatedClips.push({
      id: event?.id || `context-${index + 1}`,
      paragraphIndex: segment.paragraphIndex,
      session_time_s: event ? Number(event.session_time_s) : Math.round(window.sessionSeconds * 10) / 10,
      visual_session_start_s: roundedSeconds(window.sessionStartSeconds),
      source_start_s: Math.round(window.start * 10) / 10,
      source_end_s: Math.round(window.end * 10) / 10,
      spoken_segment_index: index + 1,
      spoken_text: segment.text.slice(0, 240),
      label: window.label,
      reason: selectionReason,
      source_video_path: videoClip.sourcePath || primaryVideo.path,
      source_camera_role: videoClip.sourceRole || 'main',
      audio_duration_seconds: Math.round(Number(audio.durationSeconds || 0) * 10) / 10,
      playback_rate: Number(window.playbackRate || 1),
      slow_motion: Boolean(window.slowMotion),
      direct_spoken_time: Boolean(window.directSpokenTime),
      spoken_anchor_offset_seconds: Math.round(Number(window.spokenAnchorOffset || 0) * 10) / 10,
      spoken_time_lead_seconds: Math.round(Number(window.spokenTimeLeadSeconds || 0) * 10) / 10,
      source_time_strategy: window.directSpokenTime ? 'spoken_time_phrase_aligned_to_source' : 'session_offset_or_event',
      matched_event: Boolean(event),
      procedural_broll: false,
      procedural_broll_score: null,
      timeline_trace: { ...timelineTrace, spoken_segment_index: index + 1 },
    });
  }

  const outputBase = `${slugifyFilePart(payload.title || 'session-review-video')}-${Date.now()}`;
  const outputFilename = `${outputBase}.mp4`;
  const outputPath = path.join(uploadDir, outputFilename);
  const audioFilename = `${outputBase}.mp3`;
  const audioOutputPath = path.join(uploadDir, audioFilename);
  const continuousWavPath = path.join(workDir, 'review-video-continuous-audio.wav');

  if (!avSegments.length || avSegments.length !== narrationSegments.length) {
    throw new Error(`Review video segment assembly failed: ${avSegments.length} A/V segments for ${narrationSegments.length} spoken segments.`);
  }

  onProgress({ phase: 'muxing', current: 4, total: 5, message: 'Concatenating narration-locked audio/video segments...' });
  await concatWavSegments(audioSegments, continuousWavPath, workDir);
  await concatAvSegments(avSegments, outputPath, workDir);
  if (!narration.reused) await fs.copyFile(narration.audioPath, audioOutputPath);

  let finalDuration = await mediaDurationSeconds(outputPath).catch(() => totalAudioDuration);
  const continuousAudioDuration = await mediaDurationSeconds(continuousWavPath).catch(() => totalAudioDuration);
  if (continuousAudioDuration < totalAudioDuration - 0.75) {
    throw new Error(`Narration concat is short: expected about ${Math.round(totalAudioDuration)}s, got ${Math.round(continuousAudioDuration)}s.`);
  }
  if (finalDuration < totalAudioDuration - 0.75) {
    throw new Error(`Review video audio was truncated: expected about ${Math.round(totalAudioDuration)}s, got ${Math.round(finalDuration)}s.`);
  }
  const watermark = normalizeWatermarkSettings(payload.watermark || {});
  const watermarkDebug = await replaceVideoWithWatermarkedExport(outputPath, watermark, {
    durationSeconds: finalDuration,
    contentType: 'session_review_video',
    onProgress,
    appVersion: payload.appVersion || '',
  });
  finalDuration = await mediaDurationSeconds(outputPath).catch(() => totalAudioDuration);
  const stat = await fs.stat(outputPath);
  const canonicalAudioPath = narration.reused ? narration.audioPath : audioOutputPath;
  const canonicalAudioUrl = narration.reused ? narration.rendered.file_url : `/uploads/${audioFilename}`;
  const audioStat = await fs.stat(canonicalAudioPath).catch(() => null);
  const chapters = normalizeAudioChapters(
    narrationSegments.map((segment, index) => ({
      id: `review-segment-${index + 1}`,
      title: index === 0 ? 'Summary' : `Spoken segment ${index + 1}`,
      startMs: Math.round(segmentDurations.slice(0, index).reduce((sum, duration) => sum + Number(duration || 0), 0) * 1000),
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
    audio_reused: Boolean(narration.reused),
    audio_file_url: canonicalAudioUrl,
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
    watermark: watermarkDebug,
    app_version: payload.appVersion || null,
  };
  const manifest_url = await writeManifest(outputBase, manifest);
  const record = upsertEntity('SessionReviewVideo', crypto.randomUUID(), {
    title: payload.title || 'Session Review Video',
    session_id: payload.sessionId || session.id || null,
    record_type: payload.recordType || session.record_type || null,
    session_date: payload.sessionDate || session.date || null,
    review_type: payload.reviewType || null,
    analysis_title: payload.title || null,
    source_generated_at: payload.sourceGeneratedAt || null,
    file_url: `/uploads/${outputFilename}`,
    filename: outputFilename,
    mimeType: 'video/mp4',
    size: stat.size,
    duration_seconds: Math.round(finalDuration || 0),
    audio_file_url: canonicalAudioUrl,
    audio_reused: Boolean(narration.reused),
    audio_size: audioStat?.size || null,
    voice: ttsMeta?.voice || payload.voice || 'nova',
    model: ttsMeta?.model || payload.model || null,
    speed: Number(ttsMeta?.speed || payload.speed || 1),
    clip_count: generatedClips.filter((clip) => clip.matched_event).length,
    cited_time_count: plan.citedTimes.length,
    manifest_url,
    render_version: REVIEW_RENDER_VERSION,
    exported_at: new Date().toISOString(),
    watermark_enabled: Boolean(watermarkDebug?.watermark_enabled),
    watermark_preset: watermarkDebug?.preset || watermark.preset,
    app_version: payload.appVersion || null,
  });
  const result = {
    ok: true,
    jobId,
    file_url: record.file_url,
    filename: outputFilename,
    size: stat.size,
    duration_seconds: record.duration_seconds,
    audio_file_url: record.audio_file_url,
    audio_reused: Boolean(narration.reused),
    review_type: payload.reviewType || null,
    clip_count: record.clip_count,
    cited_time_count: record.cited_time_count,
    manifest_url,
    watermark: watermarkDebug,
    timeline_trace: generatedClips.map((clip) => clip.timeline_trace || null).filter(Boolean),
    record,
    render_version: REVIEW_RENDER_VERSION,
    app_version: payload.appVersion || null,
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
    const narration = await resolveNarration(payload, { jobId, signal: options.signal, onProgress });
    if (!narration.audioPath || !(await fileExists(narration.audioPath))) throw new Error('Narration audio file is unavailable.');
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
        narration,
      });
    }

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
      session,
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
          sessionSeconds: sessionTimeForSource(0, primaryVideo),
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
          sessionSeconds: sessionTimeForSource(sourceStart, primaryVideo),
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
    let finalDuration = await mediaDurationSeconds(outputPath).catch(() => audioDuration);
    const watermark = normalizeWatermarkSettings(payload.watermark || {});
    const watermarkDebug = await replaceVideoWithWatermarkedExport(outputPath, watermark, {
      durationSeconds: finalDuration,
      contentType: 'session_review_video',
      onProgress,
      appVersion: payload.appVersion || '',
    });
    finalDuration = await mediaDurationSeconds(outputPath).catch(() => audioDuration);
    const stat = await fs.stat(outputPath);
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
      watermark: watermarkDebug,
      app_version: payload.appVersion || null,
    };
    const manifest_url = await writeManifest(outputBase, manifest);
    const record = upsertEntity('SessionReviewVideo', crypto.randomUUID(), {
      title: payload.title || 'Session Review Video',
      session_id: payload.sessionId || session.id || null,
      record_type: payload.recordType || session.record_type || null,
      session_date: payload.sessionDate || session.date || null,
      review_type: payload.reviewType || null,
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
      watermark_enabled: Boolean(watermarkDebug?.watermark_enabled),
      watermark_preset: watermarkDebug?.preset || watermark.preset,
      app_version: payload.appVersion || null,
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
      review_type: payload.reviewType || null,
      clip_count: record.clip_count,
      cited_time_count: record.cited_time_count,
      manifest_url,
      watermark: watermarkDebug,
      timeline_trace: clipOutputs
        .map((clip) => clip.timeline_trace || null)
        .filter(Boolean),
      record,
      render_version: REVIEW_RENDER_VERSION,
      app_version: payload.appVersion || null,
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
  } catch (error) {
    throw friendlyReviewVideoRenderError(error);
  } finally {
    fs.rm(workDir, { recursive: true, force: true }).catch(() => {});
  }
}

export async function reviewWindowMotionFrames(sourcePath, startSeconds, durationSeconds) {
  const scanDuration = Math.max(1.5, Math.min(3, Number(durationSeconds || 3)));
  const { stderr } = await runProcess('ffmpeg', [
    '-hide_banner',
    '-ss', String(Math.max(0, Number(startSeconds || 0))),
    '-t', String(scanDuration),
    '-i', sourcePath,
    '-vf', 'crop=iw*0.72:ih*0.78:iw*0.28:ih*0.22,scale=320:-2,select=gt(scene\\,0.001),showinfo',
    '-an',
    '-f', 'null',
    '-',
  ]);
  return (String(stderr || '').match(/Parsed_showinfo[^\r\n]*pts_time/g) || []).length;
}

export async function resolveVisuallyActiveReviewStart({ sourcePath, preferredStart, durationSeconds, sourceDuration, usedWindows = [], activeCandidateStarts = [], maxDriftSeconds = Number.POSITIVE_INFINITY }) {
  const duration = Math.max(1.5, Number(durationSeconds || 1.5));
  const maxStart = Math.max(0, Number(sourceDuration || 0) - duration);
  const allowedDrift = Number(maxDriftSeconds);
  const candidates = [];
  const add = (value) => {
    const start = Math.max(0, Math.min(maxStart, Number(value || 0)));
    if (Number.isFinite(allowedDrift) && Math.abs(start - Number(preferredStart || 0)) > allowedDrift) return;
    if (!candidates.some((item) => Math.abs(item - start) < 0.5)) candidates.push(start);
  };
  add(preferredStart);
  [...activeCandidateStarts]
    .map(Number)
    .filter(Number.isFinite)
    .sort((a, b) => Math.abs(a - preferredStart) - Math.abs(b - preferredStart))
    .forEach(add);
  for (const delta of [30, -30, 60, -60, 90, -90, 150, -150, 240, -240]) add(Number(preferredStart || 0) + delta);
  for (const ratio of [0.12, 0.25, 0.38, 0.5, 0.62, 0.75, 0.88]) add(maxStart * ratio);

  let best = null;
  for (const start of candidates) {
    const conflicts = sourceWindowConflicts(start, duration, usedWindows);
    if (start !== candidates[0] && conflicts) continue;
    const motionFrames = await reviewWindowMotionFrames(sourcePath, start, duration).catch(() => 0);
    const candidate = { start, motionFrames, replaced: Math.abs(start - Number(preferredStart || 0)) >= 0.5 };
    if (!best || candidate.motionFrames > best.motionFrames) best = candidate;
    if (!conflicts && motionFrames >= REVIEW_VIDEO_MIN_ACTIVITY_FRAMES) return candidate;
  }
  return best || { start: Number(preferredStart || 0), motionFrames: 0, replaced: false };
}
