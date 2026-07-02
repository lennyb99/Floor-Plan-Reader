"""
pipeline_runner.py – Lightweight entry-point for the floor-plan geometry pipeline.

Usage (from repo root or any cwd):
    python -m product.segmentation.geometry_pipeline.pipeline_runner          # interactive image picker
    python -m product.segmentation.geometry_pipeline.pipeline_runner aaa.png  # direct path
    python -m product.segmentation.geometry_pipeline.pipeline_runner aaa.png --debug

Or import as a module:
    from product.segmentation.geometry_pipeline.pipeline_runner import run_pipeline
    run_pipeline("aaa.png", debug=True)
"""

from __future__ import annotations

import os
import sys
import cv2
import numpy as np
from pathlib import Path

# ---------------------------------------------------------------------------
# Resolve project paths relative to *this* file so it works from any cwd.
# ---------------------------------------------------------------------------
_THIS_DIR = Path(__file__).resolve().parent
_DEBUG_DIR = _THIS_DIR.parent / "debug"
_IMAGES_DIR = _DEBUG_DIR / "images"
_OUTPUTS_DIR = _DEBUG_DIR / "outputs"

# ---------------------------------------------------------------------------
# Import pipeline functions
# ---------------------------------------------------------------------------
from product.segmentation.geometry_pipeline.image_to_json_pipeline import (
    WallElement,
    load_binary_mask,
    clean_wall_mask,
    compute_thickness_map,
    extract_skeleton,
    vectorize_skeleton,
    clean_topology,
    generate_json_dict,
    export_to_json,
    save_debug_image,
    save_vector_debug_image,
    draw_vector_debug_image,
)


# ---------------------------------------------------------------------------
# Helper that was missing from the original pipeline module
# ---------------------------------------------------------------------------
def assign_thickness(
    lines: list,
    distance_map: np.ndarray,
) -> list[WallElement]:
    """Assign a wall thickness to each line segment.

    For each segment the thickness is sampled from the *distance_map* at the
    line's midpoint.  The distance transform gives the distance from a wall
    pixel to the nearest background pixel, which equals the *half-thickness*.
    We therefore double the value to obtain the full wall thickness.
    """
    walls: list[WallElement] = []
    h, w = distance_map.shape[:2]

    for idx, line in enumerate(lines):
        coords = list(line.coords)
        mid_x = (coords[0][0] + coords[-1][0]) / 2.0
        mid_y = (coords[0][1] + coords[-1][1]) / 2.0

        # Clamp to image bounds
        px = int(np.clip(mid_x, 0, w - 1))
        py = int(np.clip(mid_y, 0, h - 1))

        half_thickness = float(distance_map[py, px])
        thickness = half_thickness * 2.0

        walls.append(
            WallElement(
                id=f"wall_{idx:04d}",
                geometry=line,
                thickness_px=thickness,
            )
        )

    return walls


# ---------------------------------------------------------------------------
# Utility: list available images
# ---------------------------------------------------------------------------
_SUPPORTED_EXTS = {".png", ".jpg", ".jpeg", ".bmp", ".tiff", ".tif", ".webp"}


def list_available_images() -> list[str]:
    """Return file-names inside *debug/images/* that look like images."""
    if not _IMAGES_DIR.exists():
        return []
    return sorted(
        f.name
        for f in _IMAGES_DIR.iterdir()
        if f.is_file() and f.suffix.lower() in _SUPPORTED_EXTS
    )


def _pick_image_interactive() -> str:
    """CLI helper – let the user choose an image interactively."""
    images = list_available_images()
    if not images:
        print(f"[✗] Keine Bilder in {_IMAGES_DIR} gefunden.")
        sys.exit(1)

    print("\n📂 Verfügbare Bilder in debug/images/:")
    for i, name in enumerate(images, start=1):
        print(f"  [{i}] {name}")

    choice = input("\nBild-Nummer oder Dateiname eingeben: ").strip()

    # Numeric choice
    if choice.isdigit():
        idx = int(choice) - 1
        if 0 <= idx < len(images):
            return images[idx]
        print("[✗] Ungültige Nummer.")
        sys.exit(1)

    # Direct name
    if choice in images:
        return choice

    print(f"[✗] Bild '{choice}' nicht gefunden.")
    sys.exit(1)


