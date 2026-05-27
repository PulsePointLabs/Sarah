function rows(value) {
  return Array.isArray(value) ? value : [];
}

function present(value) {
  return value != null && value !== "";
}

function manualGeometryMarkedCount(geometry) {
  return Number(geometry?.marked_count || 0);
}

function geometryValue(value, suffix = "") {
  return value == null ? "unknown" : `${value}${suffix}`;
}

function summarizeManualFootLandmarkGeometry(geometry, label = "Manual foot landmark geometry") {
  if (!geometry || manualGeometryMarkedCount(geometry) <= 0) return null;
  return [
    `${label}: ${geometry.marked_count}/${geometry.expected_count || 6} landmarks marked.`,
    `Foot spread / posture geometry: fan angle ${geometryValue(geometry.fan_angle_deg, "°")}; toe gap ${geometryValue(geometry.toe_gap_normalized)}; heel gap ${geometryValue(geometry.heel_gap_normalized)}.`,
    `Foot axis geometry: left axis ${geometryValue(geometry.left_axis_deg, "°")}; right axis ${geometryValue(geometry.right_axis_deg, "°")}.`,
    `Planted-vs-neutral proxy: left ${geometryValue(geometry.left_planted_proxy)}; right ${geometryValue(geometry.right_planted_proxy)}.`,
  ].join(" ");
}

function manualFootLandmarkSegments(motion) {
  return rows(motion?.region_segments).filter((segment) => manualGeometryMarkedCount(segment?.manual_foot_landmark_geometry) > 0);
}

function eventCategories(event) {
  return Array.isArray(event?.category) ? event.category : [event?.category].filter(Boolean);
}

export function getMotionDerivedEvents(session) {
  return rows(session?.event_timeline).filter((event) => event?.source === "motion_derived");
}

export function getManualStimulationPauseResumeEvents(session) {
  return rows(session?.event_timeline).filter((event) => (
    event?.source !== "motion_derived"
    && eventCategories(event).some((category) => ["stimulation_paused", "stimulation_resumed"].includes(category))
  ));
}

export function getMotionPauseResumeEvents(session) {
  return getMotionDerivedEvents(session).filter((event) => (
    eventCategories(event).some((category) => ["motion_pause", "motion_resume"].includes(category))
    || /\b(hand activity pause|hand activity resumed|hand inactivity|resumption candidate)\b/i.test(String(event?.note || ""))
  ));
}

export function hasMotionPauseResumeEvidence(session) {
  return getMotionPauseResumeEvents(session).length > 0
    || Number(session?.motion_analysis_summary?.hand_movement_summary?.pause_count || 0) > 0;
}

export function hasMixedPauseResumeEvidence(session) {
  return getManualStimulationPauseResumeEvents(session).length > 0
    && hasMotionPauseResumeEvidence(session);
}

export function isVerifiedMotionEvent(event) {
  return event?.source === "motion_derived"
    && ["reviewed_verified", "reviewed_adjusted"].includes(event?.verification_status);
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
    || present(motion.hand_behavior_summary)
    || present(motion.lower_body_pattern_summary)
    || present(motion.lower_body_posture_summary)
    || present(motion.manual_foot_landmark_geometry)
    || rows(motion.region_segments).some((segment) => present(segment.manual_foot_landmark_geometry))
    || rows(motion.region_segments).length
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
    session?.updated_date || session?.updated_at || "",
    motion.analyzed_at || "",
    rows(motion.derived_timeline).length,
    rows(motion.findings).length,
    rows(motion.review_peaks).length,
    JSON.stringify({
      asymmetry: motion.asymmetry_summary || null,
      cadence: motion.hand_movement_summary || null,
      handBehavior: motion.hand_behavior_summary || null,
      lowerBody: motion.lower_body_pattern_summary || null,
      posture: motion.lower_body_posture_summary || null,
      regionSegments: motion.region_segment_summary || rows(motion.region_segments).map((segment) => ({
        id: segment.id,
        start_time_s: segment.start_time_s,
        end_time_s: segment.end_time_s,
        label: segment.label,
      })),
      manualFootLandmarkGeometry: motion.manual_foot_landmark_geometry || null,
      manualFootLandmarkSegments: rows(motion.region_segments).map((segment) => ({
        id: segment.id,
        start_time_s: segment.start_time_s,
        end_time_s: segment.end_time_s,
        label: segment.label,
        geometry: segment.manual_foot_landmark_geometry || null,
      })),
      quality: motion.quality_indicators || null,
    }),
    timeline.length,
    timeline.map((event) => `${event.source || "legacy"}:${event.time_s || 0}:${event.verification_status || ""}:${event.verified_at || ""}:${event.note || ""}`).join("|"),
    promoted.length,
    promoted.map((event) => `${event.time_s || 0}:${event.verification_status || ""}:${event.verified_at || ""}:${event.note || ""}`).join("|"),
  ].join("::");
}

