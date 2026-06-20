import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildWatermarkFilter,
  DEFAULT_WATERMARK_SETTINGS,
  normalizeWatermarkSettings,
  safeExportFilename,
  watermarkPositionPlan,
  watermarkText,
} from './watermark.js';

test('public export preset enables Clinical Climax watermark by default', () => {
  const settings = normalizeWatermarkSettings();
  assert.equal(settings.preset, 'public_export');
  assert.equal(settings.enabled, true);
  assert.equal(settings.metadataScrubEnabled, true);
  assert.equal(settings.primaryText, 'Clinical Climax');
  assert.equal(settings.secondaryText, 'Powered by Sarah');
  assert.match(watermarkText(settings), /Clinical Climax/);
  assert.match(watermarkText(settings), /Powered by Sarah/);
});

test('private archive preset does not force a watermark', () => {
  const settings = normalizeWatermarkSettings({ preset: 'private_archive' });
  assert.equal(settings.enabled, false);
  assert.equal(settings.metadataScrubEnabled, false);
  assert.equal(buildWatermarkFilter(settings), null);
});

test('rotating corner mode changes positions without consecutive duplicates', () => {
  const settings = normalizeWatermarkSettings({ movementIntervalSeconds: 10 });
  const plan = watermarkPositionPlan(settings, 45);
  assert.deepEqual(plan.map((item) => item.position), [
    'top_left',
    'bottom_left',
    'top_right',
    'bottom_right',
    'top_left',
  ]);
  plan.slice(1).forEach((item, index) => {
    assert.notEqual(item.position, plan[index].position);
  });
});

test('drawtext filter stays inside frame expressions with safe padding', () => {
  const filter = buildWatermarkFilter(DEFAULT_WATERMARK_SETTINGS);
  assert.match(filter, /drawtext=/);
  assert.match(filter, /Clinical Climax/);
  assert.match(filter, /Powered by Sarah/);
  assert.match(filter, /min\(w\\,h\)\*0\.0400/);
  assert.doesNotMatch(filter, /x=-/);
  assert.doesNotMatch(filter, /y=-/);
});

test('safe export filenames avoid source names and local paths', () => {
  const filename = safeExportFilename({
    contentType: 'C:\\Users\\Ben\\Private Session',
    date: '2026-06-19T12:00:00Z',
    shortId: 'a17f',
    extension: 'mp4',
  });
  assert.equal(filename, 'clinical-climax_video_2026-06-19_a17f.mp4');
  assert.doesNotMatch(filename, /\\/);
  assert.doesNotMatch(filename, /\s/);
  assert.doesNotMatch(filename, /ben/i);
});
