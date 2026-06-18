import assert from 'node:assert/strict';
import test from 'node:test';
import { MonotonicClock } from './clock.js';
import { EventQueue } from './eventQueue.js';
import { RingBuffer } from './ringBuffer.js';
import { TelemetryEngine } from './telemetryEngine.js';

test('ring buffer keeps newest samples and counts overwrites', () => {
  const buffer = new RingBuffer(3);
  buffer.push(1);
  buffer.push(2);
  buffer.push(3);
  buffer.push(4);
  assert.deepEqual(buffer.toArray(), [2, 3, 4]);
  assert.equal(buffer.latest(), 4);
  assert.equal(buffer.health().overwrites, 1);
});

test('monotonic clock never moves backward', () => {
  const clock = new MonotonicClock();
  const a = clock.now();
  const b = clock.now();
  assert.ok(b.monotonicMs >= a.monotonicMs);
  assert.ok(b.wallTimeMs >= a.wallTimeMs);
});

test('event queue rejects overflow without hiding it', () => {
  const queue = new EventQueue({ maxPending: 1 });
  assert.equal(queue.enqueue({ id: 'a' }), true);
  assert.equal(queue.enqueue({ id: 'b' }), false);
  assert.equal(queue.status().droppedStored, 1);
  assert.match(queue.status().lastWarning, /exceeded/);
});

test('engine snapshots valid HR and EMG samples', () => {
  const engine = new TelemetryEngine({ db: null, broadcastIntervalMs: 25 });
  engine.start();
  const hr = engine.ingestHrSample({ heartRate: 88, source: 'test' });
  const emg = engine.ingestEmgSample({ left_pct: 12, right_pct: 18 });
  const rejected = engine.ingestHrSample({ heartRate: 'nope' });
  const snapshot = engine.snapshot();
  assert.equal(hr.ok, true);
  assert.equal(emg.ok, true);
  assert.equal(rejected.ok, false);
  assert.equal(snapshot.hr.currentHr, 88);
  assert.equal(snapshot.emg.left_pct, 12);
  assert.equal(snapshot.engine.queue.pending, 2);
  engine.shutdown();
});
