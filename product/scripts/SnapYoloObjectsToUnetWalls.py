"""
SnapYoloObjectsToUnetWalls.py

Snapped YOLO-erkannte Objekte (Türen/Fenster) an die nächstgelegene UNet-Wand.
Erzeugt eine kombinierte JSON-Datei mit Wänden + zugeordneten Öffnungen.

Nutzung (CLI):
    python -m product.scripts.SnapYoloObjectsToUnetWalls ^
        --unet  path/to/floorplan_unet.json ^
        --yolo  path/to/floorplan_yolo.json ^
        --out   path/to/WallsAndObjects.json ^
        --threshold 25.0

Oder als importierbares Modul:
    from product.scripts.SnapYoloObjectsToUnetWalls import snap_objects_to_walls
    result = snap_objects_to_walls(unet_path, yolo_path, threshold=20.0)
"""

import json
import os
import argparse
from shapely.geometry import LineString, Point


def snap_objects_to_walls(
    unet_json_path: str,
    yolo_json_path: str,
    output_path: str | None = None,
    snap_threshold_px: float = 20.0,
) -> dict:
    """
    Liest UNet-Wand-JSON und YOLO-Detektions-JSON ein,
    snapt erkannte Türen/Fenster an die nächste Wand und gibt
    das kombinierte Ergebnis zurück (und speichert es optional).

    Args:
        unet_json_path:    Pfad zur UNet-Geometrie-JSON (walls).
        yolo_json_path:    Pfad zur YOLO-Detektions-JSON (detections).
        output_path:       Optionaler Pfad für die Ausgabe-JSON.
                           Wenn None, wird nicht gespeichert.
        snap_threshold_px: Max. Abstand (in Pixel) für das Snapping.

    Returns:
        Das aktualisierte wall_data-Dictionary mit zugeordneten Türen/Fenstern.
    """
    # --- 1. Dateien laden ---
    if not os.path.exists(unet_json_path):
        raise FileNotFoundError(f"UNet-JSON nicht gefunden: {unet_json_path}")
    if not os.path.exists(yolo_json_path):
        raise FileNotFoundError(f"YOLO-JSON nicht gefunden: {yolo_json_path}")

    with open(unet_json_path, "r", encoding="utf-8") as f:
        wall_data = json.load(f)

    with open(yolo_json_path, "r", encoding="utf-8") as f:
        yolo_data = json.load(f)

    walls = wall_data["walls"]
    detections = yolo_data["detections"]

    snapped_count = 0
    skipped_count = 0

    # --- 2. Jede Detektion verarbeiten ---
    for obj in detections:
        if obj["name"] not in ["Tuer", "Fenster"]:
            continue  # Andere Objekte (Toiletten, Schränke etc.) überspringen

        # Mittelpunkt der YOLO Bounding Box berechnen
        bbox = obj["bbox"]
        center_x = (bbox["xmin"] + bbox["xmax"]) / 2
        center_y = (bbox["ymin"] + bbox["ymax"]) / 2
        obj_point = Point(center_x, center_y)

        best_wall = None
        min_distance = float("inf")
        snapped_coords = None

        # --- 3. Nächste Wand finden ---
        for wall in walls:
            wall_line = LineString([
                (wall["start"]["x"], wall["start"]["y"]),
                (wall["end"]["x"], wall["end"]["y"]),
            ])

            distance = obj_point.distance(wall_line)

            if distance < min_distance:
                min_distance = distance
                best_wall = wall
                # Punkt auf die Wandlinie projizieren
                projected_point = wall_line.interpolate(wall_line.project(obj_point))
                snapped_coords = (projected_point.x, projected_point.y)

        # --- 4. Objekt an Wand snappen (wenn innerhalb des Schwellwerts) ---
        if best_wall and snapped_coords and min_distance < snap_threshold_px:
            key = "doors" if obj["name"] == "Tuer" else "windows"

            # Liste initialisieren, falls noch nicht vorhanden
            if key not in best_wall:
                best_wall[key] = []

            best_wall[key].append({
                "yolo_confidence": obj["confidence"],
                "snapped_at": {
                    "x": round(snapped_coords[0], 2),
                    "y": round(snapped_coords[1], 2),
                },
                "original_bbox": bbox,
            })
            snapped_count += 1
        else:
            skipped_count += 1
            obj_label = obj["name"]
            print(
                f"  [!] {obj_label} bei ({center_x:.0f}, {center_y:.0f}) "
                f"uebersprungen (Abstand {min_distance:.1f}px > Schwellwert {snap_threshold_px}px)"
            )

    # --- 5. Ergebnis speichern ---
    if output_path:
        os.makedirs(os.path.dirname(output_path) or ".", exist_ok=True)
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(wall_data, f, indent=4, ensure_ascii=False)

    print(f"\n  Ergebnis: {snapped_count} Objekte gesnappt, {skipped_count} uebersprungen.")
    if output_path:
        print(f"  Gespeichert: {output_path}")

    return wall_data


def main():
    parser = argparse.ArgumentParser(
        description="Snappt YOLO-erkannte Tueren/Fenster an UNet-Waende.",
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""\
Beispiel:
  python -m product.scripts.SnapYoloObjectsToUnetWalls \\
      --unet  product/segmentation/debug/outputs/colorful_1603_geometry.json \\
      --yolo  path/to/yolo_detections.json \\
      --out   product/segmentation/debug/outputs/WallsAndObjects.json
        """,
    )
    parser.add_argument(
        "--unet",
        required=True,
        help="Pfad zur UNet-Wand-Geometrie-JSON (z.B. *_geometry.json)",
    )
    parser.add_argument(
        "--yolo",
        required=True,
        help="Pfad zur YOLO-Detektions-JSON (z.B. floorplan_yolo.json)",
    )
    parser.add_argument(
        "--out",
        default=None,
        help="Pfad fuer die Ausgabe-JSON. Standard: <unet-name>_with_objects.json im selben Ordner",
    )
    parser.add_argument(
        "--threshold",
        type=float,
        default=20.0,
        help="Max. Snap-Distanz in Pixeln (Standard: 20.0)",
    )

    args = parser.parse_args()

    # Standard-Ausgabepfad generieren, wenn keiner angegeben
    if args.out is None:
        base, ext = os.path.splitext(args.unet)
        args.out = f"{base}_with_objects{ext}"

    print("--- Snap YOLO Objects to UNet Walls ---")
    print(f"  UNet-JSON  : {os.path.abspath(args.unet)}")
    print(f"  YOLO-JSON  : {os.path.abspath(args.yolo)}")
    print(f"  Ausgabe    : {os.path.abspath(args.out)}")
    print(f"  Schwellwert: {args.threshold}px")
    print()

    snap_objects_to_walls(
        unet_json_path=args.unet,
        yolo_json_path=args.yolo,
        output_path=args.out,
        snap_threshold_px=args.threshold,
    )

    print("\n--- Fertig! ---")


if __name__ == "__main__":
    main()