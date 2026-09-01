import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyUploadArtifact, extractUploadReferences, isRetentionCandidate } from './mediaRetentionRules.js';

test('extractUploadReferences finds upload URLs and stored filenames', () => {
  const references = extractUploadReferences(JSON.stringify({
    preview: '/uploads/123-ai-video-pass-frame-01.jpg',
    filename: 'local-playback-seek-v2-source.mp4',
  }));
  assert.deepEqual([...references].sort(), [
    '123-ai-video-pass-frame-01.jpg',
    'local-playback-seek-v2-source.mp4',
  ]);
});

test('classifies generated previews without treating final renders as disposable cache', () => {
  assert.equal(classifyUploadArtifact('123-ai-video-pass-frame-01.jpg').category, 'generated_preview_frame');
  assert.equal(classifyUploadArtifact('local-playback-seek-v2-source.mp4').category, 'local_playback_cache');
  assert.equal(classifyUploadArtifact('ai-body-exploration-analysis-aug-1.mp4').automatic, false);
  assert.equal(classifyUploadArtifact('raw-session.mkv').automatic, false);
});

test('only old unreferenced reproducible artifacts become automatic candidates', () => {
  assert.equal(isRetentionCandidate({ filename: '123-ai-video-pass-frame-01.jpg', ageDays: 8 }).eligible, true);
  assert.equal(isRetentionCandidate({ filename: '123-ai-video-pass-frame-01.jpg', ageDays: 8, referenced: true }).eligible, false);
  assert.equal(isRetentionCandidate({ filename: 'raw-session.mkv', ageDays: 365 }).eligible, false);
});
