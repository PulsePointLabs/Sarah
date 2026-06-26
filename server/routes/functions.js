import express from 'express';
import { bulkCreate, deleteEntity, listEntities } from '../db.js';
import { aiInvokeInternal } from './internalAi.js';
import { renderTTSExport } from '../services/ttsRenderer.js';
import {
  TTS_CONTENT_TYPES,
  synthesizeTTSChunk,
} from '../services/ttsCore.js';
import { classifyProviderError } from '../../src/lib/providerErrorClassifier.js';

export const functionsRouter = express.Router();
const ttsRenderJobs = new Map();

function b64ToBuffer(b64) {
  const clean = String(b64 || '').replace(/^data:.*?;base64,/, '');
  return Buffer.from(clean, 'base64');
}

function normalizeAudioMimeType(value = 'audio/webm') {
  const raw = String(value || 'audio/webm').toLowerCase();
  if (raw.includes('ogg') || raw.includes('oga')) return { mimeType: 'audio/ogg', extension: 'ogg' };
  if (raw.includes('mp4') || raw.includes('m4a')) return { mimeType: 'audio/mp4', extension: 'm4a' };
  if (raw.includes('mpeg') || raw.includes('mp3')) return { mimeType: 'audio/mpeg', extension: 'mp3' };
  if (raw.includes('wav')) return { mimeType: 'audio/wav', extension: 'wav' };
  if (raw.includes('webm')) return { mimeType: 'audio/webm', extension: 'webm' };
  return { mimeType: 'audio/webm', extension: 'webm' };
}

async function readOpenAIError(response) {
  const raw = await response.text();
  try {
    const parsed = JSON.parse(raw);
    return parsed?.error?.message || parsed?.message || raw;
  } catch {
    return raw;
  }
}

function setTtsRenderProgress(jobId, patch) {
  if (!jobId) return;
  const previous = ttsRenderJobs.get(jobId) || {};
  const next = {
    ...previous,
    ...patch,
    jobId,
    updatedAt: new Date().toISOString(),
  };
  ttsRenderJobs.set(jobId, next);
  if (['complete', 'error'].includes(next.phase)) {
    setTimeout(() => ttsRenderJobs.delete(jobId), 10 * 60 * 1000).unref?.();
  }
}

function normalizeGeneratedJournal(value) {
  const source = value?.generated_entry && typeof value.generated_entry === 'object'
    ? value.generated_entry
    : value;
  const journal = {
    title: source?.title || 'Session Journal',
    emotional_reflection: String(source?.emotional_reflection || '').trim(),
    physiological_observations: String(source?.physiological_observations || '').trim(),
    experience_narrative: String(source?.experience_narrative || '').trim(),
    key_moments: Array.isArray(source?.key_moments) ? source.key_moments.filter(Boolean) : [],
    insights: String(source?.insights || '').trim(),
    next_session_intentions: String(source?.next_session_intentions || '').trim(),
  };
  const missing = [
    'emotional_reflection',
    'physiological_observations',
    'experience_narrative',
    'insights',
    'next_session_intentions',
  ].filter((key) => !journal[key]);
  if (!journal.key_moments.length) missing.push('key_moments');
  if (missing.length) {
    const error = new Error(`AI journal was incomplete: missing ${missing.join(', ')}`);
    error.status = 502;
    throw error;
  }
  return journal;
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
      model: requestedModel,
      speed = 1.0,
      instructions: requestedInstructions,
      format: requestedFormat,
    } = req.body || {};
    const result = await synthesizeTTSChunk({
      text,
      voice,
      model: requestedModel,
      speed,
      instructions: requestedInstructions,
      format: requestedFormat,
      meta: {
        chunkIndex: req.body?.chunkIndex,
      },
    });
    res.setHeader('Content-Type', TTS_CONTENT_TYPES[result.format]);
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-TTS-Model', result.model);
    res.setHeader('X-TTS-Voice', result.voice);
    res.setHeader('X-TTS-Speed', String(result.speed));
    res.setHeader('X-TTS-Format', result.format);
    res.setHeader('X-TTS-Latency-Ms', String(result.latencyMs));
    res.setHeader('X-TTS-Retries', String(result.retries));
    res.setHeader('Content-Length', String(result.buffer.length));
    res.send(result.buffer);
  } catch (error) {
    const providerError = classifyProviderError(error, {
      provider: 'openai',
      requestStage: 'openai_tts',
    });
    res.status(error.status || 502).json({
      error: providerError.user_message || error.message || String(error),
      provider_error: providerError,
      length: error.length,
      maxLength: error.maxLength,
      retryable: providerError.retryable,
    });
  }
});

functionsRouter.get('/ttsRenderProgress/:jobId', (req, res) => {
  const job = ttsRenderJobs.get(req.params.jobId);
  if (!job) {
    return res.json({
      jobId: req.params.jobId,
      phase: 'unknown',
      current: 0,
      total: 0,
      message: 'Waiting for render to start…',
    });
  }
  res.json(job);
});

