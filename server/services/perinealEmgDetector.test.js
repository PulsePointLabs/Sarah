import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildPerinealEmgCalibration,
  createPerinealEmgDetector,
  processPerinealEmgSample,
} from '../../src/utils/perinealEmgDetector.js';

function pushSegment(samples, start, duration, pct, step = 0.1, jitter = 0) {
  for (let t = start; t < start + duration; t += step) {
    const wobble = jitter ? Math.sin(t * 9.7) * jitter : 0;
    samples.push({ time_s: Number(t.toFixed(2)), pct: Math.max(0, pct + wobble) });
  }
  return start + duration;
}

function buildProtocolSignal() {
  const samples = [];
  let t = 0;
  t = pushSegment(samples, t, 10, 8, 0.1, 1.2);
  for (let i = 0; i < 5; i += 1) {
    t = pushSegment(samples, t, 1, 34, 0.1, 2);
    t = pushSegment(samples, t, 2.2, 9, 0.1, 1);
  }
  for (let i = 0; i < 5; i += 1) {
    t = pushSegment(samples, t, 1, 68, 0.1, 3);
    t = pushSegment(samples, t, 2.2, 8, 0.1, 1);
  }
  t = pushSegment(samples, t, 7, 58, 0.1, 2);
  t = pushSegment(samples, t, 2.5, 8, 0.1, 1);
  samples.push({ time_s: Number(t.toFixed(2)), pct: 92 }); // cough-like single-sample spike
  t += 0.1;
  t = pushSegment(samples, t, 3, 9, 0.1, 1);
  return samples;
}

test('perineal EMG detector finds calibrated contractions and rejects cough spike as high-confidence Kegel', () => {
  const samples = buildProtocolSignal();
  const baseline = samples.filter((sample) => sample.time_s < 10);
  const light = samples.filter((sample) => sample.time_s >= 10 && sample.time_s < 26);
  const strong = samples.filter((sample) => sample.time_s >= 26 && sample.time_s < 42);
  const hold = samples.filter((sample) => sample.time_s >= 42 && sample.time_s < 49);
  const cough = samples.filter((sample) => sample.pct >= 90);
  const calibration = buildPerinealEmgCalibration({
    baseline,
    light,
    strong,
    hold,
    artifacts: { cough },
    createdAt: '2026-06-17T12:00:00.000Z',
  });
  const detector = createPerinealEmgDetector({ calibration });
  const events = [];
  for (const sample of samples) {
    const result = processPerinealEmgSample(detector, sample, { calibration });
    if (result.event) events.push(result.event);
  }
  const contractions = events.filter((event) => event.event_type === 'kegel_contraction');
  const artifacts = events.filter((event) => event.contraction_type === 'possible_artifact');

  assert.equal(contractions.length, 11);
  assert.equal(contractions.filter((event) => event.contraction_type === 'light').length, 5);
  assert.equal(contractions.filter((event) => event.contraction_type === 'strong').length, 5);
  assert.equal(contractions.filter((event) => event.contraction_type === 'sustained').length, 1);
  assert.ok(artifacts.length <= 1);
  assert.equal(events.some((event) => event.contraction_type === 'possible_artifact' && event.confidence === 'high'), false);
});
