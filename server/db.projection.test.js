import assert from 'node:assert/strict';
import test from 'node:test';
import { getEntityFields, listEntityPage, listProcessingJobSummaries } from './db.js';

test('listEntityPage projects requested fields before JSON reaches Node', () => {
  const rows = listEntityPage('User', {
    fields: ['full_name'],
    sort: '-updated_date',
    limit: 1,
  });

  assert.equal(rows.length, 1);
  assert.ok(rows[0].id);
  assert.ok(Object.hasOwn(rows[0], 'full_name'));
  assert.deepEqual(
    Object.keys(rows[0]).sort(),
    ['created_date', 'full_name', 'id', 'updated_date'].sort(),
  );
});

test('getEntityFields avoids returning unrequested large profile fields', () => {
  const user = getEntityFields('User', 'local-user', ['full_name']);

  assert.ok(user);
  assert.equal(user.id, 'local-user');
  assert.ok(Object.hasOwn(user, 'full_name'));
  assert.equal(Object.hasOwn(user, 'profile_anatomy_image_index'), false);
});

test('processing job summaries never return giant result or payload bodies', () => {
  const jobs = listProcessingJobSummaries({ limit: 3, includeCleared: true });

  assert.ok(jobs.length <= 3);
  for (const job of jobs) {
    assert.equal(Object.hasOwn(job, 'result'), false);
    assert.equal(Object.hasOwn(job, 'payload'), false);
    assert.equal(Array.isArray(job.progress?.completed_batch_results), false);
    assert.equal(Array.isArray(job.meta?.reviewed_images), false);
  }
});
