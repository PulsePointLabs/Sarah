import express from 'express';
import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import { uploadDir } from '../config.js';
import { classifyProviderError } from '../../src/lib/providerErrorClassifier.js';
import { estimateImageCostUsd, guardedOpenAIRequest, makeOpenAIHttpError } from '../services/openaiGuard.js';

export const sarahBrandRouter = express.Router();

const BRAND_UPLOAD_DIR = path.join(uploadDir, 'sarah-brand');
const IMAGE_MODEL = process.env.OPENAI_IMAGE_MODEL || 'gpt-image-2';
const IMAGE_SIZE = process.env.OPENAI_IMAGE_SIZE || '1024x1024';
const IMAGE_QUALITY = process.env.OPENAI_IMAGE_QUALITY || 'medium';

function cleanPrompt(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 1200);
}

function buildSarahPortraitPrompt(userPrompt) {
  const custom = cleanPrompt(userPrompt);
  return [
    'Create a tasteful app portrait for Sarah, a warm clinical physiology assistant.',
    'The image should work as a square app/avatar portrait and feel calm, intelligent, medically literate, and modern.',
    'Use a polished realistic or semi-realistic style with soft lavender clinical lighting.',
    'No text, no logos, no usernames, no legal names, no watermarks, no patient data, no explicit anatomy, no medical procedure scene.',
    custom ? `User customization: ${custom}` : 'Default look: approachable woman clinician in a modern physiology lab.',
  ].join('\n');
}

async function callOpenAIImageGeneration(prompt) {
  const result = await guardedOpenAIRequest({
    feature: 'sarah_portrait_generation',
    model: IMAGE_MODEL,
    inputCharacters: prompt.length,
    estimatedCostUsd: estimateImageCostUsd(),
    dedupeKey: `${IMAGE_MODEL}|${IMAGE_SIZE}|${IMAGE_QUALITY}|${prompt}`,
    execute: async ({ requestId }) => {
      const response = await fetch('https://api.openai.com/v1/images/generations', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          'Content-Type': 'application/json',
          'X-Client-Request-Id': requestId,
        },
        body: JSON.stringify({ model: IMAGE_MODEL, prompt, n: 1, size: IMAGE_SIZE, quality: IMAGE_QUALITY, output_format: 'png' }),
      });
      const raw = await response.text();
      if (!response.ok) throw makeOpenAIHttpError(response, raw);
      return { payload: JSON.parse(raw), providerRequestId: response.headers.get('x-request-id') || null };
    },
  });
  const payload = result.payload;

  const item = Array.isArray(payload?.data) ? payload.data[0] : null;
  const b64 = item?.b64_json || item?.image_base64 || item?.base64;
  if (!b64) {
    const error = new Error('OpenAI image generation returned no image data.');
    error.status = 502;
    error.providerPayload = payload;
    throw error;
  }
  return { buffer: Buffer.from(b64, 'base64'), revisedPrompt: item?.revised_prompt || '' };
}

sarahBrandRouter.post('/generate-portrait', async (req, res) => {
  const userPrompt = cleanPrompt(req.body?.prompt);
  const prompt = buildSarahPortraitPrompt(userPrompt);
  try {
    const { buffer, revisedPrompt } = await callOpenAIImageGeneration(prompt);
    await fs.mkdir(BRAND_UPLOAD_DIR, { recursive: true });
    const id = crypto.randomUUID();
    const filename = `sarah-generated-${Date.now()}-${id.slice(0, 8)}.png`;
    const filePath = path.join(BRAND_UPLOAD_DIR, filename);
    await fs.writeFile(filePath, buffer);
    await fs.writeFile(filePath.replace(/\.png$/i, '.json'), JSON.stringify({
      kind: 'sarah_generated_portrait',
      model: IMAGE_MODEL,
      size: IMAGE_SIZE,
      quality: IMAGE_QUALITY,
      promptHash: crypto.createHash('sha256').update(prompt).digest('hex'),
      userPromptHash: crypto.createHash('sha256').update(userPrompt).digest('hex'),
      revisedPrompt,
      createdAt: new Date().toISOString(),
    }, null, 2));

    res.json({
      ok: true,
      id: `generated-${id}`,
      label: 'Generated Sarah',
      helper: userPrompt ? 'Generated from your Sarah customization prompt.' : 'Generated from the default Sarah portrait prompt.',
      url: `/uploads/sarah-brand/${filename}`,
      filename,
      model: IMAGE_MODEL,
      size: IMAGE_SIZE,
      quality: IMAGE_QUALITY,
    });
  } catch (error) {
    const classified = classifyProviderError(error, {
      provider: 'openai',
      model: IMAGE_MODEL,
      requestStage: 'sarah_portrait_generation',
    });
    res.status(error.status || 502).json({
      ok: false,
      error: classified.user_message || error.message || 'Sarah portrait generation failed.',
      category: classified.category,
      retryable: classified.retryable,
    });
  }
});
