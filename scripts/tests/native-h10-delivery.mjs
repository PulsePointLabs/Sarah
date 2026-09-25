// Isolated route integration: never contacts the user's OBS or production database.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import express from 'express';
import { WebSocketServer } from 'ws';

const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'sarah-h10-test-'));
process.env.DATABASE_PATH = path.join(dir, 'test.sqlite');
process.env.DATA_DIR = dir;
process.env.HR_RECORDINGS_DIR = path.join(dir, 'recordings');
process.env.EMG_TEXT_DIR = path.join(dir, 'emg');
process.env.EMG_SESSIONS_DIR = path.join(dir, 'emg-sessions');
const relay = new WebSocketServer({ port: 0, host: '127.0.0.1' });
await new Promise((resolve) => relay.once('listening', resolve));
process.env.HR_CAPTURE_WS_URL = `ws://127.0.0.1:${relay.address().port}`;
const connected = new Promise((resolve) => relay.once('connection', resolve));
const { initDb, db } = await import('../../server/db.js');
initDb();
const { liveCaptureRouter } = await import('../../server/routes/liveCapture.js');
const app = express(); app.use(express.json()); app.use('/capture', liveCaptureRouter);
const server = app.listen(0, '127.0.0.1');
await new Promise((resolve) => server.once('listening', resolve));
const base = `http://127.0.0.1:${server.address().port}/capture`;
const post = async (route, body) => fetch(base + route, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
try {
  const socket = await connected;
  const start = Date.now() - 180_000;
  socket.send(JSON.stringify({ type: 'obs_record_state', active: true, startedAtMs: start, outputPath: path.join(dir, 'test.mkv') }));
  let status;
  for (let i = 0; i < 50; i++) {
    status = await (await fetch(base + '/status')).json();
    if (status.hr?.directH10Recording?.filepath) break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.ok(status.hr.directH10Recording.filepath);
  const session = status.session.activeSessionId;
  const packet = { nativeH10: true, packetId: randomUUID(), connectionId: randomUUID(), collectorId: 'phone', collectorKind: 'APK',
    heartRatePacket: '105a00040003', measuredAt: start + 60000, pmdFrames: [] };
  assert.equal((await post('/hr-direct-h10/claim', { collectorId: 'phone', collectorKind: 'APK' })).status, 200);
  let response = await post('/hr-direct-h10/telemetry', packet);
  assert.equal(response.status, 200);
  assert.equal((await response.json()).nativeAcknowledged, true);
  // Simulate a lost acknowledgement: resend the exact same saved phone packet.
  response = await post('/hr-direct-h10/telemetry', packet);
  assert.equal((await response.json()).nativeAcknowledged, true);
  const csv = await fs.readFile(status.hr.directH10Recording.filepath, 'utf8');
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, 2, 'one physical HR reading produces one saved row');
  assert.ok(lines[1].includes('60.000'), 'buffered packet belongs at 1:00, not 3:00 delivery time');
  assert.ok(lines[1].includes(new Date(packet.measuredAt).toISOString()));
  assert.equal(db.prepare('SELECT count(*) n FROM native_h10_receipts').get().n, 1);
  response = await post('/hr-direct-h10/claim', { collectorId: 'chrome-monitor', collectorKind: 'Chrome' });
  assert.equal(response.status, 409, 'second device cannot steal the active collector');
  for (let i = 0; i < 3; i++) {
    response = await post('/ensure-session', {});
    assert.equal((await response.json()).sessionId, session, 'monitor cannot create a duplicate session');
  }
  const newer = { ...packet, packetId: randomUUID(), measuredAt: Date.now() };
  response = await post('/hr-direct-h10/telemetry', newer);
  assert.equal(response.status, 200);
  status = await (await fetch(base + '/status')).json();
  assert.equal(status.hr.latestTelemetry.heartRate, 90);
  assert.equal(status.hr.latestTelemetry.measuredAt, newer.measuredAt);
  const zero = { ...newer, packetId: randomUUID(), heartRatePacket: '0000' };
  response = await post('/hr-direct-h10/telemetry', zero);
  assert.equal(response.status, 200, 'a zero-HR packet must not wedge the native FIFO');
  assert.equal((await response.json()).nativeAcknowledged, true);
  assert.equal(JSON.parse(db.prepare('SELECT payload FROM native_h10_receipts WHERE packet_id = ?').get(zero.packetId).payload).heartRatePacket, '0000', 'unusable readings are preserved, not invented or dropped');
  const malformed = { ...zero, packetId: randomUUID(), heartRatePacket: '105a00' };
  response = await post('/hr-direct-h10/telemetry', malformed);
  assert.equal((await response.json()).nativeAcknowledged, true, 'malformed readings are durably quarantined');
  const delayed = { ...packet, packetId: randomUUID(), measuredAt: start + 61000 };
  response = await post('/hr-direct-h10/telemetry', delayed);
  assert.equal(response.status, 200);
  status = await (await fetch(base + '/status')).json();
  assert.equal(Date.parse(status.hr.directH10.lastMeasuredAt), newer.measuredAt, 'backlog cannot replace current connection freshness');
  assert.equal(status.hr.latestTelemetry.measuredAt, newer.measuredAt);
  assert.ok(db.prepare('SELECT payload FROM native_h10_receipts WHERE packet_id = ?').get(delayed.packetId).payload, 'out-of-order data remains recoverable even when CSV has advanced');
  const previousInstall = { ...delayed, packetId: randomUUID(), collectorId: 'old-phone-id', measuredAt: start - 1000 };
  response = await post('/hr-direct-h10/telemetry', previousInstall);
  assert.equal((await response.json()).archived, true, 'old collector backlog is archived without stealing the live collector');
  status = await (await fetch(base + '/status')).json();
  assert.equal(status.hr.directH10.collectorId, 'phone');
  assert.equal((await post('/hr-direct-h10/telemetry', { ...previousInstall, packetId: randomUUID(), measuredAt: Date.now() })).status, 409, 'fresh foreign collectors still cannot steal ownership');
  console.log('PASS: original timestamps, durable ack, retry deduplication, collector ownership, shared session, live stream');
  process.exitCode = 0;
} catch (error) {
  console.error(error); process.exitCode = 1;
} finally {
  server.closeAllConnections(); server.close();
  for (const socket of relay.clients) socket.terminate();
  relay.close(); db.close();
  const resolved = path.resolve(dir);
  if (path.dirname(resolved) === path.resolve(os.tmpdir()) && path.basename(resolved).startsWith('sarah-h10-test-')) await fs.rm(resolved, { recursive: true, force: true });
  process.exit(process.exitCode || 0);
}
