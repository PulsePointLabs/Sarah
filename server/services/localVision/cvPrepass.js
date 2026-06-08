import { runProcessBinary } from '../ttsCore.js';
import { sampleLocalVisionFrames } from './frameSampler.js';

const RAW_W = 32;
const RAW_H = 18;
const RAW_SIZE = RAW_W * RAW_H;

function clamp01(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.min(1, parsed));
}

async function frameGrayPixels(filePath) {
  const { stdout } = await runProcessBinary('ffmpeg', [
    '-hide_banner',
    '-loglevel', 'error',
    '-i', filePath,
    '-vf', `scale=${RAW_W}:${RAW_H},format=gray`,
    '-frames:v', '1',
    '-f', 'rawvideo',
    'pipe:1',
  ]);
  return stdout.length >= RAW_SIZE ? stdout.subarray(0, RAW_SIZE) : Buffer.alloc(RAW_SIZE);
}

function regionBounds(region) {
  if (region === 'lower_center') return { x0: 10, x1: 22, y0: 8, y1: 16 };
  if (region === 'lower') return { x0: 0, x1: RAW_W, y0: 10, y1: RAW_H };
  if (region === 'edges') return { x0: 0, x1: RAW_W, y0: 0, y1: RAW_H, edges: true };
  return { x0: 0, x1: RAW_W, y0: 0, y1: RAW_H };
}

function diffBounds(a, b, bounds) {
  let sum = 0;
  let count = 0;
  for (let y = bounds.y0; y < bounds.y1; y += 1) {
    for (let x = bounds.x0; x < bounds.x1; x += 1) {
      if (bounds.edges && x > 3 && x < RAW_W - 4 && y > 3 && y < RAW_H - 4) continue;
      const idx = y * RAW_W + x;
      sum += Math.abs((a?.[idx] || 0) - (b?.[idx] || 0));
      count += 1;
    }
  }
  return count ? sum / (count * 255) : 0;
}

function diffRegion(a, b, region) {
  return diffBounds(a, b, regionBounds(region));
}

function roiBounds(roi = {}) {
  const x0 = Math.max(0, Math.min(RAW_W - 1, Math.floor(Number(roi.x || 0) * RAW_W)));
  const y0 = Math.max(0, Math.min(RAW_H - 1, Math.floor(Number(roi.y || 0) * RAW_H)));
  const x1 = Math.max(x0 + 1, Math.min(RAW_W, Math.ceil((Number(roi.x || 0) + Number(roi.width || 0)) * RAW_W)));
  const y1 = Math.max(y0 + 1, Math.min(RAW_H, Math.ceil((Number(roi.y || 0) + Number(roi.height || 0)) * RAW_H)));
  return { x0, x1, y0, y1 };
}

function roiMotionMetrics(a, b, rois = []) {
  const scored = rois.map((roi) => ({
    id: roi.id,
    label: roi.label,
    type: roi.type,
    score: diffBounds(a, b, roiBounds(roi)),
  })).sort((left, right) => right.score - left.score);
  const top = scored[0] || null;
  const average = scored.length ? scored.reduce((sum, item) => sum + item.score, 0) / scored.length : 0;
  return {
    max: top?.score || 0,
    average,
    top,
    all: scored,
  };
}

function candidateTypeForRecord(recordType, metrics) {
  const type = String(recordType || '').toLowerCase();
  const roiType = String(metrics.roiTop?.type || '').toLowerCase();
  if (roiType === 'genital_hand_roi') return 'hand_genital_motion_candidate';
  if (roiType === 'feet_legs_roi') return 'body_foot_movement_candidate';
  if (roiType === 'foley_procedure_field_roi') return 'foley_tool_or_tubing_activity_candidate';
  if (roiType === 'tubing_bag_roi') return 'tubing_or_bag_field_candidate';
  if (roiType === 'full_body_roi' && metrics.roiMax > 0.1) return 'body_position_or_surface_visibility_candidate';
  if (type === 'foley_procedure') return metrics.lowerCenter > 0.11 ? 'foley_tool_or_tubing_activity_candidate' : 'procedure_field_change_candidate';
  if (type === 'masturbation') {
    if (metrics.lowerCenter > 0.12) return 'hand_genital_motion_candidate';
    if (metrics.lower > 0.1) return 'body_foot_movement_candidate';
    return 'anatomy_visibility_change_candidate';
  }
  if (type === 'body_exploration') {
    if (metrics.lower > 0.1) return 'body_position_or_surface_visibility_candidate';
    return 'anatomy_visibility_candidate';
  }
  return metrics.global > 0.14 ? 'scene_or_motion_change_candidate' : 'general_visibility_candidate';
}

