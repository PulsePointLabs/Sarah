import express from 'express';
import { getObsRecordingCoordinator } from '../services/obsRecordingCoordinator.js';

export const obsRecordingRouter = express.Router();
obsRecordingRouter.use((_req, res, next) => {
  res.set('Cache-Control', 'no-store');
  if (!getObsRecordingCoordinator()) return res.status(503).json({ error: 'The embedded OBS relay is unavailable.' });
  next();
});
obsRecordingRouter.get('/', (_req, res) => res.json(getObsRecordingCoordinator().snapshot()));
obsRecordingRouter.put('/', (req, res) => {
  try { res.json(getObsRecordingCoordinator().save(req.body || {})); }
  catch (error) { res.status(400).json({ error: error.message }); }
});
obsRecordingRouter.post('/test', async (_req, res) => {
  try {
    const controller = getObsRecordingCoordinator();
    if (!controller.peer?.ready) throw new Error(controller.peer?.error || 'Secondary OBS is not connected yet.');
    await controller.peer.request('GetRecordStatus');
    await controller.poll();
    res.json(controller.snapshot());
  } catch (error) { res.status(409).json({ error: error.message }); }
});
obsRecordingRouter.post('/start-secondary', async (_req, res) => {
  const controller = getObsRecordingCoordinator();
  if (!controller.primary.status().recording) return res.status(409).json({ error: 'Start the primary recording first.' });
  try {
    controller.warn('Secondary recording was started late. Its recording does not include the beginning of the session.');
    await controller.secondaryCommand('StartRecord');
    res.json(controller.snapshot());
  } catch (error) { res.status(409).json({ error: error.message }); }
});
