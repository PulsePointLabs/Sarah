import { computeLiveClimaxPrediction } from '../../src/utils/liveClimaxPrediction.js';
import { withCivetEvidence } from '../../src/lib/civet.js';

const number = (...values) => {
  for (const value of values) if (value != null && value !== '' && Number.isFinite(Number(value))) return Number(value);
  return null;
};
const stamp = value => Number(value) || Date.parse(value || '');

// Passive physiology observer. It never sends commands to a connected device.
export class LiveMonitoring {
  constructor({ predict = computeLiveClimaxPrediction, onCandidate = () => {} } = {}) {
    this.predict = predict;
    this.onCandidate = onCandidate;
    this.reset(null);
  }
  reset(sessionId, count = 0) {
    this.sessionId = sessionId; this.count = count; this.history = [];
    this.prediction = null; this.basePrediction = null; this.latestAt = null;
    this.candidateSince = null; this.belowSince = null; this.inEpisode = false;
  }
  update({ hr, emg, civet, sessionId, startedAt, active, paused, candidateCount = 0 }, now = Date.now()) {
    if (sessionId !== this.sessionId) this.reset(sessionId, candidateCount);
    const at = stamp(hr?.measuredAt || hr?.receivedAt);
    if (!active || paused || !Number.isFinite(at) || now - at > 5000 || at > now + 5000 || hr?.quality?.stale) {
      this.candidateSince = null; this.belowSince = null;
      return this.snapshot(now, { paused, active });
    }
    if (this.latestAt != null && at <= this.latestAt) return this.snapshot(now, { paused, active });
    if (this.latestAt != null && at - this.latestAt > 5000) {
      this.candidateSince = null; this.belowSince = null; this.inEpisode = false;
    }
    const emgAt = stamp(emg?.source_at || emg?.receivedAt || emg?.engineReceivedAt);
    const liveEmg = Number.isFinite(emgAt) && Math.abs(at - emgAt) < 5000 ? emg : null;
    const hrv = hr.hrv || {}, multi = hr.multimodal || {};
    const start = stamp(startedAt);
    const point = {
      ts: at, time: new Date(at).toLocaleTimeString([], { minute: '2-digit', second: '2-digit' }),
      sessionTimeSec: Number.isFinite(start) ? Math.max(0, (at - start) / 1000) : 0,
      hr: number(hr.currentHr, hr.hr, hr.heartRate), hrSmoothed: number(hr.hrSmoothed, hr.smoothedHr),
      baseline: number(hr.baselineHr), build: number(hr.buildConfidence), phase: hr.phase || null,
      hrSource: hr.source, hrvRmssd: number(hrv.rmssdMs), hrvSdnn: number(hrv.sdnnMs),
      hrvPnn50: number(hrv.pnn50), hrvQuality: hrv.quality, rrCount: number(hr.quality?.rrCount, hrv.sampleCount),
      motionClass: multi.motion?.class, motionRms: number(multi.motion?.dynamicRmsMilliG),
      respirationBpm: number(multi.respiration?.bpm), respirationConfidence: multi.respiration?.confidence,
      possibleBreathHold: Boolean(multi.respiration?.possibleBreathHold),
      breathHoldDurationSeconds: number(multi.respiration?.holdDurationSeconds),
      signalConfidence: number(multi.signalConfidence?.score), autonomicState: multi.state?.key,
      recoveryDropBpm: number(multi.recovery?.currentDropBpm),
      left: number(liveEmg?.left_pct, liveEmg?.level_pct), right: number(liveEmg?.right_pct), diff: number(liveEmg?.diff_pct),
    };
    // One point per second, stamped at sensor receipt, never WebView wake-up time.
    if (this.history.at(-1) && at - this.history.at(-1).ts < 900) return this.snapshot(now, { active, paused });
    const history = [...this.history, point].filter(row => at - row.ts <= 3600000).slice(-3600);
    const base = this.predict(hr, liveEmg, history, { sessionTimeSec: point.sessionTimeSec });
    const prediction = withCivetEvidence(base, civet, Math.max(point.left || 0, point.right || 0));
    Object.assign(point, { nearClimax: prediction.nearClimax, recovery: prediction.recovery,
      hrvSignal: prediction.hrvSignal, plateau: prediction.plateauScore,
      controllerConfidence: prediction.controllerConfidence, physiologicalIntensity: prediction.physiologicalIntensity });
    const high = prediction.nearClimax >= 68 && prediction.buildEligibleForNearClimax
      && prediction.confirmationCount >= 2 && prediction.controllerConfidence >= 50 && prediction.multimodalTrusted;
    if (high) {
      this.belowSince = null;
      if (!this.inEpisode) {
        this.candidateSince ??= at;
        if (at - this.candidateSince >= 5000) {
          const event = {
            id: `approach_candidate_server_${sessionId}_${at}`, time_s: point.sessionTimeSec,
            label: `High-probability physiology candidate ${this.count + 1}`,
            note: `Physiology-only approach candidate: watch ${prediction.nearClimax}%, ${prediction.confirmationCount} signal families. Requires contextual review.`,
            category: ['physiology', 'phase_detection', 'review_candidate'],
            annotation_tags: ['approach_candidate', 'high_probability', 'trend_detected', 'needs_context_confirmation'],
            source: 'live_climax_prediction', created_at: new Date(at).toISOString(),
            prediction: { near_climax: prediction.nearClimax, controller_confidence: prediction.controllerConfidence,
              confirmation_count: prediction.confirmationCount, reason: prediction.reason, evidence_status: 'physiology_only' },
          };
          // Advance only after the event has been durably accepted; retry on storage failure.
          this.onCandidate(event);
          this.count++; this.inEpisode = true; this.candidateSince = null;
        }
      }
    } else {
      this.candidateSince = null;
      if (this.inEpisode && prediction.nearClimax < 52) {
        this.belowSince ??= at;
        if (at - this.belowSince >= 8000) { this.inEpisode = false; this.belowSince = null; }
      } else this.belowSince = null;
    }
    this.history = history; this.prediction = prediction; this.basePrediction = base; this.latestAt = at;
    return this.snapshot(now, { active, paused });
  }
  snapshot(now = Date.now(), { active = true, paused = false } = {}) {
    return { version: 1, sessionId: this.sessionId, active, paused,
      stale: this.latestAt == null || now - this.latestAt > 5000 || !active || paused,
      latestAt: this.latestAt, point: this.history.at(-1) || null,
      prediction: this.prediction, basePrediction: this.basePrediction, candidateCount: this.count, historySize: this.history.length };
  }
}
