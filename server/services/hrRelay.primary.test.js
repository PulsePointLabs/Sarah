import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import WebSocket, { WebSocketServer } from 'ws';
import { HeartRateRelay } from './hrRelay.js';
import { liveCaptureConfig } from '../config.js';

test('primary recorder switches to a remote OBS endpoint, authenticates and tests read-only', async () => {
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'sarah-primary-obs-'));
  const previous = { url: liveCaptureConfig.hrObsWsUrl, password: liveCaptureConfig.hrObsPassword };
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise(resolve => server.once('listening', resolve));
  const commands = [];
  let authenticated = false;
  const secret = 'fixture-password';
  const hash = value => crypto.createHash('sha256').update(value).digest('base64');
  server.on('connection', socket => {
    socket.send(JSON.stringify({ op: 0, d: { rpcVersion: 1, authentication: { salt: 'salt', challenge: 'challenge' } } }));
    socket.on('message', raw => {
      const message = JSON.parse(raw.toString());
      if (message.op === 1) {
        authenticated = message.d.authentication === hash(hash(secret + 'salt') + 'challenge');
        socket.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } }));
      } else if (message.op === 6) {
        commands.push(message.d.requestType);
        socket.send(JSON.stringify({ op: 7, d: {
          requestId: message.d.requestId, requestStatus: { result: true, code: 100 },
          responseData: { outputActive: false, outputPaused: false },
        } }));
      }
    });
  });
  const settingsPath = path.join(temporary, 'primary.json');
  const relay = new HeartRateRelay({ WebSocket, WebSocketServer, primarySettingsPath: settingsPath });
  try {
    const url = `ws://127.0.0.1:${server.address().port}`;
    relay.savePrimaryObsConnection({ url, password: secret });
    for (let attempt = 0; attempt < 100 && !relay.obsIdentified; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.ok(relay.obsIdentified);
    assert.ok(authenticated);
    await relay.obsRequest('GetRecordStatus');
    const snapshot = relay.recordingCoordinator.snapshot();
    assert.equal(snapshot.primaryConnection.passwordSaved, true);
    assert.equal(JSON.stringify(snapshot).includes(secret), false);
    assert.equal(fs.readFileSync(settingsPath, 'utf8').includes(secret), true);
    assert.ok(commands.includes('GetRecordStatus'));
    assert.equal(commands.some(type => /StartRecord|StopRecord|SetCurrent/.test(type)), false);
    relay.obsRecordActive = true;
    assert.throws(() => relay.savePrimaryObsConnection({ url }), /finished/);
    relay.obsRecordActive = false;
    assert.throws(() => relay.savePrimaryObsConnection({ url: 'ws://user:secret@host:4455' }), /password separately/);
  } finally {
    relay.stop();
    for (const client of server.clients) client.terminate();
    await new Promise(resolve => server.close(resolve));
    liveCaptureConfig.hrObsWsUrl = previous.url;
    liveCaptureConfig.hrObsPassword = previous.password;
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});
