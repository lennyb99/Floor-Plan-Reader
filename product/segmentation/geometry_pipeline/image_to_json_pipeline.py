import cv2
import numpy as np
import os
from shapely.geometry import LineString, Point
from dataclasses import dataclass
from skimage.morphology import skeletonize
import json
from shapely.ops import unary_union
from typing import Union

@dataclass
class WallElement:
    id: str
    geometry: LineString
    thickness_px: float


# --- HILFSFUNKTION FÜR DEN PROGRESS ---
def save_debug_image(step_name: str, image: np.ndarray, output_dir: str = "debug_output"):
    """Speichert Zwischenschritte der Pipeline als Bilddatei ab."""
    os.makedirs(output_dir, exist_ok=True)
    filepath = os.path.join(output_dir, f"{step_name}.png")
    cv2.imwrite(filepath, image)
    print(f"[✓] Progress gespeichert: {filepath}")

def load_binary_mask(image_source: Union[str, np.ndarray]) -> np.ndarray:
    """Schritt 0: Lädt das Bild (aus Datei oder Speicher) und stellt sicher, dass es eine strikte Binärmaske (0 oder 255) ist."""
    if isinstance(image_source, str):
        if not os.path.exists(image_source):
            raise FileNotFoundError(f"Bild nicht gefunden: {image_source}")

        # Als Graustufenbild laden
        img = cv2.imread(image_source, cv2.IMREAD_GRAYSCALE)
        if img is None:
            raise ValueError(f"Bild konnte nicht geladen werden: {image_source}")
    else:
        # Check if it's already a numpy array
        img = image_source
        if len(img.shape) == 3:
            img = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)

    # Thresholding: Alles über 0 wird weiß (255), Rest schwarz (0)
    # Damit werden auch niedrige Werte wie 1 (z.B. aus Modell-Masken) korrekt als Wand erkannt.
    _, binary_mask = cv2.threshold(img, 0, 255, cv2.THRESH_BINARY)
    return binary_mask

# ==========================================
# SCHRITT 1: Masken-Bereinigung
# ==========================================
def clean_wall_mask(raw_mask: np.ndarray) -> np.ndarray:
    """Repair small cracks without filling intentional door-sized openings."""
    base_kernel = np.ones((3, 3), np.uint8)
    closed = cv2.morphologyEx(raw_mask, cv2.MORPH_CLOSE, base_kernel)

    # Floor-plan walls are predominantly axis-aligned.  Directional kernels
    # heal short inference dropouts while a 7 px cap leaves normal openings.
    horizontal = cv2.morphologyEx(closed, cv2.MORPH_CLOSE, np.ones((1, 7), np.uint8))
    vertical = cv2.morphologyEx(closed, cv2.MORPH_CLOSE, np.ones((7, 1), np.uint8))
    repaired = cv2.bitwise_or(closed, cv2.bitwise_or(horizontal, vertical))
    cleaned = cv2.morphologyEx(repaired, cv2.MORPH_OPEN, base_kernel)

    # Remove isolated speckles but retain thin connected wall strokes.
    count, labels, stats, _ = cv2.connectedComponentsWithStats(cleaned, connectivity=8)
    result = np.zeros_like(cleaned)
    for label in range(1, count):
        if stats[label, cv2.CC_STAT_AREA] >= 12:
            result[labels == label] = 255
    return result

# ==========================================
# SCHRITT 2: Wanddicken-Kartierung
# ==========================================
def compute_thickness_map(clean_mask: np.ndarray) -> np.ndarray:
    """Erstellt eine Heatmap, die den Abstand jedes Pixels zum Rand angibt."""
    # distanceTransform berechnet den Abstand zur nächsten '0' (schwarzer Hintergrund)
    distance_map = cv2.distanceTransform(clean_mask, cv2.DIST_L2, 5)
    return distance_map

