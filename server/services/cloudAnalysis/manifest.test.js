import assert from 'node:assert/strict';
import test from 'node:test';
import { buildCloudAnalysisPreflight, CLOUD_ANALYSIS_SCHEMA_VERSION } from './manifest.js';

test('cloud preflight preserves timing and excludes absolute local paths from cloud payload', async () => {
  const result = await buildCloudAnalysisPreflight({
    record: {
      id: 'session-private-id',
      notes: 'private session note',
      event_timeline: [{ time_s: 12.5, note: 'manual note', source: 'manual' }],
    },
    recordType: 'session',
    videos: [{ path: 'Z:\\missing\\wide.mkv', label: 'Wide', timelineOffsetSeconds: 3.25, durationSeconds: 60 }],
    heartRateRows: [{ time_offset_s: 0, hr: 82 }, { time_offset_s: 60, hr: 105, rmssd_ms: 21 }],
  });

  assert.equal(result.cloudJob.schema_version, CLOUD_ANALYSIS_SCHEMA_VERSION);
  assert.equal(result.cloudJob.source_media[0].source_zero_session_ms, 3250);
  assert.equal(result.cloudJob.evidence_streams.find((item) => item.name === 'heart_rate').row_count, 2);
  assert.equal(result.cloudJob.context.has_notes, true);
  assert.equal(result.readiness.ready_to_package, false);
  assert.equal(JSON.stringify(result.cloudJob).includes('Z:\\missing'), false);
  assert.equal(JSON.stringify(result.cloudJob).includes('private session note'), false);
  assert.equal(result.localAssets[0].local_path, 'Z:\\missing\\wide.mkv');
});

