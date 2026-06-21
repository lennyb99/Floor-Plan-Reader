"""
objectsToWalls.py – Merges YOLO detections onto UNet wall geometry.

Rewritten as a pure function (no Colab, no file I/O) so server.py can import it.

Input formats
─────────────
wall_data   : { "walls": [ { "id", "start", "end", "thickness", "windows": [], "doors": [] }, ... ] }
yolo_data   : { "detections": [ { "name", "confidence", "bbox": { xmin, ymin, xmax, ymax } }, ... ] }

Output – same as wall_data but with windows/doors filled in.
Children use the field names revise.html expects:
  { "detection_id", "confidence", "center": {x,y}, "width", "height", "distance_to_wall" }
"""

from shapely.geometry import LineString, Point
import copy

# YOLO class names → wall child key. Extend if your model adds classes.
YOLO_CLASS_MAP = {
    "Tuer":    "doors",
    "Fenster": "windows",
}

# Max pixel distance for a detection center to be snapped onto a wall.
SNAP_THRESHOLD_PX = 20.0


def merge(wall_data: dict, yolo_data: dict) -> dict:
    """Snap YOLO detections onto the nearest wall and return the merged dict."""
    result = copy.deepcopy(wall_data)
    walls  = result["walls"]

    # Build Shapely lines once — reused for every detection
    wall_lines = [
        LineString([(w["start"]["x"], w["start"]["y"]),
                    (w["end"]["x"],   w["end"]["y"])])
        for w in walls
    ]

    for detection_id, obj in enumerate(yolo_data.get("detections", [])):
        target_key = YOLO_CLASS_MAP.get(obj["name"])
        if target_key is None:
            continue  # Skip toilets, sinks, etc.

        bbox     = obj["bbox"]
        center_x = (bbox["xmin"] + bbox["xmax"]) / 2
        center_y = (bbox["ymin"] + bbox["ymax"]) / 2
        obj_pt   = Point(center_x, center_y)

        # Find closest wall
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
            continue  # No wall close enough

        # Build child in the format revise.html expects
        child = {
            "detection_id":     detection_id,
            "confidence":       obj["confidence"],
            "center":           {"x": round(snapped_pt[0], 2),
                                 "y": round(snapped_pt[1], 2)},
            "width":            round(bbox["xmax"] - bbox["xmin"], 2),
            "height":           round(bbox["ymax"] - bbox["ymin"], 2),
            "distance_to_wall": round(min_dist, 2),
        }

        walls[best_idx][target_key].append(child)

    return result
