import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import express from 'express';
import WebSocket, { WebSocketServer } from 'ws';

const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'sarah-obs-integration-'));
Object.assign(process.env, { DATA_DIR: directory, DATABASE_PATH: path.join(directory, 'test.sqlite'),
  HR_RECORDINGS_DIR: path.join(directory, 'hr'), EMG_TEXT_DIR: path.join(directory, 'emg'), EMG_SESSIONS_DIR: path.join(directory, 'emg-sessions') });
const waitFor = async (check) => {
  for (let i = 0; i < 150; i++) { const value = await check(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 20)); }
  throw new Error('Timed out waiting for test state');
};
async function fakeObs(name, password = '') {
  const server = new WebSocketServer({ port: 0, host: '127.0.0.1' });
  await new Promise((resolve) => server.once('listening', resolve));
  const state = { active: false, paused: false, started: 0, commands: [] };
  const event = (suffix) => {
    const payload = JSON.stringify({ op: 5, d: { eventType: 'RecordStateChanged', eventData: {
      outputState: `OBS_WEBSOCKET_OUTPUT_${suffix}`, outputActive: state.active, outputPath: `${name}.mkv`,
    } } });
    for (const socket of server.clients) if (socket.readyState === WebSocket.OPEN) socket.send(payload);
  };
  server.on('connection', (socket) => {
    socket.send(JSON.stringify({ op: 0, d: { rpcVersion: 1, ...(password ? { authentication: { salt: 'salt', challenge: 'challenge' } } : {}) } }));
    socket.on('message', (raw) => {
      const message = JSON.parse(String(raw));
      if (message.op === 1) {
        const hash = (value) => crypto.createHash('sha256').update(value).digest('base64');
        if (password && message.d.authentication !== hash(hash(password + 'salt') + 'challenge')) { socket.close(4009); return; }
        socket.send(JSON.stringify({ op: 2, d: { negotiatedRpcVersion: 1 } })); return;
      }
      if (message.op !== 6) return;
      const { requestType, requestId } = message.d;
      state.commands.push({ type: requestType, at: performance.now() });
      let responseData = {};
      if (requestType === 'GetRecordStatus') responseData = { outputActive: state.active, outputPaused: state.paused, outputDuration: state.active ? Date.now() - state.started : 0 };
      if (requestType === 'StartRecord') { event('STARTING'); state.active = true; state.started = Date.now(); event('STARTED'); }
      if (requestType === 'StopRecord') { event('STOPPING'); state.active = false; event('STOPPED'); responseData = { outputPath: `${name}.mkv` }; }
      if (requestType === 'PauseRecord') { state.paused = true; event('PAUSED'); }
      if (requestType === 'ResumeRecord') { state.paused = false; event('RESUMED'); }
      socket.send(JSON.stringify({ op: 7, d: { requestId, requestStatus: { result: true, code: 100 }, responseData } }));
    });
  });
  return { server, state, event, url: `ws://127.0.0.1:${server.address().port}` };
}

