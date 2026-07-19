"""
objectsToWalls.py – Merges YOLO detections onto UNet wall geometry.

Wall-snapped classes  (Tuer, Fenster, Doppeltuer) → attached as children of nearest wall.
Free-standing classes (Waschbecken, Herd, Toilette, …) → top-level "furniture" list.

Output JSON shape
─────────────────
{
  "walls": [
    { "id", "start", "end", "thickness",
      "windows": [ { detection_id, confidence, center, width, height, distance_to_wall } ],
      "doors":   [ { ... } ]
    }
  ],
  "furniture": [
    { "id", "class", "confidence", "center": {x, y}, "width", "height" }
  ]
}
"""

from shapely.geometry import LineString, Point
import copy

# ── Wall-snapped classes ───────────────────────────────────────────────────────
# These get projected onto the nearest wall (must be within SNAP_THRESHOLD_PX).
WALL_CLASS_MAP = {
    "Tuer":        "doors",
    "Doppeltuer":  "doors",
    "Fenster":     "windows",
}

# ── Free-standing furniture classes ───────────────────────────────────────────
# These are placed by their bbox center in world space — no wall snapping.
FURNITURE_CLASSES = {
    "Waschbecken",
    "Herd",
    "Toilette",
    "Bett",
}

# Max pixel distance for wall-snapped classes.
SNAP_THRESHOLD_PX = 40.0


def merge(wall_data: dict, yolo_data: dict) -> dict:
    """Route YOLO detections to wall children or top-level furniture."""
    result            = copy.deepcopy(wall_data)
    result.setdefault("furniture", [])   # ensure key exists even if no furniture detected

    walls      = result["walls"]
    furniture  = result["furniture"]

    # Build Shapely lines once — reused for every wall-snapped detection
    wall_lines = [
        LineString([(w["start"]["x"], w["start"]["y"]),
                    (w["end"]["x"],   w["end"]["y"])])
        for w in walls
    ]

    for detection_id, obj in enumerate(yolo_data.get("detections", [])):
        name = obj["name"]
        bbox = obj["bbox"]
        cx   = (bbox["xmin"] + bbox["xmax"]) / 2
        cy   = (bbox["ymin"] + bbox["ymax"]) / 2
        w    = round(bbox["xmax"] - bbox["xmin"], 2)
        h    = round(bbox["ymax"] - bbox["ymin"], 2)

        # ── Free-standing furniture ────────────────────────────────────────────
        if name in FURNITURE_CLASSES:
            furniture.append({
                "id":         f"furniture_{detection_id}",
                "class":      name,
                "confidence": obj["confidence"],
                "center":     {"x": round(cx, 2), "y": round(cy, 2)},
                "width":      w,
                "height":     h,
            })
            continue

        # ── Wall-snapped objects ───────────────────────────────────────────────
        target_key = WALL_CLASS_MAP.get(name)
        if target_key is None:
            continue   # Treppe, Bett, Dusche — not yet supported, skip silently

        obj_pt     = Point(cx, cy)
        best_idx   = None
        min_dist   = float("inf")
        snapped_pt = None

        for i, line in enumerate(wall_lines):
            dist = obj_pt.distance(line)
            if dist < min_dist:
                min_dist   = dist
                best_idx   = i
                proj       = line.interpolate(line.project(obj_pt))
                snapped_pt = (proj.x, proj.y)

        if best_idx is None or min_dist > SNAP_THRESHOLD_PX:
            continue   # No wall close enough

        walls[best_idx][target_key].append({
            "detection_id":     detection_id,
            "confidence":       obj["confidence"],
            "center":           {"x": round(snapped_pt[0], 2),
                                 "y": round(snapped_pt[1], 2)},
            "width":            w,
            "height":           h,
            "distance_to_wall": round(min_dist, 2),
        })

    return result
