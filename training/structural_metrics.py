"""Structural wall-mask metrics for floor-plan validation.

Dice and IoU are useful, but they can hide small gaps, duplicated wall bands
and shifted wall edges.  The metrics in this module are deliberately
diagnostic: they complement pixel overlap and are not trained on the holdout.
"""

from __future__ import annotations

import cv2
import numpy as np
from skimage.morphology import skeletonize


def _binary(mask: np.ndarray) -> np.ndarray:
    array = np.asarray(mask)
    if array.ndim > 2:
        array = np.squeeze(array)
    if array.ndim != 2:
        raise ValueError(f"Expected a 2D mask, got shape {array.shape}")
    return array.astype(bool)


def _boundary(mask: np.ndarray) -> np.ndarray:
    data = mask.astype(np.uint8)
    kernel = np.ones((3, 3), dtype=np.uint8)
    dilated = cv2.dilate(data, kernel, iterations=1)
    eroded = cv2.erode(data, kernel, iterations=1)
    return (dilated != eroded)


def _distance_to(features: np.ndarray) -> np.ndarray:
    if not np.any(features):
        return np.full(features.shape, np.inf, dtype=np.float32)
    inverse = (~features).astype(np.uint8)
    return cv2.distanceTransform(inverse, cv2.DIST_L2, 3)


def boundary_scores(
    prediction: np.ndarray,
    target: np.ndarray,
    tolerance_px: float = 3.0,
) -> dict[str, float]:
    """Return symmetric boundary precision/recall/F1 with pixel tolerance."""
    pred_boundary = _boundary(_binary(prediction))
    target_boundary = _boundary(_binary(target))
    pred_count = int(pred_boundary.sum())
    target_count = int(target_boundary.sum())
    if pred_count == 0 and target_count == 0:
        return {"boundary_precision": 1.0, "boundary_recall": 1.0, "boundary_f1": 1.0}

    pred_matches = int(np.sum(_distance_to(target_boundary)[pred_boundary] <= tolerance_px))
    target_matches = int(np.sum(_distance_to(pred_boundary)[target_boundary] <= tolerance_px))
    precision = pred_matches / max(pred_count, 1)
    recall = target_matches / max(target_count, 1)
    f1 = (2.0 * precision * recall) / max(precision + recall, 1e-12)
    return {
        "boundary_precision": float(precision),
        "boundary_recall": float(recall),
        "boundary_f1": float(f1),
    }


def _significant_components(mask: np.ndarray, min_area: int) -> int:
    count, _, stats, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), connectivity=8)
    if count <= 1:
        return 0
    return int(np.sum(stats[1:, cv2.CC_STAT_AREA] >= min_area))


def _feature_clusters(features: np.ndarray) -> int:
    count, _ = cv2.connectedComponents(features.astype(np.uint8), connectivity=8)
    return max(0, int(count) - 1)


def _skeleton_features(mask: np.ndarray) -> tuple[np.ndarray, int, int]:
    skeleton = skeletonize(mask).astype(np.uint8)
    neighbour_kernel = np.ones((3, 3), dtype=np.uint8)
    neighbours = cv2.filter2D(skeleton, cv2.CV_16U, neighbour_kernel) - skeleton
    endpoints = _feature_clusters((skeleton > 0) & (neighbours == 1))
    junctions = _feature_clusters((skeleton > 0) & (neighbours >= 3))
    return skeleton.astype(bool), endpoints, junctions


def _relative_count_score(prediction: int, target: int) -> float:
    return max(0.0, 1.0 - abs(prediction - target) / max(prediction, target, 1))


def topology_scores(
    prediction: np.ndarray,
    target: np.ndarray,
    min_component_area: int = 32,
) -> dict[str, float | int]:
    """Compare fragmentation, skeleton endpoints, junctions and wall width."""
    pred = _binary(prediction)
    truth = _binary(target)
    pred_skeleton, pred_endpoints, pred_junctions = _skeleton_features(pred)
    target_skeleton, target_endpoints, target_junctions = _skeleton_features(truth)

    pred_components = _significant_components(pred, min_component_area)
    target_components = _significant_components(truth, min_component_area)
    connectivity_score = _relative_count_score(pred_components, target_components)
    endpoint_score = _relative_count_score(pred_endpoints, target_endpoints)
    junction_score = _relative_count_score(pred_junctions, target_junctions)

    pred_distance = cv2.distanceTransform(pred.astype(np.uint8), cv2.DIST_L2, 5)
    target_distance = cv2.distanceTransform(truth.astype(np.uint8), cv2.DIST_L2, 5)
    pred_thickness = float(2.0 * np.median(pred_distance[pred_skeleton])) if np.any(pred_skeleton) else 0.0
    target_thickness = float(2.0 * np.median(target_distance[target_skeleton])) if np.any(target_skeleton) else 0.0

    return {
        "prediction_components": pred_components,
        "target_components": target_components,
        "component_error": abs(pred_components - target_components),
        "prediction_endpoints": pred_endpoints,
        "target_endpoints": target_endpoints,
        "endpoint_error": abs(pred_endpoints - target_endpoints),
        "prediction_junctions": pred_junctions,
        "target_junctions": target_junctions,
        "junction_error": abs(pred_junctions - target_junctions),
        "prediction_median_thickness_px": pred_thickness,
        "target_median_thickness_px": target_thickness,
        "thickness_error_px": abs(pred_thickness - target_thickness),
        "connectivity_score": connectivity_score,
        "endpoint_score": endpoint_score,
        "junction_score": junction_score,
        "topology_score": float(np.mean([connectivity_score, endpoint_score, junction_score])),
    }


def structural_wall_metrics(
    prediction: np.ndarray,
    target: np.ndarray,
    tolerance_px: float = 3.0,
    min_component_area: int = 32,
) -> dict[str, float | int]:
    """Return boundary and topology diagnostics for one wall-mask pair."""
    return {
        **boundary_scores(prediction, target, tolerance_px=tolerance_px),
        **topology_scores(prediction, target, min_component_area=min_component_area),
    }


def aggregate_structural_metrics(items: list[dict[str, float | int]]) -> dict[str, float]:
    if not items:
        return {}
    keys = (
        "boundary_precision",
        "boundary_recall",
        "boundary_f1",
        "component_error",
        "endpoint_error",
        "junction_error",
        "thickness_error_px",
        "connectivity_score",
        "endpoint_score",
        "junction_score",
        "topology_score",
    )
    return {key: float(np.mean([float(item[key]) for item in items])) for key in keys}
