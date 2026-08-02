const KG_PER_LB = 0.45359237;

function parseLine(line, delimiter) {
  const columns = [];
  let value = "";
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (char === '"' && quoted && line[index + 1] === '"') {
      value += '"';
      index += 1;
    } else if (char === '"') quoted = !quoted;
    else if (char === delimiter && !quoted) {
      columns.push(value.trim());
      value = "";
    } else value += char;
  }
  columns.push(value.trim());
  return columns;
}

function normalize(value = "") {
  return String(value).replace(/^\uFEFF/, "").toLowerCase().replace(/[%()/_-]+/g, " ").replace(/\s+/g, " ").trim();
}

const HEADER_TERMS = {
  pulse_ox: ["spo2", "sp02", "oxygen saturation", "blood oxygen", "pulse rate", "perfusion"],
  blood_glucose: ["blood glucose", "blood sugar", "glucose", "glucose value", "glucose reading", "bg value", "bg reading", "result", "mg dl", "mmol"],
  body_composition: ["body fat", "lean body", "weight", "visceral fat", "muscle mass", "body water", "bmi"],
};

const TIME_TERMS = ["date", "time", "timestamp", "measured at", "measurement date", "measurement time", "device timestamp"];

function headerScore(headers, kind) {
  const normalized = headers.map(normalize);
  const terms = kind ? HEADER_TERMS[kind] : Object.values(HEADER_TERMS).flat();
  const vitalHits = normalized.filter((header) => terms.some((term) => header === term || header.includes(term))).length;
  const timeHits = normalized.filter((header) => TIME_TERMS.some((term) => header === term || header.includes(term))).length;
  const mixedGlucoseTable = normalized.some((header) => ["event type", "record type", "reading type", "measurement type"].some((term) => header.includes(term)))
    && normalized.some((header) => ["event value", "reading value", "measurement value", "value"].some((term) => header === term || header.includes(term)));
  const mixedGlucoseScore = mixedGlucoseTable && (!kind || kind === "blood_glucose") ? 40 : 0;
  return vitalHits * 20 + timeHits * 5 + mixedGlucoseScore + Math.min(headers.length, 12);
}

function linesAndHeaders(text, kind) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return { error: "CSV appears empty or has no data rows." };
  const delimiter = [",", "\t", ";", "|"].map((candidate) => ({
    candidate,
    score: Math.max(...lines.slice(0, 60).map((line) => parseLine(line, candidate).length)),
  })).sort((a, b) => b.score - a.score)[0].candidate;
  const candidates = lines.slice(0, 60).map((line, index) => {
    const headers = parseLine(line, delimiter);
    return { index, headers, score: headerScore(headers, kind) };
  }).sort((a, b) => b.score - a.score || a.index - b.index);
  const selected = candidates[0];
  if (!selected || selected.score < 20) return { error: "Could not find a recognized vital-sign header row." };
  return {
    lines,
    delimiter,
    headerIndex: selected.index,
    headers: selected.headers,
    normalized: selected.headers.map(normalize),
    dataLines: lines.slice(selected.index + 1),
  };
}

function indexOf(headers, aliases) {
  return headers.findIndex((header) => aliases.some((alias) => header === alias || header.includes(alias)));
}

