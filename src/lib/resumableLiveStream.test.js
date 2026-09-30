import test from 'node:test';
import assert from 'node:assert/strict';
import { createResumableLiveStream, mergeMonitoringPoints } from './resumableLiveStream.js';

test('returning to the page replaces its stream and rejects queued events from the old stream', () => {
  const sources = [], received = []; let resumed = 0;
  const visibility = new EventTarget(); visibility.visibilityState = 'visible';
  class Source extends EventTarget {
    constructor() { super(); sources.push(this); }
    close() { this.closed = true; }
  }
  const stream = createResumableLiveStream('/stream', { EventSourceClass: Source, visibility, onResume: () => resumed++ });
  stream.addEventListener('telemetry', () => received.push(true));
  sources[0].dispatchEvent(new Event('telemetry'));
  visibility.visibilityState = 'hidden'; visibility.dispatchEvent(new Event('visibilitychange'));
  assert.equal(sources.length, 1);
  visibility.visibilityState = 'visible'; visibility.dispatchEvent(new Event('visibilitychange'));
  assert.equal(resumed, 1);
  assert.equal(sources[0].closed, true);
  sources[0].dispatchEvent(new Event('telemetry'));
  sources[1].dispatchEvent(new Event('telemetry'));
  assert.equal(received.length, 2);
  stream.close(); stream.resume(); visibility.dispatchEvent(new Event('visibilitychange'));
  assert.equal(sources.length, 2);
});

test('history merges preserve source timestamps and newer live samples', () => {
  assert.deepEqual(mergeMonitoringPoints([{ ts: 4 }, { ts: 2, value: 1 }], [{ ts: 1 }, { ts: 2, value: 2 }]),
    [{ ts: 1 }, { ts: 2, value: 2 }, { ts: 4 }]);
});
