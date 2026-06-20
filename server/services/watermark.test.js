import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSarahBrandFilterComplex,
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
  assert.equal(settings.positionMode, 'bottom_right');
  assert.equal(settings.portraitEnabled, true);
  assert.equal(settings.logoEnabled, true);
  assert.equal(settings.portraitPath, 'brand/sarah-lab.jpg');
  assert.equal(settings.logoPath, 'icons/sarah-192.png');
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
  const settings = normalizeWatermarkSettings({ positionMode: 'rotating_corners', movementIntervalSeconds: 10 });
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

test('Sarah brand watermark graph places portrait, icon, and text in the bottom right', () => {
  const filter = buildSarahBrandFilterComplex(DEFAULT_WATERMARK_SETTINGS, {
    hasPortrait: true,
    hasLogo: true,
  });
  assert.match(filter, /sarahPortrait/);
  assert.match(filter, /sarahLogo/);
  assert.match(filter, /overlay=x=max\(.*w-/);
  assert.match(filter, /y=max\(.*h-/);
  assert.match(filter, /Clinical Climax/);
  assert.match(filter, /Powered by Sarah/);
  assert.match(filter, /\[vout\]$/);
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
