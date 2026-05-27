import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, CheckCircle2, Footprints, Hand, Loader2, Play, Save, Settings2, ShieldCheck, Square } from "lucide-react";
import {
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import SideBalanceGauge from "./SideBalanceGauge";

const TASKS_VISION_VERSION = "0.10.35";
const WASM_ROOT = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${TASKS_VISION_VERSION}/wasm`;
const POSE_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";
const HAND_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const LEFT_LEG_POINTS = [25, 27, 29, 31];
const RIGHT_LEG_POINTS = [26, 28, 30, 32];
const LEG_CONNECTIONS = [[25, 27], [27, 29], [29, 31], [26, 28], [28, 30], [30, 32]];
const HAND_CONNECTIONS = [
  [0, 1], [1, 2], [2, 3], [3, 4],
  [0, 5], [5, 6], [6, 7], [7, 8],
  [5, 9], [9, 10], [10, 11], [11, 12],
  [9, 13], [13, 14], [14, 15], [15, 16],
  [13, 17], [17, 18], [18, 19], [19, 20],
  [0, 17],
];
const FULL_FRAME_ROI = { x: 0, y: 0, width: 1, height: 1 };
const PIP_ROI_PRESET = {
  leftLowerBody: { x: 0.17, y: 0.03, width: 0.15, height: 0.36 },
  rightLowerBody: { x: 0.02, y: 0.03, width: 0.15, height: 0.36 },
  leftForefoot: { x: 0.17, y: 0.03, width: 0.15, height: 0.15 },
  rightForefoot: { x: 0.02, y: 0.03, width: 0.15, height: 0.15 },
  hands: { x: 0.35, y: 0.08, width: 0.62, height: 0.86 },
};
const POSTURE_REFERENCE_OPTIONS = [
  { key: "neutral", label: "Neutral / relaxed", phrase: "neutral / relaxed appearance" },
  { key: "outward", label: "Fanned outward", phrase: "outward / fanned appearance proxy" },
  { key: "inward", label: "Toward midline", phrase: "inward / toward-midline appearance proxy" },
  { key: "planted", label: "Downward planted", phrase: "downward planted appearance proxy" },
  { key: "dorsiflexed", label: "Toward body", phrase: "toward-body / dorsiflexed appearance proxy" },
  { key: "heel_lift", label: "Heel lift", phrase: "heel-lift appearance proxy" },
];
const HAND_REFERENCE_KEYS = ["stroke_like", "non_stroke"];

const FOOT_LANDMARKS = [
  { key: "leftBigToe", label: "Left big toe", shortLabel: "L toe", side: "left", role: "big_toe", color: "#38bdf8" },
  { key: "leftForefoot", label: "Left forefoot / ball", shortLabel: "L ball", side: "left", role: "forefoot", color: "#2dd4bf" },
  { key: "leftHeel", label: "Left heel", shortLabel: "L heel", side: "left", role: "heel", color: "#a78bfa" },
  { key: "rightBigToe", label: "Right big toe", shortLabel: "R toe", side: "right", role: "big_toe", color: "#fb7185" },
  { key: "rightForefoot", label: "Right forefoot / ball", shortLabel: "R ball", side: "right", role: "forefoot", color: "#fb923c" },
  { key: "rightHeel", label: "Right heel", shortLabel: "R heel", side: "right", role: "heel", color: "#f472b6" },
];

function emptyFootLandmarks() {
  return Object.fromEntries(FOOT_LANDMARKS.map(({ key }) => [key, null]));
}

function copyFootPoint(point) {
  return point ? { x: point.x, y: point.y } : null;
}

function copyFootLandmarks(landmarks) {
  return Object.fromEntries(FOOT_LANDMARKS.map(({ key }) => [key, copyFootPoint(landmarks?.[key])]));
}

function roundedFootPoint(point) {
  return point ? { x: Math.round(point.x * 1000) / 1000, y: Math.round(point.y * 1000) / 1000 } : null;
}

function roundedFootLandmarks(landmarks) {
  return Object.fromEntries(FOOT_LANDMARKS.map(({ key }) => [key, roundedFootPoint(landmarks?.[key])]));
}

function footLandmarkCompletion(landmarks) {
  return FOOT_LANDMARKS.filter(({ key }) => landmarks?.[key]).length;
}

function footAxisAngleDegrees(heel, toe) {
  if (!heel || !toe) return null;
  return Math.round((Math.atan2(toe.x - heel.x, -(toe.y - heel.y)) * 1800) / Math.PI) / 10;
}

function normalizedLandmarkDistance(first, second) {
  if (!first || !second) return null;
  return Math.round(pointDistance(first, second) * 1000) / 1000;
}

function footPlantedProxy(heel, forefoot, toe) {
  const full = pointDistance(heel, toe);
  const short = pointDistance(heel, forefoot);
  if (!full || !short) return null;
  return Math.round((short / full) * 1000) / 1000;
}

function computeFootLandmarkGeometry(landmarks) {
  const leftHeel = landmarks?.leftHeel;
  const leftToe = landmarks?.leftBigToe;
  const leftForefoot = landmarks?.leftForefoot;
  const rightHeel = landmarks?.rightHeel;
  const rightToe = landmarks?.rightBigToe;
  const rightForefoot = landmarks?.rightForefoot;
  const leftAxisDeg = footAxisAngleDegrees(leftHeel, leftToe);
  const rightAxisDeg = footAxisAngleDegrees(rightHeel, rightToe);
  const fanAngleDeg = leftAxisDeg != null && rightAxisDeg != null
    ? Math.round(Math.abs(rightAxisDeg - leftAxisDeg) * 10) / 10
    : null;
  const markedCount = footLandmarkCompletion(landmarks);
  return {
    status: markedCount >= FOOT_LANDMARKS.length ? "complete" : markedCount > 0 ? "partial" : "not_marked",
    marked_count: markedCount,
    expected_count: FOOT_LANDMARKS.length,
    left_axis_deg: leftAxisDeg,
    right_axis_deg: rightAxisDeg,
    fan_angle_deg: fanAngleDeg,
    toe_gap_normalized: normalizedLandmarkDistance(leftToe, rightToe),
    heel_gap_normalized: normalizedLandmarkDistance(leftHeel, rightHeel),
    left_planted_proxy: footPlantedProxy(leftHeel, leftForefoot, leftToe),
    right_planted_proxy: footPlantedProxy(rightHeel, rightForefoot, rightToe),
    method: "manual_foot_landmark_geometry",
    method_note: "Manual visual foot landmarks are normalized to the source frame. Geometry values are observational review aids, not force, pressure, or confirmed posture measurements.",
  };
}

function plantedProxyLabel(value) {
  if (value == null) return "needs heel / forefoot / toe";
  if (value < 0.5) return "more compressed / planted proxy";
  if (value < 0.68) return "neutral-ish proxy";
  return "extended / dorsiflexed proxy";
}

function drawFootLandmarkOverlay(context, landmarks, width, height, activeKey, dotSize = 8) {
  const pointFor = (key) => {
    const point = landmarks?.[key];
    return point ? { x: point.x * width, y: point.y * height } : null;
  };
  const drawLine = (from, to, color, label) => {
    const start = pointFor(from);
    const end = pointFor(to);
    if (!start || !end) return;
    context.beginPath();
    context.strokeStyle = color;
    context.lineWidth = 3;
    context.moveTo(start.x, start.y);
    context.lineTo(end.x, end.y);
    context.stroke();
    if (label) {
      context.fillStyle = color;
      context.font = "bold 12px sans-serif";
      context.fillText(label, ((start.x + end.x) / 2) + 6, ((start.y + end.y) / 2) - 6);
    }
  };
  drawLine("leftHeel", "leftBigToe", "#38bdf8", "L axis");
  drawLine("rightHeel", "rightBigToe", "#fb7185", "R axis");
  drawLine("leftBigToe", "rightBigToe", "#e5e7eb", "toe gap");
  drawLine("leftHeel", "rightHeel", "#94a3b8", "heel gap");
  drawLine("leftHeel", "leftForefoot", "#2dd4bf");
  drawLine("rightHeel", "rightForefoot", "#fb923c");

  FOOT_LANDMARKS.forEach(({ key, shortLabel, color }) => {
    const point = pointFor(key);
    if (!point) return;
    const radius = key === activeKey ? dotSize + 3 : dotSize;
    context.beginPath();
    context.fillStyle = color;
    context.arc(point.x, point.y, radius, 0, Math.PI * 2);
    context.fill();
    context.lineWidth = key === activeKey ? 4 : 2;
    context.strokeStyle = "#ffffff";
    context.stroke();
    context.fillStyle = color;
    context.font = "bold 12px sans-serif";
    context.fillText(shortLabel, point.x + radius + 4, point.y - radius - 2);
  });
}

const LOWER_BODY_METHODS = {
  regionMotion: {
    label: "Region motion (recommended for soles-facing view)",
    description: "Measures movement inside the selected foot regions without requiring the model to identify individual toes. Optional forefoot / toe-region comparison can be enabled separately.",
  },
  landmarks: {
    label: "Pose landmarks (experimental comparison)",
    description: "Uses detected ankle, heel, and foot-index landmarks. This can be unreliable when soles fill the camera view.",
  },
};

const MODES = {
  combined: {
    label: "Hands + feet / legs together",
    description: "Tracks visible hand activity and left/right foot / leg movement in one synchronized pass.",
    fps: 6,
    icon: Activity,
  },
  legs: {
    label: "Feet / legs reactivity",
    description: "Tracks visible knee, ankle, heel, and foot motion as a review signal.",
    fps: 4,
    icon: Footprints,
  },
  hands: {
    label: "Hand movement activity",
    description: "Tracks visible hand movement as groundwork for later cadence calibration.",
    fps: 8,
    icon: Hand,
  },
};

function formatTime(value) {
  const total = Math.max(0, Math.round(Number(value) || 0));
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function copyRoi(roi) {
  return { x: roi.x, y: roi.y, width: roi.width, height: roi.height };
}

function copyRois(rois) {
  return {
    leftLowerBody: copyRoi(rois.leftLowerBody),
    rightLowerBody: copyRoi(rois.rightLowerBody),
    leftForefoot: copyRoi(rois.leftForefoot),
    rightForefoot: copyRoi(rois.rightForefoot),
    hands: copyRoi(rois.hands),
  };
}

function roundedRoi(roi) {
  return {
    x: Math.round(roi.x * 1000) / 1000,
    y: Math.round(roi.y * 1000) / 1000,
    width: Math.round(roi.width * 1000) / 1000,
    height: Math.round(roi.height * 1000) / 1000,
  };
}

function roundedTime(value) {
  return Math.round((Number(value) || 0) * 10) / 10;
}

function emptyPostureReferenceTimes() {
  return Object.fromEntries(POSTURE_REFERENCE_OPTIONS.map(({ key }) => [key, null]));
}

function emptyHandBehaviorReferenceTimes() {
  return Object.fromEntries(HAND_REFERENCE_KEYS.map((key) => [key, null]));
}

function copyPostureReferenceTimes(referenceTimes) {
  return Object.fromEntries(POSTURE_REFERENCE_OPTIONS.map(({ key }) => [key, referenceTimes?.[key] ?? null]));
}

function copyHandBehaviorReferenceTimes(referenceTimes) {
  return Object.fromEntries(HAND_REFERENCE_KEYS.map((key) => [key, referenceTimes?.[key] ?? null]));
}

function normalizeRegionSegments(segments) {
  const ordered = [...(Array.isArray(segments) ? segments : [])]
    .sort((first, second) => Number(first.startTimeS) - Number(second.startTimeS));
  return ordered.map((segment, index) => ({
    ...segment,
    startTimeS: roundedTime(segment.startTimeS),
    endTimeS: index < ordered.length - 1 ? roundedTime(ordered[index + 1].startTimeS) : null,
    rois: copyRois(segment.rois),
    postureReferenceTimes: copyPostureReferenceTimes(segment.postureReferenceTimes),
    handBehaviorReferenceTimes: copyHandBehaviorReferenceTimes(segment.handBehaviorReferenceTimes),
    footLandmarks: copyFootLandmarks(segment.footLandmarks),
  }));
}

function regionSegmentAtTime(segments, timeS) {
  const time = Number(timeS) || 0;
  return [...(segments || [])]
    .reverse()
    .find((segment) => time >= Number(segment.startTimeS)) || segments?.[0] || null;
}

function serializeRegionSegments(segments) {
  return normalizeRegionSegments(segments).map((segment) => ({
    id: segment.id,
    label: segment.label,
    start_time_s: segment.startTimeS,
    end_time_s: segment.endTimeS,
    regions: {
      left_lower_body: roundedRoi(segment.rois.leftLowerBody),
      right_lower_body: roundedRoi(segment.rois.rightLowerBody),
      left_forefoot: roundedRoi(segment.rois.leftForefoot),
      right_forefoot: roundedRoi(segment.rois.rightForefoot),
      hands: roundedRoi(segment.rois.hands),
    },
    settings_overrides: {
      roi_layout: segment.roiLayout,
      forefoot_enabled: segment.forefootEnabled,
      posture_matching_enabled: segment.postureMatchingEnabled,
      hand_behavior_matching_enabled: segment.handBehaviorMatchingEnabled,
    },
    calibration_references_s: {
      foot_postures: copyPostureReferenceTimes(segment.postureReferenceTimes),
      hand_behavior: copyHandBehaviorReferenceTimes(segment.handBehaviorReferenceTimes),
    },
    manual_foot_landmarks: roundedFootLandmarks(segment.footLandmarks),
    manual_foot_landmark_geometry: computeFootLandmarkGeometry(segment.footLandmarks),
    anatomical_orientation: segment.leftRightOrientation,
  }));
}

function resolveRois(layoutMode, configuredRois) {
  if (layoutMode === "full") {
    return {
      leftLowerBody: copyRoi(FULL_FRAME_ROI),
      rightLowerBody: copyRoi(FULL_FRAME_ROI),
      leftForefoot: copyRoi(FULL_FRAME_ROI),
      rightForefoot: copyRoi(FULL_FRAME_ROI),
      hands: copyRoi(FULL_FRAME_ROI),
    };
  }
  return copyRois(configuredRois);
}

function formatRoiLabel(roi) {
  return `${Math.round(roi.width * 100)}% x ${Math.round(roi.height * 100)}% at ${Math.round(roi.x * 100)}%, ${Math.round(roi.y * 100)}%`;
}

const ROI_MIN_SIZE = 0.02;
const ROI_HANDLE_TOLERANCE = 0.02;

function roiCorners(roi) {
  return {
    nw: { x: roi.x, y: roi.y },
    ne: { x: roi.x + roi.width, y: roi.y },
    sw: { x: roi.x, y: roi.y + roi.height },
    se: { x: roi.x + roi.width, y: roi.y + roi.height },
  };
}

function findRoiResizeCorner(point, roi) {
  return Object.entries(roiCorners(roi)).find(([, corner]) => (
    Math.abs(point.x - corner.x) <= ROI_HANDLE_TOLERANCE
    && Math.abs(point.y - corner.y) <= ROI_HANDLE_TOLERANCE
  ))?.[0] || null;
}

function pointInsideRoi(point, roi) {
  return Boolean(roi) && (
    point.x >= roi.x
    && point.x <= roi.x + roi.width
    && point.y >= roi.y
    && point.y <= roi.y + roi.height
  );
}

function resizeRoiFromCorner(roi, corner, point) {
  let left = roi.x;
  let top = roi.y;
  let right = roi.x + roi.width;
  let bottom = roi.y + roi.height;
  if (corner.includes("n")) top = clamp(point.y, 0, bottom - ROI_MIN_SIZE);
  if (corner.includes("s")) bottom = clamp(point.y, top + ROI_MIN_SIZE, 1);
  if (corner.includes("w")) left = clamp(point.x, 0, right - ROI_MIN_SIZE);
  if (corner.includes("e")) right = clamp(point.x, left + ROI_MIN_SIZE, 1);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

function anatomicalScreenSide(orientation, side) {
  const leftAppearsRight = orientation === "anatomical_left_on_screen_right";
  if (side === "left") return leftAppearsRight ? "screen right" : "screen left";
  return leftAppearsRight ? "screen left" : "screen right";
}

function pointerToCanvasFrame(event, canvas, clampOutside = false) {
  if (!canvas?.width || !canvas?.height) return null;
  const rect = canvas.getBoundingClientRect();
  if (!rect.width || !rect.height) return null;
  const canvasRatio = canvas.width / canvas.height;
  const elementRatio = rect.width / rect.height;
  let contentWidth = rect.width;
  let contentHeight = rect.height;
  let contentLeft = rect.left;
  let contentTop = rect.top;
  if (elementRatio > canvasRatio) {
    contentWidth = rect.height * canvasRatio;
    contentLeft += (rect.width - contentWidth) / 2;
  } else if (elementRatio < canvasRatio) {
    contentHeight = rect.width / canvasRatio;
    contentTop += (rect.height - contentHeight) / 2;
  }
  const rawX = (event.clientX - contentLeft) / contentWidth;
  const rawY = (event.clientY - contentTop) / contentHeight;
  if (!clampOutside && (rawX < 0 || rawX > 1 || rawY < 0 || rawY > 1)) return null;
  return {
    x: clamp(rawX, 0, 1),
    y: clamp(rawY, 0, 1),
  };
}

function pointDistance(a, b) {
  if (!a || !b) return null;
  return Math.hypot(a.x - b.x, a.y - b.y);
}

function mean(values) {
  const valid = values.filter((value) => Number.isFinite(value));
  if (!valid.length) return null;
  return valid.reduce((sum, value) => sum + value, 0) / valid.length;
}

function percentile(values, fraction) {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (!sorted.length) return null;
  return sorted[Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * fraction))];
}

function waitForVideoMetadata(video) {
  if (video.readyState >= 1 && Number.isFinite(video.duration)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const handleReady = () => {
      cleanup();
      resolve();
    };
    const handleError = () => {
      cleanup();
      reject(new Error("The local video could not be prepared for analysis."));
    };
    const cleanup = () => {
      video.removeEventListener("loadedmetadata", handleReady);
      video.removeEventListener("error", handleError);
    };
    video.addEventListener("loadedmetadata", handleReady);
    video.addEventListener("error", handleError);
  });
}

function waitForVideoPixels(video) {
  if (video.readyState >= 2 && video.videoWidth > 0 && video.videoHeight > 0) {
    return new Promise((resolve) => window.requestAnimationFrame(() => resolve()));
  }
  return new Promise((resolve, reject) => {
    const handleReady = () => {
      if (video.videoWidth <= 0 || video.videoHeight <= 0) return;
      cleanup();
      window.requestAnimationFrame(() => resolve());
    };
    const handleError = () => {
      cleanup();
      reject(new Error("The local video frame could not be decoded for preview."));
    };
    const cleanup = () => {
      video.removeEventListener("loadeddata", handleReady);
      video.removeEventListener("canplay", handleReady);
      video.removeEventListener("error", handleError);
    };
    video.addEventListener("loadeddata", handleReady);
    video.addEventListener("canplay", handleReady);
    video.addEventListener("error", handleError);
  });
}

function seekVideo(video, timeS) {
  if (Math.abs(video.currentTime - timeS) < 0.02) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      window.clearTimeout(timeoutId);
      video.removeEventListener("seeked", finish);
      resolve();
    };
    const timeoutId = window.setTimeout(finish, 5000);
    video.addEventListener("seeked", finish);
    video.currentTime = timeS;
  });
}

function landmarkVisible(landmark) {
  return landmark && (landmark.visibility == null || landmark.visibility >= 0.35);
}

function extractLegSides(result) {
  const landmarks = result?.landmarks?.[0];
  if (!landmarks) return null;
  const getPoints = (indices) => indices
    .map((index) => landmarks[index])
    .filter(landmarkVisible)
    .map(({ x, y }) => ({ x, y }));
  const left = getPoints(LEFT_LEG_POINTS);
  const right = getPoints(RIGHT_LEG_POINTS);
  return {
    left: left.length >= 2 ? left : null,
    right: right.length >= 2 ? right : null,
  };
}

function extractRegionLeg(result) {
  const landmarks = result?.landmarks?.[0];
  if (!landmarks) return null;
  const sideCandidates = [LEFT_LEG_POINTS, RIGHT_LEG_POINTS]
    .map((indices) => ({
      indices,
      points: indices
        .map((index) => landmarks[index])
        .filter(landmarkVisible)
        .map(({ x, y }) => ({ x, y })),
    }))
    .sort((a, b) => b.points.length - a.points.length);
  return sideCandidates[0]?.points.length >= 2 ? sideCandidates[0] : null;
}

function extractHands(result) {
  if (!result?.landmarks?.length) return null;
  return result.landmarks.map((landmarks, index) => {
    const category = result.handedness?.[index]?.[0]?.categoryName || `hand-${index}`;
    const points = [0, 5, 9, 13, 17].map((landmarkIndex) => landmarks[landmarkIndex]);
    return { key: category, points };
  });
}

function mapLandmarkToFrame(landmark, roi) {
  if (!landmark) return null;
  return {
    ...landmark,
    x: roi.x + (landmark.x * roi.width),
    y: roi.y + (landmark.y * roi.height),
  };
}

function drawLandmarkPoint(context, landmark, roi, width, height, color, radius = 4) {
  if (!landmarkVisible(landmark)) return;
  const point = mapLandmarkToFrame(landmark, roi);
  context.beginPath();
  context.fillStyle = color;
  context.arc(point.x * width, point.y * height, radius, 0, Math.PI * 2);
  context.fill();
}

function drawLandmarkConnection(context, points, from, to, roi, width, height, color) {
  const start = points?.[from];
  const end = points?.[to];
  if (!landmarkVisible(start) || !landmarkVisible(end)) return;
  const mappedStart = mapLandmarkToFrame(start, roi);
  const mappedEnd = mapLandmarkToFrame(end, roi);
  context.beginPath();
  context.strokeStyle = color;
  context.lineWidth = 3;
  context.moveTo(mappedStart.x * width, mappedStart.y * height);
  context.lineTo(mappedEnd.x * width, mappedEnd.y * height);
  context.stroke();
}

function drawRegionLegOverlay(context, leg, roi, width, height, color) {
  if (!leg?.points?.length) return;
  leg.points.forEach((point, index) => {
    if (index > 0) {
      const prior = leg.points[index - 1];
      context.beginPath();
      context.strokeStyle = color;
      context.lineWidth = 3;
      context.moveTo((roi.x + prior.x * roi.width) * width, (roi.y + prior.y * roi.height) * height);
      context.lineTo((roi.x + point.x * roi.width) * width, (roi.y + point.y * roi.height) * height);
      context.stroke();
    }
    drawLandmarkPoint(context, point, roi, width, height, color, 5);
  });
}

function drawSignalRegion(context, roi, width, height, color, label) {
  context.strokeStyle = color;
  context.lineWidth = 2;
  context.strokeRect(roi.x * width, roi.y * height, roi.width * width, roi.height * height);
  context.fillStyle = color;
  context.font = "bold 12px sans-serif";
  context.fillText(label, (roi.x * width) + 6, (roi.y * height) + 16);
}

function drawPreviewFrame(canvas, video, legPreview, handResult, showLegs, showHands, rois, orientation) {
  const width = video.videoWidth || 0;
  const height = video.videoHeight || 0;
  if (!canvas || !width || !height) return false;
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext("2d");
  if (!context) return false;
  context.drawImage(video, 0, 0, width, height);

  const posePoints = legPreview?.fullResult?.landmarks?.[0];
  if (showLegs && legPreview?.regionMotion) {
    drawSignalRegion(context, rois.leftLowerBody, width, height, "#20d3c2", `Your left foot (${anatomicalScreenSide(orientation, "left")})`);
    drawSignalRegion(context, rois.rightLowerBody, width, height, "#f59e0b", `Your right foot (${anatomicalScreenSide(orientation, "right")})`);
    if (legPreview.forefootEnabled) {
      drawSignalRegion(context, rois.leftForefoot, width, height, "#2dd4bf", "Left forefoot");
      drawSignalRegion(context, rois.rightForefoot, width, height, "#fb923c", "Right forefoot");
    }
  } else if (showLegs && posePoints) {
    LEG_CONNECTIONS.forEach(([from, to]) => {
      const color = LEFT_LEG_POINTS.includes(from) ? "#20d3c2" : "#f59e0b";
      drawLandmarkConnection(context, posePoints, from, to, rois.leftLowerBody, width, height, color);
    });
    LEFT_LEG_POINTS.forEach((index) => drawLandmarkPoint(context, posePoints[index], rois.leftLowerBody, width, height, "#20d3c2", 5));
    RIGHT_LEG_POINTS.forEach((index) => drawLandmarkPoint(context, posePoints[index], rois.rightLowerBody, width, height, "#f59e0b", 5));
  } else if (showLegs) {
    drawRegionLegOverlay(context, legPreview?.left, rois.leftLowerBody, width, height, "#20d3c2");
    drawRegionLegOverlay(context, legPreview?.right, rois.rightLowerBody, width, height, "#f59e0b");
  }

  if (showHands) {
    (handResult?.landmarks || []).forEach((handPoints) => {
      HAND_CONNECTIONS.forEach(([from, to]) => {
        drawLandmarkConnection(context, handPoints, from, to, rois.hands, width, height, "#a78bfa");
      });
      handPoints.forEach((point) => drawLandmarkPoint(context, point, rois.hands, width, height, "#c4b5fd", 3));
    });
  }
  return true;
}

function drawVideoCrop(video, roi, canvas) {
  const sourceWidth = video.videoWidth || 0;
  const sourceHeight = video.videoHeight || 0;
  if (!sourceWidth || !sourceHeight) return video;
  const width = Math.max(2, Math.round(sourceWidth * roi.width));
  const height = Math.max(2, Math.round(sourceHeight * roi.height));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const context = canvas.getContext("2d");
  if (!context) return video;
  context.drawImage(
    video,
    roi.x * sourceWidth,
    roi.y * sourceHeight,
    roi.width * sourceWidth,
    roi.height * sourceHeight,
    0,
    0,
    width,
    height,
  );
  return canvas;
}

function readRoiGrayscale(video, roi, canvas) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context || !video.videoWidth || !video.videoHeight) return null;
  const width = 48;
  const height = Math.max(16, Math.min(72, Math.round(width * ((roi.height * video.videoHeight) / (roi.width * video.videoWidth)))));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  context.drawImage(
    video,
    roi.x * video.videoWidth,
    roi.y * video.videoHeight,
    roi.width * video.videoWidth,
    roi.height * video.videoHeight,
    0,
    0,
    width,
    height,
  );
  const image = context.getImageData(0, 0, width, height).data;
  const grayscale = new Float32Array(width * height);
  for (let index = 0, pixel = 0; index < image.length; index += 4, pixel += 1) {
    grayscale[pixel] = (image[index] * 0.299) + (image[index + 1] * 0.587) + (image[index + 2] * 0.114);
  }
  return grayscale;
}

function regionPixelMotion(current, previous) {
  if (!current || !previous || current.length !== previous.length) return null;
  let total = 0;
  for (let index = 0; index < current.length; index += 1) {
    total += Math.abs(current[index] - previous[index]);
  }
  return total / (current.length * 255);
}
function detectReflectiveMarkerPoints(video, roi, canvas) {
  const context = canvas.getContext("2d", { willReadFrequently: true });
  if (!context || !video.videoWidth || !video.videoHeight || !roi) return [];
  const width = 72;
  const height = Math.max(20, Math.min(96, Math.round(width * ((roi.height * video.videoHeight) / (roi.width * video.videoWidth)))));
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  context.drawImage(
    video,
    roi.x * video.videoWidth,
    roi.y * video.videoHeight,
    roi.width * video.videoWidth,
    roi.height * video.videoHeight,
    0,
    0,
    width,
    height,
  );
  const image = context.getImageData(0, 0, width, height).data;
  const luminance = new Float32Array(width * height);
  for (let index = 0, pixel = 0; index < image.length; index += 4, pixel += 1) {
    luminance[pixel] = (image[index] * 0.299) + (image[index + 1] * 0.587) + (image[index + 2] * 0.114);
  }

  const brightThreshold = Math.max(205, percentile(Array.from(luminance), 0.985) || 230);
  const active = new Uint8Array(width * height);
  for (let index = 0; index < luminance.length; index += 1) {
    active[index] = luminance[index] >= brightThreshold ? 1 : 0;
  }

  const visited = new Uint8Array(width * height);
  const components = [];
  for (let start = 0; start < active.length; start += 1) {
    if (!active[start] || visited[start]) continue;
    const stack = [start];
    visited[start] = 1;
    let count = 0;
    let weightedX = 0;
    let weightedY = 0;
    let totalWeight = 0;
    let peak = 0;

    while (stack.length) {
      const pixel = stack.pop();
      const x = pixel % width;
      const y = Math.floor(pixel / width);
      const value = luminance[pixel];
      const weight = Math.max(1, value - brightThreshold + 1);
      count += 1;
      weightedX += x * weight;
      weightedY += y * weight;
      totalWeight += weight;
      peak = Math.max(peak, value);

      [pixel - 1, pixel + 1, pixel - width, pixel + width].forEach((neighbor) => {
        if (neighbor < 0 || neighbor >= active.length || visited[neighbor] || !active[neighbor]) return;
        const neighborX = neighbor % width;
        if (Math.abs(neighborX - x) > 1) return;
        visited[neighbor] = 1;
        stack.push(neighbor);
      });
    }

    if (count >= 2 && count <= Math.max(80, width * height * 0.08) && totalWeight > 0) {
      components.push({
        x: roi.x + ((weightedX / totalWeight) / Math.max(1, width - 1)) * roi.width,
        y: roi.y + ((weightedY / totalWeight) / Math.max(1, height - 1)) * roi.height,
        area: count,
        peak,
        score: peak + Math.min(60, count * 3),
      });
    }
  }

  return components
    .sort((first, second) => second.score - first.score)
    .filter((component, index, all) => (
      all.slice(0, index).every((prior) => pointDistance(component, prior) > 0.018)
    ))
    .slice(0, 3)
    .map(({ x, y, area, peak }) => ({
      x: Math.round(x * 1000) / 1000,
      y: Math.round(y * 1000) / 1000,
      area,
      peak: Math.round(peak),
    }));
}

function markerTripletToFootPoints(points) {
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

function averageGeometryValue(frames, key) {
  return Math.round((mean(frames.map((frame) => Number(frame[key]))) || 0) * 1000) / 1000;
}

function geometryRange(frames, key) {
  const values = frames.map((frame) => Number(frame[key])).filter(Number.isFinite);
  if (!values.length) return null;
  return {
    min: Math.round(Math.min(...values) * 1000) / 1000,
    max: Math.round(Math.max(...values) * 1000) / 1000,
  };
}

function buildFootGeometryTrackingSummary(samples, sampleRate) {
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

  const stride = Math.max(1, Math.ceil(frames.length / 600));
  const timeline = frames.filter((_, index) => index % stride === 0 || index === frames.length - 1);

  return {
    status: coveragePct >= 55 ? "marker_tracking_available" : "limited_marker_tracking",
    method: "marker_assisted_foot_geometry_timeline",
    coverage_pct: coveragePct,
    sample_count: frames.length,
    sample_rate_fps: sampleRate,
    average_fan_angle_deg: averageGeometryValue(frames, "fan_angle_deg"),
    average_toe_gap_normalized: averageGeometryValue(frames, "toe_gap_normalized"),
    average_heel_gap_normalized: averageGeometryValue(frames, "heel_gap_normalized"),
    fan_angle_range_deg: geometryRange(frames, "fan_angle_deg"),
    toe_gap_range_normalized: geometryRange(frames, "toe_gap_normalized"),
    heel_gap_range_normalized: geometryRange(frames, "heel_gap_normalized"),
    interpretation_hint: "Use this as continuous observational foot-position trend support. Describe how foot spread, fanning, heel separation, toe gap, foot-axis symmetry, and planted/neutral posture change over time rather than treating one saved frame as whole-session truth.",
    method_note: "Experimental marker-assisted tracking from bright reflective dots in the foot ROIs. Requires stable lighting and three visible markers per foot. Confirm important moments against video.",
    timeline,
  };
}

function appearanceSignature(pixels) {
  if (!pixels?.length) return null;
  const bins = 96;
  const binSize = Math.max(1, Math.floor(pixels.length / bins));
  const values = Array.from({ length: bins }, (_, index) => {
    const start = index * binSize;
    const end = index === bins - 1 ? pixels.length : Math.min(pixels.length, start + binSize);
    let total = 0;
    for (let pixel = start; pixel < end; pixel += 1) total += pixels[pixel];
    return total / Math.max(1, end - start);
  });
  const center = mean(values) || 0;
  const deviation = Math.sqrt(mean(values.map((value) => (value - center) ** 2)) || 1);
  return values.map((value) => Math.round(((value - center) / deviation) * 1000) / 1000);
}

function appearanceDistance(first, second) {
  if (!first || !second || first.length !== second.length) return Infinity;
  return mean(first.map((value, index) => Math.abs(value - second[index]))) ?? Infinity;
}

function sideMotion(current, previous) {
  if (!current || !previous) return null;
  return mean(current.map((point, index) => pointDistance(point, previous[index])));
}

function handMotion(current, previous) {
  if (!current || !previous) return null;
  const movements = current.map((hand) => {
    const prior = previous.find((candidate) => candidate.key === hand.key);
    if (!prior) return null;
    return mean(hand.points.map((point, index) => pointDistance(point, prior.points[index])));
  });
  return mean(movements);
}

function handCentroid(hand) {
  if (!hand?.points?.length) return null;
  return {
    x: mean(hand.points.map((point) => point.x)),
    y: mean(hand.points.map((point) => point.y)),
  };
}

function dominantHandVector(current, previous) {
  if (!current || !previous) return null;
  return current
    .map((hand) => {
      const prior = previous.find((candidate) => candidate.key === hand.key);
      const from = handCentroid(prior);
      const to = handCentroid(hand);
      if (!from || !to) return null;
      const dx = to.x - from.x;
      const dy = to.y - from.y;
      return { key: hand.key, dx, dy, magnitude: Math.hypot(dx, dy) };
    })
    .filter(Boolean)
    .sort((a, b) => b.magnitude - a.magnitude)[0] || null;
}

function normalizeSingleSamples(rawSamples) {
  const reference = percentile(rawSamples.map((sample) => sample.motion), 0.95) || 0;
  return rawSamples.map((sample) => ({
    ...sample,
    score: reference > 0 && sample.motion != null
      ? Math.round(clamp((sample.motion / reference) * 100, 0, 100))
      : 0,
  }));
}

function normalizedScore(value, reference) {
  return reference > 0 && value != null
    ? Math.round(clamp((value / reference) * 100, 0, 100))
    : 0;
}

function normalizeTrackedSamples(rawSamples, includeHands) {
  const lowerBodyReference = percentile(rawSamples.flatMap((sample) => [sample.leftMotion, sample.rightMotion]), 0.95) || 0;
  const forefootReference = percentile(rawSamples.flatMap((sample) => [sample.leftForefootMotion, sample.rightForefootMotion]), 0.95) || 0;
  const handReference = percentile(rawSamples.map((sample) => sample.handMotion), 0.95) || 0;
  return rawSamples.map((sample) => {
    const leftScore = normalizedScore(sample.leftMotion, lowerBodyReference);
    const rightScore = normalizedScore(sample.rightMotion, lowerBodyReference);
    const leftForefootScore = sample.leftForefootMotion == null ? null : normalizedScore(sample.leftForefootMotion, forefootReference);
    const rightForefootScore = sample.rightForefootMotion == null ? null : normalizedScore(sample.rightForefootMotion, forefootReference);
    const legScore = Math.max(leftScore, rightScore);
    const handScore = includeHands ? normalizedScore(sample.handMotion, handReference) : null;
    return { ...sample, leftScore, rightScore, leftForefootScore, rightForefootScore, legScore, handScore, score: Math.max(legScore, handScore || 0) };
  });
}

function averageScore(samples, key) {
  return Math.round(mean(samples.map((sample) => sample[key])) || 0);
}

function qualityFromCoverage(coverage) {
  if (coverage == null) return null;
  if (coverage >= 75) return { level: "strong", label: "Strong", color: "text-emerald-400 border-emerald-400/30 bg-emerald-400/10" };
  if (coverage >= 50) return { level: "moderate", label: "Moderate", color: "text-amber-400 border-amber-400/30 bg-amber-400/10" };
  return { level: "limited", label: "Limited", color: "text-rose-400 border-rose-400/30 bg-rose-400/10" };
}

function calculateAsymmetry(samples) {
  const activePaired = samples
    .filter((sample) => (
      sample.leftDetected
      && sample.rightDetected
      && (sample.leftScore + sample.rightScore) >= 10
    ))
    .map((sample) => ({
      ...sample,
      asymmetry: (sample.leftScore - sample.rightScore) / (sample.leftScore + sample.rightScore),
    }));
  if (!activePaired.length) return null;
  const meanIndex = mean(activePaired.map((sample) => sample.asymmetry));
  const peak = [...activePaired].sort((a, b) => Math.abs(b.asymmetry) - Math.abs(a.asymmetry))[0];
  const leftWindows = activePaired.filter((sample) => sample.asymmetry > 0.1).length;
  const rightWindows = activePaired.filter((sample) => sample.asymmetry < -0.1).length;
  const balancedWindows = activePaired.length - leftWindows - rightWindows;
  const predominantWindows = Math.max(leftWindows, rightWindows);
  const directionalPct = Math.round((predominantWindows / activePaired.length) * 100);
  const predominantSide = directionalPct >= 55
    ? (leftWindows > rightWindows ? "left" : rightWindows > leftWindows ? "right" : "balanced")
    : "balanced";
  return {
    averageIndex: Math.round(meanIndex * 100) / 100,
    peakIndex: Math.round(peak.asymmetry * 100) / 100,
    peakTimeS: Math.round(peak.timeS * 10) / 10,
    comparedWindows: activePaired.length,
    predominantSide,
    predominantPct: directionalPct,
    leftBiasedPct: Math.round((leftWindows / activePaired.length) * 100),
    rightBiasedPct: Math.round((rightWindows / activePaired.length) * 100),
    balancedPct: Math.round((balancedWindows / activePaired.length) * 100),
  };
}

function segmentDuration(points, stepS) {
  if (!points.length) return 0;
  return points[points.length - 1].timeS - points[0].timeS + stepS;
}

function collectMotionSegments(points, predicate, sampleRate, minimumDurationS, mergeGapS = 0.5) {
  const stepS = 1 / sampleRate;
  const rawSegments = [];
  let current = [];
  points.forEach((point) => {
    if (predicate(point)) {
      current.push(point);
      return;
    }
    if (current.length) rawSegments.push(current);
    current = [];
  });
  if (current.length) rawSegments.push(current);

  const merged = rawSegments.reduce((segments, segment) => {
    const prior = segments[segments.length - 1];
    const gapS = prior
      ? segment[0].timeS - prior[prior.length - 1].timeS - stepS
      : Infinity;
    if (prior && gapS <= mergeGapS) {
      prior.push(...segment);
    } else {
      segments.push([...segment]);
    }
    return segments;
  }, []);
  return merged.filter((segment) => segmentDuration(segment, stepS) >= minimumDurationS);
}

function compactPatternCandidate(segment, type, label, stepS, extra = {}) {
  const peak = [...segment].sort((a, b) => b.combined - a.combined)[0];
  return {
    type,
    label,
    time_s: Math.round(peak.timeS * 10) / 10,
    start_time_s: Math.round(segment[0].timeS * 10) / 10,
    duration_s: Math.round(segmentDuration(segment, stepS) * 10) / 10,
    peak_activity: Math.round(peak.combined),
    ...extra,
  };
}

function orderedTopCandidates(candidates, maximum = 8) {
  return [...candidates]
    .sort((a, b) => b.peak_activity - a.peak_activity)
    .slice(0, maximum)
    .sort((a, b) => a.time_s - b.time_s);
}

function calculateLowerBodyPatternSummary(samples, sampleRate) {
  if (!samples.length || sampleRate < 4) return null;
  const points = samples
    .filter((sample) => sample.leftDetected || sample.rightDetected || sample.regionBoundary)
    .map((sample) => {
      const left = Number(sample.leftScore) || 0;
      const right = Number(sample.rightScore) || 0;
      return {
        timeS: sample.timeS,
        left,
        right,
        combined: Math.max(left, right),
        divergence: Math.abs(left - right),
        regionBoundary: Boolean(sample.regionBoundary),
      };
    });
  if (points.length < sampleRate * 2) return null;

  const stepS = 1 / sampleRate;
  const burstSegments = collectMotionSegments(points, (point) => point.combined >= 65, sampleRate, 0.35, 0.35);
  const baselineActivity = percentile(points.map((point) => point.combined), 0.5) || 0;
  const sustainedThreshold = Math.max(30, baselineActivity + 20);
  const sustainedSegments = collectMotionSegments(
    points,
    (point) => point.combined >= sustainedThreshold,
    sampleRate,
    3,
    0.5,
  );
  const divergenceSegments = collectMotionSegments(
    points,
    (point) => point.combined >= 40 && point.divergence >= 35,
    sampleRate,
    0.75,
    0.35,
  );

  const localPeaks = points.filter((point, index) => (
    point.combined >= 35
    && point.combined >= (points[index - 1]?.combined ?? -1)
    && point.combined > (points[index + 1]?.combined ?? -1)
  ));
  const boundaryTimes = points.filter((point) => point.regionBoundary).map((point) => point.timeS);
  const peakGroups = localPeaks.reduce((groups, peak) => {
    const prior = groups[groups.length - 1];
    const previousPeakTime = prior?.[prior.length - 1]?.timeS;
    const crossesRegionBoundary = boundaryTimes.some((timeS) => timeS > previousPeakTime && timeS <= peak.timeS);
    if (prior && peak.timeS - previousPeakTime <= 1.25 && !crossesRegionBoundary) {
      prior.push(peak);
    } else {
      groups.push([peak]);
    }
    return groups;
  }, []);
  const oscillatoryCandidates = peakGroups
    .filter((group) => group.length >= 3 && segmentDuration(group, stepS) <= 4)
    .map((group) => compactPatternCandidate(
      group,
      "oscillatory_candidate",
      "Rapid shudder-like lower-body activity",
      stepS,
      { repeated_peaks: group.length },
    ));

  const burstCandidates = orderedTopCandidates(burstSegments.map((segment) => compactPatternCandidate(
    segment,
    "movement_burst",
    "Brief lower-body movement burst",
    stepS,
  )));
  const sustainedCandidates = orderedTopCandidates(sustainedSegments.map((segment) => compactPatternCandidate(
    segment,
    "sustained_activity_shift",
    "Sustained lower-body activity",
    stepS,
  )));
  const divergenceCandidates = orderedTopCandidates(divergenceSegments.map((segment) => {
    const leftAverage = mean(segment.map((point) => point.left)) || 0;
    const rightAverage = mean(segment.map((point) => point.right)) || 0;
    return compactPatternCandidate(
      segment,
      "left_right_divergence",
      "Lower-body side divergence",
      stepS,
      { predominant_side: leftAverage >= rightAverage ? "left" : "right" },
    );
  }));
  const storedOscillatoryCandidates = orderedTopCandidates(oscillatoryCandidates);

  return {
    method: "normalized_lower_body_region_activity",
    method_note: "Derived from normalized lower-body activity traces. These are observational review candidates, not confirmed spasms, posture direction, intent, or physiological cause.",
    movement_burst_count: burstSegments.length,
    oscillatory_candidate_count: oscillatoryCandidates.length,
    sustained_activity_shift_count: sustainedSegments.length,
    left_right_divergence_count: divergenceSegments.length,
    burst_candidates: burstCandidates,
    oscillatory_candidates: storedOscillatoryCandidates,
    sustained_activity_shift_candidates: sustainedCandidates,
    divergence_candidates: divergenceCandidates,
  };
}

function nearestAppearanceSample(samples, timeS, toleranceS) {
  if (!Number.isFinite(Number(timeS))) return null;
  const candidates = samples.filter((sample) => sample.leftAppearance || sample.rightAppearance);
  if (!candidates.length) return null;
  const nearest = candidates.reduce((closest, sample) => (
    Math.abs(sample.timeS - timeS) < Math.abs(closest.timeS - timeS) ? sample : closest
  ), candidates[0]);
  return Math.abs(nearest.timeS - timeS) <= toleranceS ? nearest : null;
}

function pairedAppearanceDistance(sample, reference) {
  const distances = [
    appearanceDistance(sample.leftAppearance, reference.leftAppearance),
    appearanceDistance(sample.rightAppearance, reference.rightAppearance),
  ].filter((value) => Number.isFinite(value));
  return mean(distances) ?? Infinity;
}

function postureConfidence(matchDistance, stabilitySpread, coveragePct, supportingFrames) {
  if (Number.isFinite(matchDistance) && matchDistance <= 0.36 && stabilitySpread <= 0.14 && coveragePct >= 65 && supportingFrames >= 4) {
    return "moderate";
  }
  if (Number.isFinite(matchDistance) && matchDistance <= 0.5 && stabilitySpread <= 0.24 && coveragePct >= 35 && supportingFrames >= 3) {
    return "low";
  }
  return "weak";
}

function buildPostureAppearanceSummary(samples, referenceTimes, sampleRate) {
  const appearanceSamples = samples.filter((sample) => sample.leftAppearance || sample.rightAppearance);
  if (!appearanceSamples.length) {
    return {
      method: "calibrated_region_image_appearance",
      coverage_pct: 0,
      status: "insufficient_appearance",
      method_note: "No local foot-region appearance samples were available for calibrated matching.",
      posture_candidates: [],
    };
  }
  const toleranceS = Math.max(1, 2 / sampleRate);
  const references = Object.fromEntries(POSTURE_REFERENCE_OPTIONS.map(({ key }) => {
    const sample = nearestAppearanceSample(appearanceSamples, referenceTimes[key], toleranceS);
    return [key, sample || null];
  }));
  const neutral = references.neutral;
  const exemplarKeys = POSTURE_REFERENCE_OPTIONS
    .map(({ key }) => key)
    .filter((key) => key !== "neutral" && references[key]);
  const coveragePct = Math.round((appearanceSamples.length / samples.length) * 100);
  if (!neutral || !exemplarKeys.length) {
    return {
      method: "calibrated_region_image_appearance",
      coverage_pct: coveragePct,
      status: "references_needed",
      calibrated_references: Object.fromEntries(POSTURE_REFERENCE_OPTIONS.map(({ key }) => [key, !!references[key]])),
      method_note: "Foot-region appearance samples were captured, but neutral plus at least one named posture reference inside the analyzed window is needed for matching.",
      posture_candidates: [],
    };
  }

  const classified = appearanceSamples.map((sample) => {
    const neutralDistance = pairedAppearanceDistance(sample, neutral);
    const match = exemplarKeys
      .map((key) => ({ key, distance: pairedAppearanceDistance(sample, references[key]) }))
      .sort((a, b) => a.distance - b.distance)[0];
    const posture = match && match.distance <= 0.62 && match.distance + 0.05 < neutralDistance ? match.key : null;
    return { ...sample, posture, confidenceScore: match?.distance };
  });
  const segments = [];
  let current = [];
  classified.forEach((sample) => {
    if (sample.posture && (!current.length || current[0].posture === sample.posture)) {
      current.push(sample);
      return;
    }
    if (current.length) segments.push(current);
    current = sample.posture ? [sample] : [];
  });
  if (current.length) segments.push(current);
  const stepS = 1 / sampleRate;
  const postureCandidates = segments
    .filter((segment) => segmentDuration(segment, stepS) >= 0.75)
    .map((segment) => {
      const posture = segment[0].posture;
      const meta = POSTURE_REFERENCE_OPTIONS.find((option) => option.key === posture);
      const matchDistances = segment.map((sample) => sample.confidenceScore).filter(Number.isFinite);
      const matchDistance = mean(matchDistances);
      const stabilitySpread = matchDistances.length
        ? Math.max(...matchDistances) - Math.min(...matchDistances)
        : Infinity;
      return {
        type: "calibrated_posture_candidate",
        posture,
        posture_phrase: meta?.phrase || posture,
        time_s: Math.round(segment[0].timeS * 10) / 10,
        start_time_s: Math.round(segment[0].timeS * 10) / 10,
        duration_s: Math.round(segmentDuration(segment, stepS) * 10) / 10,
        confidence: postureConfidence(matchDistance, stabilitySpread, coveragePct, segment.length),
        match_distance: Number.isFinite(matchDistance) ? Math.round(matchDistance * 100) / 100 : undefined,
        stability_spread: Number.isFinite(stabilitySpread) ? Math.round(stabilitySpread * 100) / 100 : undefined,
        supporting_frames: segment.length,
      };
    })
    .slice(0, 16);
  return {
    method: "calibrated_region_image_appearance",
    coverage_pct: coveragePct,
    status: "calibrated_matching_available",
    calibrated_references: Object.fromEntries(POSTURE_REFERENCE_OPTIONS.map(({ key }) => [key, !!references[key]])),
    method_note: "Matches compact left/right foot-region image appearance against user-marked reference moments. Images and frame signatures are used transiently during local analysis and are not stored; labels remain visual posture proxies.",
    posture_candidates: postureCandidates,
  };
}

function calculateHandRhythmSummary(samples, scoreKey, handCoverage, sampleRate) {
  if (!samples.length || handCoverage < 65 || sampleRate < 6) {
    return {
      reliability: "insufficient",
      reason: handCoverage < 65
        ? "Hand visibility coverage was below the threshold required for cadence estimation."
        : "The sampling rate was too low for cadence estimation.",
    };
  }

  const detected = samples
    .filter((sample) => sample.handsDetected || (!("handsDetected" in sample) && sample.detected))
    .map((sample) => ({ timeS: sample.timeS, score: Number(sample[scoreKey]) || 0 }));
  if (detected.length < sampleRate * 8) {
    return {
      reliability: "insufficient",
      reason: "Not enough continuously visible hand movement was available for cadence estimation.",
    };
  }

  const smoothed = detected.map((sample, index) => ({
    ...sample,
    score: mean(detected.slice(Math.max(0, index - 1), Math.min(detected.length, index + 2)).map((point) => point.score)) || 0,
  }));
  const activeThreshold = 22;
  const peakThreshold = 35;
  const minimumPeakSpacingS = 0.45;
  const peaks = [];
  smoothed.forEach((sample, index) => {
    if (
      sample.score >= peakThreshold
      && sample.score >= (smoothed[index - 1]?.score ?? -1)
      && sample.score > (smoothed[index + 1]?.score ?? -1)
      && (!peaks.length || sample.timeS - peaks[peaks.length - 1].timeS >= minimumPeakSpacingS)
    ) {
      peaks.push(sample);
    }
  });

  const intervals = peaks
    .slice(1)
    .map((sample, index) => sample.timeS - peaks[index].timeS)
    .filter((duration) => duration >= minimumPeakSpacingS && duration <= 3);
  const cadence = intervals.length >= 3 ? Math.round(60 / (mean(intervals) || 1)) : null;
  let pauseStart = null;
  let pauseCount = 0;
  let pausedSeconds = 0;
  smoothed.forEach((sample, index) => {
    const inactive = sample.score < activeThreshold;
    if (inactive && pauseStart == null) pauseStart = sample.timeS;
    if ((!inactive || index === smoothed.length - 1) && pauseStart != null) {
      const end = inactive ? sample.timeS : (smoothed[index - 1]?.timeS ?? sample.timeS);
      const duration = end - pauseStart;
      if (duration >= 2) {
        pauseCount += 1;
        pausedSeconds += duration;
      }
      pauseStart = null;
    }
  });

  return {
    reliability: cadence != null && peaks.length >= 4 ? "moderate" : "limited",
    movement_cycles_per_minute_estimate: cadence,
    detected_cycle_peaks: peaks.length,
    pause_count: pauseCount,
    paused_time_s: Math.round(pausedSeconds),
    active_time_pct: Math.round((smoothed.filter((sample) => sample.score >= activeThreshold).length / smoothed.length) * 100),
    method_note: "Estimated from normalized repeated hand-movement oscillations; this is an observational cadence proxy, not confirmed stroke speed.",
  };
}

function axisAngleDistance(first, second) {
  if (!Number.isFinite(first) || !Number.isFinite(second)) return 1;
  const difference = Math.abs(first - second) % Math.PI;
  return Math.min(difference, Math.PI - difference) / (Math.PI / 2);
}

function handWindowFeatures(samples, scoreKey, sampleRate, startTimeS, endTimeS) {
  const points = samples.filter((sample) => (
    sample.timeS >= startTimeS
    && sample.timeS <= endTimeS
    && sample.handsDetected
    && Number.isFinite(sample.handDx)
    && Number.isFinite(sample.handDy)
  ));
  if (points.length < Math.max(4, Math.round(sampleRate * 0.75))) return null;
  const xx = mean(points.map((point) => point.handDx ** 2)) || 0;
  const yy = mean(points.map((point) => point.handDy ** 2)) || 0;
  const xy = mean(points.map((point) => point.handDx * point.handDy)) || 0;
  const axisAngleRad = 0.5 * Math.atan2(2 * xy, xx - yy);
  const axis = { x: Math.cos(axisAngleRad), y: Math.sin(axisAngleRad) };
  const projections = points.map((point) => (
    (point.handDx * axis.x) + (point.handDy * axis.y)
  ));
  const perpendicular = points.map((point) => (
    (-point.handDx * axis.y) + (point.handDy * axis.x)
  ));
  const axisTravel = projections.reduce((total, value) => total + Math.abs(value), 0);
  const crossTravel = perpendicular.reduce((total, value) => total + Math.abs(value), 0);
  const meaningfulDirections = projections.filter((value) => Math.abs(value) >= 0.001);
  const reversals = meaningfulDirections.slice(1).filter((value, index) => (
    Math.sign(value) !== Math.sign(meaningfulDirections[index])
  )).length;
  const durationS = Math.max(0.5, endTimeS - startTimeS);
  const scores = points.map((point) => Number(point[scoreKey]) || 0);
  return {
    axis_angle_rad: axisAngleRad,
    axis_alignment: axisTravel / Math.max(0.0001, axisTravel + crossTravel),
    reversal_rate_hz: reversals / durationS,
    mean_activity: mean(scores) || 0,
    peak_activity: Math.max(...scores),
    active_pct: Math.round((scores.filter((score) => score >= 22).length / scores.length) * 100),
    supporting_samples: points.length,
  };
}

function handBehaviorDistance(candidate, reference) {
  if (!candidate || !reference) return Infinity;
  return (
    axisAngleDistance(candidate.axis_angle_rad, reference.axis_angle_rad) * 0.28
    + Math.abs(candidate.axis_alignment - reference.axis_alignment) * 0.22
    + Math.min(1, Math.abs(candidate.reversal_rate_hz - reference.reversal_rate_hz) / 3) * 0.24
    + Math.min(1, Math.abs(candidate.mean_activity - reference.mean_activity) / 100) * 0.14
    + Math.min(1, Math.abs(candidate.active_pct - reference.active_pct) / 100) * 0.12
  );
}

function handBehaviorConfidence(matchDistance, separation, supportingWindows) {
  if (matchDistance <= 0.28 && separation >= 0.18 && supportingWindows >= 2) return "moderate";
  if (matchDistance <= 0.45 && separation >= 0.08) return "low";
  return "weak";
}

function buildHandBehaviorSummary(samples, scoreKey, handCoverage, sampleRate, referenceTimes) {
  if (!samples.length || handCoverage < 65 || sampleRate < 6) {
    return {
      status: "insufficient_tracking",
      method: "calibrated_directional_hand_motion",
      method_note: "Hand visibility or sampling rate was insufficient for calibrated hand-behavior comparison.",
      stroke_like_windows: [],
    };
  }
  const referenceRadiusS = 1.5;
  const strokeReference = Number.isFinite(referenceTimes.stroke_like)
    ? handWindowFeatures(samples, scoreKey, sampleRate, referenceTimes.stroke_like - referenceRadiusS, referenceTimes.stroke_like + referenceRadiusS)
    : null;
  const nonStrokeReference = Number.isFinite(referenceTimes.non_stroke)
    ? handWindowFeatures(samples, scoreKey, sampleRate, referenceTimes.non_stroke - referenceRadiusS, referenceTimes.non_stroke + referenceRadiusS)
    : null;
  if (!strokeReference || !nonStrokeReference) {
    return {
      status: "references_needed",
      method: "calibrated_directional_hand_motion",
      calibrated_references: {
        stroke_like: !!strokeReference,
        non_stroke: !!nonStrokeReference,
      },
      method_note: "Mark one clear rhythmic stroke-like example and one visible non-stroke or adjustment example in the recorded video, then analyze a window containing both.",
      stroke_like_windows: [],
    };
  }

  const classifiedWindows = [];
  for (let center = samples[0].timeS + 1; center <= samples[samples.length - 1].timeS - 1; center += 1) {
    const features = handWindowFeatures(samples, scoreKey, sampleRate, center - 1, center + 1);
    if (!features || features.active_pct < 25) continue;
    const strokeDistance = handBehaviorDistance(features, strokeReference);
    const nonStrokeDistance = handBehaviorDistance(features, nonStrokeReference);
    const separation = nonStrokeDistance - strokeDistance;
    if (strokeDistance <= 0.52 && separation >= 0.06) {
      classifiedWindows.push({
        start_time_s: center - 1,
        end_time_s: center + 1,
        match_distance: strokeDistance,
        separation,
        features,
      });
    }
  }
  const merged = classifiedWindows.reduce((segments, window) => {
    const prior = segments[segments.length - 1];
    if (prior && window.start_time_s <= prior.end_time_s + 0.25) {
      prior.end_time_s = window.end_time_s;
      prior.windows.push(window);
    } else {
      segments.push({ start_time_s: window.start_time_s, end_time_s: window.end_time_s, windows: [window] });
    }
    return segments;
  }, []);
  const strokeLikeWindows = merged
    .filter((segment) => segment.end_time_s - segment.start_time_s >= 1.5)
    .map((segment) => {
      const distance = mean(segment.windows.map((window) => window.match_distance)) || Infinity;
      const separation = mean(segment.windows.map((window) => window.separation)) || 0;
      const cadence = calculateHandRhythmSummary(
        samples.filter((sample) => sample.timeS >= segment.start_time_s && sample.timeS <= segment.end_time_s),
        scoreKey,
        handCoverage,
        sampleRate,
      );
      return {
        start_time_s: Math.round(segment.start_time_s * 10) / 10,
        end_time_s: Math.round(segment.end_time_s * 10) / 10,
        duration_s: Math.round((segment.end_time_s - segment.start_time_s) * 10) / 10,
        confidence: handBehaviorConfidence(distance, separation, segment.windows.length),
        cadence_proxy: cadence.reliability === "moderate" ? cadence.movement_cycles_per_minute_estimate : null,
        mean_activity: Math.round(mean(segment.windows.map((window) => window.features.mean_activity)) || 0),
      };
    })
    .filter((segment) => segment.confidence !== "weak")
    .slice(0, 16);
  const classifiedDurationS = strokeLikeWindows.reduce((total, segment) => total + segment.duration_s, 0);
  const analyzedDurationS = Math.max(1, samples[samples.length - 1].timeS - samples[0].timeS);
  return {
    status: "calibrated_matching_available",
    method: "calibrated_directional_hand_motion",
    calibrated_references: { stroke_like: true, non_stroke: true },
    calibration_window_s: referenceRadiusS * 2,
    stroke_like_window_count: strokeLikeWindows.length,
    stroke_like_time_pct: Math.round((classifiedDurationS / analyzedDurationS) * 100),
    method_note: "Compares directional, reversing, rhythmic visible hand motion against examples marked from this recording. These are stroke-like motion proxies, not confirmed technique, force, or intent.",
    stroke_like_windows: strokeLikeWindows,
  };
}

function samplesForRegionSegment(samples, segment) {
  return samples.filter((sample) => sample.regionSegmentId === segment.id);
}

function segmentHandCoverage(samples) {
  if (!samples.length) return 0;
  return Math.round((samples.filter((sample) => sample.handsDetected).length / samples.length) * 100);
}

function buildPostureAppearanceResult(samples, regionSegments, referenceTimes, sampleRate) {
  if (!regionSegments.length) return buildPostureAppearanceSummary(samples, referenceTimes, sampleRate);

  const segmentSummaries = regionSegments
    .filter((segment) => segment.postureMatchingEnabled)
    .map((segment) => {
      const segmentSamples = samplesForRegionSegment(samples, segment);
      const summary = buildPostureAppearanceSummary(
        segmentSamples,
        segment.postureReferenceTimes,
        sampleRate,
      );
      return { segment, summary };
    })
    .filter(({ summary }) => summary.status !== "insufficient_appearance");
  const postureCandidates = segmentSummaries.flatMap(({ segment, summary }) => (
    (summary.posture_candidates || []).map((candidate) => ({
      ...candidate,
      region_segment_id: segment.id,
      region_segment_label: segment.label,
    }))
  ));
  const hasCalibratedSegment = segmentSummaries.some(({ summary }) => summary.status === "calibrated_matching_available");

  return {
    method: "calibrated_region_image_appearance_by_position_segment",
    coverage_pct: segmentSummaries.length
      ? Math.round(mean(segmentSummaries.map(({ summary }) => summary.coverage_pct)) || 0)
      : 0,
    status: postureCandidates.length || hasCalibratedSegment
      ? "calibrated_matching_available"
      : segmentSummaries.some(({ summary }) => summary.status === "references_needed")
        ? "references_needed"
        : "insufficient_appearance",
    calibrated_references_by_segment: segmentSummaries.map(({ segment, summary }) => ({
      region_segment_id: segment.id,
      region_segment_label: segment.label,
      calibrated_references: summary.calibrated_references || {},
    })),
    method_note: "Matches foot-region appearance only against references marked within the same position segment. Images and frame signatures are used transiently during local analysis and are not stored; labels remain visual posture proxies.",
    posture_candidates: postureCandidates,
  };
}

function buildHandBehaviorResult(samples, regionSegments, scoreKey, handCoverage, sampleRate, referenceTimes) {
  if (!regionSegments.length) {
    return buildHandBehaviorSummary(samples, scoreKey, handCoverage, sampleRate, referenceTimes);
  }

  const segmentSummaries = regionSegments
    .filter((segment) => segment.handBehaviorMatchingEnabled)
    .map((segment) => {
      const segmentSamples = samplesForRegionSegment(samples, segment);
      const summary = buildHandBehaviorSummary(
        segmentSamples,
        scoreKey,
        segmentHandCoverage(segmentSamples),
        sampleRate,
        segment.handBehaviorReferenceTimes,
      );
      return { segment, summary };
    });
  const strokeLikeWindows = segmentSummaries.flatMap(({ segment, summary }) => (
    (summary.stroke_like_windows || []).map((window) => ({
      ...window,
      region_segment_id: segment.id,
      region_segment_label: segment.label,
    }))
  ));
  const hasCalibratedSegment = segmentSummaries.some(({ summary }) => summary.status === "calibrated_matching_available");
  const analyzedDurationS = Math.max(1, samples[samples.length - 1].timeS - samples[0].timeS);

  return {
    status: strokeLikeWindows.length || hasCalibratedSegment
      ? "calibrated_matching_available"
      : segmentSummaries.some(({ summary }) => summary.status === "references_needed")
        ? "references_needed"
        : "insufficient_tracking",
    method: "calibrated_directional_hand_motion_by_position_segment",
    calibrated_references_by_segment: segmentSummaries.map(({ segment, summary }) => ({
      region_segment_id: segment.id,
      region_segment_label: segment.label,
      calibrated_references: summary.calibrated_references || {},
    })),
    stroke_like_window_count: strokeLikeWindows.length,
    stroke_like_time_pct: Math.round((
      strokeLikeWindows.reduce((total, window) => total + window.duration_s, 0) / analyzedDurationS
    ) * 100),
    method_note: "Compares visible hand motion only against examples marked within the same position segment. These are stroke-like motion proxies, not confirmed technique, force, or intent.",
    stroke_like_windows: strokeLikeWindows,
  };
}

function buildHandCadenceTimeline(result) {
  if (!result.hasHands || !result.samples.length || result.sampleRate < 6) return [];
  const scoreKey = result.hasLegs ? "handScore" : "score";
  const radiusS = 5;
  const firstTime = result.samples[0]?.timeS ?? result.start;
  const lastTime = result.samples[result.samples.length - 1]?.timeS ?? result.end;
  const points = [];

  for (let timeS = firstTime; timeS <= lastTime + 0.001; timeS += 1) {
    const windowSamples = result.samples.filter((sample) => (
      sample.timeS >= timeS - radiusS && sample.timeS <= timeS + radiusS
    ));
    if (!windowSamples.length) continue;
    const detectedCount = windowSamples.filter((sample) => sample.handsDetected).length;
    const coverage = Math.round((detectedCount / windowSamples.length) * 100);
    const rhythm = calculateHandRhythmSummary(windowSamples, scoreKey, coverage, result.sampleRate);
    points.push({
      time_s: Math.round(timeS * 10) / 10,
      movement_cycles_per_minute_estimate: rhythm.reliability === "moderate"
        ? rhythm.movement_cycles_per_minute_estimate
        : null,
      reliability: rhythm.reliability,
    });
  }
  return points;
}

const MOTION_SUGGESTION_SENSITIVITY = {
  conservative: { inactiveThreshold: 18, resumeDurationS: 1, minimumCoverage: 75 },
  balanced: { inactiveThreshold: 22, resumeDurationS: 0.75, minimumCoverage: 65 },
  sensitive: { inactiveThreshold: 28, resumeDurationS: 0.5, minimumCoverage: 65 },
};

function buildHandTransitionSuggestions(result, settings) {
  if (!result?.hasHands || !result.samples?.length || result.sampleRate < 6) return [];
  const sensitivity = MOTION_SUGGESTION_SENSITIVITY[settings.sensitivity] || MOTION_SUGGESTION_SENSITIVITY.balanced;
  if (result.handCoverage < sensitivity.minimumCoverage) return [];

  const stepS = 1 / result.sampleRate;
  const scoreKey = result.hasLegs ? "handScore" : "score";
  const points = result.samples.map((sample) => ({
    timeS: sample.timeS,
    score: Number(sample[scoreKey]) || 0,
    detected: Boolean(sample.handsDetected),
  }));
  const rawPauses = [];
  let pauseStart = null;
  points.forEach((point, index) => {
    const inactive = point.detected && point.score < sensitivity.inactiveThreshold;
    if (inactive && pauseStart == null) pauseStart = index;
    if ((!inactive || index === points.length - 1) && pauseStart != null) {
      const endIndex = inactive ? index : index - 1;
      rawPauses.push({ startIndex: pauseStart, endIndex });
      pauseStart = null;
    }
  });

  const mergedPauses = rawPauses.reduce((segments, segment) => {
    const prior = segments[segments.length - 1];
    if (!prior || !settings.mergeNearby) {
      segments.push(segment);
      return segments;
    }
    const gapStart = prior.endIndex + 1;
    const gapEnd = segment.startIndex - 1;
    const gap = points.slice(gapStart, gapEnd + 1);
    const gapDuration = Math.max(0, points[segment.startIndex].timeS - points[prior.endIndex].timeS - stepS);
    const bridgeIsLowMotion = gap.every((point) => point.detected && point.score < sensitivity.inactiveThreshold * 1.4);
    if (gapDuration <= 0.5 && bridgeIsLowMotion) {
      prior.endIndex = segment.endIndex;
    } else {
      segments.push(segment);
    }
    return segments;
  }, []);

  const candidates = [];
  let lastPairStart = -Infinity;
  mergedPauses.forEach((segment, pairIndex) => {
    const start = points[segment.startIndex].timeS;
    const end = points[segment.endIndex].timeS + stepS;
    const duration = end - start;
    if (duration < settings.minimumPauseDuration || start - lastPairStart < settings.minimumSpacing) return;

    const prePause = points.filter((point) => point.timeS >= start - 2 && point.timeS < start && point.detected);
    const postResume = points.filter((point) => point.timeS >= end && point.timeS < end + sensitivity.resumeDurationS && point.detected);
    const preAverage = mean(prePause.map((point) => point.score));
    const postAverage = mean(postResume.map((point) => point.score));
    const minimumResumeSamples = Math.max(1, Math.ceil(result.sampleRate * sensitivity.resumeDurationS * 0.65));
    const activePostSamples = postResume.filter((point) => point.score >= sensitivity.inactiveThreshold).length;
    if (
      preAverage == null
      || preAverage < sensitivity.inactiveThreshold
      || postAverage == null
      || postResume.length < minimumResumeSamples
      || activePostSamples < minimumResumeSamples
    ) return;

    const id = `motion-pause-${Math.round(start * 10)}-${pairIndex}`;
    const shared = {
      pairId: id,
      pauseStartTimeS: Math.round(start * 10) / 10,
      pauseEndTimeS: Math.round(end * 10) / 10,
      pauseDurationS: Math.round(duration * 10) / 10,
      confidence: "moderate",
      prePauseHandActivityAverage: Math.round(preAverage),
      postResumeHandActivityAverage: Math.round(postAverage),
    };
    candidates.push({ ...shared, id: `${id}-pause`, type: "motion_pause", timeS: shared.pauseStartTimeS });
    candidates.push({ ...shared, id: `${id}-resume`, type: "motion_resume", timeS: shared.pauseEndTimeS });
    lastPairStart = start;
  });
  return candidates;
}

function candidateOverlaps(first, second, paddingS = 0.5) {
  const firstStart = Number(first.start_time_s ?? first.time_s);
  const firstEnd = firstStart + Number(first.duration_s || 0);
  const secondStart = Number(second.start_time_s ?? second.time_s);
  const secondEnd = secondStart + Number(second.duration_s || 0);
  return firstStart <= secondEnd + paddingS && secondStart <= firstEnd + paddingS;
}

function lowerBodySidePattern(result, candidate) {
  const start = Number(candidate.start_time_s ?? candidate.time_s);
  const end = start + Number(candidate.duration_s || 0);
  const windowSamples = result.samples.filter((sample) => sample.timeS >= start && sample.timeS <= end);
  const left = mean(windowSamples.map((sample) => Number(sample.leftScore) || 0)) || 0;
  const right = mean(windowSamples.map((sample) => Number(sample.rightScore) || 0)) || 0;
  const difference = left - right;
  if (left >= 20 && right < 8) return { value: "left_only", phrase: "left-side only" };
  if (right >= 20 && left < 8) return { value: "right_only", phrase: "right-side only" };
  if (Math.abs(difference) < 10) return { value: "bilateral_similar", phrase: "bilaterally similar" };
  return difference > 0
    ? { value: "left_greater_than_right", phrase: "left greater than right" }
    : { value: "right_greater_than_left", phrase: "right greater than left" };
}

function lowerBodyIntensity(peakActivity) {
  if (peakActivity >= 75) return "marked";
  if (peakActivity >= 45) return "moderate";
  return "mild";
}

function buildLowerBodySemanticSuggestions(result) {
  if (!result?.hasLegs) return [];
  const patterns = result.lowerBodyPatterns || {};
  const postureCandidates = (result.postureGeometry?.posture_candidates || []).map((candidate, index) => ({
    id: `lower-body-posture-${candidate.posture}-${Math.round(candidate.time_s * 10)}-${index}`,
    pairId: `lower-body-posture-${candidate.posture}-${Math.round(candidate.time_s * 10)}`,
    type: "lower_body_semantic_finding",
    timeS: candidate.time_s,
    durationS: candidate.duration_s,
    confidence: candidate.confidence,
    note: `Motion-derived: ${candidate.posture_phrase} observed for approximately ${candidate.duration_s.toFixed(1).replace(/\.0$/, "")} seconds.`,
    semanticLabel: candidate.posture_phrase,
    sidePattern: "not_determined",
    sidePatternPhrase: "calibrated appearance match",
    intensity: "not_applicable",
    movementQuality: ["calibrated_posture_match"],
    posture: candidate.posture,
  }));
  const oscillatory = (patterns.oscillatory_candidates || []).map((candidate) => ({
    ...candidate,
    semanticQuality: "rapid_oscillatory_shudder_like_activity",
    qualityPhrase: "rapid shudder-like lower-body activity",
  }));
  const sustained = (patterns.sustained_activity_shift_candidates || [])
    .filter((candidate) => !oscillatory.some((existing) => candidateOverlaps(candidate, existing)))
    .map((candidate) => ({
      ...candidate,
      semanticQuality: "sustained_activity_elevation",
      qualityPhrase: "sustained lower-body activity",
    }));
  const bursts = (patterns.burst_candidates || [])
    .filter((candidate) => ![...oscillatory, ...sustained].some((existing) => candidateOverlaps(candidate, existing)))
    .map((candidate) => ({
      ...candidate,
      semanticQuality: "brief_movement_burst",
      qualityPhrase: "brief lower-body movement burst",
    }));
  const divergenceOnly = (patterns.divergence_candidates || [])
    .filter((candidate) => ![...oscillatory, ...sustained, ...bursts].some((existing) => candidateOverlaps(candidate, existing)))
    .map((candidate) => ({
      ...candidate,
      semanticQuality: "left_right_divergence",
      qualityPhrase: "lower-body side divergence",
    }));

  const activityCandidates = [...oscillatory, ...sustained, ...bursts, ...divergenceOnly]
    .sort((a, b) => a.time_s - b.time_s)
    .slice(0, 16)
    .map((candidate, index) => {
      const sidePattern = lowerBodySidePattern(result, candidate);
      const intensity = lowerBodyIntensity(candidate.peak_activity);
      const hasOverlappingDivergence = (patterns.divergence_candidates || [])
        .some((divergence) => candidateOverlaps(candidate, divergence));
      const sideClause = hasOverlappingDivergence || sidePattern.value !== "bilateral_similar"
        ? `, ${sidePattern.phrase}`
        : ", bilaterally similar";
      const note = `Motion-derived: ${intensity} ${candidate.qualityPhrase}${sideClause}.`;
      return {
        id: `lower-body-semantic-${candidate.semanticQuality}-${Math.round(candidate.time_s * 10)}-${index}`,
        pairId: `lower-body-semantic-${candidate.semanticQuality}-${Math.round(candidate.time_s * 10)}`,
        type: "lower_body_semantic_finding",
        timeS: candidate.time_s,
        durationS: candidate.duration_s,
        confidence: "moderate",
        note,
        semanticLabel: candidate.qualityPhrase,
        sidePattern: sidePattern.value,
        sidePatternPhrase: sidePattern.phrase,
        intensity,
        movementQuality: [candidate.semanticQuality],
        posture: "not_classified_from_activity_trace",
      };
    });
  return [...postureCandidates, ...activityCandidates]
    .sort((a, b) => a.timeS - b.timeS)
    .slice(0, 20);
}

function motionSuggestionEvent(suggestion) {
  if (suggestion.type === "lower_body_semantic_finding") {
    return {
      time_s: suggestion.timeS,
      note: suggestion.note,
      category: ["movement_observed"],
      annotation_tags: ["lower_body", "motion_derived"],
      source: "motion_derived",
      verification_status: "unverified",
      motion_evidence: {
        candidate_id: suggestion.pairId,
        suggestion_type: suggestion.type,
        confidence: suggestion.confidence,
        side_pattern: suggestion.sidePattern,
        posture: suggestion.posture,
        movement_quality: suggestion.movementQuality,
        intensity: suggestion.intensity,
        duration_s: suggestion.durationS,
      },
    };
  }
  const pauseSeconds = suggestion.pauseDurationS.toFixed(1).replace(/\.0$/, "");
  const isPause = suggestion.type === "motion_pause";
  return {
    time_s: suggestion.timeS,
    note: isPause
      ? "Motion-derived: hand activity pause observed."
      : `Motion-derived: hand activity resumed after brief pause (${pauseSeconds} seconds).`,
    category: [isPause ? "motion_pause" : "motion_resume"],
    annotation_tags: ["other_context"],
    source: "motion_derived",
    verification_status: "unverified",
    motion_evidence: {
      candidate_id: suggestion.pairId,
      suggestion_type: suggestion.type,
      confidence: suggestion.confidence,
      ...(isPause ? { pause_duration_s: suggestion.pauseDurationS } : { preceding_pause_duration_s: suggestion.pauseDurationS }),
    },
  };
}

function QualityBadge({ coverage }) {
  const quality = qualityFromCoverage(coverage);
  if (!quality) return null;
  return (
    <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${quality.color}`}>
      {quality.label}
    </span>
  );
}

