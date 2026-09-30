// Recover real, late-delivered H10 packets into an existing review timeline.
// Original CSVs and native receipts are never changed. Dry run by default.
import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { decodeNativeHeartRate } from '../server/services/nativeH10Telemetry.js';
import { computeHrvFromRr } from '../server/services/hrSources.js';

const session = process.argv[2];
if (!session || !/^[a-f\d-]{36}$/i.test(session)) throw Error('Usage: node scripts/recover-buffered-h10.mjs SESSION_ID [--apply]');
const apply = process.argv.includes('--apply');
const db = new Database(path.resolve(process.env.DATABASE_PATH || 'data/pulsepoint.sqlite'), { readonly: !apply });
const originals = db.prepare("SELECT data FROM entities WHERE entity='HeartRateTimeline' AND json_extract(data,'$.session')=?")
  .all(session).map(row => JSON.parse(row.data)).filter(row => row.hr_source === 'direct_h10')
  .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
if (!originals.length) throw Error('No direct H10 review timeline found.');
const at = row => Number(row.hr_measured_at) || Date.parse(row.timestamp);
const first = originals[0], last = originals.at(-1);
const origin = at(first) - Number(first.time_offset_ms ?? Number(first.time_offset_s) * 1000);
const seen = new Set(originals.map(at));
const packets = db.prepare('SELECT packet_id,payload FROM native_h10_receipts WHERE recorded=0 AND payload IS NOT NULL AND received_at>? AND received_at<? ORDER BY received_at')
  .all(at(first), at(last));
const recovered = [];
for (const record of packets) {
  const packet = JSON.parse(record.payload);
  if (seen.has(packet.measuredAt)) continue;
  const decoded = decodeNativeHeartRate(packet.heartRatePacket);
  if (decoded.heartRate < 25 || decoded.heartRate > 250 || !decoded.rrIntervalsMs.length) continue;
  const offset = packet.measuredAt - origin;
  recovered.push({
    id: `h10-recovered-${record.packet_id}`, session, timestamp: new Date(packet.measuredAt).toISOString(),
    time_offset_ms: offset, time_offset_s: offset / 1000, hr: decoded.heartRate, hr_source: 'direct_h10',
    hr_measured_at: packet.measuredAt, hr_received_at: packet.measuredAt,
    rr_intervals_ms: decoded.rrIntervalsMs.join('|'),
    note: 'Recovered from original native H10 packet delivered late; not interpolated.',
    recovery_packet_id: record.packet_id, recovery_policy: 'native-buffer-recovery-1',
    created_date: new Date().toISOString(), updated_date: new Date().toISOString(),
  });
}
const combined = [...originals.map(row => ({ ...row })), ...recovered].sort((a, b) => at(a) - at(b));
let rr = [], lastAt = null;
const changed = [];
for (const row of combined) {
  if (lastAt != null && at(row) - lastAt > 5000) rr = [];
  lastAt = at(row);
  rr = [...rr, ...String(row.rr_intervals_ms || '').split('|').map(Number).filter(n => n >= 300 && n <= 2000)].slice(-180);
  if (rr.length < 180 && !row.recovery_packet_id) continue; // No invented pre-session RR history.
  const hrv = computeHrvFromRr(rr);
  const values = { hrv_rmssd_ms: hrv.rmssdMs ?? null, hrv_sdnn_ms: hrv.sdnnMs ?? null,
    hrv_pnn50: hrv.pnn50 ?? null, hrv_window_seconds: hrv.windowSeconds, hrv_quality: hrv.quality };
  if (!row.recovery_packet_id && Object.entries(values).every(([key, value]) => String(row[key]) === String(value))) continue;
  if (!row.recovery_packet_id && !row.hrv_original_live) row.hrv_original_live = Object.fromEntries(Object.keys(values).map(key => [key, row[key]]));
  Object.assign(row, values, { hrv_processing_policy: 'native-buffer-recovery-1' });
  changed.push(row);
}
// Do not rewrite unrelated HRV differences when there are no missing raw packets.
const report = { session, applied: apply, originalRows: originals.length, recoveredPackets: recovered.length,
  affectedRows: recovered.length ? changed.length : 0,
  recoveredTimesSeconds: recovered.map(row => row.time_offset_s),
  maximumGapSeconds: Math.max(...combined.slice(1).map((row, index) => (at(row) - at(combined[index])) / 1000)) };
if (apply && recovered.length) {
  fs.mkdirSync('logs', { recursive: true });
  const backup = `logs/h10-recovery-${session}-${Date.now()}.json`;
  fs.writeFileSync(backup, JSON.stringify({ report, originals: originals.filter(row => changed.some(next => next.id === row.id)), addedIds: recovered.map(row => row.id) }, null, 2));
  const write = db.prepare("INSERT INTO entities(entity,id,created_date,updated_date,data) VALUES ('HeartRateTimeline',?,?,?,?) ON CONFLICT(entity,id) DO UPDATE SET updated_date=excluded.updated_date,data=excluded.data");
  db.transaction(() => { for (const row of changed) write.run(row.id, row.created_date, new Date().toISOString(), JSON.stringify(row)); })();
  report.backup = backup;
}
db.close();
console.log(JSON.stringify(report, null, 2));