const primary = await fakeObs('primary');
const secondary = await fakeObs('secondary', 'test-password');
const { liveCaptureConfig } = await import('../../server/config.js');
liveCaptureConfig.hrObsWsUrl = primary.url;
liveCaptureConfig.hrRelayPort = 0;
const { db, initDb, listEntities } = await import('../../server/db.js'); initDb();
const { HeartRateRelay } = await import('../../server/services/hrRelay.js');
const relay = new HeartRateRelay({ WebSocket, WebSocketServer }).start();
await new Promise((resolve) => relay.appWss.once('listening', resolve));
liveCaptureConfig.hrWsUrl = `ws://127.0.0.1:${relay.appWss.address().port}`;
const { liveCaptureRouter } = await import('../../server/routes/liveCapture.js');
const { obsRecordingRouter } = await import('../../server/routes/obsRecording.js');
const app = express(); app.use(express.json()); app.use('/capture', liveCaptureRouter); app.use('/obs', obsRecordingRouter);
const server = app.listen(0, '127.0.0.1'); await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const control = new WebSocket(liveCaptureConfig.hrWsUrl);
await new Promise((resolve) => control.once('open', resolve));
try {
  await waitFor(() => relay.obsIdentified);
  let response = await fetch(`${base}/obs`, { method: 'PUT', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled: true, url: secondary.url, password: 'test-password' }) });
  assert.equal(response.status, 200);
  assert.equal(JSON.stringify(await response.json()).includes('test-password'), false);
  await waitFor(() => relay.recordingCoordinator.peer.ready);
  response = await fetch(`${base}/obs/test`, { method: 'POST' }); assert.equal(response.status, 200);
  assert.equal(primary.state.active, false); assert.equal(secondary.state.active, false);
  control.send(JSON.stringify({ type: 'obs_start_record', source: 'isolated_test' }));
  control.send(JSON.stringify({ type: 'obs_start_record', source: 'duplicate_test' }));
  await waitFor(() => primary.state.active && secondary.state.active && listEntities('Session').length === 1);
  assert.equal(primary.state.commands.filter((v) => v.type === 'StartRecord').length, 1);
  assert.equal(secondary.state.commands.filter((v) => v.type === 'StartRecord').length, 1);
  const firstRun = relay.recordingCoordinator.run.id;
  await waitFor(() => listEntities('Session')[0]?.obs_recording_sync?.id === firstRun);
  const skew = Math.abs(primary.state.commands.find((v) => v.type === 'StartRecord').at - secondary.state.commands.find((v) => v.type === 'StartRecord').at);
  assert.ok(skew < 100, `Local simulated OBS commands were ${skew} ms apart`);
  // Secondary events never become a second Sarah session boundary.
  secondary.event('STARTED'); await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(listEntities('Session').length, 1);
  primary.state.paused = true; primary.event('PAUSED');
  await waitFor(() => secondary.state.paused);
  primary.state.paused = false; primary.event('RESUMED');
  await waitFor(() => !secondary.state.paused);
  control.send(JSON.stringify({ type: 'obs_stop_record', source: 'isolated_test' }));
  await waitFor(() => !primary.state.active && !secondary.state.active);
  await waitFor(() => listEntities('Session')[0]?.obs_recording_sync?.secondary?.outputPath === 'secondary.mkv');
  assert.equal(listEntities('Session').length, 1);
  assert.equal(listEntities('Session')[0].obs_recording_sync.primary.outputPath, 'primary.mkv');
  // Manual primary OBS start still follows; it creates exactly one additional session.
  await new Promise((resolve) => setTimeout(resolve, 1100));
  primary.event('STARTING'); primary.state.active = true; primary.state.started = Date.now(); primary.event('STARTED');
  await waitFor(() => secondary.state.active && listEntities('Session').length === 2);
  assert.notEqual(relay.recordingCoordinator.run.id, firstRun);
  assert.equal(secondary.state.commands.filter((v) => v.type === 'StartRecord').length, 2);
  assert.ok([...primary.state.commands, ...secondary.state.commands].every((v) => ['GetRecordStatus', 'StartRecord', 'StopRecord', 'PauseRecord', 'ResumeRecord'].includes(v.type)));
  console.log(`PASS: authenticated real WebSockets, simultaneous dispatch (${skew.toFixed(1)} ms in local simulation), primary-follow, pause/resume, HTTP settings, no overlay commands, one session per recording, persisted both file paths`);
  process.exitCode = 0;
} catch (error) { console.error(error); process.exitCode = 1; }
finally {
  control.terminate(); relay.stop();
  for (const fake of [primary, secondary]) { for (const socket of fake.server.clients) socket.terminate(); fake.server.close(); }
  server.closeAllConnections(); server.close();
  await new Promise((resolve) => setTimeout(resolve, 100)); db.close();
  if (path.dirname(directory) === os.tmpdir() && path.basename(directory).startsWith('sarah-obs-integration-')) await fs.rm(directory, { recursive: true, force: true });
  process.exit(process.exitCode || 0);
}