export function getMotionEvidenceSummary(session) {
  const motion = session?.motion_analysis_summary || {};
  const promotedEvents = getMotionDerivedEvents(session);
  const manualStimulationPauseResumeEvents = getManualStimulationPauseResumeEvents(session);
  const motionPauseResumeEvents = getMotionPauseResumeEvents(session);
  const verifiedPromotedEvents = promotedEvents.filter(isVerifiedMotionEvent);
  const hasSavedTelemetry = hasSavedMotionTelemetry(session);
  const hasPromotedEvents = promotedEvents.length > 0;
  const manualFootLandmarkSegmentRows = manualFootLandmarkSegments(motion);
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
    verifiedPromotedEventCount: verifiedPromotedEvents.length,
    verifiedPromotedEvents,
    manualStimulationPauseResumeCount: manualStimulationPauseResumeEvents.length,
    manualStimulationPauseResumeEvents,
    motionPauseResumeCount: motionPauseResumeEvents.length,
    motionPauseResumeEvents,
    hasMixedPauseResumeEvidence: manualStimulationPauseResumeEvents.length > 0 && hasMotionPauseResumeEvidence(session),
    savedFindingCount: rows(motion.findings).length,
    reviewPeakCount: rows(motion.review_peaks).length,
    hasDerivedTimeline: rows(motion.derived_timeline).length > 0,
    derivedTimelinePointCount: rows(motion.derived_timeline).length,
    asymmetrySummary: motion.asymmetry_summary || null,
    handCadenceSummary: motion.hand_movement_summary || null,
    handBehaviorSummary: motion.hand_behavior_summary || null,
    lowerBodyPatternProxySummary: motion.lower_body_pattern_summary || null,
    footAppearanceCandidateSummary: motion.lower_body_posture_summary || null,
    manualFootLandmarks: motion.manual_foot_landmarks || null,
    manualFootLandmarkGeometry: motion.manual_foot_landmark_geometry || null,
    manualFootLandmarkSegmentCount: manualFootLandmarkSegmentRows.length,
    manualFootLandmarkSegments: manualFootLandmarkSegmentRows,
    regionSegments: rows(motion.region_segments),
    regionSegmentSummary: motion.region_segment_summary || null,
    regionSegmentCount: rows(motion.region_segments).length,
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
  if (evidence.regionSegmentCount > 1) {
    lines.push(`Position-change tracking regions: ${evidence.regionSegmentCount} region segments were used. Values near segment boundaries may reflect ROI or framing changes and are not directly interpretable as physiological transitions without video confirmation.`);
  }
  if (evidence.asymmetrySummary) {
    const asymmetry = evidence.asymmetrySummary;
    lines.push(`Lower-body asymmetry summary: average index ${asymmetry.averageIndex ?? "unknown"}; ${asymmetry.predominantSide === "balanced" ? "no clear side predominance" : `${asymmetry.predominantSide || "unknown"} predominance${asymmetry.predominantPct != null ? ` in ${asymmetry.predominantPct}% of active paired windows` : ""}`}.`);
  }
  const standaloneManualGeometry = summarizeManualFootLandmarkGeometry(evidence.manualFootLandmarkGeometry);
  if (standaloneManualGeometry) {
    lines.push(`${standaloneManualGeometry} Treat this as user-placed visual geometry evidence from the saved video frame, not automatic tracking, force, pressure, intent, or physiological cause.`);
    lines.push("When manual foot landmark geometry is present, explicitly mention toe gap, heel gap, fan angle, left/right foot-axis angles, and planted-vs-neutral proxy values when discussing foot spread, fanning, toe curl, planted posture, or lower-body positioning. Heel gap and toe gap together are especially important for distinguishing whole-foot spread from forefoot-only fanning.");
  }
  if (evidence.manualFootLandmarkSegmentCount) {
    lines.push(`Manual foot landmark geometry is available for ${evidence.manualFootLandmarkSegmentCount} position segment${evidence.manualFootLandmarkSegmentCount === 1 ? "" : "s"}. These segment-level landmarks should be used to interpret foot spread, foot-axis angle, toe/heel spacing, and planted/neutral proxies only within the matching position segment.`);
    lines.push("For segment-level manual foot geometry, cite the actual toe gap and heel gap when available. Use heel gap plus toe gap to distinguish whole-foot base spread from forefoot/toe fanning, and use left/right axis angles to describe asymmetry in foot orientation.");
    evidence.manualFootLandmarkSegments.slice(0, 6).forEach((segment) => {
      const summary = summarizeManualFootLandmarkGeometry(
        segment.manual_foot_landmark_geometry,
        `Segment ${segment.label || segment.start_time_s || "unknown"} manual foot geometry`,
      );
      if (summary) lines.push(summary);
    });
  }
  if (evidence.handCadenceSummary?.movement_cycles_per_minute_estimate != null) {
    lines.push(`Hand-movement cadence proxy: approximately ${evidence.handCadenceSummary.movement_cycles_per_minute_estimate} movement cycles per minute; pauses of at least two seconds: ${evidence.handCadenceSummary.pause_count ?? "unknown"}.`);
  }
  if (evidence.manualStimulationPauseResumeCount) {
    lines.push(`Explicit manually entered stimulation pause/resume evidence is present (${evidence.manualStimulationPauseResumeCount} timeline events). For stimulation pause timing and duration, these manual events take priority over motion-derived hand inactivity or resumption candidates; use motion pause signals only as secondary corroborating context because hand tracking may be incomplete.`);
  } else if (evidence.handCadenceSummary?.pause_count != null) {
    lines.push("No explicit manually entered stimulation pause/resume events were identified in this session. Motion-derived hand pause counts may be discussed only as provisional observed hand-activity gaps, not confirmed stimulation pauses.");
  }
  if (evidence.handBehaviorSummary?.status === "calibrated_matching_available") {
    lines.push(`Calibrated hand-behavior comparison: ${evidence.handBehaviorSummary.stroke_like_window_count ?? 0} stroke-like rhythmic motion proxy windows matched recorded-video examples, covering approximately ${evidence.handBehaviorSummary.stroke_like_time_pct ?? 0}% of the analyzed window. This is an observational proxy, not confirmed technique or intent.`);
  }
  if (evidence.lowerBodyPatternProxySummary) {
    const pattern = evidence.lowerBodyPatternProxySummary;
    lines.push(`Lower-body pattern proxies: ${pattern.movement_burst_count ?? 0} movement bursts, ${pattern.oscillatory_candidate_count ?? 0} oscillatory or shudder-like candidates, ${pattern.sustained_activity_shift_count ?? 0} sustained elevations, ${pattern.left_right_divergence_count ?? 0} side divergences.`);
  }
  if (evidence.savedFindingCount) {
    evidence.findings.slice(0, 4).forEach((finding) => lines.push(`Saved finding: ${finding}`));
  }
  if (evidence.hasPromotedEvents) {
    if (evidence.verifiedPromotedEventCount) {
      lines.push("User-verified motion-derived events have been visually reviewed and may be treated as stronger observational evidence than unverified motion-derived events. They remain observational evidence only and do not prove intent, force, neurological mechanism, or physiological cause.");
    }
    evidence.promotedEvents.slice(0, 8).forEach((event) => {
      const reviewStatus = event.verification_status === "reviewed_verified"
        ? "user-verified"
        : event.verification_status === "reviewed_adjusted"
          ? "user-reviewed and adjusted"
          : "unverified";
      lines.push(`Promoted motion-derived event (${reviewStatus}) at ${event.time_s}s: ${event.note || "observational motion finding"}`);
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
