import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Camera, Crosshair, Download, Pause, Play, RotateCcw, ShieldCheck, Square, UploadCloud } from "lucide-react";

const DEFAULT_LABELS = [
  { key: "left_toe", label: "Left big toe", color: "#2dd4bf" },
  { key: "right_toe", label: "Right big toe", color: "#fb7185" },
  { key: "left_forefoot", label: "Left forefoot", color: "#a78bfa" },
  { key: "right_forefoot", label: "Right forefoot", color: "#fbbf24" },
  { key: "left_heel", label: "Left heel", color: "#60a5fa" },
  { key: "right_heel", label: "Right heel", color: "#f97316" },
];

const SETTINGS_STORAGE_KEY = "pulsepoint.liveFootLandmarkTracker.settings.v1";
const POINTS_STORAGE_KEY = "pulsepoint.liveFootLandmarkTracker.points.v1";
const ROW_LIMIT = 1500;

const DEFAULT_SETTINGS = {
  threshold: 185,
  minArea: 6,
  maxArea: 7000,
  searchRadius: 120,
  lostTolerance: 24,
  reacquireAfter: 8,
  mirror: false,
  showCandidates: false,
};

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function readStoredJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function colorFor(label) {
  return DEFAULT_LABELS.find((item) => item.key === label)?.color || "#e2e8f0";
}

function brightness(data, width, x, y) {
  const height = Math.max(1, Math.floor(data.length / Math.max(1, width * 4)));
  const px = clamp(Math.round(x), 0, width - 1);
  const py = clamp(Math.round(y), 0, height - 1);
  const index = (py * width + px) * 4;
  return Math.max(data[index], data[index + 1], data[index + 2]);
}

function pointDistance(a, b) {
  return Math.hypot((a?.x || 0) - (b?.x || 0), (a?.y || 0) - (b?.y || 0));
}

function buildFootRoi(points, image, padding = 180) {
  const anchors = points
    .map((point) => ({
      x: Number.isFinite(point.lastGoodX) ? point.lastGoodX : point.x,
      y: Number.isFinite(point.lastGoodY) ? point.lastGoodY : point.y,
    }))
    .filter((point) => Number.isFinite(point.x) && Number.isFinite(point.y));
  if (!image?.width || anchors.length < 2) {
    return { x: 0, y: 0, w: image?.width || 1, h: image?.height || 1, locked: false };
  }
  const minX = Math.min(...anchors.map((point) => point.x));
  const maxX = Math.max(...anchors.map((point) => point.x));
  const minY = Math.min(...anchors.map((point) => point.y));
  const maxY = Math.max(...anchors.map((point) => point.y));
  const adaptivePadding = Math.max(padding, Math.min(image.width, image.height) * 0.12);
  const x = clamp(minX - adaptivePadding, 0, image.width);
  const y = clamp(minY - adaptivePadding, 0, image.height);
  const right = clamp(maxX + adaptivePadding, 0, image.width);
  const bottom = clamp(maxY + adaptivePadding, 0, image.height);
  return {
    x,
    y,
    w: Math.max(1, right - x),
    h: Math.max(1, bottom - y),
    locked: true,
  };
}

function pointInRect(point, rect, padding = 0) {
  if (!point || !rect) return true;
  return point.x >= rect.x - padding
    && point.x <= rect.x + rect.w + padding
    && point.y >= rect.y - padding
    && point.y <= rect.y + rect.h + padding;
}

function averageRingBrightness(image, x, y, radius) {
  const samples = 16;
  let total = 0;
  for (let i = 0; i < samples; i += 1) {
    const angle = (Math.PI * 2 * i) / samples;
    total += brightness(image.data, image.width, x + Math.cos(angle) * radius, y + Math.sin(angle) * radius);
  }
  return total / samples;
}

function markerProfileForBlob(blob) {
  const ringContrast = Math.max(0, (blob.meanBrightness || blob.brightness || 0) - (blob.ringBrightness || 0));
  const roundness = Math.min(blob.width || 1, blob.height || 1) / Math.max(blob.width || 1, blob.height || 1);
  return {
    ringContrast,
    markerScore: clamp((ringContrast / 95) * (0.55 + roundness * 0.45), 0, 1),
  };
}

function detectBrightBlobs(image, settings, rect) {
  const width = image.width;
  const height = image.height;
  const x0 = clamp(Math.floor(rect.x), 0, width);
  const y0 = clamp(Math.floor(rect.y), 0, height);
  const x1 = clamp(Math.ceil(rect.x + rect.w), 0, width);
  const y1 = clamp(Math.ceil(rect.y + rect.h), 0, height);
  const mapWidth = x1 - x0;
  const mapHeight = y1 - y0;
  if (mapWidth <= 0 || mapHeight <= 0) return [];

  const mask = new Uint8Array(mapWidth * mapHeight);
  const seen = new Uint8Array(mapWidth * mapHeight);
  for (let y = y0; y < y1; y += 1) {
    for (let x = x0; x < x1; x += 1) {
      const value = brightness(image.data, width, x, y);
      mask[(y - y0) * mapWidth + (x - x0)] = value >= settings.threshold ? 1 : 0;
    }
  }

  const blobs = [];
  for (let y = 0; y < mapHeight; y += 1) {
    for (let x = 0; x < mapWidth; x += 1) {
      const startIndex = y * mapWidth + x;
      if (!mask[startIndex] || seen[startIndex]) continue;

      const queue = [[x, y]];
      let head = 0;
      let count = 0;
      let sumX = 0;
      let sumY = 0;
      let maxBright = 0;
      let sumBright = 0;
      let minX = x;
      let maxX = x;
      let minY = y;
      let maxY = y;
      seen[startIndex] = 1;

      while (head < queue.length) {
        const [qx, qy] = queue[head];
        head += 1;
        const globalX = x0 + qx;
        const globalY = y0 + qy;
        const value = brightness(image.data, width, globalX, globalY);
        count += 1;
        sumX += qx;
        sumY += qy;
        sumBright += value;
        maxBright = Math.max(maxBright, value);
        minX = Math.min(minX, qx);
        maxX = Math.max(maxX, qx);
        minY = Math.min(minY, qy);
        maxY = Math.max(maxY, qy);

        [[1, 0], [-1, 0], [0, 1], [0, -1]].forEach(([dx, dy]) => {
          const nx = qx + dx;
          const ny = qy + dy;
          if (nx < 0 || ny < 0 || nx >= mapWidth || ny >= mapHeight) return;
          const nextIndex = ny * mapWidth + nx;
          if (!mask[nextIndex] || seen[nextIndex]) return;
          seen[nextIndex] = 1;
          queue.push([nx, ny]);
        });
      }

      if (count >= settings.minArea && count <= settings.maxArea) {
        const blobWidth = maxX - minX + 1;
        const blobHeight = maxY - minY + 1;
        const fill = count / Math.max(1, blobWidth * blobHeight);
        const candidate = {
          x: x0 + sumX / count,
          y: y0 + sumY / count,
          area: count,
          brightness: maxBright,
          meanBrightness: sumBright / count,
          width: blobWidth,
          height: blobHeight,
          fill,
        };
        const ringRadius = Math.max(5, Math.min(34, Math.max(blobWidth, blobHeight) * 0.72 + 4));
        candidate.ringBrightness = averageRingBrightness(image, candidate.x, candidate.y, ringRadius);
        Object.assign(candidate, markerProfileForBlob(candidate));
        blobs.push(candidate);
      }
    }
  }

  return blobs
    .sort((a, b) => b.markerScore - a.markerScore || b.brightness - a.brightness || b.area - a.area)
    .slice(0, 90);
}

