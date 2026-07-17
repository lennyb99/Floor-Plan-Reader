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

# ---------------------------------------------------------------------------
# Add the project root to sys.path so we can import from the 'product' module
# ---------------------------------------------------------------------------
import sys
import os
_PROJECT_ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", ".."))
if _PROJECT_ROOT not in sys.path:
    sys.path.insert(0, _PROJECT_ROOT)

from product.segmentation.segmentation import run_full_segmentation_pipeline
from product.segmentation.inference import load_segmentation_model, predict_mask

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
#  MODEL REGISTRY  ← edit these lists to add / remove models
# ─────────────────────────────────────────────
from pathlib import Path
from typing import Optional

WEIGHTS_DIR = Path("weights")

# All available YOLO weight files (must exist in weights/)
YOLO_MODELS = [
    "yolo_cc_1.pt",
    "yolo_cc_Handdrawn1.pt",
    "yolo_cc_Sketch1.pt",
    "yolo_real1.pt",
]

# All available UNet weight files (must exist in weights/)
UNET_MODELS = [
    "finalunet.pt",
    "uNetWeights.pt",
    "unet_FullCubicasa.pt",
    "unet_final_onlymax.pt",
]

# Which file to load on startup (index into the lists above)
DEFAULT_YOLO = YOLO_MODELS[0]
DEFAULT_UNET = UNET_MODELS[0]

# ─────────────────────────────────────────────
#  MODEL LOADING  (hot-swappable via /active-models)
# ─────────────────────────────────────────────
device = torch.device("cuda" if torch.cuda.is_available() else "cpu")

# Active model state — swapped at runtime without restarting the server
models = {
    "yolo":      None,
    "unet":      None,
    "yolo_file": None,
    "unet_file": None,
}


def load_yolo(filename: str) -> Optional[object]:
    path = WEIGHTS_DIR / filename
    try:
        m = YOLO(str(path))
        print(f"--> YOLO loaded: {path}")
        return m
    except Exception as e:
        print(f"--> YOLO load failed ({path}): {e}")
        return None


def load_unet(filename: str) -> Optional[object]:
    try:
        path = WEIGHTS_DIR / filename
        m = load_segmentation_model(str(path), device=device)
        print(f"--> UNet loaded: {path}")
        return m
    except Exception as e:
        print(f"--> UNet load failed ({filename}): {e}")
        return None


# ── Load defaults on startup ──────────────────────────────────────────────────
models["yolo"]      = load_yolo(DEFAULT_YOLO)
models["yolo_file"] = DEFAULT_YOLO

models["unet"]      = load_unet(DEFAULT_UNET)
models["unet_file"] = DEFAULT_UNET


# ─────────────────────────────────────────────
#  SHARED HELPERS
# ─────────────────────────────────────────────

def run_yolo(img_rgb: Image.Image) -> dict:
    """Run YOLO on a PIL RGB image → { detections: [...] }"""
    if models["yolo"] is None:
        raise RuntimeError("YOLO model is not loaded.")
    results = models["yolo"].predict(source=np.array(img_rgb), conf=0.25)
    boxes   = results[0].boxes
    detections = []
    for box in boxes:
        xyxy = box.xyxy[0].tolist()
        detections.append({
            "name":       models["yolo"].names[int(box.cls[0])],
            "confidence": round(float(box.conf[0]), 2),
            "bbox": {
                "xmin": round(xyxy[0], 1),
                "ymin": round(xyxy[1], 1),
                "xmax": round(xyxy[2], 1),
                "ymax": round(xyxy[3], 1),
            },
        })
    return {"detections": detections}


# (run_unet and unet_mask_to_wall_dict have been replaced by the central pipeline)


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
    if models["yolo"] is None or models["unet"] is None:
        raise HTTPException(status_code=503, detail="One or both models failed to load. Check server logs.")

    raw_bytes = await file.read()
    img       = Image.open(io.BytesIO(raw_bytes)).convert("RGB")

    # Run both models
    yolo_result = run_yolo(img)
    
    # Run full segmentation pipeline (creates mask and extracts walls)
    img_array = np.array(img)
    wall_dict = run_full_segmentation_pipeline(
        image_source=img_array,
        model=models["unet"],
        device=device
    )

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
    if models["unet"] is None:
        raise HTTPException(status_code=503, detail="UNet model is not loaded.")

    raw_bytes  = await file.read()
    img        = Image.open(io.BytesIO(raw_bytes)).convert("RGB")
    
    # predict_mask works directly with numpy arrays
    mask_array = predict_mask(models["unet"], np.array(img), device=device)

    mask_img = Image.fromarray(mask_array)
    buf      = io.BytesIO()
    mask_img.save(buf, format="PNG")
    return {"mask_base64": base64.b64encode(buf.getvalue()).decode("utf-8")}


