import express from 'express';
import {
  prepareSarahConversationContext,
  readSarahLanguageProfile,
  saveSarahLanguageProfile,
} from '../services/sarahConversationContext.js';

export const sarahConversationRouter = express.Router();

sarahConversationRouter.post('/context', (req, res) => {
  try {
    res.json(prepareSarahConversationContext(req.body || {}));
  } catch (error) {
    console.error('[sarah-conversation] context failed', error);
    res.status(500).json({ error: error.message || String(error) });
  }
});

sarahConversationRouter.get('/language-profile', (_req, res) => {
  res.json(readSarahLanguageProfile());
});

sarahConversationRouter.put('/language-profile', (req, res) => {
  res.json(saveSarahLanguageProfile(req.body || {}));
});
