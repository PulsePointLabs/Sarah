import { parseDeviceLocalTimestamp } from "./localRecordTime.js";
import { decodePulseOxCsvBytes } from "./parsePulseOxCsv.js";

function parseLine(line, delimiter) {
  const values = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && quoted && line[index + 1] === '"') {
      value += '"';
      index += 1;
    } else if (char === '"') quoted = !quoted;
    else if (char === delimiter && !quoted) {
      values.push(value.trim());
      value = "";
    } else value += char;
  }
  values.push(value.trim());
  return values;
}

function normalize(value) {
  return String(value || "").replace(/^\uFEFF/, "").trim().toLowerCase().replace(/[_()%/-]+/g, " ").replace(/\s+/g, " ");
}

function find(headers, aliases) {
  const normalized = headers.map(normalize);
  return normalized.findIndex((header) => aliases.some((alias) => header === alias || header.includes(alias)));
}

const GLUCOSE_HEADERS = [
  "blood glucose",
  "glucose value",
  "glucose reading",
  "blood sugar",
  "bg value",
  "bg reading",
  "glucose",
  "result",
];

const GENERIC_VALUE_HEADERS = ["event value", "reading value", "measurement value", "value"];
const EVENT_TYPE_HEADERS = ["event type", "record type", "reading type", "measurement type", "type"];
const COMBINED_TIME_HEADERS = [
  "date and time",
  "date time",
  "datetime",
  "time stamp",
  "timestamp",
  "device timestamp",
  "measured at",
  "reading time",
  "event time",
];
const DATE_HEADERS = ["reading date", "measurement date", "event date", "date"];

function findSchema(headers) {
  const glucoseIndex = find(headers, GLUCOSE_HEADERS);
  const eventTypeIndex = find(headers, EVENT_TYPE_HEADERS);
  const genericValueIndex = find(headers, GENERIC_VALUE_HEADERS);
  const timeIndex = find(headers, COMBINED_TIME_HEADERS);
  const dateIndex = find(headers, DATE_HEADERS);
  const hasTimestamp = timeIndex >= 0 || dateIndex >= 0;
  const valueIndex = glucoseIndex >= 0 ? glucoseIndex : genericValueIndex;
  const isMixedEventTable = glucoseIndex < 0 && genericValueIndex >= 0 && eventTypeIndex >= 0;
  return {
    glucoseIndex: valueIndex,
    eventTypeIndex,
    timeIndex,
    dateIndex,
    valid: valueIndex >= 0 && hasTimestamp && (glucoseIndex >= 0 || isMixedEventTable),
  };
}

function isGlucoseEvent(value) {
  const type = normalize(value);
  return type === "bg"
    || type.includes("blood glucose")
    || type.includes("blood sugar")
    || type.includes("glucose");
}

function number(value) {
  const match = String(value || "").replace(/,/g, "").match(/-?\d+(?:\.\d+)?/);
  return match ? Number(match[0]) : null;
}

function detectDelimiter(lines) {
  return [",", "\t", ";", "|"].map((delimiter) => ({
    delimiter,
    columns: Math.max(...lines.slice(0, 20).map((line) => parseLine(line, delimiter).length)),
  })).sort((a, b) => b.columns - a.columns)[0].delimiter;
}

export { decodePulseOxCsvBytes as decodeBloodGlucoseCsvBytes };

export function parseBloodGlucoseCsv(text) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return { error: "CSV appears empty or has no data rows.", rows: [] };
  const delimiter = detectDelimiter(lines);
  let headerIndex = -1;
  let headers = [];
  for (let index = 0; index < Math.min(lines.length, 50); index += 1) {
    const candidate = parseLine(lines[index], delimiter);
    if (findSchema(candidate).valid) {
      headerIndex = index;
      headers = candidate;
      break;
    }
  }
  if (headerIndex < 0) {
    return { error: "Could not find OneTouch date/time and glucose columns.", rows: [], detectedHeaders: parseLine(lines[0], delimiter) };
  }

  const {
    glucoseIndex,
    eventTypeIndex,
    timeIndex,
    dateIndex,
  } = findSchema(headers);
  const unitIndex = find(headers, ["unit", "units"]);
  const mealIndex = find(headers, ["meal tag", "meal", "tag"]);
  const noteIndex = find(headers, ["notes", "note", "comment"]);
  const rows = [];
  const skipReasons = [];

  lines.slice(headerIndex + 1).forEach((line, offset) => {
    const columns = parseLine(line, delimiter);
    if (eventTypeIndex >= 0 && !isGlucoseEvent(columns[eventTypeIndex])) return;
    const timestampText = dateIndex >= 0 && timeIndex >= 0 && dateIndex !== timeIndex
      ? `${columns[dateIndex]} ${columns[timeIndex]}`
      : columns[timeIndex >= 0 ? timeIndex : dateIndex];
    const measured = parseDeviceLocalTimestamp(timestampText);
    const rawValue = number(columns[glucoseIndex]);
    const unitText = `${columns[unitIndex] || ""} ${headers[glucoseIndex] || ""} ${columns[glucoseIndex] || ""}`.toLowerCase();
    const isMmol = unitText.includes("mmol");
    const mgDl = rawValue == null ? null : (isMmol ? rawValue * 18.0182 : rawValue);
    if (!measured || !Number.isFinite(mgDl) || mgDl < 20 || mgDl > 700) {
      skipReasons.push(`Row ${headerIndex + offset + 2}: invalid ${!measured ? "timestamp" : "glucose value"}`);
      return;
    }
    rows.push({
      measured_at: measured.toISOString(),
      glucose_mg_dl: Math.round(mgDl),
      glucose_mmol_l: Number((mgDl / 18.0182).toFixed(1)),
      original_value: rawValue,
      original_unit: isMmol ? "mmol/L" : "mg/dL",
      meal_tag: mealIndex >= 0 ? columns[mealIndex] || "" : "",
      notes: noteIndex >= 0 ? columns[noteIndex] || "" : "",
      source_app: "OneTouch Reveal CSV",
      source_device: "OneTouch meter",
      timestamp_interpretation: "device local time",
    });
  });

  rows.sort((a, b) => new Date(a.measured_at) - new Date(b.measured_at));
  if (!rows.length) return { error: "No valid OneTouch glucose rows found.", rows, skipReasons, detectedHeaders: headers };
  return {
    rows,
    total: lines.length - headerIndex - 1,
    imported: rows.length,
    skipped: lines.length - headerIndex - 1 - rows.length,
    skipReasons,
    detectedHeaders: headers,
    firstTimestamp: rows[0].measured_at,
    lastTimestamp: rows[rows.length - 1].measured_at,
    timestampInterpretation: "CSV clock values interpreted as local device time",
  };
}
