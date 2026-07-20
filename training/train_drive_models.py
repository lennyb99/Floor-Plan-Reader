"""Fine-tune U-Net and YOLO on the real Floor Plan Reader Drive datasets.

The script is intended for a machine where Google Drive is mounted (for
example Colab's ``/content/drive/MyDrive``). Augmented variants are split by
their original sketch group, preventing train/validation leakage.
"""

from __future__ import annotations

import argparse
import json
import random
import re
import shutil
import sys
from pathlib import Path

import segmentation_models_pytorch as smp
import torch
import yaml
from torch.utils.data import ConcatDataset, DataLoader
from tqdm.auto import tqdm
from ultralytics import YOLO


PROJECT_ROOT = Path(__file__).resolve().parents[1]
if str(PROJECT_ROOT) not in sys.path:
    sys.path.insert(0, str(PROJECT_ROOT))

from product.segmentation.model import create_unet_model
from product.segmentation.preprocessing import TARGET_SIZE
from training.unet.train_unet import LocalFloorplanDataset


REAL_DATASET_NAMES = ("real_training", "real_training_aug")
HOLDOUT_DATASET_NAMES = ("real_test",)
SYNTHETIC_DATASET_NAMES = ("cubicasa_dataset", "cubicasa_handdrawn", "cubicasa_sketch")
IMAGE_EXTS = (".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff")
YOLO_CLASSES = (
    "Tuer",
    "Doppeltuer",
    "Fenster",
    "Treppe",
    "Waschbecken",
    "Herd",
    "Toilette",
    "Dusche",
    "Bett",
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--drive-root", type=Path, default=Path("/content/drive/MyDrive"))
    parser.add_argument("--model", choices=("audit", "unet", "yolo", "all"), default="audit")
    parser.add_argument("--output", type=Path, default=PROJECT_ROOT / "training" / "runs" / "drive_finetune")
    parser.add_argument("--device", default="auto", help="auto, cpu, mps, cuda or a YOLO device such as 0")
    parser.add_argument("--unet-base", type=Path, default=PROJECT_ROOT / "product/backend/weights/unet_final_onlymax.pt")
    parser.add_argument("--yolo-base", type=Path, default=PROJECT_ROOT / "product/backend/weights/yolo_real1.pt")
    parser.add_argument("--unet-epochs", type=int, default=12)
    parser.add_argument("--yolo-epochs", type=int, default=50)
    parser.add_argument("--batch-size", type=int, default=8)
    parser.add_argument("--workers", type=int, default=4)
    parser.add_argument("--val-fraction", type=float, default=0.2)
    parser.add_argument("--seed", type=int, default=42)
    parser.add_argument(
        "--include-synthetic",
        action="store_true",
        help="Also add the older CubiCasa domains. Real data remains the default.",
    )
    return parser.parse_args()


def dataset_roots(args: argparse.Namespace) -> list[Path]:
    names = list(REAL_DATASET_NAMES)
    if args.include_synthetic:
        names.extend(SYNTHETIC_DATASET_NAMES)
    return [args.drive_root / name for name in names]


def _files(folder: Path, suffixes: tuple[str, ...]) -> set[str]:
    return {path.name for path in folder.iterdir() if path.suffix.lower() in suffixes}


def _split_dirs(root: Path, split: str | None = None) -> tuple[Path, Path, Path]:
    suffix = (split,) if split else ()
    return (
        root.joinpath("images", *suffix),
        root.joinpath("masks_walls", *suffix),
        root.joinpath("labels", *suffix),
    )


def _layout_splits(root: Path) -> tuple[str | None, ...]:
    return ("train", "val") if (root / "images" / "train").is_dir() else (None,)


def audit_datasets(roots: list[Path]) -> dict:
    report: dict[str, dict] = {}
    errors: list[str] = []
    for root in roots:
        domain: dict[str, dict] = {}
        for split in _layout_splits(root):
            image_dir, mask_dir, label_dir = _split_dirs(root, split)
            for folder in (image_dir, mask_dir, label_dir):
                if not folder.is_dir():
                    errors.append(f"Missing directory: {folder}")
            if any(not folder.is_dir() for folder in (image_dir, mask_dir, label_dir)):
                continue

            images = _files(image_dir, IMAGE_EXTS)
            masks = _files(mask_dir, IMAGE_EXTS)
            labels = _files(label_dir, (".txt",))
            image_stems = {Path(name).stem for name in images}
            mask_stems = {Path(name).stem for name in masks}
            label_stems = {Path(name).stem for name in labels}
            missing_masks = sorted(image_stems - mask_stems)
            missing_labels = sorted(image_stems - label_stems)
            if missing_masks:
                errors.append(f"{root.name}/{split or 'flat'}: {len(missing_masks)} images without wall mask")
            if missing_labels:
                errors.append(f"{root.name}/{split or 'flat'}: {len(missing_labels)} images without YOLO label")
            domain[split or "flat"] = {
                "images": len(images),
                "masks": len(masks),
                "labels": len(labels),
                "paired_unet": len(image_stems & mask_stems),
                "paired_yolo": len(image_stems & label_stems),
            }
        report[root.name] = domain

    if errors:
        raise RuntimeError("Dataset audit failed:\n- " + "\n- ".join(errors))
    return report


def torch_device(requested: str) -> torch.device:
    if requested != "auto":
        if requested.isdigit():
            return torch.device(f"cuda:{requested}")
        return torch.device(requested)
    if torch.cuda.is_available():
        return torch.device("cuda")
    if torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


def _group_key(filename: str) -> str:
    """Map generated variants back to the source sketch for leakage-free splits."""
    stem = Path(filename).stem.lower()
    pattern = r"(?:[_-](?:aug(?:mented)?|variant|copy|rot(?:ated)?|flip|gamma|noise|perspective)[_-]?\d*)+$"
    return re.sub(pattern, "", stem)


def _paired_files(root: Path, split: str | None = None) -> list[str]:
    image_dir, mask_dir, _ = _split_dirs(root, split)
    images = _files(image_dir, IMAGE_EXTS)
    masks = _files(mask_dir, IMAGE_EXTS)
    return sorted(images & masks)


def build_group_split(roots: list[Path], val_fraction: float, seed: int) -> dict[str, dict[str, list[str]]]:
    """Return per-domain filenames while keeping every augmentation group intact."""
    if not 0.05 <= val_fraction <= 0.5:
        raise ValueError("--val-fraction must be between 0.05 and 0.5")

    flat_roots = [root for root in roots if _layout_splits(root) == (None,)]
    grouped: dict[str, list[tuple[Path, str]]] = {}
    for root in flat_roots:
        for filename in _paired_files(root):
            grouped.setdefault(_group_key(filename), []).append((root, filename))

    keys = sorted(grouped)
    random.Random(seed).shuffle(keys)
    n_val = max(1, round(len(keys) * val_fraction)) if keys else 0
    val_keys = set(keys[:n_val])
    result: dict[str, dict[str, list[str]]] = {
        root.name: {"train": [], "val": []} for root in roots
    }

    for key, records in grouped.items():
        split = "val" if key in val_keys else "train"
        for root, filename in records:
            result[root.name][split].append(filename)

    # Preserve pre-existing curated splits for legacy datasets.
    for root in roots:
        if _layout_splits(root) != (None,):
            result[root.name]["train"] = _paired_files(root, "train")
            result[root.name]["val"] = _paired_files(root, "val")
    return result


def build_unet_dataset(roots: list[Path], manifest: dict, split: str) -> ConcatDataset:
    datasets = []
    for root in roots:
        filenames = manifest[root.name][split]
        if not filenames:
            continue
        source_split = split if _layout_splits(root) != (None,) else None
        image_dir, mask_dir, _ = _split_dirs(root, source_split)
        datasets.append(LocalFloorplanDataset(
            str(image_dir), str(mask_dir), image_size=TARGET_SIZE, gamma=1.25,
            filenames=filenames,
        ))
    if not datasets:
        raise RuntimeError(f"No U-Net samples found for split '{split}'")
    return ConcatDataset(datasets)


@torch.no_grad()
def evaluate_unet(model: torch.nn.Module, loader: DataLoader, device: torch.device) -> dict[str, float]:
    model.eval()
    intersection = 0.0
    prediction_sum = 0.0
    target_sum = 0.0
    union = 0.0
    for images, masks in loader:
        predictions = torch.sigmoid(model(images.to(device))) >= 0.5
        targets = masks.to(device) >= 0.5
        intersection += float((predictions & targets).sum())
        prediction_sum += float(predictions.sum())
        target_sum += float(targets.sum())
        union += float((predictions | targets).sum())
    return {
        "dice": (2.0 * intersection) / max(prediction_sum + target_sum, 1.0),
        "iou": intersection / max(union, 1.0),
    }


def train_unet(args: argparse.Namespace, roots: list[Path], manifest: dict) -> Path:
    device = torch_device(args.device)
    train_data = build_unet_dataset(roots, manifest, "train")
    val_data = build_unet_dataset(roots, manifest, "val")
    train_loader = DataLoader(
        train_data,
        batch_size=args.batch_size,
        shuffle=True,
        num_workers=args.workers,
        pin_memory=device.type == "cuda",
    )
    val_loader = DataLoader(
        val_data,
        batch_size=args.batch_size,
        shuffle=False,
        num_workers=args.workers,
        pin_memory=device.type == "cuda",
    )

    model = create_unet_model(encoder_weights=None)
    model.load_state_dict(torch.load(args.unet_base, map_location=device, weights_only=True))
    model.to(device)
    optimizer = torch.optim.AdamW(model.parameters(), lr=1e-4, weight_decay=1e-4)
    bce = smp.losses.SoftBCEWithLogitsLoss()
    dice = smp.losses.DiceLoss(mode="binary")
    history: list[dict] = []
    best_iou = -1.0
    output_path = args.output / "unet_floorplan_512.pt"

    for epoch in range(1, args.unet_epochs + 1):
        model.train()
        total_loss = 0.0
        progress = tqdm(train_loader, desc=f"U-Net {epoch}/{args.unet_epochs}")
        for images, masks in progress:
            images = images.to(device, non_blocking=True)
            masks = masks.to(device, non_blocking=True)
            logits = model(images)
            loss = bce(logits, masks) + dice(logits, masks)
            optimizer.zero_grad(set_to_none=True)
            loss.backward()
            optimizer.step()
            total_loss += float(loss)
            progress.set_postfix(loss=f"{float(loss):.4f}")

        metrics = evaluate_unet(model, val_loader, device)
        record = {
            "epoch": epoch,
            "loss": total_loss / max(len(train_loader), 1),
            **metrics,
        }
        history.append(record)
        print(json.dumps(record))
        if metrics["iou"] > best_iou:
            best_iou = metrics["iou"]
            torch.save(model.state_dict(), output_path)

    (args.output / "unet_history.json").write_text(json.dumps(history, indent=2), encoding="utf-8")
    return output_path


def _stage_yolo_split(args: argparse.Namespace, roots: list[Path], manifest: dict, split: str) -> Path:
    stage = args.output / "yolo_dataset"
    image_target = stage / "images" / split
    label_target = stage / "labels" / split
    # A changed seed/split must not leave stale links in both partitions.
    for target in (image_target, label_target):
        if target.exists():
            shutil.rmtree(target)
    image_target.mkdir(parents=True, exist_ok=True)
    label_target.mkdir(parents=True, exist_ok=True)
    for root in roots:
        source_split = split if _layout_splits(root) != (None,) else None
        image_dir, _, label_dir = _split_dirs(root, source_split)
        for filename in manifest[root.name][split]:
            label = label_dir / f"{Path(filename).stem}.txt"
            if not label.is_file():
                continue
            prefix = f"{root.name}__"
            for source, target in (
                (image_dir / filename, image_target / f"{prefix}{filename}"),
                (label, label_target / f"{prefix}{label.name}"),
            ):
                if target.exists():
                    continue
                try:
                    target.symlink_to(source.resolve())
                except OSError:
                    shutil.copy2(source, target)
    return image_target


def write_combined_yolo_config(args: argparse.Namespace, roots: list[Path], manifest: dict) -> Path:
    train_dir = _stage_yolo_split(args, roots, manifest, "train")
    val_dir = _stage_yolo_split(args, roots, manifest, "val")
    config = {
        "path": str(args.output / "yolo_dataset"),
        "train": str(train_dir.relative_to(args.output / "yolo_dataset")),
        "val": str(val_dir.relative_to(args.output / "yolo_dataset")),
        "nc": len(YOLO_CLASSES),
        "names": list(YOLO_CLASSES),
    }
    path = args.output / "combined_yolo.yaml"
    path.write_text(yaml.safe_dump(config, sort_keys=False, allow_unicode=True), encoding="utf-8")
    return path


def train_yolo(args: argparse.Namespace, roots: list[Path], manifest: dict) -> Path:
    config_path = write_combined_yolo_config(args, roots, manifest)
    model = YOLO(str(args.yolo_base))
    result = model.train(
        data=str(config_path),
        epochs=args.yolo_epochs,
        imgsz=TARGET_SIZE,
        batch=args.batch_size,
        workers=args.workers,
        device=None if args.device == "auto" else args.device,
        project=str(args.output),
        name="yolo_combined",
        exist_ok=True,
        patience=10,
        seed=args.seed,
        deterministic=True,
        degrees=2.0,
        perspective=0.0005,
        translate=0.08,
        scale=0.20,
    )
    best = Path(result.save_dir) / "weights" / "best.pt"
    output_path = args.output / "yolo_floorplan_512.pt"
    shutil.copy2(best, output_path)
    return output_path


def main() -> None:
    args = parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    roots = dataset_roots(args)
    report = audit_datasets(roots)
    report["excluded_holdouts"] = [
        name for name in HOLDOUT_DATASET_NAMES if (args.drive_root / name).exists()
    ]
    manifest = build_group_split(roots, args.val_fraction, args.seed)
    report["split"] = {
        name: {split: len(files) for split, files in splits.items()}
        for name, splits in manifest.items()
    }
    print(json.dumps(report, indent=2))
    (args.output / "dataset_audit.json").write_text(json.dumps(report, indent=2), encoding="utf-8")
    (args.output / "split_manifest.json").write_text(json.dumps(manifest, indent=2), encoding="utf-8")

    if args.model in {"unet", "all"}:
        print(f"Best U-Net checkpoint: {train_unet(args, roots, manifest)}")
    if args.model in {"yolo", "all"}:
        print(f"Best YOLO checkpoint: {train_yolo(args, roots, manifest)}")


if __name__ == "__main__":
    main()
