import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { initDb } from './db.js';
import { uploadDir } from './config.js';
import { entitiesRouter } from './routes/entities.js';
import { aiRouter } from './routes/ai.js';
import { filesRouter } from './routes/files.js';
import { functionsRouter } from './routes/functions.js';
import { authRouter } from './routes/auth.js';
import { jobsRouter } from './routes/jobs.js';
import { statusRouter } from './routes/status.js';
import { liveCaptureRouter } from './routes/liveCapture.js';
import { restorePersistedJobs } from './services/jobQueue.js';

const app = express();
const port = Number(process.env.PORT || 8787);

initDb();
restorePersistedJobs();

app.use(cors());
app.use(express.json({ limit: '50mb' }));
app.use('/uploads', express.static(uploadDir));

app.get('/api/health', (_req, res) => res.json({ ok: true, app: 'PulsePoint Standalone API' }));
app.use('/api/entities', entitiesRouter);
app.use('/api/ai', aiRouter);
app.use('/api/files', filesRouter);
app.use('/api/functions', functionsRouter);
app.use('/api/jobs', jobsRouter);
app.use('/api/status', statusRouter);
app.use('/api/live-capture', liveCaptureRouter);
app.use('/api/auth', authRouter);

app.listen(port, () => {
  console.log(`PulsePoint local API running on http://localhost:${port}`);
});
