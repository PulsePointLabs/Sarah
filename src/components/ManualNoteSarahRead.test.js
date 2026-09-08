import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { transformSync } from 'esbuild';
import { formatManualAnnotationReviewText, formatSessionClock } from '../lib/manualAnnotationReviewText.js';

const source = fs.readFileSync(new URL('./VideoSyncPlayer.jsx', import.meta.url), 'utf8');
const component = source.slice(source.indexOf('function ManualNoteSarahRead('), source.indexOf('\nfunction visualSnapshotSearchText'));
const module = { exports: {} };
vm.runInNewContext(transformSync(`export ${component}`, { loader: 'jsx', jsx: 'automatic', format: 'cjs' }).code, {
  module, exports: module.exports, require: createRequire(import.meta.url),
  Sparkles: () => null, formatManualAnnotationReviewText, fmtMmSs: formatSessionClock,
});
const render = (props) => renderToStaticMarkup(React.createElement(module.exports.ManualNoteSarahRead, props));

test('completed empty feet review displays status, note assessment, and saved foot evidence', () => {
  const html = render({ cameraLabel: 'Feet', onReview() {}, review: {
    summary: '', findings: [], note_assessment: 'not_visually_confirmed',
    foot_assessment: { relaxation_evidence: 'No visible transition in these sampled frames.' },
  } });
  assert.match(html, /Feet · visual review/);
  assert.match(html, /Review completed with no new supported visual changes saved/);
  assert.match(html, /not visually confirmed in this camera/);
  assert.match(html, /Saved foot assessment/);
  assert.match(html, /Review again/);
});

test('camera without a saved review exposes an explicit review action', () => {
  const html = render({ cameraLabel: 'Feet', onReview() {} });
  assert.match(html, /No saved review for this note on the selected camera/);
  assert.match(html, /Review this camera/);
});

test('reused findings are visible as prior evidence rather than a fresh note assessment', () => {
  const html = render({ review: { coverage_status: 'fully_reused', summary: 'Frames already reviewed.', findings: [], reused_findings: [{ anatomical_area: 'Left toes', observation: 'Extend.' }] } });
  assert.match(html, /Previously saved evidence from this camera \(1\)/);
  assert.match(html, /Left toes: Extend/);
  assert.doesNotMatch(html, /Note: supported/);
});
