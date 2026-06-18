import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { MonotonicClock } from './clock.js';
import { EventQueue } from './eventQueue.js';
import { RingBuffer } from './ringBuffer.js';

function cleanNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function sampleAgeMs(sample, nowMs = Date.now()) {
  const t = Number(sample?.wallTimeMs) || Date.parse(sample?.receivedAt || '');
  return Number.isFinite(t) ? Math.max(0, nowMs - t) : null;
}

function rateFor(buffer, nowMs = Date.now(), windowMs = 10000) {
  const rows = buffer.toArray().filter((row) => {
    const t = Number(row?.wallTimeMs);
    return Number.isFinite(t) && nowMs - t <= windowMs;
  });
  return Math.round((rows.length / (windowMs / 1000)) * 10) / 10;
}

export class TelemetryEngine extends EventEmitter {
  constructor({
    db = null,
    clock = new MonotonicClock(),
    ringCapacity = 4096,
    maxPending = 50000,
    flushIntervalMs = 250,
    broadcastIntervalMs = 250,
    flushBatchSize = 1000,
  } = {}) {
    super();
    this.db = db;
    this.clock = clock;
    this.hrBuffer = new RingBuffer(ringCapacity);
    this.emgBuffer = new RingBuffer(ringCapacity);
    this.eventBuffer = new RingBuffer(ringCapacity);
    this.queue = new EventQueue({ maxPending });
    this.flushIntervalMs = flushIntervalMs;
    this.broadcastIntervalMs = broadcastIntervalMs;
    this.flushBatchSize = flushBatchSize;
    this.startedAt = new Date().toISOString();
    this.activeSessionId = null;
    this.storage = {
      ok: true,
      flushed: 0,
      failed: 0,
      lastWriteAt: null,
      lastError: null,
    };
    this.display = {
      snapshotsSent: 0,
      droppedDisplayUpdates: 0,
      pendingDirty: false,
      lastSnapshotAt: null,
    };
    this.flushTimer = null;
    this.broadcastTimer = null;
    this.insertTelemetryEvent = null;
    this.running = false;
  }

