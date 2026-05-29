from pathlib import Path

path = Path("src/components/LocalMotionAnalysisPanel.jsx")
if not path.exists():
    raise SystemExit("Run this from the PulsePoint-Standalone repo root. Missing src/components/LocalMotionAnalysisPanel.jsx")

text = path.read_text(encoding="utf-8")

if "MOTION_LAB_MARKER_CONFIDENCE_V1" in text:
    print("Motion Lab marker confidence v1 already appears to be applied. No changes made.")
    raise SystemExit(0)

backup = path.with_suffix(".jsx.bak-marker-confidence-v1")
backup.write_text(text, encoding="utf-8")

old_block = '''function markerTripletToFootPoints(points) {
  if (!Array.isArray(points) || points.length < 3) return null;
  const ordered = [...points].sort((first, second) => first.y - second.y);
  return {
    bigToe: { x: ordered[0].x, y: ordered[0].y },
    forefoot: { x: ordered[1].x, y: ordered[1].y },
    heel: { x: ordered[2].x, y: ordered[2].y },
  };
}

function buildMarkerFootGeometry(leftMarkers, rightMarkers) {
  const left = markerTripletToFootPoints(leftMarkers);
  const right = markerTripletToFootPoints(rightMarkers);
  if (!left || !right) return null;

  const landmarks = {
    leftBigToe: left.bigToe,
    leftForefoot: left.forefoot,
    leftHeel: left.heel,
    rightBigToe: right.bigToe,
    rightForefoot: right.forefoot,
    rightHeel: right.heel,
  };

  return {
    ...computeFootLandmarkGeometry(landmarks),
    method: "marker_assisted_foot_geometry_timeline",
    method_note: "Experimental reflective-marker tracking from bright dot-like blobs inside the left/right foot ROIs. Assumes three visible markers per foot ordered toe-to-heel by vertical position. Use as observational trend support only; verify against video.",
    landmarks: roundedFootLandmarks(landmarks),
  };
}
'''

