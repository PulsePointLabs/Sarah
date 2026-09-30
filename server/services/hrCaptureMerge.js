import { computeHrvFromRr } from './hrSources.js';

// A live packet can overtake the phone's durable FIFO. Rebuild the review HRV
// window in measurement order once delayed RR samples have joined the recording.
export function repairBufferedHrvRows(rows) {
  if (!rows.some(row => String(row.note || '').includes('native_buffered_delivery=true'))) return rows;
  let rr = [], previousAt = null;
  return rows.map(row => {
    if (row.hr_source !== 'direct_h10') return row;
    const at = Number(row.hr_measured_at) || Date.parse(row.timestamp);
    if (previousAt != null && at - previousAt > 5000) rr = [];
    previousAt = at;
    rr = [...rr, ...String(row.rr_intervals_ms || '').split('|').map(Number).filter(value => value >= 300 && value <= 2000)].slice(-180);
    if (rr.length < 180) return row;
    const hrv = computeHrvFromRr(rr);
    return { ...row, hrv_rmssd_ms: hrv.rmssdMs, hrv_sdnn_ms: hrv.sdnnMs, hrv_pnn50: hrv.pnn50,
      hrv_window_seconds: hrv.windowSeconds, hrv_quality: hrv.quality,
      note: `${row.note || ''}; hrv_reprocessed_from_ordered_rr=true` };
  });
}

const RICH_EVIDENCE_FIELDS = [
  'rr_intervals_ms',
  'hrv_rmssd_ms',
  'hrv_sdnn_ms',
  'respiration_bpm',
  'motion_dynamic_rms_mg',
  'motion_peak_dynamic_mg',
  'signal_confidence_score',
];

function hasValue(value) {
  return value !== null && value !== undefined && value !== '';
}

function evidenceScore(row = {}) {
  return RICH_EVIDENCE_FIELDS.reduce(
    (score, field) => score + (hasValue(row[field]) ? 1 : 0),
    0,
  );
}

function mergeRowValues(preferred, fallback) {
  const merged = { ...preferred };
  for (const [key, value] of Object.entries(fallback || {})) {
    if (!hasValue(merged[key]) && hasValue(value)) merged[key] = value;
  }
  return merged;
}

export function coalesceDuplicateHrRows(rows = [], thresholdSeconds = 0.05) {
  const sorted = [...rows].sort(
    (left, right) => Number(left?.time_offset_s || 0) - Number(right?.time_offset_s || 0),
  );
  const coalesced = [];

  for (const row of sorted) {
    const previous = coalesced.at(-1);
    const sameHeartRate = hasValue(row?.hr)
      && hasValue(previous?.hr)
      && Number(row.hr) === Number(previous.hr);
    const differentSources = String(row?.hr_source || '') !== String(previous?.hr_source || '');
    const nearby = previous
      && Math.abs(Number(row?.time_offset_s || 0) - Number(previous?.time_offset_s || 0)) <= thresholdSeconds;

    if (!previous || !sameHeartRate || !differentSources || !nearby) {
      coalesced.push(row);
      continue;
    }

    const rowIsRicher = evidenceScore(row) > evidenceScore(previous);
    coalesced[coalesced.length - 1] = rowIsRicher
      ? mergeRowValues(row, previous)
      : mergeRowValues(previous, row);
  }

  return coalesced;
}