function makeLearnedPoint(label, blob, image, fallback) {
  const x = blob?.x ?? fallback.x;
  const y = blob?.y ?? fallback.y;
  const bright = blob?.brightness ?? brightness(image.data, image.width, x, y);
  const area = blob?.area || 24;
  const markerScore = blob?.markerScore ?? 0;
  const ringContrast = blob?.ringContrast ?? 0;
  return {
    label,
    x,
    y,
    previousX: x,
    previousY: y,
    lastGoodX: x,
    lastGoodY: y,
    vx: 0,
    vy: 0,
    area,
    baseArea: area,
    baseWidth: blob?.width || Math.sqrt(area),
    baseHeight: blob?.height || Math.sqrt(area),
    baseBrightness: bright,
    baseMarkerScore: markerScore,
    brightness: bright,
    markerScore,
    ringContrast,
    confidence: blob ? 0.82 + markerScore * 0.18 : 0.65,
    lost: false,
    lostFrames: 0,
    mode: blob ? "learned_blob" : "learned_click",
    movedPx: 0,
    searchRadius: 0,
  };
}

function autoLearnDefaultPoints(image, settings) {
  const minimumSpacing = Math.max(26, Math.min(image.width, image.height) * 0.035);
  const candidates = detectBrightBlobs(image, settings, { x: 0, y: 0, w: image.width, h: image.height })
    .filter((blob) => blob.markerScore >= 0.18 || blob.ringContrast >= 18)
    .sort((a, b) => {
      const aScore = (a.markerScore || 0) * 100 + (a.ringContrast || 0) * 0.45 + (a.brightness || 0) * 0.08;
      const bScore = (b.markerScore || 0) * 100 + (b.ringContrast || 0) * 0.45 + (b.brightness || 0) * 0.08;
      return bScore - aScore;
    });
  const picked = [];
  candidates.forEach((blob) => {
    if (picked.length >= 6) return;
    if (picked.some((item) => Math.hypot(item.x - blob.x, item.y - blob.y) < minimumSpacing)) return;
    picked.push(blob);
  });
  if (picked.length < 6) return null;

  const byX = picked.slice().sort((a, b) => a.x - b.x);
  const left = byX.slice(0, 3).sort((a, b) => a.y - b.y);
  const right = byX.slice(3, 6).sort((a, b) => a.y - b.y);
  const assignments = [
    ["left_toe", left[0]],
    ["left_forefoot", left[1]],
    ["left_heel", left[2]],
    ["right_toe", right[0]],
    ["right_forefoot", right[1]],
    ["right_heel", right[2]],
  ];
  return assignments.map(([label, blob]) => makeLearnedPoint(label, blob, image, blob));
}

function scoreCandidate(blob, point, targetX, targetY, claimed) {
  if (claimed.some((item) => Math.hypot(blob.x - item.x, blob.y - item.y) < 10)) return Number.POSITIVE_INFINITY;
  const distance = Math.hypot(blob.x - targetX, blob.y - targetY);
  const baseArea = point.baseArea || point.area || 24;
  const areaRatio = Math.max(0.05, (blob.area || baseArea) / Math.max(1, baseArea));
  const areaPenalty = Math.abs(Math.log(areaRatio)) * 30;
  const widthPenalty = Math.abs(Math.log(Math.max(0.1, (blob.width || point.baseWidth || 1) / Math.max(1, point.baseWidth || blob.width || 1)))) * 8;
  const heightPenalty = Math.abs(Math.log(Math.max(0.1, (blob.height || point.baseHeight || 1) / Math.max(1, point.baseHeight || blob.height || 1)))) * 8;
  const brightnessPenalty = Math.max(0, (point.baseBrightness || 190) - (blob.brightness || 0)) * 0.26;
  const fillPenalty = blob.fill ? Math.abs(0.7 - blob.fill) * 12 : 4;
  const markerBonus = Math.max(blob.markerScore || 0, point.baseMarkerScore ? Math.min(blob.markerScore || 0, point.baseMarkerScore + 0.25) : 0) * 28;
  const anchorDistance = point.lastGoodX != null ? Math.hypot(blob.x - point.lastGoodX, blob.y - point.lastGoodY) : 0;
  const anchorPenalty = Math.max(0, anchorDistance - 420) * 0.65;
  const jumpPenalty = !point.lost && distance > 260 ? 90 : 0;
  return distance + areaPenalty + widthPenalty + heightPenalty + brightnessPenalty + fillPenalty + anchorPenalty + jumpPenalty - markerBonus;
}

function pickBestBlob(image, point, targetX, targetY, radius, settings, claimed, strict = false) {
  const blobs = detectBrightBlobs(image, settings, {
    x: targetX - radius,
    y: targetY - radius,
    w: radius * 2,
    h: radius * 2,
  });
  let best = null;
  let bestScore = Number.POSITIVE_INFINITY;
  blobs.forEach((blob) => {
    const score = scoreCandidate(blob, point, targetX, targetY, claimed);
    if (score < bestScore) {
      best = blob;
      bestScore = score;
    }
  });
  const markerLift = best?.markerScore ? best.markerScore * 18 : 0;
  const maxScore = (strict ? Math.max(80, radius * 0.72) : Math.max(110, radius * 0.95)) + markerLift;
  return best && bestScore < maxScore ? { ...best, score: bestScore, mode: "blob" } : null;
}

function pickFullFrameBlob(image, point, settings, claimed, options = {}) {
  const maxDistance = options.maxDistance ?? 520;
  const maxScore = options.maxScore ?? 175;
  const searchRect = options.rect || { x: 0, y: 0, w: image.width, h: image.height };
  const blobs = detectBrightBlobs(image, settings, searchRect);
  const anchorX = point.lastGoodX ?? point.x;
  const anchorY = point.lastGoodY ?? point.y;
  let best = null;
  let bestScore = Number.POSITIVE_INFINITY;
  blobs.forEach((blob) => {
    if (Math.hypot(blob.x - anchorX, blob.y - anchorY) > maxDistance) return;
    const score = scoreCandidate(blob, point, anchorX, anchorY, claimed);
    if (score < bestScore) {
      best = blob;
      bestScore = score;
    }
  });
  return best && bestScore < maxScore ? { ...best, score: bestScore, mode: "wide_reacquire" } : null;
}

