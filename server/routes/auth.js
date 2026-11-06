import express from 'express';
import { getEntityFields, upsertEntity } from '../db.js';

export const authRouter = express.Router();

function parseFields(value) {
  if (!value) return null;
  const fields = Array.isArray(value) ? value : String(value).split(',');
  const cleaned = fields.map((field) => String(field || '').trim()).filter(Boolean);
  return cleaned.length ? cleaned : null;
}

function projectUser(user, fields) {
  if (!fields?.length || !user) return user;
  const out = {};
  for (const field of fields) {
    if (field in user) out[field] = user[field];
  }
  if (user.id != null) out.id = user.id;
  if (user.created_date != null) out.created_date = user.created_date;
  if (user.updated_date != null) out.updated_date = user.updated_date;
  return out;
}

authRouter.get('/me', (req, res) => {
  const fields = parseFields(req.query.fields);
  res.json(projectUser(getEntityFields('User', 'local-user', fields), fields));
});

authRouter.patch('/me', (req, res) => {
  res.json(upsertEntity('User', 'local-user', req.body || {}));
});

const voiceSettingId = 'sarah-voice-preferences';
const voiceFields = ['tts', 'personality'];

authRouter.get('/me/voice', (_req, res) => {
  const current = getEntityFields('AppSetting', voiceSettingId, ['tts', 'personality']);
  res.json(Object.fromEntries(voiceFields.filter((key) => current?.[key]).map((key) => [key, current[key]])));
});

authRouter.patch('/me/voice', (req, res) => {
  const current = getEntityFields('AppSetting', voiceSettingId, voiceFields);
  const changes = {};
  for (const key of voiceFields) {
    const value = req.body?.[key];
    if (value && typeof value === 'object' && !Array.isArray(value) && (!req.query.seed || !current?.[key])) {
      changes[key] = value;
    }
  }
  const saved = Object.keys(changes).length
    ? upsertEntity('AppSetting', voiceSettingId, { key: voiceSettingId, ...changes })
    : current;
  res.json(Object.fromEntries(voiceFields.filter((key) => saved?.[key]).map((key) => [key, saved[key]])));
});
