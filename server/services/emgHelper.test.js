import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createEmgHelper } from './emgHelper.js';

test('managed EMG validates ports, prevents duplicate collectors, preserves paths and closes gracefully', async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sarah-emg-test-'));
  const launches = [];
  const process = new EventEmitter(); process.stdout = new EventEmitter(); process.stderr = new EventEmitter();
  const manager = createEmgHelper({ emgTextDir: directory, emgSessionsDir: path.join(directory, 'sessions'), hrObsWsUrl: 'ws://127.0.0.1:4455', hrObsPassword: 'fixture-secret' }, {
    exec: async () => ({ stdout: JSON.stringify([{ port: 'COM7', label: 'Arduino' }]) }),
    spawn: (...args) => { launches.push(args); return process; },
  });
  try {
    await assert.rejects(manager.start({ port: 'COM999' }), /unavailable/);
    assert.equal(launches.length, 0);
    await manager.start({ port: 'COM7', channels: 2 });
    await manager.start({ port: 'COM7', channels: 2 });
    assert.equal(launches.length, 1);
    await assert.rejects(manager.start({ port: 'COM7', channels: 1 }), /Disconnect/);
    const options = launches[0][2];
    assert.equal(options.windowsHide, true);
    assert.equal(options.env.EMG_HEADLESS, '1');
    assert.equal(options.env.EMG_LEFT_TEXT_PATH, path.join(directory, 'emg_left.txt'));
    assert.equal(options.env.OBS_HOST, '127.0.0.1');
    assert.equal(JSON.stringify(manager.status()).includes('fixture-secret'), false);
    await manager.stop();
    assert.equal(await fs.readFile(path.join(directory, 'emg_stop'), 'utf8'), 'stop');
    process.emit('exit', 0);
    assert.equal(manager.status().running, false);
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
