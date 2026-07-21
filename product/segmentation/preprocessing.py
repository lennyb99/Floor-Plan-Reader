"""Shared preprocessing for the floor-plan inference pipeline.

Both YOLO and U-Net must see the exact same pixels.  The public coordinate
system of the application is therefore the 512 x 512 preprocessed image.
"""

from __future__ import annotations

from dataclasses import asdict, dataclass
from typing import Any

import cv2
import numpy as np


TARGET_SIZE = 512
DEFAULT_GAMMA = 1.25


@dataclass(frozen=True)
class PreprocessMetadata:
    original_width: int
    original_height: int
    crop_left: float
    crop_top: float
    crop_size: float
    output_width: int
    output_height: int
    gamma: float
    auto_crop: bool
    cleanup_applied: bool

    def to_dict(self) -> dict[str, Any]:
        return asdict(self)


@dataclass(frozen=True)
class PreprocessResult:
    image_rgb: np.ndarray
    metadata: PreprocessMetadata


def _as_rgb(image: np.ndarray) -> np.ndarray:
    if image is None or image.size == 0:
        raise ValueError("The uploaded image is empty.")
    if image.ndim == 2:
        return cv2.cvtColor(image, cv2.COLOR_GRAY2RGB)
    if image.ndim != 3:
        raise ValueError(f"Unsupported image shape: {image.shape}")
    if image.shape[2] == 4:
        return cv2.cvtColor(image, cv2.COLOR_RGBA2RGB)
    if image.shape[2] != 3:
        raise ValueError(f"Unsupported channel count: {image.shape[2]}")
    return image.astype(np.uint8, copy=False)


def _colored_ink_mask(image_rgb: np.ndarray) -> np.ndarray:
    """Detect coloured pen strokes independently of paper brightness."""
    channels = image_rgb.astype(np.int16)
    chroma = channels.max(axis=2) - channels.min(axis=2)
    gray = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2GRAY)
    return ((chroma >= 14) & (gray <= 235)).astype(np.uint8)


def _local_ink_mask(gray: np.ndarray) -> np.ndarray:
    """Detect graphite/black strokes on photographed or textured paper."""
    smoothed = cv2.GaussianBlur(gray, (3, 3), 0)
    sigma = max(gray.shape) / 28.0
    background = cv2.GaussianBlur(smoothed, (0, 0), sigma)
    contrast = np.clip(
        background.astype(np.int16) - smoothed.astype(np.int16), 0, 255
    ).astype(np.uint8)
    otsu, _ = cv2.threshold(contrast, 0, 255, cv2.THRESH_BINARY + cv2.THRESH_OTSU)
    threshold = max(8.0, float(otsu) * 0.72)
    return (contrast >= threshold).astype(np.uint8)


def _content_square(
    image_rgb: np.ndarray,
    gray: np.ndarray,
    padding_ratio: float = 0.055,
) -> tuple[float, float, float]:
    """Return a padded square around meaningful (non-paper) content.

    The square may extend beyond the input image.  ``warpAffine`` fills that
    area with white, preserving the entire plan instead of clipping its long
    side.
    """
    height, width = gray.shape
    coloured_ink = _colored_ink_mask(image_rgb)
    coloured_ratio = float(np.mean(coloured_ink))
    if coloured_ratio >= 0.0005:
        # This excludes grey paper boundaries and shadows around blue/red ink.
        ink = coloured_ink
    elif float(np.median(gray)) < 242:
        ink = _local_ink_mask(gray)
    else:
        ink = (gray < 235).astype(np.uint8)

    # Ignore isolated scan/camera noise while retaining thin wall strokes.
    count, labels, stats, _ = cv2.connectedComponentsWithStats(ink, connectivity=8)
    min_area = max(8, int(width * height * 0.00001))
    kept = np.zeros_like(ink)
    for label in range(1, count):
        if stats[label, cv2.CC_STAT_AREA] >= min_area:
            kept[labels == label] = 1

    ys, xs = np.nonzero(kept)
    if xs.size == 0:
        size = float(max(width, height))
        return (width - size) / 2.0, (height - size) / 2.0, size

    x0, x1 = float(xs.min()), float(xs.max() + 1)
    y0, y1 = float(ys.min()), float(ys.max() + 1)
    content_width = max(1.0, x1 - x0)
    content_height = max(1.0, y1 - y0)
    size = max(content_width, content_height) * (1.0 + 2.0 * padding_ratio)
    center_x = (x0 + x1) / 2.0
    center_y = (y0 + y1) / 2.0
    return center_x - size / 2.0, center_y - size / 2.0, size


