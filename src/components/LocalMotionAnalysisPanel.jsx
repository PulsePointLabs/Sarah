import { useEffect, useMemo, useRef, useState } from "react";
import { Activity, CheckCircle2, Footprints, Hand, Loader2, Play, Save, ShieldCheck, Square } from "lucide-react";
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

function motionSuggestionEvent(suggestion) {
  const pauseSeconds = suggestion.pauseDurationS.toFixed(1).replace(/\.0$/, "");
  const isPause = suggestion.type === "motion_pause";
  return {
    time_s: suggestion.timeS,
    note: isPause
      ? "Motion-derived: observed hand activity pause candidate."
      : `Motion-derived: observed hand activity resumed after approximately ${pauseSeconds} seconds of reduced activity.`,
    category: [isPause ? "motion_pause" : "motion_resume"],
    annotation_tags: ["other_context"],
    source: "motion_derived",
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

function buildFindings(result) {
  const findings = [];
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
  if (result.asymmetry && result.leftCoverage >= 50 && result.rightCoverage >= 50) {
    if (result.asymmetry.predominantSide === "balanced") {
      findings.push(`No clear side predominance was established across active paired lower-body windows (left-biased ${result.asymmetry.leftBiasedPct}%, right-biased ${result.asymmetry.rightBiasedPct}%, broadly similar ${result.asymmetry.balancedPct}%; ${result.asymmetry.comparedWindows} compared samples).`);
    } else {
      const side = result.asymmetry.predominantSide === "left" ? "Left" : "Right";
      findings.push(`${side}-side activity predominated in ${result.asymmetry.predominantPct}% of active paired lower-body windows (${result.asymmetry.comparedWindows} compared samples).`);
    }
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
    }));
}

