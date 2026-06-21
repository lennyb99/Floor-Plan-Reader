from fastapi import FastAPI, File, UploadFile, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from ultralytics import YOLO
from PIL import Image
import io
import cv2
import numpy as np
import base64
import torch
import torch.nn as nn
import torchvision.transforms as transforms
from shapely.geometry import LineString, Point
import zipfile
import json

# Import the vectorization sub-steps from your pipeline module
import image_to_json_pipeline

app = FastAPI()

# Enable CORS for local development frontend communication
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ==========================================
# 1. MODEL CONFIGURATION & INITIALIZATION
# ==========================================
ODIN = "weights/yoloWeights.pt"
UNET_WEIGHTS = "weights/uNetWeights.pt"
device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')

# Load YOLO Model
try:
    yolo_model = YOLO(ODIN)
    print(f"--> Success: Loaded local YOLO model '{ODIN}' successfully!")
except Exception as e:
    print(f"--> Error loading YOLO '{ODIN}': {e}")

# Load U-Net Model with Dynamic Channel Patching
try:
    import segmentation_models_pytorch as smp

    unet_model = smp.Unet(
        encoder_name="resnet34",
        encoder_weights=None,
        in_channels=1,
        classes=1
    )

    # FORCE LAYER FIX: Overwrite first convolution layer to accept 1 channel (Grayscale)
    unet_model.encoder.conv1 = nn.Conv2d(
        in_channels=1,
        out_channels=64,
        kernel_size=(7, 7),
        stride=(2, 2),
        padding=(3, 3),
        bias=False
    )

    # Load weights cleanly onto patched architecture
    unet_model.load_state_dict(torch.load(UNET_WEIGHTS, map_location=device))
    unet_model.to(device)
    unet_model.eval()
    print(f"--> Success: Patched and loaded local UNet model '{UNET_WEIGHTS}' successfully!")
except Exception as e:
    print(f"--> Error loading UNet '{UNET_WEIGHTS}': {e}")


# ==========================================
# 2. INTEGRATED PIPELINE ENDPOINTS
# ==========================================

