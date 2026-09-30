import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { parse } from 'csv-parse/sync';
import { repairBufferedHrvRows } from '../services/hrCaptureMerge.js';

test('native FIFO samples survive live-lane overtaking; duplicates and failed writes are handled', async () => {
  const source = fs.readFileSync(new URL('./liveCapture.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function appendDirectH10TelemetryRow(');
  const end = source.indexOf('\nasync function appendDirectH10SensorBatch', start);
  const written = []; let fail = false;
  const context = vm.createContext({
    state: { hr: { recording: { active: true }, selectedSource: 'h10' } },
    HR_SOURCE_IDS: { DIRECT_H10: 'h10' },
    directH10Recording: { filepath: 'test.csv', startEpochMs: 1000, lastEpochMs: null },
    cleanHr: Number, cleanNumber: value => value == null ? null : Number(value),
    csvEscape: value => JSON.stringify(String(value ?? '')),
    fs: { appendFile: async (_path, row) => { if (fail) throw Error('disk unavailable'); written.push(row); } },
  });
  vm.runInContext(source.slice(start, end) + '\nthis.append = appendDirectH10TelemetryRow;', context);
  const sample = at => ({ receivedAt: at, heartRate: 80, rrIntervalsMs: [750], quality: { nativeBackgroundCapture: true, stale: true } });
  await context.append(sample(4000));
  await context.append(sample(2000));
  await Promise.all([context.append(sample(3000)), context.append(sample(3000))]);
  assert.equal(written.length, 3);
  assert.equal(context.directH10Recording.lastEpochMs, 4000);
  assert.deepEqual(written.map(row => parse(row)[0][1]), ['3000', '1000', '2000']);
  assert.match(written[1], /native_buffered_delivery=true/);
  fail = true;
  await assert.rejects(context.append(sample(5000)), /disk unavailable/);
  fail = false;
  assert.equal(await context.append(sample(5000)), true);
  assert.equal(written.length, 4);
  assert.equal(await context.append(sample(500)), undefined);
});

test('review HRV uses chronological RR including buffered samples and leaves original rows intact', () => {
  const rows = Array.from({ length: 190 }, (_, index) => ({
    hr_source: 'direct_h10', hr_measured_at: 100000 + index * 1000,
    rr_intervals_ms: index % 2 ? '800' : '1000', hrv_rmssd_ms: 999,
    note: index === 120 ? 'native_buffered_delivery=true' : '',
  }));
  const repaired = repairBufferedHrvRows(rows);
  assert.equal(repaired.at(-1).hrv_rmssd_ms, 200);
  assert.equal(rows.at(-1).hrv_rmssd_ms, 999);
  assert.equal(repaired[20].hrv_rmssd_ms, 999); // Cannot invent pre-session RR.
  assert.match(repaired.at(-1).note, /reprocessed/);
  const clean = rows.map(row => ({ ...row, note: '' }));
  assert.equal(repairBufferedHrvRows(clean), clean);
});
