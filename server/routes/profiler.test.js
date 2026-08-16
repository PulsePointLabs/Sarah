import test from 'node:test';
import assert from 'node:assert/strict';
import { compactProfilerBodyExploration, compactProfilerSession } from './profiler.js';

test('compactProfilerSession preserves report evidence and omits dense historical payloads', () => {
  const session = compactProfilerSession({
    id: 'session-1',
    date: '2026-08-16',
    notes: 'saved note',
    event_timeline: [{ time_s: 12, note: 'marker', source: 'manual', huge: 'omit' }],
    motion_analysis_summary: {
      findings: ['saved motion finding'],
      hand_movement_summary: { pause_count: 2 },
      derived_timeline: Array.from({ length: 1000 }, (_, index) => ({ time_s: index })),
    },
    ai_analysis: {
      summary: 'large historical report',
      _visual_findings: [{ findings: ['visible finding'] }],
      _video_pass_findings: [{ summary: 'saved video finding' }],
    },
  });

  assert.equal(session.id, 'session-1');
  assert.equal(session.event_timeline[0].note, 'marker');
  assert.equal(session.event_timeline[0].huge, undefined);
  assert.deepEqual(session.motion_analysis_summary.findings, ['saved motion finding']);
  assert.equal(session.motion_analysis_summary.derived_timeline, undefined);
  assert.deepEqual(session.ai_analysis._visual_findings, [{ findings: ['visible finding'] }]);
  assert.equal(session.ai_analysis.summary, undefined);
});

test('compactProfilerBodyExploration preserves saved visual and video findings only', () => {
  const exploration = compactProfilerBodyExploration({
    id: 'exploration-1',
    purpose: 'body exploration',
    ai_body_exploration: {
      overview: 'large generated report',
      _visual_findings: [{ findings: ['saved visual finding'] }],
      _video_pass_digest: 'saved digest',
    },
  });

  assert.equal(exploration.purpose, 'body exploration');
  assert.deepEqual(exploration.ai_body_exploration._visual_findings, [{ findings: ['saved visual finding'] }]);
  assert.equal(exploration.ai_body_exploration._video_pass_digest, 'saved digest');
  assert.equal(exploration.ai_body_exploration.overview, undefined);
});
