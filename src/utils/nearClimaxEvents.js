function numberOrNull(value) {
  if (value == null || value === "") return null;
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

const DIRECT_NEAR_CLIMAX_CUE_PATTERN = /\b(?:near[-\s]?climax|pre[-\s]?climax|climax\s+(?:approach|possible|imminent)|approach(?:ing)?\s+(?:climax|threshold)|at\s+threshold|almost\s+(?:there|climax)|orgasm(?:ic)?\s+(?:build|approach)|ejaculat(?:ion|ory)\s+(?:build|approach))\b/i;
const ACTIVE_MASTURBATION_PATTERN = /\b(?:active\s+(?:manual\s+)?stimulation|stimulation\s+(?:resumes?|continues?|begins?|starts?|intensifies)|masturbat(?:e|es|ed|ing|ion)|strok(?:e|es|ed|ing)|(?:hand|stroke)\s+(?:speed|cadence)\s+(?:increase|increases|increased|quickens?|accelerat)|(?:rapid|quick|fast|full|upward|downward|focused)\s+(?:manual\s+)?strok(?:e|es|ing)|grip\s+(?:tightens?|shifts?|changes?)\s+(?:on|along|toward)\s+(?:the\s+)?(?:penis|shaft|glans))\b/i;
const NON_AROUSAL_EXERTION_PATTERN = /\b(?:walk(?:s|ed|ing)?|ambulatory|stand(?:s|ing|ing\s+up)?|stood|mount(?:s|ed|ing)?\s+(?:the\s+)?(?:exam\s+)?table|re-?mount(?:s|ed|ing)?\s+(?:the\s+)?(?:exam\s+)?table|got\s+off\s+(?:the\s+)?(?:exam\s+)?table|get(?:ting)?\s+off\s+(?:the\s+)?(?:exam\s+)?table|off\s+(?:the\s+)?(?:exam\s+)?table|away\s+from\s+(?:the\s+)?table|left\s+(?:the\s+)?(?:room|table)|table\s+(?:is\s+)?vacant|empty\s+(?:exam\s+)?table|room\s+(?:is\s+)?empty|find(?:s|ing)?\s+(?:a\s+)?position(?:\s+of\s+comfort)?|position(?:ing)?\s+(?:on|at)\s+(?:the\s+)?table|select(?:s|ed|ing)?\s+(?:the\s+)?media|set(?:s|ting)?\s+up\s+(?:the\s+)?media|fighting\s+(?:the\s+)?(?:app|computer)|computer\s+(?:problem|issue|trouble)|technical\s+(?:problem|issue|trouble)|troubleshoot(?:s|ed|ing)?|restart(?:s|ed|ing)?\s+(?:the\s+)?(?:app|computer|obs)|adjust(?:s|ed|ing)?\s+(?:the\s+)?(?:camera|monitor|monitors|computer|app|obs|equipment)|camera\s+adjustment|stimulation\s+(?:is\s+)?paused|paus(?:e|es|ed|ing)\s+(?:stimulation|to\s+adjust)|no\s+(?:active\s+)?(?:stimulation|genital\s+contact)|room\s+(?:prep|setup)|prepar(?:e|es|ed|ing|ation)\s+(?:the\s+)?(?:room|camera|computer|equipment))\b/i;

function evidenceText(event = {}) {
  return [
    event.note,
    event.text,
    event.summary,
    event.label,
    event.reason,
    event.description,
    Array.isArray(event.findings) ? event.findings.join(" ") : event.findings,
  ].filter(Boolean).join(" ").replace(/\s+/g, " ").trim();
}

function evidenceBounds(event = {}) {
  const time = numberOrNull(event.time_s ?? event.session_time_s ?? event.offset_s);
  const start = numberOrNull(event.start_offset_s ?? event.start_s ?? event.timeline_start_s ?? event.time_s ?? event.session_time_s);
  const end = numberOrNull(event.end_offset_s ?? event.end_s ?? event.timeline_end_s ?? event.time_s ?? event.session_time_s);
  return {
    start: start ?? time,
    end: end ?? start ?? time,
  };
}

function evidenceOverlaps(event, startS, endS, padS = 45) {
  const bounds = evidenceBounds(event);
  if (bounds.start == null || bounds.end == null) return false;
  return bounds.end >= startS - padS && bounds.start <= endS + padS;
}

function evidenceDistanceToTime(event, timeS) {
  const bounds = evidenceBounds(event);
  if (bounds.start == null || bounds.end == null || !Number.isFinite(timeS)) return Number.POSITIVE_INFINITY;
  if (bounds.start <= timeS && bounds.end >= timeS) return 0;
  return Math.min(Math.abs(timeS - bounds.start), Math.abs(timeS - bounds.end));
}

function eventCategories(event = {}) {
  return (Array.isArray(event.category) ? event.category : [event.category])
    .filter(Boolean)
    .map((value) => String(value).toLowerCase());
}

function pushContextEvidence(target, value) {
  const text = evidenceText(value);
  const bounds = evidenceBounds(value);
  if (!text || bounds.start == null) return;
  target.push({
    ...value,
    note: text,
    start_s: bounds.start,
    end_s: bounds.end,
  });
}

export function buildNearClimaxContextEvidence(session = {}) {
  const evidence = [];
  (Array.isArray(session.event_timeline) ? session.event_timeline : []).forEach((event) => {
    pushContextEvidence(evidence, { ...event, evidence_source: event.evidence_source || event.source || "session_event" });
  });

  const sessionSummaryText = [session.notes, session.subjective_notes]
    .filter(Boolean)
    .join(" ")
    .replace(/\s+/g, " ")
    .trim();
  const sessionEndS = numberOrNull(session.capture_active_duration_seconds)
    ?? (numberOrNull(session.duration_minutes) != null ? Number(session.duration_minutes) * 60 : null)
    ?? numberOrNull(session.climax_offset_s)
    ?? 0;
  if (sessionSummaryText && DIRECT_NEAR_CLIMAX_CUE_PATTERN.test(sessionSummaryText) && sessionEndS > 0) {
    pushContextEvidence(evidence, {
      start_s: 0,
      end_s: sessionEndS,
      note: sessionSummaryText,
      category: ["subjective", "session_summary", "near_climax_report"],
      evidence_source: "user_session_summary",
    });
  }

  const analysis = session.ai_analysis || {};
  const videoPasses = Array.isArray(analysis._video_pass_findings) ? analysis._video_pass_findings : [];
  videoPasses.forEach((pass) => {
    const clip = pass?.clip || {};
    const start = numberOrNull(clip.start_s ?? pass?.window?.start);
    const end = numberOrNull(clip.end_s ?? pass?.window?.end) ?? start;
    const findings = Array.isArray(pass?.findings)
      ? pass.findings.map((finding) => typeof finding === "string" ? finding : finding?.findingText || finding?.text || finding?.finding).filter(Boolean)
      : [];
    if (start != null) {
      pushContextEvidence(evidence, {
        start_s: start,
        end_s: end,
        note: [pass?.summary, ...findings].filter(Boolean).join(" "),
        category: ["visual"],
        evidence_source: "video_pass",
      });
    }
    const draftEvents = Array.isArray(pass?.draft_events || pass?.events) ? (pass.draft_events || pass.events) : [];
    draftEvents.forEach((event) => pushContextEvidence(evidence, {
      ...event,
      evidence_source: "video_pass_event",
      category: [...eventCategories(event), "visual"],
    }));
  });

  const visualEntries = Array.isArray(analysis._visual_findings) ? analysis._visual_findings : [];
  visualEntries.forEach((entry) => {
    const findings = Array.isArray(entry?.findings)
      ? entry.findings.map((finding) => typeof finding === "string" ? finding : finding?.findingText || finding?.text || finding?.finding).filter(Boolean)
      : [];
    const videos = Array.isArray(entry?.media_context?.videos) ? entry.media_context.videos : [];
    videos.forEach((video) => {
      const start = numberOrNull(video.timelineStartSeconds ?? video.startSeconds);
      const end = numberOrNull(video.timelineEndSeconds ?? video.endSeconds) ?? start;
      if (start == null) return;
      pushContextEvidence(evidence, {
        start_s: start,
        end_s: end,
        note: findings.join(" "),
        category: ["visual"],
        evidence_source: "saved_visual_review",
      });
    });
  });

  const cloudPasses = Array.isArray(analysis.cloud_multimodal_passes) ? analysis.cloud_multimodal_passes : [];
  cloudPasses.forEach((pass) => {
    const result = pass?.result || {};
    const candidates = Array.isArray(result.strong_candidates) ? result.strong_candidates : [];
    const offsetS = Number(pass?.source_video?.source_zero_session_ms || 0) / 1000;
    candidates.forEach((candidate) => {
      const start = numberOrNull(candidate?.start_ms);
      if (start == null) return;
      const end = numberOrNull(candidate?.end_ms) ?? start;
      const visual = candidate?.visual_evidence || {};
      const details = [
        candidate?.label,
        candidate?.basis,
        candidate?.summary,
        candidate?.review_summary,
        ...(Array.isArray(visual.actions) ? visual.actions : []),
        ...(Array.isArray(visual.change_across_frames) ? visual.change_across_frames : []),
      ].filter(Boolean);
      pushContextEvidence(evidence, {
        start_s: start / 1000 + offsetS,
        end_s: end / 1000 + offsetS,
        note: details.join(" "),
        category: [String(candidate?.provenance?.modality || "visual").toLowerCase()],
        evidence_source: "cloud_multimodal",
      });
    });
  });

  const phaseMarkers = [
    ["pre_climax", session.pre_climax_offset_s ?? session.pre_climax_time_s],
    ["climax", session.climax_offset_s ?? session.climax_time_s],
    ["recovery", session.recovery_offset_s ?? session.recovery_time_s],
  ];
  phaseMarkers.forEach(([phase, rawTime]) => {
    const timeS = numberOrNull(rawTime);
    if (timeS == null) return;
    pushContextEvidence(evidence, {
      time_s: timeS,
      note: `Manually saved ${phase.replace("_", "-")} phase marker`,
      category: ["phase_marker", phase],
      evidence_source: "manual_phase_marker",
    });
  });

  return evidence;
}

export function assessNearClimaxEventContext(event = {}, contextEvidence = []) {
  const startS = numberOrNull(event.start_offset_s ?? event.start_s ?? event.time_s) ?? 0;
  const endS = numberOrNull(event.end_offset_s ?? event.end_s ?? event.time_s) ?? startS;
  const peakS = numberOrNull(event.peak_offset_s ?? event.peak_s) ?? ((startS + endS) / 2);
  const aligned = (Array.isArray(contextEvidence) ? contextEvidence : [])
    .filter((item) => evidenceOverlaps(item, startS, endS));
  const phaseEvidence = (Array.isArray(contextEvidence) ? contextEvidence : [])
    .filter((item) => eventCategories(item).includes("phase_marker"));
  const markerTime = (phase) => phaseEvidence
    .filter((item) => eventCategories(item).includes(phase))
    .map((item) => evidenceBounds(item).start)
    .filter(Number.isFinite)
    .sort((a, b) => a - b)[0] ?? null;
  const preClimaxS = markerTime("pre_climax");
  const climaxS = markerTime("climax");
  const beforePreClimax = preClimaxS != null && peakS < preClimaxS - 15;
  const afterClimax = climaxS != null && peakS > climaxS + 5;
  let positiveScore = 0;
  let negativeScore = 0;
  const positiveSources = new Set();
  const negativeSources = new Set();
  let activeMasturbation = false;
  let directThresholdCue = false;
  let nonArousalAtPeak = false;
  let sessionMultipleNearClimaxReport = false;
  let telemetryCandidateAtPeak = false;

  aligned.forEach((item) => {
    const text = evidenceText(item);
    const categories = eventCategories(item);
    const source = String(item.evidence_source || "context");
    const direct = DIRECT_NEAR_CLIMAX_CUE_PATTERN.test(text);
    const active = ACTIVE_MASTURBATION_PATTERN.test(text);
    const distanceToPeak = evidenceDistanceToTime(item, peakS);
    if (source === "user_session_summary" && /\b(?:multiple|several|repeated|many)\s+near[-\s]?climax\b/i.test(text)) {
      sessionMultipleNearClimaxReport = true;
    }
    if (source === "sarah_live_cue" && categories.includes("live_cue_edging_candidate") && distanceToPeak <= 25) {
      telemetryCandidateAtPeak = true;
    }
    const circularTelemetryCue = source === "live_climax_prediction"
      || source === "sarah_live_cue"
      || categories.includes("phase_detection")
      || categories.includes("live_cue_edging_candidate")
      || (categories.includes("physiology") && /\bnear[-\s]?climax\s+watch\b/i.test(text));
    const nonArousalExertion = NON_AROUSAL_EXERTION_PATTERN.test(text)
      || categories.some((category) => ["setup", "technical", "equipment", "room_setup"].includes(category));

    if (!circularTelemetryCue && source !== "manual_phase_marker" && distanceToPeak <= 18) {
      if (direct) {
        directThresholdCue = true;
        positiveScore += 5;
      }
      if (active) {
        activeMasturbation = true;
        positiveScore += 3;
      }
      if (direct || active) positiveSources.add(source);
    }

    if (nonArousalExertion && distanceToPeak <= 25) {
      nonArousalAtPeak = true;
      negativeScore += 6;
      negativeSources.add(source);
    }
  });

  const manualThresholdCue = preClimaxS != null
    && peakS >= preClimaxS - 15
    && (climaxS == null || peakS < climaxS);
  if (manualThresholdCue) positiveScore += 5;
  // A saved pre-climax marker identifies the final approach window. It does not
  // rule out earlier approach/recovery cycles in a multi-event session.
  const contradicted = afterClimax || nonArousalAtPeak;
  const confirmed = !contradicted && (
    (activeMasturbation && (manualThresholdCue || directThresholdCue))
    || (sessionMultipleNearClimaxReport && telemetryCandidateAtPeak)
  );
  const status = afterClimax
      ? "after_climax"
      : nonArousalAtPeak
        ? "contradicted"
    : confirmed
      ? "context_confirmed"
      : aligned.length
        ? "context_unconfirmed"
        : "physiology_only";

  return {
    status,
    confirmed,
    contradicted,
    alignedEvidenceCount: aligned.length,
    positiveScore,
    negativeScore,
    peakS,
    preClimaxS,
    climaxS,
    beforePreClimax,
    activeMasturbation,
    directThresholdCue,
    manualThresholdCue,
    sessionMultipleNearClimaxReport,
    telemetryCandidateAtPeak,
    nonArousalAtPeak,
    positiveSources: [...positiveSources],
    negativeSources: [...negativeSources],
  };
}

export function filterContradictedNearClimaxEvents(events = [], contextEvidence = []) {
  return (Array.isArray(events) ? events : [])
    .map((event) => ({ ...event, context_evidence: assessNearClimaxEventContext(event, contextEvidence) }))
    .filter((event) => !event.context_evidence.contradicted);
}

export function getContextConfirmedNearClimaxEvents(events = [], contextEvidence = []) {
  return filterContradictedNearClimaxEvents(events, contextEvidence)
    .filter((event) => event.context_evidence.confirmed);
}

export function confirmedNearClimaxEventsForSession(session = {}) {
  return getContextConfirmedNearClimaxEvents(
    session.ai_near_climax_events || [],
    buildNearClimaxContextEvidence(session),
  );
}

export function scoreEventNoteCorroboration(eventStartS, eventEndS, sessionEvents) {
  if (!sessionEvents || sessionEvents.length === 0) return 0;
  const windowS = 45;
  let score = 0;
  for (const ev of sessionEvents) {
    const cats = eventCategories(ev);
    const source = String(ev.evidence_source || ev.source || "");
    if (
      source === "live_climax_prediction"
      || source === "user_session_summary"
      || source === "sarah_live_cue"
      || cats.includes("phase_detection")
      || cats.includes("live_cue_edging_candidate")
    ) continue;
    const bounds = evidenceBounds(ev);
    if (bounds.start == null || bounds.end == null || bounds.end < eventStartS - windowS || bounds.start > eventEndS + windowS) continue;
    const t = Math.min(Math.max((bounds.start + bounds.end) / 2, eventStartS), eventEndS);
    const dist = Math.max(0, Math.min(Math.abs(t - eventStartS), Math.abs(t - eventEndS)));
    const proximityWeight = dist < 15 ? 2 : 1;
    const note = String(ev.note || "").toLowerCase();
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
    const contextAssessment = assessNearClimaxEventContext({ start_offset_s: t0, end_offset_s: eventEndS }, sessionEvents);
    if (contextAssessment.contradicted) {
      i = dropIdx + 1;
      continue;
    }
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
      evidence_status: contextAssessment.status,
      context_confirmed: contextAssessment.confirmed,
      context_evidence: contextAssessment,
    });

    lastEventEnd = eventEndS;
    i = dropIdx + 1;
  }

  return events;
}
