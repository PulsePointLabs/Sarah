import test from 'node:test';
import assert from 'node:assert/strict';
import {
  backgroundJobStateToken,
  hasUnseenJobState,
  loadClosedJobSnapshot,
  saveClosedJobSnapshot,
} from './backgroundJobTrayPersistence.js';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
  };
}

test('closed job state survives reload but reopens for a status change or new job', () => {
  const storage = memoryStorage();
  const jobs = [{ id: 'one', status: 'complete' }];
  saveClosedJobSnapshot(jobs, storage);
  const snapshot = loadClosedJobSnapshot(storage);
  assert.equal(snapshot.has(backgroundJobStateToken(jobs[0])), true);
  assert.equal(hasUnseenJobState(jobs, snapshot), false);
  assert.equal(hasUnseenJobState([{ id: 'one', status: 'running' }], snapshot), true);
  assert.equal(hasUnseenJobState([...jobs, { id: 'two', status: 'queued' }], snapshot), true);
});