@app.post("/detect")
@app.post("/analyze")
@app.post("/debug")
async def analyze_floorplan(request: Request, file: UploadFile = File(...)):
    if unet_model is None:
        return {"error": "UNet model is not loaded on the server. Check startup logs."}

    # Evaluate routing request to determine whether to dump file binaries or return browser JSON
    is_debug_mode = request.url.path.endswith("/debug")

    # Read uploaded file bytes
    request_content = await file.read()
    img_pil = Image.open(io.BytesIO(request_content)).convert("RGB")
    original_size = img_pil.size  # (width, height)
    img_np = np.array(img_pil)

    # -----------------------------------------------------------------
    # STEP A: Run YOLO Object Detection (Doors & Windows)
    # -----------------------------------------------------------------
    yolo_results = yolo_model.predict(source=img_np, conf=0.25)
    detections = []
    if len(yolo_results) > 0:
        for idx, box in enumerate(yolo_results[0].boxes):
            xyxy = box.xyxy[0].tolist()  # [xmin, ymin, xmax, ymax]
            cls_id = int(box.cls[0])
            label = yolo_model.names[cls_id]

            detections.append({
                "detection_id": idx,
                "name": label,
                "confidence": round(float(box.conf[0]), 2),
                "bbox": {
                    "xmin": xyxy[0],
                    "ymin": xyxy[1],
                    "xmax": xyxy[2],
                    "ymax": xyxy[3]
                }
            })

    # -----------------------------------------------------------------
    # STEP B: Run U-Net Structural Wall Segmentation
    # -----------------------------------------------------------------
    unet_transform = transforms.Compose([
        transforms.Resize((512, 512)),
        transforms.Grayscale(num_output_channels=1),
        transforms.ToTensor(),
    ])
    input_tensor = unet_transform(img_pil).unsqueeze(0).to(device)

    with torch.no_grad():
        output = unet_model(input_tensor)

    # Convert output tensor map to standard binary mask array
    preds = torch.sigmoid(output)
    preds = (preds > 0.5).float().squeeze().cpu().numpy()
    mask_array = (preds * 255).astype(np.uint8)

    # ---> ADD THIS LINE TO INVERT THE COLORS <---
    mask_array = 255 - mask_array

    # Rescale the wall mask back to match original image pixel tracking resolution
    mask_img = Image.fromarray(mask_array).resize(original_size, resample=Image.NEAREST)
    mask_np = np.array(mask_img)

    # -----------------------------------------------------------------
    # STEP C: Run Morphological Vectorization Pipeline
    # -----------------------------------------------------------------
    _, binary_mask = cv2.threshold(mask_np, 0, 255, cv2.THRESH_BINARY)

    clean_mask = image_to_json_pipeline.clean_wall_mask(binary_mask)
    distance_map = image_to_json_pipeline.compute_thickness_map(clean_mask)
    skeleton = image_to_json_pipeline.extract_skeleton(clean_mask)
    lines = image_to_json_pipeline.vectorize_skeleton(skeleton)
    clean_lines = image_to_json_pipeline.clean_topology(lines)

    # Format walls into standard JSON structure
    walls_list = []
    for idx, line in enumerate(clean_lines):
        coords = list(line.coords)

        # Calculate localized wall thickness from distance map values
        thickness_samples = []
        for pt in coords:
            x, y = int(round(pt[0])), int(round(pt[1]))
            if 0 <= y < distance_map.shape[0] and 0 <= x < distance_map.shape[1]:
                thickness_samples.append(distance_map[y, x] * 2)

        avg_thickness = np.mean(thickness_samples) if thickness_samples else 12.0

        walls_list.append({
            "id": f"wall_{idx}",
            "start": {"x": round(coords[0][0], 2), "y": round(coords[0][1], 2)},
            "end": {"x": round(coords[-1][0], 2), "y": round(coords[-1][1], 2)},
            "thickness": round(float(avg_thickness), 2),
            "doors": [],
            "windows": []
        })

    # -----------------------------------------------------------------
    # STEP D: Merge Objects to Walls (Matches correct.json schema)
    # -----------------------------------------------------------------
    for obj in detections:
        name_lower = obj["name"].lower()
        if "tuer" in name_lower or "door" in name_lower:
            category = "doors"
        elif "fenster" in name_lower or "window" in name_lower:
            category = "windows"
        else:
            continue

        bbox = obj["bbox"]
        width = bbox["xmax"] - bbox["xmin"]
        height = bbox["ymax"] - bbox["ymin"]

        center_x = (bbox["xmin"] + bbox["xmax"]) / 2
        center_y = (bbox["ymin"] + bbox["ymax"]) / 2
        obj_point = Point(center_x, center_y)

        closest_wall = None
        min_distance = float("inf")
        snapped_coords = None

        # Proximity scanning
        for wall in walls_list:
            wall_line = LineString([
                (wall["start"]["x"], wall["start"]["y"]),
                (wall["end"]["x"], wall["end"]["y"])
            ])
            distance = obj_point.distance(wall_line)

            if distance < min_distance:
                min_distance = distance
                closest_wall = wall

                # Find nearest point coordinate along the vector segment
                projection = wall_line.project(obj_point)
                projected_point = wall_line.interpolate(projection)
                snapped_coords = {"x": round(projected_point.x, 2), "y": round(projected_point.y, 2)}

        # Structural snapping restriction threshold (within 40 pixels)
        if closest_wall and min_distance < 40.0:
            closest_wall[category].append({
                "detection_id": obj["detection_id"],
                "confidence": obj["confidence"],
                "center": snapped_coords,
                "width": round(width, 2),
                "height": round(height, 2),
                "distance_to_wall": round(min_distance, 2)
            })

    # -----------------------------------------------------------------
    # STEP E: Package and Stream Response
    # -----------------------------------------------------------------
    if is_debug_mode:
        # Create an in-memory ZIP byte payload to stream directly to download disk
        zip_buffer = io.BytesIO()

        with zipfile.ZipFile(zip_buffer, "w", zipfile.ZIP_DEFLATED) as zip_file:
            # 1. Store clean analytics mapping data
            clean_payload = {"walls": walls_list}
            zip_file.writestr("analytics_result.json", json.dumps(clean_payload, indent=4))

            # 2. Store original source image
            orig_img_buf = io.BytesIO()
            img_pil.save(orig_img_buf, format="PNG")
            zip_file.writestr("0_original_image.png", orig_img_buf.getvalue())

            # 3. Store raw segmentation map
            _, enc_raw = cv2.imencode(".png", mask_np)
            zip_file.writestr("1_unet_raw_mask.png", enc_raw.tobytes())

            # 4. Store morphologically cleaned mask
            clean_mask_img = (clean_mask * 255).astype(np.uint8) if clean_mask.dtype == bool else clean_mask
            _, enc_clean = cv2.imencode(".png", clean_mask_img)
            zip_file.writestr("2_clean_mask.png", enc_clean.tobytes())

            # 5. Store topological skeleton single-line spine
            skeleton_img = (skeleton * 255).astype(np.uint8) if skeleton.dtype == bool else skeleton
            _, enc_skel = cv2.imencode(".png", skeleton_img)
            zip_file.writestr("3_skeleton.png", enc_skel.tobytes())

            # 6. Store YOLO labeled box overlays
            yolo_canvas = cv2.cvtColor(img_np, cv2.COLOR_RGB2BGR)
            for obj in detections:
                box = obj["bbox"]
                p1 = (int(box["xmin"]), int(box["ymin"]))
                p2 = (int(box["xmax"]), int(box["ymax"]))
                cv2.rectangle(yolo_canvas, p1, p2, (0, 255, 0), 2)
                lbl = f"{obj['name']} ({obj['confidence']})"
                cv2.putText(yolo_canvas, lbl, (p1[0], max(p1[1] - 6, 0)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 255, 0), 2)
            _, enc_yolo = cv2.imencode(".png", yolo_canvas)
            zip_file.writestr("4_yolo_visual.png", enc_yolo.tobytes())

        zip_buffer.seek(0)
        return StreamingResponse(
            zip_buffer,
            media_type="application/x-zip-compressed",
            headers={"Content-Disposition": "attachment; filename=floorplan_debug_package.zip"}
        )

    else:
        # Standard workflow (Return standard JSON output for regular frontend canvas view)
        buffered = io.BytesIO()
        img_pil.save(buffered, format="PNG")
        img_b64 = base64.b64encode(buffered.getvalue()).decode("utf-8")

        return {
            "backgroundImage": f"data:image/png;base64,{img_b64}",
            "walls": walls_list
        }


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="127.0.0.1", port=8000)