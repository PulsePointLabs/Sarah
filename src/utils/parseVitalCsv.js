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

function linesAndHeaders(text) {
  const lines = String(text || "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (lines.length < 2) return { error: "CSV appears empty or has no data rows." };
  const delimiter = [",", "\t", ";", "|"].map((candidate) => ({
    candidate,
    score: Math.max(...lines.slice(0, 20).map((line) => parseLine(line, candidate).length)),
  })).sort((a, b) => b.score - a.score)[0].candidate;
  const headers = parseLine(lines[0], delimiter);
  return { lines, delimiter, headers, normalized: headers.map(normalize) };
}

function indexOf(headers, aliases) {
  return headers.findIndex((header) => aliases.some((alias) => header === alias || header.includes(alias)));
}

function number(value) {
  const parsed = Number(String(value ?? "").replace(/[^\d.+-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function timestamp(columns, headers) {
  const dateIndex = indexOf(headers, ["date", "measurement date", "record date"]);
  const timeIndex = indexOf(headers, ["timestamp", "date time", "datetime", "measured at", "measurement time", "record time", "time"]);
  const raw = dateIndex >= 0 && timeIndex >= 0 && dateIndex !== timeIndex
    ? `${columns[dateIndex]} ${columns[timeIndex]}`
    : columns[timeIndex >= 0 ? timeIndex : dateIndex];
  if (!raw) return null;
  const parsed = new Date(raw);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
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
  if (/body fat|lean body|weight|visceral fat|muscle mass|body water|bmi/.test(joined)) return { type: "body_composition", headers: parsed.headers };
  return { type: null, headers: parsed.headers, error: "Sarah could not identify this CSV from its headers. Choose the import type manually." };
}

export function parseBloodGlucoseCsv(text, options = {}) {
  const parsed = linesAndHeaders(text);
  if (parsed.error) return { ...parsed, rows: [] };
  const glucoseIndex = indexOf(parsed.normalized, ["blood glucose", "blood sugar", "glucose", "result", "value"]);
  const unitIndex = indexOf(parsed.normalized, ["unit", "units"]);
  if (glucoseIndex < 0) return { error: "Could not find a blood-glucose column.", rows: [], headers: parsed.headers };
  const rows = [];
  parsed.lines.slice(1).forEach((line, index) => {
    const columns = parseLine(line, parsed.delimiter);
    const measuredAt = timestamp(columns, parsed.normalized);
    let glucose = number(columns[glucoseIndex]);
    const unit = `${columns[unitIndex] || ""} ${parsed.headers[glucoseIndex] || ""}`.toLowerCase();
    if (glucose != null && /mmol/.test(unit)) glucose *= 18.0182;
    if (!measuredAt || glucose == null || glucose < 20 || glucose > 700) return;
    rows.push({
      id: `blood-glucose-${measuredAt}-${index}`,
      measured_at: measuredAt,
      glucose_mg_dl: Math.round(glucose * 10) / 10,
      source_app: options.sourceApp || "CSV import",
      source_device: options.sourceDevice || "",
      import_source: "csv",
    });
  });
  return rows.length ? { rows, imported: rows.length, total: parsed.lines.length - 1, headers: parsed.headers } : { error: "No valid blood-glucose rows were found.", rows: [], headers: parsed.headers };
}

export function parseBodyCompositionCsv(text, options = {}) {
  const parsed = linesAndHeaders(text);
  if (parsed.error) return { ...parsed, rows: [] };
  const weightIndex = indexOf(parsed.normalized, ["weight", "body weight", "mass"]);
  const fatIndex = indexOf(parsed.normalized, ["body fat", "fat percent", "fat percentage"]);
  const bmiIndex = indexOf(parsed.normalized, ["bmi", "body mass index"]);
  const leanIndex = indexOf(parsed.normalized, ["lean body mass", "lean mass", "fat free mass"]);
  const unitIndex = indexOf(parsed.normalized, ["unit", "units"]);
  if (weightIndex < 0) return { error: "Could not find a body-weight column.", rows: [], headers: parsed.headers };
  const rows = [];
  parsed.lines.slice(1).forEach((line, index) => {
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
  return rows.length ? { rows, imported: rows.length, total: parsed.lines.length - 1, headers: parsed.headers } : { error: "No valid body-composition rows were found.", rows: [], headers: parsed.headers };
}
