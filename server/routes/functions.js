import express from 'express';
import { bulkCreate, deleteEntity, listEntities, upsertEntity } from '../db.js';
import { aiInvokeInternal } from './internalAi.js';

export const functionsRouter = express.Router();

function b64ToBuffer(b64) {
  const clean = String(b64 || '').replace(/^data:.*?;base64,/, '');
  return Buffer.from(clean, 'base64');
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 25000) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try { return await fetch(url, { ...options, signal: controller.signal }); }
  finally { clearTimeout(t); }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clampSpeed(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0.25 && parsed <= 4 ? parsed : 1.0;
}

const DEFAULT_TTS_INSTRUCTIONS = 'Read with friendly analytical enthusiasm, like an engaged physiologist explaining a fascinating finding to someone they know well. Keep a smooth natural cadence, varied inflection, and clear sentence-level pauses. Sound warm and alive, not formal, monotone, sultry, or announcer-like.';

const TTS_CONTENT_TYPES = {
  mp3: 'audio/mpeg',
  opus: 'audio/ogg',
  aac: 'audio/aac',
  flac: 'audio/flac',
  wav: 'audio/wav',
  pcm: 'application/octet-stream',
};

function normalizeTTSFormat(value) {
  const format = String(value || process.env.OPENAI_TTS_FORMAT || 'mp3').toLowerCase();
  return TTS_CONTENT_TYPES[format] ? format : 'mp3';
}

function getTTSInstructions(requestedInstructions) {
  const instructions = requestedInstructions ?? process.env.OPENAI_TTS_INSTRUCTIONS ?? DEFAULT_TTS_INSTRUCTIONS;
  return String(instructions || '').trim();
}

function supportsTTSInstructions(model) {
  return !String(model || '').startsWith('tts-1');
}

async function callOpenAITTS(body, meta) {
  const maxAttempts = Number(process.env.OPENAI_TTS_BACKEND_ATTEMPTS || 3);
  let lastStatus = 502;
  let lastMessage = 'Unknown OpenAI TTS error';

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const startedAt = Date.now();
    try {
      const response = await fetchWithTimeout('https://api.openai.com/v1/audio/speech', {
        method: 'POST',
        headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      }, Number(process.env.OPENAI_TTS_TIMEOUT_MS || 30000));
      const latencyMs = Date.now() - startedAt;

      if (response.ok) {
        console.info('[openaiTTS] success', { ...meta, latencyMs, retries: attempt });
        return { response, latencyMs, retries: attempt };
      }

      lastStatus = response.status;
      lastMessage = await response.text();
      const retryable = [408, 429, 500, 502, 503, 504].includes(response.status);
      console.warn('[openaiTTS] upstream error', { ...meta, status: response.status, latencyMs, attempt: attempt + 1, retryable, message: lastMessage.slice(0, 300) });
      if (!retryable || attempt === maxAttempts - 1) break;

      const retryAfter = response.headers.get('retry-after');
      const delay = retryAfter
        ? Math.min(Math.max(Number(retryAfter) * 1000, 1000), 8000)
        : Math.min(900 * 2 ** attempt, 8000) + Math.floor(Math.random() * 400);
      await sleep(delay);
    } catch (error) {
      lastMessage = error.message || String(error);
      console.warn('[openaiTTS] exception', { ...meta, attempt: attempt + 1, message: lastMessage });
      if (attempt === maxAttempts - 1) break;
      await sleep(Math.min(900 * 2 ** attempt, 8000));
    }
  }

  const error = new Error(lastMessage);
  error.status = lastStatus;
  throw error;
}

functionsRouter.post('/saveTimelineData', (req, res) => {
  const { session_id, entity, rows = [], action } = req.body || {};
  if (!session_id || !['HeartRateTimeline', 'EMGTimeline'].includes(entity)) {
    return res.status(400).json({ error: 'Missing or invalid session_id/entity' });
  }
  const timeKey = entity === 'EMGTimeline' ? 'time_s' : 'time_offset_s';

  if (action === 'fetch') {
    const out = listEntities(entity)
      .filter((r) => r.session === session_id)
      .sort((a, b) => Number(a[timeKey] || 0) - Number(b[timeKey] || 0));
    return res.json({ ok: true, rows: out, count: out.length });
  }

  if (action === 'clear') {
    const existing = listEntities(entity).filter((r) => r.session === session_id).slice(0, 200);
    existing.forEach((r) => deleteEntity(entity, r.id));
    return res.json({ ok: true, action: 'clear', deleted: existing.length, done: existing.length < 200 });
  }

  const finalRows = entity === 'HeartRateTimeline' && rows.length > 10000
    ? rows.filter((_r, i) => i % Math.ceil(rows.length / 10000) === 0)
    : rows;
  bulkCreate(entity, finalRows.map((r) => ({ ...r, session: session_id })));
  res.json({ ok: true, inserted: finalRows.length, original: rows.length });
});

functionsRouter.post('/purgeEMGData', (req, res) => {
  const { session_id } = req.body || {};
  const rows = listEntities('EMGTimeline').filter((r) => !session_id || r.session === session_id).slice(0, 1000);
  rows.forEach((r) => deleteEntity('EMGTimeline', r.id));
  res.json({ ok: true, deleted: rows.length, done: rows.length < 1000 });
});

