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
# These keep their own top-level records. Furniture that normally sits against
# a wall gets its nearest bbox edge snapped to the visible wall face, while
# truly free-standing symbols such as stairs remain at the detected center.
FURNITURE_CLASSES = {
    "Waschbecken",
    "Herd",
    "Her",  # legacy class typo in yolo_cc_1.pt
    "Toilette",
    "Bett",
    "Dusche",
    "Treppe",
}

WALL_ATTACHED_FURNITURE_CLASSES = {
    "Waschbecken",
    "Herd",
    "Toilette",
    "Dusche",
    "Bett",
}

FURNITURE_DEFAULT_SIZES = {
    "Waschbecken": (42.0, 32.0),
    "Herd":        (34.0, 34.0),
    "Toilette":    (22.0, 34.0),
    "Bett":        (72.0, 92.0),
    "Dusche":      (48.0, 48.0),
    "Treppe":      (52.0, 76.0),
}

# Max pixel distance for wall-snapped classes.
SNAP_THRESHOLD_PX = 40.0
FURNITURE_SNAP_THRESHOLD_PX = 70.0


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


def _wall_is_horizontal(wall: dict) -> bool:
    return abs(wall["end"]["x"] - wall["start"]["x"]) >= abs(wall["end"]["y"] - wall["start"]["y"])


def _interval_gap(min_a: float, max_a: float, min_b: float, max_b: float) -> float:
    if max_a < min_b:
        return min_b - max_a
    if max_b < min_a:
        return min_a - max_b
    return 0.0


def _clamp(value: float, minimum: float, maximum: float) -> float:
    if maximum < minimum:
        return (minimum + maximum) / 2
    return max(minimum, min(maximum, value))


def default_furniture_size(name: str, detected_width: float, detected_height: float) -> tuple[float, float]:
    """Return stable editor dimensions for known classes.

    YOLO boxes vary strongly with handwriting thickness and perspective. The
    floor-plan editor should start with consistent object symbols and keep the
    raw detection box only as provenance.
    """
    return FURNITURE_DEFAULT_SIZES.get(name, (detected_width, detected_height))


def snap_furniture_bbox_to_wall_edge(item: dict, walls: list[dict], threshold_px: float = FURNITURE_SNAP_THRESHOLD_PX) -> dict:
    """Snap a furniture item's nearest bbox edge to a visible wall edge.

    Windows and doors are centered on wall centerlines because they cut holes
    into walls. Furniture instead sits beside a wall; snapping its nearest box
    edge to the wall's visible face keeps it from protruding through the wall.
    """
    if item.get("class") not in WALL_ATTACHED_FURNITURE_CLASSES:
        return item

    cx = float(item["center"]["x"])
    cy = float(item["center"]["y"])
    width = float(item["width"])
    height = float(item["height"])
    left, right = cx - width / 2, cx + width / 2
    top, bottom = cy - height / 2, cy + height / 2
    best = None

    for wall in walls:
        half = max(1.0, float(wall.get("thickness", 8)) / 2)
        if _wall_is_horizontal(wall):
            wall_y = (float(wall["start"]["y"]) + float(wall["end"]["y"])) / 2
            wall_min_x = min(float(wall["start"]["x"]), float(wall["end"]["x"]))
            wall_max_x = max(float(wall["start"]["x"]), float(wall["end"]["x"]))
            along_gap = _interval_gap(left, right, wall_min_x, wall_max_x)
            if along_gap > threshold_px:
                continue
            candidates = [
                ("top", "bottom", wall_y + half + height / 2),
                ("bottom", "top", wall_y - half - height / 2),
            ]
            for furniture_edge, wall_edge, target_y in candidates:
                offset = target_y - cy
                distance = (offset * offset + along_gap * along_gap) ** 0.5
                if abs(offset) > threshold_px or (best and distance >= best["distance"]):
                    continue
                best = {
                    "distance": distance,
                    "center": {
                        "x": _clamp(cx, wall_min_x + width / 2, wall_max_x - width / 2),
                        "y": target_y,
                    },
                    "attachment": {
                        "mode": "bbox_edge_to_wall_thickness",
                        "wall_id": wall.get("id"),
                        "wall_orientation": "horizontal",
                        "furniture_edge": furniture_edge,
                        "wall_edge": wall_edge,
                    },
                }
        else:
            wall_x = (float(wall["start"]["x"]) + float(wall["end"]["x"])) / 2
            wall_min_y = min(float(wall["start"]["y"]), float(wall["end"]["y"]))
            wall_max_y = max(float(wall["start"]["y"]), float(wall["end"]["y"]))
            along_gap = _interval_gap(top, bottom, wall_min_y, wall_max_y)
            if along_gap > threshold_px:
                continue
            candidates = [
                ("left", "right", wall_x + half + width / 2),
                ("right", "left", wall_x - half - width / 2),
            ]
            for furniture_edge, wall_edge, target_x in candidates:
                offset = target_x - cx
                distance = (offset * offset + along_gap * along_gap) ** 0.5
                if abs(offset) > threshold_px or (best and distance >= best["distance"]):
                    continue
                best = {
                    "distance": distance,
                    "center": {
                        "x": target_x,
                        "y": _clamp(cy, wall_min_y + height / 2, wall_max_y - height / 2),
                    },
                    "attachment": {
                        "mode": "bbox_edge_to_wall_thickness",
                        "wall_id": wall.get("id"),
                        "wall_orientation": "vertical",
                        "furniture_edge": furniture_edge,
                        "wall_edge": wall_edge,
                    },
                }

    if best:
        item["center"] = {
            "x": round(best["center"]["x"], 2),
            "y": round(best["center"]["y"], 2),
        }
        item["attached_wall_id"] = best["attachment"]["wall_id"]
        item["attachment"] = best["attachment"]
        item["rotation"] = rotation_for_attachment(best["attachment"])
    else:
        item["rotation"] = 0
    return item


def rotation_for_attachment(attachment: dict) -> float:
    """2D symbol rotation in degrees.

    The SVG furniture assets are authored with their wall/back side at the top.
    We rotate that top edge toward the wall face selected by the snap.
    """
    wall_edge = attachment.get("wall_edge")
    if wall_edge == "bottom":
        return 0
    if wall_edge == "top":
        return 180
    if wall_edge == "right":
        return -90
    if wall_edge == "left":
        return 90
    return 0


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
            default_width, default_height = default_furniture_size(display_name, w, h)
            item = {
                "id":         f"furniture_{detection_id}",
                "class":      display_name,
                "confidence": obj["confidence"],
                "center":     {"x": round(cx, 2), "y": round(cy, 2)},
                "width":      round(default_width, 2),
                "height":     round(default_height, 2),
                "rotation":   0,
                "raw_bbox":   {
                    "xmin": round(bbox["xmin"], 2),
                    "ymin": round(bbox["ymin"], 2),
                    "xmax": round(bbox["xmax"], 2),
                    "ymax": round(bbox["ymax"], 2),
                    "width": w,
                    "height": h,
                },
            }
            snap_furniture_bbox_to_wall_edge(item, walls)
            furniture.append(item)
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