new_block = '''// MOTION_LAB_MARKER_CONFIDENCE_V1
const MARKER_ANCHOR_MAX_DISTANCE = 0.085;
const FOOT_MARKER_ROLE_KEYS = ["bigToe", "forefoot", "heel"];
const FOOT_MARKER_LANDMARK_KEYS = {
  left: { bigToe: "leftBigToe", forefoot: "leftForefoot", heel: "leftHeel" },
  right: { bigToe: "rightBigToe", forefoot: "rightForefoot", heel: "rightHeel" },
};

function markerAssignmentSummary(assignment) {
  if (!assignment) return { status: "missing", confidence: "rejected" };
  return {
    status: assignment.status,
    confidence: assignment.confidence,
    method: assignment.method,
    rejection_reason: assignment.rejectionReason,
    mean_anchor_distance: assignment.meanAnchorDistance,
    max_anchor_distance: assignment.maxAnchorDistance,
    detected_marker_count: assignment.detectedMarkerCount,
  };
}

function fallbackMarkerTripletAssignment(points) {
  if (!Array.isArray(points) || points.length < 3) {
    return {
      status: "rejected",
      confidence: "rejected",
      method: "vertical_sort_fallback",
      rejectionReason: "fewer_than_three_markers",
      detectedMarkerCount: Array.isArray(points) ? points.length : 0,
      points: null,
    };
  }
  const ordered = [...points].sort((first, second) => first.y - second.y).slice(0, 3);
  return {
    status: "assigned",
    confidence: "limited",
    method: "vertical_sort_fallback",
    rejectionReason: null,
    detectedMarkerCount: points.length,
    meanAnchorDistance: null,
    maxAnchorDistance: null,
    points: {
      bigToe: { x: ordered[0].x, y: ordered[0].y },
      forefoot: { x: ordered[1].x, y: ordered[1].y },
      heel: { x: ordered[2].x, y: ordered[2].y },
    },
  };
}

function assignMarkersToManualAnchors(markers, manualLandmarks, side) {
  const landmarkKeys = FOOT_MARKER_LANDMARK_KEYS[side];
  const anchors = Object.fromEntries(FOOT_MARKER_ROLE_KEYS.map((role) => [role, manualLandmarks?.[landmarkKeys[role]] || null]));
  const hasAllAnchors = FOOT_MARKER_ROLE_KEYS.every((role) => anchors[role]);
  if (!hasAllAnchors) return fallbackMarkerTripletAssignment(markers);
  if (!Array.isArray(markers) || markers.length < 3) {
    return {
      status: "rejected",
      confidence: "rejected",
      method: "manual_anchor_match",
      rejectionReason: "fewer_than_three_markers",
      detectedMarkerCount: Array.isArray(markers) ? markers.length : 0,
      points: null,
    };
  }

  const available = markers.map((marker, index) => ({ ...marker, markerIndex: index }));
  const assignments = {};
  const distances = [];
  for (const role of FOOT_MARKER_ROLE_KEYS) {
    const anchor = anchors[role];
    const nearest = [...available]
      .map((marker) => ({ marker, distance: pointDistance(marker, anchor) ?? Infinity }))
      .sort((first, second) => first.distance - second.distance)[0];
    if (!nearest || nearest.distance > MARKER_ANCHOR_MAX_DISTANCE) {
      return {
        status: "rejected",
        confidence: "rejected",
        method: "manual_anchor_match",
        rejectionReason: `marker_too_far_from_${role}_anchor`,
        detectedMarkerCount: markers.length,
        maxAnchorDistance: Math.round((nearest?.distance || 0) * 1000) / 1000,
        points: null,
      };
    }
    assignments[role] = { x: nearest.marker.x, y: nearest.marker.y };
    distances.push(nearest.distance);
    const usedIndex = available.findIndex((marker) => marker.markerIndex === nearest.marker.markerIndex);
    if (usedIndex >= 0) available.splice(usedIndex, 1);
  }

  const meanDistance = mean(distances) || 0;
  const maxDistance = Math.max(...distances);
  return {
    status: "assigned",
    confidence: maxDistance <= 0.045 ? "strong" : "moderate",
    method: "manual_anchor_match",
    rejectionReason: null,
    detectedMarkerCount: markers.length,
    meanAnchorDistance: Math.round(meanDistance * 1000) / 1000,
    maxAnchorDistance: Math.round(maxDistance * 1000) / 1000,
    points: assignments,
  };
}

function buildMarkerFootGeometry(leftMarkers, rightMarkers, manualLandmarks = null) {
  const left = assignMarkersToManualAnchors(leftMarkers, manualLandmarks, "left");
  const right = assignMarkersToManualAnchors(rightMarkers, manualLandmarks, "right");
  if (!left.points || !right.points) {
    return {
      status: "marker_assignment_rejected",
      method: "marker_assisted_foot_geometry_timeline",
      marked_count: 0,
      expected_count: FOOT_LANDMARKS.length,
      marker_assignment: {
        left: markerAssignmentSummary(left),
        right: markerAssignmentSummary(right),
      },
      method_note: "Reflective marker blobs were detected, but toe/forefoot/heel assignment was rejected or incomplete. Region motion remains the primary foot movement signal.",
      landmarks: null,
    };
  }

  const landmarks = {
    leftBigToe: left.points.bigToe,
    leftForefoot: left.points.forefoot,
    leftHeel: left.points.heel,
    rightBigToe: right.points.bigToe,
    rightForefoot: right.points.forefoot,
    rightHeel: right.points.heel,
  };
  const manualAnchorUsed = left.method === "manual_anchor_match" && right.method === "manual_anchor_match";
  const confidence = [left.confidence, right.confidence].includes("limited")
    ? "limited"
    : [left.confidence, right.confidence].includes("moderate")
      ? "moderate"
      : "strong";

  return {
    ...computeFootLandmarkGeometry(landmarks),
    method: "marker_assisted_foot_geometry_timeline",
    marker_assignment_confidence: confidence,
    marker_assignment_method: manualAnchorUsed ? "manual_anchor_match" : "vertical_sort_fallback",
    marker_assignment: {
      left: markerAssignmentSummary(left),
      right: markerAssignmentSummary(right),
    },
    method_note: manualAnchorUsed
      ? "Experimental reflective-marker tracking using manual foot landmarks as anchors for identical silver markers. Use as observational trend support only; verify important moments against video."
      : "Experimental reflective-marker tracking from bright dot-like blobs inside the left/right foot ROIs. No complete manual anchor set was available, so toe/forefoot/heel assignment falls back to vertical ordering and should be treated as limited-confidence trend support only.",
    landmarks: roundedFootLandmarks(landmarks),
  };
}
'''

if old_block not in text:
    raise SystemExit("Patch failed: could not find markerTripletToFootPoints/buildMarkerFootGeometry block.")
text = text.replace(old_block, new_block, 1)