function reasonsFor(type, metrics) {
  const reasons = [];
  if (metrics.global > 0.16) reasons.push('non-static frame cluster');
  if (metrics.scene > 0.2) reasons.push('large scene or posture change');
  if (metrics.lowerCenter > 0.1) reasons.push('localized motion near lower torso/genital region');
  if (metrics.lower > 0.1) reasons.push('lower-body or foot/leg motion signal');
  if (metrics.roiTop?.score > 0.08) reasons.push(`ROI-weighted motion in ${metrics.roiTop.label || metrics.roiTop.type}`);
  if (type.includes('fluid') || (metrics.lowerCenter > 0.16 && metrics.global < 0.22)) reasons.push('localized appearance change worth checking for fluid or contact change');
  if (!reasons.length) reasons.push('visibility checkpoint selected from chronological scan');
  return reasons;
}

function mergeCandidates(candidates, mergeGapMs = 3500) {
  const sorted = [...candidates].sort((a, b) => a.start_ms - b.start_ms);
  const out = [];
  for (const candidate of sorted) {
    const prev = out[out.length - 1];
    if (prev && prev.type === candidate.type && candidate.start_ms <= prev.end_ms + mergeGapMs) {
      prev.end_ms = Math.max(prev.end_ms, candidate.end_ms);
      prev.score = Math.max(prev.score, candidate.score);
      prev.frame_refs = [...new Set([...prev.frame_refs, ...candidate.frame_refs])];
      prev.reasons = [...new Set([...prev.reasons, ...candidate.reasons])];
      prev.debug.samples += candidate.debug.samples;
      continue;
    }
    out.push({ ...candidate, reasons: [...candidate.reasons], frame_refs: [...candidate.frame_refs], debug: { ...candidate.debug } });
  }
  return out;
}

export function rankCandidateWindows(candidates = [], maxCandidateWindows = 12) {
  return [...candidates]
    .sort((a, b) => (b.score || 0) - (a.score || 0) || (a.start_ms || 0) - (b.start_ms || 0))
    .slice(0, Math.max(1, Number(maxCandidateWindows || 12)))
    .sort((a, b) => (a.start_ms || 0) - (b.start_ms || 0))
    .map((candidate, index) => ({
      ...candidate,
      candidate_id: candidate.candidate_id || `cand_${String(index + 1).padStart(3, '0')}`,
      lifecycle: candidate.lifecycle || ['detected_by_cv'],
    }));
}

