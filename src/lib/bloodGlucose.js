import { readingsWithinRecord } from "@/utils/localRecordTime";

export function summarizeBloodGlucose(readings = []) {
  const values = readings.map((reading) => Number(reading.glucose_mg_dl)).filter(Number.isFinite);
  if (!values.length) return null;
  return {
    count: values.length,
    latest: readings[readings.length - 1],
    averageMgDl: Math.round(values.reduce((sum, value) => sum + value, 0) / values.length),
    minMgDl: Math.min(...values),
    maxMgDl: Math.max(...values),
  };
}

export function bloodGlucoseFields(readings = [], record = null) {
  const aligned = record ? readingsWithinRecord(readings, record) : readings;
  const summary = summarizeBloodGlucose(aligned);
  if (!summary) return { blood_glucose_readings: [] };
  return {
    blood_glucose_readings: aligned,
    latest_blood_glucose_reading: summary.latest,
    avg_blood_glucose_mg_dl: summary.averageMgDl,
    min_blood_glucose_mg_dl: summary.minMgDl,
    max_blood_glucose_mg_dl: summary.maxMgDl,
    blood_glucose_source: "OneTouch Reveal CSV",
  };
}
