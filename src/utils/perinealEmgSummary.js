const TYPE_ORDER = ["light", "moderate", "strong", "sustained", "possible_artifact"];

function cleanNumber(value, fallback = null) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function confidenceScore(value) {
  if (typeof value === "number") return Math.max(0, Math.min(1, value > 1 ? value / 100 : value));
  const text = String(value || "").toLowerCase();
  if (text === "high") return 1;
  if (text === "medium" || text === "moderate") return 0.62;
  if (text === "low") return 0.28;
  return null;
}

function confidenceLabel(score) {
  if (score == null) return "Unknown";
  if (score >= 0.82) return "High";
  if (score >= 0.48) return "Mixed";
  return "Low";
}

function plural(count, singular, pluralLabel = `${singular}s`) {
  return `${count} ${count === 1 ? singular : pluralLabel}`;
}

function displayType(type) {
  if (type === "possible_artifact") return "Possible Artifact";
  if (type === "sustained") return "Sustained Hold";
  if (type === "strong") return "Strong Contraction";
  if (type === "moderate") return "Moderate Contraction";
  if (type === "light") return "Light Contraction";
  return "Detected Activation";
}

function qualityDisplayLabel(qualityLabel) {
  if (qualityLabel === "High confidence") return "High Confidence";
  if (qualityLabel === "Mixed / review") return "Mixed / Review";
  if (qualityLabel === "Artifact-heavy") return "Artifact Heavy";
  if (qualityLabel === "No detected contractions") return "No Detected Contractions";
  return qualityLabel;
}

function buildStorySentence({ events, contractionEvents, artifactEvents, byType, qualityLabel, hasSetup }) {
  if (qualityLabel === "Artifact-heavy") {
    return `Artifact-heavy session. Interpret detected activations cautiously.`;
  }
  if (!events.length) {
    return hasSetup
      ? "Perineal Body EMG was configured, but no contraction events were detected."
      : "No perineal EMG events are saved in this session.";
  }

  const parts = [];
  if (byType.strong) parts.push(plural(byType.strong, "strong contraction"));
  if (byType.sustained) parts.push(plural(byType.sustained, "sustained hold"));
  if (byType.moderate && !byType.strong && !byType.sustained) parts.push(plural(byType.moderate, "moderate activation"));
  if (byType.light && !byType.strong && !byType.sustained && byType.moderate <= byType.light) parts.push(plural(byType.light, "light activation"));

  if (parts.length) {
    return `${plural(contractionEvents.length, "contraction event")} detected, including ${parts.join(" and ")}.`;
  }

  if (contractionEvents.length) {
    return "Primarily light-to-moderate perineal EMG activation detected, with no sustained holds.";
  }

  if (artifactEvents.length) {
    return "Only possible artifact markers were detected. Interpret the EMG trace cautiously.";
  }

  return "Perineal EMG activity was reviewed, with no clear contraction pattern detected.";
}

export function isPerinealEmgEvent(event = {}) {
  return event?.source === "perineal_emg" || Boolean(event?.perineal_emg);
}

export function normalizePerinealEmgEvent(event = {}) {
  const meta = event?.perineal_emg || {};
  const contractionType = String(meta.contraction_type || event.contraction_type || "moderate").toLowerCase();
  const type = TYPE_ORDER.includes(contractionType) ? contractionType : "moderate";
  const eventType = meta.event_type || event.event_type || (type === "possible_artifact" ? "possible_artifact" : "kegel_contraction");
  const peakTime = cleanNumber(meta.peak_time_s, cleanNumber(event.time_s, null));
  const startTime = cleanNumber(meta.start_time_s, peakTime);
  const endTime = cleanNumber(meta.end_time_s, startTime);
  const duration = cleanNumber(meta.duration_s, endTime != null && startTime != null ? Math.max(0, endTime - startTime) : null);
  const score = confidenceScore(meta.confidence ?? event.confidence);
  return {
    id: event.id || `${event.source || "perineal_emg"}-${startTime ?? event.time_s ?? "unknown"}-${type}`,
    note: event.note || "",
    source: event.source || "perineal_emg",
    event_type: eventType,
    contraction_type: eventType === "possible_artifact" ? "possible_artifact" : type,
    time_s: cleanNumber(event.time_s, peakTime),
    start_time_s: startTime,
    peak_time_s: peakTime,
    end_time_s: endTime,
    duration_s: duration,
    peak_pct: cleanNumber(meta.peak_pct, null),
    average_pct: cleanNumber(meta.average_pct, null),
    integrated_activation: cleanNumber(meta.integrated_activation, null),
    confidence: meta.confidence ?? event.confidence ?? null,
    confidence_score: score,
    confidence_label: confidenceLabel(score),
    calibration_id: meta.calibration_id || null,
  };
}