function estimateFromCompanion(point, companion, targetCompanion) {
  if (!companion || !targetCompanion || companion.lost || !Number.isFinite(companion.lastGoodX) || !Number.isFinite(point.lastGoodX)) {
    return null;
  }
  return {
    x: companion.x + (point.lastGoodX - companion.lastGoodX),
    y: companion.y + (point.lastGoodY - companion.lastGoodY),
    weight: targetCompanion,
  };
}

function estimateGeometryTarget(point, points, image) {
  const [side, kind] = String(point.label || "").split("_");
  if (!side || !kind || !Number.isFinite(point.lastGoodX) || !Number.isFinite(point.lastGoodY)) return null;
  const byLabel = Object.fromEntries(points.map((item) => [item.label, item]));
  const toe = byLabel[`${side}_toe`];
  const forefoot = byLabel[`${side}_forefoot`];
  const heel = byLabel[`${side}_heel`];
  const estimates = [];

  if (kind === "heel") {
    estimates.push(estimateFromCompanion(point, forefoot, 1.2));
    estimates.push(estimateFromCompanion(point, toe, 0.8));
  } else if (kind === "toe") {
    estimates.push(estimateFromCompanion(point, forefoot, 1.2));
    estimates.push(estimateFromCompanion(point, heel, 0.8));
  } else if (kind === "forefoot") {
    estimates.push(estimateFromCompanion(point, toe, 1));
    estimates.push(estimateFromCompanion(point, heel, 1));
  }

  const usable = estimates.filter(Boolean);
  if (!usable.length) return null;
  const weight = usable.reduce((sum, item) => sum + item.weight, 0);
  const x = usable.reduce((sum, item) => sum + item.x * item.weight, 0) / weight;
  const y = usable.reduce((sum, item) => sum + item.y * item.weight, 0) / weight;
  return {
    x: clamp(x, 0, image.width),
    y: clamp(y, 0, image.height),
  };
}

function findNearbyPeak(image, point, radius, settings) {
  const anchorX = point.lastGoodX ?? point.x;
  const anchorY = point.lastGoodY ?? point.y;
  let best = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  for (let y = Math.max(0, Math.floor(anchorY - radius)); y < Math.min(image.height, Math.ceil(anchorY + radius)); y += 2) {
    for (let x = Math.max(0, Math.floor(anchorX - radius)); x < Math.min(image.width, Math.ceil(anchorX + radius)); x += 2) {
      const distance = Math.hypot(x - anchorX, y - anchorY);
      if (distance > radius) continue;
      const value = brightness(image.data, image.width, x, y);
      const score = value - distance * 0.18;
      if (score > bestScore) {
        bestScore = score;
        best = { x, y, area: 0, brightness: value, meanBrightness: value, mode: "peak_hold" };
      }
    }
  }
  return best && best.brightness > Math.max(110, settings.threshold - 50) ? best : null;
}

function updatePointWithBlob(point, blob) {
  const next = { ...point };
  const vx = blob.x - next.x;
  const vy = blob.y - next.y;
  next.previousX = next.x;
  next.previousY = next.y;
  next.x = blob.x;
  next.y = blob.y;
  next.area = blob.area || 0;
  next.brightness = blob.brightness || 0;
  next.ringContrast = blob.ringContrast || 0;
  next.markerScore = blob.markerScore || 0;
  next.movedPx = Math.hypot(next.x - next.previousX, next.y - next.previousY);
  next.mode = blob.mode || "blob";
  next.searchRadius = blob.searchRadius || next.searchRadius || 0;
  if (next.mode === "peak_hold") {
    next.vx = (next.vx || 0) * 0.15;
    next.vy = (next.vy || 0) * 0.15;
    next.confidence = 0.48;
    next.lostFrames = Math.max(0, (next.lostFrames || 0) - 1);
    next.lost = false;
    return next;
  }
  next.vx = (next.vx || 0) * 0.25 + vx * 0.75;
  next.vy = (next.vy || 0) * 0.25 + vy * 0.75;
  next.lastGoodX = blob.x;
  next.lastGoodY = blob.y;
  next.confidence = next.mode.includes("reacquire") ? 0.78 + next.markerScore * 0.18 : 0.82 + next.markerScore * 0.18;
  next.lostFrames = 0;
  next.lost = false;
  return next;
}

function coastPoint(point, settings) {
  const lostFrames = (point.lostFrames || 0) + 1;
  return {
    ...point,
    previousX: point.x,
    previousY: point.y,
    x: point.lastGoodX ?? point.x,
    y: point.lastGoodY ?? point.y,
    vx: (point.vx || 0) * 0.35,
    vy: (point.vy || 0) * 0.35,
    confidence: Math.max(0, 1 - lostFrames / settings.lostTolerance),
    lostFrames,
    lost: lostFrames >= settings.lostTolerance,
    movedPx: 0,
    mode: lostFrames >= settings.lostTolerance ? "lost" : "coast",
  };
}

