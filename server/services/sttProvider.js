import {
  estimateAudioInputTokens,
  estimateWhisperCostUsd,
  guardedOpenAIRequest,
  makeOpenAIHttpError,
} from './openaiGuard.js';

function envFlag(name, fallback = false) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

export function normalizeSttProvider(value = 'auto') {
  const normalized = String(value || 'auto').trim().toLowerCase();
  if (['groq', 'openai', 'auto'].includes(normalized)) return normalized;
  return 'auto';
}

export function sttProviderConfigured(provider) {
  if (provider === 'groq') return Boolean(String(process.env.GROQ_API_KEY || '').trim());
  if (provider === 'openai') {
    return envFlag('OPENAI_ENABLED', false) && Boolean(String(process.env.OPENAI_API_KEY || '').trim());
  }
  return false;
}

export function getConfiguredSttProviders() {
  return ['groq', 'openai'].filter(sttProviderConfigured);
}

export function resolveSttProvider(requestedProvider = 'auto') {
  const requested = normalizeSttProvider(
    requestedProvider || process.env.SARAH_STT_PROVIDER || process.env.STT_PROVIDER || 'auto',
  );

  if (requested === 'auto') {
    if (sttProviderConfigured('groq')) return 'groq';
    if (sttProviderConfigured('openai')) return 'openai';
    const error = new Error('No speech-to-text provider is configured. Add GROQ_API_KEY, or enable OpenAI transcription on the Sarah backend.');
    error.status = 503;
    error.code = 'stt_provider_not_configured';
    throw error;
  }

  if (sttProviderConfigured(requested)) return requested;
  const label = requested === 'groq' ? 'Groq' : 'OpenAI';
  const hint = requested === 'groq'
    ? 'Add GROQ_API_KEY to the Sarah backend environment.'
    : 'Set OPENAI_ENABLED=true and add OPENAI_API_KEY to the Sarah backend environment.';
  const error = new Error(`${label} speech-to-text is not configured. ${hint}`);
  error.status = 503;
  error.code = 'stt_provider_not_configured';
  throw error;
}

function sttProviderConfig(provider) {
  if (provider === 'groq') {
    return {
      provider: 'groq',
      label: 'Groq',
      model: String(process.env.GROQ_STT_MODEL || 'whisper-large-v3-turbo').trim() || 'whisper-large-v3-turbo',
      url: 'https://api.groq.com/openai/v1/audio/transcriptions',
      apiKey: process.env.GROQ_API_KEY,
    };
  }
  return {
    provider: 'openai',
    label: 'OpenAI',
    model: String(process.env.OPENAI_STT_MODEL || 'whisper-1').trim() || 'whisper-1',
    url: 'https://api.openai.com/v1/audio/transcriptions',
    apiKey: process.env.OPENAI_API_KEY,
  };
}

function createTranscriptionForm({ audioBuffer, mimeType, filename, prompt, language, model }) {
  const form = new FormData();
  form.append('file', new Blob([audioBuffer], { type: mimeType }), filename);
  form.append('model', model);
  if (language) form.append('language', language);
  if (prompt) form.append('prompt', prompt);
  return form;
}

export async function transcribeAudioWithProvider({
  audioBuffer,
  mimeType,
  filename,
  prompt,
  language = 'en',
  requestedProvider = 'auto',
  feature = 'whisper_stt',
  dedupeKey,
  idempotencyKey,
} = {}) {
  const provider = resolveSttProvider(requestedProvider);
  const config = sttProviderConfig(provider);
  const estimatedDurationSeconds = Math.max(1, Buffer.byteLength(audioBuffer) / 32_000);

  if (provider === 'openai') {
    const result = await guardedOpenAIRequest({
      feature,
      model: config.model,
      inputCharacters: String(prompt || '').length,
      estimatedInputTokens: estimateAudioInputTokens(estimatedDurationSeconds),
      estimatedCostUsd: estimateWhisperCostUsd(estimatedDurationSeconds),
      idempotencyKey,
      dedupeKey,
      execute: async ({ requestId }) => {
        const form = createTranscriptionForm({
          audioBuffer,
          mimeType,
          filename,
          prompt,
          language,
          model: config.model,
        });
        const response = await fetch(config.url, {
          method: 'POST',
          headers: { Authorization: `Bearer ${config.apiKey}`, 'X-Client-Request-Id': requestId },
          body: form,
        });
        if (!response.ok) {
          const error = makeOpenAIHttpError(response, await response.text());
          error.provider = 'openai';
          throw error;
        }
        return { data: await response.json(), providerRequestId: response.headers.get('x-request-id') || null };
      },
    });
    return {
      provider,
      providerLabel: config.label,
      model: config.model,
      providerRequestId: result.providerRequestId || null,
      data: result.data,
      text: String(result.data?.text || '').trim(),
    };
  }

  const form = createTranscriptionForm({
    audioBuffer,
    mimeType,
    filename,
    prompt,
    language,
    model: config.model,
  });
  const response = await fetch(config.url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${config.apiKey}` },
    body: form,
  });
  if (!response.ok) {
    const error = makeOpenAIHttpError(response, await response.text());
    error.provider = 'groq';
    throw error;
  }
  const data = await response.json();
  return {
    provider,
    providerLabel: config.label,
    model: config.model,
    providerRequestId: response.headers.get('x-request-id') || null,
    data,
    text: String(data?.text || '').trim(),
  };
}
