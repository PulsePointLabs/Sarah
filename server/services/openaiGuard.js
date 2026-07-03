import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from '../config.js';

const inFlight = new Map();
const recent = new Map();
const reservations = new Map();
const featureRequestStarts = new Map();
const activeByFeature = new Map();
let activeRequests = 0;
const defaultUsageFile = path.join(dataDir, 'openai-usage.jsonl');
const RECENT_TTL_MS = 5 * 60 * 1000;

function pruneRecent(now = Date.now()) {
  for (const [key, item] of recent) {
    if (now - item.at >= RECENT_TTL_MS) recent.delete(key);
  }
  while (recent.size > 64) recent.delete(recent.keys().next().value);
}

function envFlag(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function numberEnv(name, fallback) {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function featureEnvSuffix(feature = '') {
  return String(feature || 'unknown').toUpperCase().replace(/[^A-Z0-9]+/g, '_');
}

function featureBurstLimit(feature) {
  const configured = numberEnv(`OPENAI_BURST_MAX_${featureEnvSuffix(feature)}`, -1);
  if (configured >= 0) return configured;
  if (feature === 'session_review_video_segment') return 30;
  if (feature === 'tts_export') return 200;
  if (feature === 'tts_live') return 120;
  return numberEnv('OPENAI_FEATURE_BURST_MAX_REQUESTS', 60);
}

function assertFeatureBurstAvailable(feature) {
  const now = Date.now();
  const windowMs = Math.max(1_000, numberEnv('OPENAI_FEATURE_BURST_WINDOW_MS', 5 * 60 * 1000));
  const limit = featureBurstLimit(feature);
  const starts = (featureRequestStarts.get(feature) || []).filter((at) => now - at < windowMs);
  if (limit > 0 && starts.length >= limit) {
    const error = new Error(`OpenAI feature circuit is temporarily open for ${feature}: ${starts.length} unique requests in ${Math.round(windowMs / 1000)} seconds.`);
    error.status = 429;
    error.code = 'openai_feature_circuit_open';
    error.retryable = false;
    throw error;
  }
  starts.push(now);
  featureRequestStarts.set(feature, starts);
}

function reserveConcurrency(feature) {
  const globalLimit = Math.max(1, numberEnv('OPENAI_MAX_CONCURRENT_REQUESTS', 4));
  const featureLimit = Math.max(1, numberEnv(`OPENAI_MAX_CONCURRENT_${featureEnvSuffix(feature)}`, numberEnv('OPENAI_MAX_CONCURRENT_PER_FEATURE', 2)));
  const featureActive = activeByFeature.get(feature) || 0;
  if (activeRequests >= globalLimit || featureActive >= featureLimit) {
    const error = new Error(`OpenAI request concurrency limit reached for ${feature}; retry this action after current requests finish.`);
    error.status = 429;
    error.code = 'openai_concurrency_limit';
    error.retryable = false;
    throw error;
  }
  activeRequests += 1;
  activeByFeature.set(feature, featureActive + 1);
}

function releaseConcurrency(feature) {
  activeRequests = Math.max(0, activeRequests - 1);
  const remaining = Math.max(0, (activeByFeature.get(feature) || 1) - 1);
  if (remaining) activeByFeature.set(feature, remaining);
  else activeByFeature.delete(feature);
}

function stableHash(value) {
  return crypto.createHash('sha256').update(String(value || '')).digest('hex');
}

function todayKey(date = new Date()) {
  return date.toISOString().slice(0, 10);
}

function monthKey(date = new Date()) {
  return date.toISOString().slice(0, 7);
}

function readUsageTotals() {
  const totals = { day: 0, month: 0, byFeature: {} };
  const usageFile = process.env.OPENAI_USAGE_FILE || defaultUsageFile;
  if (!fs.existsSync(usageFile)) return totals;
  const day = todayKey();
  const month = monthKey();
  const lines = fs.readFileSync(usageFile, 'utf8').split(/\r?\n/).filter(Boolean);
  for (const line of lines) {
    try {
      const item = JSON.parse(line);
      if (item.status !== 'success') continue;
      const cost = Number(item.estimated_cost_usd || 0);
      if (String(item.at || '').startsWith(day)) totals.day += cost;
      if (String(item.at || '').startsWith(month)) totals.month += cost;
      totals.byFeature[item.feature] = (totals.byFeature[item.feature] || 0) + cost;
    } catch {}
  }
  return totals;
}

function appendUsage(item) {
  const usageFile = process.env.OPENAI_USAGE_FILE || defaultUsageFile;
  fs.mkdirSync(path.dirname(usageFile), { recursive: true });
  fs.appendFileSync(usageFile, `${JSON.stringify(item)}\n`, 'utf8');
}

function reservationTotal(prefix) {
  let total = 0;
  for (const reservation of reservations.values()) {
    if (reservation.period.startsWith(prefix)) total += reservation.cost;
  }
  return total;
}

function openAIConfigurationError(message, status = 503) {
  const error = new Error(message);
  error.status = status;
  error.code = 'openai_disabled';
  error.retryable = false;
  return error;
}

export function assertOpenAIEnabled() {
  if (!envFlag('OPENAI_ENABLED', false)) {
    throw openAIConfigurationError('OpenAI access is disabled by OPENAI_ENABLED.');
  }
  if (!String(process.env.OPENAI_API_KEY || '').trim()) {
    throw openAIConfigurationError('OpenAI access is not configured on the Sarah backend.');
  }
}

export function estimateTextTokens(characterCount = 0) {
  return Math.ceil(Math.max(0, Number(characterCount) || 0) / 4);
}

export function estimateAudioInputTokens(durationSeconds = 0) {
  return Math.ceil(Math.max(0, Number(durationSeconds) || 0) * 50);
}

export function estimateTtsCostUsd(characterCount = 0) {
  return Math.max(0, Number(characterCount) || 0) / 1_000_000
    * numberEnv('OPENAI_TTS_USD_PER_1M_CHARACTERS', 15);
}

export function estimateWhisperCostUsd(durationSeconds = 0) {
  return Math.max(0, Number(durationSeconds) || 0) / 60
    * numberEnv('OPENAI_WHISPER_USD_PER_MINUTE', 0.006);
}

export function estimateImageCostUsd() {
  return numberEnv('OPENAI_IMAGE_ESTIMATED_COST_USD', 0.05);
}

export function makeOpenAIHttpError(response, bodyText = '') {
  let payload = null;
  try { payload = JSON.parse(bodyText); } catch {}
  const error = new Error(payload?.error?.message || payload?.message || bodyText || `OpenAI request failed (${response.status}).`);
  error.status = response.status;
  error.code = payload?.error?.code || payload?.error?.type || 'openai_http_error';
  error.providerPayload = payload;
  error.retryable = [408, 500, 502, 503, 504].includes(response.status);
  return error;
}

export function isRetryableOpenAIError(error) {
  const status = Number(error?.status || 0);
  const code = String(error?.code || '').toLowerCase();
  const message = String(error?.message || '').toLowerCase();
  if ([400, 401, 403, 404, 409, 413, 422, 429].includes(status)) return false;
  if (/billing|quota|insufficient_quota|invalid|authentication|permission/.test(`${code} ${message}`)) return false;
  return error?.retryable === true || [408, 500, 502, 503, 504].includes(status) || error?.name === 'TypeError';
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function guardedOpenAIRequest({
  feature,
  model,
  inputCharacters = 0,
  estimatedInputTokens = estimateTextTokens(inputCharacters),
  estimatedCostUsd = 0,
  dedupeKey,
  idempotencyKey,
  maxAttempts = numberEnv('OPENAI_MAX_ATTEMPTS', 2),
  execute,
} = {}) {
  assertOpenAIEnabled();
  if (typeof execute !== 'function') throw new TypeError('guardedOpenAIRequest requires execute');

  const maxInputCharacters = numberEnv('OPENAI_MAX_INPUT_CHARACTERS', 20_000);
  if (inputCharacters > maxInputCharacters) {
    const error = new Error(`OpenAI input is too large: ${inputCharacters} characters (maximum ${maxInputCharacters}).`);
    error.status = 413;
    error.retryable = false;
    throw error;
  }

  const requestId = crypto.randomUUID();
  const finalDedupeKey = stableHash(`${feature}|${model}|${idempotencyKey || ''}|${dedupeKey || ''}`);
  pruneRecent();
  const cached = recent.get(finalDedupeKey);
  if (cached && Date.now() - cached.at < RECENT_TTL_MS) return cached.value;
  if (inFlight.has(finalDedupeKey)) return inFlight.get(finalDedupeKey);

  const totals = readUsageTotals();
  assertFeatureBurstAvailable(feature);
  reserveConcurrency(feature);

  const dayLimit = numberEnv('OPENAI_DAILY_BUDGET_USD', 15);
  const monthLimit = numberEnv('OPENAI_MONTHLY_BUDGET_USD', 100);
  const reservedDay = reservationTotal(todayKey());
  const reservedMonth = reservationTotal(monthKey());
  if (dayLimit > 0 && totals.day + reservedDay + estimatedCostUsd > dayLimit) {
    releaseConcurrency(feature);
    throw openAIConfigurationError(`OpenAI daily spending guard reached ($${dayLimit.toFixed(2)}).`, 429);
  }
  if (monthLimit > 0 && totals.month + reservedMonth + estimatedCostUsd > monthLimit) {
    releaseConcurrency(feature);
    throw openAIConfigurationError(`OpenAI monthly spending guard reached ($${monthLimit.toFixed(2)}).`, 429);
  }

  reservations.set(requestId, { period: `${todayKey()}|${monthKey()}`, cost: estimatedCostUsd });
  console.info('[openai] request', {
    requestId,
    feature,
    model,
    inputCharacters,
    estimatedInputTokens,
    estimatedCostUsd: Number(estimatedCostUsd.toFixed(6)),
  });

  const promise = (async () => {
    let lastError;
    const attempts = Math.max(1, Math.min(3, Number(maxAttempts) || 1));
    for (let attempt = 1; attempt <= attempts; attempt += 1) {
      const startedAt = Date.now();
      try {
        const value = await execute({ requestId, attempt });
        appendUsage({
          at: new Date().toISOString(), status: 'success', request_id: requestId,
          provider_request_id: value?.providerRequestId || null, feature, model,
          input_characters: inputCharacters, estimated_input_tokens: estimatedInputTokens,
          estimated_cost_usd: Number(estimatedCostUsd.toFixed(6)), attempt,
          latency_ms: Date.now() - startedAt,
        });
        recent.set(finalDedupeKey, { at: Date.now(), value });
        return value;
      } catch (error) {
        lastError = error;
        const retryable = isRetryableOpenAIError(error);
        appendUsage({
          at: new Date().toISOString(), status: 'failed', request_id: requestId,
          feature, model, input_characters: inputCharacters,
          estimated_input_tokens: estimatedInputTokens, estimated_cost_usd: 0,
          attempt, latency_ms: Date.now() - startedAt,
          http_status: Number(error?.status || 0) || null,
          error_code: String(error?.code || error?.name || 'error').slice(0, 80),
          error_message: String(error?.message || error).slice(0, 300),
          retryable,
        });
        if (!retryable || attempt >= attempts) throw error;
        await sleep(Math.min(500 * (2 ** (attempt - 1)), 4000));
      }
    }
    throw lastError;
  })().finally(() => {
    inFlight.delete(finalDedupeKey);
    reservations.delete(requestId);
    releaseConcurrency(feature);
  });

  inFlight.set(finalDedupeKey, promise);
  return promise;
}

export function resetOpenAIGuardForTests() {
  inFlight.clear();
  recent.clear();
  reservations.clear();
  featureRequestStarts.clear();
  activeByFeature.clear();
  activeRequests = 0;
}

export const OPENAI_USAGE_FILE = defaultUsageFile;