# Schritt 3: Skelettierung
def extract_skeleton(clean_mask: np.ndarray) -> np.ndarray:
    """Schritt 3: Skelettierung der Maske auf exakt 1 Pixel Breite."""
    # scikit-image erwartet Werte zwischen 0 und 1 (Boolean oder Float)
    bool_mask = clean_mask > 0

    # Skelettierung ausführen
    skeleton_bool = skeletonize(bool_mask)

    # Wieder zurück in OpenCV-Format (0 und 255) konvertieren
    skeleton_img = np.zeros(clean_mask.shape, dtype=np.uint8)
    skeleton_img[skeleton_bool] = 255

    return skeleton_img

# Schritt 4: Vektorisierung
def vectorize_skeleton(skeleton: np.ndarray) -> list[LineString]:
    """Schritt 4: Wandelt die Pixel-Linien via Hough-Transformation in Shapely-Vektoren um."""
    # Parameter für die Hough-Transformation (müssen evtl. je nach Auflösung leicht angepasst werden)
    rho = 1            # Auflösung des Abstands in Pixeln
    theta = np.pi/180  # Auflösung des Winkels in Radiant (1 Grad)
    threshold = 15     # Mindestanzahl an Schnittpunkten in der Hough-Matrix, um eine Linie zu loggen
    min_line_length = 15  # Minimale Länge einer Wand in Pixeln (kürzere Linien werden ignoriert)
    max_line_gap = 30     # Maximale Lücke zwischen Pixeln, die noch als *selbe* Linie gezählt wird

    lines = cv2.HoughLinesP(skeleton, rho, theta, threshold,
                            minLineLength=min_line_length, maxLineGap=max_line_gap)

    shapely_lines = []

    if lines is not None:
        for line in lines:
            x1, y1, x2, y2 = line[0]
            # Erstelle ein Shapely LineString-Objekt (Vektor)
            shapely_lines.append(LineString([(x1, y1), (x2, y2)]))

    print(f"[i] Vektorisierung abgeschlossen: {len(shapely_lines)} Liniensegmente gefunden.")
    return shapely_lines


def extract_structural_ink_guides(
    image_source: Union[str, np.ndarray],
    reference_lines: list[LineString],
    *,
    axis_tolerance_px: float = 14.0,
) -> list[LineString]:
    """Recover long wall axes that the segmentation mask omitted.

    The neural mask remains the primary signal. Raw ink lines are accepted
    only when they extend an existing wall axis or connect two already known
    perpendicular axes. This recovers weak exterior/internal walls while
    rejecting isolated furniture rectangles and most annotation strokes.
    """
    if not reference_lines:
        return []

    if isinstance(image_source, str):
        image = cv2.imread(image_source, cv2.IMREAD_COLOR)
        if image is None:
            return []
        gray = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    else:
        image = np.asarray(image_source)
        if image.ndim == 2:
            gray = image.astype(np.uint8)
        else:
            # Product arrays use RGB; grayscale conversion is insensitive to
            # the small channel-order difference for black ink on paper.
            gray = cv2.cvtColor(image.astype(np.uint8), cv2.COLOR_RGB2GRAY)

    edges = cv2.Canny(gray, 35, 110)
    detected = cv2.HoughLinesP(
        edges, 1, np.pi / 180, 24,
        minLineLength=45, maxLineGap=18,
    )
    if detected is None:
        return []

    records: dict[str, list[tuple[float, float, float]]] = {"h": [], "v": []}
    for item in detected:
        x1, y1, x2, y2 = map(float, item[0])
        dx, dy = abs(x2 - x1), abs(y2 - y1)
        if max(dx, dy) < 45 or min(dx, dy) > max(dx, dy) * 0.14:
            continue
        if dx >= dy:
            records["h"].append(((y1 + y2) / 2.0, min(x1, x2), max(x1, x2)))
        else:
            records["v"].append(((x1 + x2) / 2.0, min(y1, y2), max(y1, y2)))

    def cluster_records(values, tolerance=7.0, max_gap=30.0):
        clusters: list[list[tuple[float, float, float]]] = []
        for record in sorted(values):
            for cluster in clusters:
                axis = float(np.median([entry[0] for entry in cluster]))
                if abs(record[0] - axis) <= tolerance:
                    cluster.append(record)
                    break
            else:
                clusters.append([record])

        merged_records = []
        for cluster in clusters:
            axis = float(np.median([entry[0] for entry in cluster]))
            intervals = sorted((entry[1], entry[2]) for entry in cluster)
            if not intervals:
                continue
            merged = [list(intervals[0])]
            for start, end in intervals[1:]:
                if start <= merged[-1][1] + max_gap:
                    merged[-1][1] = max(merged[-1][1], end)
                else:
                    merged.append([start, end])
            merged_records.extend(
                (axis, start, end) for start, end in merged if end - start >= 45
            )
        return merged_records

    def orientation(line: LineString) -> str:
        (x1, y1), (x2, y2) = line.coords[0], line.coords[-1]
        return "h" if abs(x2 - x1) >= abs(y2 - y1) else "v"

    guides: list[LineString] = []
    for kind in ("h", "v"):
        parallel = [line for line in reference_lines if orientation(line) == kind]
        perpendicular = [line for line in reference_lines if orientation(line) != kind]
        parallel_axes = []
        for line in parallel:
            (x1, y1), (x2, y2) = line.coords[0], line.coords[-1]
            parallel_axes.append((y1 + y2) / 2.0 if kind == "h" else (x1 + x2) / 2.0)

        for axis, start, end in cluster_records(records[kind]):
            nearest_axis = min(parallel_axes, key=lambda value: abs(value - axis), default=axis)
            if abs(nearest_axis - axis) <= axis_tolerance_px:
                axis = nearest_axis

            candidate = (
                LineString([(start, axis), (end, axis)])
                if kind == "h"
                else LineString([(axis, start), (axis, end)])
            )

            collinear_overlap = False
            for line in parallel:
                (x1, y1), (x2, y2) = line.coords[0], line.coords[-1]
                ref_axis = (y1 + y2) / 2.0 if kind == "h" else (x1 + x2) / 2.0
                ref_start, ref_end = (
                    sorted((x1, x2)) if kind == "h" else sorted((y1, y2))
                )
                overlap = max(0.0, min(end, ref_end) - max(start, ref_start))
                if abs(axis - ref_axis) <= 8.0 and overlap >= 18.0:
                    collinear_overlap = True
                    break

            endpoints_supported = all(
                min((Point(point).distance(line) for line in perpendicular), default=999.0) <= 11.0
                for point in candidate.coords
            )
            if collinear_overlap or endpoints_supported:
                guides.append(candidate)

    return guides

