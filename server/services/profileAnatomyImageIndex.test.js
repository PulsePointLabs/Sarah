import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  normalizeProfileAnatomyClassification,
  runProfileAnatomyImageIndex,
  selectProfileAnatomyIndexEntries,
} from './profileAnatomyImageIndex.js';

function indexedClassification(overrides = {}) {
  return {
    visible_anatomy: ['penis', 'foreskin'],
    fine_structures: ['penile_shaft', 'foreskin_forward'],
    laterality: ['midline'],
    positions: ['standing', 'anterior'],
    device_classification: 'none',
    device_types: [],
    device_is_primary_subject: false,
    quality: { overall: 'good', focus: 'good', lighting: 'adequate', anatomy_visibility: 'good' },
    best_for_sections: ['penis', 'foreskin', 'penis_and_foreskin'],
    combined_view_strengths: ['penis_and_foreskin'],
    notes: 'Standing anterior reference with clear penile shaft and forward foreskin.',
    ...overrides,
  };
}

test('normalization retains only stable anatomy vocabulary and device state', () => {
  const normalized = normalizeProfileAnatomyClassification({
    ...indexedClassification(),
    visible_anatomy: ['penis', 'foreskin', 'invented_structure'],
    device_classification: 'incidental_device',
  }, { imageId: 'pelvic_img_025', sourceType: 'profiler_upload' });
  assert.deepEqual(normalized.visible_anatomy, ['penis', 'foreskin']);
  assert.equal(normalized.device_classification, 'incidental_device');
  assert.equal(normalized.image_id, 'pelvic_img_025');
});

test('unchanged indexed hash is skipped without an AI call', async () => {
  let calls = 0;
  const entries = [{
    inventoryKey: 'pelvic:img_025:hash', imageId: 'img_025', sourceType: 'profiler_upload',
    sourceUrl: '/uploads/reference.jpg', filePath: 'unused.jpg', fileHash: 'hash', fileExists: true,
    status: 'indexed', classifiedAt: '2026-06-27T12:00:00.000Z', classification: indexedClassification(),
  }];
  const result = await runProfileAnatomyImageIndex({ mode: 'unclassified', confirmCredits: true }, {}, {
    entries,
    invoke: async () => { calls += 1; return indexedClassification(); },
    save: () => { throw new Error('should not save'); },
  });
  assert.equal(calls, 0);
  assert.equal(result.requested, 0);
});

test('partial indexing saves each completed image and reports a failed image durably', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sarah-anatomy-index-'));
  const one = path.join(dir, 'one.jpg');
  const two = path.join(dir, 'two.jpg');
  fs.writeFileSync(one, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  fs.writeFileSync(two, Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
  const entries = [one, two].map((filePath, index) => ({
    inventoryKey: `head:img_${index}:hash_${index}`,
    imageId: `img_${index}`,
    displayLabel: `Image ${index}`,
    sourceType: 'profiler_upload',
    sourceUrl: `/uploads/${path.basename(filePath)}`,
    filePath,
    fileHash: `hash_${index}`,
    fileExists: true,
    status: 'unindexed',
    classifiedAt: '',
  }));
  const saved = [];
  let calls = 0;
  const result = await runProfileAnatomyImageIndex({ mode: 'unclassified', confirmCredits: true }, {}, {
    entries,
    invoke: async () => {
      calls += 1;
      if (calls === 2) throw new Error('fixture provider failure');
      return indexedClassification();
    },
    save: (record) => saved.push(record),
  });
  assert.equal(result.completed, 1);
  assert.equal(result.failed, 1);
  assert.equal(saved.length, 1);
  assert.equal(result.failures[0].error, 'fixture provider failure');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('reindex all resumes from records classified after the request timestamp', () => {
  const entries = [
    { inventoryKey: 'a', fileExists: true, fileHash: 'a', status: 'indexed', classifiedAt: '2026-06-27T10:00:00.000Z' },
    { inventoryKey: 'b', fileExists: true, fileHash: 'b', status: 'indexed', classifiedAt: '2026-06-27T12:00:00.000Z' },
  ];
  const selected = selectProfileAnatomyIndexEntries(entries, { mode: 'all', requestedAt: '2026-06-27T11:00:00.000Z' });
  assert.deepEqual(selected.map((entry) => entry.inventoryKey), ['a']);
});