functionsRouter.post('/openaiTTS', async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'Missing OPENAI_API_KEY' });
    const {
      text,
      voice = 'nova',
      speed = 1.0,
      instructions: requestedInstructions,
      format: requestedFormat,
    } = req.body || {};
    const input = String(text || '').trim();
    if (!input) return res.status(400).json({ error: 'Missing text' });
    const maxChars = Number(process.env.OPENAI_TTS_MAX_CHARS || 2500);
    if (input.length > maxChars) {
      return res.status(413).json({ error: 'Text chunk too large', length: input.length, maxLength: maxChars });
    }
    const model = process.env.OPENAI_TTS_MODEL || 'gpt-4o-mini-tts';
    const finalSpeed = clampSpeed(speed);
    const responseFormat = normalizeTTSFormat(requestedFormat);
    const body = {
      model,
      input,
      voice,
      response_format: responseFormat,
      speed: finalSpeed,
    };
    const instructions = getTTSInstructions(requestedInstructions);
    if (instructions && supportsTTSInstructions(model)) body.instructions = instructions;
    const meta = {
      chunkIndex: req.body?.chunkIndex,
      charCount: input.length,
      estimatedDurationSec: Math.max(1, Math.round(input.split(/\s+/).filter(Boolean).length / 2.25)),
      model,
      voice,
      speed: finalSpeed,
      format: responseFormat,
    };
    const { response, latencyMs, retries } = await callOpenAITTS(body, meta);
    const buffer = Buffer.from(await response.arrayBuffer());
    res.setHeader('Content-Type', TTS_CONTENT_TYPES[responseFormat]);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-TTS-Model', model);
    res.setHeader('X-TTS-Voice', voice);
    res.setHeader('X-TTS-Speed', String(finalSpeed));
    res.setHeader('X-TTS-Format', responseFormat);
    res.setHeader('X-TTS-Latency-Ms', String(latencyMs));
    res.setHeader('X-TTS-Retries', String(retries));
    res.send(buffer);
  } catch (error) {
    res.status(error.status || 502).json({ error: error.message || String(error), retryable: true });
  }
});

functionsRouter.post('/whisperSTT', async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'Missing OPENAI_API_KEY' });
    const { audio_base64, mime_type = 'audio/webm', prompt } = req.body || {};
    if (!audio_base64) return res.status(400).json({ error: 'No audio provided' });
    const form = new FormData();
    const blob = new Blob([b64ToBuffer(audio_base64)], { type: mime_type });
    form.append('file', blob, 'audio.webm');
    form.append('model', 'whisper-1');
    form.append('language', 'en');
    if (prompt) form.append('prompt', prompt);
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form,
    });
    if (!response.ok) return res.status(response.status).json({ error: await response.text() });
    const data = await response.json();
    res.json({ text: data.text });
  } catch (error) {
    res.status(500).json({ error: error.message || String(error) });
  }
});

functionsRouter.post('/generateJournal', async (req, res) => {
  try {
    const { session_id, voice_transcript, session_data } = req.body || {};
    if (!session_id) return res.status(400).json({ error: 'session_id required' });
    const s = session_data || {};
    const sessionContext = [
      s.date ? `Date: ${new Date(s.date).toLocaleDateString('en-US', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })}` : null,
      s.duration_minutes ? `Duration: ${s.duration_minutes} minutes` : null,
      s.methods?.length ? `Methods: ${s.methods.join(', ')}` : null,
      s.intensity != null ? `Intensity: ${s.intensity}/10` : null,
      s.satisfaction != null ? `Satisfaction: ${s.satisfaction}/10` : null,
      s.avg_hr ? `Avg HR: ${s.avg_hr} bpm` : null,
      s.max_hr ? `Max HR: ${s.max_hr} bpm` : null,
      s.notes ? `Session notes: ${s.notes}` : null,
      s.event_timeline?.length ? `Event timeline: ${s.event_timeline.slice(0, 10).map(e => `[${Math.floor(e.time_s / 60)}:${String(Math.round(e.time_s % 60)).padStart(2, '0')}] ${e.note}`).join(' | ')}` : null,
    ].filter(Boolean).join('\n');
    const transcriptSection = voice_transcript?.trim() ? `\n\nNOTES FROM THE PERSON:\n"${voice_transcript.trim()}"` : '';
    const prompt = `You are a compassionate physiological journal assistant. Write in second person. SESSION DATA:\n${sessionContext}${transcriptSection}\n\nWrite a structured journal entry using JSON keys: title, emotional_reflection, physiological_observations, experience_narrative, key_moments, insights, next_session_intentions.`;
    const result = await aiInvokeInternal({ model: 'claude_sonnet_4_6', prompt, response_json_schema: {
      type: 'object', properties: {
        title: { type: 'string' }, emotional_reflection: { type: 'string' }, physiological_observations: { type: 'string' }, experience_narrative: { type: 'string' }, key_moments: { type: 'array', items: { type: 'string' } }, insights: { type: 'string' }, next_session_intentions: { type: 'string' }
      }
    }});
    const payload = { session_id, session_date: s.date, voice_transcript, generated_entry: result, title: result.title };
    const created = upsertEntity('Journal', crypto.randomUUID(), payload);
    res.json({ journal: created, result });
  } catch (error) {
    res.status(502).json({ error: error.message || String(error) });
  }
});