function ConfidenceBadge({ level }) {
  const color = level === "moderate"
    ? "border-emerald-400/25 bg-emerald-400/[0.08] text-emerald-300"
    : level === "low"
      ? "border-amber-400/25 bg-amber-400/[0.08] text-amber-300"
      : "border-rose-400/25 bg-rose-400/[0.08] text-rose-300";
  return (
    <span className={`inline-flex rounded-full border px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wider ${color}`}>
      {level || "weak"}
    </span>
  );
}

function patternSeverity(count) {
  if (count >= 12) {
    return {
      label: "High count",
      className: "border-rose-400/25 bg-rose-400/[0.06]",
      numberClassName: "text-rose-300",
      badgeClassName: "border-rose-400/25 bg-rose-400/[0.09] text-rose-300",
    };
  }
  if (count >= 4) {
    return {
      label: "Moderate count",
      className: "border-amber-400/25 bg-amber-400/[0.05]",
      numberClassName: "text-amber-300",
      badgeClassName: "border-amber-400/25 bg-amber-400/[0.08] text-amber-300",
    };
  }
  return {
    label: "Low count",
    className: "border-border bg-muted/15",
    numberClassName: "text-foreground",
    badgeClassName: "border-border bg-muted/20 text-muted-foreground",
  };
}