text = text.replace(
'''      const defaultFrameConfiguration = {
        appliedRois: analysisRois,
        roiLayout,
        lowerBodyMethod: appliedLowerBodyMethod,
        forefootEnabled,
        postureMatchingEnabled,
        postureReferenceTimes,
        handBehaviorMatchingEnabled,
        handBehaviorReferenceTimes,
        leftRightOrientation,
        segment: null,
      };
''',
'''      const defaultFrameConfiguration = {
        appliedRois: analysisRois,
        roiLayout,
        lowerBodyMethod: appliedLowerBodyMethod,
        forefootEnabled,
        postureMatchingEnabled,
        postureReferenceTimes,
        handBehaviorMatchingEnabled,
        handBehaviorReferenceTimes,
        footLandmarks: copyFootLandmarks(footLandmarks),
        leftRightOrientation,
        segment: null,
      };
''',
1,
)

text = text.replace(
'''        const footMarkerGeometry = markerTrackingActive
          ? buildMarkerFootGeometry(leftMarkerPoints, rightMarkerPoints)
          : null;
''',
'''        const footMarkerGeometry = markerTrackingActive
          ? buildMarkerFootGeometry(leftMarkerPoints, rightMarkerPoints, frameConfiguration.footLandmarks)
          : null;
''',
1,
)

text = text.replace(
'''  context.fillStyle = footMarkerGeometry?.marked_count >= 6 ? "#5eead4" : "#fbbf24";
  context.fillText(
    footMarkerGeometry?.marked_count >= 6
      ? `Marker geometry: ${footMarkerGeometry.fan_angle_deg ?? "?"} deg fan`
      : "Marker geometry: waiting for 3 dots per foot",
    20,
    72,
  );
''',
'''  context.fillStyle = footMarkerGeometry?.marked_count >= 6 ? "#5eead4" : "#fbbf24";
  const assignmentLabel = footMarkerGeometry?.marked_count >= 6
    ? `${footMarkerGeometry.marker_assignment_method || "marker assignment"}; ${footMarkerGeometry.marker_assignment_confidence || "limited"}`
    : footMarkerGeometry?.status === "marker_assignment_rejected"
      ? "marker assignment rejected"
      : "waiting for 3 dots per foot";
  context.fillText(
    footMarkerGeometry?.marked_count >= 6
      ? `Geometry: ${footMarkerGeometry.fan_angle_deg ?? "?"} deg fan (${assignmentLabel})`
      : `Geometry: ${assignmentLabel}`,
    20,
    72,
  );
''',
1,
)

