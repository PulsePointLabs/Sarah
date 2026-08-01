import { base44 } from "@/api/base44Client";
import { decodePulseOxCsvBytes, parsePulseOxCsv } from "@/utils/parsePulseOxCsv";
import { readingsWithinRecord } from "@/utils/localRecordTime";

export function pulseOxReadingKey(reading) {
  return [
    reading.measured_at,
    reading.spo2_percent,
    reading.pulse_bpm ?? "",
    reading.perfusion_index ?? "",
  ].join("|");
}

function uniqueReadings(readings = []) {
  return readings
    .filter((reading, index, values) => (
      values.findIndex((candidate) => pulseOxReadingKey(candidate) === pulseOxReadingKey(reading)) === index
    ))
    .sort((a, b) => new Date(a.measured_at) - new Date(b.measured_at));
}

export function summarizePulseOxRows(rows = []) {
  const spo2 = rows.map((row) => Number(row.spo2_percent)).filter(Number.isFinite);
  const pulse = rows.map((row) => Number(row.pulse_bpm)).filter(Number.isFinite);
  if (!spo2.length) return null;
  return {
    minSpo2: Math.min(...spo2),
    avgSpo2: Math.round(spo2.reduce((sum, value) => sum + value, 0) / spo2.length),
    avgPulse: pulse.length ? Math.round(pulse.reduce((sum, value) => sum + value, 0) / pulse.length) : null,
    maxPulse: pulse.length ? Math.max(...pulse) : null,
  };
}

export function pulseOxFields(rows = [], filename = "") {
  const ordered = uniqueReadings(rows);
  const summary = summarizePulseOxRows(ordered);
  return {
    pulse_ox_enabled: ordered.length > 0,
    pulse_ox_source: "EMAY app CSV",
    pulse_ox_import_filename: filename || undefined,
    pulse_ox_readings: ordered,
    latest_pulse_ox_reading: ordered[ordered.length - 1] || null,
    min_spo2_percent: summary?.minSpo2 ?? null,
    avg_spo2_percent: summary?.avgSpo2 ?? null,
    avg_pulse_ox_pulse_bpm: summary?.avgPulse ?? null,
    max_pulse_ox_pulse_bpm: summary?.maxPulse ?? null,
  };
}

async function attachToMatchingRecords(readings, filename, currentRecordId) {
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
      const existing = Array.isArray(record.pulse_ox_readings) ? record.pulse_ox_readings : [];
      await base44.entities[entity].update(
        record.id,
        pulseOxFields([...existing, ...aligned], filename),
      );
      matched += 1;
    }
  }
  return matched;
}

export async function importPulseOxCsvBytes(bytes, { filename = "", record = null, parsed = null } = {}) {
  const result = parsed || parsePulseOxCsv(decodePulseOxCsvBytes(bytes));
  if (result.error) return result;

  const existing = await base44.entities.PulseOxReading.list("-measured_at", 10000);
  const existingKeys = new Set((existing || []).map(pulseOxReadingKey));
  const newRows = result.rows.filter((reading) => !existingKeys.has(pulseOxReadingKey(reading)));
  if (newRows.length) await base44.entities.PulseOxReading.bulkCreate(newRows);

  const allRows = uniqueReadings([...(existing || []), ...newRows]);
  const matchedRecords = await attachToMatchingRecords(allRows, filename, record?.id);
  const aligned = record ? readingsWithinRecord(allRows, record) : [];

  return {
    ...result,
    allRows,
    aligned,
    newlySaved: newRows.length,
    matchedRecords: matchedRecords + (aligned.length ? 1 : 0),
    alignedCount: aligned.length,
  };
}
