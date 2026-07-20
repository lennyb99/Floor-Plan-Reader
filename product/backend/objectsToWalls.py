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
    "Her",  # legacy class typo in yolo_cc_1.pt
    "Toilette",
    "Bett",
    "Dusche",
    "Treppe",
}

# Max pixel distance for wall-snapped classes.
SNAP_THRESHOLD_PX = 40.0


def normalize_furniture_class(name: str, width: float, height: float) -> str:
    """Resolve a common bed/stove ambiguity in hand-drawn symbol models.

    Beds have a clearly elongated footprint in all three training domains,
    while cooker symbols are close to square.  The detector occasionally
    labels a square cooker with two hotplates as ``Bett``.
    """
    if name != "Bett" or min(width, height) <= 0:
        return "Herd" if name == "Her" else name

    aspect_ratio = max(width, height) / min(width, height)
    # A cooker false-positive is both nearly square and compact. Real beds can
    # look almost square after perspective correction, but remain materially
    # larger in the public 512 px coordinate space.
    return "Herd" if aspect_ratio < 1.35 and max(width, height) < 70 else name


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
            display_name = normalize_furniture_class(name, w, h)
            furniture.append({
                "id":         f"furniture_{detection_id}",
                "class":      display_name,
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

        target_line = wall_lines[best_idx]
        tx = abs(target_line.coords[-1][0] - target_line.coords[0][0])
        ty = abs(target_line.coords[-1][1] - target_line.coords[0][1])
        # Use the box extent along the wall.  max(width, height) included door
        # swing arcs and produced oversized holes in the 3D mesh.
        opening_width = w if tx >= ty else h

        walls[best_idx][target_key].append({
            "detection_id":     detection_id,
            "confidence":       obj["confidence"],
            "center":           {"x": round(snapped_pt[0], 2),
                                 "y": round(snapped_pt[1], 2)},
            "width":            w,
            "height":           h,
            "opening_width":    round(opening_width, 2),
            "distance_to_wall": round(min_dist, 2),
        })

    return result