function buildSavedSummary(result) {
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
    left_lower_body_average_activity: result.hasLegs ? result.leftAverage : undefined,
    right_lower_body_average_activity: result.hasLegs ? result.rightAverage : undefined,
    left_forefoot_average_activity: result.hasForefoot ? result.leftForefootAverage : undefined,
    right_forefoot_average_activity: result.hasForefoot ? result.rightForefootAverage : undefined,
    hand_average_activity: result.hasHands ? result.handAverage : undefined,
    hand_movement_summary: result.hasHands ? result.handRhythm : undefined,
    hand_cadence_timeline: result.hasHands ? buildHandCadenceTimeline(result) : undefined,
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
    normalization_guardrail: "Activity scores are normalized within this analyzed video window and are not absolute force measurements or directly comparable magnitudes across recordings. Region-motion scores should be checked against camera movement, framing changes, and visible recording artifacts.",
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

export default function LocalMotionAnalysisPanel({ videoSrc, videoDuration, videoTime, selectedSession, onSeek, onSaveSummary, onAcceptSuggestions }) {
  const stopRequestedRef = useRef(false);
  const previewCanvasRef = useRef(null);
  const previewEnabledRef = useRef(false);
  const previewLegsRef = useRef(true);
  const previewHandsRef = useRef(true);
  const previewReadyRef = useRef(false);
  const roiCanvasRef = useRef(null);
  const roiFrameCanvasRef = useRef(null);
  const roiDragStartRef = useRef(null);
  const [mode, setMode] = useState("combined");
  const [windowMode, setWindowMode] = useState("segment");
  const [roiLayout, setRoiLayout] = useState("pip");
  const [lowerBodyMethod, setLowerBodyMethod] = useState("regionMotion");
  const [rois, setRois] = useState(() => copyRois(PIP_ROI_PRESET));
  const [activeRoi, setActiveRoi] = useState("leftLowerBody");
  const [forefootEnabled, setForefootEnabled] = useState(false);
  const [leftRightOrientation, setLeftRightOrientation] = useState("anatomical_left_on_screen_right");
  const [roiFrameReady, setRoiFrameReady] = useState(false);
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
  const [visibleSuggestionTypes, setVisibleSuggestionTypes] = useState({ motion_pause: true, motion_resume: true });
  const [dismissedSuggestionIds, setDismissedSuggestionIds] = useState([]);
  const [acceptedSuggestionIds, setAcceptedSuggestionIds] = useState([]);
  const [acceptingSuggestions, setAcceptingSuggestions] = useState(false);

  useEffect(() => {
    stopRequestedRef.current = true;
    setResult(null);
    setError("");
    setProgress(0);
    setSaved(false);
    setPreviewReady(false);
    setRoiFrameReady(false);
    roiFrameCanvasRef.current = null;
    previewReadyRef.current = false;
    setDismissedSuggestionIds([]);
    setAcceptedSuggestionIds([]);
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
  const appliedRois = useMemo(() => resolveRois(roiLayout, rois), [roiLayout, rois]);
  const appliedLowerBodyMethod = roiLayout === "pip" ? lowerBodyMethod : "landmarks";
  const motionSuggestions = useMemo(
    () => buildHandTransitionSuggestions(result, suggestionSettings),
    [result, suggestionSettings],
  );
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
      { key: "leftLowerBody", color: "#20d3c2", label: `Your left foot (${anatomicalScreenSide(leftRightOrientation, "left")})` },
      { key: "rightLowerBody", color: "#f59e0b", label: `Your right foot (${anatomicalScreenSide(leftRightOrientation, "right")})` },
      { key: "hands", color: "#a78bfa", label: "Hands / main" },
    ];
    if (forefootEnabled && lowerBodyMethod === "regionMotion") {
      visibleRegions.splice(2, 0,
        { key: "leftForefoot", color: "#2dd4bf", label: "Left forefoot / toes" },
        { key: "rightForefoot", color: "#fb923c", label: "Right forefoot / toes" },
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
  };

  useEffect(() => {
    drawRoiSetupFrame();
  }, [activeRoi, forefootEnabled, leftRightOrientation, lowerBodyMethod, roiFrameReady, roiLayout, rois]);

  const captureRoiSetupFrame = async () => {
    if (!videoSrc) return;
    let probe = null;
    try {
      probe = document.createElement("video");
      probe.src = videoSrc;
      probe.muted = true;
      probe.playsInline = true;
      probe.preload = "auto";
      await waitForVideoMetadata(probe);
      await waitForVideoPixels(probe);
      await seekVideo(probe, clamp(Number(videoTime) || 0, 0, Number(probe.duration) || 0));
      await waitForVideoPixels(probe);
      const frame = document.createElement("canvas");
      frame.width = probe.videoWidth;
      frame.height = probe.videoHeight;
      frame.getContext("2d")?.drawImage(probe, 0, 0, frame.width, frame.height);
      roiFrameCanvasRef.current = frame;
      setRoiFrameReady(true);
    } catch (caughtError) {
      setError(caughtError?.message || "The analysis-region preview could not be captured.");
    } finally {
      if (probe) {
        probe.pause();
        probe.src = "";
      }
    }
  };

  const handleRoiMouseDown = (event) => {
    if (running || roiLayout === "full" || !roiFrameReady) return;
    const canvas = event.currentTarget;
    const start = pointerToCanvasFrame(event, canvas);
    if (!start) return;
    const selectedRoi = rois[activeRoi];
    const resizeCorner = selectedRoi ? findRoiResizeCorner(start, selectedRoi) : null;
    const movingKey = !resizeCorner && selectedRoi
      && start.x >= selectedRoi.x && start.x <= selectedRoi.x + selectedRoi.width
      && start.y >= selectedRoi.y && start.y <= selectedRoi.y + selectedRoi.height
      ? activeRoi
      : null;
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
    const analysisRois = resolveRois(roiLayout, rois);
    const analyzeForefoot = mode !== "hands" && appliedLowerBodyMethod === "regionMotion" && forefootEnabled;
    try {
      const { FilesetResolver, PoseLandmarker, HandLandmarker } = await import("@mediapipe/tasks-vision");
      const vision = await FilesetResolver.forVisionTasks(WASM_ROOT);
      if ((mode === "legs" || mode === "combined") && appliedLowerBodyMethod === "landmarks") {
        const poseOptions = {
          baseOptions: { modelAssetPath: POSE_MODEL_URL },
          runningMode: "VIDEO",
          numPoses: 1,
          minPoseDetectionConfidence: 0.45,
          minPosePresenceConfidence: 0.45,
          minTrackingConfidence: 0.45,
        };
        if (roiLayout === "pip") {
          leftPoseLandmarker = await PoseLandmarker.createFromOptions(vision, poseOptions);
          rightPoseLandmarker = await PoseLandmarker.createFromOptions(vision, poseOptions);
        } else {
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
      let processed = 0;

      for (let timeS = start; timeS <= end + 0.001; timeS += step) {
        if (stopRequestedRef.current) break;
        await seekVideo(probe, Math.min(timeS, end));
        const timestamp = Math.round(timeS * 1000);
        const poseSource = poseLandmarker ? drawVideoCrop(probe, analysisRois.leftLowerBody, poseCropCanvas) : null;
        const leftPoseSource = leftPoseLandmarker ? drawVideoCrop(probe, analysisRois.leftLowerBody, leftPoseCropCanvas) : null;
        const rightPoseSource = rightPoseLandmarker ? drawVideoCrop(probe, analysisRois.rightLowerBody, rightPoseCropCanvas) : null;
        const handSource = drawVideoCrop(probe, analysisRois.hands, handCropCanvas);
        const poseResult = poseLandmarker ? poseLandmarker.detectForVideo(poseSource, timestamp) : null;
        const leftPoseResult = leftPoseLandmarker ? leftPoseLandmarker.detectForVideo(leftPoseSource, timestamp) : null;
        const rightPoseResult = rightPoseLandmarker ? rightPoseLandmarker.detectForVideo(rightPoseSource, timestamp) : null;
        const handResult = handLandmarker ? handLandmarker.detectForVideo(handSource, timestamp) : null;
        const legs = appliedLowerBodyMethod === "landmarks"
          ? (roiLayout === "pip"
            ? { left: extractRegionLeg(leftPoseResult)?.points || null, right: extractRegionLeg(rightPoseResult)?.points || null }
            : extractLegSides(poseResult))
          : null;
        const legPreview = appliedLowerBodyMethod === "regionMotion"
          ? { regionMotion: true, forefootEnabled: analyzeForefoot }
          : (roiLayout === "pip"
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
            analysisRois,
            leftRightOrientation,
          );
          if (frameDrawn && !previewReadyRef.current) {
            previewReadyRef.current = true;
            setPreviewReady(true);
          }
        }
        const regionFrames = appliedLowerBodyMethod === "regionMotion"
          ? {
            left: readRoiGrayscale(probe, analysisRois.leftLowerBody, leftMotionCanvas),
            right: readRoiGrayscale(probe, analysisRois.rightLowerBody, rightMotionCanvas),
            leftForefoot: analyzeForefoot ? readRoiGrayscale(probe, analysisRois.leftForefoot, leftForefootMotionCanvas) : null,
            rightForefoot: analyzeForefoot ? readRoiGrayscale(probe, analysisRois.rightForefoot, rightForefootMotionCanvas) : null,
          }
          : null;
        const leftValue = appliedLowerBodyMethod === "regionMotion"
          ? regionPixelMotion(regionFrames.left, previousRegionFrames.left)
          : sideMotion(legs?.left, previousLegs.left);
        const rightValue = appliedLowerBodyMethod === "regionMotion"
          ? regionPixelMotion(regionFrames.right, previousRegionFrames.right)
          : sideMotion(legs?.right, previousLegs.right);
        const leftForefootValue = analyzeForefoot
          ? regionPixelMotion(regionFrames.leftForefoot, previousRegionFrames.leftForefoot)
          : null;
        const rightForefootValue = analyzeForefoot
          ? regionPixelMotion(regionFrames.rightForefoot, previousRegionFrames.rightForefoot)
          : null;
        const handValue = handMotion(hands, previousHands);
        if (mode === "combined" || mode === "legs") {
          rawSamples.push({
            timeS,
            leftMotion: leftValue,
            rightMotion: rightValue,
            leftForefootMotion: leftForefootValue,
            rightForefootMotion: rightForefootValue,
            handMotion: mode === "combined" ? handValue : null,
            leftDetected: appliedLowerBodyMethod === "regionMotion" ? leftValue != null : !!legs?.left,
            rightDetected: appliedLowerBodyMethod === "regionMotion" ? rightValue != null : !!legs?.right,
            legsDetected: appliedLowerBodyMethod === "regionMotion" ? leftValue != null || rightValue != null : !!legs?.left || !!legs?.right,
            handsDetected: !!hands,
            detected: appliedLowerBodyMethod === "regionMotion"
              ? leftValue != null || rightValue != null || (mode === "combined" && !!hands)
              : !!legs?.left || !!legs?.right || (mode === "combined" && !!hands),
          });
        } else {
          rawSamples.push({
            timeS,
            motion: handValue,
            handsDetected: !!hands,
            detected: !!hands,
          });
        }
        previousLegs = {
          left: legs?.left || previousLegs.left,
          right: legs?.right || previousLegs.right,
        };
        previousHands = hands || previousHands;
        if (regionFrames) previousRegionFrames = regionFrames;
        processed += 1;
        if (processed % 5 === 0 || processed === expectedSamples) {
          setProgress(Math.min(100, Math.round((processed / expectedSamples) * 100)));
          await new Promise((resolve) => window.setTimeout(resolve, 0));
        }
      }

      if (!rawSamples.length) return;
      const hasLegs = mode !== "hands";
      const hasHands = mode !== "legs";
      const hasForefoot = hasLegs && analyzeForefoot;
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
        lowerBodyMethod: appliedLowerBodyMethod,
        leftRightOrientation,
        sampleRate: selectedMode.fps,
        roiLayout,
        rois: analysisRois,
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
      nextResult.asymmetry = hasLegs ? calculateAsymmetry(samples) : null;
      nextResult.handRhythm = hasHands
        ? calculateHandRhythmSummary(samples, hasLegs ? "handScore" : "score", nextResult.handCoverage, selectedMode.fps)
        : null;
      nextResult.findings = buildFindings(nextResult);
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
      await onSaveSummary(buildSavedSummary(result));
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

  return (
    <div className="rounded-xl border border-border bg-card p-4 space-y-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          <Activity className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
          <div>
            <p className="text-xs font-semibold uppercase tracking-wider text-primary">Local Motion Analysis</p>
            <p className="mt-1 text-sm text-muted-foreground">
              Experimental landmark tracking for review support. Results remain temporary unless you explicitly save a compact summary to a selected session.
            </p>
            <p className="mt-1 text-xs text-muted-foreground">
              Combined tracking expects both views in one composite video; separate recordings can be analyzed one at a time.
            </p>
          </div>
        </div>
        <div className="inline-flex items-center gap-1.5 rounded-full border border-primary/25 bg-primary/[0.08] px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wider text-primary">
          <ShieldCheck className="h-3 w-3" />
          Local video only
        </div>
      </div>

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
              className={`rounded-md px-3 py-1.5 font-medium transition-colors ${roiLayout === "pip" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              Upper-left inset
            </button>
            <button
              type="button"
              onClick={() => setRoiLayout("full")}
              disabled={running}
              className={`rounded-md px-3 py-1.5 font-medium transition-colors ${roiLayout === "full" ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
            >
              Full frame
            </button>
          </div>
        </div>

        {roiLayout === "pip" ? (
          <>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={() => setActiveRoi("leftLowerBody")}
                disabled={running}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${activeRoi === "leftLowerBody" ? "border-primary bg-primary/[0.12] text-primary" : "border-border text-muted-foreground"}`}
              >
                Edit your left foot ({anatomicalScreenSide(leftRightOrientation, "left")})
              </button>
              <button
                type="button"
                onClick={() => setActiveRoi("rightLowerBody")}
                disabled={running}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${activeRoi === "rightLowerBody" ? "border-[#f59e0b] bg-[#f59e0b]/10 text-[#fbbf24]" : "border-border text-muted-foreground"}`}
              >
                Edit your right foot ({anatomicalScreenSide(leftRightOrientation, "right")})
              </button>
              <button
                type="button"
                onClick={() => setActiveRoi("hands")}
                disabled={running}
                className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${activeRoi === "hands" ? "border-[#a78bfa] bg-[#a78bfa]/10 text-[#c4b5fd]" : "border-border text-muted-foreground"}`}
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
                className="rounded-full border border-border px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
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
                className="rounded-full border border-border px-3 py-1 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
              >
                Mirror / swap left-right labels
              </button>
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
                  <div className="flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() => setActiveRoi("leftForefoot")}
                      disabled={running}
                      className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${activeRoi === "leftForefoot" ? "border-[#2dd4bf] bg-[#2dd4bf]/10 text-[#5eead4]" : "border-border text-muted-foreground"}`}
                    >
                      Edit left forefoot / toe region
                    </button>
                    <button
                      type="button"
                      onClick={() => setActiveRoi("rightForefoot")}
                      disabled={running}
                      className={`rounded-full border px-3 py-1 text-xs font-medium transition-colors ${activeRoi === "rightForefoot" ? "border-[#fb923c] bg-[#fb923c]/10 text-[#fdba74]" : "border-border text-muted-foreground"}`}
                    >
                      Edit right forefoot / toe region
                    </button>
                  </div>
                )}
                <p className="text-[11px] text-muted-foreground">
                  This comparison is optional. Standard left/right foot tracking runs without it.
                </p>
              </div>
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
          <p className="text-[11px] text-muted-foreground">
            Full-frame mode sends the complete video image to each enabled tracker. Use this for a single-camera view without an inset layout.
          </p>
        )}

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            onClick={captureRoiSetupFrame}
            disabled={!videoSrc || running}
            className="rounded-lg border border-border bg-card px-3 py-2 text-xs font-semibold text-foreground transition-colors hover:border-primary/40 disabled:cursor-not-allowed disabled:opacity-45"
          >
            Preview regions at current video position
          </button>
          <span className="text-[11px] text-muted-foreground">
            {roiFrameReady
              ? roiLayout === "pip" ? "Choose the region to edit first. Drag its white corner handles to resize, drag inside to move it, or drag elsewhere to redraw it." : "The full frame will be analyzed."
              : "Load a local video, then capture a frame to adjust the regions."}
          </span>
        </div>

        {roiFrameReady && (
          <div className="space-y-2">
            <div className="overflow-hidden rounded-lg border border-border bg-black">
              <canvas
                ref={roiCanvasRef}
                onMouseDown={handleRoiMouseDown}
                className={`block aspect-video max-h-[52vh] w-full object-contain ${roiLayout === "pip" && !running ? "cursor-crosshair" : ""}`}
              />
            </div>
            <p className="text-[11px] text-muted-foreground">
              These colored rectangles are the exact crop regions used for the next analysis. White corner handles resize the selected region.
            </p>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
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
        {!videoSrc && (
          <span className="text-xs text-muted-foreground">The loaded review video remains in browser memory only.</span>
        )}
      </div>

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
                  {appliedLowerBodyMethod === "regionMotion" ? "Foot signal regions" : "Lower-body landmarks"}
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

      {error && (
        <p className="rounded-lg border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {result && (
        <div className="space-y-4 border-t border-border pt-4">
          <div className="rounded-lg border border-primary/25 bg-primary/[0.07] px-3 py-2 text-sm text-foreground">
            <span className="font-semibold text-primary">Current analysis result.</span>{" "}
            This temporary trace reflects the most recent run and replaces the saved summary only after you select <span className="font-medium">Save summary to selected session</span>.
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

          {result.hasHands && (
            <div className="rounded-lg border border-primary/25 bg-primary/[0.04] p-3 space-y-3">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wider text-primary">Motion-Derived Event Suggestions</p>
                  <p className="mt-1 text-[11px] text-muted-foreground">Draft observations only. Review against video before saving.</p>
                </div>
                {motionSuggestions.length > 0 && (
                  <div className="flex flex-wrap gap-1.5">
                    <button
                      type="button"
                      onClick={() => acceptSuggestions(visibleMotionSuggestions)}
                      disabled={!selectedSession || acceptingSuggestions || visibleMotionSuggestions.length === 0}
                      className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-semibold text-primary-foreground disabled:opacity-45"
                    >
                      Accept all visible
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
              <div className="flex flex-wrap gap-2">
                {[
                  { key: "motion_pause", label: "Pauses" },
                  { key: "motion_resume", label: "Resumptions" },
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
                  No confidence-gated hand pause/resumption candidates were identified for this run.
                </p>
              ) : visibleMotionSuggestions.length === 0 ? (
                <p className="rounded-md border border-border bg-muted/15 px-3 py-2 text-xs text-muted-foreground">
                  No remaining visible draft suggestions. Dismissed drafts are not saved.
                </p>
              ) : (
                <div className="space-y-2">
                  {visibleMotionSuggestions.map((suggestion) => {
                    const isPause = suggestion.type === "motion_pause";
                    const pauseSeconds = suggestion.pauseDurationS.toFixed(1).replace(/\.0$/, "");
                    return (
                      <div key={suggestion.id} className="flex flex-wrap items-center gap-2 rounded-lg border border-border bg-card/60 px-3 py-2">
                        <button type="button" onClick={() => onSeek?.(suggestion.timeS)} className="inline-flex items-center gap-1 text-xs font-semibold text-primary">
                          <Play className="h-3 w-3" />
                          {formatTime(suggestion.timeS)}
                        </button>
                        <span className="rounded-full border border-primary/25 bg-primary/[0.08] px-2 py-0.5 text-[10px] font-semibold text-primary">
                          {isPause ? "Pause candidate" : "Resumption candidate"}
                        </span>
                        <span className="rounded-full border border-amber-400/25 bg-amber-400/[0.08] px-2 py-0.5 text-[10px] font-semibold text-amber-300">
                          {suggestion.confidence}
                        </span>
                        <p className="min-w-[16rem] flex-1 text-xs text-foreground">
                          {isPause
                            ? `Motion-derived: observed hand activity pause candidate (${pauseSeconds} seconds).`
                            : `Motion-derived: observed hand activity resumed after approximately ${pauseSeconds} seconds.`}
                        </p>
                        <span className="text-[10px] text-muted-foreground">
                          pre {suggestion.prePauseHandActivityAverage} / post {suggestion.postResumeHandActivityAverage}
                        </span>
                        <button
                          type="button"
                          onClick={() => acceptSuggestions([suggestion])}
                          disabled={!selectedSession || acceptingSuggestions}
                          className="rounded-md bg-primary px-2.5 py-1 text-[11px] font-semibold text-primary-foreground disabled:opacity-45"
                        >
                          Accept
                        </button>
                        <button
                          type="button"
                          onClick={() => setDismissedSuggestionIds((current) => [...new Set([...current, suggestion.id])])}
                          className="rounded-md border border-border px-2.5 py-1 text-[11px] text-muted-foreground"
                        >
                          Dismiss
                        </button>
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
          </div>

          {result.moments.length > 0 ? (
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wider text-primary">Review Peaks</p>
              <div className="flex flex-wrap gap-2">
                {result.moments.map((moment) => (
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
                ))}
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
                  {saving ? "Saving..." : "Save summary to selected session"}
                </button>
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
