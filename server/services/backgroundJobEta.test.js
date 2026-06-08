import test from 'node:test';
import assert from 'node:assert/strict';

import {
  estimateBackgroundJobEtaSnapshot,
  stabilizeBackgroundJobEta,
} from '../../src/lib/backgroundJobEta.js';

test('raw background ETA grows when progress stalls inside a long unit', () => {
  const job = {
    id: 'job-eta-raw',
    status: 'running',
    startedAt: new Date(1_000).toISOString(),
    progress: { current: 1, total: 6 },
  };

  const first = estimateBackgroundJobEtaSnapshot(job, 61_000);
  const later = estimateBackgroundJobEtaSnapshot(job, 91_000);

  assert.ok(first.etaMs > 0);
  assert.ok(later.etaMs > first.etaMs);
});

test('stabilized background ETA counts down while progress is unchanged', () => {
  const cache = new Map();
  const job = {
    id: 'job-eta-stable',
    status: 'running',
    startedAt: new Date(1_000).toISOString(),
    progress: { current: 1, total: 6 },
  };

  const first = stabilizeBackgroundJobEta(job, cache, 61_000);
  const later = stabilizeBackgroundJobEta(job, cache, 91_000);

  assert.ok(first.etaMs > 0);
  assert.ok(later.etaMs < first.etaMs);
});

test('stabilized background ETA refreshes when progress advances', () => {
  const cache = new Map();
  const job = {
    id: 'job-eta-advance',
    status: 'running',
    startedAt: new Date(1_000).toISOString(),
    progress: { current: 1, total: 6 },
  };

  const first = stabilizeBackgroundJobEta(job, cache, 61_000);
  const advanced = stabilizeBackgroundJobEta({
    ...job,
    progress: { current: 2, total: 6 },
  }, cache, 91_000);

  assert.ok(first.etaMs > 0);
  assert.equal(advanced.key, 'running|2|6');
  assert.ok(advanced.etaMs > 0);
});
