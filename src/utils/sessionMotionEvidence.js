function rows(value) {
  return Array.isArray(value) ? value : [];
}

function present(value) {
  return value != null && value !== "";
}

export function getMotionDerivedEvents(session) {
  return rows(session?.event_timeline).filter((event) => event?.source === "motion_derived");
}

export function hasPromotedMotionEvents(session) {
  return getMotionDerivedEvents(session).length > 0;
}

export function hasSavedMotionTelemetry(session) {
  const motion = session?.motion_analysis_summary;
  if (!motion || typeof motion !== "object") return false;
  return Boolean(
    present(motion.source)
    || present(motion.analyzed_at)
    || rows(motion.derived_timeline).length
    || rows(motion.findings).length
    || rows(motion.review_peaks).length
    || present(motion.asymmetry_summary)
    || present(motion.hand_movement_summary)
    || present(motion.lower_body_pattern_summary)
    || present(motion.lower_body_posture_summary)
    || present(motion.left_lower_body_average_activity)
    || present(motion.right_lower_body_average_activity)
    || present(motion.hand_average_activity)
  );
}

export function hasAnyMotionEvidence(session) {
  return hasSavedMotionTelemetry(session) || hasPromotedMotionEvents(session);
}

export function getMotionEvidenceFreshnessKey(session) {
  const motion = session?.motion_analysis_summary || {};
  const timeline = rows(session?.event_timeline);
  const promoted = getMotionDerivedEvents(session);
  return [
    motion.analyzed_at || "",
    rows(motion.derived_timeline).length,
    rows(motion.findings).length,
    rows(motion.review_peaks).length,
    timeline.length,
    timeline.map((event) => `${event.source || "legacy"}:${event.time_s || 0}:${event.note || ""}`).join("|"),
    promoted.length,
    promoted.map((event) => `${event.time_s || 0}:${event.note || ""}`).join("|"),
  ].join("::");
}

export function getMotionEvidenceSummary(session) {
  const motion = session?.motion_analysis_summary || {};
  const promotedEvents = getMotionDerivedEvents(session);
  const hasSavedTelemetry = hasSavedMotionTelemetry(session);
  const hasPromotedEvents = promotedEvents.length > 0;
  const sourceTypes = [
    hasSavedTelemetry ? "saved_telemetry" : null,
    hasPromotedEvents ? "promoted_motion_events" : null,
  ].filter(Boolean);

  return {
    hasAnyMotionEvidence: hasSavedTelemetry || hasPromotedEvents,
    hasSavedTelemetry,
    hasPromotedEvents,
    sourceTypes,
    analyzedAt: motion.analyzed_at || null,
    promotedEventCount: promotedEvents.length,
    promotedEvents,
    savedFindingCount: rows(motion.findings).length,
    reviewPeakCount: rows(motion.review_peaks).length,
    hasDerivedTimeline: rows(motion.derived_timeline).length > 0,
    derivedTimelinePointCount: rows(motion.derived_timeline).length,
    asymmetrySummary: motion.asymmetry_summary || null,
    handCadenceSummary: motion.hand_movement_summary || null,
    lowerBodyPatternProxySummary: motion.lower_body_pattern_summary || null,
    footAppearanceCandidateSummary: motion.lower_body_posture_summary || null,
    confidenceSummary: motion.quality_indicators || null,
    leftLowerBodyAverage: motion.left_lower_body_average_activity ?? null,
    rightLowerBodyAverage: motion.right_lower_body_average_activity ?? null,
    handAverage: motion.hand_average_activity ?? null,
    findings: rows(motion.findings),
    reviewPeaks: rows(motion.review_peaks),
    freshnessKey: getMotionEvidenceFreshnessKey(session),
  };
}

export function getMotionEvidenceDigest(session) {
  const evidence = getMotionEvidenceSummary(session);
  if (!evidence.hasAnyMotionEvidence) {
    return "No saved motion telemetry or promoted motion-derived events are available for this session.";
  }

  const lines = [];
  if (evidence.hasSavedTelemetry && !evidence.hasPromotedEvents) {
    lines.push("Saved motion telemetry exists for this session, but no reviewed motion-derived findings have been promoted into the event timeline yet.");
  } else if (!evidence.hasSavedTelemetry && evidence.hasPromotedEvents) {
    lines.push("Reviewed motion-derived findings are available in the event timeline, although no saved telemetry summary is available.");
  } else {
    lines.push("Saved motion telemetry and promoted motion-derived event evidence are available for this session.");
  }

  if (evidence.leftLowerBodyAverage != null || evidence.rightLowerBodyAverage != null) {
    lines.push(`Lower-body average activity: left ${evidence.leftLowerBodyAverage ?? "unknown"}, right ${evidence.rightLowerBodyAverage ?? "unknown"}.`);
  }
  if (evidence.asymmetrySummary) {
    const asymmetry = evidence.asymmetrySummary;
    lines.push(`Lower-body asymmetry summary: average index ${asymmetry.averageIndex ?? "unknown"}; ${asymmetry.predominantSide === "balanced" ? "no clear side predominance" : `${asymmetry.predominantSide || "unknown"} predominance${asymmetry.predominantPct != null ? ` in ${asymmetry.predominantPct}% of active paired windows` : ""}`}.`);
  }
  if (evidence.handCadenceSummary?.movement_cycles_per_minute_estimate != null) {
    lines.push(`Hand-movement cadence proxy: approximately ${evidence.handCadenceSummary.movement_cycles_per_minute_estimate} movement cycles per minute; pauses of at least two seconds: ${evidence.handCadenceSummary.pause_count ?? "unknown"}.`);
  }
  if (evidence.lowerBodyPatternProxySummary) {
    const pattern = evidence.lowerBodyPatternProxySummary;
    lines.push(`Lower-body pattern proxies: ${pattern.movement_burst_count ?? 0} movement bursts, ${pattern.oscillatory_candidate_count ?? 0} oscillatory or shudder-like candidates, ${pattern.sustained_activity_shift_count ?? 0} sustained elevations, ${pattern.left_right_divergence_count ?? 0} side divergences.`);
  }
  if (evidence.savedFindingCount) {
    evidence.findings.slice(0, 4).forEach((finding) => lines.push(`Saved finding: ${finding}`));
  }
  if (evidence.hasPromotedEvents) {
    evidence.promotedEvents.slice(0, 8).forEach((event) => {
      lines.push(`Promoted motion-derived event at ${event.time_s}s: ${event.note || "observational motion finding"}`);
    });
  }
  lines.push("Motion evidence is observational only; do not infer intent, arousal phase, force, neurological mechanism, or physiological cause from motion alone.");
  return lines.join("\n");
}

export function summarizeMotionEvidenceCoverage(sessions) {
  const values = rows(sessions).map(getMotionEvidenceSummary);
  return {
    any: values.filter((entry) => entry.hasAnyMotionEvidence).length,
    saved: values.filter((entry) => entry.hasSavedTelemetry).length,
    promoted: values.filter((entry) => entry.hasPromotedEvents).length,
    both: values.filter((entry) => entry.hasSavedTelemetry && entry.hasPromotedEvents).length,
  };
}
