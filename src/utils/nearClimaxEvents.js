function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function median(values = []) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function quantile(values = [], q = 0.5) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return null;
  const index = (sorted.length - 1) * q;
  const lower = Math.floor(index);
  const upper = Math.ceil(index);
  if (lower === upper) return sorted[lower];
  const weight = index - lower;
  return sorted[lower] * (1 - weight) + sorted[upper] * weight;
}

function hrvQualityRank(value) {
  const quality = String(value || "").toLowerCase();
  if (quality === "high") return 3;
  if (quality === "moderate") return 2;
  if (quality === "low") return 1;
  return 0;
}

function rowTime(row = {}) {
  return numberOrNull(row.time_offset_s ?? row.time_s ?? row.offset_s);
}

function rowHr(row = {}) {
  return numberOrNull(row.hr_smoothed ?? row.hr ?? row.heart_rate ?? row.bpm);
}

function rowRmssd(row = {}) {
  return numberOrNull(row.hrv_rmssd_ms ?? row.rmssd_ms ?? row.hrvRmssd);
}

function usableHrvRows(rows = []) {
  const ranked = rows.filter((row) => {
    const rmssd = rowRmssd(row);
    if (rmssd == null) return false;
    const quality = hrvQualityRank(row.hrv_quality);
    return quality >= 2 || !String(row.hrv_quality || "").trim();
  });
  return ranked.length ? ranked : rows.filter((row) => rowRmssd(row) != null);
}

export const NCE_KEYWORDS = [
  "tension", "tense", "tight", "tighten", "clench", "grip",
  "foot", "feet", "plant", "planting", "toe", "curl",
  "throb", "pulse", "pulsing", "twitch", "spasm",
  "edge", "edg", "near", "almost", "close", "threshold",
  "pressure", "build", "buildup", "surge", "wave", "rush",
  "intense", "intensity", "strong", "overwhelming",
  "breath", "breathing", "gasp", "hold",
  "shiver", "shak", "tremble",
];

export function scoreEventNoteCorroboration(eventStartS, eventEndS, sessionEvents) {
  if (!sessionEvents || sessionEvents.length === 0) return 0;
  const windowS = 45;
  let score = 0;
  for (const ev of sessionEvents) {
    const t = Number(ev.time_s);
    if (t < eventStartS - windowS || t > eventEndS + windowS) continue;
    const dist = Math.max(0, Math.min(Math.abs(t - eventStartS), Math.abs(t - eventEndS)));
    const proximityWeight = dist < 15 ? 2 : 1;
    const note = String(ev.note || "").toLowerCase();
    const cats = Array.isArray(ev.category) ? ev.category : [ev.category].filter(Boolean);
    if (cats.some((c) => ["physical", "sensation"].includes(c))) score += 1 * proximityWeight;
    for (const kw of NCE_KEYWORDS) {
      if (note.includes(kw)) {
        score += 2 * proximityWeight;
        break;
      }
    }
  }
  return score;
}

function smoothRows(rows = []) {
  return rows
    .map((row, index) => {
      const win = rows.slice(Math.max(0, index - 3), index + 4);
      const avg = win.reduce((sum, item) => sum + (rowHr(item) || 0), 0) / win.length;
      const time = rowTime(row);
      if (time == null) return null;
      return {
        t: time,
        hr: avg,
        rmssd: rowRmssd(row),
        hrv_quality: String(row.hrv_quality || "").toLowerCase(),
      };
    })
    .filter(Boolean);
}

function rowsBetween(rows, startS, endS) {
  return rows.filter((row) => row.t >= startS && row.t <= endS);
}

function summarizeCandidateHrv(candidateRows, referenceRmssd) {
  const usableRows = usableHrvRows(candidateRows);
  const values = usableRows.map((row) => rowRmssd(row)).filter(Number.isFinite);
  if (!values.length || !Number.isFinite(referenceRmssd)) {
    return { score: 0, compressed: false, opening: false, medianRmssd: null };
  }
  const candidateMedian = median(values);
  const compressed = candidateMedian <= Math.min(referenceRmssd * 0.72, referenceRmssd - 2) || candidateMedian <= 5.5;
  const opening = candidateMedian >= Math.max(referenceRmssd * 1.35, referenceRmssd + 3);
  return {
    score: compressed ? 2 : opening ? -1 : 0,
    compressed,
    opening,
    medianRmssd: candidateMedian,
  };
}