def draw_vector_debug_image(lines: list[LineString], base_image: np.ndarray) -> np.ndarray:
    """Zeichnet die mathematischen Vektoren als farbige Linien auf ein Kontrollbild und gibt dieses zurück."""
    # Erstelle ein farbiges (BGR) Bild aus der Graustufen-Maske, damit wir bunt zeichnen können
    debug_img = cv2.cvtColor(base_image, cv2.COLOR_GRAY2BGR)

    # Jede Linie in einer zufälligen Farbe zeichnen, damit man sieht, wo ein Segment aufhört
    for line in lines:
        coords = list(line.coords)
        pt1 = (int(coords[0][0]), int(coords[0][1]))
        pt2 = (int(coords[1][0]), int(coords[1][1]))

        # Zufällige Farbe (B, G, R)
        color = tuple(map(int, np.random.randint(50, 255, size=3)))

        # Linie zeichnen (Dicke 2 Pixel)
        cv2.line(debug_img, pt1, pt2, color, 2)
        # Endpunkte extra markieren (kleine Kreise)
        cv2.circle(debug_img, pt1, 3, (0, 0, 255), -1)
        cv2.circle(debug_img, pt2, 3, (0, 0, 255), -1)

    return debug_img

def save_vector_debug_image(step_name: str, lines: list[LineString], base_image: np.ndarray, output_dir: str = "debug_output"):
    """Zeichnet die mathematischen Vektoren auf ein Kontrollbild und speichert es."""
    debug_img = draw_vector_debug_image(lines, base_image)
    filepath = os.path.join(output_dir, f"{step_name}.png")
    cv2.imwrite(filepath, debug_img)
    print(f"[✓] Progress gespeichert: {filepath}")

