import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import express from 'express';

test('real command routes preserve high levels and respect live channel limits', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'sarah-howl-range-'));
  const previousDatabase = process.env.DATABASE_PATH;
  process.env.DATABASE_PATH = path.join(dir, 'test.sqlite');
  let db, deviceServer, apiServer;
  try {
    const database = await import('../db.js');
    db = database.db;
    database.initDb();
    const { howlRouter } = await import('../routes/howl.js');
    const options = { power_a: 80, power_b: 120, power_a_limit: 199, power_b_limit: 200 };
    const sent = [];
    const device = express();
    device.use(express.json());
    device.post('/status', (req, res) => {
      assert.equal(req.headers.authorization, 'Bearer fixture-only');
      res.json({ options });
    });
    device.post('/set_power', (req, res) => {
      sent.push(req.body);
      Object.assign(options, req.body);
      res.json({ options });
    });
    deviceServer = device.listen(0, '127.0.0.1');
    await new Promise(resolve => deviceServer.once('listening', resolve));
    database.upsertEntity('HowlControlSettings', 'default', {
      safetySettingsVersion: 2, intensityCeiling: 200,
      controlEnabled: true, dispatchMode: 'direct_http',
      controlUrl: `http://127.0.0.1:${deviceServer.address().port}`, remoteAccessKey: 'fixture-only',
    });
    const api = express();
    api.use(express.json());
    api.use('/api/howl', howlRouter);
    apiServer = api.listen(0, '127.0.0.1');
    await new Promise(resolve => apiServer.once('listening', resolve));
    const url = `http://127.0.0.1:${apiServer.address().port}/api/howl`;
    const post = async (endpoint, body) => {
      const response = await fetch(url + endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
      assert.equal(response.status, 200);
      return response.json();
    };
    const saved = await post('/control/settings', { controlEnabled: true, intensityCeiling: 200 });
    assert.equal(saved.settings.intensityCeiling, 200);
    await post('/control', { action: 'increment_power', channel: 'a', step: 1 });
    assert.deepEqual(sent.at(-1), { power_a: 81 });
    await post('/control', { action: 'set_power', channel: 'all', intensity: 180 });
    assert.deepEqual(sent.at(-1), { power_a: 83, power_b: 122 });
    Object.assign(options, { power_a: 198, power_b: 199 });
    await post('/control', { action: 'set_power', channel: 'all', intensity: 200 });
    assert.deepEqual(sent.at(-1), { power_a: 199, power_b: 200 });
    options.power_a_limit = 197;
    await post('/control', { action: 'increment_power', channel: 'a', step: 1 });
    assert.deepEqual(sent.at(-1), { power_a: 197 });
  } finally {
    await Promise.all([deviceServer, apiServer].filter(Boolean).map(server => new Promise(resolve => server.close(resolve))));
    db?.close();
    if (previousDatabase == null) delete process.env.DATABASE_PATH;
    else process.env.DATABASE_PATH = previousDatabase;
    if (path.dirname(path.resolve(dir)) !== path.resolve(os.tmpdir()) || !path.basename(dir).startsWith('sarah-howl-range-')) throw Error('Unexpected test cleanup path');
    await rm(dir, { recursive: true, force: true });
  }
});
