function parseCsvLine(line, delimiter = ",") {
  const cols = [];
  let current = "";
  let quoted = false;
  for (let i = 0; i < line.length; i += 1) {
    const char = line[i];
    const next = line[i + 1];
    if (char === '"' && quoted && next === '"') {
      current += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === delimiter && !quoted) {
      cols.push(current);
      current = "";
    } else {
      current += char;
    }
  }
  cols.push(current);
  return cols.map((value) => value.trim());
}

function normalizeHeader(value = "") {
  return String(value)
    .replace(/^\uFEFF/, "")
    .replace(/[₂₂]/g, "2")
    .replace(/[₀⁰]/g, "0")
    .trim()
    .toLowerCase()
    .replace(/[%()/_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function findHeaderIndex(headers, aliases) {
  const normalized = headers.map(normalizeHeader);
  return normalized.findIndex((header) => aliases.some((alias) => header === alias || header.includes(alias)));
}

function delimiterScore(lines, delimiter) {
  return lines.slice(0, 30).reduce((best, line) => {
    const columns = parseCsvLine(line, delimiter);
    return Math.max(best, columns.length);
  }, 0);
}

function detectDelimiter(lines) {
  return [",", "\t", ";", "|"].reduce((best, delimiter) => {
    const score = delimiterScore(lines, delimiter);
    return score > best.score ? { delimiter, score } : best;
  }, { delimiter: ",", score: 0 }).delimiter;
}

function cleanNumber(value) {
  if (value == null) return null;
  const cleaned = String(value).replace(/[^\d.+-]/g, "");
  if (!cleaned) return null;
  const num = Number(cleaned);
  return Number.isFinite(num) ? num : null;
}

function parseTimestamp(value) {
  if (!value) return null;
  const raw = String(value).trim();
  const parsed = new Date(raw);
  if (!Number.isNaN(parsed.getTime())) return parsed;

  const normalized = raw.replace(/\s+/g, " ").replace(/(\d)\.(\d)/g, "$1:$2");
  const match = normalized.match(/^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})[ T]+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
  if (!match) return null;
  const [, month, day, yearRaw, hourRaw, minute, second = "0", ampm] = match;
  let year = Number(yearRaw);
  if (year < 100) year += 2000;
  let hour = Number(hourRaw);
  if (/pm/i.test(ampm || "") && hour < 12) hour += 12;
  if (/am/i.test(ampm || "") && hour === 12) hour = 0;
  const candidate = new Date(year, Number(month) - 1, Number(day), hour, Number(minute), Number(second));
  return Number.isNaN(candidate.getTime()) ? null : candidate;
}

function combineDateAndTime(dateValue, timeValue) {
  const date = String(dateValue || "").trim();
  const time = String(timeValue || "").trim();
  return parseTimestamp(`${date} ${time}`) || parseTimestamp(`${time} ${date}`);
}

function pickFirstNumeric(cols, indexes) {
  for (const index of indexes) {
    if (index < 0) continue;
    const value = cleanNumber(cols[index]);
    if (value != null) return value;
  }
  return null;
}

function findHeaderRow(lines, delimiter) {
  const candidates = lines.slice(0, 40);
  for (let index = 0; index < candidates.length; index += 1) {
    const headers = parseCsvLine(candidates[index], delimiter);
    const timeIdx = findHeaderIndex(headers, ["time", "timestamp", "date time", "datetime", "record time", "measurement time", "measured at"]);
    const dateIdx = findHeaderIndex(headers, ["date", "record date", "measurement date"]);
    const spo2Idx = findHeaderIndex(headers, ["spo2", "sp02", "sp o2", "sp 02", "oxygen", "blood oxygen", "oxygen saturation", "o2"]);
    if ((timeIdx !== -1 || dateIdx !== -1) && spo2Idx !== -1) {
      return { index, headers };
    }
  }
  return { index: 0, headers: parseCsvLine(lines[0], delimiter) };
}

export function decodePulseOxCsvBytes(value) {
  const bytes = value instanceof Uint8Array ? value : new Uint8Array(value || []);
  if (!bytes.length) return "";
  if (bytes[0] === 0xff && bytes[1] === 0xfe) {
    return new TextDecoder("utf-16le").decode(bytes.subarray(2));
  }
  if (bytes[0] === 0xfe && bytes[1] === 0xff) {
    const swapped = new Uint8Array(bytes.length - 2);
    for (let index = 2; index + 1 < bytes.length; index += 2) {
      swapped[index - 2] = bytes[index + 1];
      swapped[index - 1] = bytes[index];
    }
    return new TextDecoder("utf-16le").decode(swapped);
  }
  const zeroBytes = bytes.slice(0, Math.min(bytes.length, 200)).filter((byte) => byte === 0).length;
  return new TextDecoder(zeroBytes > 10 ? "utf-16le" : "utf-8").decode(bytes);
}

export function parsePulseOxCsv(text, options = {}) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) {
    return { error: "CSV appears empty or has no data rows.", rows: [], skipped: 0, total: 0 };
  }

  const delimiter = detectDelimiter(lines);
  const headerRow = findHeaderRow(lines, delimiter);
  const headers = headerRow.headers;
  const timeIdx = findHeaderIndex(headers, ["time", "timestamp", "date time", "datetime", "record time"]);
  const dateIdx = findHeaderIndex(headers, ["date", "record date", "measurement date"]);
  const spo2Idx = findHeaderIndex(headers, ["spo2", "sp02", "sp o2", "sp 02", "oxygen", "blood oxygen", "oxygen saturation", "o2"]);
  const pulseIdx = findHeaderIndex(headers, ["pulse rate", "pulse", "pr", "bpm", "heart rate", "hr"]);
  const piIdx = findHeaderIndex(headers, ["pi", "perfusion", "perfusion index"]);

  const fallbackLikelyEmay = timeIdx !== -1 && spo2Idx === -1 && pulseIdx === -1 && headers.length >= 3;
  const resolvedSpo2Idx = spo2Idx !== -1 ? spo2Idx : (fallbackLikelyEmay ? 1 : -1);
  const resolvedPulseIdx = pulseIdx !== -1 ? pulseIdx : (fallbackLikelyEmay ? 2 : -1);

  if (timeIdx === -1 && dateIdx === -1) {
    return { error: "Could not find a time/timestamp column in the pulse-ox CSV.", rows: [], skipped: lines.length - 1, total: lines.length - 1 };
  }
  if (resolvedSpo2Idx === -1) {
    return { error: "Could not find a SpO2/oxygen saturation column in the pulse-ox CSV.", rows: [], skipped: lines.length - 1, total: lines.length - 1 };
  }

  const rawRows = [];
  const skipReasons = [];
  const dataLines = lines.slice(headerRow.index + 1);

  dataLines.forEach((line, index) => {
    const rowNum = index + 2;
    const cols = parseCsvLine(line, delimiter);
    const measuredAtDate = dateIdx !== -1 && timeIdx !== -1 && dateIdx !== timeIdx
      ? combineDateAndTime(cols[dateIdx], cols[timeIdx])
      : parseTimestamp(cols[timeIdx !== -1 ? timeIdx : dateIdx]);
    const spo2 = cleanNumber(cols[resolvedSpo2Idx]);
    const pulse = pickFirstNumeric(cols, [resolvedPulseIdx]);
    const perfusionIndex = cleanNumber(cols[piIdx]);

    if (!measuredAtDate) {
      skipReasons.push(`Row ${rowNum}: invalid timestamp`);
      return;
    }
    if (spo2 == null || spo2 < 50 || spo2 > 100) {
      skipReasons.push(`Row ${rowNum}: invalid SpO2`);
      return;
    }
    if (pulse != null && (pulse < 20 || pulse > 240)) {
      skipReasons.push(`Row ${rowNum}: invalid pulse rate`);
      return;
    }

    rawRows.push({
      measured_at: measuredAtDate.toISOString(),
      spo2_percent: Math.round(spo2),
      pulse_bpm: pulse != null ? Math.round(pulse) : null,
      perfusion_index: perfusionIndex,
      source_app: options.sourceApp || "EMAY app CSV",
      source_device: options.sourceDevice || "EMAY pulse oximeter",
    });
  });

  if (!rawRows.length) {
    return {
      error: `No valid pulse-ox rows found. Detected columns: ${headers.filter(Boolean).join(", ") || "none"}.`,
      rows: [],
      skipped: dataLines.length,
      total: dataLines.length,
      skipReasons,
      detectedHeaders: headers,
      delimiter,
    };
  }

  rawRows.sort((a, b) => new Date(a.measured_at).getTime() - new Date(b.measured_at).getTime());
  const sessionStartMs = options.sessionStartAt ? new Date(options.sessionStartAt).getTime() : NaN;
  const sessionEndMs = options.sessionEndAt ? new Date(options.sessionEndAt).getTime() : NaN;
  const hasSessionStart = Number.isFinite(sessionStartMs);
  const hasSessionEnd = Number.isFinite(sessionEndMs);
  let filteredBefore = 0;
  let filteredAfter = 0;
  const firstMs = hasSessionStart ? sessionStartMs : new Date(rawRows[0].measured_at).getTime();
  const alignedRows = rawRows.filter((row) => {
    const measuredMs = new Date(row.measured_at).getTime();
    if (hasSessionStart && measuredMs < sessionStartMs) {
      filteredBefore += 1;
      return false;
    }
    if (hasSessionEnd && measuredMs > sessionEndMs) {
      filteredAfter += 1;
      return false;
    }
    return true;
  });

  if (!alignedRows.length) {
    return {
      error: hasSessionStart
        ? "No pulse-ox rows fall inside this session start/end window."
        : "No valid pulse-ox rows found.",
      rows: [],
      skipped: dataLines.length,
      total: dataLines.length,
      skipReasons,
      filteredBefore,
      filteredAfter,
    };
  }

  const rows = alignedRows.map((row, index) => ({
    ...row,
    id: row.id || `pulseox-${row.measured_at}-${index}`,
    time_offset_s: Math.max(0, Math.round((new Date(row.measured_at).getTime() - firstMs) / 1000)),
  }));

  return {
    rows,
    total: dataLines.length,
    imported: rows.length,
    skipped: dataLines.length - rows.length,
    skipReasons,
    filteredBefore,
    filteredAfter,
    alignedToSession: hasSessionStart,
    sessionStartAt: hasSessionStart ? new Date(sessionStartMs).toISOString() : null,
    sessionEndAt: hasSessionEnd ? new Date(sessionEndMs).toISOString() : null,
    firstTimestamp: rows[0]?.measured_at || null,
    lastTimestamp: rows[rows.length - 1]?.measured_at || null,
    detectedHeaders: headers,
    delimiter,
  };
}
