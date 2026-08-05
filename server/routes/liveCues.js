import express from 'express';
import { TTS_CONTENT_TYPES } from '../services/ttsCore.js';
import { prepareLiveCueAudioClip, readLiveCueAudioFile } from '../services/liveCueAudioCache.js';
import { classifyProviderError } from '../../src/lib/providerErrorClassifier.js';

export const liveCuesRouter = express.Router();

async function prepareInBatches(clips, settings, concurrency = 3) {
  const prepared = new Array(clips.length);
  const failures = [];
  let cursor = 0;
  async function worker() {
    while (cursor < clips.length) {
      const index = cursor;
      cursor += 1;
      const clip = clips[index];
      try {
        prepared[index] = await prepareLiveCueAudioClip({
          text: clip.text,
          voice: clip.voice || settings.voice,
          model: clip.model || settings.model,
          speed: clip.speed || settings.speed,
          format: clip.format || settings.format,
          profileVersion: settings.profileVersion,
        });
      } catch (error) {
        failures.push({
          index,
          text: clip.text,
          error: error?.message || String(error),
        });
      }
    }
  }
  await Promise.all(Array.from(
    { length: Math.min(concurrency, clips.length) },
    () => worker()
  ));
  return { prepared: prepared.filter(Boolean), failures };
}

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
    const requested = clips.slice(0, 48);
    const { prepared, failures } = await prepareInBatches(requested, {
      voice,
      model,
      speed,
      format,
      profileVersion,
    });
    if (!prepared.length) {
      const error = new Error(failures[0]?.error || 'No live cue audio could be prepared');
      error.status = 502;
      throw error;
    }
    res.json({
      ok: true,
      partial: failures.length > 0,
      clips: prepared,
      failures,
    });
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