def clean_topology(lines: list[LineString], snap_tolerance_px: float = 15.0) -> list[LineString]:
    """Schritt 5: Verbindet nahe Ecken, erzwingt rechte Winkel und teilt sich kreuzende Wände."""
    if not lines:
        return []

    # 1. ORTHOGONALITÄT ERZWINGEN (Wände auf exakt 0° oder 90° zwingen)
    aligned_lines = []
    for line in lines:
        x1, y1 = line.coords[0]
        x2, y2 = line.coords[-1]

        dx = abs(x2 - x1)
        dy = abs(y2 - y1)

        # Toleranz: Wenn die Linie fast horizontal ist (weniger als 15% Steigung)
        if dy <= dx * 0.25:
            y_avg = (y1 + y2) / 2.0
            aligned_lines.append(LineString([(x1, y_avg), (x2, y_avg)]))
        # Wenn die Linie fast vertikal ist
        elif dx <= dy * 0.25:
            x_avg = (x1 + x2) / 2.0
            aligned_lines.append(LineString([(x_avg, y1), (x_avg, y2)]))
        else:
            # Diagonale Wände bleiben unangetastet
            aligned_lines.append(line)

    # 2. 1D CLUSTERING (Grid-Snapping - Verhindert "Skewing" / schräge Linien)
    # Sammle alle globalen X- und Y-Koordinaten
    xs, ys = [], []
    for line in aligned_lines:
        xs.extend([p[0] for p in line.coords])
        ys.extend([p[1] for p in line.coords])

    def build_coordinate_grid(coords, tolerance):
        """Fasst nahegelegene Koordinaten zu einem Rasterpunkt zusammen."""
        clusters = []
        for c in sorted(list(set(coords))):
            placed = False
            for cluster in clusters:
                # Vergleiche strikt mit dem ersten Punkt (Anker), um "Chaining" zu verhindern.
                # Dadurch wird die maximale Breite eines Clusters auf 'tolerance' begrenzt.
                if abs(c - cluster[0]) <= tolerance:
                    cluster.append(c)
                    placed = True
                    break
            if not placed:
                clusters.append([c])

        mapping = {}
        for cluster in clusters:
            avg = sum(cluster) / len(cluster)
            for c in cluster:
                mapping[c] = avg
        return mapping

    x_grid = build_coordinate_grid(xs, snap_tolerance_px)
    y_grid = build_coordinate_grid(ys, snap_tolerance_px)

    # 3. LINIEN AUF DAS NEUE GRID ZIEHEN UND VERLÄNGERN
    snapped_lines = []
    EXT = 8.0  # Small extension; larger gaps are handled direction-aware below.
    for line in aligned_lines:
        x1, y1 = line.coords[0]
        x2, y2 = line.coords[-1]

        nx1, ny1 = x_grid[x1], y_grid[y1]
        nx2, ny2 = x_grid[x2], y_grid[y2]

        if nx1 == nx2 and ny1 == ny2:
            continue

        if nx1 == nx2: # vertikal
            if ny1 > ny2: ny1, ny2 = ny2, ny1
            snapped_lines.append(LineString([(nx1, ny1 - EXT), (nx2, ny2 + EXT)]))
        elif ny1 == ny2: # horizontal
            if nx1 > nx2: nx1, nx2 = nx2, nx1
            snapped_lines.append(LineString([(nx1 - EXT, ny1), (nx2 + EXT, ny2)]))
        else:
            snapped_lines.append(LineString([(nx1, ny1), (nx2, ny2)]))

    # 4. UNARY UNION (Schneidet Linien an Ecken und T-Kreuzungen mathematisch sauber auf)
    merged_graph = unary_union(snapped_lines)

    from shapely.geometry import MultiLineString
    from collections import defaultdict

    final_lines = []
    if isinstance(merged_graph, MultiLineString):
        final_lines = list(merged_graph.geoms)
    elif isinstance(merged_graph, LineString):
        final_lines = [merged_graph]

    # 5. DANGLE-REMOVAL (Overshoots abschneiden)
    endpoint_counts = defaultdict(int)
    for line in final_lines:
        endpoint_counts[line.coords[0]] += 1
        endpoint_counts[line.coords[-1]] += 1

    clean_lines = []
    for line in final_lines:
        c1 = line.coords[0]
        c2 = line.coords[-1]
        is_dangle = (endpoint_counts[c1] == 1 or endpoint_counts[c2] == 1)
        
        # Alle überschüssigen Verlängerungen (Overshoots) sind max EXT lang
        if is_dangle and line.length <= EXT + 2.0:
            continue
            
        if line.length > 5.0:
            clean_lines.append(line)

    print(f"[i] Topologie bereinigt (Ortho-Mode): {len(clean_lines)} finale Wandsegmente erstellt.")
    return clean_lines

