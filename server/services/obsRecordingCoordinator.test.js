import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ObsRecordingCoordinator, validateSecondarySettings } from './obsRecordingCoordinator.js';

const tick = () => new Promise((resolve) => setImmediate(resolve));
function fixture(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'sarah-obs-test-'));
  const calls = [];
  let coordinator;
  const primaryState = { connected: true, identified: true, recording: false, paused: false };
  let secondaryRecording = false;
  let primaryGate = null;
  const primary = {
    status: () => ({ ...primaryState }),
    request: async (type) => {
      calls.push(`primary:${type}`);
      if (type === 'GetRecordStatus') return { outputActive: primaryState.recording, outputPaused: primaryState.paused, outputDuration: 1000 };
      if (type === 'StartRecord') {
        if (primaryGate) await primaryGate;
        coordinator.primaryEvent({ outputState: 'OBS_WEBSOCKET_OUTPUT_STARTING', outputActive: false });
        primaryState.recording = true;
        coordinator.primaryEvent({ outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED', outputActive: true });
      }
      if (type === 'StopRecord') {
        coordinator.primaryEvent({ outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPING', outputActive: true });
        primaryState.recording = false;
        coordinator.primaryEvent({ outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED', outputActive: false, outputPath: 'primary.mkv' });
      }
      return { outputPath: 'primary.mkv' };
    },
  };
  const peer = { ready: true, error: '', connect() {}, close() {},
    async request(type) {
      calls.push(`secondary:${type}`);
      if (type === 'GetRecordStatus') return { outputActive: secondaryRecording, outputPaused: false, outputDuration: 970 };
      if (type === 'StartRecord') {
        secondaryRecording = true;
        coordinator.secondaryEvent({ outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED', outputActive: true });
      }
      if (type === 'StopRecord') {
        secondaryRecording = false;
        coordinator.secondaryEvent({ outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED', outputActive: false, outputPath: 'secondary.mkv' });
      }
      return { outputPath: 'secondary.mkv' };
    },
  };
  coordinator = new ObsRecordingCoordinator({ primary, directory, peerFactory: () => peer });
  coordinator.save({ enabled: true, url: 'ws://second-computer:4455', password: 'test-secret' });
  t.after(() => {
    coordinator.close();
    assert.equal(path.dirname(directory), os.tmpdir());
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return { coordinator, primaryState, peer, calls, directory, gate: (value) => { primaryGate = value; } };
}

test('Sarah dispatches both starts before primary acknowledgment, repeated clicks send only one', async (t) => {
  const f = fixture(t);
  let release;
  f.gate(new Promise((resolve) => { release = resolve; }));
  const first = f.coordinator.startRecording();
  const second = f.coordinator.startRecording();
  await tick();
  assert.equal(f.calls.filter((v) => v === 'secondary:StartRecord').length, 1);
  assert.equal(f.calls.filter((v) => v === 'primary:StartRecord').length, 1);
  assert.equal(f.primaryState.recording, false);
  release(); await Promise.all([first, second]);
  assert.equal(f.calls.filter((v) => v === 'secondary:StartRecord').length, 1);
  assert.equal(f.coordinator.run.timing.frameAlignmentVerified, false);
  assert.ok(Math.abs(f.coordinator.run.timing.estimatedStartDifferenceMs - 30) <= 10);
});

test('starting primary OBS directly starts secondary once, without sending a command back to primary', async (t) => {
  const f = fixture(t);
  f.coordinator.primaryEvent({ outputState: 'OBS_WEBSOCKET_OUTPUT_STARTING' });
  f.primaryState.recording = true;
  f.coordinator.primaryEvent({ outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED' });
  f.coordinator.primaryEvent({ outputState: 'OBS_WEBSOCKET_OUTPUT_STARTED' });
  await tick();
  assert.equal(f.calls.filter((v) => v === 'secondary:StartRecord').length, 1);
  assert.equal(f.calls.filter((v) => v === 'primary:StartRecord').length, 0);
});

test('secondary failure does not stop primary; warnings are retained', async (t) => {
  const f = fixture(t); f.peer.ready = false;
  await f.coordinator.startRecording();
  assert.equal(f.primaryState.recording, true);
  assert.ok(f.coordinator.run.warnings.some((warning) => warning.includes('unavailable')));
  assert.equal(f.calls.includes('primary:StopRecord'), false);
});

test('stop synchronizes both recorders once and keeps each remote file path', async (t) => {
  const f = fixture(t); await f.coordinator.startRecording();
  await Promise.all([f.coordinator.stopRecording(), f.coordinator.stopRecording()]);
  assert.equal(f.calls.filter((v) => v === 'primary:StopRecord').length, 1);
  assert.equal(f.calls.filter((v) => v === 'secondary:StopRecord').length, 1);
  assert.equal(f.coordinator.run.primary.outputPath, 'primary.mkv');
  assert.equal(f.coordinator.run.secondary.outputPath, 'secondary.mkv');
  const saved = JSON.parse(fs.readFileSync(path.join(f.directory, `${f.coordinator.run.id}.json`)));
  assert.equal(saved.secondary.outputPath, 'secondary.mkv');
});

test('manually stopping secondary never stops primary', async (t) => {
  const f = fixture(t); await f.coordinator.startRecording();
  f.coordinator.secondaryEvent({ outputState: 'OBS_WEBSOCKET_OUTPUT_STOPPED', outputPath: 'angle.mkv' });
  assert.equal(f.calls.includes('primary:StopRecord'), false);
  assert.ok(f.coordinator.run.warnings.some((warning) => warning.includes('still recording')));
});

test('secondary settings persist server-side, secrets stay out of snapshots and survive blank edits', (t) => {
  const f = fixture(t);
  assert.equal(JSON.stringify(f.coordinator.snapshot()).includes('test-secret'), false);
  f.coordinator.save({ enabled: true, url: 'ws://second-computer:4455', password: '' });
  assert.equal(f.coordinator.settings.password, 'test-secret');
  const saved = JSON.parse(fs.readFileSync(path.join(f.directory, 'settings.json')));
  assert.equal(saved.password, 'test-secret');
  f.coordinator.save({ enabled: false, clearPassword: true });
  assert.equal(f.coordinator.publicSettings().passwordSaved, false);
});

test('settings cannot change during capture and secondary cannot point at primary', async (t) => {
  const f = fixture(t); await f.coordinator.startRecording();
  assert.throws(() => f.coordinator.save({ enabled: false }), /Stop both/);
  for (const url of ['ws://localhost:4455', 'ws://127.0.0.1:4455', 'http://second:4455', 'ws://name:secret@second:4455']) {
    assert.throws(() => validateSecondarySettings({ enabled: true, url }));
  }
});

test('disabled secondary preserves primary-only behavior', async (t) => {
  const f = fixture(t); f.coordinator.save({ enabled: false });
  await f.coordinator.startRecording(); await f.coordinator.stopRecording();
  assert.equal(f.calls.some((v) => v.startsWith('secondary:')), false);
  assert.equal(f.coordinator.run, null);
});

test('pause and resume are one-way from primary', async (t) => {
  const f = fixture(t); await f.coordinator.startRecording();
  f.coordinator.primaryEvent({ outputState: 'OBS_WEBSOCKET_OUTPUT_PAUSED' }); await tick();
  assert.equal(f.calls.filter((v) => v === 'secondary:PauseRecord').length, 1);
  assert.equal(f.calls.includes('primary:PauseRecord'), false);
});