function PatternProxyMetric({ label, count }) {
  const severity = patternSeverity(Number(count) || 0);
  return (
    <div className={`rounded-lg border px-3 py-2 ${severity.className}`}>
      <div className="flex flex-wrap items-center justify-between gap-1">
        <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{label}</p>
        <span className={`rounded-full border px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider ${severity.badgeClassName}`}>
          {severity.label}
        </span>
      </div>
      <p className={`mt-1 font-mono text-base font-semibold ${severity.numberClassName}`}>{count}</p>
      <div className="motion-lab-floating-navigator fixed bottom-4 right-4 z-40 hidden max-w-[11rem] rounded-2xl border border-primary/25 bg-card/95 p-2 shadow-2xl shadow-background/40 backdrop-blur supports-[backdrop-filter]:bg-card/85 xl:block">
        <p className="mb-1.5 px-1 text-[9px] font-semibold uppercase tracking-wider text-primary">Motion Lab Nav</p>
        <div className="grid gap-1">
          {[
            ["motion-lab-top", "Top"],
            ["motion-lab-setup", "Setup"],
            ["motion-lab-regions", "Regions"],
            ["motion-lab-landmarks", "Landmarks"],
            ["motion-lab-preview", "Preview"],
            ["motion-lab-results", "Results"],
            ["motion-lab-findings", "Findings"],
            ["motion-lab-trace", "Trace"],
          ].map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => scrollToMotionSection(id)}
              className="rounded-lg border border-border/70 bg-muted/20 px-2 py-1 text-left text-[10px] font-medium text-foreground transition-colors hover:border-primary/45 hover:bg-primary/[0.1] hover:text-primary"
            >
              {label}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

function HandBehaviorCalibration({
  enabled,
  onEnabledChange,
  referenceTimes,
  onReferenceTimesChange,
  scopeLabel,
  videoSrc,
  videoTime,
  running,
}) {
  return (
    <div className="space-y-3 rounded-lg border border-[#a78bfa]/25 bg-[#a78bfa]/[0.05] p-3">
      <label className="inline-flex items-center gap-2 text-xs font-medium text-foreground">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) => onEnabledChange(event.target.checked)}
          disabled={running}
          className="h-3.5 w-3.5 accent-[#a78bfa]"
        />
        Enable calibrated stroke-like hand-motion matching (experimental)
      </label>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        Use this after the session: scrub the loaded recording to one clear rhythmic up/down hand-motion example and one visible adjustment or other non-stroke hand movement. The next analysis compares later visible hand windows to those examples.
      </p>
      {scopeLabel && (
        <p className="rounded-md border border-[#a78bfa]/20 bg-[#a78bfa]/[0.06] px-2.5 py-1.5 text-[11px] text-[#ddd6fe]">
          These hand examples apply only to <span className="font-semibold">{scopeLabel}</span>.
        </p>
      )}
      {enabled && (
        <>
          <p className="text-[10px] font-semibold uppercase tracking-wider text-[#c4b5fd]">
            Click to mark current playback example
          </p>
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => onReferenceTimesChange((current) => ({
                ...current,
                stroke_like: Math.round((Number(videoTime) || 0) * 10) / 10,
              }))}
              disabled={!videoSrc || running}
              className={`rounded-lg border px-3 py-2 text-[11px] font-semibold shadow-sm transition-all disabled:cursor-not-allowed disabled:opacity-45 ${
                referenceTimes.stroke_like != null
                  ? "border-[#a78bfa]/70 bg-[#a78bfa]/[0.2] text-[#ddd6fe] ring-1 ring-[#a78bfa]/20"
                  : "border-[#a78bfa]/35 bg-[#a78bfa]/[0.08] text-[#c4b5fd] hover:border-[#a78bfa]/65 hover:bg-[#a78bfa]/[0.15]"
              }`}
            >
              {referenceTimes.stroke_like != null ? "Marked: " : "Mark: "}Rhythmic stroke-like example
              {referenceTimes.stroke_like != null && (
                <span className="ml-1.5 font-mono">{formatTime(referenceTimes.stroke_like)}</span>
              )}
            </button>
            <button
              type="button"
              onClick={() => onReferenceTimesChange((current) => ({
                ...current,
                non_stroke: Math.round((Number(videoTime) || 0) * 10) / 10,
              }))}
              disabled={!videoSrc || running}
              className={`rounded-lg border px-3 py-2 text-[11px] font-semibold shadow-sm transition-all disabled:cursor-not-allowed disabled:opacity-45 ${
                referenceTimes.non_stroke != null
                  ? "border-[#a78bfa]/70 bg-[#a78bfa]/[0.2] text-[#ddd6fe] ring-1 ring-[#a78bfa]/20"
                  : "border-[#a78bfa]/35 bg-[#a78bfa]/[0.08] text-[#c4b5fd] hover:border-[#a78bfa]/65 hover:bg-[#a78bfa]/[0.15]"
              }`}
            >
              {referenceTimes.non_stroke != null ? "Marked: " : "Mark: "}Adjustment / non-stroke example
              {referenceTimes.non_stroke != null && (
                <span className="ml-1.5 font-mono">{formatTime(referenceTimes.non_stroke)}</span>
              )}
            </button>
            <button
              type="button"
              onClick={() => onReferenceTimesChange(emptyHandBehaviorReferenceTimes())}
              disabled={running}
              className="rounded-lg border border-border bg-card px-3 py-2 text-[11px] font-semibold text-foreground shadow-sm transition-colors hover:border-[#a78bfa]/35 hover:bg-[#a78bfa]/[0.06] disabled:cursor-not-allowed disabled:opacity-45"
            >
              Clear hand examples
            </button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Each mark represents a three-second example window centered at the selected playback time. Both examples are required; results remain stroke-like motion proxies, not confirmed technique.
          </p>
        </>
      )}
    </div>
  );
}

