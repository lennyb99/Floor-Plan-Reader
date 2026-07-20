"""
server.py – FastAPI backend for the floorplan pipeline.

Endpoints
─────────
POST /preprocess Fast 512 px preparation preview (no model inference)
POST /analyze   Full pipeline: UNet (walls) + YOLO (objects) → merged JSON for revise.html
POST /detect    YOLO only (kept for backwards compat / debugging)
POST /segment   UNet only  (kept for backwards compat / debugging)
"""

from fastapi import FastAPI, File, Form, UploadFile, HTTPException
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import RedirectResponse
from ultralytics import YOLO
from PIL import Image, ImageOps
import io
import numpy as np
import base64
import torch

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
from product.segmentation.preprocessing import DEFAULT_GAMMA, TARGET_SIZE, preprocess_floorplan
from product.backend.model_config import (
    DEFAULT_UNET,
    DEFAULT_YOLO,
    UNET_PROFILES,
    YOLO_PROFILES,
    public_profiles,
)

from product.backend.objectsToWalls import merge as merge_detections_onto_walls
from product.backend.detection_ensemble import detect_stair_candidate, merge_detection_sets

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

BACKEND_DIR = Path(__file__).resolve().parent
WEIGHTS_DIR = BACKEND_DIR / "weights"
FRONTEND_DIR = BACKEND_DIR / "frontend"

# The public image and every returned coordinate stay at 512 px. A small
# detector-only test-time upscale recovers fine furniture strokes without
# changing that coordinate space (Ultralytics maps boxes back to the source).
YOLO_INFERENCE_SIZE = 544

# All available YOLO weight files (must exist in weights/)
YOLO_MODELS = list(YOLO_PROFILES)

# All available UNet weight files (must exist in weights/)
UNET_MODELS = list(UNET_PROFILES)

# ─────────────────────────────────────────────
#  MODEL LOADING  (hot-swappable via /active-models)
# ─────────────────────────────────────────────
def select_device() -> torch.device:
    requested = os.getenv("FPR_DEVICE")
    if requested:
        return torch.device(requested)
    if torch.cuda.is_available():
        return torch.device("cuda")
    if torch.backends.mps.is_available():
        return torch.device("mps")
    return torch.device("cpu")


device = select_device()
print(f"--> Inference device: {device}")

# Active model state — swapped at runtime without restarting the server
models = {
    "yolo":      None,
    "yolo_production": None,
    "yolo_fallback": None,
    "unet":      None,
    "unet_production": None,
    "yolo_file": None,
    "unet_file": None,
}


def _validated_weight(filename: str, registry: list[str]) -> Path:
    if filename not in registry:
        raise ValueError(f"Unknown weight file: {filename}")
    path = WEIGHTS_DIR / filename
    if not path.is_file():
        raise FileNotFoundError(f"Weight file not found: {path}")
    return path


def load_yolo(filename: str) -> Optional[object]:
    try:
        path = _validated_weight(filename, YOLO_MODELS)
        m = YOLO(str(path))
        print(f"--> YOLO loaded: {path}")
        return m
    except Exception as e:
        print(f"--> YOLO load failed ({path}): {e}")
        return None


def load_unet(filename: str) -> Optional[object]:
    try:
        path = _validated_weight(filename, UNET_MODELS)
        m = load_segmentation_model(str(path), device=device)
        print(f"--> UNet loaded: {path}")
        return m
    except Exception as e:
        print(f"--> UNet load failed ({filename}): {e}")
        return None


# ── Load defaults on startup ──────────────────────────────────────────────────
models["yolo"]      = load_yolo(DEFAULT_YOLO)
models["yolo_file"] = DEFAULT_YOLO
models["yolo_production"] = models["yolo"]

# The real-photo and hand-drawn datasets are complementary: the real model is
# stronger on beds/stairs while the hand-drawn model recovers sanitary symbols
# and openings.  Keep the secondary detector resident to avoid a second load
# during every request.
YOLO_FALLBACK = "yolo_cc_Handdrawn1.pt"
models["yolo_fallback"] = load_yolo(YOLO_FALLBACK)

models["unet"]      = load_unet(DEFAULT_UNET)
models["unet_file"] = DEFAULT_UNET
models["unet_production"] = models["unet"]