export function summarizePerinealEmg(input = {}) {
  const session = Array.isArray(input) ? { event_timeline: input } : (input || {});
  const rawEvents = Array.isArray(session.event_timeline) ? session.event_timeline : [];
  const events = rawEvents
    .filter(isPerinealEmgEvent)
    .map(normalizePerinealEmgEvent)
    .sort((a, b) => cleanNumber(a.peak_time_s, a.time_s ?? 0) - cleanNumber(b.peak_time_s, b.time_s ?? 0));
  const byType = Object.fromEntries(TYPE_ORDER.map((type) => [type, 0]));
  for (const event of events) byType[event.contraction_type] = (byType[event.contraction_type] || 0) + 1;
  const artifactEvents = events.filter((event) => event.contraction_type === "possible_artifact" || event.event_type === "possible_artifact");
  const contractionEvents = events.filter((event) => event.contraction_type !== "possible_artifact" && event.event_type !== "possible_artifact");
  const strongestEvent = contractionEvents
    .filter((event) => event.peak_pct != null)
    .sort((a, b) => b.peak_pct - a.peak_pct)[0] || null;
  const sustainedEvents = contractionEvents.filter((event) => event.contraction_type === "sustained");
  const longestHoldEvent = sustainedEvents.length
    ? [...sustainedEvents].sort((a, b) => cleanNumber(b.duration_s, 0) - cleanNumber(a.duration_s, 0))[0]
    : [...contractionEvents].sort((a, b) => cleanNumber(b.duration_s, 0) - cleanNumber(a.duration_s, 0))[0] || null;
  const durations = contractionEvents.map((event) => cleanNumber(event.duration_s, null)).filter((value) => value != null);
  const confidenceScores = events.map((event) => event.confidence_score).filter((value) => value != null);
  const average = (values) => values.length ? values.reduce((sum, value) => sum + value, 0) / values.length : null;
  const totalActiveSeconds = durations.reduce((sum, value) => sum + value, 0);
  const averageConfidence = average(confidenceScores);
  const artifactRatio = events.length ? artifactEvents.length / events.length : 0;
  const hasSetup = Boolean(
    session.emg_perineal_calibration
    || /perineal|pelvic\s*floor/i.test(String(session.emg_target_area || ""))
    || /perineal|pelvic\s*floor/i.test(String(session.emg_sensor_type || ""))
  );
  let qualityLabel = "No perineal EMG events";
  if (events.length && artifactRatio >= 0.45) qualityLabel = "Artifact-heavy";
  else if (events.length && (artifactRatio >= 0.2 || (averageConfidence != null && averageConfidence < 0.75))) qualityLabel = "Mixed / review";
  else if (events.length) qualityLabel = "High confidence";
  else if (hasSetup) qualityLabel = "No detected contractions";
  const notableEvents = [...contractionEvents]
    .sort((a, b) => {
      const typeWeight = { sustained: 4, strong: 3, moderate: 2, light: 1 };
      const bScore = (typeWeight[b.contraction_type] || 0) * 100 + cleanNumber(b.peak_pct, 0) + cleanNumber(b.duration_s, 0);
      const aScore = (typeWeight[a.contraction_type] || 0) * 100 + cleanNumber(a.peak_pct, 0) + cleanNumber(a.duration_s, 0);
      return bScore - aScore;
    })
    .slice(0, 8);
  const storySentence = buildStorySentence({
    events,
    contractionEvents,
    artifactEvents,
    byType,
    qualityLabel,
    hasSetup,
  });
  return {
    hasPerinealEvents: events.length > 0,
    hasPerinealSetup: hasSetup,
    events,
    contractionEvents,
    artifactEvents,
    total: contractionEvents.length,
    byType,
    possibleArtifactCount: artifactEvents.length,
    strongestEvent,
    longestHoldEvent,
    averageDurationSeconds: durations.length ? average(durations) : null,
    totalActiveSeconds,
    averageConfidence,
    confidenceLabel: confidenceLabel(averageConfidence),
    artifactRatio,
    qualityLabel,
    qualityDisplayLabel: qualityDisplayLabel(qualityLabel),
    storySentence,
    notableEvents,
    strongestEventTypeLabel: strongestEvent ? displayType(strongestEvent.contraction_type) : null,
  };
}
