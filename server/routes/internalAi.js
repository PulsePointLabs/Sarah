import Anthropic from '@anthropic-ai/sdk';
import { writeAIForensicArtifact } from '../services/aiForensics.js';
import { classifyProviderError, shouldRetryProviderError } from '../../src/lib/providerErrorClassifier.js';
import { completePlainTextResponse } from '../services/completePlainTextResponse.js';

const MODEL_MAP = {
  claude_sonnet_4_6: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6',
  claude_sonnet_4_5: 'claude-sonnet-4-5-20250929',
};

function anthropicTimeoutMs() {
  const configured = Number(process.env.ANTHROPIC_TIMEOUT_MS || 600000);
  return Number.isFinite(configured) && configured > 0 ? configured : 600000;
}

function stripCodeFence(text = '') {
  const trimmed = String(text).trim();
  const match = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  return match ? match[1].trim() : trimmed;
}

function extractJsonObject(text = '') {
  const stripped = stripCodeFence(text);
  const first = stripped.indexOf('{');
  const last = stripped.lastIndexOf('}');
  if (first === -1 || last === -1 || last <= first) return stripped;
  return stripped.slice(first, last + 1);
}

function parseJsonOrThrow(text = '') {
  try {
    return JSON.parse(extractJsonObject(text));
  } catch (error) {
    const parseError = new Error(`AI returned malformed JSON. The response may have been cut off. ${error.message}`);
    parseError.status = 502;
    parseError.code = 'AI_MALFORMED_JSON';
    parseError.rawPreview = String(text || '').slice(0, 500);
    throw parseError;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createMessageWithRetries(anthropic, payload, attempts = 3, signal) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (signal?.aborted) throw new Error('Cancelled');
    try {
      const message = await anthropic.messages.create(payload, signal ? { signal } : undefined);
      return { message, attemptsUsed: attempt + 1 };
    } catch (error) {
      lastError = error;
      if (signal?.aborted) throw new Error('Cancelled');
      const classified = classifyProviderError(error, { provider: 'anthropic', requestStage: 'internal_invoke' });
      const retryable = shouldRetryProviderError(error, { provider: 'anthropic', requestStage: 'internal_invoke' });
      if (!retryable || attempt === attempts - 1) throw error;
      const retryAfter = error.headers?.['retry-after'] || error.response?.headers?.get?.('retry-after');
      const delay = retryAfter
        ? Math.min(Math.max(Number(retryAfter) * 1000, 2000), 65000)
        : Math.min(10000 * 2 ** attempt, 65000) + Math.floor(Math.random() * 1500);
      console.warn('Internal AI invoke retrying after transient error', { category: classified.category, code: classified.code, attempt: attempt + 1, delay });
      await sleep(delay);
    }
  }
  throw lastError;
}

function jsonInstruction(responseJsonSchema, schemaMode) {
  if (!responseJsonSchema) return '';
  if (schemaMode === 'base44_parity') {
    const fields = Object.keys(responseJsonSchema.properties || {});
    const required = responseJsonSchema.required || [];
    return `\n\nReturn the analysis as valid JSON with these fields: ${fields.join(', ')}. Required fields: ${required.join(', ')}. Use a string for summary and arrays of prose paragraphs for the other fields.`;
  }
  return `\n\nReturn ONLY valid JSON matching this JSON schema. Do not wrap in markdown.\n${JSON.stringify(responseJsonSchema, null, 2)}`;
}

function resolveMaxImageCount(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.max(1, Math.min(12, Math.floor(parsed))) : 5;
}

function imageBlocksFromPayload(images = [], maxImages = 5) {
  if (!Array.isArray(images)) return [];
  return images.slice(0, resolveMaxImageCount(maxImages)).map((image) => {
    const mediaType = image?.media_type || image?.mimeType || image?.mime_type;
    const rawData = String(image?.data || image?.base64 || '').replace(/^data:[^;]+;base64,/, '');
    if (!mediaType || !rawData) return null;
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: mediaType,
        data: rawData,
      },
    };
  }).filter(Boolean);
}

function imageMetadata(images = [], maxImages = 5) {
  if (!Array.isArray(images)) return [];
  return images.slice(0, resolveMaxImageCount(maxImages)).map((image, index) => ({
    index,
    filename: image?.filename || '',
    media_type: image?.media_type || image?.mimeType || image?.mime_type || '',
    has_data: Boolean(image?.data || image?.base64),
  }));
}