functionsRouter.post('/renderTTSExport', async (req, res) => {
  const jobId = String(req.body?.jobId || crypto.randomUUID());
  try {
    const result = await renderTTSExport({ ...req.body, jobId }, {
      jobId,
      onProgress: (progress) => setTtsRenderProgress(jobId, progress),
    });
    res.json(result);
  } catch (error) {
    console.error('[renderTTSExport] failed', error);
    setTtsRenderProgress(jobId, {
      phase: 'error',
      message: error.message || String(error),
    });
    res.status(error.status || 502).json({ error: error.message || String(error), retryable: true });
  }
});

functionsRouter.post('/whisperSTT', async (req, res) => {
  try {
    if (!process.env.OPENAI_API_KEY) return res.status(500).json({ error: 'Missing OPENAI_API_KEY' });
    const { audio_base64, mime_type = 'audio/webm', prompt } = req.body || {};
    if (!audio_base64) return res.status(400).json({ error: 'No audio provided' });
    const { mimeType, extension } = normalizeAudioMimeType(mime_type);
    const form = new FormData();
    const blob = new Blob([b64ToBuffer(audio_base64)], { type: mimeType });
    form.append('file', blob, `audio.${extension}`);
    form.append('model', 'whisper-1');
    form.append('language', 'en');
    if (prompt) form.append('prompt', prompt);
    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form,
    });
    if (!response.ok) {
      const message = await readOpenAIError(response);
      return res.status(response.status).json({
        error: message,
        provider: 'openai',
        endpoint: 'audio/transcriptions',
      });
    }
    const data = await response.json();
    res.json({ text: data.text });
  } catch (error) {
    const message = error.message || String(error);
    res.status(500).json({
      error: /Invalid URL\s+\(POST\s+\/v1\/audio\/transcriptions\)/i.test(message)
        ? 'Whisper reached the transcription layer, but the OpenAI client received a relative transcription URL. Restart the local API so Sarah uses the direct OpenAI Whisper route.'
        : message,
    });
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
      s.build_quality != null ? `Build quality: ${s.build_quality}/10` : null,
      s.build_type ? `Build type: ${s.build_type}` : null,
      s.climax_duration ? `Climax duration: ${s.climax_duration}` : null,
      s.no_climax ? 'No climax this session' : null,
      s.mood ? `Mood: ${s.mood}` : null,
      s.session_context?.blood_pressure?.systolic_mm_hg && s.session_context?.blood_pressure?.diastolic_mm_hg
        ? `Blood pressure context: ${s.session_context.blood_pressure.systolic_mm_hg}/${s.session_context.blood_pressure.diastolic_mm_hg} mmHg${s.session_context.blood_pressure.pulse_bpm ? `, pulse ${s.session_context.blood_pressure.pulse_bpm} bpm` : ''}${s.session_context.blood_pressure.measured_at ? `, measured ${s.session_context.blood_pressure.measured_at}` : ''}`
        : null,
      Array.isArray(s.pulse_ox_readings) && s.pulse_ox_readings.length
        ? `Pulse oximetry: ${s.pulse_ox_readings.length} samples, average SpO2 ${s.avg_spo2_percent || ''}%, minimum SpO2 ${s.min_spo2_percent || ''}%${s.avg_pulse_ox_pulse_bpm ? `, average pulse ${s.avg_pulse_ox_pulse_bpm} bpm` : ''}`
        : null,
      s.avg_hr ? `Avg HR: ${s.avg_hr} bpm` : null,
      s.max_hr ? `Max HR: ${s.max_hr} bpm` : null,
      s.hr_at_climax ? `HR at climax: ${s.hr_at_climax} bpm` : null,
      s.ejaculate_volume ? `Ejaculate volume: ${s.ejaculate_volume}` : null,
      s.discomfort ? `Discomfort noted: ${s.discomfort_notes || 'yes'}` : null,
      s.discomfort_entries?.length ? `Discomfort entries: ${s.discomfort_entries.map(d => `severity ${d.severity}/10 - ${d.note}`).join('; ')}` : null,
      s.unusual_sensations ? `Unusual sensations: ${s.unusual_sensations}` : null,
      s.hydration ? `Hydration: ${s.hydration}` : null,
      s.substances?.length ? `Substances: ${s.substances.join(', ')}` : null,
      s.foley_size ? `Foley size: ${s.foley_size}` : null,
      s.foley_type ? `Foley type: ${s.foley_type}` : null,
      s.estim_notes ? `E-stim notes: ${s.estim_notes}` : null,
      s.refractory_notes ? `Refractory notes: ${s.refractory_notes}` : null,
      s.notes ? `Session notes: ${s.notes}` : null,
      s.event_timeline?.length ? `Event timeline: ${s.event_timeline.slice(0, 10).map(e => `[${Math.floor(e.time_s / 60)}:${String(Math.round(e.time_s % 60)).padStart(2, '0')}] ${e.note}`).join(' | ')}` : null,
    ].filter(Boolean).join('\n');
    const profile = s.user_profile || {};
    const profileContext = profile && Object.keys(profile).length ? [
      `Age: ${profile.age || ''}`,
      `Fitness level: ${profile.fitness_level || ''}`,
      `Resting heart rate: ${profile.resting_hr || ''}`,
      `Maximum heart rate: ${profile.max_hr || ''}`,
      `Arousal response style: ${profile.arousal_response_style || ''}`,
      `Typical build duration: ${profile.typical_build_duration || ''}`,
      `Climax sensitivity: ${profile.climax_sensitivity || ''}`,
      `Preferred stimulation: ${Array.isArray(profile.preferred_stimulation) ? profile.preferred_stimulation.join(', ') : profile.preferred_stimulation || ''}`,
      `Refractory pattern: ${profile.refractory_pattern || ''}`,
      `Arousal notes: ${profile.arousal_notes || ''}`,
      `Profile notes: ${profile.profile_notes || profile.notes || ''}`,
    ].filter((line) => !line.endsWith(': ')).join('\n') : '';
    const transcriptSection = voice_transcript?.trim()
      ? `\n\nNOTES FROM THE PERSON (written or transcribed immediately after session):\n"${voice_transcript.trim()}"`
      : '';
    const prompt = `You are a compassionate physiological journal assistant. Write in second person ("you", "your") directly to the person. Your writing is warm, introspective, and data-grounded.

GLOBAL PROFILE REFERENCE:
${profileContext || 'No saved profile context was available. Rely only on the session data and the person\'s notes.'}

GLOBAL EVIDENCE AND INTERPRETATION RULES:
- Treat the profile as background context, not as a replacement for the current session facts.
- Separate observed facts from interpretation.
- Do not infer intent, strategy, motivation, or goals unless the person explicitly wrote it in notes, journal text, event annotations, or profile context.
- Avoid claims like "trying to avoid climax", "intentionally edging", "choosing to delay", "suppressing climax", or "holding back" unless explicitly logged.
- Use neutral physiological language when intent is not stated.

CRITICAL FOR TEXT-TO-SPEECH:
- Write all numbers as words (e.g., "eight out of ten", "seventy-two beats per minute")
- Use natural spoken prose - no bullet headers, no markdown
- Short, flowing sentences with natural pauses

SESSION DATA:
${sessionContext}
${transcriptSection}

Write a structured journal entry using EXACTLY these JSON keys. All fields are required and must be non-empty strings (or array for key_moments):
- title: a short evocative title (not just the date)
- emotional_reflection: 2-3 sentences about the emotional tone
- physiological_observations: 2-3 sentences grounding the experience in physiological data
- experience_narrative: 3-4 sentences weaving the full arc as a personal narrative
- key_moments: array of 2-4 brief strings, one per notable moment
- insights: 1-2 sentences of meaningful insight
- next_session_intentions: 1-2 sentences of intentions for next time`;
    let rawResult = await aiInvokeInternal({ model: 'claude_sonnet_4_6', max_tokens: 4096, prompt, response_json_schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        emotional_reflection: { type: 'string' },
        physiological_observations: { type: 'string' },
        experience_narrative: { type: 'string' },
        key_moments: { type: 'array', items: { type: 'string' } },
        insights: { type: 'string' },
        next_session_intentions: { type: 'string' },
      },
      required: ['title', 'emotional_reflection', 'physiological_observations', 'experience_narrative', 'key_moments', 'insights', 'next_session_intentions'],
    }});
    let result = rawResult?.response ?? rawResult;
    let journal;
    try {
      journal = normalizeGeneratedJournal(result);
    } catch {
      rawResult = await aiInvokeInternal({ model: 'claude_sonnet_4_6', max_tokens: 4096, prompt: `${prompt}

IMPORTANT COMPLETENESS CHECK:
Return a complete object this time. Do not return only a title. Every required string field must contain full prose, and key_moments must contain at least two items.`, response_json_schema: {
        type: 'object',
        properties: {
          title: { type: 'string' },
          emotional_reflection: { type: 'string' },
          physiological_observations: { type: 'string' },
          experience_narrative: { type: 'string' },
          key_moments: { type: 'array', items: { type: 'string' } },
          insights: { type: 'string' },
          next_session_intentions: { type: 'string' },
        },
        required: ['title', 'emotional_reflection', 'physiological_observations', 'experience_narrative', 'key_moments', 'insights', 'next_session_intentions'],
      }});
      result = rawResult?.response ?? rawResult;
      journal = normalizeGeneratedJournal(result);
    }
    res.json({ journal });
  } catch (error) {
    res.status(502).json({ error: error.message || String(error) });
  }
});