# ─────────────────────────────────────────────
#  SHARED HELPERS
# ─────────────────────────────────────────────

def _predict_yolo(model: object, img_rgb: Image.Image | np.ndarray, confidence: float) -> list[dict]:
    """Run one YOLO model and return normalized detections."""
    if model is None:
        raise RuntimeError("YOLO model is not loaded.")
    source = np.asarray(img_rgb)
    results = model.predict(
        source=source,
        conf=float(np.clip(confidence, 0.05, 0.95)),
        iou=0.55,
        imgsz=YOLO_INFERENCE_SIZE,
        device=str(device),
        verbose=False,
    )
    boxes   = results[0].boxes
    detections = []
    for box in boxes:
        xyxy = box.xyxy[0].tolist()
        if (xyxy[2] - xyxy[0]) * (xyxy[3] - xyxy[1]) < 80:
            continue
        detections.append({
            "name":       model.names[int(box.cls[0])],
            "confidence": round(float(box.conf[0]), 2),
            "bbox": {
                "xmin": round(xyxy[0], 1),
                "ymin": round(xyxy[1], 1),
                "xmax": round(xyxy[2], 1),
                "ymax": round(xyxy[3], 1),
            },
        })
    return detections


def run_yolo(
    img_rgb: Image.Image | np.ndarray,
    confidence: float = 0.25,
    use_ensemble: bool = False,
) -> dict:
    """Run the selected detector, optionally fused with the sketch fallback."""
    confidence = float(np.clip(confidence, 0.05, 0.95))
    primary_model = models["yolo_production"] if use_ensemble else models["yolo"]
    detections = _predict_yolo(primary_model, img_rgb, confidence)
    if use_ensemble and models["yolo_fallback"] is not None:
        fallback = _predict_yolo(models["yolo_fallback"], img_rgb, min(confidence, 0.30))
        detections = merge_detection_sets(detections, fallback, confidence)
        detections.extend(detect_stair_candidate(np.asarray(img_rgb), detections))
    return {"detections": detections}


def _read_image(raw_bytes: bytes) -> np.ndarray:
    if len(raw_bytes) > 20 * 1024 * 1024:
        raise HTTPException(status_code=413, detail="Image exceeds the 20 MB upload limit.")
    try:
        image = Image.open(io.BytesIO(raw_bytes))
        image = ImageOps.exif_transpose(image).convert("RGB")
        return np.asarray(image)
    except Exception as exc:
        raise HTTPException(status_code=400, detail=f"Invalid image: {exc}") from exc


def _encode_png(image: np.ndarray) -> str:
    pil_image = Image.fromarray(image)
    buffer = io.BytesIO()
    pil_image.save(buffer, format="PNG", optimize=True)
    return base64.b64encode(buffer.getvalue()).decode("utf-8")


def _active_unet_profile() -> dict:
    return UNET_PROFILES[models["unet_file"]]


# (run_unet and unet_mask_to_wall_dict have been replaced by the central pipeline)


# ─────────────────────────────────────────────
#  ENDPOINTS
# ─────────────────────────────────────────────

@app.post("/preprocess")
async def preview_preprocessing(
    file: UploadFile = File(...),
    gamma: float = Form(DEFAULT_GAMMA),
    auto_crop: bool = Form(True),
):
    """Return the exact 512 px model input without running U-Net or YOLO."""
    raw_bytes = await file.read()
    prepared = preprocess_floorplan(
        _read_image(raw_bytes),
        gamma=gamma,
        auto_crop=auto_crop,
    )
    return {
        "preview_image_base64": _encode_png(prepared.image_rgb),
        "metadata": prepared.metadata.to_dict(),
    }


