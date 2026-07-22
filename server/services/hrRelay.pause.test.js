import assert from 'node:assert/strict';
import test from 'node:test';
import { HeartRateRelay } from './hrRelay.js';

test('OBS pause and resume keep one active recording and publish boundaries', () => {
  const relay = new HeartRateRelay({ WebSocket: { OPEN: 1 }, WebSocketServer: class {} });
  const messages = [];
  relay.broadcast = (message) => messages.push(message);
  relay.broadcastRelayStatus = () => {};
  relay.obsRecordActive = true;
  relay.currentRecording = { pauseIntervals: [] };

  relay.handleObsEvent('RecordStateChanged', {
    outputActive: true,
    outputState: 'OBS_WEBSOCKET_OUTPUT_PAUSED',
  });
  assert.equal(relay.obsRecordActive, true);
  assert.equal(relay.obsRecordPaused, true);
  assert.equal(relay.currentRecording.pauseIntervals.length, 1);
  assert.equal(messages.at(-1).type, 'obs_record_pause');
  assert.equal(messages.at(-1).paused, true);

  relay.handleObsEvent('RecordStateChanged', {
    outputActive: true,
    outputState: 'OBS_WEBSOCKET_OUTPUT_RESUMED',
  });
  assert.equal(relay.obsRecordActive, true);
  assert.equal(relay.obsRecordPaused, false);
  assert.ok(relay.currentRecording.pauseIntervals[0].resumedAtMs);
  assert.equal(messages.at(-1).type, 'obs_record_pause');
  assert.equal(messages.at(-1).paused, false);
});
