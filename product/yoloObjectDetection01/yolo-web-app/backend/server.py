from fastapi import FastAPI, File, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from ultralytics import YOLO
from PIL import Image
import io
import numpy as np

app = FastAPI()

# Enable CORS for local development
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Crucial: This points exactly to your file name
MODEL_NAME = "my_model.pt"

try:
    model = YOLO(MODEL_NAME)
    print(f"--> Success: Loaded local model '{MODEL_NAME}' successfully!")
except Exception as e:
    print(f"--> Error loading '{MODEL_NAME}'. Did you move it into the backend folder? Details: {e}")

@app.post("/detect")
async def detect_objects(file: UploadFile = File(...)):
    # 1. Read incoming image bytes from the browser upload
    request_object_content = await file.read()
    img = Image.open(io.BytesIO(request_object_content)).convert("RGB")
    img_array = np.array(img)
    
    # 2. Run inference local function call
    results = model.predict(source=img_array, conf=0.25)
    boxes = results[0].boxes
    
    # 3. Build a structured array of your labeled bounding boxes
    detections = []
    for box in boxes:
        # xyxy contains raw coordinates: [xmin, ymin, xmax, ymax]
        xyxy = box.xyxy[0].tolist() 
        
        detections.append({
            "name": model.names[int(box.cls[0])],
            "confidence": round(float(box.conf[0]), 2),
            "bbox": {
                "xmin": round(xyxy[0], 1),
                "ymin": round(xyxy[1], 1),
                "xmax": round(xyxy[2], 1),
                "ymax": round(xyxy[3], 1)
            }
        })
        
    # 4. Return native Python dict (FastAPI converts this automatically to standard JSON)
    return {"detections": detections}

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="127.0.0.1", port=8000)