function formatSeconds(value) {
  const total = Math.max(0, Math.round(Number(value) || 0));
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

function angleBetween(a, b, c) {
  if (!a || !b || !c) return null;
  const abx = a.x - b.x;
  const aby = a.y - b.y;
  const cbx = c.x - b.x;
  const cby = c.y - b.y;
  const denom = Math.hypot(abx, aby) * Math.hypot(cbx, cby);
  if (!denom) return null;
  const radians = Math.acos(clamp((abx * cbx + aby * cby) / denom, -1, 1));
  return (radians * 180) / Math.PI;
}

function describePlanting(value) {
  if (!Number.isFinite(value)) return "unknown";
  if (value >= 0.78) return "steady";
  if (value >= 0.45) return "shifting";
  return "active";
}

function describeToeActivity(value) {
  if (!Number.isFinite(value)) return "unknown";
  if (value <= 4) return "quiet";
  if (value <= 14) return "expressive";
  return "high motion";
}

function summarizeFootGeometry(points) {
  const byLabel = Object.fromEntries(points.map((point) => [point.label, point]));
  const summarizeSide = (side) => {
    const toe = byLabel[`${side}_toe`];
    const forefoot = byLabel[`${side}_forefoot`];
    const heel = byLabel[`${side}_heel`];
    const available = [toe, forefoot, heel].filter((point) => point && !point.lost);
    if (available.length < 2) {
      return {
        available_markers: available.length,
        confidence: Number((available.reduce((sum, point) => sum + (point.confidence || 0), 0) / Math.max(1, available.length)).toFixed(3)),
      };
    }
    const axisStart = heel && !heel.lost ? heel : forefoot;
    const axisEnd = toe && !toe.lost ? toe : forefoot;
    const angleDeg = axisStart && axisEnd
      ? (Math.atan2(axisEnd.y - axisStart.y, axisEnd.x - axisStart.x) * 180) / Math.PI
      : null;
    const movement = available.reduce((sum, point) => sum + (point.movedPx || 0), 0) / available.length;
    const plantedProxy = Number(clamp(1 - movement / 28, 0, 1).toFixed(3));
    const toeMovement = toe && !toe.lost ? toe.movedPx || 0 : null;
    const toeFan = toe && forefoot && heel && !toe.lost && !forefoot.lost && !heel.lost ? angleBetween(toe, forefoot, heel) : null;
    const heelStability = heel && !heel.lost ? clamp(1 - (heel.movedPx || 0) / 20, 0, 1) : null;
    return {
      available_markers: available.length,
      confidence: Number((available.reduce((sum, point) => sum + (point.confidence || 0), 0) / available.length).toFixed(3)),
      foot_angle_deg: Number.isFinite(angleDeg) ? Number(angleDeg.toFixed(1)) : null,
      toe_to_heel_px: toe && heel && !toe.lost && !heel.lost ? Number(pointDistance(toe, heel).toFixed(2)) : null,
      forefoot_to_heel_px: forefoot && heel && !forefoot.lost && !heel.lost ? Number(pointDistance(forefoot, heel).toFixed(2)) : null,
      toe_to_forefoot_px: toe && forefoot && !toe.lost && !forefoot.lost ? Number(pointDistance(toe, forefoot).toFixed(2)) : null,
      toe_fan_deg: Number.isFinite(toeFan) ? Number(toeFan.toFixed(1)) : null,
      toe_activity_px: Number.isFinite(toeMovement) ? Number(toeMovement.toFixed(2)) : null,
      heel_stability_proxy: Number.isFinite(heelStability) ? Number(heelStability.toFixed(3)) : null,
      planted_proxy: plantedProxy,
      planting: describePlanting(plantedProxy),
      toe_activity: describeToeActivity(toeMovement),
    };
  };
  const activeDistance = (a, b) => a && b && !a.lost && !b.lost ? Number(pointDistance(a, b).toFixed(2)) : null;
  return {
    left: summarizeSide("left"),
    right: summarizeSide("right"),
    bilateral: {
      heel_separation_px: activeDistance(byLabel.left_heel, byLabel.right_heel),
      toe_separation_px: activeDistance(byLabel.left_toe, byLabel.right_toe),
      forefoot_separation_px: activeDistance(byLabel.left_forefoot, byLabel.right_forefoot),
    },
  };
}

function buildSummary(points, settings, sessionTimeS) {
  const labels = {};
  points.forEach((point) => {
    labels[point.label] = {
      x_norm: Number.isFinite(point.xNorm) ? Number(point.xNorm.toFixed(5)) : null,
      y_norm: Number.isFinite(point.yNorm) ? Number(point.yNorm.toFixed(5)) : null,
      confidence: Number((point.confidence || 0).toFixed(3)),
      lost: Boolean(point.lost),
      mode: point.mode || "",
      moved_px: Number((point.movedPx || 0).toFixed(2)),
      brightness: Math.round(point.brightness || 0),
      marker_score: Number((point.markerScore || 0).toFixed(3)),
      ring_contrast: Math.round(point.ringContrast || 0),
    };
  });
  return {
    source: "live_capture_landmark_tracker",
    updated_at: new Date().toISOString(),
    session_time_s: Math.max(0, Math.round(Number(sessionTimeS) || 0)),
    expected_count: DEFAULT_LABELS.length,
    tracked_count: points.filter((point) => !point.lost).length,
    lost_count: points.filter((point) => point.lost).length,
    average_confidence: Number((points.reduce((sum, point) => sum + (point.confidence || 0), 0) / Math.max(1, points.length)).toFixed(3)),
    landmark_labels: labels,
    foot_geometry: summarizeFootGeometry(points),
    settings: {
      threshold: settings.threshold,
      min_area: settings.minArea,
      max_area: settings.maxArea,
      search_radius_px: settings.searchRadius,
      lost_tolerance_frames: settings.lostTolerance,
      reacquire_after_frames: settings.reacquireAfter,
      mirror: settings.mirror,
    },
    note: "Compact live foot marker tracking summary only. Raw video, raw frames, and raw landmarks are not persisted.",
  };
}

function MetricPill({ label, value, tone = "default" }) {
  const toneClass = tone === "good"
    ? "border-green-400/30 bg-green-400/10 text-green-200"
    : tone === "warn"
      ? "border-chart-3/35 bg-chart-3/10 text-chart-3"
      : "border-border bg-muted/30 text-foreground";
  return (
    <div className={`rounded-lg border px-3 py-2 ${toneClass}`}>
      <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{label}</p>
      <p className="mt-0.5 truncate text-sm font-semibold">{value ?? "unknown"}</p>
    </div>
  );
}

function FootMetricsPanel({ geometry, trackedCount, lostCount, compact = false }) {
  const leftPlanting = geometry?.left?.planting || "unknown";
  const rightPlanting = geometry?.right?.planting || "unknown";
  const heelStabilityValues = [geometry?.left?.heel_stability_proxy, geometry?.right?.heel_stability_proxy].filter(Number.isFinite);
  const heelStability = heelStabilityValues.length
    ? heelStabilityValues.reduce((sum, value) => sum + value, 0) / heelStabilityValues.length
    : null;
  const heelTone = heelStability >= 0.7 ? "good" : lostCount ? "warn" : "default";
  return (
    <div className={`grid gap-2 ${compact ? "sm:grid-cols-2 xl:grid-cols-6" : "sm:grid-cols-2 xl:grid-cols-3"}`}>
      <MetricPill label="Tracked" value={`${trackedCount}/6`} tone={lostCount ? "warn" : "good"} />
      <MetricPill label="Left foot" value={leftPlanting} tone={leftPlanting === "steady" ? "good" : "default"} />
      <MetricPill label="Right foot" value={rightPlanting} tone={rightPlanting === "steady" ? "good" : "default"} />
      <MetricPill label="Heel spread" value={geometry?.bilateral?.heel_separation_px ? `${Math.round(geometry.bilateral.heel_separation_px)} px` : "learning"} />
      <MetricPill label="Toe motion" value={`${geometry?.left?.toe_activity || "?"} / ${geometry?.right?.toe_activity || "?"}`} />
      <MetricPill label="Heel stability" value={heelStability != null ? `${Math.round(heelStability * 100)}% stable` : "learning"} tone={heelTone} />
    </div>
  );
}

export default function LiveFootLandmarkTracker({ sessionId, recordingActive, getSessionTimeS, onTrackingSnapshot, compact = false }) {
  const videoRef = useRef(null);
  const overlayRef = useRef(null);
  const clickRef = useRef(null);
  const offscreenRef = useRef(null);
  const animationRef = useRef(null);
  const streamRef = useRef(null);
  const objectUrlRef = useRef("");
  const pointsRef = useRef([]);
  const settingsRef = useRef(DEFAULT_SETTINGS);
  const lastEmitRef = useRef(0);
  const lastCsvRef = useRef(0);

  const [open, setOpen] = useState(true);
  const [status, setStatus] = useState("Ready");
  const [selectedLabel, setSelectedLabel] = useState("left_toe");
  const [settings, setSettings] = useState(() => ({ ...DEFAULT_SETTINGS, ...readStoredJson(SETTINGS_STORAGE_KEY, {}) }));
  const [points, setPoints] = useState(() => readStoredJson(POINTS_STORAGE_KEY, []));
  const [cameraActive, setCameraActive] = useState(false);
  const [videoLoaded, setVideoLoaded] = useState(false);
  const [trackingFrozen, setTrackingFrozen] = useState(false);
  const [csvRows, setCsvRows] = useState([]);
  const [recordCsv, setRecordCsv] = useState(false);
  const [candidateCount, setCandidateCount] = useState(0);

  const trackedCount = points.filter((point) => !point.lost).length;
  const lostCount = points.filter((point) => point.lost).length;
  const allDefaultPointsSet = useMemo(() => DEFAULT_LABELS.every((item) => points.some((point) => point.label === item.key)), [points]);
  const footGeometry = useMemo(() => summarizeFootGeometry(points), [points]);

  useEffect(() => {
    settingsRef.current = settings;
    localStorage.setItem(SETTINGS_STORAGE_KEY, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    pointsRef.current = points;
    localStorage.setItem(POINTS_STORAGE_KEY, JSON.stringify(points));
  }, [points]);

  const stopSource = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    if (objectUrlRef.current) {
      URL.revokeObjectURL(objectUrlRef.current);
      objectUrlRef.current = "";
    }
    const video = videoRef.current;
    if (video) {
      video.pause();
      video.removeAttribute("src");
      video.srcObject = null;
      video.load();
    }
    setCameraActive(false);
    setVideoLoaded(false);
  }, []);

  useEffect(() => () => {
    if (animationRef.current) cancelAnimationFrame(animationRef.current);
    stopSource();
  }, [stopSource]);

  const updateSetting = (key, value) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  };

  const getCanvasRect = useCallback(() => {
    const canvas = overlayRef.current;
    const video = videoRef.current;
    if (!canvas || !video?.videoWidth) return null;
    const rect = canvas.getBoundingClientRect();
    const scale = Math.min(rect.width / video.videoWidth, rect.height / video.videoHeight);
    const videoWidth = video.videoWidth * scale;
    const videoHeight = video.videoHeight * scale;
    return {
      displayWidth: rect.width,
      displayHeight: rect.height,
      videoWidth: video.videoWidth,
      videoHeight: video.videoHeight,
      scale,
      dx: (rect.width - videoWidth) / 2,
      dy: (rect.height - videoHeight) / 2,
    };
  }, []);

  const videoToScreen = useCallback((point) => {
    const rect = getCanvasRect();
    const mirror = settingsRef.current.mirror;
    if (!rect) return { x: 0, y: 0 };
    const x = mirror ? rect.videoWidth - point.x : point.x;
    return { x: rect.dx + x * rect.scale, y: rect.dy + point.y * rect.scale };
  }, [getCanvasRect]);

  const screenToVideo = useCallback((x, y) => {
    const rect = getCanvasRect();
    const mirror = settingsRef.current.mirror;
    if (!rect) return null;
    if (x < rect.dx || y < rect.dy || x > rect.dx + rect.videoWidth * rect.scale || y > rect.dy + rect.videoHeight * rect.scale) return null;
    let vx = (x - rect.dx) / rect.scale;
    const vy = (y - rect.dy) / rect.scale;
    if (mirror) vx = rect.videoWidth - vx;
    return { x: clamp(vx, 0, rect.videoWidth), y: clamp(vy, 0, rect.videoHeight) };
  }, [getCanvasRect]);

  const getFrame = useCallback(() => {
    const video = videoRef.current;
    if (!video?.videoWidth) return null;
    const canvas = offscreenRef.current || document.createElement("canvas");
    offscreenRef.current = canvas;
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    return ctx.getImageData(0, 0, canvas.width, canvas.height);
  }, []);

  const findNearestBlob = useCallback((image, point) => {
    const blobs = detectBrightBlobs(image, settingsRef.current, { x: 0, y: 0, w: image.width, h: image.height });
    setCandidateCount(settingsRef.current.showCandidates ? blobs.length : 0);
    let best = null;
    let bestDistance = Number.POSITIVE_INFINITY;
    blobs.forEach((blob) => {
      const distance = Math.hypot(blob.x - point.x, blob.y - point.y);
      if (distance < bestDistance) {
        best = blob;
        bestDistance = distance;
      }
    });
    return best && bestDistance < 130 ? best : null;
  }, []);

  const trackPoints = useCallback((image) => {
    if (trackingFrozen) return pointsRef.current;
    const settingsNow = settingsRef.current;
    const claimed = [];
    const footRoi = buildFootRoi(pointsRef.current, image);
    const keepInsideRoi = (candidate) => (candidate && footRoi.locked && !pointInRect(candidate, footRoi, 32) ? null : candidate);
    const nextPoints = pointsRef.current
      .slice()
      .sort((a, b) => (a.lostFrames || 0) - (b.lostFrames || 0))
      .map((point) => {
        const missedFrames = point.lostFrames || 0;
        const speed = Math.hypot(point.vx || 0, point.vy || 0);
        const anchorX = point.lastGoodX ?? point.x;
        const anchorY = point.lastGoodY ?? point.y;
        const predictedX = point.lost ? anchorX : point.x + (point.vx || 0) * 0.55;
        const predictedY = point.lost ? anchorY : point.y + (point.vy || 0) * 0.55;
        const radius = Math.min(520, settingsNow.searchRadius + speed * 1.6 + missedFrames * 18);
        let found = null;

        if (missedFrames > 0) {
          const anchorRadius = Math.min(460, 90 + missedFrames * 28);
          found = keepInsideRoi(pickBestBlob(image, point, anchorX, anchorY, anchorRadius, settingsNow, claimed, true));
          if (found) found.mode = "last_good_reacquire";
        }
        if (!found && missedFrames === 0) found = keepInsideRoi(pickBestBlob(image, point, predictedX, predictedY, radius, settingsNow, claimed));
        if (!found) {
          found = keepInsideRoi(pickBestBlob(image, point, anchorX, anchorY, Math.min(560, radius + 70 + missedFrames * 10), settingsNow, claimed, true));
          if (found) found.mode = missedFrames > 0 ? "anchor_reacquire" : "blob";
        }
        if (!found && missedFrames > 0) {
          const geometryTarget = estimateGeometryTarget(point, pointsRef.current, image);
          if (geometryTarget) {
            found = keepInsideRoi(pickBestBlob(image, point, geometryTarget.x, geometryTarget.y, Math.min(520, 110 + missedFrames * 30), settingsNow, claimed, false));
            if (found) found.mode = "geometry_reacquire";
          }
        }
        if (!found && missedFrames >= settingsNow.reacquireAfter) {
          const isHeel = String(point.label || "").endsWith("_heel");
          found = keepInsideRoi(pickFullFrameBlob(image, point, settingsNow, claimed, {
            rect: footRoi,
            maxDistance: isHeel ? 860 : 620,
            maxScore: isHeel ? 225 : 185,
          }));
        }
        if (!found && missedFrames < Math.max(3, Math.floor(settingsNow.lostTolerance * 0.35))) {
          found = keepInsideRoi(findNearbyPeak(image, point, Math.min(180, radius * 0.55), settingsNow));
        }

        if (!found) return coastPoint({ ...point, searchRadius: radius }, settingsNow);
        found.searchRadius = radius;
        const updated = updatePointWithBlob(point, found);
        if (found.mode !== "peak_hold") claimed.push({ x: updated.x, y: updated.y });
        return updated;
      })
      .map((point) => ({
        ...point,
        xNorm: image.width ? point.x / image.width : null,
        yNorm: image.height ? point.y / image.height : null,
      }));

    const ordered = DEFAULT_LABELS
      .map((item) => nextPoints.find((point) => point.label === item.key))
      .filter(Boolean);
    const custom = nextPoints.filter((point) => !DEFAULT_LABELS.some((item) => item.key === point.label));
    return [...ordered, ...custom];
  }, [trackingFrozen]);

  const drawOverlay = useCallback((image) => {
    const overlay = overlayRef.current;
    const click = clickRef.current;
    if (!overlay || !click) return;
    const rect = overlay.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    [overlay, click].forEach((canvas) => {
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      canvas.getContext("2d").setTransform(dpr, 0, 0, dpr, 0, 0);
    });
    const ctx = overlay.getContext("2d");
    const clickCtx = click.getContext("2d");
    ctx.clearRect(0, 0, rect.width, rect.height);
    clickCtx.clearRect(0, 0, rect.width, rect.height);
    ctx.font = "12px system-ui";
    ctx.lineWidth = 2.5;

    if (image && pointsRef.current.length >= 2) {
      const roi = buildFootRoi(pointsRef.current, image);
      if (roi.locked) {
        const topLeft = videoToScreen({ x: roi.x, y: roi.y });
        const bottomRight = videoToScreen({ x: roi.x + roi.w, y: roi.y + roi.h });
        ctx.strokeStyle = "rgba(45, 212, 191, .48)";
        ctx.setLineDash([8, 6]);
        ctx.strokeRect(
          Math.min(topLeft.x, bottomRight.x),
          Math.min(topLeft.y, bottomRight.y),
          Math.abs(bottomRight.x - topLeft.x),
          Math.abs(bottomRight.y - topLeft.y),
        );
        ctx.setLineDash([]);
        ctx.fillStyle = "rgba(45, 212, 191, .85)";
        ctx.fillText("foot ROI", Math.min(topLeft.x, bottomRight.x) + 8, Math.min(topLeft.y, bottomRight.y) + 16);
      }
    }

    if (settingsRef.current.showCandidates && image) {
      const roi = buildFootRoi(pointsRef.current, image);
      const candidates = detectBrightBlobs(image, settingsRef.current, roi.locked ? roi : { x: 0, y: 0, w: image.width, h: image.height });
      setCandidateCount(candidates.length);
      candidates.slice(0, 80).forEach((candidate) => {
        const point = videoToScreen(candidate);
        ctx.strokeStyle = "rgba(255,255,255,.42)";
        ctx.beginPath();
        ctx.arc(point.x, point.y, 5, 0, Math.PI * 2);
        ctx.stroke();
      });
    }

    pointsRef.current.forEach((point) => {
      const screen = videoToScreen(point);
      const color = point.lost ? "#ef4444" : point.mode?.includes("reacquire") ? "#f59e0b" : colorFor(point.label);
      ctx.strokeStyle = color;
      ctx.fillStyle = color;
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, 13, 0, Math.PI * 2);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, 3.5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillText(`${point.label.replaceAll("_", " ")} ${point.lost ? "lost" : point.mode || ""}`, screen.x + 15, screen.y - 12);
      ctx.strokeStyle = `${color}55`;
      ctx.beginPath();
      ctx.arc(screen.x, screen.y, (point.searchRadius || settingsRef.current.searchRadius) * (getCanvasRect()?.scale || 1), 0, Math.PI * 2);
      ctx.stroke();
    });
  }, [getCanvasRect, videoToScreen]);

  const recordCsvRow = useCallback((pointsNow, sessionTimeS) => {
    const row = { time_s: Number(sessionTimeS || 0).toFixed(3) };
    pointsNow.forEach((point) => {
      row[`${point.label}_x`] = point.lost ? "" : (point.x || 0).toFixed(2);
      row[`${point.label}_y`] = point.lost ? "" : (point.y || 0).toFixed(2);
      row[`${point.label}_confidence`] = (point.confidence || 0).toFixed(3);
      row[`${point.label}_lost`] = point.lost ? "1" : "0";
      row[`${point.label}_mode`] = point.mode || "";
      row[`${point.label}_moved_px`] = (point.movedPx || 0).toFixed(2);
      row[`${point.label}_marker_score`] = (point.markerScore || 0).toFixed(3);
      row[`${point.label}_ring_contrast`] = Math.round(point.ringContrast || 0);
    });
    setCsvRows((prev) => [...prev.slice(-(ROW_LIMIT - 1)), row]);
  }, []);

  const loop = useCallback(() => {
    const image = getFrame();
    if (image) {
      const nextPoints = trackPoints(image);
      pointsRef.current = nextPoints;
      setPoints(nextPoints);
      drawOverlay(image);
      const now = Date.now();
      const sessionTimeS = typeof getSessionTimeS === "function" ? getSessionTimeS() : 0;
      if (recordCsv && now - lastCsvRef.current > 500) {
        lastCsvRef.current = now;
        recordCsvRow(nextPoints, sessionTimeS);
      }
      if (onTrackingSnapshot && sessionId && now - lastEmitRef.current > 5000) {
        lastEmitRef.current = now;
        onTrackingSnapshot(buildSummary(nextPoints, settingsRef.current, sessionTimeS));
      }
    } else {
      drawOverlay(null);
    }
    animationRef.current = requestAnimationFrame(loop);
  }, [drawOverlay, getFrame, getSessionTimeS, onTrackingSnapshot, recordCsv, recordCsvRow, sessionId, trackPoints]);

  useEffect(() => {
    animationRef.current = requestAnimationFrame(loop);
    return () => {
      if (animationRef.current) cancelAnimationFrame(animationRef.current);
    };
  }, [loop]);

  const startCamera = async () => {
    stopSource();
    const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
    streamRef.current = stream;
    const video = videoRef.current;
    video.srcObject = stream;
    await video.play();
    setCameraActive(true);
    setVideoLoaded(true);
    setStatus("Camera live");
  };

  const loadVideo = async (file) => {
    if (!file) return;
    stopSource();
    const url = URL.createObjectURL(file);
    objectUrlRef.current = url;
    const video = videoRef.current;
    video.src = url;
    video.loop = true;
    await video.play();
    setVideoLoaded(true);
    setStatus(file.name);
  };

  const handleClick = (event) => {
    const image = getFrame();
    const canvas = clickRef.current;
    if (!image || !canvas) return;
    const rect = canvas.getBoundingClientRect();
    const point = screenToVideo(event.clientX - rect.left, event.clientY - rect.top);
    if (!point) {
      setStatus("Click inside the video frame to place the marker.");
      return;
    }
    const blob = findNearestBlob(image, point);
    const learned = makeLearnedPoint(selectedLabel, blob, image, point);
    learned.xNorm = image.width ? learned.x / image.width : null;
    learned.yNorm = image.height ? learned.y / image.height : null;
    const next = [...pointsRef.current.filter((item) => item.label !== selectedLabel), learned];
    const ordered = DEFAULT_LABELS.map((item) => next.find((pointItem) => pointItem.label === item.key)).filter(Boolean);
    pointsRef.current = ordered;
    setPoints(ordered);
    setStatus(`${DEFAULT_LABELS.find((item) => item.key === selectedLabel)?.label || selectedLabel} learned`);
  };

  const clearSelected = () => {
    const next = points.filter((point) => point.label !== selectedLabel);
    pointsRef.current = next;
    setPoints(next);
  };

  const clearAll = () => {
    pointsRef.current = [];
    setPoints([]);
    setCsvRows([]);
  };

  const autoLearnMarkers = () => {
    const image = getFrame();
    if (!image) {
      setStatus("Start a camera or video source before auto-learning markers.");
      return;
    }
    const learned = autoLearnDefaultPoints(image, settingsRef.current);
    if (!learned) {
      setStatus("Auto-learn did not find six clear marker dots. Manual marking is still available for tuning.");
      return;
    }
    pointsRef.current = learned;
    setPoints(learned);
    setStatus("Auto-learned six foot markers. Tap any marker to fine-tune if needed.");
  };

  const downloadCsv = () => {
    if (!csvRows.length) return;
    const fields = Array.from(new Set(csvRows.flatMap((row) => Object.keys(row)))).sort((a, b) => {
      if (a === "time_s") return -1;
      if (b === "time_s") return 1;
      return a.localeCompare(b);
    });
    const esc = (value) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const text = [fields.join(","), ...csvRows.map((row) => fields.map((field) => esc(row[field])).join(","))].join("\n");
    const blob = new Blob([text], { type: "text/csv" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `pulsepoint-live-foot-landmarks-${new Date().toISOString().slice(0, 10)}.csv`;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const showFullPanel = open && !compact;
  const hiddenEngineClass = "fixed -left-[10000px] top-0 h-[180px] w-[320px] overflow-hidden opacity-0 pointer-events-none";

  return (
    <section className={`rounded-xl border bg-card ${compact ? "border-primary/20" : "border-primary/25"}`}>
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-start gap-3 p-4 text-left"
        aria-expanded={showFullPanel}
      >
        <Crosshair className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
        <div className="min-w-0">
          <p className="text-xs font-semibold uppercase tracking-wider text-primary">Live Foot Landmark Tracker</p>
          <p className="mt-1 text-sm text-muted-foreground">
            {compact
              ? "Tracking stays active while you use this view, with compact derived foot evidence below."
              : "Learn the silver marker dots on big toes, forefeet, and heels, then keep tracking with fast geometry-aware reacquire."}
          </p>
        </div>
        <span className="ml-auto rounded-full border border-border bg-muted/40 px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
          {showFullPanel ? "Hide" : "Show"}
        </span>
      </button>

      {(compact || !open) && (
        <div className="space-y-3 border-t border-border p-3">
          <FootMetricsPanel geometry={footGeometry} trackedCount={trackedCount} lostCount={lostCount} compact />
          <p className="text-xs text-muted-foreground">
            {videoLoaded ? "Tracking engine is still running." : "Open the tracker setup panel to start a source and learn the markers."}
          </p>
        </div>
      )}

      <div className={showFullPanel ? "space-y-4 border-t border-border p-4" : hiddenEngineClass} aria-hidden={!showFullPanel}>
          <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]">
            <div className="space-y-3">
              <div className="relative aspect-video overflow-hidden rounded-xl border border-border bg-black">
                <video
                  ref={videoRef}
                  muted
                  playsInline
                  className="absolute inset-0 h-full w-full object-contain"
                  style={{ transform: settings.mirror ? "scaleX(-1)" : "none" }}
                />
                <canvas ref={overlayRef} className="absolute inset-0 h-full w-full" />
                <canvas
                  ref={clickRef}
                  onClick={handleClick}
                  className="absolute inset-0 h-full w-full cursor-crosshair"
                  aria-label="Live foot landmark placement canvas"
                />
                {!videoLoaded && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/70 p-6 text-center">
                    <div>
                      <Crosshair className="mx-auto mb-3 h-8 w-8 text-primary" />
                      <p className="font-semibold text-foreground">Load a camera or video to place landmark dots.</p>
                      <p className="mt-1 text-sm text-muted-foreground">Click a marker button, then click the black-bordered silver dot in the large preview.</p>
                    </div>
                  </div>
                )}
              </div>
              <div className="grid gap-2 sm:grid-cols-3">
                <div className="rounded-lg border border-border bg-muted/20 p-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Tracked</p>
                  <p className="mt-1 text-2xl font-bold text-primary">{trackedCount}/{points.length || DEFAULT_LABELS.length}</p>
                </div>
                <div className="rounded-lg border border-border bg-muted/20 p-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Lost</p>
                  <p className="mt-1 text-2xl font-bold text-chart-3">{lostCount}</p>
                </div>
                <div className="rounded-lg border border-border bg-muted/20 p-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Saved Summary</p>
                  <p className="mt-1 text-sm font-semibold text-foreground">
                    {sessionId ? (recordingActive ? "Live session" : "Session ready") : "No live session"}
                  </p>
                  <p className="mt-1 text-[10px] text-muted-foreground">Raw video and frames are not persisted.</p>
                </div>
              </div>
              <FootMetricsPanel geometry={footGeometry} trackedCount={trackedCount} lostCount={lostCount} />
            </div>

            <div className="space-y-3">
              <div className="rounded-xl border border-border bg-muted/20 p-3">
                <p className="text-xs font-semibold uppercase tracking-wider text-primary">Source</p>
                <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
                  <button type="button" onClick={startCamera} className="inline-flex items-center justify-center gap-2 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2 text-sm font-semibold text-foreground hover:bg-primary/15">
                    <Camera className="h-4 w-4 text-primary" />
                    Start camera
                  </button>
                  <label className="inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm font-semibold text-foreground hover:bg-muted/50">
                    <UploadCloud className="h-4 w-4 text-primary" />
                    Load video
                    <input type="file" accept="video/*" className="hidden" onChange={(event) => loadVideo(event.target.files?.[0])} />
                  </label>
                  <button type="button" onClick={() => videoRef.current?.play()} className="inline-flex items-center justify-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm font-semibold text-foreground hover:bg-muted/50">
                    <Play className="h-4 w-4 text-primary" />
                    Play
                  </button>
                  <button type="button" onClick={() => videoRef.current?.pause()} className="inline-flex items-center justify-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm font-semibold text-foreground hover:bg-muted/50">
                    <Pause className="h-4 w-4 text-primary" />
                    Pause
                  </button>
                  <button type="button" onClick={stopSource} className="inline-flex items-center justify-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm font-semibold text-foreground hover:bg-destructive/15">
                    <Square className="h-4 w-4 text-destructive" />
                    Stop source
                  </button>
                  <button type="button" onClick={() => setTrackingFrozen((value) => !value)} className="inline-flex items-center justify-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm font-semibold text-foreground hover:bg-muted/50">
                    <ShieldCheck className="h-4 w-4 text-primary" />
                    {trackingFrozen ? "Resume tracking" : "Freeze tracking"}
                  </button>
                  <button type="button" onClick={autoLearnMarkers} className="inline-flex items-center justify-center gap-2 rounded-lg border border-primary/40 bg-primary/10 px-3 py-2 text-sm font-semibold text-foreground hover:bg-primary/15">
                    <Crosshair className="h-4 w-4 text-primary" />
                    Auto-learn dots
                  </button>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">{status}</p>
              </div>

              <div className="rounded-xl border border-primary/20 bg-primary/[0.06] p-3">
                <p className="text-xs font-semibold uppercase tracking-wider text-primary">Click To Mark</p>
                <div className="mt-3 grid gap-2 sm:grid-cols-2 xl:grid-cols-1">
                  {DEFAULT_LABELS.map((item) => {
                    const point = points.find((candidate) => candidate.label === item.key);
                    const active = selectedLabel === item.key;
                    return (
                      <button
                        key={item.key}
                        type="button"
                        onClick={() => setSelectedLabel(item.key)}
                        className={`rounded-lg border px-3 py-2 text-left text-sm font-semibold transition-colors ${
                          active
                            ? "border-primary bg-primary/15 text-foreground"
                            : point?.lost
                              ? "border-chart-3/50 bg-chart-3/10 text-foreground"
                              : point
                                ? "border-green-400/40 bg-green-400/10 text-foreground"
                                : "border-border bg-card text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                        }`}
                      >
                        <span className="inline-flex items-center gap-2">
                          <span className="h-2.5 w-2.5 rounded-full" style={{ backgroundColor: item.color }} />
                          {item.label}
                        </span>
                        <span className="mt-1 block text-[10px] font-medium text-muted-foreground">
                          {point ? (point.lost ? "Lost, reacquiring" : `${point.mode || "tracking"} · ${Math.round((point.confidence || 0) * 100)}%`) : "Not marked"}
                        </span>
                      </button>
                    );
                  })}
                </div>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <button type="button" onClick={clearSelected} className="rounded-lg border border-border bg-card px-3 py-2 text-sm font-semibold text-foreground hover:bg-muted/50">
                    Clear selected
                  </button>
                  <button type="button" onClick={clearAll} className="inline-flex items-center justify-center gap-2 rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm font-semibold text-foreground hover:bg-destructive/15">
                    <RotateCcw className="h-4 w-4 text-destructive" />
                    Clear all
                  </button>
                </div>
              </div>

              <div className="rounded-xl border border-border bg-muted/20 p-3">
                <p className="text-xs font-semibold uppercase tracking-wider text-primary">Detection</p>
                <div className="mt-3 space-y-3">
                  {[
                    ["threshold", "Threshold", 0, 255, 1],
                    ["minArea", "Min area", 1, 500, 1],
                    ["maxArea", "Max area", 100, 30000, 100],
                    ["searchRadius", "Search radius", 20, 500, 5],
                    ["lostTolerance", "Lost tolerance", 1, 100, 1],
                    ["reacquireAfter", "Reacquire after", 0, 60, 1],
                  ].map(([key, label, min, max, step]) => (
                    <label key={key} className="block text-xs text-muted-foreground">
                      <span className="flex justify-between gap-3">
                        <span className="font-semibold uppercase tracking-wider">{label}</span>
                        <span>{settings[key]}</span>
                      </span>
                      <input
                        type="range"
                        min={min}
                        max={max}
                        step={step}
                        value={settings[key]}
                        onChange={(event) => updateSetting(key, Number(event.target.value))}
                        className="mt-1 w-full accent-primary"
                      />
                    </label>
                  ))}
                </div>
                <div className="mt-3 space-y-2 text-sm text-muted-foreground">
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={settings.mirror} onChange={(event) => updateSetting("mirror", event.target.checked)} className="h-4 w-4 accent-primary" />
                    Mirror preview/tracking
                  </label>
                  <label className="flex items-center gap-2">
                    <input type="checkbox" checked={settings.showCandidates} onChange={(event) => updateSetting("showCandidates", event.target.checked)} className="h-4 w-4 accent-primary" />
                    Show debug candidates ({candidateCount})
                  </label>
                </div>
              </div>

              <div className="rounded-xl border border-border bg-muted/20 p-3">
                <p className="text-xs font-semibold uppercase tracking-wider text-primary">Local CSV</p>
                <div className="mt-3 grid gap-2 sm:grid-cols-2">
                  <button type="button" onClick={() => setRecordCsv((value) => !value)} className="rounded-lg border border-primary/40 bg-primary/10 px-3 py-2 text-sm font-semibold text-foreground hover:bg-primary/15">
                    {recordCsv ? "Stop CSV" : "Start CSV"}
                  </button>
                  <button type="button" onClick={downloadCsv} disabled={!csvRows.length} className="inline-flex items-center justify-center gap-2 rounded-lg border border-border bg-card px-3 py-2 text-sm font-semibold text-foreground hover:bg-muted/50 disabled:opacity-50">
                    <Download className="h-4 w-4 text-primary" />
                    Download
                  </button>
                </div>
                <p className="mt-2 text-xs text-muted-foreground">{csvRows.length} local row{csvRows.length === 1 ? "" : "s"} buffered. This is a manual export only.</p>
              </div>
            </div>
          </div>

          <div className="rounded-lg border border-primary/20 bg-primary/[0.06] p-3 text-xs text-muted-foreground">
            <span className="font-semibold text-foreground">How to use:</span> place black-bordered silver dots on both big toes, forefeet, and heels. Select a marker button, click the dot in the big preview, then let the tracker follow it. If a dot disappears briefly, the tracker holds the last reliable neighborhood and tries to reacquire there before widening the search.
            {allDefaultPointsSet ? <span className="ml-2 text-green-300">All six default foot markers are learned.</span> : null}
          </div>
        </div>
    </section>
  );
}
