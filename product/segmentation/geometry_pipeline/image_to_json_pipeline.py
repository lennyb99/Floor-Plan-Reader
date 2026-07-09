import cv2
import numpy as np
import os
from shapely.geometry import LineString
from dataclasses import dataclass
from skimage.morphology import skeletonize
import json
from shapely.ops import unary_union, snap
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
    """Schritt 1: Morphologische Bereinigung der KI-Maske."""
    # Ein 5x5 Pixel Kernel (unsere "Bürste" für die Bereinigung)
    kernel = np.ones((5, 5), np.uint8)

    # 1. Closing: Füllt kleine schwarze Löcher IN den weißen Wänden
    closed = cv2.morphologyEx(raw_mask, cv2.MORPH_CLOSE, kernel)

    # 2. Opening: Entfernt kleine weiße Pixel-Inseln (False Positives) außerhalb
    cleaned = cv2.morphologyEx(closed, cv2.MORPH_OPEN, kernel)

    return cleaned

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
    min_line_length = 20  # Minimale Länge einer Wand in Pixeln (kürzere Linien werden ignoriert)
    max_line_gap = 10     # Maximale Lücke zwischen Pixeln, die noch als *selbe* Linie gezählt wird

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
        if dy <= dx * 0.15:
            y_avg = (y1 + y2) / 2.0
            aligned_lines.append(LineString([(x1, y_avg), (x2, y_avg)]))
        # Wenn die Linie fast vertikal ist
        elif dx <= dy * 0.15:
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
                cluster_avg = sum(cluster) / len(cluster)
                if abs(c - cluster_avg) <= tolerance:
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

    # 3. LINIEN AUF DAS NEUE GRID ZIEHEN
    snapped_lines = []
    for line in aligned_lines:
        new_coords = [(x_grid[x], y_grid[y]) for x, y in line.coords]

        # Nur hinzufügen, wenn die Linie nicht zu einem einzigen Punkt kollabiert ist
        if new_coords[0] != new_coords[-1]:
            snapped_lines.append(LineString(new_coords))

    # 4. UNARY UNION (Schneidet Linien an Ecken und T-Kreuzungen mathematisch sauber auf)
    merged_graph = unary_union(snapped_lines)

    from shapely.geometry import MultiLineString
    final_lines = []
    if isinstance(merged_graph, MultiLineString):
        final_lines = list(merged_graph.geoms)
    elif isinstance(merged_graph, LineString):
        final_lines = [merged_graph]

    # Artefakte (Punkte oder winzige Schnipsel unter 5 Pixel) rausfiltern
    clean_lines = [line for line in final_lines if line.length > 5.0]

    print(f"[i] Topologie bereinigt (Ortho-Mode): {len(clean_lines)} finale Wandsegmente erstellt.")
    return clean_lines

"""Schritt 7: Wandelt unsere Python-Objekte in sauberes BIM-fertiges JSON um."""
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

