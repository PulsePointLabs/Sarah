import { createCivetProcessor } from './civet.js';
import { CIVET_ACQUISITION_POLICY } from './civetReadiness.js';
import { CIVET_VERSION, linkIntervals, summarizeTrains } from './civetAnalysis.js';

export const CIVET_REPROCESS_VERSION = `civet-reprocess-2-${CIVET_ACQUISITION_POLICY}-${CIVET_VERSION}`;

// Replay only after an original sample attests that rest/hold/release passed.
// Never infer a calibration from high pressure, or carry one across a hardware reset.
export function reprocessCivetRecording(source) {
  let processor = null, calibrationId = null, previous = null, segment = 0;
  let recoveredSamples = 0;
  const rows = source.map(original => {
    const c = original.calibration;
    const id = c?.id ?? c?.at;
    const changed = previous && (id !== calibrationId ||
      original.connection_id !== previous.connection_id || original.capture_id !== previous.capture_id);
    const oldDrift = original.acquisition_policy === 'pressure-acquisition-3' &&
      ['checking', 'recalibrate'].includes(original.acquisition_state) &&
      ['Pressure baseline changed — checking recovery', 'Pressure remains shifted. Relax; recalibrate if it does not recover.'].includes(original.acquisition_message);
    const invalid = original.calibration_error ||
      ['calibrating', 'settling', 'uncalibrated'].includes(original.acquisition_state) ||
      (original.acquisition_state === 'recalibrate' && !oldDrift);
    if (changed || invalid) processor = null;
    const verified = original.usable === true && original.calibration_valid === true &&
      original.acquisition_state === 'ready' && c?.reference > 0 && Number.isFinite(c?.noise);
    if (!processor && verified && !invalid) {
      processor = createCivetProcessor({ verifiedCalibration: c });
      segment++;
    }
    calibrationId = id;
    previous = original;
    if (!processor) return { ...original, mode: 'reprocessed', reprocessed: false };
    const result = processor.ingest(original.pressure_kpa, original.t, { timestamp_ms: original.timestamp_ms });
    const events = result.events.map(e => ({ ...e, id: `reprocessed-${segment}-${e.id}`, segment: `reprocessed-${segment}-${e.segment}`, mode: 'reprocessed', peak_timestamp_ms: original.timestamp_ms + (e.peak - original.t) * 1000 }));
    if (!original.usable && result.usable) recoveredSamples++;
    return { ...original, ...result, events, mode: 'reprocessed', reprocessed: true,
      recorded_acquisition_state: original.acquisition_state, recorded_usable: original.usable };
  });
  const events = linkIntervals(rows.flatMap(r => r.events || []));
  return { mode: 'reprocessed', algorithm: CIVET_VERSION, policy: CIVET_ACQUISITION_POLICY,
    version: CIVET_REPROCESS_VERSION, recovered_samples: recoveredSamples,
    rows, events, trains: summarizeTrains(events, rows) };
}
