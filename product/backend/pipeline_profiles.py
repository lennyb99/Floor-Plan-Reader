"""Input-domain routing and calibrated pipeline profiles.

The two domains deliberately share one public 512 px coordinate space and one
floorplan JSON schema.  Only preparation, model recommendations and geometry
repair strength differ.
"""

from __future__ import annotations

import cv2
import numpy as np


PIPELINE_PROFILES = {
    "hand_sketch": {
        "label": "Hand sketch",
        "description": "Tolerant cleanup and topology repair for photographed or hand-drawn plans.",
        "default_gamma": 1.25,
        "cleanup_mode": "on",
        "recommended_yolo": "yolo_real_Aug_3.pt",
        "recommended_unet": "unet_real_finetuned_v1.pt",
        "geometry_profile": "hand_sketch",
        "use_yolo_ensemble": True,
    },
    "professional_plan": {
        "label": "Professional plan",
        "description": "Conservative vectorization that preserves clean CAD and architectural geometry.",
        "default_gamma": 1.0,
        "cleanup_mode": "off",
        "recommended_yolo": "yolo_cc_Sketch_1.pt",
        "recommended_unet": "finalunet.pt",
        "geometry_profile": "professional_plan",
        "use_yolo_ensemble": False,
    },
}

PIPELINE_MODES = {"auto", *PIPELINE_PROFILES}


def public_pipeline_profiles() -> list[dict]:
    return [
        {
            "id": profile_id,
            "label": profile["label"],
            "description": profile["description"],
            "default_gamma": profile["default_gamma"],
            "recommended_yolo": profile["recommended_yolo"],
            "recommended_unet": profile["recommended_unet"],
        }
        for profile_id, profile in PIPELINE_PROFILES.items()
    ]


def _as_rgb(image: np.ndarray) -> np.ndarray:
    if image.ndim == 2:
        return cv2.cvtColor(image, cv2.COLOR_GRAY2RGB)
    if image.ndim == 3 and image.shape[2] == 4:
        return cv2.cvtColor(image, cv2.COLOR_RGBA2RGB)
    if image.ndim == 3 and image.shape[2] == 3:
        return image.astype(np.uint8, copy=False)
    raise ValueError(f"Unsupported image shape for pipeline routing: {image.shape}")


def classify_floorplan_style(image: np.ndarray) -> dict:
    """Distinguish clean exported plans from photographed/hand-drawn input.

    This is intentionally a transparent heuristic, not another opaque model.
    The UI exposes its decision and always lets the user override it.
    """
    rgb = _as_rgb(image)
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)
    height, width = gray.shape

    channels = rgb.astype(np.int16)
    chroma = channels.max(axis=2) - channels.min(axis=2)
    colored_ink_ratio = float(np.mean((chroma >= 14) & (gray <= 235)))
    paper_brightness = float(np.median(gray))

    sigma = max(gray.shape) / 30.0
    background = cv2.GaussianBlur(gray, (0, 0), sigma)
    residual = np.abs(gray.astype(np.float32) - background.astype(np.float32))
    bright_cutoff = float(np.percentile(gray, 70))
    paper_region = residual[gray >= bright_cutoff]
    texture = float(np.median(paper_region)) if paper_region.size else float(np.median(residual))

    _, ink = cv2.threshold(gray, 0, 255, cv2.THRESH_BINARY_INV + cv2.THRESH_OTSU)
    lines = cv2.HoughLinesP(
        ink,
        1,
        np.pi / 180,
        threshold=max(18, int(min(height, width) * 0.035)),
        minLineLength=max(24, int(min(height, width) * 0.09)),
        maxLineGap=max(4, int(min(height, width) * 0.015)),
    )
    line_count = 0
    orthogonal_ratio = 0.0
    if lines is not None:
        line_count = len(lines)
        orthogonal = 0
        for x1, y1, x2, y2 in lines[:, 0]:
            angle = abs(np.degrees(np.arctan2(y2 - y1, x2 - x1))) % 90.0
            distance_to_axis = min(angle, 90.0 - angle)
            orthogonal += distance_to_axis <= 2.5
        orthogonal_ratio = orthogonal / max(1, line_count)

    professional_score = 0.0
    professional_score += 0.28 if colored_ink_ratio < 0.003 else 0.0
    professional_score += 0.22 if paper_brightness >= 244 else (0.10 if paper_brightness >= 238 else 0.0)
    professional_score += 0.20 if texture <= 1.5 else (0.08 if texture <= 3.0 else 0.0)
    professional_score += 0.22 * orthogonal_ratio
    professional_score += 0.08 if line_count >= 4 else 0.0
    professional_score = float(np.clip(professional_score, 0.0, 1.0))

    resolved = "professional_plan" if professional_score >= 0.64 else "hand_sketch"
    confidence = 0.5 + min(0.49, abs(professional_score - 0.64) * 1.35)
    return {
        "resolved_mode": resolved,
        "confidence": round(float(confidence), 3),
        "signals": {
            "professional_score": round(professional_score, 3),
            "colored_ink_ratio": round(colored_ink_ratio, 5),
            "paper_brightness": round(paper_brightness, 2),
            "paper_texture": round(texture, 2),
            "orthogonal_line_ratio": round(float(orthogonal_ratio), 3),
            "long_line_count": int(line_count),
        },
    }


def resolve_pipeline_mode(requested_mode: str, image: np.ndarray) -> dict:
    if requested_mode not in PIPELINE_MODES:
        raise ValueError(
            f"Unknown pipeline mode '{requested_mode}'. Expected auto, hand_sketch or professional_plan."
        )
    if requested_mode == "auto":
        decision = classify_floorplan_style(image)
    else:
        decision = {"resolved_mode": requested_mode, "confidence": 1.0, "signals": {}}
    resolved = decision["resolved_mode"]
    return {
        "requested_mode": requested_mode,
        **decision,
        "profile": PIPELINE_PROFILES[resolved],
    }