def connect_loose_ends(lines: list[LineString], max_dist: float = 125.0) -> list[LineString]:
    """Connect facing loose ends and short endpoint-to-wall gaps.

    Door and window symbols can suppress wall masks over relatively long spans,
    so facing collinear ends may bridge up to 125 px.  Unlike the previous
    proximity-only heuristic, every bridge must continue the direction of both
    source segments; T/L junction extensions remain capped at 32 px.
    """
    from shapely.geometry import MultiLineString, LineString
    from collections import defaultdict
    if not lines:
        return []

    endpoint_counts = defaultdict(int)
    for line in lines:
        endpoint_counts[line.coords[0]] += 1
        endpoint_counts[line.coords[-1]] += 1

    loose_ends = [pt for pt, count in endpoint_counts.items() if count == 1]

    endpoint_directions = {}
    for line in lines:
        coords = list(line.coords)
        if len(coords) < 2:
            continue
        for point, neighbour in ((coords[0], coords[1]), (coords[-1], coords[-2])):
            if endpoint_counts[point] != 1:
                continue
            vector = np.asarray(point, dtype=float) - np.asarray(neighbour, dtype=float)
            norm = float(np.linalg.norm(vector))
            if norm > 0:
                endpoint_directions[point] = vector / norm

    connectors = []
    used_loose_ends = set()

    for p1 in loose_ends:
        if p1 in used_loose_ends:
            continue
            
        best_p2 = None
        best_dist = float('inf')
        direction1 = endpoint_directions.get(p1)
        if direction1 is None:
            continue
        
        for p2 in loose_ends:
            if p1 == p2 or p2 in used_loose_ends:
                continue
            
            delta = np.asarray(p2, dtype=float) - np.asarray(p1, dtype=float)
            dist = float(np.linalg.norm(delta))
            if dist == 0 or dist > max_dist or dist >= best_dist:
                continue
            unit = delta / dist
            direction2 = endpoint_directions.get(p2)
            if direction2 is None:
                continue

            # Both line ends must point into the proposed bridge.
            if float(np.dot(direction1, unit)) < 0.82:
                continue
            if float(np.dot(direction2, -unit)) < 0.82:
                continue

            perpendicular_error = abs(float(direction1[0] * delta[1] - direction1[1] * delta[0]))
            if perpendicular_error <= 7.0:
                best_p2 = p2
                best_dist = dist
                    
        if best_p2 is not None:
            final_p2 = best_p2
            if abs(direction1[0]) >= 0.9:
                final_p2 = (best_p2[0], p1[1])
            elif abs(direction1[1]) >= 0.9:
                final_p2 = (p1[0], best_p2[1])

            connectors.append(LineString([p1, final_p2]))
            used_loose_ends.add(p1)
            used_loose_ends.add(best_p2)

    # Extend remaining loose ends onto nearby perpendicular walls.  This
    # repairs T-junctions where the segmentation stops just before the corner.
    for p1 in loose_ends:
        if p1 in used_loose_ends:
            continue
        direction = endpoint_directions.get(p1)
        if direction is None:
            continue
        best_target = None
        # Do not close deliberate façade/setback openings. Mask/vector
        # extensions already cover small cracks, so only short T-junction
        # misses are repaired here.
        best_distance = min(max_dist, 24.0)
        px, py = p1
        horizontal = abs(direction[0]) >= 0.9
        vertical = abs(direction[1]) >= 0.9
        if not horizontal and not vertical:
            continue
        for line in lines:
            coords = list(line.coords)
            x1, y1 = coords[0]
            x2, y2 = coords[-1]
            if p1 in (coords[0], coords[-1]):
                continue
            if horizontal and abs(x1 - x2) < 0.1:
                forward = (x1 - px) * direction[0]
                if 0 < forward <= best_distance and min(y1, y2) - 2 <= py <= max(y1, y2) + 2:
                    best_distance = forward
                    best_target = (x1, py)
            elif vertical and abs(y1 - y2) < 0.1:
                forward = (y1 - py) * direction[1]
                if 0 < forward <= best_distance and min(x1, x2) - 2 <= px <= max(x1, x2) + 2:
                    best_distance = forward
                    best_target = (px, y1)
        if best_target is not None:
            connectors.append(LineString([p1, best_target]))
            used_loose_ends.add(p1)

    if not connectors:
        return lines

    from shapely.ops import unary_union
    all_lines = lines + connectors
    merged = unary_union(all_lines)

    final_lines = []
    if isinstance(merged, MultiLineString):
        final_lines = list(merged.geoms)
    elif isinstance(merged, LineString):
        final_lines = [merged]

    # Winzige Dangles entfernen, die durch das Zusammenfügen entstanden sein könnten
    clean_final = []
    endpoint_counts_final = defaultdict(int)
    for line in final_lines:
        endpoint_counts_final[line.coords[0]] += 1
        endpoint_counts_final[line.coords[-1]] += 1
        
    for line in final_lines:
        c1 = line.coords[0]
        c2 = line.coords[-1]
        is_dangle = (endpoint_counts_final[c1] == 1 or endpoint_counts_final[c2] == 1)
        if is_dangle and line.length < 2.0:
            continue
        clean_final.append(line)

    print(f"[i] Lücken geschlossen (Loose-to-Loose): {len(connectors)} Verbindungen erstellt.")
    return clean_final

