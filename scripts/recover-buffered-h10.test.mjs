import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import Database from 'better-sqlite3';

test('late native recovery fills only in-window packets, preserves originals, and is idempotent', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sarah-h10-recovery-'));
  const filename = path.join(root, 'test.sqlite');
  const session = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const start = Date.parse('2026-09-01T10:00:00Z');
  const db = new Database(filename);
  db.exec('CREATE TABLE entities(entity TEXT,id TEXT,created_date TEXT,updated_date TEXT,data TEXT,PRIMARY KEY(entity,id)); CREATE TABLE native_h10_receipts(packet_id TEXT,received_at INTEGER,payload TEXT,recorded INTEGER);');
  const insert = db.prepare("INSERT INTO entities VALUES ('HeartRateTimeline',?,'date','date',?)");
  for (let index = 0; index < 200; index++) {
    if (index === 120) continue;
    const row = { id: `row-${index}`, session, timestamp: new Date(start + index * 1000).toISOString(),
      hr_source: 'direct_h10', hr_measured_at: start + index * 1000, time_offset_ms: index * 1000,
      rr_intervals_ms: '1000', hr: 60, hrv_rmssd_ms: 0, hrv_sdnn_ms: 0, hrv_pnn50: 0,
      hrv_quality: 'high', hrv_window_seconds: 90, created_date: 'date', updated_date: 'date' };
    insert.run(row.id, JSON.stringify(row));
  }
  const packet = { measuredAt: start + 120000, heartRatePacket: '103c0004' };
  const receipt = db.prepare('INSERT INTO native_h10_receipts VALUES (?,?,?,0)');
  receipt.run('packet-inside', packet.measuredAt, JSON.stringify(packet));
  receipt.run('packet-outside', start - 1000, JSON.stringify({ ...packet, measuredAt: start - 1000 }));
  const run = (...args) => {
    const result = spawnSync(process.execPath, [path.resolve('scripts/recover-buffered-h10.mjs'), session, ...args], {
      cwd: root, env: { ...process.env, DATABASE_PATH: filename }, encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    return JSON.parse(result.stdout);
  };
  try {
    const before = db.prepare('SELECT data FROM entities ORDER BY id').all();
    assert.equal(run().recoveredPackets, 1);
    assert.deepEqual(db.prepare('SELECT data FROM entities ORDER BY id').all(), before);
    const applied = run('--apply');
    assert.equal(applied.maximumGapSeconds, 1);
    assert.ok(fs.existsSync(path.join(root, applied.backup)));
    const recovered = JSON.parse(db.prepare("SELECT data FROM entities WHERE id='h10-recovered-packet-inside'").get().data);
    assert.equal(recovered.hr, 60);
    assert.equal(recovered.time_offset_s, 120);
    assert.equal(recovered.rr_intervals_ms, '1000');
    assert.equal(run('--apply').recoveredPackets, 0);
    assert.equal(db.prepare('SELECT count(*) AS n FROM entities').get().n, 200);
    assert.equal(db.prepare('SELECT payload FROM native_h10_receipts WHERE packet_id=?').get('packet-inside').payload, JSON.stringify(packet));
  } finally {
    db.close();
    assert.equal(path.dirname(path.resolve(root)), path.resolve(os.tmpdir()));
    assert.ok(path.basename(root).startsWith('sarah-h10-recovery-'));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
