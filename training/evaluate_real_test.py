"""Evaluate released U-Net/YOLO weights on the immutable ``real_test`` holdout.

This command never trains, augments, moves or overwrites dataset files. It is
intended for a mounted Google Drive, e.g. ``/content/drive/MyDrive/real_test``.
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
import torch
import yaml
from torch.utils.data import DataLoader
from ultralytics import YOLO


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from product.segmentation.inference import _hysteresis_mask, load_segmentation_model
from training.structural_metrics import aggregate_structural_metrics, structural_wall_metrics
from training.train_drive_models import IMAGE_EXTS, YOLO_CLASSES, torch_device
from training.unet.train_unet import LocalFloorplanDataset


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--test-root", type=Path, default=Path("/content/drive/MyDrive/real_test"))
    parser.add_argument("--model", choices=("audit", "unet", "yolo", "all"), default="all")
    parser.add_argument("--output", type=Path, default=PROJECT_ROOT / "training/runs/real_test")
    parser.add_argument("--device", default="auto")
    parser.add_argument("--batch-size", type=int, default=4)
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--unet-threshold", type=float, default=0.56)
    parser.add_argument("--unet-low-threshold", type=float, default=0.50)
    parser.add_argument(
        "--unet-weights",
        type=Path,
        default=PROJECT_ROOT / "product/backend/weights/unet_final_onlymax.pt",
    )
    parser.add_argument(
        "--yolo-weights",
        type=Path,
        nargs="+",
        default=[
            PROJECT_ROOT / "product/backend/weights/yolo_real1.pt",
            PROJECT_ROOT / "product/backend/weights/yolo_cc_Handdrawn1.pt",
        ],
    )
    return parser.parse_args()


def _visible_stems(folder: Path, extensions: tuple[str, ...]) -> set[str]:
    if not folder.is_dir():
        raise FileNotFoundError(f"Missing holdout directory: {folder}")
    return {
        path.stem for path in folder.iterdir()
        if not path.name.startswith(".") and path.suffix.lower() in extensions
    }


def group_key(filename: str) -> str:
    return re.sub(r"_(?:TL|TR|BL|BR)$", "", Path(filename).stem, flags=re.IGNORECASE)


def audit_holdout(root: Path) -> dict:
    images = _visible_stems(root / "images", IMAGE_EXTS)
    masks = _visible_stems(root / "masks_walls", IMAGE_EXTS)
    labels = _visible_stems(root / "labels", (".txt",))
    errors = {
        "missing_masks": sorted(images - masks),
        "missing_labels": sorted(images - labels),
        "orphan_masks": sorted(masks - images),
        "orphan_labels": sorted(labels - images),
    }
    if any(errors.values()):
        raise RuntimeError("real_test pairing failed:\n" + json.dumps(errors, indent=2))
    groups = sorted({group_key(name) for name in images})
    return {
        "dataset": root.name,
        "images": len(images),
        "wall_masks": len(masks),
        "yolo_labels": len(labels),
        "source_plan_groups": len(groups),
        "groups": groups,
        "training_allowed": False,
    }


@torch.no_grad()
def evaluate_unet_holdout(args: argparse.Namespace) -> dict:
    device = torch_device(args.device)
    dataset = LocalFloorplanDataset(
        str(args.test_root / "images"),
        str(args.test_root / "masks_walls"),
        filenames=sorted(path.name for path in (args.test_root / "images").iterdir() if path.suffix.lower() in IMAGE_EXTS),
    )
    loader = DataLoader(dataset, batch_size=args.batch_size, shuffle=False, num_workers=args.workers)
    model = load_segmentation_model(str(args.unet_weights), device=device)

    per_image = []
    totals = {"intersection": 0.0, "prediction": 0.0, "target": 0.0, "union": 0.0}
    offset = 0
    model.eval()
    for images, targets in loader:
        probabilities = torch.sigmoid(model(images.to(device))).cpu().numpy()[:, 0]
        target_arrays = targets.numpy()[:, 0] >= 0.5
        for probability, target in zip(probabilities, target_arrays):
            prediction = _hysteresis_mask(
                probability,
                threshold=args.unet_threshold,
                low_threshold=args.unet_low_threshold,
            ).astype(bool)
            intersection = float((prediction & target).sum())
            prediction_sum = float(prediction.sum())
            target_sum = float(target.sum())
            union = float((prediction | target).sum())
            filename = dataset.filenames[offset]
            offset += 1
            structural = structural_wall_metrics(prediction, target)
            per_image.append({
                "file": filename,
                "group": group_key(filename),
                "dice": (2 * intersection) / max(prediction_sum + target_sum, 1.0),
                "iou": intersection / max(union, 1.0),
                "structural": structural,
            })
            totals["intersection"] += intersection
            totals["prediction"] += prediction_sum
            totals["target"] += target_sum
            totals["union"] += union

    grouped: dict[str, list[dict]] = defaultdict(list)
    for item in per_image:
        grouped[item["group"]].append(item)
    group_metrics = {
        name: {
            "dice": float(np.mean([item["dice"] for item in items])),
            "iou": float(np.mean([item["iou"] for item in items])),
            "structural": aggregate_structural_metrics([item["structural"] for item in items]),
        }
        for name, items in sorted(grouped.items())
    }
    return {
        "weights": str(args.unet_weights),
        "threshold": args.unet_threshold,
        "low_threshold": args.unet_low_threshold,
        "dice": (2 * totals["intersection"]) / max(totals["prediction"] + totals["target"], 1.0),
        "iou": totals["intersection"] / max(totals["union"], 1.0),
        "structural": aggregate_structural_metrics([item["structural"] for item in per_image]),
        "worst_image_iou": min(per_image, key=lambda item: item["iou"]),
        "groups": group_metrics,
        "images": per_image,
    }


def write_yolo_test_config(args: argparse.Namespace) -> Path:
    # Ultralytics writes a label cache next to the evaluated dataset. Stage a
    # tiny read-only copy so ``real_test`` itself remains completely untouched.
    stage = args.output / "yolo_test_staging"
    image_stage = stage / "images"
    label_stage = stage / "labels"
    image_stage.mkdir(parents=True, exist_ok=True)
    label_stage.mkdir(parents=True, exist_ok=True)
    for source in (args.test_root / "images").iterdir():
        if source.name.startswith(".") or source.suffix.lower() not in IMAGE_EXTS:
            continue
        shutil.copy2(source, image_stage / source.name)
        label = args.test_root / "labels" / f"{source.stem}.txt"
        shutil.copy2(label, label_stage / label.name)

    config = {
        "path": str(stage),
        "train": "images",
        "val": "images",
        "test": "images",
        "nc": len(YOLO_CLASSES),
        "names": list(YOLO_CLASSES),
    }
    path = args.output / "real_test_yolo.yaml"
    path.write_text(yaml.safe_dump(config, sort_keys=False, allow_unicode=True), encoding="utf-8")
    return path


def evaluate_yolo_holdout(args: argparse.Namespace) -> list[dict]:
    config = write_yolo_test_config(args)
    reports = []
    for weights in args.yolo_weights:
        model = YOLO(str(weights))
        metrics = model.val(
            data=str(config),
            split="test",
            imgsz=512,
            batch=args.batch_size,
            workers=args.workers,
            device=None if args.device == "auto" else args.device,
            project=str(args.output),
            name=f"yolo_{weights.stem}",
            exist_ok=True,
            plots=True,
            verbose=False,
        )
        reports.append({
            "weights": str(weights),
            "map50": float(metrics.box.map50),
            "map50_95": float(metrics.box.map),
            "precision": float(metrics.box.mp),
            "recall": float(metrics.box.mr),
        })
    return reports


def main() -> None:
    args = parse_args()
    if not 0.0 < args.unet_low_threshold <= args.unet_threshold < 1.0:
        raise ValueError("Require 0 < --unet-low-threshold <= --unet-threshold < 1")
    args.output.mkdir(parents=True, exist_ok=True)
    report: dict = {"holdout": audit_holdout(args.test_root)}
    if args.model in {"unet", "all"}:
        report["unet"] = evaluate_unet_holdout(args)
    if args.model in {"yolo", "all"}:
        report["yolo"] = evaluate_yolo_holdout(args)
    output = args.output / "benchmark.json"
    output.write_text(json.dumps(report, indent=2), encoding="utf-8")
    print(json.dumps(report, indent=2))
    print(f"Benchmark saved to: {output}")


if __name__ == "__main__":
    main()
