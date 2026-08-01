import { base44 } from "@/api/base44Client";
import { bloodGlucoseFields } from "@/lib/bloodGlucose";
import { decodeBloodGlucoseCsvBytes, parseBloodGlucoseCsv } from "@/utils/parseBloodGlucoseCsv";
import { readingsWithinRecord } from "@/utils/localRecordTime";

export function bloodGlucoseReadingKey(reading) {
  return `${reading.measured_at}|${reading.glucose_mg_dl}`;
}

function uniqueReadings(readings = []) {
  return readings
    .filter((reading, index, values) => (
      values.findIndex((candidate) => bloodGlucoseReadingKey(candidate) === bloodGlucoseReadingKey(reading)) === index
    ))
    .sort((a, b) => new Date(a.measured_at) - new Date(b.measured_at));
}

async function attachToMatchingRecords(readings, currentRecordId) {
  const [sessions, explorations] = await Promise.all([
    base44.entities.Session.list("-date", 1000),
    base44.entities.BodyExploration.list("-date", 1000),
  ]);
  let matched = 0;
  for (const [entity, records] of [["Session", sessions], ["BodyExploration", explorations]]) {
    for (const record of records || []) {
      if (record.id === currentRecordId) continue;
      const aligned = readingsWithinRecord(readings, record);
      if (!aligned.length) continue;
      const existing = Array.isArray(record.blood_glucose_readings) ? record.blood_glucose_readings : [];
      const merged = uniqueReadings([...existing, ...aligned]);
      await base44.entities[entity].update(record.id, bloodGlucoseFields(merged));
      matched += 1;
    }
  }
  return matched;
}

export async function importBloodGlucoseCsvBytes(bytes, { record = null } = {}) {
  const parsed = parseBloodGlucoseCsv(decodeBloodGlucoseCsvBytes(bytes));
  if (parsed.error) return parsed;

  const existing = await base44.entities.BloodGlucoseReading.list("-measured_at", 5000);
  const existingKeys = new Set((existing || []).map(bloodGlucoseReadingKey));
  const newRows = parsed.rows.filter((reading) => !existingKeys.has(bloodGlucoseReadingKey(reading)));
  if (newRows.length) await base44.entities.BloodGlucoseReading.bulkCreate(newRows);

  const allRows = uniqueReadings([...(existing || []), ...newRows]);
  const matchedRecords = await attachToMatchingRecords(allRows, record?.id);
  const aligned = record ? readingsWithinRecord(allRows, record) : [];

  return {
    ...parsed,
    allRows,
    aligned,
    newlySaved: newRows.length,
    matchedRecords: matchedRecords + (aligned.length ? 1 : 0),
    alignedCount: aligned.length,
  };
}
