import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalizePerinealEmgEvent,
  summarizePerinealEmg,
} from '../../src/utils/perinealEmgSummary.js';

const event = (type, start, duration, peak, confidence = 'high') => ({
  source: 'perineal_emg',
  time_s: start + duration / 2,
  note: type === 'possible_artifact' ? 'Possible EMG artifact' : 'Kegel detected',
  perineal_emg: {
    event_type: type === 'possible_artifact' ? 'possible_artifact' : 'kegel_contraction',
    contraction_type: type,
    start_time_s: start,
    peak_time_s: start + duration / 2,
    end_time_s: start + duration,
    duration_s: duration,
    peak_pct: peak,
    average_pct: peak - 10,
    integrated_activation: duration * peak,
    confidence,
  },
});

test('summarizes saved perineal EMG timeline events from a session object', () => {
  const summary = summarizePerinealEmg({
    emg_target_area: 'Perineal body / pelvic floor',
    event_timeline: [
      event('light', 10, 0.8, 34, 'medium'),
      event('moderate', 14, 0.9, 45, 'high'),
      event('strong', 18, 1.1, 72, 'high'),
      event('sustained', 25, 7, 62, 'high'),
      event('possible_artifact', 40, 0.15, 90, 'low'),
      { source: 'live_voice_annotation', note: 'manual note', time_s: 50 },
    ],
  });

  assert.equal(summary.hasPerinealEvents, true);
  assert.equal(summary.total, 4);
  assert.equal(summary.byType.light, 1);
  assert.equal(summary.byType.moderate, 1);
  assert.equal(summary.byType.strong, 1);
  assert.equal(summary.byType.sustained, 1);
  assert.equal(summary.possibleArtifactCount, 1);
  assert.equal(summary.strongestEvent.contraction_type, 'strong');
  assert.equal(summary.longestHoldEvent.contraction_type, 'sustained');
  assert.equal(Number(summary.totalActiveSeconds.toFixed(1)), 9.8);
  assert.equal(summary.qualityLabel, 'Mixed / review');
  assert.equal(summary.qualityDisplayLabel, 'Mixed / Review');
  assert.equal(summary.storySentence, '4 contraction events detected, including 1 strong contraction and 1 sustained hold.');
  assert.equal(summary.notableEvents[0].contraction_type, 'sustained');
  assert.equal(summary.strongestEventTypeLabel, 'Strong Contraction');
});

test('labels artifact-heavy perineal EMG summaries conservatively', () => {
  const summary = summarizePerinealEmg([
    event('possible_artifact', 1, 0.1, 88, 'low'),
    event('possible_artifact', 3, 0.1, 90, 'low'),
    event('light', 8, 0.7, 31, 'medium'),
  ]);

  assert.equal(summary.hasPerinealEvents, true);
  assert.equal(summary.total, 1);
  assert.equal(summary.possibleArtifactCount, 2);
  assert.equal(summary.qualityLabel, 'Artifact-heavy');
  assert.equal(summary.qualityDisplayLabel, 'Artifact Heavy');
  assert.equal(summary.storySentence, 'Artifact-heavy session. Interpret detected activations cautiously.');
});

test('handles missing timelines and setup-only sessions safely', () => {
  const none = summarizePerinealEmg({});
  assert.equal(none.hasPerinealEvents, false);
  assert.equal(none.qualityLabel, 'No perineal EMG events');

  const setupOnly = summarizePerinealEmg({ emg_perineal_calibration: { id: 'cal-1' }, event_timeline: [] });
  assert.equal(setupOnly.hasPerinealSetup, true);
  assert.equal(setupOnly.qualityLabel, 'No detected contractions');
  assert.equal(setupOnly.qualityDisplayLabel, 'No Detected Contractions');
  assert.equal(setupOnly.storySentence, 'Perineal Body EMG was configured, but no contraction events were detected.');
});

test('generates a light-to-moderate story when no strong or sustained events are present', () => {
  const summary = summarizePerinealEmg([
    event('light', 10, 0.8, 34, 'high'),
    event('moderate', 14, 0.9, 45, 'high'),
    event('moderate', 18, 1.1, 49, 'high'),
  ]);

  assert.equal(summary.qualityDisplayLabel, 'High Confidence');
  assert.equal(summary.storySentence, '3 contraction events detected, including 2 moderate activations.');
});

test('normalizes older partial event metadata without crashing', () => {
  const normalized = normalizePerinealEmgEvent({
    source: 'perineal_emg',
    time_s: 12,
    perineal_emg: {
      contraction_type: 'strong',
      peak_pct: '70',
      confidence: 0.9,
    },
  });

  assert.equal(normalized.contraction_type, 'strong');
  assert.equal(normalized.peak_pct, 70);
  assert.equal(normalized.confidence_label, 'High');
  assert.equal(normalized.start_time_s, 12);
});