function clusterMoments(moments, nearbyWindowS = 6) {
  return moments.reduce((clusters, moment) => {
    const previous = clusters[clusters.length - 1];
    if (previous && moment.timeS - previous[previous.length - 1].timeS <= nearbyWindowS) {
      previous.push(moment);
    } else {
      clusters.push([moment]);
    }
    return clusters;
  }, []);
}

function buildFindings(result) {
  const findings = [];
  if (result.regionSegments?.length > 1) {
    findings.push(`${result.regionSegments.length} position-specific tracking region sets were used in this analysis. Apparent signal changes near position-change boundaries may reflect framing or region changes and require direct video confirmation.`);
  }
  if (result.hasLegs && result.lowerBodyMethod === "regionMotion") {
    findings.push(result.hasForefoot
      ? "Foot signals were measured from movement within the assigned left and right regions, with optional forefoot / toe-region activity included for visual comparison."
      : "Foot signals were measured from movement within the assigned left and right regions; forefoot / toe-region comparison was not enabled for this run.");
  }
  if (result.hasLegs && result.leftCoverage >= 60 && result.rightCoverage >= 60) {
    const difference = result.leftAverage - result.rightAverage;
    if (Math.abs(difference) < 6) {
      findings.push("Left and right foot / leg movement were broadly similar across the analyzed window.");
    } else {
      findings.push(`${difference > 0 ? "Left" : "Right"} foot / leg movement showed higher average activity in this analyzed window (${Math.abs(difference)} points higher).`);
    }
  }
  if (result.hasLegs && result.lowerBodyMethod === "landmarks" && (result.leftCoverage < 60 || result.rightCoverage < 60)) {
    findings.push("One side had limited landmark visibility, so side-to-side comparison should be treated cautiously.");
  }
  if (result.hasHands && result.handCoverage >= 60) {
    findings.push("Hand motion was detected reliably enough to compare its timing against visible foot / leg activity peaks.");
  }
  if (result.handRhythm?.reliability === "moderate" && result.handRhythm.movement_cycles_per_minute_estimate != null) {
    findings.push(`Repeated hand-movement oscillations support a cautious cadence estimate of approximately ${result.handRhythm.movement_cycles_per_minute_estimate} movement cycles per minute, with ${result.handRhythm.pause_count} pauses of at least two seconds; this is not confirmed stroke speed.`);
  }
  if (result.handBehavior?.status === "calibrated_matching_available" && result.handBehavior.stroke_like_window_count > 0) {
    findings.push(`${result.handBehavior.stroke_like_window_count} calibrated stroke-like rhythmic hand-motion window${result.handBehavior.stroke_like_window_count === 1 ? " was" : "s were"} identified from examples marked in this recording; these remain observational proxies, not confirmed technique.`);
  }
  if (result.asymmetry && result.leftCoverage >= 50 && result.rightCoverage >= 50) {
    if (result.asymmetry.predominantSide === "balanced") {
      findings.push(`No clear side predominance was established across active paired lower-body windows (left-biased ${result.asymmetry.leftBiasedPct}%, right-biased ${result.asymmetry.rightBiasedPct}%, broadly similar ${result.asymmetry.balancedPct}%; ${result.asymmetry.comparedWindows} compared samples).`);
    } else {
      const side = result.asymmetry.predominantSide === "left" ? "Left" : "Right";
      findings.push(`${side}-side activity predominated in ${result.asymmetry.predominantPct}% of active paired lower-body windows (${result.asymmetry.comparedWindows} compared samples).`);
    }
  }
  if (result.postureGeometry?.status === "calibrated_matching_available" && result.postureGeometry.posture_candidates.length > 0) {
    findings.push(`${result.postureGeometry.posture_candidates.length} calibrated visual foot-posture candidate${result.postureGeometry.posture_candidates.length === 1 ? " was" : "s were"} identified from user-marked reference appearances; these remain observational proxies.`);
  }
  if (result.footGeometryTracking?.status === "marker_tracking_available" || result.footGeometryTracking?.status === "limited_marker_tracking") {
    findings.push(`Marker-assisted foot geometry was tracked across ${result.footGeometryTracking.sample_count} sampled frames (${result.footGeometryTracking.coverage_pct}% coverage). Use this as a continuous visual trend for foot spread, fanning, heel separation, toe gap, and planted/neutral posture, not as force or intent.`);
  }
  findings.push(`There were ${result.moments.length} high-activity moments flagged for direct video review.`);
  return findings;
}

function buildDerivedTimeline(result, maximumPoints = 900) {
  const stride = Math.max(1, Math.ceil(result.samples.length / maximumPoints));
  return result.samples
    .filter((_, index) => index % stride === 0 || index === result.samples.length - 1)
    .map((sample) => ({
      time_s: Math.round(sample.timeS * 10) / 10,
      activity: sample.score,
      left_lower_body_activity: result.hasLegs ? sample.leftScore : undefined,
      right_lower_body_activity: result.hasLegs ? sample.rightScore : undefined,
      left_forefoot_activity: result.hasForefoot ? sample.leftForefootScore : undefined,
      right_forefoot_activity: result.hasForefoot ? sample.rightForefootScore : undefined,
      hand_activity: result.hasHands ? (result.hasLegs ? sample.handScore : sample.score) : undefined,
      foot_fan_angle_deg: sample.footMarkerGeometry?.fan_angle_deg,
      foot_toe_gap_normalized: sample.footMarkerGeometry?.toe_gap_normalized,
      foot_heel_gap_normalized: sample.footMarkerGeometry?.heel_gap_normalized,
      foot_left_axis_deg: sample.footMarkerGeometry?.left_axis_deg,
      foot_right_axis_deg: sample.footMarkerGeometry?.right_axis_deg,
      foot_left_planted_proxy: sample.footMarkerGeometry?.left_planted_proxy,
      foot_right_planted_proxy: sample.footMarkerGeometry?.right_planted_proxy,
      region_segment_id: sample.regionSegmentId || undefined,
      region_segment_label: sample.regionSegmentLabel || undefined,
      region_segment_boundary: sample.regionBoundary || undefined,
    }));
}

function buildSavedSummary(result) {
  const serializedSegments = serializeRegionSegments(result.regionSegments);
  const analyzedSegmentIds = [...new Set(result.samples.map((sample) => sample.regionSegmentId).filter(Boolean))];
  return {
    source: "local_mediapipe_video_review",
    status: "reviewed_derived_signal",
    analyzed_at: new Date().toISOString(),
    mode: result.mode,
    lower_body_tracking_method: result.hasLegs ? result.lowerBodyMethod : undefined,
    left_right_orientation: result.hasLegs ? result.leftRightOrientation : undefined,
    forefoot_enabled: result.hasForefoot,
    roi_configuration: {
      layout: result.roiLayout,
      left_lower_body: roundedRoi(result.rois.leftLowerBody),
      right_lower_body: roundedRoi(result.rois.rightLowerBody),
      left_forefoot: result.hasForefoot ? roundedRoi(result.rois.leftForefoot) : undefined,
      right_forefoot: result.hasForefoot ? roundedRoi(result.rois.rightForefoot) : undefined,
      hands: roundedRoi(result.rois.hands),
    },
    region_segments: serializedSegments.length ? serializedSegments : undefined,
    region_segment_summary: serializedSegments.length ? {
      segment_count: serializedSegments.length,
      analyzed_segment_count: analyzedSegmentIds.length,
      analyzed_segment_ids: analyzedSegmentIds,
      boundary_times_s: serializedSegments.slice(1).map((segment) => segment.start_time_s),
      manual_foot_landmark_segment_count: serializedSegments.filter((segment) => segment.manual_foot_landmark_geometry?.marked_count > 0).length,
      interpretation_note: "Tracking regions changed at marked position boundaries. Signal changes near those boundaries may reflect framing or region-of-interest changes and should be verified against video before physiological interpretation.",
    } : undefined,
    manual_foot_landmarks: !serializedSegments.length ? roundedFootLandmarks(result.footLandmarks) : undefined,
    manual_foot_landmark_geometry: !serializedSegments.length ? result.footLandmarkGeometry : undefined,
    window_start_s: Math.round(result.start),
    window_end_s: Math.round(result.end),
    sample_rate_fps: result.sampleRate,
    detection_coverage_pct: result.coverage,
    left_lower_body_coverage_pct: result.hasLegs ? result.leftCoverage : undefined,
    right_lower_body_coverage_pct: result.hasLegs ? result.rightCoverage : undefined,
    hand_coverage_pct: result.hasHands ? result.handCoverage : undefined,
    quality_indicators: {
      left_lower_body: result.hasLegs && result.lowerBodyMethod === "landmarks" ? qualityFromCoverage(result.leftCoverage)?.level : undefined,
      right_lower_body: result.hasLegs && result.lowerBodyMethod === "landmarks" ? qualityFromCoverage(result.rightCoverage)?.level : undefined,
      hands: result.hasHands ? qualityFromCoverage(result.handCoverage)?.level : undefined,
    },
    asymmetry_summary: result.hasLegs && result.asymmetry ? result.asymmetry : undefined,
    lower_body_pattern_summary: result.hasLegs ? result.lowerBodyPatterns : undefined,
    lower_body_posture_summary: result.hasLegs ? result.postureGeometry : undefined,
    posture_reference_times_s: result.hasLegs && result.postureGeometry && !serializedSegments.length ? result.postureReferenceTimes : undefined,
    left_lower_body_average_activity: result.hasLegs ? result.leftAverage : undefined,
    right_lower_body_average_activity: result.hasLegs ? result.rightAverage : undefined,
    left_forefoot_average_activity: result.hasForefoot ? result.leftForefootAverage : undefined,
    right_forefoot_average_activity: result.hasForefoot ? result.rightForefootAverage : undefined,
    hand_average_activity: result.hasHands ? result.handAverage : undefined,
    hand_movement_summary: result.hasHands ? result.handRhythm : undefined,
    hand_behavior_summary: result.hasHands ? result.handBehavior : undefined,
    hand_behavior_reference_times_s: result.hasHands && result.handBehavior && !serializedSegments.length ? result.handBehaviorReferenceTimes : undefined,
    hand_cadence_timeline: result.hasHands ? buildHandCadenceTimeline(result) : undefined,
    foot_geometry_tracking_summary: result.hasLegs ? result.footGeometryTracking : undefined,
    findings: result.findings,
    derived_timeline: buildDerivedTimeline(result),
    review_peaks: result.moments.map((moment) => ({
      time_s: Math.round(moment.timeS * 10) / 10,
      activity: moment.score,
      left_lower_body_activity: moment.leftScore,
      right_lower_body_activity: moment.rightScore,
      left_forefoot_activity: result.hasForefoot ? moment.leftForefootScore : undefined,
      right_forefoot_activity: result.hasForefoot ? moment.rightForefootScore : undefined,
      hand_activity: moment.handScore,
    })),
    interpretation_guardrail: "Media-derived movement signals are observational and require correlation with session notes and telemetry before physiological interpretation.",
    normalization_guardrail: "Activity scores are normalized within this analyzed video window and are not absolute force measurements or directly comparable magnitudes across recordings. Region-motion scores should be checked against camera movement, framing changes, marked position-change boundaries, and visible recording artifacts.",
  };
}

function selectReviewMoments(samples, mode) {
  const minimumSpacing = mode === "hands" ? 1 : 1.5;
  const candidates = samples
    .filter((sample, index) => (
      sample.detected
      && sample.score >= 70
      && sample.score >= (samples[index - 1]?.score ?? -1)
      && sample.score >= (samples[index + 1]?.score ?? -1)
    ))
    .sort((a, b) => b.score - a.score);
  const selected = [];
  candidates.forEach((candidate) => {
    if (selected.every((value) => Math.abs(value.timeS - candidate.timeS) >= minimumSpacing)) {
      selected.push(candidate);
    }
  });
  return selected.slice(0, 8).sort((a, b) => a.timeS - b.timeS);
}

function MotionTooltip({ active, payload, label }) {
  if (!active || !payload?.length) return null;
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2 text-xs shadow-xl">
      <p className="font-mono font-semibold text-foreground">{formatTime(label)}</p>
      {payload.map((entry) => (
        <p key={entry.dataKey} className="mt-1" style={{ color: entry.color }}>
          {entry.name}: {entry.value ?? 0}
        </p>
      ))}
    </div>
  );
}

