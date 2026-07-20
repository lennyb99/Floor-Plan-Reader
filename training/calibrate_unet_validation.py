"""Calibrate U-Net hysteresis thresholds on the saved validation split only.

Probability maps are inferred once, then reused for every threshold pair. The
immutable ``real_test`` holdout is never read by this command.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

import numpy as np
import torch
from torch.utils.data import DataLoader


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from product.segmentation.inference import _hysteresis_mask, load_segmentation_model
from training.structural_metrics import aggregate_structural_metrics, structural_wall_metrics
from training.train_drive_models import REAL_DATASET_NAMES, build_unet_dataset, torch_device


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--drive-root", type=Path, default=Path("/content/drive/MyDrive"))
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--weights", type=Path, required=True)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--batch-size", type=int, default=4)
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument(
        "--thresholds",
        type=float,
        nargs="+",
        default=(0.50, 0.54, 0.56, 0.58, 0.62),
    )
    parser.add_argument(
        "--low-offsets",
        type=float,
        nargs="+",
        default=(0.04, 0.06, 0.08),
        help="Each low threshold is high threshold minus this offset.",
    )
    return parser.parse_args()


@torch.no_grad()
def infer_validation_probabilities(
    model: torch.nn.Module,
    loader: DataLoader,
    device: torch.device,
) -> tuple[list[np.ndarray], list[np.ndarray]]:
    probabilities: list[np.ndarray] = []
    targets: list[np.ndarray] = []
    model.eval()
    for images, masks in loader:
        batch = torch.sigmoid(model(images.to(device))).cpu().numpy()[:, 0]
        probabilities.extend(batch)
        targets.extend(masks.numpy()[:, 0] >= 0.5)
    return probabilities, targets


def score_threshold_pair(
    probabilities: list[np.ndarray],
    targets: list[np.ndarray],
    threshold: float,
    low_threshold: float,
) -> dict[str, float]:
    intersection = 0.0
    prediction_sum = 0.0
    target_sum = 0.0
    union = 0.0
    structural_items = []
    for probability, target in zip(probabilities, targets):
        prediction = _hysteresis_mask(probability, threshold, low_threshold).astype(bool)
        intersection += float((prediction & target).sum())
        prediction_sum += float(prediction.sum())
        target_sum += float(target.sum())
        union += float((prediction | target).sum())
        structural_items.append(structural_wall_metrics(prediction, target))

    structural = aggregate_structural_metrics(structural_items)
    metrics = {
        "dice": (2.0 * intersection) / max(prediction_sum + target_sum, 1.0),
        "iou": intersection / max(union, 1.0),
        "boundary_f1": structural["boundary_f1"],
        "topology_score": structural["topology_score"],
    }
    metrics["selection_score"] = (
        0.65 * metrics["iou"]
        + 0.20 * metrics["boundary_f1"]
        + 0.15 * metrics["topology_score"]
    )
    return metrics


def main() -> None:
    args = parse_args()
    if not args.manifest.is_file():
        raise FileNotFoundError(f"Split manifest not found: {args.manifest}")
    if not args.weights.is_file():
        raise FileNotFoundError(f"Weights not found: {args.weights}")

    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    roots = [args.drive_root / name for name in REAL_DATASET_NAMES]
    validation = build_unet_dataset(roots, manifest, "val")
    device = torch_device(args.device)
    loader = DataLoader(
        validation,
        batch_size=args.batch_size,
        shuffle=False,
        num_workers=args.workers,
        pin_memory=device.type == "cuda",
    )
    model = load_segmentation_model(str(args.weights), device=device)
    probabilities, targets = infer_validation_probabilities(model, loader, device)

    candidates = []
    for threshold in sorted(set(args.thresholds)):
        for offset in sorted(set(args.low_offsets)):
            low_threshold = threshold - offset
            if not 0.0 < low_threshold <= threshold < 1.0:
                continue
            candidates.append({
                "threshold": threshold,
                "low_threshold": low_threshold,
                **score_threshold_pair(probabilities, targets, threshold, low_threshold),
            })
    if not candidates:
        raise ValueError("No valid threshold pairs were provided")
    candidates.sort(key=lambda item: item["selection_score"], reverse=True)

    result = {
        "dataset": "real_training validation only",
        "manifest": str(args.manifest),
        "weights": str(args.weights),
        "validation_samples": len(validation),
        "selection_formula": "0.65*iou + 0.20*boundary_f1 + 0.15*topology_score",
        "best": candidates[0],
        "candidates": candidates,
    }
    output = args.output or args.manifest.with_name("unet_threshold_calibration.json")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result, indent=2))
    print(f"Threshold calibration saved to: {output}")


if __name__ == "__main__":
    main()
