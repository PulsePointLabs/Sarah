import fsp from 'node:fs/promises';
import { normalizeVlmAnswers } from './schema.js';

const DEFAULT_SERVICE_URL = 'http://127.0.0.1:8765';
const LATERALITY_DISCIPLINE = "Laterality discipline: anatomical left/right means the person's own left/right, not viewer screen-left/screen-right. When the person faces the camera, anatomical right appears on viewer-left. Do not guess anatomical left/right from image position alone. Preserve anatomical identity across poses and camera angles: a bruise, mole, scar, catheter/tubing position, pelvic finding, genital finding, or skin mark on anatomical right remains right-sided when the person moves from supine to standing, turns toward the camera, rotates, or appears in another crop/camera lane. Track stable landmarks such as umbilicus, sternum, pubic mound, inguinal creases, thighs, known scars, moles, bruises, catheter exit angle, and manual side notes before assigning side. If orientation is unclear, say screen-left/screen-right, near/far, upper/lower, one hand/the other hand, or one leg/the other leg.";
const SARAH_OVERLAY_DISCIPLINE = "Sarah overlay discipline: if sampled frames include readable Sarah app overlays or panels, treat labels such as Current HR, AVG, MAX, RR samples, RMSSD, HRV quality, build confidence, AI Magic, near-climax, recovery, phase labels, EMG levels, Howl/Coyote/e-stim state, timers, or heart-rate trend as app-generated telemetry evidence for that frame/window. Use readable overlay values as supporting context for the visual answer. If overlay text is blurred, cropped, stale, or unreadable, say it is unreadable rather than inventing values. Prefer stored/session telemetry for exact numeric conflict resolution; overlay OCR is visual support.";

function assertLocalServiceUrl(value) {
  const url = new URL(value || process.env.LOCAL_VISION_URL || DEFAULT_SERVICE_URL);
  const host = url.hostname.toLowerCase();
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
    const error = new Error('LOCAL_VISION_URL must point to localhost/127.0.0.1/::1. Local vision will not send frames to remote hosts.');
    error.status = 400;
    throw error;
  }
  return url;
}

function timeoutSignal(signal, timeoutMs) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(new Error(`Local vision request timed out after ${timeoutMs} ms.`)), timeoutMs);
  const abort = () => controller.abort(signal.reason || new Error('Local vision request cancelled.'));
  if (signal) {
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timeout);
      if (signal) signal.removeEventListener('abort', abort);
    },
  };
}

async function parseJsonResponse(response) {
  const text = await response.text();
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    const error = new Error(`Local Qwen service returned non-JSON response: ${text.slice(0, 300)}`);
    error.status = 502;
    throw error;
  }
}

async function readFramePayload(frames) {
  return Promise.all(frames.map(async (frame) => {
    const bytes = await fsp.readFile(frame.file_path);
    return {
      frame_id: frame.frame_id,
      time_ms: frame.time_ms,
      image_base64: bytes.toString('base64'),
      mime_type: 'image/jpeg',
      width: frame.width,
      height: frame.height,
    };
  }));
}

function normalizeModelInfo(data) {
  if (data?.model && typeof data.model === 'object') return data.model;
  return {
    name: data?.model || data?.model_name || process.env.LOCAL_VISION_MODEL || 'Qwen/Qwen2.5-VL-7B-Instruct',
    device: data?.device || 'unknown',
    quantization: data?.quantization || 'unknown',
  };
}