@app.post("/analyze")
async def analyze(
    file: UploadFile = File(...),
    gamma: float = Form(DEFAULT_GAMMA),
    auto_crop: bool = Form(True),
    detection_confidence: float = Form(0.30),
):
    """
    Full pipeline: UNet → walls + YOLO → detections → merged JSON.
    This is the endpoint analyze.html calls.
    Returns { walls: [...] } ready for revise.html.
    """
    if models["yolo"] is None or models["unet"] is None:
        raise HTTPException(status_code=503, detail="One or both models failed to load. Check server logs.")

    raw_bytes = await file.read()
    original = _read_image(raw_bytes)
    prepared = preprocess_floorplan(original, gamma=gamma, auto_crop=auto_crop)
    profile = UNET_PROFILES[DEFAULT_UNET]

    # Run both models
    yolo_result = run_yolo(
        prepared.image_rgb,
        confidence=detection_confidence,
        use_ensemble=True,
    )
    
    # Run full segmentation pipeline (creates mask and extracts walls)
    wall_dict = run_full_segmentation_pipeline(
        image_source=prepared.image_rgb,
        model=models["unet_production"],
        device=device,
        threshold=profile["threshold"],
        low_threshold=profile["low_threshold"],
        invert_output=profile["invert_output"],
    )

    # Merge YOLO detections onto walls
    merged = merge_detections_onto_walls(wall_dict, yolo_result)
    merged["metadata"] = {
        "preprocessing": prepared.metadata.to_dict(),
        "models": {
            "yolo": models["yolo_file"],
            "yolo_fallback": YOLO_FALLBACK,
            "unet": DEFAULT_UNET,
        },
        "detection_confidence": round(float(np.clip(detection_confidence, 0.05, 0.95)), 2),
        "coordinate_space": "preprocessed_512px",
    }
    merged["preview_image_base64"] = _encode_png(prepared.image_rgb)

    return merged


@app.post("/detect")
async def detect_objects(file: UploadFile = File(...)):
    """YOLO only — returns raw detections. Kept for debugging."""
    raw_bytes = await file.read()
    prepared = preprocess_floorplan(_read_image(raw_bytes))
    return run_yolo(prepared.image_rgb)


@app.post("/segment")
async def segment_image(file: UploadFile = File(...)):
    """UNet only — returns base64 PNG mask. Kept for debugging."""
    if models["unet"] is None:
        raise HTTPException(status_code=503, detail="UNet model is not loaded.")

    raw_bytes  = await file.read()
    prepared = preprocess_floorplan(_read_image(raw_bytes))
    profile = _active_unet_profile()
    
    # predict_mask works directly with numpy arrays
    mask_array = predict_mask(
        models["unet"], prepared.image_rgb, device=device,
        threshold=profile["threshold"],
        low_threshold=profile["low_threshold"],
        invert_output=profile["invert_output"],
    )

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
    prepared = preprocess_floorplan(_read_image(raw_bytes))
    img = Image.fromarray(prepared.image_rgb)
    img_array = prepared.image_rgb
    profile = _active_unet_profile()
    
    mask = predict_mask(
        models["unet"], img_array, device=device, return_probs=False,
        threshold=profile["threshold"],
        low_threshold=profile["low_threshold"],
        invert_output=profile["invert_output"],
    )
    if isinstance(mask, tuple):
        mask = mask[0]
        
    from product.segmentation.geometry_pipeline.pipeline_runner import process_image as geometry_process_image
    
    json_dict, debug_images = geometry_process_image(
        mask, guide_image=img_array, return_debug_images=True,
    )
    
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
        "04a_ink_guides": "5b. Structural Ink Guides",
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
    prepared = preprocess_floorplan(_read_image(raw_bytes))
    img = Image.fromarray(prepared.image_rgb)

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
        "production_pair": {"yolo": DEFAULT_YOLO, "unet": DEFAULT_UNET},
        "ensemble_fallback": YOLO_FALLBACK if models["yolo_fallback"] is not None else None,
        "yolo_profiles": public_profiles(YOLO_PROFILES),
        "unet_profiles": public_profiles(UNET_PROFILES),
        "device": str(device),
        "preprocessing": {"size": TARGET_SIZE, "default_gamma": DEFAULT_GAMMA},
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
@app.get("/", include_in_schema=False)
async def frontend_home():
    return RedirectResponse(url="/analyze.html")


@app.get("/health")
async def health():
    return {
        "status": "ok" if models["yolo"] is not None and models["unet"] is not None else "degraded",
        "device": str(device),
        "models": {"yolo": models["yolo_file"], "unet": models["unet_file"]},
    }


app.mount("/", StaticFiles(directory=str(FRONTEND_DIR), html=True), name="frontend")

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)