def process_image(
    image_source: np.ndarray | str, 
    debug: bool = False, 
    output_dir: str | None = None,
    return_visualization: bool = False
) -> dict | tuple[dict, np.ndarray]:
    """Run the pipeline in-memory and return a JSON dictionary.
    
    If return_visualization is True, returns a tuple: (json_dict, visualization_image_array)
    If debug is True, intermediate steps are saved to output_dir (which must be provided).
    """
    raw_mask = load_binary_mask(image_source)
    if debug and output_dir:
        save_debug_image("00_raw_input", raw_mask, output_dir)

    clean_mask = clean_wall_mask(raw_mask)
    if debug and output_dir:
        save_debug_image("01_cleaned_mask", clean_mask, output_dir)

    distance_map = compute_thickness_map(clean_mask)
    if debug and output_dir:
        visual_dist_map = cv2.normalize(distance_map, np.zeros_like(distance_map), 0, 255, cv2.NORM_MINMAX)
        save_debug_image("02_distance_map", visual_dist_map.astype(np.uint8), output_dir)

    skeleton_mask = extract_skeleton(clean_mask)
    if debug and output_dir:
        save_debug_image("03_skeleton_mask", skeleton_mask, output_dir)

    raw_lines = vectorize_skeleton(skeleton_mask)
    if debug and output_dir:
        black_bg = np.zeros_like(clean_mask)
        save_vector_debug_image("04_raw_vectors", raw_lines, black_bg, output_dir)

    clean_lines = clean_topology(raw_lines, snap_tolerance_px=15.0)
    if debug and output_dir:
        black_bg = np.zeros_like(clean_mask)
        save_vector_debug_image("05_clean_topology", clean_lines, black_bg, output_dir)

    final_walls = assign_thickness(clean_lines, distance_map)
    img_height = clean_mask.shape[0]
    
    json_dict = generate_json_dict(final_walls, img_height)
    
    if return_visualization:
        black_bg = np.zeros_like(clean_mask)
        vis_img = draw_vector_debug_image(clean_lines, black_bg)
        return json_dict, vis_img
        
    return json_dict

# ---------------------------------------------------------------------------
# Main pipeline entry-point
# ---------------------------------------------------------------------------
def run_pipeline(image_name: str, *, debug: bool = False) -> Path:
    """Run the full geometry pipeline for a single image.

    Parameters
    ----------
    image_name:
        File-name (not full path) of an image inside ``debug/images/``.
    debug:
        If *True*, intermediate step images are saved to ``debug/outputs/``.

    Returns
    -------
    Path to the generated JSON file.
    """
    image_path = _IMAGES_DIR / image_name
    if not image_path.exists():
        raise FileNotFoundError(
            f"Bild nicht gefunden: {image_path}\n"
            f"Verfügbare Bilder: {list_available_images()}"
        )

    # Prepare output directory
    os.makedirs(_OUTPUTS_DIR, exist_ok=True)
    output_json = _OUTPUTS_DIR / f"{image_path.stem}_geometry.json"
    output_dir = str(_OUTPUTS_DIR)

    print("--- 🚀 Starte Geometrie-Pipeline ---")
    print(f"    Eingabe : {image_path}")
    print(f"    Ausgabe : {output_json}")
    print(f"    Debug   : {'AN' if debug else 'AUS'}\n")

    # Call the core processing function
    json_data = process_image(str(image_path), debug=debug, output_dir=output_dir if debug else None)
    
    # Save the JSON manually since we want the old behavior
    import json
    with open(output_json, 'w') as f:
        json.dump(json_data, f, indent=4)

    print(f"\n--- 🎉 Pipeline erfolgreich! Ergebnis: {output_json} ---")
    return output_json


# ---------------------------------------------------------------------------
# CLI entry-point
# ---------------------------------------------------------------------------
def main() -> None:
    import argparse

    parser = argparse.ArgumentParser(
        description="Grundriss-Geometrie-Pipeline – verarbeitet ein Bild zu JSON.",
    )
    parser.add_argument(
        "image",
        nargs="?",
        default=None,
        help="Dateiname eines Bildes in debug/images/ (interaktive Auswahl wenn leer).",
    )
    parser.add_argument(
        "--debug",
        action="store_true",
        help="Zwischenschritt-Bilder in debug/outputs/ speichern.",
    )
    args = parser.parse_args()

    image_name = args.image or _pick_image_interactive()

    try:
        run_pipeline(image_name, debug=args.debug)
    except Exception as e:
        import traceback
        print(f"\n[FEHLER] Pipeline abgebrochen: {e}")
        traceback.print_exc()
        sys.exit(1)


if __name__ == "__main__":
    main()