export async function runCvPrepass({ request, videoPath, sessionId, onProgress } = {}) {
  const candidatePolicy = request.candidatePolicy || {};
  const sampled = await sampleLocalVisionFrames({
    videoPath,
    sessionId,
    startMs: request.startMs,
    endMs: request.endMs,
    samplePolicy: {
      fps: candidatePolicy.baselineFps || 0.5,
      maxFrames: Math.min(
        Number(process.env.LOCAL_VISION_CV_MAX_FRAMES || 240),
        Math.max(12, Math.ceil(((request.endMs - request.startMs) / 1000) * Number(candidatePolicy.baselineFps || 0.5))),
      ),
      dedupe: candidatePolicy.dedupe !== false,
      thumbnailWidth: candidatePolicy.thumbnailWidth || 512,
    },
    onProgress,
  });

  const pixels = [];
  const rois = Array.isArray(request.regionsOfInterest) ? request.regionsOfInterest : [];
  for (let index = 0; index < sampled.frames.length; index += 1) {
    pixels.push(await frameGrayPixels(sampled.frames[index].file_path));
    if (index === 0 || (index + 1) % 10 === 0 || index === sampled.frames.length - 1) {
      onProgress?.({
        phase: 'cv_prepass',
        framesScanned: index + 1,
        frames_scanned: index + 1,
        total: sampled.frames.length,
        current: index + 1,
        message: `Cheap CV pre-pass scanned ${index + 1}/${sampled.frames.length} frames...`,
      });
    }
  }

  const rawCandidates = [];
  for (let index = 1; index < sampled.frames.length; index += 1) {
    const prev = sampled.frames[index - 1];
    const frame = sampled.frames[index];
    const metrics = {
      global: diffRegion(pixels[index - 1], pixels[index], 'global'),
      lowerCenter: diffRegion(pixels[index - 1], pixels[index], 'lower_center'),
      lower: diffRegion(pixels[index - 1], pixels[index], 'lower'),
      scene: diffRegion(pixels[index - 1], pixels[index], 'edges'),
    };
    const roiMetrics = roiMotionMetrics(pixels[index - 1], pixels[index], rois);
    metrics.roiMax = roiMetrics.max;
    metrics.roiAverage = roiMetrics.average;
    metrics.roiTop = roiMetrics.top;
    const score = clamp01(Math.max(
      (metrics.global * 1.7) + (metrics.lowerCenter * 2.2) + (metrics.lower * 1.1) + (metrics.scene * 0.8),
      metrics.roiMax * 2.4,
    ));
    const isCheckpoint = index === 1 || index === sampled.frames.length - 1 || index % Math.max(4, Math.round(sampled.frames.length / 8)) === 0;
    if (score < 0.18 && !isCheckpoint) continue;
    const type = candidateTypeForRecord(request.recordType, metrics);
    rawCandidates.push({
      candidate_id: `raw_${String(index).padStart(3, '0')}`,
      start_ms: Math.max(request.startMs, prev.time_ms - Number(candidatePolicy.candidateWindowPreMs ?? 3000)),
      end_ms: Math.min(request.endMs, frame.time_ms + Number(candidatePolicy.candidateWindowPostMs ?? 3000)),
      type,
      score: Number(Math.max(score, isCheckpoint ? 0.22 : 0).toFixed(3)),
      reasons: reasonsFor(type, metrics),
      frame_refs: [prev.frame_id, frame.frame_id],
      lifecycle: ['detected_by_cv'],
      roi: metrics.roiTop?.score > 0.04 ? {
        id: metrics.roiTop.id,
        label: metrics.roiTop.label,
        type: metrics.roiTop.type,
        motion_score: Number(metrics.roiTop.score.toFixed(4)),
        contributed: metrics.roiTop.score > 0.08,
      } : null,
      debug: {
        samples: 1,
        metrics: {
          global: Number(metrics.global.toFixed(4)),
          lowerCenter: Number(metrics.lowerCenter.toFixed(4)),
          lower: Number(metrics.lower.toFixed(4)),
          scene: Number(metrics.scene.toFixed(4)),
          roiMax: Number(metrics.roiMax.toFixed(4)),
          roiAverage: Number(metrics.roiAverage.toFixed(4)),
        },
      },
    });
  }

  const merged = mergeCandidates(rawCandidates);
  const ranked = rankCandidateWindows(merged, candidatePolicy.maxCandidateWindows || 12);
  return {
    ...sampled,
    candidate_windows: ranked,
    cvPrepassStats: {
      frames_scanned: sampled.frames.length,
      raw_candidates: rawCandidates.length,
      candidate_windows: ranked.length,
      baseline_fps: candidatePolicy.baselineFps || 0.5,
      roi_configured: rois.length > 0,
      roi_count: rois.length,
      roi_labels: rois.map((roi) => roi.label),
    },
  };
}
