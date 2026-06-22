function parseCsvLine(line) {
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
    } else if (char === "," && !quoted) {
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
    .trim()
    .toLowerCase()
    .replace(/[%()/_-]+/g, " ")
    .replace(/\s+/g, " ");
}

function findHeaderIndex(headers, aliases) {
  const normalized = headers.map(normalizeHeader);
  return normalized.findIndex((header) => aliases.some((alias) => header === alias || header.includes(alias)));
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

  const match = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*(AM|PM)?$/i);
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

function pickFirstNumeric(cols, indexes) {
  for (const index of indexes) {
    if (index < 0) continue;
    const value = cleanNumber(cols[index]);
    if (value != null) return value;
  }
  return null;
}

export function parsePulseOxCsv(text, options = {}) {
  const lines = String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  if (lines.length < 2) {
    return { error: "CSV appears empty or has no data rows.", rows: [], skipped: 0, total: 0 };
  }

  const headers = parseCsvLine(lines[0]);
  const timeIdx = findHeaderIndex(headers, ["time", "timestamp", "date time", "datetime", "record time"]);
  const spo2Idx = findHeaderIndex(headers, ["spo2", "sp o2", "oxygen", "blood oxygen", "oxygen saturation"]);
  const pulseIdx = findHeaderIndex(headers, ["pulse rate", "pulse", "pr", "bpm", "heart rate", "hr"]);
  const piIdx = findHeaderIndex(headers, ["pi", "perfusion", "perfusion index"]);

  const fallbackLikelyEmay = timeIdx !== -1 && spo2Idx === -1 && pulseIdx === -1 && headers.length >= 3;
  const resolvedSpo2Idx = spo2Idx !== -1 ? spo2Idx : (fallbackLikelyEmay ? 1 : -1);
  const resolvedPulseIdx = pulseIdx !== -1 ? pulseIdx : (fallbackLikelyEmay ? 2 : -1);

  if (timeIdx === -1) {
    return { error: "Could not find a time/timestamp column in the pulse-ox CSV.", rows: [], skipped: lines.length - 1, total: lines.length - 1 };
  }
  if (resolvedSpo2Idx === -1) {
    return { error: "Could not find a SpO2/oxygen saturation column in the pulse-ox CSV.", rows: [], skipped: lines.length - 1, total: lines.length - 1 };
  }

  const rawRows = [];
  const skipReasons = [];
  const dataLines = lines.slice(1);

  dataLines.forEach((line, index) => {
    const rowNum = index + 2;
    const cols = parseCsvLine(line);
    const measuredAtDate = parseTimestamp(cols[timeIdx]);
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
    return { error: "No valid pulse-ox rows found.", rows: [], skipped: dataLines.length, total: dataLines.length, skipReasons };
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
  };
}
