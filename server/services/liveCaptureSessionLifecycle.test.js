import test from 'node:test';
import assert from 'node:assert/strict';

import { decideObsSessionLifecycleTransition } from './liveCaptureSessionLifecycle.js';

test('creates a record only on the stopped-to-recording transition', () => {
  assert.equal(decideObsSessionLifecycleTransition({ previousActive: false, nextActive: true, hasActiveSession: false }), 'start');
  assert.equal(decideObsSessionLifecycleTransition({ previousActive: false, nextActive: false, hasActiveSession: false }), 'none');
});

test('duplicate and reconnect recording events do not create another record', () => {
  assert.equal(decideObsSessionLifecycleTransition({ previousActive: true, nextActive: true, hasActiveSession: true }), 'none');
});

test('a recording reconnect can recover when the in-memory active record is missing', () => {
  assert.equal(decideObsSessionLifecycleTransition({ previousActive: true, nextActive: true, hasActiveSession: false }), 'start');
});

test('finalizes once on recording-to-stopped and ignores duplicate stopped events', () => {
  assert.equal(decideObsSessionLifecycleTransition({ previousActive: true, nextActive: false, hasActiveSession: true }), 'finalize');
  assert.equal(decideObsSessionLifecycleTransition({ previousActive: false, nextActive: false, hasActiveSession: false }), 'none');
});

test('the next stopped-to-recording transition creates a new record after finalization', () => {
  assert.equal(decideObsSessionLifecycleTransition({ previousActive: false, nextActive: true, hasActiveSession: false }), 'start');
});
