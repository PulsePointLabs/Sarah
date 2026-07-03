import express from 'express';
import { TTS_CONTENT_TYPES } from '../services/ttsCore.js';
import { prepareLiveCueAudioClip, readLiveCueAudioFile } from '../services/liveCueAudioCache.js';
import { classifyProviderError } from '../../src/lib/providerErrorClassifier.js';

export const liveCuesRouter = express.Router();

liveCuesRouter.post('/prepare', async (req, res) => {
  const {
    clips = [],
    voice = 'nova',
    model = 'tts-1-hd',
    speed = 1,
    format = 'mp3',
    profileVersion,
  } = req.body || {};
  if (!Array.isArray(clips) || !clips.length) {
    return res.status(400).json({ error: 'No cue clips requested' });
  }
  try {
    const prepared = [];
    for (const clip of clips.slice(0, 40)) {
      prepared.push(await prepareLiveCueAudioClip({
        text: clip.text,
        voice: clip.voice || voice,
        model: clip.model || model,
        speed: clip.speed || speed,
        format: clip.format || format,
        profileVersion,
      }));
    }
    res.json({ ok: true, clips: prepared });
  } catch (error) {
    const classified = classifyProviderError(error, {
      provider: 'openai',
      requestStage: 'live_cue_audio_prepare',
    });
    res.status(error.status || 502).json({
      ok: false,
      error: classified.user_message || error.message || String(error),
      category: classified.category,
      retryable: classified.retryable,
    });
  }
});

liveCuesRouter.get('/audio/:filename', async (req, res) => {
  try {
    const buffer = await readLiveCueAudioFile(req.params.filename);
    const format = String(req.params.filename || '').split('.').pop().toLowerCase();
    res.setHeader('Content-Type', TTS_CONTENT_TYPES[format] || 'audio/mpeg');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.send(buffer);
  } catch (error) {
    res.status(error.status || 404).json({ error: error.message || String(error) });
  }
});
