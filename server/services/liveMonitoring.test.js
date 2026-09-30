import test from 'node:test';
import assert from 'node:assert/strict';
import { LiveMonitoring } from './liveMonitoring.js';
import { createNativeH10Decoder } from './nativeH10Telemetry.js';
import { computeLiveClimaxPrediction } from '../../src/utils/liveClimaxPrediction.js';

const start = 1790000000000;
const high = { nearClimax: 75, buildEligibleForNearClimax: true, confirmationCount: 3,
  controllerConfidence: 80, multimodalTrusted: true, recovery: 0, reason: 'test signal' };
const sample = second => ({ sessionId: 'session-a', active: true, startedAt: new Date(start).toISOString(),
  hr: { measuredAt: start + second * 1000, heartRate: 110, baselineHr: 70, buildConfidence: 80,
    hrv: { rmssdMs: 12 + second / 100, quality: 'high', sampleCount: 180 } } });

test('candidate is emitted live without any screen, and repeats are deduplicated until recovery', () => {
  const events = []; let prediction = high;
  const monitor = new LiveMonitoring({ predict: () => prediction, onCandidate: event => events.push(event) });
  for (let second = 0; second <= 60; second++) monitor.update(sample(second), start + second * 1000);
  assert.equal(events.length, 1);
  assert.equal(events[0].time_s, 5);
  assert.equal(monitor.history.length, 61);
  assert.equal(monitor.snapshot(start + 60000).stale, false);
  prediction = { ...high, nearClimax: 30 };
  for (let second = 61; second <= 70; second++) monitor.update(sample(second), start + second * 1000);
  prediction = high;
  for (let second = 71; second <= 80; second++) monitor.update(sample(second), start + second * 1000);
  assert.equal(events.length, 2);
  assert.equal(events[1].time_s, 76);
});

test('paused, missing, stale and repeated samples cannot sustain a candidate', () => {
  const events = [];
  const monitor = new LiveMonitoring({ predict: () => high, onCandidate: event => events.push(event) });
  monitor.update(sample(0), start);
  for (let second = 1; second < 20; second++) monitor.update(sample(0), start + second * 1000);
  assert.equal(events.length, 0);
  assert.equal(monitor.snapshot(start + 20000).stale, true);
  monitor.update({ ...sample(20), paused: true }, start + 20000);
  monitor.update(sample(21), start + 21000);
  monitor.update(sample(22), start + 22000);
  monitor.update(sample(40), start + 40000);
  assert.equal(events.length, 0);
  monitor.update({ ...sample(41), sessionId: 'session-b', candidateCount: 3 }, start + 41000);
  assert.equal(monitor.history.length, 1);
  assert.equal(monitor.count, 3);
});

test('failed candidate persistence is retried before advancing its count', () => {
  let fail = true; const events = [];
  const monitor = new LiveMonitoring({ predict: () => high, onCandidate: event => {
    if (fail) throw Error('disk unavailable'); events.push(event);
  } });
  for (let second = 0; second < 5; second++) monitor.update(sample(second), start + second * 1000);
  assert.throws(() => monitor.update(sample(5), start + 5000), /disk unavailable/);
  assert.equal(monitor.count, 0);
  fail = false;
  monitor.update(sample(5), start + 5000);
  assert.equal(monitor.count, 1);
  assert.equal(events.length, 1);
});

test('real native HR/RR pipeline keeps HRV and predictions updating for ten minutes without UI', () => {
  const decode = createNativeH10Decoder();
  const monitor = new LiveMonitoring();
  for (let second = 0; second < 600; second++) {
    const bytes = Buffer.alloc(6);
    bytes[0] = 16; bytes[1] = 90 + second % 30;
    bytes.writeUInt16LE(650 + second % 55, 2);
    bytes.writeUInt16LE(680 - second % 40, 4);
    const hr = decode({ measuredAt: start + second * 1000, heartRatePacket: bytes.toString('hex'),
      packetId: `packet-${second}`, collectorId: 'phone', connectionId: 'connection', pmdFrames: [] });
    monitor.update({ ...sample(second), hr: { ...hr, baselineHr: 70, buildConfidence: 65, phase: 'build' } }, start + second * 1000);
  }
  assert.equal(monitor.history.length, 600);
  assert.ok(new Set(monitor.history.slice(100).map(row => row.hrvRmssd)).size > 10);
  assert.equal(monitor.latestAt, start + 599000);
  assert.equal(monitor.prediction.buildDurationSec, computeLiveClimaxPrediction(
    { heartRate: 119, baselineHr: 70, buildConfidence: 65, phase: 'build' }, null, monitor.history,
    { sessionTimeSec: 599 }).buildDurationSec);
  assert.equal(monitor.snapshot(start + 599000).stale, false);
});