export default function LocalMotionAnalysisPanel({ videoSrc, videoDuration, videoTime, videoPlaying = false, selectedSession, analysisFeedLabel = null, onSeek, onSaveSummary, onAcceptSuggestions }) {
  const stopRequestedRef = useRef(false);
  const previewCanvasRef = useRef(null);
  const previewEnabledRef = useRef(false);
  const previewLegsRef = useRef(true);
  const previewHandsRef = useRef(true);
  const previewReadyRef = useRef(false);
  const roiCanvasRef = useRef(null);
  const roiFrameCanvasRef = useRef(null);
  const roiFrameRequestRef = useRef(0);
  const roiDragStartRef = useRef(null);
  const [mode, setMode] = useState("combined");
  const [windowMode, setWindowMode] = useState("segment");
  const [roiLayout, setRoiLayout] = useState("pip");
  const [lowerBodyMethod, setLowerBodyMethod] = useState("regionMotion");
  const [rois, setRois] = useState(() => copyRois(PIP_ROI_PRESET));
  const [regionSegments, setRegionSegments] = useState([]);
  const [selectedRegionSegmentId, setSelectedRegionSegmentId] = useState(null);
  const [activeRoi, setActiveRoi] = useState("leftLowerBody");
  const [landmarkPlacementEnabled, setLandmarkPlacementEnabled] = useState(false);
  const [activeFootLandmark, setActiveFootLandmark] = useState("leftBigToe");
  const [footLandmarks, setFootLandmarks] = useState(() => emptyFootLandmarks());
  const [landmarkDisplaySize, setLandmarkDisplaySize] = useState(8);
  const [roiPreviewZoom, setRoiPreviewZoom] = useState(1);
  const [roiPreviewPan, setRoiPreviewPan] = useState({ x: 0, y: 0 });
  const [forefootEnabled, setForefootEnabled] = useState(false);
  const [postureMatchingEnabled, setPostureMatchingEnabled] = useState(true);
  const [postureReferenceTimes, setPostureReferenceTimes] = useState(() => emptyPostureReferenceTimes());
  const [handBehaviorMatchingEnabled, setHandBehaviorMatchingEnabled] = useState(true);
  const [handBehaviorReferenceTimes, setHandBehaviorReferenceTimes] = useState(() => emptyHandBehaviorReferenceTimes());
  const [leftRightOrientation, setLeftRightOrientation] = useState("anatomical_left_on_screen_right");
  const [roiFrameReady, setRoiFrameReady] = useState(false);
  const [roiSetupTime, setRoiSetupTime] = useState(0);
  const [roiFrameRevision, setRoiFrameRevision] = useState(0);
  const [syncRoiWithMainPlayer, setSyncRoiWithMainPlayer] = useState(true);
  const [loadingRoiFrame, setLoadingRoiFrame] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState("");
  const [result, setResult] = useState(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [visibleSignals, setVisibleSignals] = useState({
    left: true,
    right: true,
    leftForefoot: false,
    rightForefoot: false,
    hands: true,
    activity: true,
  });
  const [previewEnabled, setPreviewEnabled] = useState(false);
  const [previewLegs, setPreviewLegs] = useState(true);
  const [previewHands, setPreviewHands] = useState(true);
  const [previewReady, setPreviewReady] = useState(false);
  const [suggestionSettings, setSuggestionSettings] = useState({
    minimumPauseDuration: 2,
    sensitivity: "balanced",
    mergeNearby: true,
    minimumSpacing: 2,
  });
  const [visibleSuggestionTypes, setVisibleSuggestionTypes] = useState({
    motion_pause: true,
    motion_resume: true,
    lower_body_semantic_finding: true,
  });
  const [dismissedSuggestionIds, setDismissedSuggestionIds] = useState([]);
  const [acceptedSuggestionIds, setAcceptedSuggestionIds] = useState([]);
  const [acceptingSuggestions, setAcceptingSuggestions] = useState(false);
  const [expandedPeakClusters, setExpandedPeakClusters] = useState([]);
  const [setupExpanded, setSetupExpanded] = useState(false);
  const [regionsExpanded, setRegionsExpanded] = useState(false);
  const [previewExpanded, setPreviewExpanded] = useState(false);

  useEffect(() => {
    stopRequestedRef.current = true;
    setResult(null);
    setError("");
    setProgress(0);
    setSaved(false);
    setPreviewReady(false);
    setRoiFrameReady(false);
    setRoiSetupTime(0);
    setRoiFrameRevision(0);
    setLoadingRoiFrame(false);
    setRegionSegments([]);
    setSelectedRegionSegmentId(null);
    roiFrameCanvasRef.current = null;
    roiFrameRequestRef.current += 1;
    previewReadyRef.current = false;
    setDismissedSuggestionIds([]);
    setAcceptedSuggestionIds([]);
    setExpandedPeakClusters([]);
    setPostureReferenceTimes(emptyPostureReferenceTimes());
    setHandBehaviorReferenceTimes(emptyHandBehaviorReferenceTimes());
    setFootLandmarks(emptyFootLandmarks());
    setLandmarkPlacementEnabled(false);
    setRoiPreviewZoom(1);
    setRoiPreviewPan({ x: 0, y: 0 });
  }, [videoSrc]);

  useEffect(() => {
    previewEnabledRef.current = previewEnabled;
    previewLegsRef.current = previewLegs;
    previewHandsRef.current = previewHands;
    if (!previewEnabled) {
      const canvas = previewCanvasRef.current;
      canvas?.getContext("2d")?.clearRect(0, 0, canvas.width, canvas.height);
      previewReadyRef.current = false;
      setPreviewReady(false);
    }
  }, [previewEnabled, previewHands, previewLegs]);

  useEffect(() => {
    if (!result) return;
    setVisibleSignals({
      left: result.hasLegs,
      right: result.hasLegs,
      leftForefoot: false,
      rightForefoot: false,
      hands: result.hasHands && !result.hasLegs,
      activity: !result.hasLegs,
    });
  }, [result]);

  useEffect(() => {
    if (!forefootEnabled && (activeRoi === "leftForefoot" || activeRoi === "rightForefoot")) {
      setActiveRoi("leftLowerBody");
    }
  }, [activeRoi, forefootEnabled]);

  const selectedMode = MODES[mode];
  const orderedRegionSegments = useMemo(() => normalizeRegionSegments(regionSegments), [regionSegments]);
  const activeRegionSegment = useMemo(
    () => regionSegmentAtTime(orderedRegionSegments, videoTime),
    [orderedRegionSegments, videoTime],
  );
  const selectedRegionSegment = orderedRegionSegments.find((segment) => segment.id === selectedRegionSegmentId) || activeRegionSegment;
  const appliedRois = useMemo(() => resolveRois(roiLayout, rois), [roiLayout, rois]);
  const appliedLowerBodyMethod = roiLayout === "pip" ? lowerBodyMethod : "landmarks";
  const handTransitionSuggestions = useMemo(
    () => buildHandTransitionSuggestions(result, suggestionSettings),
    [result, suggestionSettings],
  );
  const lowerBodySemanticSuggestions = useMemo(
    () => buildLowerBodySemanticSuggestions(result),
    [result],
  );
  const motionSuggestions = useMemo(
    () => [...handTransitionSuggestions, ...lowerBodySemanticSuggestions].sort((a, b) => a.timeS - b.timeS),
    [handTransitionSuggestions, lowerBodySemanticSuggestions],
  );
  const reviewPeakClusters = useMemo(() => clusterMoments(result?.moments || []), [result?.moments]);
  const currentMotionPoint = useMemo(() => {
    if (!result?.samples?.length || !Number.isFinite(Number(videoTime))) return null;
    return result.samples.reduce((closest, sample) => (
      Math.abs(Number(sample.timeS) - Number(videoTime)) < Math.abs(Number(closest.timeS) - Number(videoTime))
        ? sample
        : closest
    ), result.samples[0]);
  }, [result, videoTime]);
  const visibleMotionSuggestions = motionSuggestions.filter((suggestion) => (
    visibleSuggestionTypes[suggestion.type]
    && !dismissedSuggestionIds.includes(suggestion.id)
    && !acceptedSuggestionIds.includes(suggestion.id)
  ));
  const analysisRange = useMemo(() => {
    const duration = Number(videoDuration) || 0;
    if (!duration) return { start: 0, end: 0 };
    if (windowMode === "full") return { start: 0, end: duration };
    const center = clamp(Number(videoTime) || 0, 0, duration);
    return {
      start: Math.max(0, center - 60),
      end: Math.min(duration, center + 60),
    };
  }, [videoDuration, videoTime, windowMode]);
  const footLandmarkGeometry = useMemo(() => computeFootLandmarkGeometry(footLandmarks), [footLandmarks]);

  const stopAnalysis = () => {
    stopRequestedRef.current = true;
  };

  const drawRoiSetupFrame = () => {
    const canvas = roiCanvasRef.current;
    const source = roiFrameCanvasRef.current;
    if (!canvas || !source) return;
    if (canvas.width !== source.width || canvas.height !== source.height) {
      canvas.width = source.width;
      canvas.height = source.height;
    }
    const context = canvas.getContext("2d");
    if (!context) return;
    context.drawImage(source, 0, 0);
    if (roiLayout === "full") {
      context.strokeStyle = "#20d3c2";
      context.lineWidth = 4;
      context.strokeRect(2, 2, canvas.width - 4, canvas.height - 4);
      return;
    }
    const visibleRegions = [
      { key: "leftLowerBody", color: "#20d3c2", label: "L foot" },
      { key: "rightLowerBody", color: "#f59e0b", label: "R foot" },
      { key: "hands", color: "#a78bfa", label: "Hands" },
    ];
    if (forefootEnabled && lowerBodyMethod === "regionMotion") {
      visibleRegions.splice(2, 0,
        { key: "leftForefoot", color: "#2dd4bf", label: "L toes" },
        { key: "rightForefoot", color: "#fb923c", label: "R toes" },
      );
    }
    visibleRegions.forEach(({ key, color, label }) => {
      const roi = rois[key];
      const x = roi.x * canvas.width;
      const y = roi.y * canvas.height;
      const width = roi.width * canvas.width;
      const height = roi.height * canvas.height;
      context.fillStyle = `${color}20`;
      context.fillRect(x, y, width, height);
      context.strokeStyle = color;
      context.lineWidth = key === activeRoi ? 4 : 2;
      context.strokeRect(x, y, width, height);
      context.fillStyle = color;
      context.font = "bold 13px sans-serif";
      context.fillText(label, x + 8, y + 18);
      if (key === activeRoi) {
        const handleSize = Math.max(10, Math.min(canvas.width, canvas.height) * 0.018);
        context.fillStyle = "#ffffff";
        context.strokeStyle = color;
        context.lineWidth = 3;
        Object.values(roiCorners(roi)).forEach((corner) => {
          const handleX = (corner.x * canvas.width) - (handleSize / 2);
          const handleY = (corner.y * canvas.height) - (handleSize / 2);
          context.fillRect(handleX, handleY, handleSize, handleSize);
          context.strokeRect(handleX, handleY, handleSize, handleSize);
        });
      }
    });
    drawFootLandmarkOverlay(context, footLandmarks, canvas.width, canvas.height, activeFootLandmark, landmarkDisplaySize);
  };

  useEffect(() => {
    drawRoiSetupFrame();
  }, [activeFootLandmark, activeRoi, footLandmarks, forefootEnabled, landmarkDisplaySize, leftRightOrientation, lowerBodyMethod, roiFrameReady, roiFrameRevision, roiLayout, rois]);

  const captureRoiSetupFrame = async (requestedTime = videoTime) => {
    if (!videoSrc) return;
    let probe = null;
    const requestId = roiFrameRequestRef.current + 1;
    roiFrameRequestRef.current = requestId;
    const targetTime = clamp(Number(requestedTime) || 0, 0, Number(videoDuration) || Number.MAX_SAFE_INTEGER);
    setLoadingRoiFrame(true);
    try {
      probe = document.createElement("video");
      probe.src = videoSrc;
      probe.muted = true;
      probe.playsInline = true;
      probe.preload = "auto";
      await waitForVideoMetadata(probe);
      await waitForVideoPixels(probe);
      const frameTime = clamp(targetTime, 0, Number(probe.duration) || 0);
      await seekVideo(probe, frameTime);
      await waitForVideoPixels(probe);
      const frame = document.createElement("canvas");
      frame.width = probe.videoWidth;
      frame.height = probe.videoHeight;
      frame.getContext("2d")?.drawImage(probe, 0, 0, frame.width, frame.height);
      if (roiFrameRequestRef.current !== requestId) return;
      roiFrameCanvasRef.current = frame;
      setRoiSetupTime(frameTime);
      setRoiFrameRevision((current) => current + 1);
      setRoiFrameReady(true);
    } catch (caughtError) {
      setError(caughtError?.message || "The analysis-region preview could not be captured.");
    } finally {
      if (probe) {
        probe.pause();
        probe.src = "";
      }
      if (roiFrameRequestRef.current === requestId) setLoadingRoiFrame(false);
    }
  };

  const navigateRoiSetupFrame = (timeS) => {
    const nextTime = clamp(Number(timeS) || 0, 0, Number(videoDuration) || 0);
    captureRoiSetupFrame(nextTime);
    if (syncRoiWithMainPlayer) onSeek?.(nextTime);
  };

  const createRegionSegment = (label, startTimeS, source = null, preserveCalibration = false) => ({
    id: `region-segment-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    label,
    startTimeS: roundedTime(startTimeS),
    endTimeS: null,
    rois: copyRois(source?.rois || rois),
    roiLayout: source?.roiLayout || roiLayout,
    forefootEnabled: source?.forefootEnabled ?? forefootEnabled,
    postureMatchingEnabled: source?.postureMatchingEnabled ?? postureMatchingEnabled,
    postureReferenceTimes: preserveCalibration
      ? copyPostureReferenceTimes(source?.postureReferenceTimes || postureReferenceTimes)
      : emptyPostureReferenceTimes(),
    handBehaviorMatchingEnabled: source?.handBehaviorMatchingEnabled ?? handBehaviorMatchingEnabled,
    handBehaviorReferenceTimes: preserveCalibration
      ? copyHandBehaviorReferenceTimes(source?.handBehaviorReferenceTimes || handBehaviorReferenceTimes)
      : emptyHandBehaviorReferenceTimes(),
    footLandmarks: preserveCalibration
      ? copyFootLandmarks(source?.footLandmarks || footLandmarks)
      : emptyFootLandmarks(),
    leftRightOrientation: source?.leftRightOrientation || leftRightOrientation,
  });

  const loadRegionSegment = (segment, seekToStart = false) => {
    if (!segment) return;
    setSelectedRegionSegmentId(segment.id);
    setRois(copyRois(segment.rois));
    setRoiLayout(segment.roiLayout);
    setForefootEnabled(segment.forefootEnabled);
    setPostureMatchingEnabled(segment.postureMatchingEnabled);
    setPostureReferenceTimes(copyPostureReferenceTimes(segment.postureReferenceTimes));
    setHandBehaviorMatchingEnabled(segment.handBehaviorMatchingEnabled ?? true);
    setHandBehaviorReferenceTimes(copyHandBehaviorReferenceTimes(segment.handBehaviorReferenceTimes));
    setFootLandmarks(copyFootLandmarks(segment.footLandmarks));
    setLeftRightOrientation(segment.leftRightOrientation);
    if (seekToStart) navigateRoiSetupFrame(segment.startTimeS);
  };

  const addPositionChange = (copyPrevious = false) => {
    const positionTime = roundedTime(roiFrameReady ? roiSetupTime : videoTime);
    const currentSegments = orderedRegionSegments;
    if (!currentSegments.length) {
      const initial = createRegionSegment("Initial position", 0, null, true);
      if (positionTime <= 0) {
        setRegionSegments([initial]);
        loadRegionSegment(initial);
        return;
      }
      const next = createRegionSegment(`Position change ${formatTime(positionTime)}`, positionTime, initial);
      setRegionSegments(normalizeRegionSegments([initial, next]));
      loadRegionSegment(next, true);
      return;
    }
    const matching = currentSegments.find((segment) => Math.abs(segment.startTimeS - positionTime) < 0.1);
    if (matching) {
      loadRegionSegment(matching, true);
      return;
    }
    const source = copyPrevious
      ? regionSegmentAtTime(currentSegments, Math.max(0, positionTime - 0.1))
      : (selectedRegionSegment || regionSegmentAtTime(currentSegments, positionTime));
    const next = createRegionSegment(`Position change ${formatTime(positionTime)}`, positionTime, source);
    setRegionSegments(normalizeRegionSegments([...currentSegments, next]));
    loadRegionSegment(next, true);
  };

  const updateSelectedRegionSegment = (updates) => {
    if (!selectedRegionSegmentId) return;
    setRegionSegments((current) => normalizeRegionSegments(current.map((segment) => (
      segment.id === selectedRegionSegmentId ? { ...segment, ...updates } : segment
    ))));
  };

  const deleteSelectedRegionSegment = () => {
    if (!selectedRegionSegment) return;
    const remaining = orderedRegionSegments.filter((segment) => segment.id !== selectedRegionSegment.id);
    if (!remaining.length) {
      setRegionSegments([]);
      setSelectedRegionSegmentId(null);
      return;
    }
    setRegionSegments(normalizeRegionSegments(remaining));
    const next = regionSegmentAtTime(remaining, videoTime) || remaining[0];
    loadRegionSegment(next, true);
  };

  useEffect(() => {
    if (!selectedRegionSegmentId) return;
    setRegionSegments((current) => normalizeRegionSegments(current.map((segment) => (
      segment.id === selectedRegionSegmentId
        ? {
          ...segment,
          rois: copyRois(rois),
          roiLayout,
          forefootEnabled,
          postureMatchingEnabled,
          postureReferenceTimes: copyPostureReferenceTimes(postureReferenceTimes),
          handBehaviorMatchingEnabled,
          handBehaviorReferenceTimes: copyHandBehaviorReferenceTimes(handBehaviorReferenceTimes),
          footLandmarks: copyFootLandmarks(footLandmarks),
          leftRightOrientation,
        }
        : segment
    ))));
  }, [footLandmarks, forefootEnabled, handBehaviorMatchingEnabled, handBehaviorReferenceTimes, leftRightOrientation, postureMatchingEnabled, postureReferenceTimes, roiLayout, rois, selectedRegionSegmentId]);

  useEffect(() => {
    if (!videoPlaying || !activeRegionSegment || activeRegionSegment.id === selectedRegionSegmentId || running) return;
    loadRegionSegment(activeRegionSegment);
  }, [activeRegionSegment, running, selectedRegionSegmentId, videoPlaying]);

  useEffect(() => {
    if (!roiFrameReady || running || !orderedRegionSegments.length) return;
    const frameSegment = regionSegmentAtTime(orderedRegionSegments, roiSetupTime);
    if (!frameSegment || frameSegment.id === selectedRegionSegmentId) return;
    loadRegionSegment(frameSegment);
  }, [orderedRegionSegments, roiFrameReady, roiSetupTime, running, selectedRegionSegmentId]);

  useEffect(() => {
    if (!roiFrameReady || !syncRoiWithMainPlayer || videoPlaying || running) return;
    if (Math.abs(Number(videoTime) - Number(roiSetupTime)) < 0.05) return;
    captureRoiSetupFrame(videoTime);
  }, [roiFrameReady, roiSetupTime, running, syncRoiWithMainPlayer, videoPlaying, videoTime]);

  const handleRoiMouseDown = (event) => {
    if (running || roiLayout === "full" || !roiFrameReady) return;
    const canvas = event.currentTarget;
    const start = pointerToCanvasFrame(event, canvas);
    if (!start) return;
    if (landmarkPlacementEnabled && mode !== "hands") {
      setFootLandmarks((current) => ({
        ...current,
        [activeFootLandmark]: { x: start.x, y: start.y },
      }));
      return;
    }
    const selectedRoi = rois[activeRoi];
    const resizeCorner = selectedRoi ? findRoiResizeCorner(start, selectedRoi) : null;
    const visibleRoiKeys = [
      "leftLowerBody",
      "rightLowerBody",
      ...(forefootEnabled && lowerBodyMethod === "regionMotion" ? ["leftForefoot", "rightForefoot"] : []),
      "hands",
    ];
    const clickedKey = !resizeCorner
      ? visibleRoiKeys
        .filter((key) => pointInsideRoi(start, rois[key]))
        .sort((first, second) => (
          (rois[first].width * rois[first].height) - (rois[second].width * rois[second].height)
        ))[0] || null
      : activeRoi;
    const movingKey = !resizeCorner ? clickedKey : null;
    if (clickedKey && clickedKey !== activeRoi) setActiveRoi(clickedKey);
    const initialRoi = resizeCorner ? selectedRoi : movingKey ? rois[movingKey] : null;
    roiDragStartRef.current = start;
    const onMove = (moveEvent) => {
      const current = pointerToCanvasFrame(moveEvent, canvas, true);
      if (!current) return;
      if (resizeCorner && initialRoi) {
        setRois((existing) => ({
          ...existing,
          [activeRoi]: resizeRoiFromCorner(initialRoi, resizeCorner, current),
        }));
        return;
      }
      if (movingKey && initialRoi) {
        const x = clamp(initialRoi.x + current.x - start.x, 0, 1 - initialRoi.width);
        const y = clamp(initialRoi.y + current.y - start.y, 0, 1 - initialRoi.height);
        setRois((existing) => ({
          ...existing,
          [movingKey]: { ...initialRoi, x, y },
        }));
        return;
      }
      const x = Math.min(start.x, current.x);
      const y = Math.min(start.y, current.y);
      const width = Math.max(ROI_MIN_SIZE, Math.abs(start.x - current.x));
      const height = Math.max(ROI_MIN_SIZE, Math.abs(start.y - current.y));
      setRois((existing) => ({
        ...existing,
        [activeRoi]: { x, y, width: Math.min(width, 1 - x), height: Math.min(height, 1 - y) },
      }));
    };
    const onUp = () => {
      roiDragStartRef.current = null;
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  };

  const analyze = async () => {
    if (!videoSrc || running) return;
    stopRequestedRef.current = false;
    setRunning(true);
    setProgress(0);
    setError("");
    setResult(null);
    setSaved(false);
    setDismissedSuggestionIds([]);
    setAcceptedSuggestionIds([]);
    setExpandedPeakClusters([]);
    previewReadyRef.current = false;
    setPreviewReady(false);

    let poseLandmarker = null;
    let leftPoseLandmarker = null;
    let rightPoseLandmarker = null;
    let handLandmarker = null;
    let probe = null;
    const poseCropCanvas = document.createElement("canvas");
    const leftPoseCropCanvas = document.createElement("canvas");
    const rightPoseCropCanvas = document.createElement("canvas");
    const handCropCanvas = document.createElement("canvas");
    const leftMotionCanvas = document.createElement("canvas");
    const rightMotionCanvas = document.createElement("canvas");
    const leftForefootMotionCanvas = document.createElement("canvas");
    const rightForefootMotionCanvas = document.createElement("canvas");
    const leftMarkerCanvas = document.createElement("canvas");
    const rightMarkerCanvas = document.createElement("canvas");
    const analysisRois = resolveRois(roiLayout, rois);
    const analysisRegionSegments = orderedRegionSegments.map((segment) => ({
      ...segment,
      appliedRois: resolveRois(segment.roiLayout, segment.rois),
      lowerBodyMethod: segment.roiLayout === "pip" ? lowerBodyMethod : "landmarks",
    }));
    const defaultFrameConfiguration = {
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
    const frameConfigurations = analysisRegionSegments.length ? analysisRegionSegments : [defaultFrameConfiguration];
    const analyzePostureAppearance = mode !== "hands" && frameConfigurations.some((configuration) => (
      configuration.lowerBodyMethod === "regionMotion" && configuration.postureMatchingEnabled
    ));
    const analyzeHandBehavior = mode !== "legs" && frameConfigurations.some((configuration) => (
      configuration.handBehaviorMatchingEnabled ?? handBehaviorMatchingEnabled
    ));
    try {
      const { FilesetResolver, PoseLandmarker, HandLandmarker } = await import("@mediapipe/tasks-vision");
      const vision = await FilesetResolver.forVisionTasks(WASM_ROOT);
      if ((mode === "legs" || mode === "combined") && frameConfigurations.some((configuration) => configuration.lowerBodyMethod === "landmarks")) {
        const poseOptions = {
          baseOptions: { modelAssetPath: POSE_MODEL_URL },
          runningMode: "VIDEO",
          numPoses: 1,
          minPoseDetectionConfidence: 0.45,
          minPosePresenceConfidence: 0.45,
          minTrackingConfidence: 0.45,
        };
        if (frameConfigurations.some((configuration) => configuration.lowerBodyMethod === "landmarks" && configuration.roiLayout === "pip")) {
          leftPoseLandmarker = await PoseLandmarker.createFromOptions(vision, poseOptions);
          rightPoseLandmarker = await PoseLandmarker.createFromOptions(vision, poseOptions);
        }
        if (frameConfigurations.some((configuration) => configuration.lowerBodyMethod === "landmarks" && configuration.roiLayout === "full")) {
          poseLandmarker = await PoseLandmarker.createFromOptions(vision, poseOptions);
        }
      }
      if (mode === "hands" || mode === "combined") {
        handLandmarker = await HandLandmarker.createFromOptions(vision, {
          baseOptions: { modelAssetPath: HAND_MODEL_URL },
          runningMode: "VIDEO",
          numHands: 2,
          minHandDetectionConfidence: 0.4,
          minHandPresenceConfidence: 0.4,
          minTrackingConfidence: 0.4,
        });
      }

      probe = document.createElement("video");
      probe.src = videoSrc;
      probe.muted = true;
      probe.playsInline = true;
      probe.preload = "auto";
      await waitForVideoMetadata(probe);
      await waitForVideoPixels(probe);

      const probeDuration = Number(probe.duration) || 0;
      const center = clamp(Number(videoTime) || 0, 0, probeDuration);
      const start = windowMode === "full" ? 0 : Math.max(0, center - 60);
      const end = windowMode === "full" ? probeDuration : Math.min(probeDuration, center + 60);
      const step = 1 / selectedMode.fps;
      const expectedSamples = Math.max(1, Math.floor((end - start) / step) + 1);
      const rawSamples = [];
      let previousLegs = { left: null, right: null };
      let previousHands = null;
      let previousRegionFrames = {
        left: null,
        right: null,
        leftForefoot: null,
        rightForefoot: null,
      };
      let previousRegionSegmentId = null;
      let processed = 0;

      for (let timeS = start; timeS <= end + 0.001; timeS += step) {
        if (stopRequestedRef.current) break;
        await seekVideo(probe, Math.min(timeS, end));
        const timestamp = Math.round(timeS * 1000);
        const segment = analysisRegionSegments.length ? regionSegmentAtTime(analysisRegionSegments, timeS) : null;
        const frameConfiguration = segment || defaultFrameConfiguration;
        const frameRois = frameConfiguration.appliedRois;
        const frameLowerBodyMethod = frameConfiguration.lowerBodyMethod;
        const frameForefootEnabled = mode !== "hands"
          && frameLowerBodyMethod === "regionMotion"
          && frameConfiguration.forefootEnabled;
        const framePostureMatchingEnabled = mode !== "hands"
          && frameLowerBodyMethod === "regionMotion"
          && frameConfiguration.postureMatchingEnabled;
        const regionSegmentId = segment?.id || null;
        const regionBoundary = analysisRegionSegments.length > 0
          && previousRegionSegmentId !== null
          && regionSegmentId !== previousRegionSegmentId;
        if (regionBoundary) {
          previousLegs = { left: null, right: null };
          previousHands = null;
          previousRegionFrames = {
            left: null,
            right: null,
            leftForefoot: null,
            rightForefoot: null,
          };
        }
        const poseSource = poseLandmarker && frameLowerBodyMethod === "landmarks" && frameConfiguration.roiLayout === "full"
          ? drawVideoCrop(probe, frameRois.leftLowerBody, poseCropCanvas)
          : null;
        const leftPoseSource = leftPoseLandmarker && frameLowerBodyMethod === "landmarks" && frameConfiguration.roiLayout === "pip"
          ? drawVideoCrop(probe, frameRois.leftLowerBody, leftPoseCropCanvas)
          : null;
        const rightPoseSource = rightPoseLandmarker && frameLowerBodyMethod === "landmarks" && frameConfiguration.roiLayout === "pip"
          ? drawVideoCrop(probe, frameRois.rightLowerBody, rightPoseCropCanvas)
          : null;
        const handSource = drawVideoCrop(probe, frameRois.hands, handCropCanvas);
        const poseResult = poseSource ? poseLandmarker.detectForVideo(poseSource, timestamp) : null;
        const leftPoseResult = leftPoseSource ? leftPoseLandmarker.detectForVideo(leftPoseSource, timestamp) : null;
        const rightPoseResult = rightPoseSource ? rightPoseLandmarker.detectForVideo(rightPoseSource, timestamp) : null;
        const handResult = handLandmarker ? handLandmarker.detectForVideo(handSource, timestamp) : null;
        const legs = frameLowerBodyMethod === "landmarks"
          ? (frameConfiguration.roiLayout === "pip"
            ? { left: extractRegionLeg(leftPoseResult)?.points || null, right: extractRegionLeg(rightPoseResult)?.points || null }
            : extractLegSides(poseResult))
          : null;
        const legPreview = frameLowerBodyMethod === "regionMotion"
          ? { regionMotion: true, forefootEnabled: frameForefootEnabled }
          : (frameConfiguration.roiLayout === "pip"
            ? { left: extractRegionLeg(leftPoseResult), right: extractRegionLeg(rightPoseResult) }
            : { fullResult: poseResult });
        const hands = extractHands(handResult);
        if (previewEnabledRef.current) {
          const frameDrawn = drawPreviewFrame(
            previewCanvasRef.current,
            probe,
            legPreview,
            handResult,
            previewLegsRef.current && mode !== "hands",
            previewHandsRef.current && mode !== "legs",
            frameRois,
            frameConfiguration.leftRightOrientation,
          );
          if (frameDrawn && !previewReadyRef.current) {
            previewReadyRef.current = true;
            setPreviewReady(true);
          }
        }
        const regionFrames = frameLowerBodyMethod === "regionMotion"
          ? {
            left: readRoiGrayscale(probe, frameRois.leftLowerBody, leftMotionCanvas),
            right: readRoiGrayscale(probe, frameRois.rightLowerBody, rightMotionCanvas),
            leftForefoot: frameForefootEnabled ? readRoiGrayscale(probe, frameRois.leftForefoot, leftForefootMotionCanvas) : null,
            rightForefoot: frameForefootEnabled ? readRoiGrayscale(probe, frameRois.rightForefoot, rightForefootMotionCanvas) : null,
          }
          : null;
        const leftValue = frameLowerBodyMethod === "regionMotion"
          ? regionPixelMotion(regionFrames.left, previousRegionFrames.left)
          : sideMotion(legs?.left, previousLegs.left);
        const rightValue = frameLowerBodyMethod === "regionMotion"
          ? regionPixelMotion(regionFrames.right, previousRegionFrames.right)
          : sideMotion(legs?.right, previousLegs.right);
        const leftForefootValue = frameForefootEnabled
          ? regionPixelMotion(regionFrames.leftForefoot, previousRegionFrames.leftForefoot)
          : null;
        const rightForefootValue = frameForefootEnabled
          ? regionPixelMotion(regionFrames.rightForefoot, previousRegionFrames.rightForefoot)
          : null;
        const footMarkerGeometry = mode !== "hands"
          && frameLowerBodyMethod === "regionMotion"
          && frameConfiguration.roiLayout === "pip"
          ? buildMarkerFootGeometry(
            detectReflectiveMarkerPoints(probe, frameRois.leftLowerBody, leftMarkerCanvas),
            detectReflectiveMarkerPoints(probe, frameRois.rightLowerBody, rightMarkerCanvas),
          )
          : null;
        const handValue = handMotion(hands, previousHands);
        const handVector = dominantHandVector(hands, previousHands);
        if (mode === "combined" || mode === "legs") {
          rawSamples.push({
            timeS,
            leftMotion: leftValue,
            rightMotion: rightValue,
            leftForefootMotion: leftForefootValue,
            rightForefootMotion: rightForefootValue,
            footMarkerGeometry,
            handMotion: mode === "combined" ? handValue : null,
            handDx: mode === "combined" ? handVector?.dx : null,
            handDy: mode === "combined" ? handVector?.dy : null,
            leftAppearance: framePostureMatchingEnabled ? appearanceSignature(regionFrames.left) : null,
            rightAppearance: framePostureMatchingEnabled ? appearanceSignature(regionFrames.right) : null,
            leftDetected: frameLowerBodyMethod === "regionMotion" ? leftValue != null : !!legs?.left,
            rightDetected: frameLowerBodyMethod === "regionMotion" ? rightValue != null : !!legs?.right,
            legsDetected: frameLowerBodyMethod === "regionMotion" ? leftValue != null || rightValue != null : !!legs?.left || !!legs?.right,
            handsDetected: !!hands,
            detected: frameLowerBodyMethod === "regionMotion"
              ? leftValue != null || rightValue != null || (mode === "combined" && !!hands)
              : !!legs?.left || !!legs?.right || (mode === "combined" && !!hands),
            regionSegmentId,
            regionSegmentLabel: segment?.label || null,
            regionBoundary,
          });
        } else {
          rawSamples.push({
            timeS,
            motion: handValue,
            handDx: handVector?.dx,
            handDy: handVector?.dy,
            handsDetected: !!hands,
            detected: !!hands,
            regionSegmentId,
            regionSegmentLabel: segment?.label || null,
            regionBoundary,
          });
        }
        previousLegs = {
          left: legs?.left || previousLegs.left,
          right: legs?.right || previousLegs.right,
        };
        previousHands = hands || previousHands;
        if (regionFrames) previousRegionFrames = regionFrames;
        previousRegionSegmentId = regionSegmentId;
        processed += 1;
        if (processed % 5 === 0 || processed === expectedSamples) {
          setProgress(Math.min(100, Math.round((processed / expectedSamples) * 100)));
          await new Promise((resolve) => window.setTimeout(resolve, 0));
        }
      }

      if (!rawSamples.length) return;
      const hasLegs = mode !== "hands";
      const hasHands = mode !== "legs";
      const hasForefoot = hasLegs && rawSamples.some((sample) => (
        sample.leftForefootMotion != null || sample.rightForefootMotion != null
      ));
      const lowerBodyMethods = [...new Set(frameConfigurations.map((configuration) => configuration.lowerBodyMethod))];
      const samples = hasLegs ? normalizeTrackedSamples(rawSamples, hasHands) : normalizeSingleSamples(rawSamples);
      const detectedSamples = samples.filter((sample) => sample.detected);
      const coverage = Math.round((detectedSamples.length / samples.length) * 100);
      const moments = selectReviewMoments(samples, mode);
      const nextResult = {
        mode,
        samples,
        moments,
        coverage,
        hasLegs,
        hasHands,
        hasForefoot,
        lowerBodyMethod: lowerBodyMethods.length === 1 ? lowerBodyMethods[0] : "mixed_segmented",
        leftRightOrientation,
        sampleRate: selectedMode.fps,
        roiLayout,
        rois: analysisRois,
        regionSegments: analysisRegionSegments,
        footLandmarks: copyFootLandmarks(footLandmarks),
        footLandmarkGeometry,
        postureReferenceTimes,
        handBehaviorReferenceTimes,
        leftCoverage: hasLegs
          ? Math.round((samples.filter((sample) => sample.leftDetected).length / samples.length) * 100)
          : null,
        rightCoverage: hasLegs
          ? Math.round((samples.filter((sample) => sample.rightDetected).length / samples.length) * 100)
          : null,
        handCoverage: hasHands
          ? Math.round((samples.filter((sample) => sample.handsDetected).length / samples.length) * 100)
          : null,
        leftAverage: hasLegs ? averageScore(samples, "leftScore") : null,
        rightAverage: hasLegs ? averageScore(samples, "rightScore") : null,
        leftForefootAverage: hasForefoot ? averageScore(samples, "leftForefootScore") : null,
        rightForefootAverage: hasForefoot ? averageScore(samples, "rightForefootScore") : null,
        handAverage: hasHands ? averageScore(samples, hasLegs ? "handScore" : "score") : null,
        start,
        end,
        stopped: stopRequestedRef.current,
        averageActivity: Math.round(mean(detectedSamples.map((sample) => sample.score)) || 0),
        peakActivity: Math.round(Math.max(0, ...detectedSamples.map((sample) => sample.score))),
      };
      nextResult.footGeometryTracking = hasLegs ? buildFootGeometryTrackingSummary(samples, selectedMode.fps) : null;
      nextResult.asymmetry = hasLegs ? calculateAsymmetry(samples) : null;
      nextResult.lowerBodyPatterns = hasLegs ? calculateLowerBodyPatternSummary(samples, selectedMode.fps) : null;
      nextResult.postureGeometry = hasLegs && analyzePostureAppearance
        ? buildPostureAppearanceResult(samples, analysisRegionSegments, postureReferenceTimes, selectedMode.fps)
        : null;
      nextResult.handRhythm = hasHands
        ? calculateHandRhythmSummary(samples, hasLegs ? "handScore" : "score", nextResult.handCoverage, selectedMode.fps)
        : null;
      nextResult.handBehavior = hasHands && analyzeHandBehavior
        ? buildHandBehaviorResult(
          samples,
          analysisRegionSegments,
          hasLegs ? "handScore" : "score",
          nextResult.handCoverage,
          selectedMode.fps,
          handBehaviorReferenceTimes,
        )
        : null;
      nextResult.findings = buildFindings(nextResult);
      if (hasLegs && footLandmarkGeometry.marked_count > 0) {
        nextResult.findings.unshift(`Manual foot landmark geometry was available for review (${footLandmarkGeometry.marked_count}/${footLandmarkGeometry.expected_count} landmarks marked; fan angle ${footLandmarkGeometry.fan_angle_deg ?? "not available"}°).`);
      }
      setResult(nextResult);
    } catch (caughtError) {
      setError(caughtError?.message || "Motion analysis could not be completed.");
    } finally {
      poseLandmarker?.close?.();
      leftPoseLandmarker?.close?.();
      rightPoseLandmarker?.close?.();
      handLandmarker?.close?.();
      if (probe) {
        probe.pause();
        probe.src = "";
      }
      setRunning(false);
    }
  };

  const saveSummaryForAI = async () => {
    if (!result || !selectedSession || !onSaveSummary) return;
    setSaving(true);
    setError("");
    try {
      const finalizedMotionEvents = motionSuggestions
        .filter((suggestion) => acceptedSuggestionIds.includes(suggestion.id))
        .map(motionSuggestionEvent);
      await onSaveSummary(buildSavedSummary(result), finalizedMotionEvents);
      setSaved(true);
    } catch (caughtError) {
      setError(caughtError?.message || "The motion summary could not be saved to this session.");
    } finally {
      setSaving(false);
    }
  };

  const acceptSuggestions = async (suggestions) => {
    if (!suggestions.length || !selectedSession || !onAcceptSuggestions) return;
    setAcceptingSuggestions(true);
    setError("");
    try {
      await onAcceptSuggestions(suggestions.map(motionSuggestionEvent));
      setAcceptedSuggestionIds((current) => [...new Set([...current, ...suggestions.map((suggestion) => suggestion.id)])]);
    } catch (caughtError) {
      setError(caughtError?.message || "The motion-derived event suggestions could not be saved.");
    } finally {
      setAcceptingSuggestions(false);
    }
  };

  const ModeIcon = selectedMode.icon;
  const scrollToMotionSection = (id) => {
    if (typeof document === "undefined") return;
    document.getElementById(id)?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  return (
    <div id="motion-lab-top" className="relative rounded-xl border border-border bg-card p-4 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <Activity className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-primary">Local Motion Analysis</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Experimental local movement tracking for review support. Results remain temporary unless you explicitly save a compact summary to a selected session.
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              {analysisFeedLabel
                ? `${analysisFeedLabel} is configured independently. Finalize this derived result to combine its supported signals with other finalized feeds for the session.`
                : "Combined tracking expects both views in one composite video; separate feeds can be configured and finalized independently."}
            </p>
          </div>
        </div>
        <div className="inline-flex items-center gap-1.5 rounded-full border border-primary/25 bg-primary/[0.08] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-primary">
          <ShieldCheck className="h-3 w-3" />
          Local video only
        </div>
      </div>

      <div className="rounded-xl border border-primary/20 bg-primary/[0.04] p-3 space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={analyze}
            disabled={!videoSrc || running}
            className="inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:opacity-45"
          >
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <ModeIcon className="h-4 w-4" />}
            {running ? `Analyzing ${progress}%` : `Analyze ${selectedMode.label}`}
          </button>
          {running && (
            <button
              type="button"
              onClick={stopAnalysis}
              className="inline-flex h-10 items-center gap-2 rounded-lg border border-border px-4 text-sm font-semibold text-foreground transition-colors hover:bg-muted/50"
            >
              <Square className="h-3.5 w-3.5" />
              Stop
            </button>
          )}
          <span className="rounded-full border border-border bg-card px-2.5 py-1 text-[11px] text-muted-foreground">
            {selectedMode.label}
          </span>
          <span className="rounded-full border border-border bg-card px-2.5 py-1 text-[11px] text-muted-foreground">
            {windowMode === "full" ? "Entire recording" : "Current position +/- 1 min"}
          </span>
          {mode !== "hands" && (
            <span className="rounded-full border border-border bg-card px-2.5 py-1 text-[11px] text-muted-foreground">
              {roiLayout === "pip" ? "Upper-left inset" : "Full frame"}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => setSetupExpanded((current) => !current)}
            className={`inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${setupExpanded ? "border-primary/35 bg-primary/10 text-primary" : "border-border bg-card text-foreground hover:border-primary/35"}`}
          >
            <Settings2 className="h-3.5 w-3.5" />
            Analysis setup
          </button>
          <button
            type="button"
            onClick={() => setRegionsExpanded((current) => !current)}
            className={`rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${regionsExpanded ? "border-primary/35 bg-primary/10 text-primary" : "border-border bg-card text-foreground hover:border-primary/35"}`}
          >
            Regions & calibration
          </button>
          <button
            type="button"
            onClick={() => setPreviewExpanded((current) => !current)}
            className={`rounded-lg border px-3 py-2 text-xs font-medium transition-colors ${previewExpanded ? "border-primary/35 bg-primary/10 text-primary" : "border-border bg-card text-foreground hover:border-primary/35"}`}
          >
            Analysis preview {previewEnabled ? "on" : "off"}
          </button>
          {!videoSrc && (
            <span className="text-xs text-muted-foreground">Load a local video to begin.</span>
          )}
        </div>
      </div>

      {setupExpanded && (
      <div className="space-y-3 rounded-lg border border-border bg-muted/10 p-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-primary">Analysis Setup</p>
        <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-foreground">Analysis signal</label>
          <Select value={mode} onValueChange={setMode} disabled={running}>
            <SelectTrigger className="h-10">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(MODES).map(([value, option]) => (
                <SelectItem key={value} value={value}>{option.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11px] leading-relaxed text-muted-foreground">{selectedMode.description}</p>
        </div>
        <div className="space-y-1.5">
          <label className="text-xs font-medium text-foreground">Analysis window</label>
          <Select value={windowMode} onValueChange={setWindowMode} disabled={running}>
            <SelectTrigger className="h-10">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="segment">Current position +/- 1 minute</SelectItem>
              <SelectItem value="full">Entire local recording</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-[11px] text-muted-foreground">
            {videoSrc && videoDuration
              ? `${formatTime(analysisRange.start)} to ${formatTime(analysisRange.end)} at ${selectedMode.fps} samples/second`
              : videoSrc
                ? `Timing will be read at start; ${selectedMode.fps} samples/second`
              : "Load a local video to begin."}
          </p>
        </div>
      </div>

      {mode !== "hands" && (
        <div className="rounded-lg border border-border bg-muted/10 p-3 space-y-2">
          <label className="text-xs font-medium text-foreground">Lower-body tracking method</label>
          <Select value={appliedLowerBodyMethod} onValueChange={setLowerBodyMethod} disabled={running || roiLayout === "full"}>
            <SelectTrigger className="h-10">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {Object.entries(LOWER_BODY_METHODS).map(([value, option]) => (
                <SelectItem key={value} value={value}>{option.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {roiLayout === "full"
              ? "Full-frame mode uses pose landmarks because separate left and right foot regions are not assigned."
              : LOWER_BODY_METHODS[appliedLowerBodyMethod].description}
          </p>
        </div>
      )}
      </div>
      )}

      {regionsExpanded && (
      <div className="rounded-lg border border-border bg-muted/10 p-3 space-y-3">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-primary">Analysis Regions</p>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              For your soles-facing upper-left inset, your anatomical left foot normally appears on screen right. Primary foot regions are enough for tracking; optional forefoot / toe-region boxes can be added when useful.
            </p>
          </div>
          <div className="inline-flex rounded-lg border border-border bg-card p-1 text-xs">
            <button
              type="button"
              onClick={() => {
                setRoiLayout("pip");
                setRois(copyRois(PIP_ROI_PRESET));
                setForefootEnabled(false);
                setLeftRightOrientation("anatomical_left_on_screen_right");
                setActiveRoi("leftLowerBody");
              }}
              disabled={running}
              className={`rounded-md px-3 py-2 font-semibold transition-colors ${roiLayout === "pip" ? "bg-primary text-primary-foreground shadow-sm" : "text-foreground hover:bg-muted/40"}`}
            >
              Upper-left inset
            </button>
            <button
              type="button"
              onClick={() => setRoiLayout("full")}
              disabled={running}
              className={`rounded-md px-3 py-2 font-semibold transition-colors ${roiLayout === "full" ? "bg-primary text-primary-foreground shadow-sm" : "text-foreground hover:bg-muted/40"}`}
            >
              Full frame
            </button>
          </div>
        </div>

        <div className="space-y-3 rounded-lg border border-primary/20 bg-primary/[0.04] p-3">
          <div className="flex flex-wrap items-start justify-between gap-2">
            <div>
              <p className="text-[10px] font-semibold uppercase tracking-wider text-primary">Region Segments / Position Changes</p>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                Optional. Mark a change when framing or body position shifts; later analysis will use the matching rectangles for each point in the video.
              </p>
            </div>
            <button
              type="button"
              onClick={() => addPositionChange(false)}
              disabled={!videoSrc || running}
              className="rounded-lg border border-primary/45 bg-primary/[0.12] px-3 py-2 text-xs font-semibold text-primary transition-colors hover:bg-primary/[0.2] disabled:cursor-not-allowed disabled:opacity-45"
            >
              Add Position Change at Current Time
            </button>
          </div>

          {orderedRegionSegments.length === 0 ? (
            <p className="rounded-md border border-border bg-card/50 px-3 py-2 text-[11px] text-muted-foreground">
              No position changes marked. The existing single set of analysis regions will be used for the entire selected analysis window.
            </p>
          ) : (
            <>
              <div className="flex flex-wrap gap-2">
                {orderedRegionSegments.map((segment) => (
                  <button
                    key={segment.id}
                    type="button"
                    onClick={() => loadRegionSegment(segment, true)}
                    disabled={running}
                    className={`rounded-lg border px-3 py-2 text-left text-[11px] transition-colors disabled:opacity-45 ${
                      selectedRegionSegment?.id === segment.id
                        ? "border-primary/55 bg-primary/[0.14] text-foreground"
                        : "border-border bg-card/50 text-muted-foreground hover:border-primary/35"
                    }`}
                  >
                    <span className="block font-semibold">{segment.label}</span>
                    <span className="font-mono">{formatTime(segment.startTimeS)}{segment.endTimeS != null ? ` - ${formatTime(segment.endTimeS)}` : " onward"}</span>
                    {activeRegionSegment?.id === segment.id && (
                      <span className="ml-2 rounded-full bg-primary/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase text-primary">Active</span>
                    )}
                  </button>
                ))}
              </div>

              {selectedRegionSegment && (
                <div className="space-y-2 rounded-lg border border-border bg-card/45 p-3">
                  <div className="grid gap-2 sm:grid-cols-[minmax(12rem,1fr)_auto]">
                    <label className="space-y-1">
                      <span className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Selected segment name</span>
                      <input
                        type="text"
                        value={selectedRegionSegment.label}
                        onChange={(event) => updateSelectedRegionSegment({ label: event.target.value || "Position change" })}
                        disabled={running}
                        className="h-9 w-full rounded-md border border-border bg-background px-2.5 text-xs text-foreground outline-none focus:border-primary/50 disabled:opacity-45"
                      />
                    </label>
                    <div className="flex items-end gap-2">
                      <button
                        type="button"
                        onClick={() => loadRegionSegment(selectedRegionSegment, true)}
                        disabled={running}
                        className="h-9 rounded-md border border-border bg-card px-3 text-xs font-medium text-foreground hover:border-primary/35 disabled:opacity-45"
                      >
                        Jump to start
                      </button>
                      <button
                        type="button"
                        onClick={deleteSelectedRegionSegment}
                        disabled={running}
                        className="h-9 rounded-md border border-border bg-card px-3 text-xs font-medium text-muted-foreground hover:border-destructive/40 hover:text-destructive disabled:opacity-45"
                      >
                        Delete
                      </button>
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-2">
                    {orderedRegionSegments[0]?.id !== selectedRegionSegment.id && (
                      <button
                        type="button"
                        onClick={() => {
                          const nextStart = roundedTime(roiFrameReady ? roiSetupTime : videoTime);
                          updateSelectedRegionSegment({ startTimeS: nextStart });
                        }}
                        disabled={running}
                        className="rounded-md border border-border bg-card px-2.5 py-1.5 text-[11px] font-medium text-foreground hover:border-primary/35 disabled:opacity-45"
                      >
                        Set start to current time
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => addPositionChange(true)}
                      disabled={running || !videoSrc}
                      className="rounded-md border border-border bg-card px-2.5 py-1.5 text-[11px] font-medium text-foreground hover:border-primary/35 disabled:opacity-45"
                    >
                      Duplicate previous at current time
                    </button>
                    {orderedRegionSegments.findIndex((segment) => segment.id === selectedRegionSegment.id) > 0 && (
                      <button
                        type="button"
                        onClick={() => {
                          const index = orderedRegionSegments.findIndex((segment) => segment.id === selectedRegionSegment.id);
                          const previous = orderedRegionSegments[index - 1];
                          const updated = {
                            ...selectedRegionSegment,
                            rois: copyRois(previous.rois),
                            roiLayout: previous.roiLayout,
                            forefootEnabled: previous.forefootEnabled,
                            postureMatchingEnabled: previous.postureMatchingEnabled,
                            leftRightOrientation: previous.leftRightOrientation,
                          };
                          setRegionSegments((current) => normalizeRegionSegments(current.map((segment) => (
                            segment.id === updated.id ? updated : segment
                          ))));
                          loadRegionSegment(updated);
                        }}
                        disabled={running}
                        className="rounded-md border border-border bg-card px-2.5 py-1.5 text-[11px] font-medium text-foreground hover:border-primary/35 disabled:opacity-45"
                      >
                        Copy regions from previous segment
                      </button>
                    )}
                    <button
                      type="button"
                      onClick={() => updateSelectedRegionSegment({
                        rois: copyRois(rois),
                        roiLayout,
                        forefootEnabled,
                        postureMatchingEnabled,
                        leftRightOrientation,
                      })}
                      disabled={running}
                      className="rounded-md border border-primary/30 bg-primary/[0.08] px-2.5 py-1.5 text-[11px] font-medium text-primary hover:bg-primary/[0.14] disabled:opacity-45"
                    >
                      Apply current regions to this segment
                    </button>
                  </div>
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    Foot posture and hand-motion examples marked below belong only to this position range. New position changes begin with empty reference marks so changed framing is not compared against an older view.
                  </p>
                </div>
              )}
              <p className="text-[10px] leading-relaxed text-muted-foreground">
                Analysis resets movement comparison at each position boundary so a rectangle change is not scored as a body-motion spike. Review values near boundaries against the video before interpretation.
              </p>
            </>
          )}
        </div>

        {roiLayout === "pip" ? (
          <>
            <div className="space-y-2">
              <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Click a region to edit</p>
              <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setActiveRoi("leftLowerBody")}
                disabled={running}
                className={`rounded-lg border px-3 py-2 text-xs font-semibold shadow-sm transition-all disabled:cursor-not-allowed disabled:opacity-45 ${activeRoi === "leftLowerBody" ? "border-primary bg-primary text-primary-foreground ring-1 ring-primary/30" : "border-primary/35 bg-primary/[0.08] text-primary hover:border-primary/65 hover:bg-primary/[0.15]"}`}
              >
                Edit your left foot ({anatomicalScreenSide(leftRightOrientation, "left")})
              </button>
              <button
                type="button"
                onClick={() => setActiveRoi("rightLowerBody")}
                disabled={running}
                className={`rounded-lg border px-3 py-2 text-xs font-semibold shadow-sm transition-all disabled:cursor-not-allowed disabled:opacity-45 ${activeRoi === "rightLowerBody" ? "border-[#f59e0b] bg-[#f59e0b]/20 text-[#fde68a] ring-1 ring-[#f59e0b]/25" : "border-[#f59e0b]/35 bg-[#f59e0b]/[0.08] text-[#fbbf24] hover:border-[#f59e0b]/65 hover:bg-[#f59e0b]/[0.15]"}`}
              >
                Edit your right foot ({anatomicalScreenSide(leftRightOrientation, "right")})
              </button>
              <button
                type="button"
                onClick={() => setActiveRoi("hands")}
                disabled={running}
                className={`rounded-lg border px-3 py-2 text-xs font-semibold shadow-sm transition-all disabled:cursor-not-allowed disabled:opacity-45 ${activeRoi === "hands" ? "border-[#a78bfa] bg-[#a78bfa]/20 text-[#ddd6fe] ring-1 ring-[#a78bfa]/25" : "border-[#a78bfa]/35 bg-[#a78bfa]/[0.08] text-[#c4b5fd] hover:border-[#a78bfa]/65 hover:bg-[#a78bfa]/[0.15]"}`}
              >
                Edit hands / main view
              </button>
              <button
                type="button"
                onClick={() => {
                  setRois((current) => ({
                    ...current,
                    leftLowerBody: copyRoi(PIP_ROI_PRESET.leftLowerBody),
                    rightLowerBody: copyRoi(PIP_ROI_PRESET.rightLowerBody),
                    leftForefoot: copyRoi(PIP_ROI_PRESET.leftForefoot),
                    rightForefoot: copyRoi(PIP_ROI_PRESET.rightForefoot),
                  }));
                  setLeftRightOrientation("anatomical_left_on_screen_right");
                }}
                disabled={running}
                className="rounded-lg border border-border bg-card px-3 py-2 text-xs font-semibold text-foreground shadow-sm transition-colors hover:border-primary/35 hover:bg-muted/30 disabled:cursor-not-allowed disabled:opacity-45"
              >
                Reset foot regions
              </button>
              <button
                type="button"
                onClick={() => {
                  setRois((current) => ({
                    ...current,
                    leftLowerBody: copyRoi(current.rightLowerBody),
                    rightLowerBody: copyRoi(current.leftLowerBody),
                    leftForefoot: copyRoi(current.rightForefoot),
                    rightForefoot: copyRoi(current.leftForefoot),
                  }));
                  setLeftRightOrientation((current) => (
                    current === "anatomical_left_on_screen_right"
                      ? "anatomical_left_on_screen_left"
                      : "anatomical_left_on_screen_right"
                  ));
                }}
                disabled={running}
                className="rounded-lg border border-border bg-card px-3 py-2 text-xs font-semibold text-foreground shadow-sm transition-colors hover:border-primary/35 hover:bg-muted/30 disabled:cursor-not-allowed disabled:opacity-45"
              >
                Mirror / swap left-right labels
              </button>
              </div>
            </div>
            {appliedLowerBodyMethod === "regionMotion" && (
              <div className="space-y-2 rounded-lg border border-border bg-card/40 p-3">
                <label className="inline-flex items-center gap-2 text-xs text-foreground">
                  <input
                    type="checkbox"
                    checked={forefootEnabled}
                    onChange={(event) => setForefootEnabled(event.target.checked)}
                    disabled={running}
                    className="h-3.5 w-3.5 accent-primary"
                  />
                  Enable optional forefoot / toe-region analysis
                </label>
                {forefootEnabled && (
                  <div className="space-y-2">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Optional regions to edit</p>
                    <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setActiveRoi("leftForefoot")}
                      disabled={running}
                      className={`rounded-lg border px-3 py-2 text-xs font-semibold shadow-sm transition-all disabled:cursor-not-allowed disabled:opacity-45 ${activeRoi === "leftForefoot" ? "border-[#2dd4bf] bg-[#2dd4bf]/20 text-[#99f6e4] ring-1 ring-[#2dd4bf]/25" : "border-[#2dd4bf]/35 bg-[#2dd4bf]/[0.08] text-[#5eead4] hover:border-[#2dd4bf]/65 hover:bg-[#2dd4bf]/[0.15]"}`}
                    >
                      Edit left forefoot / toe region
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveRoi("rightForefoot")}
                      disabled={running}
                      className={`rounded-lg border px-3 py-2 text-xs font-semibold shadow-sm transition-all disabled:cursor-not-allowed disabled:opacity-45 ${activeRoi === "rightForefoot" ? "border-[#fb923c] bg-[#fb923c]/20 text-[#fed7aa] ring-1 ring-[#fb923c]/25" : "border-[#fb923c]/35 bg-[#fb923c]/[0.08] text-[#fdba74] hover:border-[#fb923c]/65 hover:bg-[#fb923c]/[0.15]"}`}
                    >
                      Edit right forefoot / toe region
                    </button>
                    </div>
                  </div>
                )}
                <p className="text-[11px] text-muted-foreground">
                  This comparison is optional. Standard left/right foot tracking runs without it.
                </p>
              </div>
            )}
            {mode !== "hands" && appliedLowerBodyMethod === "regionMotion" && (
              <div className="space-y-3 rounded-lg border border-primary/20 bg-primary/[0.04] p-3">
                <label className="inline-flex items-center gap-2 text-xs font-medium text-foreground">
                  <input
                    type="checkbox"
                    checked={postureMatchingEnabled}
                    onChange={(event) => setPostureMatchingEnabled(event.target.checked)}
                    disabled={running}
                    className="h-3.5 w-3.5 accent-primary"
                  />
                  Enable calibrated foot appearance matching (experimental)
                </label>
                <p className="text-[11px] leading-relaxed text-muted-foreground">
                  Use the region editor below to find and mark visible reference moments in this video, then analyze a window containing those moments. The app compares later images inside your left/right foot rectangles to those marked appearances. Activity tracking still runs separately.
                </p>
                {selectedRegionSegment && (
                  <p className="rounded-md border border-primary/20 bg-primary/[0.06] px-2.5 py-1.5 text-[11px] text-primary">
                    These foot appearance marks apply only to <span className="font-semibold">{selectedRegionSegment.label}</span>.
                  </p>
                )}
                {postureMatchingEnabled && (
                  <>
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-primary">
                      Click to mark the current frame as
                    </p>
                    <div className="flex flex-wrap gap-2">
                      {POSTURE_REFERENCE_OPTIONS.map((option) => (
                        <button
                          key={option.key}
                          type="button"
                          onClick={() => setPostureReferenceTimes((current) => ({
                            ...current,
                            [option.key]: Math.round((Number(roiFrameReady ? roiSetupTime : videoTime) || 0) * 10) / 10,
                          }))}
                          disabled={!videoSrc || running || !roiFrameReady}
                          className={`rounded-lg border px-3 py-2 text-[11px] font-semibold shadow-sm transition-all disabled:cursor-not-allowed disabled:opacity-45 ${
                            postureReferenceTimes[option.key] != null
                              ? "border-primary/70 bg-primary/[0.18] text-primary ring-1 ring-primary/20"
                              : "border-primary/30 bg-primary/[0.06] text-primary hover:border-primary/60 hover:bg-primary/[0.13]"
                          }`}
                        >
                          {postureReferenceTimes[option.key] != null ? "Marked: " : "Mark: "}{option.label}
                          {postureReferenceTimes[option.key] != null && (
                            <span className="ml-1.5 font-mono">{formatTime(postureReferenceTimes[option.key])}</span>
                          )}
                        </button>
                      ))}
                      <button
                        type="button"
                        onClick={() => setPostureReferenceTimes(emptyPostureReferenceTimes())}
                        disabled={running}
                        className="rounded-lg border border-border bg-card px-3 py-2 text-[11px] font-semibold text-foreground shadow-sm transition-colors hover:border-primary/35 hover:bg-muted/30 disabled:cursor-not-allowed disabled:opacity-45"
                      >
                        Clear references
                      </button>
                    </div>
                    <p className="text-[11px] text-muted-foreground">
                      Required for matching: <span className="font-medium text-foreground">Neutral / relaxed</span> plus at least one named posture reference.
                    </p>
                  </>
                )}
              </div>
            )}
            {mode !== "legs" && (
              <HandBehaviorCalibration
                enabled={handBehaviorMatchingEnabled}
                onEnabledChange={setHandBehaviorMatchingEnabled}
                referenceTimes={handBehaviorReferenceTimes}
                onReferenceTimesChange={setHandBehaviorReferenceTimes}
                scopeLabel={selectedRegionSegment?.label}
                videoSrc={videoSrc}
                videoTime={roiFrameReady ? roiSetupTime : videoTime}
                running={running}
              />
            )}
            <div className="grid gap-2 text-[11px] text-muted-foreground sm:grid-cols-3">
              <p><span className="font-medium text-primary">Your left foot ({anatomicalScreenSide(leftRightOrientation, "left")}):</span> {formatRoiLabel(appliedRois.leftLowerBody)}</p>
              <p><span className="font-medium text-[#fbbf24]">Your right foot ({anatomicalScreenSide(leftRightOrientation, "right")}):</span> {formatRoiLabel(appliedRois.rightLowerBody)}</p>
              <p><span className="font-medium text-[#c4b5fd]">Hands / main:</span> {formatRoiLabel(appliedRois.hands)}</p>
              {appliedLowerBodyMethod === "regionMotion" && forefootEnabled && (
                <>
                  <p><span className="font-medium text-[#5eead4]">Left forefoot / toe region:</span> {formatRoiLabel(appliedRois.leftForefoot)}</p>
                  <p><span className="font-medium text-[#fdba74]">Right forefoot / toe region:</span> {formatRoiLabel(appliedRois.rightForefoot)}</p>
                </>
              )}
            </div>
          </>
        ) : (
          <>
            <p className="text-[11px] text-muted-foreground">
              Full-frame mode sends the complete video image to each enabled tracker. Use this for a single-camera view without an inset layout.
            </p>
            {mode !== "legs" && (
              <HandBehaviorCalibration
                enabled={handBehaviorMatchingEnabled}
                onEnabledChange={setHandBehaviorMatchingEnabled}
                referenceTimes={handBehaviorReferenceTimes}
                onReferenceTimesChange={setHandBehaviorReferenceTimes}
                scopeLabel={selectedRegionSegment?.label}
                videoSrc={videoSrc}
                videoTime={roiFrameReady ? roiSetupTime : videoTime}
                running={running}
              />
            )}
          </>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={() => captureRoiSetupFrame(videoTime)}
            disabled={!videoSrc || running || loadingRoiFrame}
            className="rounded-lg border border-primary/50 bg-primary/[0.12] px-4 py-2.5 text-xs font-semibold text-primary shadow-sm transition-colors hover:border-primary hover:bg-primary/[0.2] disabled:cursor-not-allowed disabled:opacity-45"
          >
            {loadingRoiFrame ? "Loading frame..." : "Open region editor at player position"}
          </button>
          <span className="text-[11px] text-muted-foreground">
            {roiFrameReady
              ? roiLayout === "pip" ? "Click any rectangle to select it, drag inside to move it, use white corner handles to resize, or drag elsewhere to redraw the selected region." : "The full frame will be analyzed."
              : "Load a local video, then capture a frame to adjust the regions."}
          </span>
        </div>

        {roiFrameReady && (
          <div className="space-y-2">
            <div className="space-y-2 rounded-lg border border-border bg-muted/10 p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-primary">Region Editor Position</p>
                <span className="font-mono text-sm font-semibold text-foreground">{formatTime(roiSetupTime)}</span>
              </div>
              <input
                type="range"
                min="0"
                max={Math.max(0, Number(videoDuration) || 0)}
                step="0.1"
                value={roiSetupTime}
                onChange={(event) => navigateRoiSetupFrame(Number(event.target.value))}
                disabled={running || loadingRoiFrame || !videoDuration}
                className="w-full accent-primary"
                aria-label="Region editor video position"
              />
              <div className="flex flex-wrap items-center gap-2">
                {[-5, -1, 1, 5].map((delta) => (
                  <button
                    key={delta}
                    type="button"
                    onClick={() => navigateRoiSetupFrame(roiSetupTime + delta)}
                    disabled={running || loadingRoiFrame}
                    className="rounded-md border border-border bg-card px-2.5 py-1 text-xs font-medium text-foreground transition-colors hover:border-primary/40 disabled:opacity-45"
                  >
                    {delta > 0 ? "+" : ""}{delta}s
                  </button>
                ))}
                <label className="inline-flex items-center gap-2 rounded-md border border-primary/25 bg-primary/[0.06] px-2.5 py-1 text-xs font-medium text-foreground">
                  <input
                    type="checkbox"
                    checked={syncRoiWithMainPlayer}
                    onChange={(event) => setSyncRoiWithMainPlayer(event.target.checked)}
                    disabled={running}
                    className="h-3.5 w-3.5 accent-primary"
                  />
                  Link with main player seeks
                </label>
                {!syncRoiWithMainPlayer && (
                  <button
                    type="button"
                    onClick={() => onSeek?.(roiSetupTime)}
                    disabled={running}
                    className="rounded-md border border-primary/30 bg-primary/[0.08] px-2.5 py-1 text-xs font-medium text-primary transition-colors hover:bg-primary/[0.14] disabled:opacity-45"
                  >
                    Seek main player here
                  </button>
                )}
                <span className="text-[11px] text-muted-foreground">Scrub here to find postures without leaving the rectangle editor.</span>
              </div>
            </div>
            {mode !== "hands" && (
              <div className="space-y-3 rounded-lg border border-[#38bdf8]/25 bg-[#38bdf8]/[0.05] p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wider text-[#7dd3fc]">Manual foot landmark calibration</p>
                    <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                      Optional review geometry for existing videos. Enable placement, choose a landmark, then click the paused frame. Points are saved as normalized source-frame coordinates.
                    </p>
                  </div>
                  <label className="inline-flex items-center gap-2 rounded-full border border-[#38bdf8]/30 bg-card/60 px-2.5 py-1 text-[11px] font-medium text-[#bae6fd]">
                    <input
                      type="checkbox"
                      checked={landmarkPlacementEnabled}
                      onChange={(event) => setLandmarkPlacementEnabled(event.target.checked)}
                      disabled={running || !roiFrameReady}
                      className="h-3.5 w-3.5 accent-[#38bdf8]"
                    />
                    Place landmarks
                  </label>
                </div>
                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                  {FOOT_LANDMARKS.map((landmark) => (
                    <button
                      key={landmark.key}
                      type="button"
                      onClick={() => {
                        setActiveFootLandmark(landmark.key);
                        setLandmarkPlacementEnabled(true);
                      }}
                      disabled={running || !roiFrameReady}
                      className={`rounded-lg border px-2.5 py-2 text-left text-[11px] font-semibold transition-all disabled:cursor-not-allowed disabled:opacity-45 ${
                        activeFootLandmark === landmark.key
                          ? "border-[#38bdf8] bg-[#38bdf8]/15 text-[#bae6fd] ring-1 ring-[#38bdf8]/20"
                          : "border-border bg-card/60 text-foreground hover:border-[#38bdf8]/35"
                      }`}
                    >
                      <span className="block">{landmark.label}</span>
                      <span className="mt-0.5 block font-mono text-[10px] text-muted-foreground">
                        {footLandmarks[landmark.key]
                          ? `${Math.round(footLandmarks[landmark.key].x * 100)}%, ${Math.round(footLandmarks[landmark.key].y * 100)}%`
                          : "not marked"}
                      </span>
                    </button>
                  ))}
                </div>
                <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-4">
                  <div className="rounded-lg border border-border bg-card/50 px-3 py-2"><p className="text-[10px] uppercase tracking-wider text-muted-foreground">Fan angle</p><p className="mt-1 font-mono text-base font-semibold text-foreground">{footLandmarkGeometry.fan_angle_deg != null ? `${footLandmarkGeometry.fan_angle_deg}°` : "—"}</p></div>
                  <div className="rounded-lg border border-border bg-card/50 px-3 py-2"><p className="text-[10px] uppercase tracking-wider text-muted-foreground">Toe / heel gap</p><p className="mt-1 font-mono text-base font-semibold text-foreground">{footLandmarkGeometry.toe_gap_normalized ?? "—"} / {footLandmarkGeometry.heel_gap_normalized ?? "—"}</p></div>
                  <div className="rounded-lg border border-border bg-card/50 px-3 py-2"><p className="text-[10px] uppercase tracking-wider text-muted-foreground">Left planted proxy</p><p className="mt-1 text-xs font-medium text-foreground">{plantedProxyLabel(footLandmarkGeometry.left_planted_proxy)}</p></div>
                  <div className="rounded-lg border border-border bg-card/50 px-3 py-2"><p className="text-[10px] uppercase tracking-wider text-muted-foreground">Right planted proxy</p><p className="mt-1 text-xs font-medium text-foreground">{plantedProxyLabel(footLandmarkGeometry.right_planted_proxy)}</p></div>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <button type="button" onClick={() => setRoiPreviewZoom((current) => Math.min(5, Math.round((current + 0.25) * 100) / 100))} disabled={running} className="rounded-md border border-border bg-card px-2.5 py-1.5 text-[11px] font-medium text-foreground hover:border-[#38bdf8]/35 disabled:opacity-45">Zoom +</button>
                  <button type="button" onClick={() => setRoiPreviewZoom((current) => Math.max(1, Math.round((current - 0.25) * 100) / 100))} disabled={running} className="rounded-md border border-border bg-card px-2.5 py-1.5 text-[11px] font-medium text-foreground hover:border-[#38bdf8]/35 disabled:opacity-45">Zoom -</button>
                  <button type="button" onClick={() => { setRoiPreviewZoom(2.5); setRoiPreviewPan({ x: 0, y: 0 }); }} disabled={running} className="rounded-md border border-border bg-card px-2.5 py-1.5 text-[11px] font-medium text-foreground hover:border-[#38bdf8]/35 disabled:opacity-45">Upper-left PiP zoom</button>
                  <button type="button" onClick={() => { setRoiPreviewZoom(1); setRoiPreviewPan({ x: 0, y: 0 }); }} disabled={running} className="rounded-md border border-border bg-card px-2.5 py-1.5 text-[11px] font-medium text-foreground hover:border-[#38bdf8]/35 disabled:opacity-45">Fit frame</button>
                  <button type="button" onClick={() => setRoiPreviewPan((current) => ({ ...current, x: current.x + 40 }))} disabled={running || roiPreviewZoom <= 1} className="rounded-md border border-border bg-card px-2 py-1.5 text-[11px] font-medium text-foreground hover:border-[#38bdf8]/35 disabled:opacity-45">Pan →</button>
                  <button type="button" onClick={() => setRoiPreviewPan((current) => ({ ...current, x: current.x - 40 }))} disabled={running || roiPreviewZoom <= 1} className="rounded-md border border-border bg-card px-2 py-1.5 text-[11px] font-medium text-foreground hover:border-[#38bdf8]/35 disabled:opacity-45">Pan ←</button>
                  <button type="button" onClick={() => setRoiPreviewPan((current) => ({ ...current, y: current.y + 40 }))} disabled={running || roiPreviewZoom <= 1} className="rounded-md border border-border bg-card px-2 py-1.5 text-[11px] font-medium text-foreground hover:border-[#38bdf8]/35 disabled:opacity-45">Pan ↓</button>
                  <button type="button" onClick={() => setRoiPreviewPan((current) => ({ ...current, y: current.y - 40 }))} disabled={running || roiPreviewZoom <= 1} className="rounded-md border border-border bg-card px-2 py-1.5 text-[11px] font-medium text-foreground hover:border-[#38bdf8]/35 disabled:opacity-45">Pan ↑</button>
                  <label className="inline-flex items-center gap-2 rounded-md border border-border bg-card px-2.5 py-1.5 text-[11px] text-foreground">Dot size<input type="range" min="4" max="16" value={landmarkDisplaySize} onChange={(event) => setLandmarkDisplaySize(Number(event.target.value))} className="w-20" /><span className="font-mono text-muted-foreground">{landmarkDisplaySize}px</span></label>
                  <button type="button" onClick={() => setFootLandmarks(emptyFootLandmarks())} disabled={running} className="rounded-md border border-border bg-card px-2.5 py-1.5 text-[11px] font-medium text-muted-foreground hover:border-destructive/40 hover:text-destructive disabled:opacity-45">Clear landmarks</button>
                </div>
                <p className="text-[11px] leading-relaxed text-muted-foreground">Zoom/pan only changes this placement view. Saved landmarks stay normalized to the source video frame, so geometry remains stable across preview zoom levels.</p>
              </div>
            )}
            <div className="overflow-hidden rounded-lg border border-border bg-black">
              <div
                style={{
                  transform: `translate(${roiPreviewPan.x}px, ${roiPreviewPan.y}px) scale(${roiPreviewZoom})`,
                  transformOrigin: "top left",
                }}
              >
                <canvas
                  ref={roiCanvasRef}
                  onMouseDown={handleRoiMouseDown}
                  className={`block aspect-video max-h-[52vh] w-full object-contain ${roiLayout === "pip" && !running ? "cursor-crosshair" : ""}`}
                />
              </div>
            </div>
            <p className="text-[11px] text-muted-foreground">
              These colored rectangles are the exact crop regions used for the next analysis. Click a rectangle to select it; white corner handles resize the selected region. Anatomical left/right assignment is shown above.
            </p>
          </div>
        )}
      </div>
      )}

      {previewExpanded && (
      <div className="rounded-lg border border-border bg-muted/10 p-3 space-y-3">
        <label className="inline-flex items-center gap-2 text-sm font-medium text-foreground">
          <input
            type="checkbox"
            checked={previewEnabled}
            onChange={(event) => setPreviewEnabled(event.target.checked)}
            className="h-4 w-4 accent-primary"
          />
          Show local analysis preview during analysis
        </label>
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          Displays the currently analyzed frame with temporary signal regions and available MediaPipe overlays in this browser only. Preview frames and landmarks are not saved.
        </p>
        {previewEnabled && (
          <>
            <div className="flex flex-wrap gap-2">
              {mode !== "hands" && (
                <label className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] text-foreground">
                  <input
                    type="checkbox"
                    checked={previewLegs}
                    onChange={(event) => setPreviewLegs(event.target.checked)}
                    className="h-3 w-3 accent-primary"
                  />
                  {appliedLowerBodyMethod === "regionMotion"
                    ? (postureMatchingEnabled ? "Foot signal regions + appearance matching" : "Foot signal regions")
                    : "Lower-body landmarks"}
                </label>
              )}
              {mode !== "legs" && (
                <label className="inline-flex items-center gap-1.5 rounded-full border border-border bg-card px-2.5 py-1 text-[11px] text-foreground">
                  <input
                    type="checkbox"
                    checked={previewHands}
                    onChange={(event) => setPreviewHands(event.target.checked)}
                    className="h-3 w-3 accent-[#a78bfa]"
                  />
                  Hand landmarks
                </label>
              )}
            </div>
            <div className="relative overflow-hidden rounded-lg border border-border bg-black">
              <canvas ref={previewCanvasRef} className="block aspect-video max-h-[52vh] w-full object-contain" />
              {!previewReady && (
                <div className="absolute inset-0 flex items-center justify-center px-4 text-center text-xs text-muted-foreground">
                  Run an analysis to see the temporary landmark overlay.
                </div>
              )}
            </div>
          </>
        )}
      </div>
      )}

      {error && (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {result && (
        <div className="space-y-4 border-t border-border pt-4">
          <div className="rounded-lg border border-primary/25 bg-primary/[0.07] px-3 py-2 text-sm text-foreground">
            <span className="font-semibold text-primary">Current analysis result.</span>{" "}
            This temporary trace reflects the most recent run and replaces the saved summary and saved motion-derived events only after you select <span className="font-medium">Finalize summary and replace saved motion events</span>.
          </div>
          <div className={`grid gap-2 ${result.hasLegs ? "sm:grid-cols-4" : "sm:grid-cols-3"}`}>
            <div className="rounded-lg bg-muted/25 px-3 py-2">
              <div className="flex items-center justify-between gap-2">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  {result.hasLegs ? (result.lowerBodyMethod === "regionMotion" ? "Left Signal Samples" : "Left Coverage") : "Detection Coverage"}
                </p>
                {result.lowerBodyMethod !== "regionMotion" && <QualityBadge coverage={result.hasLegs ? result.leftCoverage : result.coverage} />}
              </div>
              <p className="mt-1 font-mono text-lg font-semibold text-foreground">
                {result.hasLegs ? result.leftCoverage : result.coverage}%
              </p>
            </div>
            {result.hasLegs && (
              <div className="rounded-lg bg-muted/25 px-3 py-2">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">{result.lowerBodyMethod === "regionMotion" ? "Right Signal Samples" : "Right Coverage"}</p>
                  {result.lowerBodyMethod !== "regionMotion" && <QualityBadge coverage={result.rightCoverage} />}
                </div>
                <p className="mt-1 font-mono text-lg font-semibold text-foreground">{result.rightCoverage}%</p>
              </div>
            )}
            <div className="rounded-lg bg-muted/25 px-3 py-2">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Average Activity</p>
              <p className="mt-1 font-mono text-lg font-semibold text-foreground">{result.averageActivity}</p>
            </div>
            <div className="rounded-lg bg-muted/25 px-3 py-2">
              <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Review Peaks</p>
              <p className="mt-1 font-mono text-lg font-semibold text-foreground">{result.moments.length}</p>
            </div>
          </div>

          {result.hasLegs && (
            <div className={`grid gap-2 ${result.hasHands ? "sm:grid-cols-3" : "sm:grid-cols-2"}`}>
              <div className="rounded-lg border border-border bg-muted/10 px-3 py-2">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Left Foot / Leg Average</p>
                <p className="mt-1 font-mono text-lg font-semibold text-primary">{result.leftAverage}</p>
              </div>
              <div className="rounded-lg border border-border bg-muted/10 px-3 py-2">
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Right Foot / Leg Average</p>
                <p className="mt-1 font-mono text-lg font-semibold text-[#f59e0b]">{result.rightAverage}</p>
              </div>
              {result.hasHands && (
                <div className="rounded-lg border border-border bg-muted/10 px-3 py-2">
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Hand Activity Average</p>
                    <QualityBadge coverage={result.handCoverage} />
                  </div>
                  <p className="mt-1 font-mono text-lg font-semibold text-[#a78bfa]">{result.handAverage}</p>
                </div>
              )}
              {result.hasForefoot && (
                <>
                  <div className="rounded-lg border border-border bg-muted/10 px-3 py-2">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Left Forefoot / Toe-Region Average</p>
                    <p className="mt-1 font-mono text-lg font-semibold text-[#2dd4bf]">{result.leftForefootAverage}</p>
                  </div>
                  <div className="rounded-lg border border-border bg-muted/10 px-3 py-2">
                    <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Right Forefoot / Toe-Region Average</p>
                    <p className="mt-1 font-mono text-lg font-semibold text-[#fb923c]">{result.rightForefootAverage}</p>
                  </div>
                </>
              )}
            </div>
          )}

          {result.hasLegs && result.asymmetry && (
            <div className="rounded-lg border border-border bg-muted/10 p-3 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-primary">Lower-Body Asymmetry</p>
                <span className="text-[10px] text-muted-foreground">Observational only</span>
              </div>
              <div className="grid gap-2 sm:grid-cols-3">
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Average Index</p>
                  <p className="mt-1 font-mono text-base font-semibold text-foreground">{result.asymmetry.averageIndex}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Peak Index</p>
                  <p className="mt-1 font-mono text-base font-semibold text-foreground">{result.asymmetry.peakIndex} at {formatTime(result.asymmetry.peakTimeS)}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Predominance</p>
                  <p className="mt-1 text-sm font-medium text-foreground">
                    {result.asymmetry.predominantSide === "balanced"
                      ? "No clear predominance"
                      : `${result.asymmetry.predominantSide === "left" ? "Left" : "Right"} in ${result.asymmetry.predominantPct}%`}
                  </p>
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground">
                Calculated only from active samples where both selected lower-body regions were detected. Left and right use one shared comparison scale; index direction reflects the labels assigned to your rectangles.
              </p>
            </div>
          )}

          {result.hasLegs && result.lowerBodyPatterns && (
            <div className="rounded-lg border border-border bg-muted/10 p-3 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-primary">Lower-Body Pattern Proxies</p>
                <span className="text-[10px] text-muted-foreground">Video confirmation required</span>
              </div>
              <div className="grid gap-2 sm:grid-cols-4">
                <PatternProxyMetric label="Movement Bursts" count={result.lowerBodyPatterns.movement_burst_count} />
                <PatternProxyMetric label="Oscillatory / Shudder-Like" count={result.lowerBodyPatterns.oscillatory_candidate_count} />
                <PatternProxyMetric label="Sustained Elevations" count={result.lowerBodyPatterns.sustained_activity_shift_count} />
                <PatternProxyMetric label="Side Divergences" count={result.lowerBodyPatterns.left_right_divergence_count} />
              </div>
              {[...result.lowerBodyPatterns.oscillatory_candidates, ...result.lowerBodyPatterns.divergence_candidates].length > 0 && (
                <div className="flex flex-wrap gap-1.5">
                  {[...result.lowerBodyPatterns.oscillatory_candidates, ...result.lowerBodyPatterns.divergence_candidates]
                    .sort((a, b) => a.time_s - b.time_s)
                    .slice(0, 8)
                    .map((candidate) => (
                      <button
                        key={`${candidate.type}-${candidate.time_s}`}
                        type="button"
                        onClick={() => onSeek?.(candidate.time_s)}
                        className="inline-flex items-center gap-1.5 rounded-md border border-border bg-card/60 px-2 py-1 text-[10px] text-foreground transition-colors hover:border-primary/40"
                      >
                        <Play className="h-3 w-3 text-primary" />
                        <span className="font-mono">{formatTime(candidate.time_s)}</span>
                        <span className="text-muted-foreground">
                          {candidate.type === "oscillatory_candidate" ? "shudder-like" : `${candidate.predominant_side} divergence`}
                        </span>
                      </button>
                    ))}
                </div>
              )}
              <p className="text-[11px] text-muted-foreground">{result.lowerBodyPatterns.method_note}</p>
            </div>
          )}

          {result.hasLegs && result.postureGeometry && (
            <div className="rounded-lg border border-primary/25 bg-primary/[0.04] p-3 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-primary">Calibrated Foot Appearance Matching</p>
                <span className="text-[10px] text-muted-foreground">{result.postureGeometry.coverage_pct}% sampled frame coverage</span>
              </div>
              {result.postureGeometry.status === "calibrated_matching_available" ? (
                <>
                  <div className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3">
                    {result.postureGeometry.posture_candidates.length > 0 ? result.postureGeometry.posture_candidates.map((candidate) => (
                      <div
                        key={`${candidate.posture}-${candidate.time_s}`}
                        className="flex items-center gap-2 rounded-lg border border-primary/20 bg-card/60 p-2"
                      >
                        <div className="flex h-12 w-14 shrink-0 flex-col items-center justify-center rounded-md border border-dashed border-border bg-muted/15 text-muted-foreground">
                          <Footprints className="h-4 w-4" />
                          <span className="mt-0.5 text-[8px] uppercase tracking-wider">Preview</span>
                        </div>
                        <button
                          type="button"
                          onClick={() => onSeek?.(candidate.time_s)}
                          className="min-w-0 flex-1 text-left transition-colors hover:text-primary"
                        >
                          <span className="inline-flex items-center gap-1 text-[10px] font-semibold text-primary">
                            <Play className="h-3 w-3" />
                            <span className="font-mono">{formatTime(candidate.time_s)}</span>
                          </span>
                          <span className="mt-1 block truncate text-[11px] text-foreground">{candidate.posture_phrase}</span>
                          <span className="mt-1 flex flex-wrap items-center gap-1.5">
                            <ConfidenceBadge level={candidate.confidence} />
                            <span className="text-[9px] text-muted-foreground">{candidate.supporting_frames} sampled frames</span>
                          </span>
                        </button>
                      </div>
                    )) : (
                      <p className="text-xs text-muted-foreground">No sustained reference matches met the cautious match threshold in this analysis window.</p>
                    )}
                  </div>
                </>
              ) : result.postureGeometry.status === "references_needed" ? (
                <p className="text-xs text-muted-foreground">
                  Foot-region image samples were captured. Mark a neutral reference plus at least one named posture reference within the selected analysis window, then run analysis again.
                </p>
              ) : (
                <p className="text-xs text-muted-foreground">
                  Foot-region appearance samples were not available for this run.
                </p>
              )}
              <p className="text-[11px] leading-relaxed text-muted-foreground">{result.postureGeometry.method_note}</p>
            </div>
          )}

          {result.hasHands && result.handRhythm?.reliability === "moderate" && (
            <div className="rounded-lg border border-[#a78bfa]/30 bg-[#a78bfa]/[0.07] p-3 space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-[#a78bfa]">Hand Movement Rhythm Estimate</p>
                <span className="text-[10px] text-muted-foreground">Observational proxy only</span>
              </div>
              <div className="grid gap-2 sm:grid-cols-3">
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Cadence Estimate</p>
                  <p className="mt-1 font-mono text-base font-semibold text-foreground">{result.handRhythm.movement_cycles_per_minute_estimate} cycles/min</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Pauses Of Two Seconds Or Longer</p>
                  <p className="mt-1 font-mono text-base font-semibold text-foreground">{result.handRhythm.pause_count}</p>
                </div>
                <div>
                  <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Active Windows</p>
                  <p className="mt-1 font-mono text-base font-semibold text-foreground">{result.handRhythm.active_time_pct}%</p>
                </div>
              </div>
              <p className="text-[11px] text-muted-foreground">{result.handRhythm.method_note}</p>
            </div>
          )}

          {result.hasHands && result.handBehavior && (
            <div className="rounded-lg border border-[#a78bfa]/30 bg-[#a78bfa]/[0.07] p-3 space-y-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <p className="text-xs font-semibold uppercase tracking-wider text-[#a78bfa]">Calibrated Hand Behavior Matching</p>
                <span className="text-[10px] text-muted-foreground">Recorded-video examples / observational proxy</span>
              </div>
              {result.handBehavior.status === "calibrated_matching_available" ? (
                <>
                  <div className="grid gap-2 sm:grid-cols-2">
                    <div>
                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Stroke-Like Windows</p>
                      <p className="mt-1 font-mono text-base font-semibold text-foreground">{result.handBehavior.stroke_like_window_count}</p>
                    </div>
                    <div>
                      <p className="text-[10px] uppercase tracking-wider text-muted-foreground">Analyzed Time Matching Proxy</p>
                      <p className="mt-1 font-mono text-base font-semibold text-foreground">{result.handBehavior.stroke_like_time_pct}%</p>
                    </div>
                  </div>
                  {result.handBehavior.stroke_like_windows.length > 0 ? (
                    <div className="flex flex-wrap gap-2">
                      {result.handBehavior.stroke_like_windows.map((window) => (
                        <button
                          key={`${window.start_time_s}-${window.end_time_s}`}
                          type="button"
                          onClick={() => onSeek?.(window.start_time_s)}
                          className="inline-flex items-center gap-2 rounded-md border border-[#a78bfa]/25 bg-card/60 px-2.5 py-1.5 text-[11px] text-foreground hover:border-[#a78bfa]/50"
                        >
                          <Play className="h-3 w-3 text-[#a78bfa]" />
                          <span className="font-mono">{formatTime(window.start_time_s)}-{formatTime(window.end_time_s)}</span>
                          <span>stroke-like rhythm</span>
                          <ConfidenceBadge level={window.confidence} />
                          {window.cadence_proxy != null && <span className="text-muted-foreground">{window.cadence_proxy}/min</span>}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className="text-xs text-muted-foreground">No hand-motion windows were distinct enough from the non-stroke example to retain as candidates.</p>
                  )}
                </>
              ) : (
                <p className="text-xs text-muted-foreground">{result.handBehavior.method_note}</p>
              )}
              {result.handBehavior.status === "calibrated_matching_available" && (
                <p className="text-[11px] text-muted-foreground">{result.handBehavior.method_note}</p>
              )}
            </div>
          )}

          {(result.hasHands || result.hasLegs) && (
            <div className="rounded-lg border border-primary/25 bg-primary/[0.04] p-3 space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-primary">Motion-Derived Event Suggestions</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">Draft observations only. Promote reviewed findings to the timeline; finalizing replaces the saved motion-derived set.</p>
                </div>
                {motionSuggestions.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      onClick={() => acceptSuggestions(visibleMotionSuggestions)}
                      disabled={!selectedSession || acceptingSuggestions || visibleMotionSuggestions.length === 0}
                      className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-semibold text-primary-foreground disabled:opacity-45"
                    >
                      Promote all visible
                    </button>
                    <button
                      type="button"
                      onClick={() => setDismissedSuggestionIds((current) => [...new Set([...current, ...visibleMotionSuggestions.map((suggestion) => suggestion.id)])])}
                      disabled={visibleMotionSuggestions.length === 0}
                      className="rounded-md border border-border px-2.5 py-1 text-[11px] font-medium text-muted-foreground disabled:opacity-45"
                    >
                      Dismiss all visible
                    </button>
                  </div>
                )}
              </div>
              {result.hasHands && (
              <div className="grid gap-2 sm:grid-cols-4">
                <div>
                  <p className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">Minimum Pause</p>
                  <Select
                    value={String(suggestionSettings.minimumPauseDuration)}
                    onValueChange={(value) => setSuggestionSettings((current) => ({ ...current, minimumPauseDuration: Number(value) }))}
                  >
                    <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="2">2 seconds</SelectItem>
                      <SelectItem value="3">3 seconds</SelectItem>
                      <SelectItem value="5">5 seconds</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <p className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">Sensitivity</p>
                  <Select
                    value={suggestionSettings.sensitivity}
                    onValueChange={(value) => setSuggestionSettings((current) => ({ ...current, sensitivity: value }))}
                  >
                    <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="conservative">Conservative</SelectItem>
                      <SelectItem value="balanced">Balanced</SelectItem>
                      <SelectItem value="sensitive">Sensitive</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div>
                  <p className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">Minimum Spacing</p>
                  <Select
                    value={String(suggestionSettings.minimumSpacing)}
                    onValueChange={(value) => setSuggestionSettings((current) => ({ ...current, minimumSpacing: Number(value) }))}
                  >
                    <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="2">2 seconds</SelectItem>
                      <SelectItem value="5">5 seconds</SelectItem>
                      <SelectItem value="10">10 seconds</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <label className="flex items-end gap-2 rounded-md border border-border px-2.5 py-2 text-xs text-foreground">
                  <input
                    type="checkbox"
                    checked={suggestionSettings.mergeNearby}
                    onChange={(event) => setSuggestionSettings((current) => ({ ...current, mergeNearby: event.target.checked }))}
                    className="h-3.5 w-3.5 accent-primary"
                  />
                  Merge nearby gaps
                </label>
              </div>
              )}
              <div className="flex flex-wrap gap-2">
                {[
                  { key: "motion_pause", label: "Pauses" },
                  { key: "motion_resume", label: "Resumptions" },
                  { key: "lower_body_semantic_finding", label: "Lower-body findings" },
                ].map(({ key, label }) => (
                  <label key={key} className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/20 px-2.5 py-1 text-[11px] text-foreground">
                    <input
                      type="checkbox"
                      checked={visibleSuggestionTypes[key]}
                      onChange={(event) => setVisibleSuggestionTypes((current) => ({ ...current, [key]: event.target.checked }))}
                      className="h-3 w-3 accent-primary"
                    />
                    {label}
                  </label>
                ))}
              </div>
              {motionSuggestions.length === 0 ? (
                <p className="rounded-md border border-border bg-muted/15 px-3 py-2 text-xs text-muted-foreground">
                  No confidence-gated motion-derived event candidates were identified for this run.
                </p>
              ) : visibleMotionSuggestions.length === 0 ? (
                <p className="rounded-md border border-border bg-muted/15 px-3 py-2 text-xs text-muted-foreground">
                  No remaining visible draft suggestions. Dismissed drafts are not saved.
                </p>
              ) : (
                <div className="overflow-hidden rounded-lg border border-border">
                  {visibleMotionSuggestions.map((suggestion, index) => {
                    const isPause = suggestion.type === "motion_pause";
                    const isLowerBody = suggestion.type === "lower_body_semantic_finding";
                    const pauseSeconds = suggestion.pauseDurationS?.toFixed(1).replace(/\.0$/, "");
                    return (
                      <div
                        key={suggestion.id}
                        className={`flex flex-wrap items-center gap-2 border-b border-border/60 px-3 py-2 transition-colors last:border-b-0 hover:bg-primary/[0.11] hover:ring-1 hover:ring-inset hover:ring-primary/30 ${
                          index % 2 === 0 ? "bg-card/60" : "bg-muted/[0.16]"
                        }`}
                      >
                        <button type="button" onClick={() => onSeek?.(suggestion.timeS)} className="inline-flex items-center gap-1 text-xs font-semibold text-primary">
                          <Play className="h-3 w-3" />
                          {formatTime(suggestion.timeS)}
                        </button>
                        <button
                          type="button"
                          onClick={() => acceptSuggestions([suggestion])}
                          disabled={!selectedSession || acceptingSuggestions}
                          className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-semibold text-primary-foreground disabled:opacity-45"
                        >
                          Promote
                        </button>
                        <button
                          type="button"
                          onClick={() => setDismissedSuggestionIds((current) => [...new Set([...current, suggestion.id])])}
                          className="rounded-md border border-border px-2.5 py-1 text-[11px] text-muted-foreground"
                        >
                          Dismiss
                        </button>
                        <span className="rounded-full border border-primary/25 bg-primary/[0.08] px-2 py-0.5 text-[10px] font-semibold text-primary">
                          {isLowerBody ? "Lower-body finding" : isPause ? "Pause candidate" : "Resumption candidate"}
                        </span>
                        <ConfidenceBadge level={suggestion.confidence} />
                        <p className="min-w-[16rem] flex-1 text-xs text-foreground">
                          {isLowerBody
                            ? suggestion.note
                            : isPause
                            ? `Motion-derived: hand activity pause candidate (${pauseSeconds} seconds).`
                            : "Motion-derived: hand activity resumed after brief pause."}
                        </p>
                        {isLowerBody ? (
                          <span className="text-[10px] text-muted-foreground">
                            {suggestion.posture !== "not_classified_from_activity_trace"
                              ? "calibrated visual posture proxy"
                              : `${suggestion.sidePatternPhrase} / ${suggestion.intensity}`}
                          </span>
                        ) : (
                          <span className="text-[10px] text-muted-foreground">
                            pre {suggestion.prePauseHandActivityAverage} / post {suggestion.postResumeHandActivityAverage}
                          </span>
                        )}
                      </div>
                    );
                  })}
                </div>
              )}
              {!selectedSession && motionSuggestions.length > 0 && (
                <p className="text-[11px] text-muted-foreground">Select a session before accepting draft suggestions into its timeline.</p>
              )}
            </div>
          )}

          {result.hasLegs && result.lowerBodyMethod === "landmarks" && (result.leftCoverage < 50 || result.rightCoverage < 50) && (
            <div className="rounded-lg border border-rose-400/30 bg-rose-400/[0.08] px-3 py-2 text-sm text-rose-200">
              Side-to-side comparison is not reliable for this run. At least one selected lower-body region had limited landmark visibility. Adjust the regions and re-run before saving this result as evidence.
            </div>
          )}

          <div className="rounded-lg border border-border bg-muted/15 p-3">
            <p className="text-xs font-semibold uppercase tracking-wider text-primary">Observed Findings</p>
            <ul className="mt-2 space-y-1.5">
              {result.findings.map((finding) => (
                <li key={finding} className="border-l-2 border-primary/35 pl-3 text-sm text-foreground">{finding}</li>
              ))}
            </ul>
          </div>

          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-primary">Derived Motion Trace</p>
            <p className="mt-1 text-xs text-muted-foreground">
              Activity is normalized within this selected window. Click the trace to seek the video; the vertical marker follows playback.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              {result.hasLegs && (
                <>
                  <label className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/20 px-2.5 py-1 text-[11px] text-foreground">
                    <input
                      type="checkbox"
                      checked={visibleSignals.left}
                      onChange={(event) => setVisibleSignals((current) => ({ ...current, left: event.target.checked }))}
                      className="h-3 w-3 accent-primary"
                    />
                    Left foot / leg
                  </label>
                  <label className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/20 px-2.5 py-1 text-[11px] text-foreground">
                    <input
                      type="checkbox"
                      checked={visibleSignals.right}
                      onChange={(event) => setVisibleSignals((current) => ({ ...current, right: event.target.checked }))}
                      className="h-3 w-3 accent-[#f59e0b]"
                    />
                    Right foot / leg
                  </label>
                  {result.hasForefoot && (
                    <>
                      <label className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/20 px-2.5 py-1 text-[11px] text-foreground">
                        <input
                          type="checkbox"
                          checked={visibleSignals.leftForefoot}
                          onChange={(event) => setVisibleSignals((current) => ({ ...current, leftForefoot: event.target.checked }))}
                          className="h-3 w-3 accent-[#2dd4bf]"
                        />
                        Left forefoot / toe region
                      </label>
                      <label className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/20 px-2.5 py-1 text-[11px] text-foreground">
                        <input
                          type="checkbox"
                          checked={visibleSignals.rightForefoot}
                          onChange={(event) => setVisibleSignals((current) => ({ ...current, rightForefoot: event.target.checked }))}
                          className="h-3 w-3 accent-[#fb923c]"
                        />
                        Right forefoot / toe region
                      </label>
                    </>
                  )}
                </>
              )}
              {result.hasHands && (
                <label className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/20 px-2.5 py-1 text-[11px] text-foreground">
                  <input
                    type="checkbox"
                    checked={visibleSignals.hands}
                    onChange={(event) => setVisibleSignals((current) => ({ ...current, hands: event.target.checked }))}
                    className="h-3 w-3 accent-[#a78bfa]"
                  />
                  Hands
                </label>
              )}
              {!result.hasLegs && (
                <label className="inline-flex items-center gap-1.5 rounded-full border border-border bg-muted/20 px-2.5 py-1 text-[11px] text-foreground">
                  <input
                    type="checkbox"
                    checked={visibleSignals.activity}
                    onChange={(event) => setVisibleSignals((current) => ({ ...current, activity: event.target.checked }))}
                    className="h-3 w-3 accent-primary"
                  />
                  Activity
                </label>
              )}
            </div>
            <div className="mt-3 h-44 rounded-lg border border-border bg-muted/10 p-2">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart
                  data={result.samples}
                  margin={{ top: 8, right: 8, bottom: 2, left: -24 }}
                  onClick={(chartData) => {
                    if (Number.isFinite(Number(chartData?.activeLabel))) onSeek?.(Number(chartData.activeLabel));
                  }}
                >
                  <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                  <XAxis
                    dataKey="timeS"
                    type="number"
                    domain={[result.start, result.end]}
                    tickFormatter={formatTime}
                    stroke="hsl(var(--muted-foreground))"
                    fontSize={10}
                  />
                  <YAxis domain={[0, 100]} stroke="hsl(var(--muted-foreground))" fontSize={10} />
                  <Tooltip content={<MotionTooltip />} />
                  <Legend wrapperStyle={{ fontSize: 11 }} />
                  {videoTime >= result.start && videoTime <= result.end && (
                    <ReferenceLine
                      x={videoTime}
                      stroke="#f43f5e"
                      strokeWidth={2}
                      label={{ value: formatTime(videoTime), fontSize: 9, fill: "#f43f5e", position: "insideTopRight" }}
                    />
                  )}
                  {result.hasLegs ? (
                    <>
                      {visibleSignals.left && (
                        <Line type="monotone" name="Left foot / leg" dataKey="leftScore" stroke="hsl(var(--primary))" dot={false} strokeWidth={2} />
                      )}
                      {visibleSignals.right && (
                        <Line type="monotone" name="Right foot / leg" dataKey="rightScore" stroke="#f59e0b" dot={false} strokeWidth={2} />
                      )}
                      {result.hasForefoot && visibleSignals.leftForefoot && (
                        <Line type="monotone" name="Left forefoot / toe region" dataKey="leftForefootScore" stroke="#2dd4bf" dot={false} strokeWidth={1.5} strokeDasharray="4 2" />
                      )}
                      {result.hasForefoot && visibleSignals.rightForefoot && (
                        <Line type="monotone" name="Right forefoot / toe region" dataKey="rightForefootScore" stroke="#fb923c" dot={false} strokeWidth={1.5} strokeDasharray="4 2" />
                      )}
                      {result.hasHands && visibleSignals.hands && (
                        <Line type="monotone" name="Hands" dataKey="handScore" stroke="#a78bfa" dot={false} strokeWidth={2} />
                      )}
                    </>
                  ) : (
                    visibleSignals.activity && (
                      <Line type="monotone" name="Movement activity" dataKey="score" stroke="hsl(var(--primary))" dot={false} strokeWidth={2} />
                    )
                  )}
                </LineChart>
              </ResponsiveContainer>
            </div>
            {result.hasLegs && (
              <div className="mt-3">
                <SideBalanceGauge left={currentMotionPoint?.leftScore} right={currentMotionPoint?.rightScore} />
              </div>
            )}
          </div>

          {result.moments.length > 0 ? (
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-primary">Review Peaks</p>
              <div className="flex flex-wrap gap-2">
                {reviewPeakClusters.map((cluster, clusterIndex) => {
                  const expanded = expandedPeakClusters.includes(clusterIndex);
                  if (cluster.length === 1) {
                    const moment = cluster[0];
                    return (
                      <button
                        key={moment.timeS}
                        type="button"
                        onClick={() => onSeek?.(moment.timeS)}
                        className="inline-flex items-center gap-2 rounded-lg border border-border bg-muted/20 px-3 py-2 text-xs text-foreground transition-colors hover:border-primary/40 hover:bg-primary/[0.08]"
                      >
                        <Play className="h-3 w-3 text-primary" />
                        <span className="font-mono">{formatTime(moment.timeS)}</span>
                        <span className="text-muted-foreground">
                          {result.hasLegs
                            ? `left ${moment.leftScore} / right ${moment.rightScore}${result.hasHands ? ` / hands ${moment.handScore}` : ""}`
                            : `activity ${moment.score}`}
                        </span>
                      </button>
                    );
                  }
                  return (
                    <div key={`${cluster[0].timeS}-${cluster[cluster.length - 1].timeS}`} className="rounded-lg border border-primary/20 bg-primary/[0.05] p-1.5">
                      <button
                        type="button"
                        onClick={() => {
                          onSeek?.(cluster[0].timeS);
                          setExpandedPeakClusters((current) => (
                            current.includes(clusterIndex)
                              ? current.filter((value) => value !== clusterIndex)
                              : [...current, clusterIndex]
                          ));
                        }}
                        className="inline-flex items-center gap-2 rounded-md px-2 py-1 text-xs text-foreground transition-colors hover:bg-primary/[0.08]"
                      >
                        <Play className="h-3 w-3 text-primary" />
                        <span className="font-mono">{formatTime(cluster[0].timeS)}-{formatTime(cluster[cluster.length - 1].timeS)}</span>
                        <span className="text-muted-foreground">burst cluster</span>
                        <span className="rounded-full bg-primary/10 px-1.5 py-0.5 text-[10px] font-semibold text-primary">{cluster.length} peaks</span>
                        <span className="text-[10px] text-muted-foreground">{expanded ? "Hide" : "Inspect"}</span>
                      </button>
                      {expanded && (
                        <div className="mt-1 flex flex-wrap gap-1 border-t border-border/60 pt-1.5">
                          {cluster.map((moment) => (
                            <button
                              key={moment.timeS}
                              type="button"
                              onClick={() => onSeek?.(moment.timeS)}
                              className="rounded-md border border-border bg-card/60 px-2 py-1 text-[10px] text-foreground hover:border-primary/40"
                            >
                              <span className="font-mono text-primary">{formatTime(moment.timeS)}</span>
                              {result.hasLegs && <span className="ml-1 text-muted-foreground">L{moment.leftScore}/R{moment.rightScore}</span>}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">
              No high-activity review peaks were identified in this window. Low detection coverage may indicate a view or lighting issue.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-3 rounded-lg border border-border bg-muted/10 px-3 py-3">
            {selectedSession ? (
              <>
              <button
                type="button"
                onClick={saveSummaryForAI}
                  disabled={saving}
                  className="inline-flex h-9 items-center gap-2 rounded-lg bg-primary px-3 text-xs font-semibold text-primary-foreground transition-colors hover:bg-primary/90 disabled:opacity-50"
                >
                  {saving ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Save className="h-3.5 w-3.5" />}
                  {saving ? "Saving..." : "Finalize summary and replace saved motion events"}
              </button>
              <p className="basis-full text-[11px] leading-relaxed text-muted-foreground">
                Finalizing replaces earlier motion-derived timeline events with accepted findings from this analysis. Manual event notes remain unchanged.
              </p>
                {saved && (
                  <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400">
                    <CheckCircle2 className="h-3.5 w-3.5" />
                    Saved to selected session
                  </span>
                )}
              </>
            ) : (
              <p className="text-xs text-muted-foreground">
                Select a session above to persist reviewed summary metrics and a compact normalized activity trace for this page, Video Sync, and later AI Profiler synthesis. Raw video, frames, and MediaPipe landmarks are never stored.
              </p>
            )}
          </div>

          <p className="text-[11px] leading-relaxed text-muted-foreground">
            {result.stopped ? "Analysis was stopped early. " : ""}
            This is a local experimental aid, not a confirmed physiological finding. Saved records retain region coordinates and a compact normalized activity trace for review, not raw video, frames, or MediaPipe landmarks. Activity scores are not absolute force measurements. Confirm any useful pattern against the recording and session data before recording an interpretation.
          </p>
        </div>
      )}
    </div>
  );
}