  start() {
    if (this.running) return;
    this.running = true;
    if (this.db) {
      this.insertTelemetryEvent = this.db.prepare(`
        INSERT INTO local_telemetry_events(
          id, session_id, kind, source, wall_time_ms, monotonic_ms, received_at, payload_json, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
    }
    this.flushTimer = setInterval(() => this.flush().catch(() => {}), this.flushIntervalMs);
    this.flushTimer.unref?.();
    this.broadcastTimer = setInterval(() => this.emitSnapshotIfDirty(), this.broadcastIntervalMs);
    this.broadcastTimer.unref?.();
  }

  async shutdown() {
    clearInterval(this.broadcastTimer);
    clearInterval(this.flushTimer);
    this.broadcastTimer = null;
    this.flushTimer = null;
    this.emitSnapshotIfDirty(true);
    await this.flush();
    this.running = false;
  }

  setActiveSession(sessionId) {
    const previousSessionId = this.activeSessionId;
    if (sessionId) {
      this.activeSessionId = sessionId;
      this.ingestEvent('session', 'session_start', { sessionId });
      return;
    }
    if (previousSessionId) this.ingestEvent('session', 'session_stop', { sessionId: previousSessionId });
    this.activeSessionId = null;
  }

  ingestHrSample(payload = {}, { source = payload.source || 'unknown' } = {}) {
    payload = payload && typeof payload === 'object' ? payload : {};
    const hr = cleanNumber(payload.currentHr ?? payload.heartRate ?? payload.hr);
    if (hr == null) return { ok: false, error: 'HR sample missing numeric heart rate.' };
    return this.ingestSample('hr', {
      ...payload,
      currentHr: hr,
      heartRate: hr,
      hr,
      source,
    }, source);
  }

  ingestEmgSample(payload = {}, { source = payload.source || 'emg_text_bridge' } = {}) {
    payload = payload && typeof payload === 'object' ? payload : {};
    const hasSignal = [
      payload.left_pct,
      payload.right_pct,
      payload.diff_pct,
      payload.level_pct,
      payload.left,
      payload.right,
      payload.level,
    ].some((value) => cleanNumber(value) != null);
    if (!hasSignal) return { ok: false, error: 'EMG sample missing numeric signal fields.' };
    return this.ingestSample('emg', { ...payload, source }, source);
  }

  ingestEvent(kind, source = 'live_capture', payload = {}) {
    return this.ingestSample(kind || 'event', { ...payload, source }, source, this.eventBuffer);
  }

  ingestSample(kind, payload, source = 'unknown', forcedBuffer = null) {
    const stamp = this.clock.now();
    const event = {
      id: randomUUID(),
      sessionId: this.activeSessionId,
      kind,
      source,
      ...stamp,
      payload: {
        ...payload,
        engineWallTimeMs: stamp.wallTimeMs,
        engineMonotonicMs: stamp.monotonicMs,
        engineReceivedAt: stamp.receivedAt,
      },
    };

    const buffer = forcedBuffer || (kind === 'hr' ? this.hrBuffer : kind === 'emg' ? this.emgBuffer : this.eventBuffer);
    buffer.push(event);
    const queued = this.queue.enqueue(event);
    this.display.pendingDirty = true;
    if (!queued) this.storage.ok = false;
    return { ok: queued, event };
  }

  async flush() {
    if (!this.insertTelemetryEvent) return { ok: true, flushed: 0 };
    const events = this.queue.drain(this.flushBatchSize);
    if (!events.length) return { ok: true, flushed: 0 };
    try {
      const tx = this.db.transaction((rows) => {
        for (const row of rows) {
          this.insertTelemetryEvent.run(
            row.id,
            row.sessionId,
            row.kind,
            row.source,
            row.wallTimeMs,
            row.monotonicMs,
            row.receivedAt,
            JSON.stringify(row.payload),
            new Date().toISOString(),
          );
        }
      });
      tx(events);
      this.storage.ok = true;
      this.storage.flushed += events.length;
      this.storage.lastWriteAt = new Date().toISOString();
      this.storage.lastError = null;
      return { ok: true, flushed: events.length };
    } catch (error) {
      this.storage.ok = false;
      this.storage.failed += events.length;
      this.storage.lastError = error.message || String(error);
      for (const event of events.reverse()) this.queue.pending.unshift(event);
      return { ok: false, flushed: 0, error: this.storage.lastError };
    }
  }

  emitSnapshotIfDirty(force = false) {
    if (!force && !this.display.pendingDirty) return;
    if (!force && this.display.lastSnapshotAt && Date.now() - this.display.lastSnapshotAt < this.broadcastIntervalMs) {
      this.display.droppedDisplayUpdates += 1;
      return;
    }
    this.display.pendingDirty = false;
    this.display.lastSnapshotAt = Date.now();
    this.display.snapshotsSent += 1;
    this.emit('snapshot', this.snapshot());
  }

  snapshot() {
    const nowMs = Date.now();
    const latestHr = this.hrBuffer.latest();
    const latestEmg = this.emgBuffer.latest();
    return {
      engine: {
        running: this.running,
        startedAt: this.startedAt,
        activeSessionId: this.activeSessionId,
        clock: {
          monotonicMs: this.clock.lastMonotonicMs,
          highResolution: true,
        },
        sampleRate: {
          hrHz: rateFor(this.hrBuffer, nowMs),
          emgHz: rateFor(this.emgBuffer, nowMs),
        },
        latest: {
          hrReceivedAt: latestHr?.receivedAt || null,
          emgReceivedAt: latestEmg?.receivedAt || null,
          hrAgeMs: sampleAgeMs(latestHr, nowMs),
          emgAgeMs: sampleAgeMs(latestEmg, nowMs),
        },
        buffers: {
          hr: this.hrBuffer.health(),
          emg: this.emgBuffer.health(),
          events: this.eventBuffer.health(),
        },
        queue: this.queue.status(),
        display: { ...this.display },
        storage: { ...this.storage },
      },
      hr: latestHr?.payload || null,
      emg: latestEmg?.payload || null,
    };
  }
}
