import express from 'express';
import { publicProfileAnatomyInventory } from '../services/profileAnatomyImageIndex.js';

export const profileAnatomyIndexRouter = express.Router();

profileAnatomyIndexRouter.get('/inventory', (_req, res) => {
  try {
    res.json(publicProfileAnatomyInventory());
  } catch (error) {
    res.status(500).json({ error: error?.message || String(error) });
  }
});
