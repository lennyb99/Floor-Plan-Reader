"""
server.py – FastAPI backend for the floorplan pipeline.

Endpoints
─────────
POST /analyze   Full pipeline: UNet (walls) + YOLO (objects) → merged JSON for revise.html
POST /detect    YOLO only (kept for backwards compat / debugging)
POST /segment   UNet only  (kept for backwards compat / debugging)
"""

from fastapi import FastAPI, File, UploadFile, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from ultralytics import YOLO
from PIL import Image
import io
import numpy as np
import base64
import torch
import torchvision.transforms as transforms

# Pipeline helpers (same folder)
from image_to_json_pipeline import (
    WallElement,
    clean_wall_mask,
    compute_thickness_map,
    extract_skeleton,
    vectorize_skeleton,
    clean_topology,
    export_to_json,
)
from objectsToWalls import merge as merge_detections_onto_walls

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ─────────────────────────────────────────────
#  MODEL LOADING
# ─────────────────────────────────────────────
YOLO_WEIGHTS = "weights/yoloWeights.pt"
UNET_WEIGHTS = "weights/uNetWeights.pt"
device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

try:
    yolo_model = YOLO(YOLO_WEIGHTS)
    print(f"--> YOLO loaded: {YOLO_WEIGHTS}")
except Exception as e:
    yolo_model = None
    print(f"--> YOLO load failed: {e}")

try:
    import segmentation_models_pytorch as smp
    unet_model = smp.Unet(
        encoder_name="resnet34",
        encoder_weights=None,
        in_channels=1,
        classes=1,
    )
    unet_model.load_state_dict(torch.load(UNET_WEIGHTS, map_location=device))
    unet_model.to(device)
    unet_model.eval()
    print(f"--> UNet loaded: {UNET_WEIGHTS}")
except ModuleNotFoundError:
    unet_model = None
    print("[!] segmentation-models-pytorch not installed. Run: pip install segmentation-models-pytorch")
except Exception as e:
    unet_model = None
    print(f"--> UNet load failed: {e}")


# ─────────────────────────────────────────────
#  SHARED HELPERS
# ─────────────────────────────────────────────

def run_yolo(img_rgb: Image.Image) -> dict:
    """Run YOLO on a PIL RGB image → { detections: [...] }"""
    if yolo_model is None:
        raise RuntimeError("YOLO model is not loaded.")
    results = yolo_model.predict(source=np.array(img_rgb), conf=0.25)
    boxes   = results[0].boxes
    detections = []
    for box in boxes:
        xyxy = box.xyxy[0].tolist()
        detections.append({
            "name":       yolo_model.names[int(box.cls[0])],
            "confidence": round(float(box.conf[0]), 2),
            "bbox": {
                "xmin": round(xyxy[0], 1),
                "ymin": round(xyxy[1], 1),
                "xmax": round(xyxy[2], 1),
                "ymax": round(xyxy[3], 1),
            },
        })
    return {"detections": detections}