text = text.replace(
'''function buildFootGeometryTrackingSummary(samples, sampleRate) {
  const frames = samples
    .filter((sample) => sample.footMarkerGeometry?.marked_count >= 6)
    .map((sample) => ({
      time_s: Math.round(sample.timeS * 10) / 10,
      fan_angle_deg: sample.footMarkerGeometry.fan_angle_deg,
      toe_gap_normalized: sample.footMarkerGeometry.toe_gap_normalized,
      heel_gap_normalized: sample.footMarkerGeometry.heel_gap_normalized,
      left_axis_deg: sample.footMarkerGeometry.left_axis_deg,
      right_axis_deg: sample.footMarkerGeometry.right_axis_deg,
      left_planted_proxy: sample.footMarkerGeometry.left_planted_proxy,
      right_planted_proxy: sample.footMarkerGeometry.right_planted_proxy,
      region_segment_id: sample.regionSegmentId || undefined,
      region_segment_label: sample.regionSegmentLabel || undefined,
    }));

  const coveragePct = samples.length ? Math.round((frames.length / samples.length) * 100) : 0;

  if (!frames.length) {
    return {
      status: "no_marker_geometry_detected",
      method: "marker_assisted_foot_geometry_timeline",
      coverage_pct: 0,
      sample_count: 0,
      method_note: "No continuous reflective-marker foot geometry was detected. Manual landmark geometry may still be available as a single reference frame.",
      timeline: [],
    };
  }
''',
'''function buildFootGeometryTrackingSummary(samples, sampleRate) {
  const markerAttempts = samples.filter((sample) => sample.footMarkerGeometry);
  const acceptedMarkerSamples = samples.filter((sample) => sample.footMarkerGeometry?.marked_count >= 6);
  const rejectedMarkerSamples = markerAttempts.filter((sample) => sample.footMarkerGeometry?.marked_count < 6);
  const anchorMatchedFrames = acceptedMarkerSamples.filter((sample) => sample.footMarkerGeometry?.marker_assignment_method === "manual_anchor_match").length;
  const fallbackFrames = acceptedMarkerSamples.filter((sample) => sample.footMarkerGeometry?.marker_assignment_method === "vertical_sort_fallback").length;
  const strongFrames = acceptedMarkerSamples.filter((sample) => sample.footMarkerGeometry?.marker_assignment_confidence === "strong").length;
  const moderateFrames = acceptedMarkerSamples.filter((sample) => sample.footMarkerGeometry?.marker_assignment_confidence === "moderate").length;
  const limitedFrames = acceptedMarkerSamples.filter((sample) => sample.footMarkerGeometry?.marker_assignment_confidence === "limited").length;
  const frames = acceptedMarkerSamples.map((sample) => ({
      time_s: Math.round(sample.timeS * 10) / 10,
      fan_angle_deg: sample.footMarkerGeometry.fan_angle_deg,
      toe_gap_normalized: sample.footMarkerGeometry.toe_gap_normalized,
      heel_gap_normalized: sample.footMarkerGeometry.heel_gap_normalized,
      left_axis_deg: sample.footMarkerGeometry.left_axis_deg,
      right_axis_deg: sample.footMarkerGeometry.right_axis_deg,
      left_planted_proxy: sample.footMarkerGeometry.left_planted_proxy,
      right_planted_proxy: sample.footMarkerGeometry.right_planted_proxy,
      marker_assignment_confidence: sample.footMarkerGeometry.marker_assignment_confidence,
      marker_assignment_method: sample.footMarkerGeometry.marker_assignment_method,
      region_segment_id: sample.regionSegmentId || undefined,
      region_segment_label: sample.regionSegmentLabel || undefined,
    }));

  const coveragePct = samples.length ? Math.round((frames.length / samples.length) * 100) : 0;
  const acceptedPct = markerAttempts.length ? Math.round((acceptedMarkerSamples.length / markerAttempts.length) * 100) : 0;

  if (!frames.length) {
    return {
      status: "no_marker_geometry_detected",
      method: "marker_assisted_foot_geometry_timeline",
      coverage_pct: 0,
      sample_count: 0,
      attempted_marker_frames: markerAttempts.length,
      accepted_marker_frames: 0,
      rejected_marker_frames: rejectedMarkerSamples.length,
      accepted_marker_frame_pct: 0,
      method_note: "No continuous reflective-marker foot geometry was accepted. Manual landmark geometry may still be available as a single reference frame. Region motion remains the primary foot movement signal.",
      timeline: [],
    };
  }
''',
1,
)

text = text.replace(
'''    sample_count: frames.length,
    sample_rate_fps: sampleRate,
''',
'''    sample_count: frames.length,
    sample_rate_fps: sampleRate,
    attempted_marker_frames: markerAttempts.length,
    accepted_marker_frames: acceptedMarkerSamples.length,
    rejected_marker_frames: rejectedMarkerSamples.length,
    accepted_marker_frame_pct: acceptedPct,
    anchor_matched_frames: anchorMatchedFrames,
    vertical_sort_fallback_frames: fallbackFrames,
    confidence_frame_counts: {
      strong: strongFrames,
      moderate: moderateFrames,
      limited: limitedFrames,
    },
''',
1,
)

text = text.replace(
'''    interpretation_hint: "Use this as continuous observational foot-position trend support. Describe how foot spread, fanning, heel separation, toe gap, foot-axis symmetry, and planted/neutral posture change over time rather than treating one saved frame as whole-session truth.",
    method_note: "Experimental marker-assisted tracking from bright reflective dots in the foot ROIs. Requires stable lighting and three visible markers per foot. Confirm important moments against video.",
''',
'''    interpretation_hint: "Use this as continuous observational foot-position trend support. Describe how foot spread, fanning, heel separation, toe gap, foot-axis symmetry, and planted/neutral posture change over time rather than treating one saved frame as whole-session truth. Treat frames with vertical_sort_fallback or limited confidence cautiously.",
    method_note: anchorMatchedFrames > 0
      ? "Experimental marker-assisted tracking from bright reflective dots in the foot ROIs, using manual landmarks as anchors when available. Requires stable lighting and three visible markers per foot. Confirm important moments against video."
      : "Experimental marker-assisted tracking from bright reflective dots in the foot ROIs. No complete manual anchor set was available for accepted frames, so assignment relied on vertical ordering and should be treated as limited-confidence trend evidence.",
''',
1,
)

path.write_text(text, encoding="utf-8")
print("Applied Motion Lab marker confidence v1.")
print("Backup written to", backup)
