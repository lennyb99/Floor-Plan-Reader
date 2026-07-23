"""Conservative fusion for complementary floor-plan object detectors."""

from __future__ import annotations

import math

import cv2
import numpy as np


FALLBACK_CLASS_THRESHOLDS = {
    "Tuer": 0.30,
    "Doppeltuer": 0.30,
    "Fenster": 0.32,
    "Toilette": 0.55,
    "Waschbecken": 0.55,
    "Herd": 0.55,
}


def _class_family(name: str) -> str:
    return "Tuer" if name in {"Tuer", "Doppeltuer"} else name


def _iou(left: dict, right: dict) -> float:
    x1 = max(left["xmin"], right["xmin"])
    y1 = max(left["ymin"], right["ymin"])
    x2 = min(left["xmax"], right["xmax"])
    y2 = min(left["ymax"], right["ymax"])
    intersection = max(0.0, x2 - x1) * max(0.0, y2 - y1)
    left_area = max(0.0, left["xmax"] - left["xmin"]) * max(0.0, left["ymax"] - left["ymin"])
    right_area = max(0.0, right["xmax"] - right["xmin"]) * max(0.0, right["ymax"] - right["ymin"])
    union = left_area + right_area - intersection
    return intersection / union if union > 0 else 0.0


def _same_object(left: dict, right: dict) -> bool:
    if _class_family(left["name"]) != _class_family(right["name"]):
        return False
    if _iou(left["bbox"], right["bbox"]) >= 0.25:
        return True

    a, b = left["bbox"], right["bbox"]
    ac = ((a["xmin"] + a["xmax"]) / 2, (a["ymin"] + a["ymax"]) / 2)
    bc = ((b["xmin"] + b["xmax"]) / 2, (b["ymin"] + b["ymax"]) / 2)
    scale = max(
        1.0,
        min(a["xmax"] - a["xmin"], a["ymax"] - a["ymin"]),
        min(b["xmax"] - b["xmin"], b["ymax"] - b["ymin"]),
    )
    return math.dist(ac, bc) <= 0.30 * scale


def merge_detection_sets(
    primary: list[dict],
    fallback: list[dict],
    requested_confidence: float,
) -> list[dict]:
    """Keep every primary result and add only reliable missing fallback boxes."""
    merged = list(primary)
    for candidate in sorted(fallback, key=lambda item: item["confidence"], reverse=True):
        threshold = FALLBACK_CLASS_THRESHOLDS.get(candidate["name"])
        if threshold is None or candidate["confidence"] < max(requested_confidence, threshold):
            continue
        if any(_same_object(candidate, existing) for existing in merged):
            continue
        enriched = dict(candidate)
        enriched["source"] = "handdrawn_fallback"
        merged.append(enriched)
    return merged


def detect_stair_candidate(image_rgb: np.ndarray, existing: list[dict]) -> list[dict]:
    """Recover a missed stair symbol from a regular ladder-like ink pattern.

    This is deliberately a high-precision fallback: at least five parallel,
    similarly spaced treads must overlap. Windows usually contribute only two
    or three parallel strokes and therefore do not pass the check.
    """
    if any(item["name"] == "Treppe" for item in existing):
        return []

    gray = cv2.cvtColor(np.asarray(image_rgb), cv2.COLOR_RGB2GRAY)
    _, ink = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    segments = cv2.HoughLinesP(
        ink,
        rho=1,
        theta=np.pi / 180,
        threshold=18,
        minLineLength=16,
        maxLineGap=4,
    )
    if segments is None:
        return []

    candidates: list[dict] = []
    segment_rows = np.asarray(segments).reshape(-1, 4)
    for orientation in ("h", "v"):
        records = []
        for raw in segment_rows:
            x1, y1, x2, y2 = map(float, raw)
            if orientation == "h" and abs(y2 - y1) <= 3 and abs(x2 - x1) >= 16:
                records.append({"axis": (y1 + y2) / 2, "start": min(x1, x2), "end": max(x1, x2)})
            elif orientation == "v" and abs(x2 - x1) <= 3 and abs(y2 - y1) >= 16:
                records.append({"axis": (x1 + x2) / 2, "start": min(y1, y2), "end": max(y1, y2)})
        if len(records) < 5:
            continue

        # Remove multiple Hough responses from the same physical stroke.
        records.sort(key=lambda item: (item["axis"], item["start"]))
        unique = []
        for record in records:
            duplicate = next((
                item for item in unique
                if abs(item["axis"] - record["axis"]) <= 2.0
                and min(item["end"], record["end"]) - max(item["start"], record["start"]) >= 0.55 * min(
                    item["end"] - item["start"], record["end"] - record["start"]
                )
            ), None)
            if duplicate is None:
                unique.append(record)
            elif record["end"] - record["start"] > duplicate["end"] - duplicate["start"]:
                duplicate.update(record)

        parent = list(range(len(unique)))

        def find(index: int) -> int:
            while parent[index] != index:
                parent[index] = parent[parent[index]]
                index = parent[index]
            return index

        def union(left: int, right: int) -> None:
            a, b = find(left), find(right)
            if a != b:
                parent[b] = a

        for left, first in enumerate(unique):
            for right in range(left + 1, len(unique)):
                second = unique[right]
                axis_gap = abs(first["axis"] - second["axis"])
                if not 3.0 <= axis_gap <= 24.0:
                    continue
                overlap = min(first["end"], second["end"]) - max(first["start"], second["start"])
                if overlap >= 0.55 * min(first["end"] - first["start"], second["end"] - second["start"]):
                    union(left, right)

        groups: dict[int, list[dict]] = {}
        for index, record in enumerate(unique):
            groups.setdefault(find(index), []).append(record)

        for group in groups.values():
            group = sorted(group, key=lambda item: item["axis"])
            if len(group) < 5:
                continue
            gaps = np.diff([item["axis"] for item in group])
            median_gap = float(np.median(gaps))
            if not 3.0 <= median_gap <= 20.0:
                continue
            if float(np.median(np.abs(gaps - median_gap))) > max(2.5, 0.45 * median_gap):
                continue

            axis_min, axis_max = group[0]["axis"], group[-1]["axis"]
            projection_min = min(item["start"] for item in group)
            projection_max = max(item["end"] for item in group)
            if axis_max - axis_min > 150 or projection_max - projection_min > 210:
                continue

            if orientation == "h":
                bbox = {
                    "xmin": max(0.0, projection_min - 6), "ymin": max(0.0, axis_min - 6),
                    "xmax": min(511.0, projection_max + 6), "ymax": min(511.0, axis_max + 6),
                }
            else:
                bbox = {
                    "xmin": max(0.0, axis_min - 6), "ymin": max(0.0, projection_min - 6),
                    "xmax": min(511.0, axis_max + 6), "ymax": min(511.0, projection_max + 6),
                }
            candidates.append({
                "name": "Treppe",
                "confidence": round(min(0.82, 0.55 + 0.03 * len(group)), 2),
                "bbox": {key: round(value, 1) for key, value in bbox.items()},
                "source": "geometry_fallback",
                "tread_count": len(group),
            })

    if not candidates:
        return []
    return [max(candidates, key=lambda item: (item["tread_count"], item["confidence"]))]