def run_unet(img_rgb: Image.Image) -> np.ndarray:
    """Run UNet on a PIL RGB image → binary mask array (uint8, 0/255, original size)."""
    if unet_model is None:
        raise RuntimeError("UNet model is not loaded.")

    original_size = img_rgb.size  # (width, height)

    transform = transforms.Compose([
        transforms.Resize((512, 512)),
        transforms.Grayscale(num_output_channels=1),
        transforms.ToTensor(),
    ])
    tensor = transform(img_rgb).unsqueeze(0).to(device)

    with torch.no_grad():
        output = unet_model(tensor)

    if output.shape[1] == 1:
        preds      = torch.sigmoid(output)
        preds      = (preds > 0.5).float().squeeze().cpu().numpy()
        mask_array = (preds * 255).astype(np.uint8)
        # ── Inversion control ────────────────────────────────────────────────
        # Walls should be WHITE (255) on a BLACK background.
        # If your mask comes out inverted (black walls), comment this line out.
        mask_array = 255 - mask_array
        # ─────────────────────────────────────────────────────────────────────
    else:
        preds      = torch.argmax(output, dim=1).squeeze().cpu().numpy()
        num_classes = output.shape[1]
        mask_array = (preds * (255 // (num_classes - 1))).astype(np.uint8)

    # Resize mask back to original image dimensions
    mask_img = Image.fromarray(mask_array).resize(original_size, resample=Image.NEAREST)
    return np.array(mask_img)


def unet_mask_to_wall_dict(mask_array: np.ndarray) -> dict:
    """Run the geometry pipeline on a binary mask array → { walls: [...] }"""
    # Threshold to strict binary (handles any interpolation artefacts from resize)
    _, binary = __import__("cv2").threshold(mask_array, 0, 255, __import__("cv2").THRESH_BINARY)

    clean_mask   = clean_wall_mask(binary)
    distance_map = compute_thickness_map(clean_mask)
    skeleton     = extract_skeleton(clean_mask)
    raw_lines    = vectorize_skeleton(skeleton)
    clean_lines  = clean_topology(raw_lines, snap_tolerance_px=15.0)

    img_height = mask_array.shape[0]
    walls: list[WallElement] = []
    for idx, line in enumerate(clean_lines):
        coords   = list(line.coords)
        mid_x    = (coords[0][0] + coords[-1][0]) / 2.0
        mid_y    = (coords[0][1] + coords[-1][1]) / 2.0
        px, py   = int(np.clip(mid_x, 0, distance_map.shape[1]-1)), \
                   int(np.clip(mid_y, 0, distance_map.shape[0]-1))
        thickness = float(distance_map[py, px]) * 2.0
        walls.append(WallElement(id=f"wall_{idx:04d}", geometry=line, thickness_px=thickness))

    # Build dict directly (same as export_to_json but in-memory, no file write)
    wall_list = []
    for wall in walls:
        coords  = list(wall.geometry.coords)
        start_y = img_height - coords[0][1]
        end_y   = img_height - coords[-1][1]
        wall_list.append({
            "id":        wall.id,
            "start":     {"x": round(coords[0][0], 2), "y": round(start_y, 2)},
            "end":       {"x": round(coords[-1][0], 2), "y": round(end_y,   2)},
            "thickness": round(wall.thickness_px, 2),
            "windows":   [],
            "doors":     [],
        })

    return {"walls": wall_list}


# ─────────────────────────────────────────────
#  ENDPOINTS
# ─────────────────────────────────────────────

@app.post("/analyze")
async def analyze(file: UploadFile = File(...)):
    """
    Full pipeline: UNet → walls + YOLO → detections → merged JSON.
    This is the endpoint analyze.html calls.
    Returns { walls: [...] } ready for revise.html.
    """
    if yolo_model is None or unet_model is None:
        raise HTTPException(status_code=503, detail="One or both models failed to load. Check server logs.")

    raw_bytes = await file.read()
    img       = Image.open(io.BytesIO(raw_bytes)).convert("RGB")

    # Run both models
    yolo_result = run_yolo(img)
    mask_array  = run_unet(img)

    # UNet mask → wall geometry dict
    wall_dict = unet_mask_to_wall_dict(mask_array)

    # Merge YOLO detections onto walls
    merged = merge_detections_onto_walls(wall_dict, yolo_result)

    return merged


@app.post("/detect")
async def detect_objects(file: UploadFile = File(...)):
    """YOLO only — returns raw detections. Kept for debugging."""
    raw_bytes = await file.read()
    img       = Image.open(io.BytesIO(raw_bytes)).convert("RGB")
    return run_yolo(img)


@app.post("/segment")
async def segment_image(file: UploadFile = File(...)):
    """UNet only — returns base64 PNG mask. Kept for debugging."""
    if unet_model is None:
        raise HTTPException(status_code=503, detail="UNet model is not loaded.")

    raw_bytes  = await file.read()
    img        = Image.open(io.BytesIO(raw_bytes)).convert("RGB")
    mask_array = run_unet(img)

    mask_img = Image.fromarray(mask_array)
    buf      = io.BytesIO()
    mask_img.save(buf, format="PNG")
    return {"mask_base64": base64.b64encode(buf.getvalue()).decode("utf-8")}


# ─────────────────────────────────────────────
#  STATIC FRONTEND
# ─────────────────────────────────────────────
# Serve analyze.html + revise.html from a "frontend" folder next to server.py.
# This makes localStorage work across pages (file:// blocks it).
# Open: http://127.0.0.1:8000/
# All API routes above are registered first so they take priority over the static catch-all.
app.mount("/", StaticFiles(directory="frontend", html=True), name="frontend")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)