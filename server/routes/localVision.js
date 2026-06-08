import express from 'express';
import fs from 'node:fs';
import { analyzeLocalVisionWindow } from '../services/localVision/analyzeWindow.js';
import { analyzeLocalVisionContinuous } from '../services/localVision/continuousAnalyzer.js';
import { analyzeLocalVisionAdaptive } from '../services/localVision/adaptiveAnalyzer.js';
import { analyzeLocalVisionForward } from '../services/localVision/forwardAnalyzer.js';
import { askLocalVisionVideo } from '../services/localVision/videoQa.js';
import { resolveCachedFramePath } from '../services/localVision/frameSampler.js';
import { getLocalVisionHealth } from '../services/localVision/localVisionClient.js';
import { getQuestionBank } from '../services/localVision/questionBank.js';
import { listLocalVisionResults } from '../services/localVision/persistence.js';

export const localVisionRouter = express.Router();

localVisionRouter.get('/health', async (_req, res) => {
  res.json(await getLocalVisionHealth());
});

localVisionRouter.get('/questions', (_req, res) => {
  res.json({ questions: getQuestionBank() });
});

localVisionRouter.post('/analyze-window', async (req, res) => {
  if (process.env.LOCAL_VISION_ENABLED === 'false') {
    return res.status(403).json({ error: 'Local vision is disabled by LOCAL_VISION_ENABLED=false.' });
  }
  try {
    const result = await analyzeLocalVisionWindow(req.body || {});
    res.json(result);
  } catch (error) {
    res.status(error?.status || 500).json({
      ok: false,
      error: error?.message || 'Local vision analysis failed.',
      privacy: { localOnly: true, cloudUpload: false },
      warnings: error?.warnings || [],
    });
  }
});

localVisionRouter.post('/analyze-continuous', async (req, res) => {
  if (process.env.LOCAL_VISION_ENABLED === 'false') {
    return res.status(403).json({ error: 'Local vision is disabled by LOCAL_VISION_ENABLED=false.' });
  }
  try {
    const result = await analyzeLocalVisionContinuous(req.body || {});
    res.json(result);
  } catch (error) {
    res.status(error?.status || 500).json({
      ok: false,
      error: error?.message || 'Continuous local vision analysis failed.',
      privacy: { localOnly: true, cloudUpload: false },
      warnings: error?.warnings || [],
    });
  }
});

localVisionRouter.post('/analyze-adaptive', async (req, res) => {
  if (process.env.LOCAL_VISION_ENABLED === 'false') {
    return res.status(403).json({ error: 'Local vision is disabled by LOCAL_VISION_ENABLED=false.' });
  }
  try {
    const result = await analyzeLocalVisionAdaptive(req.body || {});
    res.json(result);
  } catch (error) {
    res.status(error?.status || 500).json({
      ok: false,
      error: error?.message || 'Adaptive local vision analysis failed.',
      privacy: { localOnly: true, cloudUpload: false },
      warnings: error?.warnings || [],
    });
  }
});

localVisionRouter.post('/analyze-forward', async (req, res) => {
  if (process.env.LOCAL_VISION_ENABLED === 'false') {
    return res.status(403).json({ error: 'Local vision is disabled by LOCAL_VISION_ENABLED=false.' });
  }
  try {
    const result = await analyzeLocalVisionForward(req.body || {});
    res.json(result);
  } catch (error) {
    res.status(error?.status || 500).json({
      ok: false,
      error: error?.message || 'Forward local vision review failed.',
      privacy: { localOnly: true, cloudUpload: false },
      warnings: error?.warnings || [],
    });
  }
});

localVisionRouter.post('/ask-video', async (req, res) => {
  if (process.env.LOCAL_VISION_ENABLED === 'false') {
    return res.status(403).json({ error: 'Local vision is disabled by LOCAL_VISION_ENABLED=false.' });
  }
  try {
    const result = await askLocalVisionVideo(req.body || {});
    res.json(result);
  } catch (error) {
    res.status(error?.status || 500).json({
      ok: false,
      error: error?.message || 'Local video Q&A failed.',
      privacy: { localOnly: true, cloudUpload: false },
      warnings: error?.warnings || [],
    });
  }
});

localVisionRouter.get('/results', (req, res) => {
  try {
    res.json({
      results: listLocalVisionResults({
        sessionId: req.query.sessionId,
        recordType: req.query.recordType,
        limit: req.query.limit,
      }),
    });
  } catch (error) {
    res.status(500).json({ error: error?.message || 'Could not list local vision results.' });
  }
});

localVisionRouter.get('/frame/:sessionPart/:windowPart/:filename', (req, res) => {
  try {
    const filePath = resolveCachedFramePath(req.params.sessionPart, req.params.windowPart, req.params.filename);
    if (!fs.existsSync(filePath)) return res.status(404).json({ error: 'Local vision frame not found.' });
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'private, max-age=86400');
    fs.createReadStream(filePath).pipe(res);
  } catch (error) {
    res.status(error?.status || 400).json({ error: error?.message || 'Invalid local vision frame path.' });
  }
});