export async function aiInvokeInternal({
  prompt,
  response_json_schema,
  model,
  max_tokens = Number(process.env.ANTHROPIC_MAX_TOKENS || 8192),
  continue_on_max_tokens = false,
  max_continuations = 2,
  temperature = 0.3,
  schema_mode = 'strict',
  images = [],
  max_images = 5,
  forensicCaptureId,
  invocationAttempt = 1,
  signal,
}) {
  if (!process.env.ANTHROPIC_API_KEY) throw new Error('Missing ANTHROPIC_API_KEY');
  const anthropic = new Anthropic({
    apiKey: process.env.ANTHROPIC_API_KEY,
    timeout: anthropicTimeoutMs(),
  });
  const wantsJson = !!response_json_schema;
  const resolvedModel = MODEL_MAP[model] || process.env.ANTHROPIC_MODEL || model || 'claude-sonnet-4-6';
  const providerMessage = `${prompt}${jsonInstruction(response_json_schema, schema_mode)}`;
  const imageBlocks = imageBlocksFromPayload(images, max_images);
  const content = imageBlocks.length
    ? [{ type: 'text', text: providerMessage }, ...imageBlocks]
    : providerMessage;
  const attemptPrefix = `attempt-${invocationAttempt}`;
  writeAIForensicArtifact(forensicCaptureId, `${attemptPrefix}-prompt.txt`, prompt);
  writeAIForensicArtifact(forensicCaptureId, `${attemptPrefix}-schema.json`, response_json_schema || null);
  writeAIForensicArtifact(forensicCaptureId, `${attemptPrefix}-provider-message.txt`, providerMessage);
  writeAIForensicArtifact(forensicCaptureId, `${attemptPrefix}-image-metadata.json`, imageMetadata(images, max_images));
  writeAIForensicArtifact(forensicCaptureId, `${attemptPrefix}-request-config.json`, {
    requested_model_alias: model,
    resolved_model_id: resolvedModel,
    temperature,
    max_tokens,
    schema_mode,
    structured_response_requested: wantsJson,
    image_count: Array.isArray(images) ? images.length : 0,
    image_block_count: imageBlocks.length,
    requested_max_images: resolveMaxImageCount(max_images),
    provider_content_shape: imageBlocks.length ? 'text-plus-images' : 'text-only',
    configured_transport_attempts: Number(process.env.ANTHROPIC_ATTEMPTS || 3),
  });
  const providerPayload = {
    model: resolvedModel,
    max_tokens,
    temperature,
    messages: [{
      role: 'user',
      content,
    }],
  };
  const transportAttempts = Number(process.env.ANTHROPIC_ATTEMPTS || 3);
  const { message: msg, attemptsUsed } = await createMessageWithRetries(
    anthropic,
    providerPayload,
    transportAttempts,
    signal,
  );
  const text = msg.content?.map((p) => p.type === 'text' ? p.text : '').join('\n').trim() || '';
  writeAIForensicArtifact(forensicCaptureId, `${attemptPrefix}-provider-metadata.json`, {
    resolved_model_id: resolvedModel,
    stop_reason: msg.stop_reason,
    transport_attempts_used: attemptsUsed,
    usage: msg.usage,
  });
  writeAIForensicArtifact(forensicCaptureId, `${attemptPrefix}-raw-provider-response.txt`, text);
  if (!wantsJson) {
    if (msg.stop_reason !== 'max_tokens') return text;
    if (!continue_on_max_tokens) {
      throw new Error('AI response was cut off before it finished.');
    }
    const completed = await completePlainTextResponse({
      createMessage: async (nextPayload) => {
        const next = await createMessageWithRetries(
          anthropic,
          nextPayload,
          transportAttempts,
          signal,
        );
        return next.message;
      },
      initialMessage: msg,
      payload: providerPayload,
      maxContinuations: Math.min(Math.max(Number(max_continuations) || 1, 1), 3),
    });
    writeAIForensicArtifact(forensicCaptureId, `${attemptPrefix}-completed-provider-response.txt`, completed.text);
    return completed.text;
  }
  if (msg.stop_reason === 'max_tokens') {
    throw new Error('AI response was cut off before it finished. Try again, or use a smaller/batched analysis request.');
  }
  const parsed = parseJsonOrThrow(text);
  writeAIForensicArtifact(forensicCaptureId, `${attemptPrefix}-parsed-result.json`, parsed);
  return parsed;
}