async function postToLocalVision(pathname, payload, signal) {
  const serviceUrl = assertLocalServiceUrl(process.env.LOCAL_VISION_URL || DEFAULT_SERVICE_URL);
  const endpoint = new URL(pathname, serviceUrl);
  const timeoutMs = Math.max(1000, Number(process.env.LOCAL_VISION_TIMEOUT_MS || 180000));
  const abortable = timeoutSignal(signal, timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: abortable.signal,
    });
    const data = await parseJsonResponse(response);
    if (!response.ok || data?.ok === false) {
      const error = new Error(data?.error || data?.detail || `Local Qwen service failed: ${response.status}`);
      error.status = response.status || 502;
      error.data = data;
      throw error;
    }
    return data;
  } catch (error) {
    if (error?.name === 'AbortError') {
      const wrapped = new Error(error?.message || 'Local Qwen service request timed out or was cancelled.');
      wrapped.status = 504;
      throw wrapped;
    }
    if (!error.status) error.status = 502;
    throw error;
  } finally {
    abortable.cleanup();
  }
}

export async function getLocalVisionHealth() {
  const serviceUrl = assertLocalServiceUrl(process.env.LOCAL_VISION_URL || DEFAULT_SERVICE_URL);
  const endpoint = new URL('/health', serviceUrl);
  const timeoutMs = Math.min(10000, Math.max(1000, Number(process.env.LOCAL_VISION_TIMEOUT_MS || 10000)));
  const abortable = timeoutSignal(null, timeoutMs);
  try {
    const response = await fetch(endpoint, { signal: abortable.signal });
    const data = await parseJsonResponse(response);
    return {
      ok: response.ok && data?.ok !== false,
      enabled: process.env.LOCAL_VISION_ENABLED !== 'false',
      serviceUrl: serviceUrl.toString(),
      engine: process.env.LOCAL_VISION_ENGINE || 'local_qwen25vl',
      privacy: { localOnly: true, cloudUpload: false },
      ...data,
    };
  } catch (error) {
    return {
      ok: false,
      enabled: process.env.LOCAL_VISION_ENABLED !== 'false',
      serviceUrl: serviceUrl.toString(),
      engine: process.env.LOCAL_VISION_ENGINE || 'local_qwen25vl',
      error: error?.message || 'Local Qwen service is unavailable.',
      privacy: { localOnly: true, cloudUpload: false },
    };
  } finally {
    abortable.cleanup();
  }
}

export async function callLocalQwenBatch({ questions, frames, recordType, signal }) {
  const data = await postToLocalVision('/analyze-batch', {
    engine: 'local_qwen25vl',
    record_type: recordType,
    frames: await readFramePayload(frames),
    questions: questions.map((question) => ({
      id: question.id,
      label: question.label,
      prompt: `${LATERALITY_DISCIPLINE}\n\n${SARAH_OVERLAY_DISCIPLINE}\n\n${question.prompt}`,
      allowed_answers: question.allowedAnswers,
      hallucination_warning: question.hallucinationWarning,
      category: question.category,
      domain: question.domain,
      required_frame_evidence: question.requiredFrameEvidence,
    })),
    output_schema: 'strict',
  }, signal);
  return {
    model: normalizeModelInfo(data),
    answers: normalizeVlmAnswers(data?.answers || [], questions, frames),
    warnings: Array.isArray(data?.warnings) ? data.warnings : [],
  };
}

export async function askLocalQwenVideo({ question, frames, recordType, knownTimeline, scaleCalibration, signal }) {
  const data = await postToLocalVision('/ask', {
    engine: 'local_qwen25vl',
    record_type: recordType,
    question: `${LATERALITY_DISCIPLINE}\n\n${SARAH_OVERLAY_DISCIPLINE}\n\n${question}`,
    frames: await readFramePayload(frames),
    known_timeline: knownTimeline || null,
    scale_calibration: scaleCalibration || { available: false, pixelsPerCm: null, source: null },
  }, signal);
  return {
    model: normalizeModelInfo(data),
    answer: data?.answer || {},
    supporting_evidence: data?.supporting_evidence || {},
    forbidden_or_not_visible: Array.isArray(data?.forbidden_or_not_visible) ? data.forbidden_or_not_visible : [],
    warnings: Array.isArray(data?.warnings) ? data.warnings : [],
  };
}
