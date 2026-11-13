import { randomUUID } from 'node:crypto';

// Commands expire quickly and belong to one capture. Never replay a calibration
// or hardware zero when a phone reconnects later or starts another capture.
export function createPhoneCivetControl(db, { now = Date.now, timeoutMs = 10000 } = {}) {
  db.exec(`CREATE TABLE IF NOT EXISTS phone_civet_commands (
    id TEXT PRIMARY KEY, capture_id TEXT NOT NULL, expires INTEGER NOT NULL,
    body TEXT NOT NULL, result TEXT)`);
  const insert = db.prepare('INSERT INTO phone_civet_commands VALUES (?,?,?,?,NULL)');
  const waiting = new Map();
  let heartbeat = null;
  function poll(captureId) {
    if (typeof captureId !== 'string' || !/^[\w-]{8,160}$/.test(captureId)) throw Error('Invalid phone capture.');
    heartbeat = { captureId, at: now() };
    db.prepare('DELETE FROM phone_civet_commands WHERE expires < ?').run(now() - 60000);
    return { commands: db.prepare('SELECT id, body, expires FROM phone_civet_commands WHERE capture_id=? AND expires>? AND result IS NULL ORDER BY rowid').all(captureId, now()).map(row => ({ id: row.id, expires: row.expires, ...JSON.parse(row.body) })) };
  }
  function request(captureId, action, body) {
    if (!heartbeat || heartbeat.captureId !== captureId || now() - heartbeat.at > 5000) throw Error('Phone control is offline. Open the updated Sarah APK on your phone; pressure acquisition can continue independently.');
    const id = randomUUID();
    insert.run(id, captureId, now() + timeoutMs, JSON.stringify({ action, body }));
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        waiting.delete(id);
        db.prepare('DELETE FROM phone_civet_commands WHERE id=?').run(id);
        reject(Error('The phone did not confirm the command. Check its connection before retrying.'));
      }, timeoutMs);
      waiting.set(id, { resolve, reject, timer });
    });
  }
  function acknowledge({ id, capture_id: captureId, error = null }) {
    const row = db.prepare('SELECT * FROM phone_civet_commands WHERE id=? AND capture_id=?').get(id, captureId);
    if (!row || row.expires <= now()) throw Error('Phone command expired.');
    if (error !== null && typeof error !== 'string') throw Error('Invalid phone acknowledgement.');
    if (row.result !== null) return { ok: true };
    db.prepare('UPDATE phone_civet_commands SET result=? WHERE id=?').run(JSON.stringify({ error }), id);
    const pending = waiting.get(id);
    if (pending) {
      clearTimeout(pending.timer); waiting.delete(id);
      if (error) pending.reject(Error(error)); else pending.resolve();
    }
    return { ok: true };
  }
  return { poll, request, acknowledge };
}