export function detectNearClimaxEvents(rows, climaxOffsetS, preClimaxOffsetS, sessionEvents = []) {
  if (!rows || rows.length < 10) return [];

  const smoothed = smoothRows(rows);
  if (smoothed.length < 10) return [];

  const excludeStart = climaxOffsetS != null
    ? (preClimaxOffsetS != null ? Math.min(preClimaxOffsetS, climaxOffsetS - 60) : climaxOffsetS - 90)
    : Infinity;
  const preClimaxRows = smoothed.filter((row) => row.t < excludeStart);
  if (preClimaxRows.length < 10) return [];

  const sessionDurationS = preClimaxRows[preClimaxRows.length - 1]?.t || 0;
  const sessionHrs = preClimaxRows.map((row) => row.hr).filter(Number.isFinite);
  const sessionMinHR = Math.min(...sessionHrs);
  const sessionMaxHR = Math.max(...sessionHrs);
  const sessionMedianHR = median(sessionHrs) || sessionMinHR;
  const sessionUpperQuartileHR = quantile(sessionHrs, 0.75) || sessionMedianHR;
  const sessionHRRange = sessionMaxHR - sessionMinHR;

  const baselineWindowEndS = Math.min(Math.max(300, sessionDurationS * 0.16), Math.max(300, sessionDurationS * 0.3));
  const baselineRows = preClimaxRows.filter((row) => row.t <= baselineWindowEndS);
  const baselineMedianHR = median(baselineRows.map((row) => row.hr)) || sessionMedianHR;
  const earlyNoiseGuardEndS = Math.min(8 * 60, sessionDurationS * 0.22);
  const compressedPlateauStartS = sessionDurationS * 0.48;
  const peakFloor = Math.max(
    baselineMedianHR + 9,
    sessionMedianHR + 4,
    sessionUpperQuartileHR,
    sessionMinHR + sessionHRRange * 0.42,
  );

  const allUsableHrv = usableHrvRows(preClimaxRows);
  const sessionMedianRmssd = median(allUsableHrv.map((row) => rowRmssd(row)).filter(Number.isFinite));

  const MIN_RISE_BPM = Math.max(7, sessionHRRange * 0.13);
  const MAX_RISE_BPM = sessionHRRange * 0.78;
  const RISE_WINDOW_S = 120;
  const SUSTAINED_THRESHOLD_S = 20;
  const SUSTAINED_TOLERANCE = 5;
  const DROP_BPM = Math.max(5, MIN_RISE_BPM * 0.55);
  const SEARCH_DROP_S = 150;
  const MIN_DURATION_S = 25;
  const MAX_DURATION_S = 300;
  const COOLDOWN_S = 30;
  const MIN_CONFIDENCE = 3;

  const events = [];
  let lastEventEnd = -Infinity;
  let i = 0;

  while (i < smoothed.length - 5) {
    const { t: t0, hr: hr0 } = smoothed[i];

    if (t0 < lastEventEnd + COOLDOWN_S) {
      i += 1;
      continue;
    }
    if (t0 >= excludeStart) break;

    let peakIdx = i;
    let peakHr = hr0;
    for (let j = i + 1; j < smoothed.length; j += 1) {
      if (smoothed[j].t - t0 > RISE_WINDOW_S) break;
      if (smoothed[j].t >= excludeStart) break;
      if (smoothed[j].hr > peakHr) {
        peakHr = smoothed[j].hr;
        peakIdx = j;
      }
    }

    const rise = peakHr - hr0;
    if (rise < MIN_RISE_BPM || rise > MAX_RISE_BPM || peakIdx === i) {
      i += 1;
      continue;
    }

    const peakTime = smoothed[peakIdx].t;

    let sustainedEndIdx = peakIdx;
    for (let j = peakIdx + 1; j < smoothed.length; j += 1) {
      if (smoothed[j].t - peakTime > 90) break;
      if (smoothed[j].hr >= peakHr - SUSTAINED_TOLERANCE) sustainedEndIdx = j;
    }
    const sustainedDuration = smoothed[sustainedEndIdx].t - peakTime;
    if (sustainedDuration < SUSTAINED_THRESHOLD_S) {
      i = peakIdx + 1;
      continue;
    }

    let dropIdx = -1;
    for (let j = sustainedEndIdx + 1; j < smoothed.length; j += 1) {
      if (smoothed[j].t - peakTime > SEARCH_DROP_S) break;
      if (smoothed[j].hr <= peakHr - DROP_BPM) {
        dropIdx = j;
        break;
      }
    }
    if (dropIdx === -1) {
      i = peakIdx + 1;
      continue;
    }

    const eventEndS = smoothed[dropIdx].t;
    const eventDuration = eventEndS - t0;
    if (eventDuration < MIN_DURATION_S || eventDuration > MAX_DURATION_S) {
      i += 1;
      continue;
    }
    if (peakHr >= sessionMaxHR * 0.985) {
      i = dropIdx + 1;
      continue;
    }

    const noteScore = scoreEventNoteCorroboration(t0, eventEndS, sessionEvents);
    const candidateRows = rowsBetween(preClimaxRows, t0, eventEndS);
    const hrvSummary = summarizeCandidateHrv(candidateRows, sessionMedianRmssd);
    const absolutePeakStrong = peakHr >= peakFloor;
    const latePlateauWindow = peakTime >= compressedPlateauStartS;
    const clusteredReload = lastEventEnd > 0 && (t0 - lastEventEnd) <= 75;

    if (peakTime <= earlyNoiseGuardEndS && !absolutePeakStrong && noteScore < 2 && !hrvSummary.compressed) {
      i = dropIdx + 1;
      continue;
    }

    let hrConfidence = Math.floor((rise / MIN_RISE_BPM - 1) * 2) + Math.floor(sustainedDuration / 20);
    if (absolutePeakStrong) hrConfidence += 2;
    if (latePlateauWindow) hrConfidence += 1;
    if (clusteredReload) hrConfidence += 1;
    if (peakHr < peakFloor - 2 && noteScore === 0 && !hrvSummary.compressed) hrConfidence -= 2;

    const totalConfidence = hrConfidence + noteScore + hrvSummary.score;
    if (totalConfidence < MIN_CONFIDENCE) {
      i += 1;
      continue;
    }

    events.push({
      start_offset_s: t0,
      peak_offset_s: peakTime,
      end_offset_s: eventEndS,
      base_hr: Math.round(hr0),
      peak_hr: Math.round(peakHr),
      rise_bpm: Math.round(rise),
      sustained_s: Math.round(sustainedDuration),
      duration_s: Math.round(eventDuration),
      confidence: Math.min(10, Math.max(1, totalConfidence)),
      note_corroborated: noteScore > 0,
    });

    lastEventEnd = eventEndS;
    i = dropIdx + 1;
  }

  return events;
}
