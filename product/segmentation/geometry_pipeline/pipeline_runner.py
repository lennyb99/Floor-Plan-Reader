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
    extract_structural_ink_guides,
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

    positive = distance_map[distance_map > 0.5]
    fallback = float(np.median(positive) * 2.0) if positive.size else 8.0

    for idx, line in enumerate(lines):
        coords = list(line.coords)
        samples = []
        for ratio in np.linspace(0.05, 0.95, 19):
            x = coords[0][0] + (coords[-1][0] - coords[0][0]) * ratio
            y = coords[0][1] + (coords[-1][1] - coords[0][1]) * ratio
            px = int(np.clip(round(x), 0, w - 1))
            py = int(np.clip(round(y), 0, h - 1))
            patch = distance_map[max(0, py - 2):min(h, py + 3), max(0, px - 2):min(w, px + 3)]
            local = patch[patch > 0.5]
            if local.size:
                samples.append(float(np.max(local)))

        # Connector midpoints and wall openings can lie outside the raw mask.
        # Robust multi-point sampling prevents those walls from becoming
        # nearly invisible in 3D.
        thickness = float(np.median(samples) * 2.0) if samples else fallback
        thickness = float(np.clip(thickness, 4.0, 40.0))

        walls.append(
            WallElement(
                id=f"wall_{idx:04d}",
                geometry=line,
                thickness_px=thickness,
            )
        )

    return walls


def normalize_wall_thicknesses(walls: list[WallElement]) -> list[WallElement]:
    """Use one robust wall width for a hand-drawn plan.

    Local distance-transform samples fluctuate heavily around ink blobs,
    junctions and repaired gaps.  A single median width produces stable wall
    faces in the editor and prevents overlapping, flickering 3D surfaces.
    """
    if not walls:
        return walls
    canonical = float(np.clip(round(np.median([wall.thickness_px for wall in walls])), 6.0, 18.0))
    for wall in walls:
        wall.thickness_px = canonical
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
    guide_image: np.ndarray | str | None = None,
    debug: bool = False, 
    output_dir: str | None = None,
    return_visualization: bool = False,
    return_debug_images: bool = False
) -> dict | tuple[dict, np.ndarray] | tuple[dict, dict]:
    """Run the pipeline in-memory and return a JSON dictionary.
    
    If return_visualization is True, returns a tuple: (json_dict, visualization_image_array)
    If return_debug_images is True, returns a tuple: (json_dict, dict_of_debug_images)
    If debug is True, intermediate steps are saved to output_dir (which must be provided).
    """
    debug_images = {}
    
    raw_mask = load_binary_mask(image_source)
    if return_debug_images: debug_images["00_raw_input"] = raw_mask.copy()
    if debug and output_dir:
        save_debug_image("00_raw_input", raw_mask, output_dir)

    clean_mask = clean_wall_mask(raw_mask)
    if return_debug_images: debug_images["01_cleaned_mask"] = clean_mask.copy()
    if debug and output_dir:
        save_debug_image("01_cleaned_mask", clean_mask, output_dir)

    distance_map = compute_thickness_map(clean_mask)
    visual_dist_map = cv2.normalize(distance_map, np.zeros_like(distance_map), 0, 255, cv2.NORM_MINMAX)
    if return_debug_images: debug_images["02_distance_map"] = visual_dist_map.astype(np.uint8)
    if debug and output_dir:
        save_debug_image("02_distance_map", visual_dist_map.astype(np.uint8), output_dir)

    skeleton_mask = extract_skeleton(clean_mask)
    if return_debug_images: debug_images["03_skeleton_mask"] = skeleton_mask.copy()
    if debug and output_dir:
        save_debug_image("03_skeleton_mask", skeleton_mask, output_dir)

    raw_lines = vectorize_skeleton(skeleton_mask)
    black_bg = np.zeros_like(clean_mask)
    if return_debug_images: debug_images["04_raw_vectors"] = draw_vector_debug_image(raw_lines, black_bg.copy())
    if debug and output_dir:
        save_vector_debug_image("04_raw_vectors", raw_lines, black_bg, output_dir)

    clean_lines = clean_topology(raw_lines, snap_tolerance_px=7.0)

    # Conservative hybrid fallback: the neural mask decides what a wall looks
    # like; long raw-ink axes may only extend it or bridge two known axes.
    ink_guides = extract_structural_ink_guides(guide_image, clean_lines) if guide_image is not None else []
    if ink_guides:
        clean_lines = clean_topology(clean_lines + ink_guides, snap_tolerance_px=7.0)
    if return_debug_images:
        debug_images["04a_ink_guides"] = draw_vector_debug_image(ink_guides, black_bg.copy())

    black_bg2 = np.zeros_like(clean_mask)
    if return_debug_images: debug_images["05_clean_topology"] = draw_vector_debug_image(clean_lines, black_bg2.copy())
    if debug and output_dir:
        save_vector_debug_image("05_clean_topology", clean_lines, black_bg2.copy(), output_dir)
    
    # Neu: Lose Enden (Lücken) schließen
    from product.segmentation.geometry_pipeline.image_to_json_pipeline import connect_loose_ends
    clean_lines = connect_loose_ends(clean_lines, max_dist=125.0)

    black_bg3_debug = np.zeros_like(clean_mask)
    if return_debug_images: debug_images["06_connect_loose_ends"] = draw_vector_debug_image(clean_lines, black_bg3_debug.copy())
    if debug and output_dir:
        save_vector_debug_image("06_connect_loose_ends", clean_lines, black_bg3_debug, output_dir)

    # Neu: Kollineare Segmente zu durchgezogenen Linien verschmelzen
    from product.segmentation.geometry_pipeline.image_to_json_pipeline import (
        coalesce_near_parallel_lines,
        merge_collinear_lines,
    )
    clean_lines = merge_collinear_lines(clean_lines)
    clean_lines = coalesce_near_parallel_lines(clean_lines)

    black_bg4_debug = np.zeros_like(clean_mask)
    if return_debug_images: debug_images["07_merged_lines"] = draw_vector_debug_image(clean_lines, black_bg4_debug.copy())
    if debug and output_dir:
        save_vector_debug_image("07_merged_lines", clean_lines, black_bg4_debug, output_dir)

    final_walls = normalize_wall_thicknesses(assign_thickness(clean_lines, distance_map))
    img_height = clean_mask.shape[0]
    
    json_dict = generate_json_dict(final_walls, img_height)
    
    if return_debug_images:
        return json_dict, debug_images
        
    if return_visualization:
        black_bg3 = np.zeros_like(clean_mask)
        vis_img = draw_vector_debug_image(clean_lines, black_bg3)
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