def merge_collinear_lines(lines: list[LineString]) -> list[LineString]:
    """Schritt 7: Fasst kollineare Teilsegmente zu einer durchgehenden Wand zusammen."""
    if not lines:
        return []
        
    from collections import defaultdict
    
    horiz_groups = defaultdict(list)
    vert_groups = defaultdict(list)
    diagonals = []
    
    for line in lines:
        x1, y1 = line.coords[0]
        x2, y2 = line.coords[-1]
        
        # Auf 2 Nachkommastellen runden für Gruppierung
        ry1 = round(y1, 2)
        ry2 = round(y2, 2)
        rx1 = round(x1, 2)
        rx2 = round(x2, 2)
        
        # Toleranz für "ist horizontal/vertikal"
        if abs(ry1 - ry2) < 0.1: # horizontal
            y_avg = (y1 + y2) / 2.0
            horiz_groups[round(y_avg, 1)].append((min(x1, x2), max(x1, x2), y_avg))
        elif abs(rx1 - rx2) < 0.1: # vertikal
            x_avg = (x1 + x2) / 2.0
            vert_groups[round(x_avg, 1)].append((min(y1, y2), max(y1, y2), x_avg))
        else:
            diagonals.append(line)
            
    def merge_intervals(intervals):
        if not intervals: return []
        intervals.sort(key=lambda x: x[0])
        merged = [intervals[0]]
        for current in intervals[1:]:
            last = merged[-1]
            # Wenn sie sich berühren oder überlappen (Toleranz 1.0 Pixel)
            if current[0] <= last[1] + 1.0:
                merged[-1] = (last[0], max(last[1], current[1]), last[2])
            else:
                merged.append(current)
        return merged
        
    merged_lines = []
    for _, intervals in horiz_groups.items():
        for start, end, y in merge_intervals(intervals):
            merged_lines.append(LineString([(start, y), (end, y)]))
            
    for _, intervals in vert_groups.items():
        for start, end, x in merge_intervals(intervals):
            merged_lines.append(LineString([(x, start), (x, end)]))
            
    print(f"[i] Kollineare Wände zusammengefasst: Reduziert von {len(lines)} auf {len(merged_lines) + len(diagonals)} Segmente.")
    return merged_lines + diagonals


