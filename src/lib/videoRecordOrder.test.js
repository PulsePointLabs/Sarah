import test from 'node:test';
import assert from 'node:assert/strict';
import {sortVideoRecords,videoRecordDuration} from './videoRecordOrder.js';
test('same-day recordings sort by actual start time rather than storage insertion order',()=>{
  const rows=[{id:'early',date:'2026-11-19T00:00:00',start_time:'21:18'},{id:'late',date:'2026-11-19T00:00:00',start_time:'21:28'},{id:'prior',date:'2026-11-18',start_time:'23:50'}];
  assert.deepEqual(sortVideoRecords(rows).map(r=>r.id),['late','early','prior']);
  assert.equal(rows[0].id,'early');
});
test('picker preserves saved minute durations and fills capture-only second durations',()=>{
  assert.equal(videoRecordDuration({duration_minutes:47,capture_active_duration_seconds:2813.1}),'47m');
  assert.equal(videoRecordDuration({capture_active_duration_seconds:45.6}),'46s');
  assert.equal(videoRecordDuration({capture_wall_duration_seconds:120}),'2m');
  assert.equal(videoRecordDuration({}), '');
});
test('12-hour times, absent times and creation tie-breaks remain deterministic',()=>{
  assert.deepEqual(sortVideoRecords([{id:'am',date:'2026-11-19',start_time:'11:00 AM'},{id:'pm',date:'2026-11-19',start_time:'1:00 PM'},{id:'unknown',date:'2026-11-19'}]).map(r=>r.id),['pm','am','unknown']);
});
