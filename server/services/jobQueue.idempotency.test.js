import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sarah-job-dedupe-'));
process.env.DATABASE_PATH = path.join(tempDir, 'jobs.sqlite');
const { initDb } = await import('../db.js');
initDb();
const { createJob, registerJobHandler } = await import('./jobQueue.js');

test('the same client request ID cannot enqueue duplicate paid work', () => {
  const type = `openai_dedupe_test_${Date.now()}`;
  registerJobHandler(type, async () => ({ ok: true }));
  const meta = { clientRequestId: 'one-explicit-user-action' };
  const first = createJob(type, { text: 'same payload' }, meta);
  const second = createJob(type, { text: 'same payload' }, meta);
  assert.equal(second.id, first.id);
});
