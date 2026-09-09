"""Local, ephemeral manual-window CV. No cloud upload, pose inference, or physiology inference.

Requires numpy and opencv-python-headless (also supplied by the existing Modal image).
ROI identities come from a separate current-window localization pass, never prior prose.
Coordinates are normalized in the unmirrored source. Lost tracks are not relabelled.
"""
import argparse
import json
from pathlib import Path

import cv2
import numpy as np


def rounded(value):
    return round(float(value), 4)


def bounds(box, width, height):
    x, y, w, h = box
    return (max(0, int(x * width)), max(0, int(y * height)),
            min(width, int((x + w) * width)), min(height, int((y + h) * height)))


def valid_regions(regions):
    allowed = {"pelvis", "hip", "thigh", "knee", "calf", "ankle", "heel", "foot", "forefoot", "sole", "toes"}
    result = []
    for item in regions[:32]:
        box = item.get("box", [])
        if item.get("region") not in allowed or len(box) != 4:
            continue
        if not all(isinstance(v, (int, float)) and np.isfinite(v) for v in box):
            continue
        x, y, w, h = box
        if min(x, y) < 0 or min(w, h) <= 0 or x + w > 1.001 or y + h > 1.001:
            continue
        result.append({**item, "id": f"region-{len(result)}", "side": item.get("side") if item.get("side") in ["left", "right", "midline"] else "unresolved"})
    return result


def features(gray, box=None, mask=None):
    if mask is None:
        mask = np.zeros_like(gray)
        if box is not None:
            x1, y1, x2, y2 = bounds(box, gray.shape[1], gray.shape[0])
            mask[y1:y2, x1:x2] = 255
        else:
            mask[:] = 255
    return cv2.goodFeaturesToTrack(gray, 180, 0.008, 5, mask=mask, blockSize=5)


def track_points(previous, current, points, with_indices=False):
    empty = (None, None, np.array([], dtype=int)) if with_indices else (None, None)
    if points is None or len(points) < 3:
        return empty
    new, status, _ = cv2.calcOpticalFlowPyrLK(previous, current, points, None, winSize=(21, 21), maxLevel=3)
    if new is None:
        return empty
    back, back_status, _ = cv2.calcOpticalFlowPyrLK(current, previous, new, None, winSize=(21, 21), maxLevel=3)
    if back is None:
        return empty
    good = (status.ravel() == 1) & (back_status.ravel() == 1) & (np.linalg.norm(points - back, axis=2).ravel() < 1.5)
    pair = (points[good].reshape(-1, 2), new[good].reshape(-1, 2))
    return (*pair, np.flatnonzero(good)) if with_indices else pair


