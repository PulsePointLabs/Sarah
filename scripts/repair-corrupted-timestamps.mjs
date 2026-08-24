import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

const root = process.cwd();
const databasePath = path.join(root, 'data', 'pulsepoint.sqlite');
const apply = process.argv.includes('--apply');
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupDirectory = path.join(root, 'data', 'backups');
const auditPath = path.join(backupDirectory, `timestamp-repair-${stamp}.json`);
const backupPath = path.join(backupDirectory, `pulsepoint-before-timestamp-repair-${stamp}.sqlite`);
const malformedTimestamp = /^(\d{4}-\d{2}-\d{2}T\d{2}):(\d{1,2}) minutes? and (\d{1,2}) seconds?(\.\d+)?(Z|[+-]\d{2}:\d{2})$/;

function repairTimestamp(value) {
  if (typeof value !== 'string') return value;
  const match = value.match(malformedTimestamp);
  if (!match) return value;
  const repaired = `${match[1]}:${match[2].padStart(2, '0')}:${match[3].padStart(2, '0')}${match[4] || ''}${match[5]}`;
  return Number.isFinite(new Date(repaired).getTime()) ? repaired : value;
}

function repairValue(value, location, changes) {
  if (typeof value === 'string') {
    const repaired = repairTimestamp(value);
    if (repaired !== value) changes.push({ path: location, before: value, after: repaired });
    return repaired;
  }
  if (Array.isArray(value)) return value.map((item, index) => repairValue(item, `${location}[${index}]`, changes));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [
      key,
      repairValue(item, location ? `${location}.${key}` : key, changes),
    ]));
  }
  return value;
}

const db = new Database(databasePath, { readonly: !apply, fileMustExist: true });
const totalRecords = db.prepare('SELECT COUNT(*) AS count FROM entities').get().count;
const rows = db.prepare(`
  SELECT entity, id, created_date, updated_date, data
  FROM entities
  WHERE data LIKE '% minutes and % seconds%'
     OR created_date LIKE '% minutes and % seconds%'
     OR updated_date LIKE '% minutes and % seconds%'
`).all();
const repairs = [];

for (const row of rows) {
  const changes = [];
  let document;
  try {
    document = JSON.parse(row.data);
  } catch {
    continue;
  }
  const repairedDocument = repairValue(document, '', changes);
  const createdDate = repairTimestamp(row.created_date);
  const updatedDate = repairTimestamp(row.updated_date);
  if (createdDate !== row.created_date) changes.push({ path: '$column.created_date', before: row.created_date, after: createdDate });
  if (updatedDate !== row.updated_date) changes.push({ path: '$column.updated_date', before: row.updated_date, after: updatedDate });
  if (changes.length) repairs.push({
    entity: row.entity,
    id: row.id,
    created_date: createdDate,
    updated_date: updatedDate,
    data: JSON.stringify(repairedDocument),
    changes,
  });
}

const summary = {
  mode: apply ? 'apply' : 'dry-run',
  scanned_records: totalRecords,
  candidate_records: rows.length,
  affected_records: repairs.length,
  repaired_values: repairs.reduce((total, item) => total + item.changes.length, 0),
  by_entity: Object.fromEntries([...new Set(repairs.map((item) => item.entity))].sort().map((entity) => [
    entity,
    repairs.filter((item) => item.entity === entity).reduce((total, item) => total + item.changes.length, 0),
  ])),
};

if (apply && repairs.length) {
  fs.mkdirSync(backupDirectory, { recursive: true });
  await db.backup(backupPath);
  fs.writeFileSync(auditPath, JSON.stringify({
    created_at: new Date().toISOString(),
    database: databasePath,
    backup: backupPath,
    summary,
    repairs: repairs.map(({ data: _data, ...repair }) => repair),
  }, null, 2));
  const update = db.prepare('UPDATE entities SET created_date = ?, updated_date = ?, data = ? WHERE entity = ? AND id = ?');
  db.transaction((items) => {
    for (const item of items) update.run(item.created_date, item.updated_date, item.data, item.entity, item.id);
  })(repairs);
  summary.backup = backupPath;
  summary.audit = auditPath;
}

console.log(JSON.stringify(summary, null, 2));
db.close();
