"""Compare U-Net checkpoints on an existing leakage-free validation split.

This command is evaluation-only and reads ``split_manifest.json`` from a
training run.  It never reads ``real_test`` and never updates model weights.
"""

from __future__ import annotations

import argparse
import json
import sys
from pathlib import Path

from torch.utils.data import DataLoader


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from product.segmentation.inference import load_segmentation_model
from training.train_drive_models import (
    REAL_DATASET_NAMES,
    build_unet_dataset,
    evaluate_unet,
    torch_device,
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--drive-root", type=Path, default=Path("/content/drive/MyDrive"))
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--weights", type=Path, nargs="+", required=True)
    parser.add_argument("--output", type=Path)
    parser.add_argument("--device", default="auto")
    parser.add_argument("--batch-size", type=int, default=4)
    parser.add_argument("--workers", type=int, default=2)
    parser.add_argument("--threshold", type=float, default=0.50)
    parser.add_argument("--low-threshold", type=float, default=0.42)
    return parser.parse_args()


def main() -> None:
    args = parse_args()
    if not 0.0 < args.low_threshold <= args.threshold < 1.0:
        raise ValueError("Require 0 < --low-threshold <= --threshold < 1")
    if not args.manifest.is_file():
        raise FileNotFoundError(f"Split manifest not found: {args.manifest}")

    manifest = json.loads(args.manifest.read_text(encoding="utf-8"))
    roots = [args.drive_root / name for name in REAL_DATASET_NAMES]
    validation = build_unet_dataset(roots, manifest, "val")
    loader = DataLoader(
        validation,
        batch_size=args.batch_size,
        shuffle=False,
        num_workers=args.workers,
        pin_memory=torch_device(args.device).type == "cuda",
    )
    device = torch_device(args.device)

    reports = []
    for weights in args.weights:
        model = load_segmentation_model(str(weights), device=device)
        reports.append({
            "weights": str(weights),
            **evaluate_unet(
                model,
                loader,
                device,
                threshold=args.threshold,
                low_threshold=args.low_threshold,
            ),
        })

    result = {
        "dataset": "real_training validation only",
        "manifest": str(args.manifest),
        "validation_samples": len(validation),
        "threshold": args.threshold,
        "low_threshold": args.low_threshold,
        "models": reports,
    }
    output = args.output or args.manifest.with_name("unet_validation_comparison.json")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text(json.dumps(result, indent=2), encoding="utf-8")
    print(json.dumps(result, indent=2))
    print(f"Validation comparison saved to: {output}")


if __name__ == "__main__":
    main()
