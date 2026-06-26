import 'dotenv/config.js';
import express from 'express';
import cors from 'cors';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { initDb } from './db.js';
import { rootDir, uploadDirs } from './config.js';
import { entitiesRouter } from './routes/entities.js';
import { aiRouter } from './routes/ai.js';
import { filesRouter } from './routes/files.js';
import { functionsRouter } from './routes/functions.js';
import { authRouter } from './routes/auth.js';
import { jobsRouter, largeJobsRouter } from './routes/jobs.js';
import { statusRouter } from './routes/status.js';
import { liveCaptureRouter } from './routes/liveCapture.js';
import { liveCuesRouter } from './routes/liveCues.js';
import { sarahBrandRouter } from './routes/sarahBrand.js';
import { localVisionRouter } from './routes/localVision.js';
import { howlRouter } from './routes/howl.js';
import { bloodPressureRouter } from './routes/bloodPressure.js';
import { sarahVsRouter } from './routes/sarahVs.js';
import { sessionVideoRouter } from './routes/sessionVideo.js';
import { startTelemetryEngine, telemetryEngine } from './localEngine/index.js';
import { startHeartRateRelay } from './services/hrRelay.js';
import { restorePersistedJobs } from './services/jobQueue.js';

const app = express();
const port = Number(process.env.PORT || 8787);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const distDir = path.resolve(rootDir, 'dist');
const hrOverlayDir = path.resolve(rootDir, 'tools', 'capture', 'heart-rate');

initDb();
restorePersistedJobs();
startTelemetryEngine();
await startHeartRateRelay();

app.use(cors());
app.use('/api/jobs/start-large', largeJobsRouter);
app.use(express.json({ limit: '50mb' }));
for (const dir of uploadDirs) {
  app.use('/uploads', express.static(dir, {
    setHeaders(res, filePath) {
      const ext = path.extname(filePath || '').toLowerCase();
      const cacheableMedia = new Set([
        '.jpg', '.jpeg', '.png', '.webp', '.gif',
        '.mp4', '.webm', '.mov', '.m4v',
        '.mp3', '.wav', '.m4a', '.aac',
      ]);
      if (cacheableMedia.has(ext)) {
        res.setHeader('Cache-Control', 'public, max-age=604800, immutable');
        return;
      }
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
      res.setHeader('Pragma', 'no-cache');
      res.setHeader('Expires', '0');
    },
  }));
}
app.use('/tools/capture/heart-rate', express.static(hrOverlayDir, {
  fallthrough: false,
  setHeaders(res) {
    res.setHeader('Cache-Control', 'no-store');
  },
}));

app.get('/api/health', (_req, res) => res.json({ ok: true, app: 'Sarah Local API' }));
app.use('/api/entities', entitiesRouter);
app.use('/api/ai', aiRouter);
app.use('/api/files', filesRouter);
app.use('/api/functions', functionsRouter);
app.use('/api/jobs', jobsRouter);
app.use('/api/status', statusRouter);
app.use('/api/live-capture', liveCaptureRouter);
app.use('/api/live-cues', liveCuesRouter);
app.use('/api/sarah-brand', sarahBrandRouter);
app.use('/api/local-vision', localVisionRouter);
app.use('/api/howl', howlRouter);
app.use('/api/blood-pressure', bloodPressureRouter);
app.use('/api/sarahvs', sarahVsRouter);
app.use('/api/session-video', sessionVideoRouter);
app.use('/api/auth', authRouter);

if (process.env.SARAH_SERVE_STATIC === '1') {
  app.use(express.static(distDir));
  app.get('*', (_req, res) => {
    res.sendFile(path.join(distDir, 'index.html'));
  });
}

const server = app.listen(port, () => {
  console.log(`Sarah local API running on http://localhost:${port}`);
});

async function shutdown(signal) {
  console.log(`Sarah local API received ${signal}; flushing telemetry engine before shutdown.`);
  await telemetryEngine.shutdown();
  server.close(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
