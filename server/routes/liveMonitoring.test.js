import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import Database from 'better-sqlite3';
import { EventEmitter } from 'node:events';
import { LiveMonitoring } from '../services/liveMonitoring.js';

test('production snapshot handler persists detection before any client connects', () => {
  const db = new Database(':memory:');
  db.exec('CREATE TABLE session(data TEXT)');
  db.prepare('INSERT INTO session VALUES (?)').run(JSON.stringify({ id: 'session', event_timeline: [] }));
  let now = Date.now();
  const start = now;
  const engine = new EventEmitter();
  const state = { session: { active: true, activeSessionId: 'session', startedAt: new Date(start).toISOString() },
    hr: { recording: { active: true } }, emg: {} };
  const getSession = () => JSON.parse(db.prepare('SELECT data FROM session').get().data);
  class TestMonitor extends LiveMonitoring {
    constructor(options) { super({ ...options, predict: () => ({ nearClimax: 75,
      buildEligibleForNearClimax: true, confirmationCount: 3, controllerConfidence: 80,
      multimodalTrusted: true, recovery: 0 }) }); }
    update(input) { return super.update(input, now); }
  }
  const context = vm.createContext({ LiveMonitoring: TestMonitor, state, telemetryEngine: engine,
    currentLiveSessionEntity: getSession,
    patchCurrentLiveSession: patch => db.prepare('UPDATE session SET data=?').run(JSON.stringify({ ...getSession(), ...patch })),
    broadcast: () => {}, broadcastOverlayHeartRate: () => {},
  });
  const source = fs.readFileSync(new URL('./liveCapture.js', import.meta.url), 'utf8');
  const startIndex = source.indexOf('let monitoringCivet =');
  const endIndex = source.indexOf('\nfunction cleanNumber', startIndex);
  vm.runInContext(source.slice(startIndex, endIndex).replace('export function', 'function'), context);
  try {
    for (let second = 0; second <= 30; second++) {
      now = start + second * 1000;
      engine.emit('snapshot', { hr: { measuredAt: now, heartRate: 100, hrv: { rmssdMs: 15 } } });
      if (second === 5) assert.equal(getSession().event_timeline.length, 1, 'saved at detection time, without a screen');
    }
    assert.equal(state.monitoring.candidateCount, 1);
    assert.equal(state.monitoring.historySize, 31);
    assert.equal(state.monitoring.latestAt, now);
    assert.equal(getSession().event_timeline[0].prediction.evidence_status, 'physiology_only');
    assert.equal(state.monitoring.stale, false);
  } finally { db.close(); }
});