function number(value) {
  const cleaned = String(value ?? "").replace(/[^\d.+-]/g, "");
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function parseDeviceLocalTimestamp(value) {
  if (!value) return null;
  const raw = String(value).trim().replace(/\s+/g, " ");
  const withoutZoneName = raw.replace(/\s+(?:EST|EDT|CST|CDT|MST|MDT|PST|PDT|UTC|GMT)(?:[+-]\d{1,2})?$/i, "").trim();

  if (/^\d{10,13}$/.test(withoutZoneName)) {
    const numeric = Number(withoutZoneName);
    const epochMs = withoutZoneName.length === 10 ? numeric * 1000 : numeric;
    const epochDate = new Date(epochMs);
    if (!Number.isNaN(epochDate.getTime()) && epochDate.getFullYear() >= 2000 && epochDate.getFullYear() <= 2100) return epochDate;
  }

  if (/^\d{5}(?:\.\d+)?$/.test(withoutZoneName)) {
    const serial = Number(withoutZoneName);
    if (serial >= 36_526 && serial <= 73_050) {
      const utc = new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000);
      return new Date(utc.getUTCFullYear(), utc.getUTCMonth(), utc.getUTCDate(), utc.getUTCHours(), utc.getUTCMinutes(), utc.getUTCSeconds());
    }
  }

  const compact = withoutZoneName.match(/^(\d{4})(\d{2})(\d{2})[ T_-]?(\d{2})(\d{2})(\d{2})?$/);
  if (compact) {
    const local = new Date(Number(compact[1]), Number(compact[2]) - 1, Number(compact[3]), Number(compact[4]), Number(compact[5]), Number(compact[6] || 0));
    return Number.isNaN(local.getTime()) ? null : local;
  }

  const match = withoutZoneName.match(
    /^(\d{4})[./-](\d{1,2})[./-](\d{1,2})[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?(?:\s*(?:Z|[+-]\d{2}:?\d{2}))?$/i,
  ) || withoutZoneName.match(
    /^(\d{1,2})[./-](\d{1,2})[./-](\d{2,4})[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?(?:\s*(?:Z|[+-]\d{2}:?\d{2}))?$/i,
  );
  if (match) {
    const yearFirst = match[1].length === 4;
    let year = Number(yearFirst ? match[1] : match[3]);
    if (year < 100) year += 2000;
    const first = Number(match[1]);
    const second = Number(match[2]);
    const month = Number(yearFirst ? match[2] : first > 12 ? second : first);
    const day = Number(yearFirst ? match[3] : first > 12 ? first : second);
    let hour = Number(match[4]);
    if (/pm/i.test(match[7] || "") && hour < 12) hour += 12;
    if (/am/i.test(match[7] || "") && hour === 12) hour = 0;
    const local = new Date(year, month - 1, day, hour, Number(match[5]), Number(match[6] || 0));
    if (!Number.isNaN(local.getTime()) && local.getFullYear() === year && local.getMonth() === month - 1 && local.getDate() === day) return local;
  }

  const monthNames = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const named = withoutZoneName.match(/^([A-Za-z]{3,9})[ .-]+(\d{1,2}),?[ .-]+(\d{4})[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i)
    || withoutZoneName.match(/^(\d{1,2})[ .-]+([A-Za-z]{3,9})[ .,-]+(\d{4})[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (named) {
    const monthFirst = /^[A-Za-z]/.test(named[1]);
    const monthToken = String(monthFirst ? named[1] : named[2]).slice(0, 3).toLowerCase();
    const month = monthNames[monthToken];
    const day = Number(monthFirst ? named[2] : named[1]);
    const year = Number(named[3]);
    let hour = Number(named[4]);
    if (/pm/i.test(named[7] || "") && hour < 12) hour += 12;
    if (/am/i.test(named[7] || "") && hour === 12) hour = 0;
    const local = new Date(year, month, day, hour, Number(named[5]), Number(named[6] || 0));
    if (month != null && !Number.isNaN(local.getTime())) return local;
  }

  const parsed = new Date(withoutZoneName);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function timestampText(columns, headers) {
  const dateIndex = indexOf(headers, ["date", "measurement date", "record date", "device date"]);
  const timeIndex = indexOf(headers, ["device timestamp", "timestamp", "date time", "datetime", "measured at", "measurement time", "record time", "device time", "time"]);
  return dateIndex >= 0 && timeIndex >= 0 && dateIndex !== timeIndex
    ? `${columns[dateIndex]} ${columns[timeIndex]}`
    : columns[timeIndex >= 0 ? timeIndex : dateIndex];
}

function timestamp(columns, headers) {
  const raw = timestampText(columns, headers);
  if (!raw) return null;
  const parsed = parseDeviceLocalTimestamp(raw);
  return parsed ? parsed.toISOString() : null;
}

function repairUnquotedMonthDate(columns, headers) {
  if (columns.length !== headers.length + 1) return columns;
  const dateIndex = indexOf(headers, ["date", "measurement date", "record date", "device date"]);
  if (dateIndex < 0) return columns;
  const first = String(columns[dateIndex] || "").trim();
  const second = String(columns[dateIndex + 1] || "").trim();
  if (!/^[A-Za-z]{3,9}\s+\d{1,2}$/.test(first) || !/^\d{4}$/.test(second)) return columns;
  return [...columns.slice(0, dateIndex), `${first}, ${second}`, ...columns.slice(dateIndex + 2)];
}

function isGlucoseEvent(value) {
  const type = normalize(value);
  return type === "bg" || type.includes("blood glucose") || type.includes("blood sugar") || type.includes("glucose");
}

export function decodeVitalCsvBytes(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value || []);
  if (bytes[0] === 0xff && bytes[1] === 0xfe) return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  const zeros = bytes.slice(0, Math.min(bytes.length, 200)).filter((byte) => byte === 0).length;
  return new TextDecoder(zeros > 10 ? "utf-16le" : "utf-8").decode(bytes);
}

export function classifyVitalCsv(text) {
  const parsed = linesAndHeaders(text);
  if (parsed.error) return { type: null, error: parsed.error, headers: [] };
  const joined = parsed.normalized.join(" | ");
  if (/spo2|sp02|oxygen saturation|blood oxygen|pulse rate|perfusion/.test(joined)) return { type: "pulse_ox", headers: parsed.headers };
  if (/blood glucose|blood sugar|glucose|mmol|mg dl/.test(joined)) return { type: "blood_glucose", headers: parsed.headers };
  if (/event type|record type|reading type|measurement type/.test(joined) && /event value|reading value|measurement value|\bvalue\b/.test(joined)) return { type: "blood_glucose", headers: parsed.headers };
  if (/body fat|lean body|weight|visceral fat|muscle mass|body water|bmi/.test(joined)) return { type: "body_composition", headers: parsed.headers };
  return { type: null, headers: parsed.headers, error: "Sarah could not identify this CSV from its headers. Choose the import type manually." };
}

export function parseBloodGlucoseCsv(text, options = {}) {
  const parsed = linesAndHeaders(text, "blood_glucose");
  if (parsed.error) return { ...parsed, rows: [] };
  const specificGlucoseIndex = indexOf(parsed.normalized, ["blood glucose", "blood sugar", "glucose value", "glucose reading", "blood glucose result", "bg value", "bg reading", "glucose", "result"]);
  const eventTypeIndex = indexOf(parsed.normalized, ["event type", "record type", "reading type", "measurement type", "type"]);
  const genericValueIndex = indexOf(parsed.normalized, ["event value", "reading value", "measurement value", "value"]);
  const glucoseIndex = specificGlucoseIndex >= 0 ? specificGlucoseIndex : genericValueIndex;
  const unitIndex = indexOf(parsed.normalized, ["glucose units", "glucose unit", "unit", "units"]);
  if (glucoseIndex < 0 || (specificGlucoseIndex < 0 && eventTypeIndex < 0)) return { error: "Could not find OneTouch date/time and glucose columns.", rows: [], headers: parsed.headers };
  const rows = [];
  const skipReasons = [];
  parsed.dataLines.forEach((line, index) => {
    const columns = repairUnquotedMonthDate(parseLine(line, parsed.delimiter), parsed.normalized);
    if (eventTypeIndex >= 0 && !isGlucoseEvent(columns[eventTypeIndex])) return;
    const rawTimestamp = timestampText(columns, parsed.normalized);
    const measuredAt = timestamp(columns, parsed.normalized);
    let glucose = number(columns[glucoseIndex]);
    const unit = `${columns[unitIndex] || ""} ${parsed.headers[glucoseIndex] || ""}`.toLowerCase();
    if (glucose != null && /mmol/.test(unit)) glucose *= 18.0182;
    if (!measuredAt || glucose == null || glucose < 20 || glucose > 700) {
      const timestampHint = !measuredAt ? ` ${JSON.stringify(String(rawTimestamp || "").slice(0, 80))}` : "";
      skipReasons.push(`Row ${parsed.headerIndex + index + 2}: invalid ${!measuredAt ? "timestamp" : "glucose value"}${timestampHint}`);
      return;
    }
    rows.push({
      id: `blood-glucose-${measuredAt}-${index}`,
      measured_at: measuredAt,
      glucose_mg_dl: Math.round(glucose * 10) / 10,
      source_app: options.sourceApp || "CSV import",
      source_device: options.sourceDevice || "",
      import_source: "csv",
    });
  });
  return rows.length
    ? { rows, imported: rows.length, total: parsed.dataLines.length, skipped: parsed.dataLines.length - rows.length, skipReasons, headerRow: parsed.headerIndex + 1, headers: parsed.headers }
    : { error: "No valid blood-glucose rows were found after the detected header row.", rows: [], skipReasons, headers: parsed.headers };
}

export function parseBodyCompositionCsv(text, options = {}) {
  const parsed = linesAndHeaders(text, "body_composition");
  if (parsed.error) return { ...parsed, rows: [] };
  const weightIndex = indexOf(parsed.normalized, ["weight", "body weight", "mass"]);
  const fatIndex = indexOf(parsed.normalized, ["body fat", "fat percent", "fat percentage"]);
  const bmiIndex = indexOf(parsed.normalized, ["bmi", "body mass index"]);
  const leanIndex = indexOf(parsed.normalized, ["lean body mass", "lean mass", "fat free mass"]);
  const unitIndex = indexOf(parsed.normalized, ["unit", "units"]);
  if (weightIndex < 0) return { error: "Could not find a body-weight column.", rows: [], headers: parsed.headers };
  const rows = [];
  parsed.dataLines.forEach((line, index) => {
    const columns = parseLine(line, parsed.delimiter);
    const measuredAt = timestamp(columns, parsed.normalized);
    let weightKg = number(columns[weightIndex]);
    const unit = `${columns[unitIndex] || ""} ${parsed.headers[weightIndex] || ""}`.toLowerCase();
    if (weightKg != null && /\blb|pound/.test(unit)) weightKg *= KG_PER_LB;
    if (!measuredAt || weightKg == null || weightKg < 20 || weightKg > 350) return;
    rows.push({
      id: `body-composition-${measuredAt}-${index}`,
      measured_at: measuredAt,
      weight_kg: Math.round(weightKg * 100) / 100,
      body_fat_percent: number(columns[fatIndex]),
      lean_body_mass_kg: number(columns[leanIndex]),
      bmi: number(columns[bmiIndex]),
      source_app: options.sourceApp || "CSV import",
      source_device: options.sourceDevice || "",
      import_source: "csv",
    });
  });
  return rows.length ? { rows, imported: rows.length, total: parsed.dataLines.length, headerRow: parsed.headerIndex + 1, headers: parsed.headers } : { error: "No valid body-composition rows were found after the detected header row.", rows: [], headers: parsed.headers };
}
