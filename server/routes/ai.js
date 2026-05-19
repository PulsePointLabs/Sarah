import express from 'express';
import Anthropic from '@anthropic-ai/sdk';

export const aiRouter = express.Router();

const MODEL_MAP = {
  claude_sonnet_4_6: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-5-20250929',
  claude_sonnet_4_5: 'claude-sonnet-4-5-20250929',
};

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
    const preview = String(text || '').slice(0, 400);
    const parseError = new Error(`AI returned malformed JSON. The response may have been cut off. ${error.message}`);
    parseError.status = 502;
    parseError.preview = preview;
    throw parseError;
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function createMessageWithRetries(anthropic, payload, attempts = 3) {
  let lastError;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await anthropic.messages.create(payload);
    } catch (error) {
      lastError = error;
      const status = error.status || error.response?.status;
      const retryable = [408, 429, 500, 502, 503, 504].includes(status);
      if (!retryable || attempt === attempts - 1) throw error;
      const retryAfter = error.headers?.['retry-after'] || error.response?.headers?.get?.('retry-after');
      const delay = retryAfter
        ? Math.min(Math.max(Number(retryAfter) * 1000, 2000), 65000)
        : Math.min(10000 * 2 ** attempt, 65000) + Math.floor(Math.random() * 1500);
      console.warn('AI invoke retrying after transient error', { status, attempt: attempt + 1, delay });
      await sleep(delay);
    }
  }
  throw lastError;
}

aiRouter.post('/invoke', async (req, res) => {
  try {
    if (!process.env.ANTHROPIC_API_KEY) {
      return res.status(500).json({ error: 'Missing ANTHROPIC_API_KEY' });
    }
    const anthropic = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });
    const { prompt, response_json_schema, model, add_context_from_internet, ...rest } = req.body || {};
    if (!prompt) return res.status(400).json({ error: 'Missing prompt' });

    const wantsJson = !!response_json_schema;
    const modelName = MODEL_MAP[model] || process.env.ANTHROPIC_MODEL || model || 'claude-sonnet-4-5-20250929';
    const jsonInstruction = wantsJson
      ? `\n\nReturn ONLY valid JSON matching this JSON schema. Do not wrap in markdown.\n${JSON.stringify(response_json_schema, null, 2)}`
      : '';

    const msg = await createMessageWithRetries(anthropic, {
      model: modelName,
      max_tokens: rest.max_tokens || Number(process.env.ANTHROPIC_MAX_TOKENS || 8192),
      temperature: rest.temperature ?? 0.3,
      messages: [{ role: 'user', content: `${prompt}${jsonInstruction}` }],
    }, rest.attempts || Number(process.env.ANTHROPIC_ATTEMPTS || 3));

    const text = msg.content?.map((p) => p.type === 'text' ? p.text : '').join('\n').trim() || '';
    if (!wantsJson) return res.json(text);

    if (msg.stop_reason === 'max_tokens') {
      return res.status(502).json({
        error: 'AI response was cut off before it finished. Try again, or use a smaller/batched analysis request.',
        stop_reason: msg.stop_reason,
      });
    }
    return res.json(parseJsonOrThrow(text));
  } catch (error) {
    console.error('AI invoke failed:', error);
    res.status(error.status || 502).json({
      error: error.message || String(error),
      preview: error.preview,
    });
  }
});