@app.post("/unet-debug")
async def unet_debug(file: UploadFile = File(...)):
    """UNet + Geometry Pipeline debugging endpoint. Returns base64 images of all intermediate steps."""
    if models["unet"] is None:
        raise HTTPException(status_code=503, detail="UNet model is not loaded.")

    raw_bytes = await file.read()
    img = Image.open(io.BytesIO(raw_bytes)).convert("RGB")
    img_array = np.array(img)
    
    mask = predict_mask(models["unet"], img_array, device=device, return_probs=False)
    if isinstance(mask, tuple):
        mask = mask[0]
        
    from product.segmentation.geometry_pipeline.pipeline_runner import process_image as geometry_process_image
    
    json_dict, debug_images = geometry_process_image(mask, return_debug_images=True)
    
    def encode_np(arr):
        pil_img = Image.fromarray(arr)
        buf = io.BytesIO()
        pil_img.save(buf, format="PNG")
        return base64.b64encode(buf.getvalue()).decode("utf-8")
        
    encoded_steps = []
    
    # 1. Original image
    buf_orig = io.BytesIO()
    img.save(buf_orig, format="PNG")
    encoded_steps.append({
        "name": "original",
        "title": "Original Image",
        "image_b64": base64.b64encode(buf_orig.getvalue()).decode("utf-8")
    })
    
    # 2. Pipeline steps
    titles = {
        "00_raw_input": "1. Raw UNet Mask",
        "01_cleaned_mask": "2. Cleaned Mask",
        "02_distance_map": "3. Distance Map",
        "03_skeleton_mask": "4. Skeletonization",
        "04_raw_vectors": "5. Hough Vectors",
        "05_clean_topology": "6. Snapped Topology",
        "06_connect_loose_ends": "7. Connected Loose Ends",
        "07_merged_lines": "8. Merged Continuous Lines"
    }
    
    # Ensure they are added in sorted order
    for name in sorted(debug_images.keys()):
        arr = debug_images[name]
        encoded_steps.append({
            "name": name,
            "title": titles.get(name, name),
            "image_b64": encode_np(arr)
        })
        
    return {
        "steps": encoded_steps,
        "json_data": json_dict
    }


@app.post("/yolo")
async def yolo_visualize(file: UploadFile = File(...)):
    """YOLO detection with bounding boxes drawn onto the image → base64 PNG.
    Used by detect.html to visualise what the model sees."""
    raw_bytes = await file.read()
    img       = Image.open(io.BytesIO(raw_bytes)).convert("RGB")

    yolo_result = run_yolo(img)

    # Draw boxes onto the image with PIL
    from PIL import ImageDraw, ImageFont
    draw   = ImageDraw.Draw(img)
    width  = img.width

    # Colour palette — one per class name for consistency
    palette = {}
    def class_color(name):
        if name not in palette:
            import hashlib
            h = int(hashlib.md5(name.encode()).hexdigest()[:6], 16)
            r = (h >> 16) & 0xFF
            g = (h >> 8)  & 0xFF
            b =  h        & 0xFF
            # Brighten so colours are visible on dark images
            palette[name] = (max(r, 120), max(g, 120), max(b, 120))
        return palette[name]

    lw = max(2, width // 300)   # line width scales with image size
    fs = max(12, width // 60)   # font size scales too

    for det in yolo_result["detections"]:
        b     = det["bbox"]
        color = class_color(det["name"])
        label = f"{det['name']}  {int(det['confidence']*100)}%"

        # Box
        draw.rectangle([b["xmin"], b["ymin"], b["xmax"], b["ymax"]],
                        outline=color, width=lw)

        # Label background pill
        try:
            font = ImageFont.truetype("arial.ttf", fs)
        except Exception:
            font = ImageFont.load_default()

        bbox_text = draw.textbbox((b["xmin"], b["ymin"]), label, font=font)
        tw = bbox_text[2] - bbox_text[0]
        th = bbox_text[3] - bbox_text[1]
        pad = 3
        ty  = max(0, b["ymin"] - th - pad * 2)
        draw.rectangle([b["xmin"], ty, b["xmin"] + tw + pad * 2, ty + th + pad * 2],
                        fill=color)
        draw.text((b["xmin"] + pad, ty + pad), label, fill=(0, 0, 0), font=font)

    buf = io.BytesIO()
    img.save(buf, format="PNG")
    return {
        "image_b64":  base64.b64encode(buf.getvalue()).decode("utf-8"),
        "detections": yolo_result["detections"],
    }


# ─────────────────────────────────────────────
#  MODEL MANAGEMENT ENDPOINTS
# ─────────────────────────────────────────────

@app.get("/models")
async def get_models():
    """Return the registered model lists and which are currently active."""
    return {
        "yolo_models": YOLO_MODELS,
        "unet_models": UNET_MODELS,
        "active_yolo": models["yolo_file"],
        "active_unet": models["unet_file"],
    }


@app.post("/active-models")
async def set_active_models(body: dict):
    """
    Hot-swap YOLO and/or UNet model.
    Body: { "yolo": "filename.pt", "unet": "filename.pt" }
    Either key is optional — omit to leave that model unchanged.
    """
    changed = []

    if "yolo" in body and body["yolo"] != models["yolo_file"]:
        m = load_yolo(body["yolo"])
        if m is None:
            raise HTTPException(status_code=400, detail=f"Failed to load YOLO: {body['yolo']}")
        models["yolo"]      = m
        models["yolo_file"] = body["yolo"]
        changed.append(f"YOLO → {body['yolo']}")

    if "unet" in body and body["unet"] != models["unet_file"]:
        m = load_unet(body["unet"])
        if m is None:
            raise HTTPException(status_code=400, detail=f"Failed to load UNet: {body['unet']}")
        models["unet"]      = m
        models["unet_file"] = body["unet"]
        changed.append(f"UNet → {body['unet']}")

    return {
        "changed":     changed,
        "active_yolo": models["yolo_file"],
        "active_unet": models["unet_file"],
    }


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