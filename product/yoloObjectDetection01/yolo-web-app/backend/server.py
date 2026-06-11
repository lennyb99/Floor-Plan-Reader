from fastapi import FastAPI, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from ultralytics import YOLO
from PIL import Image
import io
import numpy as np
import base64
import torch
import torchvision.transforms as transforms

app = FastAPI()

# Enable CORS for local development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ==========================================
# 1. YOLO SETUP
# ==========================================
YOLO_MODEL_NAME = "my_model.pt"
try:
    yolo_model = YOLO(YOLO_MODEL_NAME)
    print(f"--> Success: Loaded local YOLO model '{YOLO_MODEL_NAME}' successfully!")
except Exception as e:
    print(f"--> Error loading YOLO '{YOLO_MODEL_NAME}'. Details: {e}")

# ==========================================
# 2. UNET SETUP (Using segmentation_models_pytorch)
# ==========================================
UNET_WEIGHTS = "unet_mock_weights.pth"
device = torch.device('cuda' if torch.cuda.is_available() else 'cpu')

try:
    import segmentation_models_pytorch as smp
    
    # Recreate the exact structural architecture you used in Google Colab
    unet_model = smp.Unet(
        encoder_name="resnet34",        # Matches your exact layer counts (3,4,6,3 blocks)
        encoder_weights=None,           # We use your local file weights instead of downloading ImageNet
        in_channels=1,                  # Expects 1-channel Grayscale floor plans
        classes=1                       # Binary segmentation target (walls vs background)
    )
    
    # Safely load the weight weights onto the skeleton structure
    unet_model.load_state_dict(torch.load(UNET_WEIGHTS, map_location=device))
    unet_model.to(device)
    unet_model.eval()
    print(f"--> Success: Loaded local UNet model '{UNET_WEIGHTS}' successfully!")
except ModuleNotFoundError:
    print("\n[!] CRITICAL: You need to install the library! Run: pip install segmentation-models-pytorch\n")
    unet_model = None
except Exception as e:
    print(f"--> Error loading UNet '{UNET_WEIGHTS}'. Details: {e}")

# ==========================================
# 3. API ENDPOINTS
# ==========================================

@app.post("/detect")
async def detect_objects(file: UploadFile = File(...)):
    request_object_content = await file.read()
    img = Image.open(io.BytesIO(request_object_content)).convert("RGB")
    img_array = np.array(img)
    
    results = yolo_model.predict(source=img_array, conf=0.25)
    boxes = results[0].boxes
    
    detections = []
    for box in boxes:
        xyxy = box.xyxy[0].tolist() 
        detections.append({
            "name": yolo_model.names[int(box.cls[0])],
            "confidence": round(float(box.conf[0]), 2),
            "bbox": {
                "xmin": round(xyxy[0], 1),
                "ymin": round(xyxy[1], 1),
                "xmax": round(xyxy[2], 1),
                "ymax": round(xyxy[3], 1)
            }
        })
    return {"detections": detections}

@app.post("/segment")
async def segment_image(file: UploadFile = File(...)):
    if unet_model is None:
        return {"error": "UNet model is not loaded on the server. Check terminal startup logs."}
        
    request_object_content = await file.read()
    img = Image.open(io.BytesIO(request_object_content)).convert("RGB")
    original_size = img.size  # Saves original dimensions to upscale the mask later

    # 1. Preprocess: Force the image to 512x512 and convert it to 1-channel Grayscale
    transform = transforms.Compose([
        transforms.Resize((512, 512)),               
        transforms.Grayscale(num_output_channels=1), 
        transforms.ToTensor(),
    ])
    input_tensor = transform(img).unsqueeze(0).to(device) # Shape: [1, 1, 512, 512]

    # 2. Model Inference
    with torch.no_grad():
        output = unet_model(input_tensor)

    # 3. Postprocess: Convert output tensor to a binary mask image
    if output.shape[1] == 1:
        preds = torch.sigmoid(output) 
        preds = (preds > 0.5).float().squeeze().cpu().numpy()
        mask_array = (preds * 255).astype(np.uint8)
        
        # -----------------------------------------------------------------
        # COLOR COLORATION CONTROL: WHITE WALLS ON BLACK BACKGROUND
        # -----------------------------------------------------------------
        # If your output currently shows black walls on a white background, 
        # this line inverts it so that walls become pure white (255) and everything else becomes black (0).
        # NOTE: If your output ends up backwards, just comment this next line out!
        mask_array = 255 - mask_array 
        # -----------------------------------------------------------------
        
    else:
        # Multiclass fallback handler
        preds = torch.argmax(output, dim=1).squeeze().cpu().numpy()
        num_classes = output.shape[1]
        mask_array = (preds * (255 // (num_classes - 1))).astype(np.uint8)

    # Bring the mask back to the natural layout dimensions of the user's uploaded floor plan
    mask_img = Image.fromarray(mask_array).resize(original_size, resample=Image.NEAREST)

    # 4. Generate Base64 string for the HTML frontend
    buffered = io.BytesIO()
    mask_img.save(buffered, format="PNG")
    img_b64 = base64.b64encode(buffered.getvalue()).decode("utf-8")

    return {"mask_base64": img_b64}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)