def coalesce_near_parallel_lines(
    lines: list[LineString],
    axis_tolerance_px: float = 12.0,
    min_overlap_px: float = 8.0,
) -> list[LineString]:
    """Collapse duplicate axes created from thick or wobbly ink strokes.

    A photographed marker line often produces two nearby skeleton branches.
    Treating both branches as walls creates parallel meshes and inconsistent
    rooms.  Two horizontal (or vertical) segments are coalesced only when
    their axes are close *and* their projected intervals overlap materially.
    This keeps unrelated nearby walls and deliberate openings separate.
    """
    if len(lines) < 2:
        return list(lines)

    from collections import defaultdict

    axis_records: dict[str, list[dict]] = {"h": [], "v": []}
    diagonals: list[LineString] = []
    for line in lines:
        x1, y1 = line.coords[0]
        x2, y2 = line.coords[-1]
        if abs(y1 - y2) <= 0.5:
            axis_records["h"].append({
                "axis": (y1 + y2) / 2.0,
                "start": min(x1, x2),
                "end": max(x1, x2),
            })
        elif abs(x1 - x2) <= 0.5:
            axis_records["v"].append({
                "axis": (x1 + x2) / 2.0,
                "start": min(y1, y2),
                "end": max(y1, y2),
            })
        else:
            diagonals.append(line)

    output: list[LineString] = []
    for orientation, records in axis_records.items():
        if not records:
            continue

        parent = list(range(len(records)))

        def find(index: int) -> int:
            while parent[index] != index:
                parent[index] = parent[parent[index]]
                index = parent[index]
            return index

        def union(left: int, right: int) -> None:
            root_left, root_right = find(left), find(right)
            if root_left != root_right:
                parent[root_right] = root_left

        for left in range(len(records)):
            a = records[left]
            for right in range(left + 1, len(records)):
                b = records[right]
                if abs(a["axis"] - b["axis"]) > axis_tolerance_px:
                    continue
                overlap = min(a["end"], b["end"]) - max(a["start"], b["start"])
                required = max(min_overlap_px, 0.18 * min(a["end"] - a["start"], b["end"] - b["start"]))
                if overlap >= required:
                    union(left, right)

        groups: dict[int, list[dict]] = defaultdict(list)
        for index, record in enumerate(records):
            groups[find(index)].append(record)

        for group in groups.values():
            total_length = sum(max(1.0, item["end"] - item["start"]) for item in group)
            axis = sum(
                item["axis"] * max(1.0, item["end"] - item["start"])
                for item in group
            ) / total_length

            intervals = sorted((item["start"], item["end"]) for item in group)
            merged_intervals = [intervals[0]]
            for start, end in intervals[1:]:
                previous_start, previous_end = merged_intervals[-1]
                if start <= previous_end + 2.0:
                    merged_intervals[-1] = (previous_start, max(previous_end, end))
                else:
                    merged_intervals.append((start, end))

            for start, end in merged_intervals:
                if orientation == "h":
                    output.append(LineString([(start, axis), (end, axis)]))
                else:
                    output.append(LineString([(axis, start), (axis, end)]))

    result = output + diagonals
    print(f"[i] Nahe Doppelachsen entfernt: Reduziert von {len(lines)} auf {len(result)} Segmente.")
    return result

"""Schritt 8: Wandelt unsere Python-Objekte in sauberes BIM-fertiges JSON um."""
def generate_json_dict(walls: list[WallElement], image_height: int) -> dict:
    """Wandelt unsere Python-Objekte in ein Dictionary (BIM-fertiges JSON Format) um."""
    data = {"walls": []}

    for wall in walls:
        coords = list(wall.geometry.coords)

        start_pt = {"x": round(coords[0][0], 2), "y": round(coords[0][1], 2)}
        end_pt = {"x": round(coords[-1][0], 2), "y": round(coords[-1][1], 2)}

        data["walls"].append({
            "id": wall.id,
            "start": start_pt,
            "end": end_pt,
            "thickness": round(wall.thickness_px, 2),
            "windows": [],
            "doors": []
        })
    return data

def export_to_json(walls: list[WallElement], output_filepath: str, image_height: int):
    """Schritt 7: Speichert das Dictionary als JSON-Datei."""
    data = generate_json_dict(walls, image_height)

    with open(output_filepath, 'w') as f:
        json.dump(data, f, indent=4)
