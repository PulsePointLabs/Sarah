import fs from 'node:fs/promises';
import path from 'node:path';
import { dataDir } from '../config.js';

const payloadDir = path.join(dataDir, 'job-payloads');

function safePayloadPath(id) {
  const safeId = String(id || '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safeId) throw new Error('Invalid payload reference');
  return path.join(payloadDir, `${safeId}.json`);
}

export async function saveJobPayload(payload) {
  await fs.mkdir(payloadDir, { recursive: true });
  const id = crypto.randomUUID();
  await fs.writeFile(safePayloadPath(id), JSON.stringify(payload || {}), 'utf8');
  return { id, path: safePayloadPath(id) };
}

export async function loadJobPayload(id) {
  const text = await fs.readFile(safePayloadPath(id), 'utf8');
  return JSON.parse(text);
}

export async function deleteJobPayload(id) {
  if (!id) return;
  try {
    await fs.unlink(safePayloadPath(id));
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}
