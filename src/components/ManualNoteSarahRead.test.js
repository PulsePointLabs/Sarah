import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformSync } from 'esbuild';
import { formatManualAnnotationReviewText, formatSessionClock } from '../lib/manualAnnotationReviewText.js';
import { manualAnnotationReport } from '../lib/manualAnnotationReport.js';

const source = fs.readFileSync(new URL('./VideoSyncPlayer.jsx', import.meta.url), 'utf8');
const component = source.slice(source.indexOf('function ManualNoteSarahRead('), source.indexOf('\nfunction visualSnapshotSearchText'));
const module = { exports: {} };
vm.runInNewContext(transformSync(`export ${component}`, { loader: 'jsx', jsx: 'automatic', format: 'cjs' }).code, {
  module, exports: module.exports, require: createRequire(import.meta.url),
  Sparkles: () => null, formatManualAnnotationReviewText, fmtMmSs: formatSessionClock, manualAnnotationReport,
});
const render = (props) => renderToStaticMarkup(React.createElement(module.exports.ManualNoteSarahRead, props));

test('temporal candidates stay visible inline with the actual reviewed window', () => {
  const html = render({onReview() {}, review:{source_video_role:'feet',summary:'Before, toe curl begins. Around the mark it increases. Afterward it decreases.',analyzed_window:{start_s:67,end_s:77},sampled_frames:[{recordTimeSeconds:72},{recordTimeSeconds:67}],findings:[{anatomical_area:'Left toes',observation:'Slight possible curl.',confidence:'low',evidence_status:'candidate'}]}});
  assert.match(html,/Possible/);assert.match(html,/Slight possible curl/);assert.match(html,/1:07.*1:17/);
  assert.doesNotMatch(html,/No saved review|<details/);
});

test('feet report is displayed inline like main, without a verdict or hidden dropdown', () => {
  const html = render({ cameraLabel: 'Feet', onReview() {}, review: {
    summary: '', findings: [], note_assessment: 'not_visually_confirmed',
    foot_assessment: { left: { ankle_state: 'plantar_flexed', toe_state: 'curled', movement_state: 'stable', evidence_frames: [72] }, relaxation_evidence: 'Your observation is not visually confirmed.' },
  } });
  assert.match(html, /Feet · visual review/);
  assert.match(html, /Left foot/);
  assert.match(html, /ankle plantar-flexed; toes curled/);
  assert.doesNotMatch(html, /not visually confirmed|No saved review|<details|<summary/);
  assert.match(html, /Review again/);
});

test('camera without a saved review exposes an explicit review action', () => {
  const html = render({ cameraLabel: 'Feet', onReview() {} });
  assert.match(html, /No saved review for this note on the selected camera/);
  assert.match(html, /Review this camera/);
});

test('reused findings are visible as prior evidence rather than a fresh note assessment', () => {
  const html = render({ review: { source_video_role: 'feet', coverage_status: 'fully_reused', summary: 'Frames already reviewed.', findings: [], reused_findings: [{ anatomical_area: 'Left toes', observation: 'Extend.' }] } });
  assert.match(html, /Saved observations from this camera/);
  assert.match(html, /Left toes/);
  assert.match(html, /Extend/);
  assert.doesNotMatch(html, /<details|No saved review/);
  assert.doesNotMatch(html, /Note: supported/);
});

test('completed main-camera review with no report is distinguished from a missing review', () => {
  const html = render({ cameraLabel: 'Main', review: { summary: '', findings: [] }, onReview() {} });
  assert.match(html, /No report text was saved for this review/);
  assert.doesNotMatch(html, /No saved review for this note/);
});