def analyze(directory, frames, regions):
    first = cv2.imread(str(directory / frames[0]["filename"]))
    if first is None:
        raise ValueError("Cannot read the first dense frame")
    height, width = first.shape[:2]
    previous = cv2.cvtColor(first, cv2.COLOR_BGR2GRAY)
    regions = valid_regions(regions)
    tracks = [{**r, "points": features(previous, r["box"]), "lost": False, "samples": []} for r in regions]
    metrics = []
    for index, descriptor in enumerate(frames[1:], 1):
        frame = cv2.imread(str(directory / descriptor["filename"]))
        if frame is None:
            raise ValueError("Dense frame decoding failed")
        gray = cv2.cvtColor(frame, cv2.COLOR_BGR2GRAY)
        # Estimate camera motion ONLY from outside localized anatomy. With no
        # localized body/background separation, mark compensation unavailable.
        background = np.full_like(previous, 255)
        for track in tracks:
            x1, y1, x2, y2 = bounds(track["box"], width, height)
            margin = 20
            background[max(0, y1-margin):min(height, y2+margin), max(0, x1-margin):min(width, x2+margin)] = 0
        old_bg, new_bg = track_points(previous, gray, features(previous, mask=background)) if tracks else (None, None)
        matrix, inliers = (None, None)
        if old_bg is not None and len(old_bg) >= 12:
            matrix, inliers = cv2.estimateAffinePartial2D(old_bg, new_bg, method=cv2.RANSAC, ransacReprojThreshold=1.5)
        compensated = matrix is not None and inliers is not None and float(inliers.mean()) >= 0.65
        if not compensated:
            matrix = np.array([[1., 0., 0.], [0., 1., 0.]])
        aligned = cv2.warpAffine(previous, matrix, (width, height), flags=cv2.INTER_LINEAR, borderMode=cv2.BORDER_REFLECT)
        # Native-resolution dense flow covers the ENTIRE frame, even anatomy
        # localization misses a region. Optical flow is movement, not joint angle.
        flow = cv2.calcOpticalFlowFarneback(aligned, gray, None, 0.5, 3, 15, 3, 5, 1.2, 0)
        magnitude = np.linalg.norm(flow, axis=2)
        tiles = []
        for row in range(4):
            for col in range(4):
                x1, y1, x2, y2 = bounds([col/4, row/4, .25, .25], width, height)
                vectors = flow[y1:y2, x1:x2]
                tiles.append({"cell": [row, col], "p90_px": rounded(np.percentile(magnitude[y1:y2, x1:x2], 90)),
                              "dx_px": rounded(np.median(vectors[:, :, 0])), "dy_px": rounded(np.median(vectors[:, :, 1]))})
        metrics.append({"time_s": descriptor["time_s"], "camera_compensated": bool(compensated),
                        "camera_affine": [[rounded(v) for v in row] for row in matrix],
                        "motion_p95_px": rounded(np.percentile(magnitude, 95)), "tiles": tiles})
        # One shared LK pass for every anatomical region avoids rebuilding the
        # full 1080p image pyramids separately for each foot/toe/knee ROI.
        groups, cursor = [], 0
        for track in tracks:
            points = track["points"] if not track["lost"] else None
            length = len(points) if points is not None else 0
            track["point_range"] = (cursor, cursor + length)
            cursor += length
            if length:
                groups.append(points)
        all_old, all_new, indices = track_points(previous, gray, np.concatenate(groups) if groups else None, with_indices=True)
        for track in tracks:
            begin, finish = track["point_range"]
            selection = (indices >= begin) & (indices < finish)
            old = all_old[selection] if all_old is not None else None
            new = all_new[selection] if all_new is not None else None
            if old is None or len(old) < 4:
                track["lost"] = True
                track["samples"].append({"time_s": descriptor["time_s"], "tracking": "lost"})
                continue
            shift = np.median(new - old, axis=0)
            predicted = cv2.transform(old.reshape(-1, 1, 2), matrix).reshape(-1, 2)
            residual = new - predicted
            delta = np.median(residual, axis=0)
            box = track["box"]
            box = [float(np.clip(box[0] + shift[0]/width, 0, 1-box[2])), float(np.clip(box[1] + shift[1]/height, 0, 1-box[3])), box[2], box[3]]
            track["box"] = box
            track["points"] = new.reshape(-1, 1, 2)
            x1, y1, x2, y2 = bounds(box, width, height)
            local_mag = magnitude[y1:y2, x1:x2]
            track["samples"].append({"time_s": descriptor["time_s"], "tracking": "tracked", "box": [rounded(v) for v in box],
                                     "feature_count": len(new), "dx_px": rounded(delta[0]), "dy_px": rounded(delta[1]),
                                     "motion_p90_px": rounded(np.percentile(local_mag, 90)), "camera_compensated": bool(compensated)})
        previous = gray
    # Store all numeric samples for future temporal comparisons; no media paths.
    output_tracks = []
    for track in tracks:
        samples = track["samples"]
        episodes, active, directions = [], None, []
        for sample in samples:
            moving = sample.get("tracking") == "tracked" and sample.get("motion_p90_px", 0) >= .25
            if moving:
                if active is None:
                    active = {"onset_s": sample["time_s"], "offset_s": sample["time_s"], "peak_px": 0., "direction_changes": 0}
                    directions = []
                active["offset_s"] = sample["time_s"]
                active["peak_px"] = max(active["peak_px"], sample["motion_p90_px"])
                vector = np.array([sample["dx_px"], sample["dy_px"]])
                if np.linalg.norm(vector) >= .15:
                    if directions and np.dot(directions[-1], vector) < -.02:
                        active["direction_changes"] += 1
                    directions.append(vector)
            elif active is not None:
                active["end_reason"] = "tracking_lost" if sample.get("tracking") == "lost" else "motion_below_threshold"
                episodes.append(active)
                active = None
        if active is not None:
            active["end_reason"] = "window_end"
            episodes.append(active)
        output_tracks.append({k: v for k, v in track.items() if k not in ["points", "lost", "box", "point_range"]} | {"episodes": episodes})
    return {"schema_version": "manual-motion.v1", "method": "native Farneback + forward/backward LK + background RANSAC affine",
            "width": width, "height": height, "frame_times_s": [f["time_s"] for f in frames],
            "candidate_threshold_px": .25, "tracks": output_tracks, "frame_metrics": metrics,
            "interpretation": "Pixel displacement is not anatomical angle, force, tension, or relaxation. Track side is a localization hypothesis; lost tracks stay unresolved."}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("manifest")
    args = parser.parse_args()
    manifest_path = Path(args.manifest).resolve()
    data = json.loads(manifest_path.read_text(encoding="utf-8"))
    result = analyze(manifest_path.parent, data["frames"], data.get("regions", []))
    (manifest_path.parent / "motion.json").write_text(json.dumps(result, separators=(",", ":")), encoding="utf-8")


if __name__ == "__main__":
    main()
