import json
from shapely.geometry import LineString, Point
from google.colab import files

# 1. Load your data
with open('floorplan_unet.json', 'r') as f:
    wall_data = json.load(f)

with open('floorplan_yolo.json', 'r') as f:
    yolo_data = json.load(f)

walls = wall_data['walls']
detections = yolo_data['detections']

# 2. Process each detection (Filter for Doors/Windows)
for obj in detections:
    if obj['name'] not in ['Tuer', 'Fenster']:
        continue  # Skip other objects like toilets or cabinets

    # Calculate the center point of the YOLO bounding box
    bbox = obj['bbox']
    center_x = (bbox['xmin'] + bbox['xmax']) / 2
    center_y = (bbox['ymin'] + bbox['ymax']) / 2
    obj_point = Point(center_x, center_y)

    best_wall = None
    min_distance = float('inf')
    snapped_coords = None

    # 3. Find the closest wall
    for wall in walls:
        # Create a line segment for the wall
        wall_line = LineString([
            (wall['start']['x'], wall['start']['y']),
            (wall['end']['x'], wall['end']['y'])
        ])

        # Calculate distance from object center to this wall
        distance = obj_point.distance(wall_line)

        if distance < min_distance:
            min_distance = distance
            best_wall = wall
            # Project the point onto the line to get the exact snapped coordinates
            projected_point = wall_line.interpolate(wall_line.project(obj_point))
            snapped_coords = (projected_point.x, projected_point.y)

    # 4. Snap the object to the wall if it's within a reasonable threshold (e.g., 20 pixels)
    if best_wall and min_distance < 20.0:
        # Determine if it's a door or window array
        key = 'doors' if obj['name'] == 'Tuer' else 'windows'

        # Initialize the list if it doesn't exist
        if key not in best_wall:
            best_wall[key] = []

        # Append the snapped object to the wall
        best_wall[key].append({
            "yolo_confidence": obj['confidence'],
            "snapped_at": {
                "x": round(snapped_coords[0], 2),
                "y": round(snapped_coords[1], 2)
            },
            "original_bbox": bbox
        })

# 5. Save and download your newly updated floorplan geometry
output_file_path = 'WallsAndObjects.json'

# Write the full dictionary wrapper to the file
with open(output_file_path, 'w') as f:
    json.dump(wall_data, f, indent=4)

print(f"Saved updated floorplan to {output_file_path}")
files.download(output_file_path)