def _needs_document_cleanup(image_rgb: np.ndarray) -> bool:
    gray = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2GRAY)
    coloured_ratio = float(np.mean(_colored_ink_mask(image_rgb)))
    return coloured_ratio >= 0.0005 or float(np.median(gray)) < 242


def clean_document_background(image_rgb: np.ndarray) -> np.ndarray:
    """Remove paper texture, shadows and colour casts while retaining strokes."""
    gray = cv2.cvtColor(image_rgb, cv2.COLOR_RGB2GRAY)
    smoothed = cv2.GaussianBlur(gray, (3, 3), 0)
    sigma = max(gray.shape) / 28.0
    background = cv2.GaussianBlur(smoothed, (0, 0), sigma)
    normalized = cv2.divide(smoothed, np.maximum(background, 1), scale=255)

    channels = image_rgb.astype(np.int16)
    chroma = channels.max(axis=2) - channels.min(axis=2)
    ink_strength = np.maximum(255 - normalized.astype(np.int16), (chroma * 1.6).astype(np.int16))
    ink_strength = np.clip(ink_strength, 0, 255).astype(np.float32)

    noise_floor = max(3.0, float(np.percentile(ink_strength, 78)))
    strong_ink = max(noise_floor + 24.0, float(np.percentile(ink_strength, 99.4)))
    enhanced = np.clip(
        (ink_strength - noise_floor) * (255.0 / (strong_ink - noise_floor)),
        0,
        255,
    ).astype(np.uint8)
    cleaned = 255 - enhanced
    return cv2.cvtColor(cleaned, cv2.COLOR_GRAY2RGB)


def apply_gamma(image_rgb: np.ndarray, gamma: float) -> np.ndarray:
    """Apply deterministic gamma correction using a lookup table."""
    gamma = float(np.clip(gamma, 0.5, 2.5))
    values = np.arange(256, dtype=np.float32) / 255.0
    lookup = np.clip(np.power(values, gamma) * 255.0, 0, 255).astype(np.uint8)
    return cv2.LUT(image_rgb, lookup)


def apply_spatial_transform(
    image: np.ndarray,
    metadata: PreprocessMetadata,
    *,
    interpolation: int,
    border_value: int | tuple[int, ...],
) -> np.ndarray:
    """Apply a previously calculated crop to an aligned image or mask."""
    scale = metadata.output_width / metadata.crop_size
    matrix = np.array(
        [[scale, 0.0, -metadata.crop_left * scale], [0.0, scale, -metadata.crop_top * scale]],
        dtype=np.float32,
    )
    return cv2.warpAffine(
        image,
        matrix,
        (metadata.output_width, metadata.output_height),
        flags=interpolation,
        borderMode=cv2.BORDER_CONSTANT,
        borderValue=border_value,
    )


def preprocess_floorplan(
    image: np.ndarray,
    *,
    gamma: float = DEFAULT_GAMMA,
    auto_crop: bool = True,
    target_size: int = TARGET_SIZE,
    cleanup_mode: str = "auto",
) -> PreprocessResult:
    """Gamma-correct and smart-crop a floor plan to exactly 512 x 512 px."""
    if target_size <= 0:
        raise ValueError("target_size must be positive")

    rgb = _as_rgb(image)
    height, width = rgb.shape[:2]
    gray = cv2.cvtColor(rgb, cv2.COLOR_RGB2GRAY)

    if auto_crop:
        crop_left, crop_top, crop_size = _content_square(rgb, gray)
    else:
        crop_size = float(max(width, height))
        crop_left = (width - crop_size) / 2.0
        crop_top = (height - crop_size) / 2.0

    if cleanup_mode not in {"auto", "on", "off"}:
        raise ValueError("cleanup_mode must be 'auto', 'on' or 'off'")
    cleanup_applied = cleanup_mode == "on" or (
        cleanup_mode == "auto" and _needs_document_cleanup(rgb)
    )
    spatial_source = clean_document_background(rgb) if cleanup_applied else rgb

    metadata = PreprocessMetadata(
        original_width=width,
        original_height=height,
        crop_left=round(crop_left, 3),
        crop_top=round(crop_top, 3),
        crop_size=round(crop_size, 3),
        output_width=target_size,
        output_height=target_size,
        gamma=round(float(np.clip(gamma, 0.5, 2.5)), 3),
        auto_crop=auto_crop,
        cleanup_applied=cleanup_applied,
    )
    scale = target_size / crop_size
    interpolation = cv2.INTER_AREA if scale < 1.0 else cv2.INTER_CUBIC
    cropped = apply_spatial_transform(
        spatial_source,
        metadata,
        interpolation=interpolation,
        border_value=(255, 255, 255),
    )
    corrected = apply_gamma(cropped, gamma)
    return PreprocessResult(image_rgb=corrected, metadata=metadata)
